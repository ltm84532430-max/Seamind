//! YouTube captions use the Android player response and a timedtext URL.
//! Keep this route independent from media stream resolution and BotGuard.

use crate::player_store::is_video_id;
use crate::youtube_net::{RedirectScope, YouTubeNet};
use regex::Regex;
use reqwest::{header, Client, Response};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;
use url::Url;
use uuid::Uuid;

const CLIENT_VERSION: &str = "20.10.38";
const CATALOG_TTL: Duration = Duration::from_secs(180);
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(40);
const CAPTION_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptTrack {
    id: String,
    language_code: String,
    name: String,
    is_generated: bool,
    is_translatable: bool,
    is_default: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationLanguage {
    language_code: String,
    name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptCatalog {
    video_id: String,
    tracks: Vec<TranscriptTrack>,
    translation_languages: Vec<TranslationLanguage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptBody {
    video_id: String,
    track_id: String,
    body: String,
    content_type: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptFailure {
    code: &'static str,
    stage: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trace_id: Option<String>,
}

impl TranscriptFailure {
    fn new(code: &'static str, stage: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            stage,
            message: message.into(),
            http_status: None,
            trace_id: None,
        }
    }

    fn with_status(mut self, status: u16) -> Self {
        self.http_status = Some(status);
        self
    }
}

#[derive(Serialize)]
#[serde(tag = "state", content = "data", rename_all = "camelCase")]
pub enum TranscriptReply<T> {
    Ok(T),
    Error(TranscriptFailure),
}

#[derive(Clone)]
struct TrackEntry {
    public: TranscriptTrack,
    base_url: String,
}

#[derive(Clone)]
struct CatalogEntry {
    public: TranscriptCatalog,
    tracks: Vec<TrackEntry>,
    consent_cookie: Option<String>,
    proxy_url: Option<String>,
    created_at: Instant,
}

#[derive(Default)]
pub struct TranscriptState {
    catalogs: Mutex<HashMap<String, CatalogEntry>>,
}

struct HttpText {
    status: u16,
    content_type: String,
    body: String,
}

fn network_failure(stage: &'static str, error: reqwest::Error) -> TranscriptFailure {
    if error.is_timeout() {
        TranscriptFailure::new("timeout", stage, "YouTube 请求超时；请检查网络或代理线路后重试。")
    } else {
        TranscriptFailure::new(
            "network",
            stage,
            "无法连接 YouTube；请检查网络或系统代理线路，恢复后重新检测字幕。",
        )
    }
}

fn http_failure(stage: &'static str, status: u16) -> TranscriptFailure {
    let (code, message) = match status {
        429 => ("rateLimited", "YouTube 限制了请求频率，请稍后再试。"),
        401 | 403 => (
            "requestBlocked",
            "YouTube 拒绝了当前字幕请求，可能需要验证。",
        ),
        404 | 410 if stage == "caption" => ("trackUnavailable", "字幕轨道地址已失效。"),
        500..=599 => ("network", "YouTube 字幕服务暂时不可用。"),
        _ => ("http", "YouTube 字幕请求返回错误状态。"),
    };
    TranscriptFailure::new(code, stage, message).with_status(status)
}

async fn read_response(
    mut response: Response,
    stage: &'static str,
) -> Result<HttpText, TranscriptFailure> {
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    if let Some(length) = response.content_length() {
        if length > MAX_RESPONSE_BYTES as u64 {
            return Err(TranscriptFailure::new(
                "unexpectedResponse",
                stage,
                "YouTube 返回了过大的字幕响应。",
            ));
        }
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| network_failure(stage, error))?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(TranscriptFailure::new(
                "unexpectedResponse",
                stage,
                "YouTube 返回了过大的字幕响应。",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8_lossy(&bytes).into_owned();
    if !(200..300).contains(&status) {
        if is_bot_challenge(&body) || body.to_ascii_lowercase().contains("botguard") {
            return Err(TranscriptFailure::new(
                "requestBlocked",
                stage,
                "YouTube 要求验证当前字幕请求。",
            )
            .with_status(status));
        }
        return Err(http_failure(stage, status));
    }
    Ok(HttpText {
        status,
        content_type,
        body,
    })
}

fn is_bot_challenge(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    lower.contains("not a bot")
        || lower.contains("unusual traffic")
        || lower.contains("class=\"g-recaptcha\"")
        || lower.contains("sign in to confirm")
}

fn extract_consent_cookie(html: &str) -> Option<String> {
    let regex = Regex::new(r#"name="v"\s+value="([^"]+)""#).ok()?;
    let value = regex.captures(html)?.get(1)?.as_str();
    if value.is_empty()
        || value.len() > 256
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return None;
    }
    Some(format!("CONSENT=YES+{value}"))
}

fn extract_api_key(html: &str) -> Option<String> {
    let regex = Regex::new(r#""INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)""#).ok()?;
    Some(regex.captures(html)?.get(1)?.as_str().to_owned())
}

async fn watch_html(
    client: &Client,
    video_id: &str,
    cookie: Option<&str>,
) -> Result<HttpText, TranscriptFailure> {
    let mut request = client.get(format!("https://www.youtube.com/watch?v={video_id}"));
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    let response = request
        .send()
        .await
        .map_err(|error| network_failure("watch", error))?;
    read_response(response, "watch").await
}

fn name_of(value: &Value, fallback: &str) -> String {
    if let Some(name) = value.get("simpleText").and_then(Value::as_str) {
        return name.to_owned();
    }
    if let Some(runs) = value.get("runs").and_then(Value::as_array) {
        let name = runs
            .iter()
            .filter_map(|run| run.get("text").and_then(Value::as_str))
            .collect::<String>();
        if !name.is_empty() {
            return name;
        }
    }
    fallback.to_owned()
}

fn parse_catalog(
    video_id: &str,
    data: &Value,
    consent_cookie: Option<String>,
    proxy_url: Option<String>,
) -> Result<CatalogEntry, TranscriptFailure> {
    if let Some(playability) = data.get("playabilityStatus") {
        let status = playability
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !status.is_empty() && status != "OK" {
            let reason = playability
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let code = if status == "LOGIN_REQUIRED" && is_bot_challenge(reason) {
                "requestBlocked"
            } else if reason.to_ascii_lowercase().contains("age") {
                "ageRestricted"
            } else {
                "videoUnavailable"
            };
            return Err(TranscriptFailure::new(
                code,
                "player",
                match code {
                    "requestBlocked" => "YouTube 要求先完成真人验证，当前无法取得字幕轨道。",
                    "ageRestricted" => "年龄限制视频需要已验证的登录会话。",
                    _ => "视频当前不可访问，无法取得字幕轨道。",
                },
            ));
        }
    }

    let renderer = data
        .get("captions")
        .and_then(|value| value.get("playerCaptionsTracklistRenderer"))
        .ok_or_else(|| {
            TranscriptFailure::new(
                "transcriptsDisabled",
                "catalog",
                "YouTube 没有返回这个视频的字幕轨道。",
            )
        })?;
    let raw_tracks = renderer
        .get("captionTracks")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            TranscriptFailure::new(
                "transcriptsDisabled",
                "catalog",
                "YouTube 没有返回这个视频的字幕轨道。",
            )
        })?;
    let translation_languages = renderer
        .get("translationLanguages")
        .and_then(Value::as_array)
        .map(|languages| {
            languages
                .iter()
                .filter_map(|language| {
                    let code = language.get("languageCode")?.as_str()?;
                    Some(TranslationLanguage {
                        language_code: code.to_owned(),
                        name: name_of(language.get("languageName").unwrap_or(&Value::Null), code),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let tracks = raw_tracks
        .iter()
        .enumerate()
        .filter_map(|(index, raw)| {
            let base_url = raw.get("baseUrl")?.as_str()?.to_owned();
            let language_code = raw.get("languageCode")?.as_str()?.to_owned();
            let is_generated = raw.get("kind").and_then(Value::as_str) == Some("asr");
            let kind = if is_generated { "auto" } else { "manual" };
            let public = TranscriptTrack {
                id: format!("youtube:{language_code}:{kind}:{index}"),
                language_code: language_code.clone(),
                name: name_of(raw.get("name").unwrap_or(&Value::Null), &language_code),
                is_generated,
                is_translatable: raw
                    .get("isTranslatable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                is_default: raw
                    .get("isDefault")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            };
            Some(TrackEntry { public, base_url })
        })
        .collect::<Vec<_>>();
    if tracks.is_empty() {
        return Err(TranscriptFailure::new(
            "transcriptsDisabled",
            "catalog",
            "YouTube 没有返回可用的字幕轨道。",
        ));
    }
    Ok(CatalogEntry {
        public: TranscriptCatalog {
            video_id: video_id.to_owned(),
            tracks: tracks.iter().map(|track| track.public.clone()).collect(),
            translation_languages,
        },
        tracks,
        consent_cookie,
        proxy_url,
        created_at: Instant::now(),
    })
}

async fn discover_catalog(
    client: &Client,
    video_id: &str,
    proxy_url: Option<String>,
) -> Result<CatalogEntry, TranscriptFailure> {
    let first_page = watch_html(client, video_id, None).await?;
    let mut consent_cookie = None;
    let page = if first_page
        .body
        .contains("action=\"https://consent.youtube.com/s\"")
    {
        consent_cookie = Some(extract_consent_cookie(&first_page.body).ok_or_else(|| {
            TranscriptFailure::new(
                "requestBlocked",
                "watch",
                "YouTube 同意页面无法建立字幕请求会话。",
            )
        })?);
        watch_html(client, video_id, consent_cookie.as_deref()).await?
    } else {
        first_page
    };
    let api_key = extract_api_key(&page.body).ok_or_else(|| {
        if is_bot_challenge(&page.body) {
            TranscriptFailure::new("requestBlocked", "watch", "YouTube 在观看页要求真人验证。")
        } else {
            TranscriptFailure::new(
                "unexpectedResponse",
                "watch",
                "观看页没有返回字幕服务所需的 InnerTube 配置。",
            )
        }
    })?;
    let player_url = format!("https://www.youtube.com/youtubei/v1/player?key={api_key}");
    let payload = json!({
        "context": {"client": {"clientName": "ANDROID", "clientVersion": CLIENT_VERSION}},
        "videoId": video_id
    });
    let mut request = client.post(player_url).json(&payload);
    if let Some(cookie) = &consent_cookie {
        request = request.header(header::COOKIE, cookie);
    }
    let response = request
        .send()
        .await
        .map_err(|error| network_failure("player", error))?;
    let player = read_response(response, "player").await?;
    let data: Value = serde_json::from_str(&player.body).map_err(|_| {
        TranscriptFailure::new(
            "unexpectedResponse",
            "player",
            "YouTube Player 接口没有返回有效 JSON。",
        )
    })?;
    parse_catalog(video_id, &data, consent_cookie, proxy_url)
}

async fn get_catalog(
    video_id: &str,
    force_refresh: bool,
    net: &YouTubeNet,
    state: &TranscriptState,
) -> Result<CatalogEntry, TranscriptFailure> {
    if !is_video_id(video_id) {
        return Err(TranscriptFailure::new(
            "videoUnavailable",
            "input",
            "无效的 YouTube 视频 ID。",
        ));
    }
    let proxy_url = net.proxy_url();
    if !force_refresh {
        let cached = state
            .catalogs
            .lock()
            .map_err(|_| TranscriptFailure::new("unknown", "catalog", "字幕缓存暂时不可用。"))?
            .get(video_id)
            .cloned();
        if let Some(cached) = cached {
            if cached.created_at.elapsed() < CATALOG_TTL && cached.proxy_url == proxy_url {
                return Ok(cached);
            }
        }
    }
    let client = net
        .client(RedirectScope::YouTube)
        .map_err(|_| TranscriptFailure::new("network", "watch", "无法创建 YouTube 网络连接。"))?;
    let catalog = tokio::time::timeout(
        DISCOVERY_TIMEOUT,
        discover_catalog(&client, video_id, proxy_url),
    )
    .await
    .map_err(|_| TranscriptFailure::new("timeout", "catalog", "字幕轨道发现超时。"))??;
    let mut cached = state
        .catalogs
        .lock()
        .map_err(|_| TranscriptFailure::new("unknown", "catalog", "字幕缓存暂时不可用。"))?;
    cached.insert(video_id.to_owned(), catalog.clone());
    if cached.len() > 24 {
        if let Some(oldest) = cached
            .iter()
            .min_by_key(|(_, entry)| entry.created_at)
            .map(|(id, _)| id.clone())
        {
            cached.remove(&oldest);
        }
    }
    Ok(catalog)
}

fn caption_url(base_url: &str, translation_lang: Option<&str>) -> Result<Url, TranscriptFailure> {
    let mut url = Url::parse(base_url)
        .map_err(|_| TranscriptFailure::new("trackUnavailable", "caption", "字幕轨道地址无效。"))?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("www.youtube.com" | "youtube.com"))
        || url.path() != "/api/timedtext"
    {
        return Err(TranscriptFailure::new(
            "trackUnavailable",
            "caption",
            "字幕轨道地址不属于允许的 YouTube 接口。",
        ));
    }
    if url
        .query_pairs()
        .any(|(key, value)| key == "exp" && value == "xpe")
    {
        return Err(TranscriptFailure::new(
            "poTokenRequired",
            "caption",
            "这个字幕轨道要求专用 PO Token，当前 Android 请求无法使用。",
        ));
    }
    let pairs = url
        .query_pairs()
        .filter(|(key, value)| !(key == "fmt" && value == "srv3") && key != "tlang")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    url.query_pairs_mut().clear().extend_pairs(pairs);
    if let Some(language) = translation_lang {
        url.query_pairs_mut().append_pair("tlang", language);
    }
    Ok(url)
}

async fn download_caption(
    client: &Client,
    url: &Url,
    cookie: Option<&str>,
) -> Result<HttpText, TranscriptFailure> {
    let mut request = client.get(url.clone());
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    let response = request
        .send()
        .await
        .map_err(|error| network_failure("caption", error))?;
    read_response(response, "caption").await
}

fn classify_caption_body(response: &HttpText) -> Result<(), TranscriptFailure> {
    let trimmed = response.body.trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() {
        return Err(TranscriptFailure::new(
            "emptyResponse",
            "caption",
            "YouTube 返回了空字幕正文，轨道可能不可访问。",
        )
        .with_status(response.status));
    }
    let lower = trimmed.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "<transcript/>" | "<transcript></transcript>" | "<timedtext/>" | "<timedtext></timedtext>"
    ) {
        return Err(TranscriptFailure::new(
            "emptyResponse",
            "caption",
            "YouTube 返回的字幕轨道没有台词内容。",
        )
        .with_status(response.status));
    }
    if lower.starts_with("<!doctype html")
        || lower.starts_with("<html")
        || response.content_type.starts_with("text/html")
    {
        if is_bot_challenge(trimmed) {
            return Err(TranscriptFailure::new(
                "requestBlocked",
                "caption",
                "YouTube 在字幕请求中要求真人验证。",
            )
            .with_status(response.status));
        }
        return Err(TranscriptFailure::new(
            "unexpectedResponse",
            "caption",
            "YouTube 返回了网页，而不是字幕正文。",
        )
        .with_status(response.status));
    }
    if !trimmed.starts_with('<') && !trimmed.starts_with('{') && !trimmed.starts_with("WEBVTT") {
        return Err(TranscriptFailure::new(
            "unexpectedResponse",
            "caption",
            "YouTube 返回了无法识别的字幕响应。",
        )
        .with_status(response.status));
    }
    Ok(())
}

async fn fetch_body(
    video_id: &str,
    track_id: &str,
    translation_lang: Option<&str>,
    net: &YouTubeNet,
    state: &TranscriptState,
) -> Result<TranscriptBody, TranscriptFailure> {
    let catalog = get_catalog(video_id, false, net, state).await?;
    let track = catalog
        .tracks
        .iter()
        .find(|track| track.public.id == track_id)
        .ok_or_else(|| {
            TranscriptFailure::new(
                "trackUnavailable",
                "catalog",
                "所选字幕轨道已不可用，请重新选择。",
            )
        })?;
    if let Some(language) = translation_lang {
        if !track.public.is_translatable
            || !catalog
                .public
                .translation_languages
                .iter()
                .any(|item| item.language_code == language)
        {
            return Err(TranscriptFailure::new(
                "languageUnavailable",
                "caption",
                "该字幕轨道不支持所选翻译语言。",
            ));
        }
    }
    let original_url = caption_url(&track.base_url, translation_lang)?;
    let client = net
        .client(RedirectScope::YouTube)
        .map_err(|_| TranscriptFailure::new("network", "caption", "无法创建 YouTube 网络连接。"))?;
    let response = tokio::time::timeout(
        CAPTION_TIMEOUT,
        download_caption(&client, &original_url, catalog.consent_cookie.as_deref()),
    )
    .await
    .map_err(|_| TranscriptFailure::new("timeout", "caption", "字幕正文请求超时。"))?;
    let first = match response {
        Ok(response) => match classify_caption_body(&response) {
            Ok(()) => {
                return Ok(TranscriptBody {
                    video_id: video_id.to_owned(),
                    track_id: track_id.to_owned(),
                    body: response.body,
                    content_type: response.content_type,
                })
            }
            Err(error) => error,
        },
        Err(error) => error,
    };
    // Only a format rejection or an empty body gets a single JSON3 attempt.
    if !matches!(first.code, "emptyResponse" | "unexpectedResponse" | "http")
        || first
            .http_status
            .is_some_and(|status| status != 200 && status != 400)
    {
        return Err(first);
    }
    let mut json3_url = original_url;
    let pairs = json3_url
        .query_pairs()
        .filter(|(key, _)| key != "fmt")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    json3_url
        .query_pairs_mut()
        .clear()
        .extend_pairs(pairs)
        .append_pair("fmt", "json3");
    let response = tokio::time::timeout(
        CAPTION_TIMEOUT,
        download_caption(&client, &json3_url, catalog.consent_cookie.as_deref()),
    )
    .await
    .map_err(|_| TranscriptFailure::new("timeout", "caption", "字幕正文请求超时。"))??;
    classify_caption_body(&response)?;
    Ok(TranscriptBody {
        video_id: video_id.to_owned(),
        track_id: track_id.to_owned(),
        body: response.body,
        content_type: response.content_type,
    })
}

fn reply<T>(result: Result<T, TranscriptFailure>, trace_id: String) -> TranscriptReply<T> {
    match result {
        Ok(value) => TranscriptReply::Ok(value),
        Err(mut error) => {
            eprintln!(
                "Seamind transcript trace={} stage={} code={} status={:?}",
                trace_id, error.stage, error.code, error.http_status
            );
            error.trace_id = Some(trace_id);
            TranscriptReply::Error(error)
        }
    }
}

#[tauri::command]
pub async fn youtube_transcript_list(
    video_id: String,
    force_refresh: bool,
    net: State<'_, YouTubeNet>,
    state: State<'_, TranscriptState>,
) -> Result<TranscriptReply<TranscriptCatalog>, String> {
    let trace_id = Uuid::new_v4().simple().to_string();
    Ok(reply(
        get_catalog(&video_id, force_refresh, &net, &state)
            .await
            .map(|catalog| catalog.public),
        trace_id,
    ))
}

#[tauri::command]
pub async fn youtube_transcript_fetch(
    video_id: String,
    track_id: String,
    translation_lang: Option<String>,
    net: State<'_, YouTubeNet>,
    state: State<'_, TranscriptState>,
) -> Result<TranscriptReply<TranscriptBody>, String> {
    let trace_id = Uuid::new_v4().simple().to_string();
    Ok(reply(
        fetch_body(
            &video_id,
            &track_id,
            translation_lang.as_deref(),
            &net,
            &state,
        )
        .await,
        trace_id,
    ))
}

#[tauri::command]
pub async fn youtube_transcript_browser_fetch(
    video_id: String,
    browser: String,
    net: State<'_, YouTubeNet>,
) -> Result<TranscriptReply<TranscriptBody>, String> {
    let trace_id = Uuid::new_v4().simple().to_string();
    let proxy_url = net.proxy_url();
    let result = tokio::task::spawn_blocking(move || {
        crate::youtube::fetch_youtube_caption_with_browser(
            &video_id,
            &browser,
            proxy_url.as_deref(),
        )
        .map(|(language, body)| TranscriptBody {
            video_id,
            track_id: format!("browser:{language}"),
            body,
            content_type: "text/vtt".to_string(),
        })
        .map_err(|(code, message)| TranscriptFailure::new(code, "browser", message))
    })
    .await
    .map_err(|_| "浏览器会话字幕任务意外退出。".to_string());
    Ok(reply(result?, trace_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn android_catalog_preserves_manual_and_generated_tracks() {
        let data = json!({
            "playabilityStatus": {"status": "OK"},
            "captions": {"playerCaptionsTracklistRenderer": {
                "captionTracks": [
                    {"baseUrl": "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en", "languageCode": "en", "name": {"simpleText": "English"}, "isTranslatable": true},
                    {"baseUrl": "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=zh&kind=asr", "languageCode": "zh", "name": {"runs": [{"text": "中文"}]}, "kind": "asr"}
                ],
                "translationLanguages": [{"languageCode": "zh-Hans", "languageName": {"simpleText": "简体中文"}}]
            }}
        });
        let catalog = parse_catalog("dQw4w9WgXcQ", &data, None, None).unwrap();
        assert_eq!(catalog.tracks.len(), 2);
        assert!(!catalog.tracks[0].public.is_generated);
        assert!(catalog.tracks[1].public.is_generated);
        assert_eq!(
            catalog.public.translation_languages[0].language_code,
            "zh-Hans"
        );
    }

    #[test]
    fn bot_verification_is_distinct_from_disabled_captions() {
        let data = json!({"playabilityStatus": {
            "status": "LOGIN_REQUIRED",
            "reason": "Sign in to confirm you're not a bot"
        }});
        let error = parse_catalog("dQw4w9WgXcQ", &data, None, None)
            .err()
            .unwrap();
        assert_eq!(error.code, "requestBlocked");
        assert_eq!(error.stage, "player");
        assert_eq!(error.http_status, None);
    }

    #[test]
    fn caption_url_rejects_external_hosts_and_removes_srv3() {
        let base = "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&fmt=srv3&lang=en";
        let url = caption_url(base, Some("zh-Hans")).unwrap();
        assert!(!url
            .query_pairs()
            .any(|(key, value)| key == "fmt" && value == "srv3"));
        assert!(url
            .query_pairs()
            .any(|(key, value)| key == "tlang" && value == "zh-Hans"));
        assert!(caption_url("https://attacker.example/api/timedtext?v=x", None).is_err());
        assert_eq!(
            caption_url("https://www.youtube.com/api/timedtext?exp=xpe", None)
                .err()
                .unwrap()
                .code,
            "poTokenRequired"
        );
    }

    #[test]
    fn empty_and_html_caption_bodies_have_distinct_errors() {
        let response = HttpText {
            status: 200,
            content_type: "text/xml".into(),
            body: "<transcript/>".into(),
        };
        assert_eq!(
            classify_caption_body(&response).err().unwrap().code,
            "emptyResponse"
        );
        let response = HttpText {
            status: 200,
            content_type: "text/html".into(),
            body: "<html>Sign in to confirm you're not a bot</html>".into(),
        };
        assert_eq!(
            classify_caption_body(&response).err().unwrap().code,
            "requestBlocked"
        );
        let response = HttpText {
            status: 200,
            content_type: "text/xml".into(),
            body: "<transcript><text start=\"1\" dur=\"2\">I am not a bot</text></transcript>".into(),
        };
        assert!(classify_caption_body(&response).is_ok());
    }

    #[test]
    fn command_reply_keeps_typed_stage_and_actual_http_status() {
        let failure =
            TranscriptFailure::new("requestBlocked", "caption", "blocked").with_status(403);
        let encoded =
            serde_json::to_value(reply::<TranscriptBody>(Err(failure), "trace123".into())).unwrap();
        assert_eq!(encoded["state"], "error");
        assert_eq!(encoded["data"]["code"], "requestBlocked");
        assert_eq!(encoded["data"]["stage"], "caption");
        assert_eq!(encoded["data"]["httpStatus"], 403);
        assert_eq!(encoded["data"]["traceId"], "trace123");
    }

    #[tokio::test]
    #[ignore = "requires a live YouTube connection"]
    async fn live_caption_probe() {
        let video_id =
            std::env::var("SEAMIND_TEST_VIDEO_ID").unwrap_or_else(|_| "dQw4w9WgXcQ".to_string());
        let net = YouTubeNet::default();
        let state = TranscriptState::default();
        let catalog = get_catalog(&video_id, true, &net, &state).await.unwrap();
        assert!(!catalog.tracks.is_empty());
        let body = fetch_body(&video_id, &catalog.tracks[0].public.id, None, &net, &state)
            .await
            .unwrap();
        assert!(!body.body.is_empty());
        println!(
            "transcript probe: tracks={}, bytes={}",
            catalog.tracks.len(),
            body.body.len()
        );
    }
}
