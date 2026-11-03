//! YouTube captions resolve from the watch page player response first, fall back across multiple
//! InnerTube client profiles, hand off PO-token-gated tracks to the WebView, and expose a
//! cookie-less `yt-dlp` fallback before any explicit user-chosen browser session retry.

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

const CATALOG_TTL: Duration = Duration::from_secs(180);
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(40);
const CAPTION_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;

struct InnerTubeClient {
    name: &'static str,
    version: &'static str,
    client_id: &'static str,
    user_agent: &'static str,
    os_name: &'static str,
    os_version: &'static str,
    device_make: Option<&'static str>,
    device_model: Option<&'static str>,
    android_sdk_version: Option<u32>,
}

const INNERTUBE_CLIENTS: &[InnerTubeClient] = &[
    InnerTubeClient {
        name: "ANDROID_VR",
        version: "1.65.10",
        client_id: "28",
        user_agent: "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
        os_name: "Android",
        os_version: "12L",
        device_make: Some("Oculus"),
        device_model: Some("Quest 3"),
        android_sdk_version: Some(32),
    },
    InnerTubeClient {
        name: "VISIONOS",
        version: "1.02",
        client_id: "101",
        user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
        os_name: "visionOS",
        os_version: "26.5.23O471",
        device_make: Some("Apple"),
        device_model: Some("RealityDevice17,1"),
        android_sdk_version: None,
    },
    InnerTubeClient {
        name: "iOS",
        version: "20.11.6",
        client_id: "5",
        user_agent: "com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)",
        os_name: "iOS",
        os_version: "16.7.7.20H330",
        device_make: Some("Apple"),
        device_model: Some("iPhone10,4"),
        android_sdk_version: None,
    },
    InnerTubeClient {
        name: "ANDROID",
        version: "21.03.36",
        client_id: "3",
        user_agent: "com.google.android.youtube/21.03.36(Linux; U; Android 16; en_US; SM-S908E Build/TP1A.220624.014) gzip",
        os_name: "Android",
        os_version: "16",
        device_make: Some("Samsung"),
        device_model: Some("SM-S908E"),
        android_sdk_version: Some(36),
    },
];

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
    #[serde(skip_serializing_if = "Option::is_none")]
    translation_body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    translation_language: Option<String>,
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
    user_agent: Option<&'static str>,
    visitor_data: Option<String>,
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
        TranscriptFailure::new(
            "timeout",
            stage,
            "YouTube 请求超时；请检查网络或代理线路后重试。",
        )
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
        || body.contains("不是机器人")
        || body.contains("异常流量")
}

fn has_age_gate_reason(reason: &str) -> bool {
    let lower = reason.to_ascii_lowercase();
    lower.contains("confirm your age")
        || lower.contains("age-restricted")
        || lower.contains("inappropriate for some users")
        || reason.contains("年龄")
}

fn is_private_or_members_reason(reason: &str) -> bool {
    let lower = reason.to_ascii_lowercase();
    lower.contains("private")
        || lower.contains("members-only")
        || lower.contains("members only")
        || reason.contains("私享")
        || reason.contains("私人")
        || reason.contains("会员")
}

fn is_valid_visitor_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value.bytes().all(|byte| (0x21..0x7f).contains(&byte))
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

fn extract_json_object_after(html: &str, marker: &str) -> Option<Value> {
    let mut search_from = 0;
    while let Some(offset) = html[search_from..].find(marker) {
        let after_marker = search_from + offset + marker.len();
        search_from = after_marker;
        let tail = &html[after_marker..];
        let trimmed = tail.trim_start_matches(|ch: char| {
            ch.is_ascii_whitespace() || matches!(ch, '"' | '\'' | ']')
        });
        let Some(after_assign) = trimmed
            .strip_prefix('=')
            .or_else(|| trimmed.strip_prefix(':'))
        else {
            continue;
        };
        let after_ws = after_assign.trim_start();
        if !after_ws.starts_with('{') {
            continue;
        }
        let bytes = after_ws.as_bytes();
        let mut depth = 0_usize;
        let mut in_string = false;
        let mut escaped = false;
        let mut end_index = None;
        for (index, &byte) in bytes.iter().enumerate() {
            if in_string {
                if escaped {
                    escaped = false;
                } else if byte == b'\\' {
                    escaped = true;
                } else if byte == b'"' {
                    in_string = false;
                }
                continue;
            }
            match byte {
                b'"' => in_string = true,
                b'{' => depth += 1,
                b'}' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        end_index = Some(index);
                        break;
                    }
                }
                _ => {}
            }
        }
        if let Some(end) = end_index {
            if let Ok(parsed) = serde_json::from_str::<Value>(&after_ws[..=end]) {
                if parsed.get("playabilityStatus").is_some()
                    || parsed.get("captions").is_some()
                    || parsed.get("videoDetails").is_some()
                {
                    return Some(parsed);
                }
            }
        }
    }
    None
}

fn extract_visitor_data(html: &str, player_data: Option<&Value>) -> Option<String> {
    if let Some(visitor) = player_data
        .and_then(|data| data.get("responseContext"))
        .and_then(|ctx| ctx.get("visitorData"))
        .and_then(Value::as_str)
    {
        if is_valid_visitor_id(visitor) {
            return Some(visitor.to_owned());
        }
    }
    let regex = Regex::new(r#""(?:VISITOR_DATA|visitorData)"\s*:\s*"([^"]+)""#).ok()?;
    let value = regex.captures(html)?.get(1)?.as_str();
    is_valid_visitor_id(value).then(|| value.to_owned())
}

fn requires_po_token(base_url: &str) -> bool {
    Url::parse(base_url).ok().is_some_and(|url| {
        url.query_pairs()
            .any(|(key, value)| key == "exp" && value == "xpe")
    })
}

fn has_direct_track(catalog: &CatalogEntry) -> bool {
    catalog
        .tracks
        .iter()
        .any(|track| !requires_po_token(&track.base_url))
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
    user_agent: Option<&'static str>,
    visitor_data: Option<String>,
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
            let code = if status == "AGE_CHECK_REQUIRED"
                || status == "CONTENT_CHECK_REQUIRED"
                || has_age_gate_reason(reason)
            {
                "ageRestricted"
            } else if status == "LOGIN_REQUIRED" {
                if is_private_or_members_reason(reason) {
                    "videoUnavailable"
                } else {
                    "requestBlocked"
                }
            } else if is_bot_challenge(reason) {
                "requestBlocked"
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
        user_agent,
        visitor_data,
        proxy_url,
        created_at: Instant::now(),
    })
}

fn build_player_payload(
    profile: &InnerTubeClient,
    video_id: &str,
    visitor_data: Option<&str>,
) -> Value {
    let mut client = json!({
        "clientName": profile.name,
        "clientVersion": profile.version,
        "osName": profile.os_name,
        "osVersion": profile.os_version,
        "hl": "en",
        "gl": "US"
    });
    if let Some(object) = client.as_object_mut() {
        if let Some(make) = profile.device_make {
            object.insert("deviceMake".to_owned(), json!(make));
        }
        if let Some(model) = profile.device_model {
            object.insert("deviceModel".to_owned(), json!(model));
        }
        if let Some(sdk) = profile.android_sdk_version {
            object.insert("androidSdkVersion".to_owned(), json!(sdk));
        }
        if let Some(visitor) = visitor_data.filter(|value| is_valid_visitor_id(value)) {
            object.insert("visitorData".to_owned(), json!(visitor));
        }
    }
    json!({
        "context": { "client": client },
        "videoId": video_id,
        "contentCheckOk": true,
        "racyCheckOk": true
    })
}

fn failure_priority(code: &str) -> u8 {
    match code {
        "ageRestricted" => 0,
        "transcriptsDisabled" => 1,
        "requestBlocked" => 2,
        "rateLimited" => 3,
        "poTokenRequired" => 4,
        "network" => 5,
        "timeout" => 6,
        "videoUnavailable" => 7,
        "http" => 8,
        "unexpectedResponse" => 9,
        _ => 10,
    }
}

fn pick_failure(failures: Vec<TranscriptFailure>) -> TranscriptFailure {
    failures
        .into_iter()
        .min_by_key(|failure| failure_priority(failure.code))
        .unwrap_or_else(|| {
            TranscriptFailure::new("unknown", "catalog", "无法解析 YouTube 字幕轨道。")
        })
}

async fn request_client_player(
    client: &Client,
    profile: &InnerTubeClient,
    video_id: &str,
    api_key: Option<&str>,
    consent_cookie: Option<&str>,
    visitor_data: Option<&str>,
) -> Result<Value, TranscriptFailure> {
    let player_url = match api_key {
        Some(key) => format!("https://www.youtube.com/youtubei/v1/player?key={key}&prettyPrint=false"),
        None => "https://www.youtube.com/youtubei/v1/player?prettyPrint=false".to_owned(),
    };
    let payload = build_player_payload(profile, video_id, visitor_data);
    let mut request = client
        .post(player_url)
        .header(header::USER_AGENT, profile.user_agent)
        .header("x-youtube-client-name", profile.client_id)
        .header("x-youtube-client-version", profile.version)
        .json(&payload);
    if let Some(visitor) = visitor_data.filter(|value| is_valid_visitor_id(value)) {
        request = request.header("x-goog-visitor-id", visitor);
    }
    if let Some(cookie) = consent_cookie {
        request = request.header(header::COOKIE, cookie);
    }
    let response = request
        .send()
        .await
        .map_err(|error| network_failure("player", error))?;
    let player = read_response(response, "player").await?;
    serde_json::from_str(&player.body).map_err(|_| {
        TranscriptFailure::new(
            "unexpectedResponse",
            "player",
            "YouTube Player 接口没有返回有效 JSON。",
        )
    })
}

async fn discover_catalog(
    client: &Client,
    video_id: &str,
    proxy_url: Option<String>,
) -> Result<CatalogEntry, TranscriptFailure> {
    let mut consent_cookie: Option<String> = None;
    let mut api_key: Option<String> = None;
    let mut visitor_data: Option<String> = None;
    let mut po_token_catalog: Option<CatalogEntry> = None;
    let mut failures: Vec<TranscriptFailure> = Vec::new();

    match watch_html(client, video_id, None).await {
        Ok(first_page) => {
            let page_result = if first_page
                .body
                .contains("action=\"https://consent.youtube.com/s\"")
            {
                match extract_consent_cookie(&first_page.body) {
                    Some(cookie) => {
                        let retry = watch_html(client, video_id, Some(&cookie)).await;
                        consent_cookie = Some(cookie);
                        retry
                    }
                    None => Err(TranscriptFailure::new(
                        "requestBlocked",
                        "watch",
                        "YouTube 同意页面无法建立字幕请求会话。",
                    )),
                }
            } else {
                Ok(first_page)
            };

            match page_result {
                Ok(page) => {
                    api_key = extract_api_key(&page.body);
                    let initial_player =
                        extract_json_object_after(&page.body, "ytInitialPlayerResponse");
                    visitor_data = extract_visitor_data(&page.body, initial_player.as_ref());
                    if let Some(ref player_data) = initial_player {
                        match parse_catalog(
                            video_id,
                            player_data,
                            consent_cookie.clone(),
                            proxy_url.clone(),
                            None,
                            visitor_data.clone(),
                        ) {
                            Ok(catalog) if has_direct_track(&catalog) => return Ok(catalog),
                            Ok(catalog) => po_token_catalog = Some(catalog),
                            Err(error) if error.code == "ageRestricted" => return Err(error),
                            Err(error) => failures.push(error),
                        }
                    } else if is_bot_challenge(&page.body) {
                        failures.push(TranscriptFailure::new(
                            "requestBlocked",
                            "watch",
                            "YouTube 在观看页要求真人验证。",
                        ));
                    }
                }
                Err(error) if matches!(error.code, "network" | "timeout") => return Err(error),
                Err(error) => failures.push(error),
            }
        }
        Err(error) if matches!(error.code, "network" | "timeout") => return Err(error),
        Err(error) => failures.push(error),
    }

    for profile in INNERTUBE_CLIENTS {
        let data = match request_client_player(
            client,
            profile,
            video_id,
            api_key.as_deref(),
            consent_cookie.as_deref(),
            visitor_data.as_deref(),
        )
        .await
        {
            Ok(data) => data,
            Err(error) if matches!(error.code, "network" | "timeout") => {
                failures.push(error);
                break;
            }
            Err(error) => {
                failures.push(error);
                continue;
            }
        };
        if visitor_data.is_none() {
            visitor_data = extract_visitor_data("", Some(&data));
        }
        match parse_catalog(
            video_id,
            &data,
            consent_cookie.clone(),
            proxy_url.clone(),
            Some(profile.user_agent),
            visitor_data.clone(),
        ) {
            Ok(catalog) if has_direct_track(&catalog) => return Ok(catalog),
            Ok(catalog) => {
                if po_token_catalog.is_none() {
                    po_token_catalog = Some(catalog);
                }
            }
            Err(error) if matches!(error.code, "transcriptsDisabled" | "ageRestricted") => {
                return Err(error)
            }
            Err(error) => failures.push(error),
        }
    }

    if let Some(catalog) = po_token_catalog {
        return Ok(catalog);
    }
    Err(pick_failure(failures))
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
            "这个字幕轨道要求专用 PO Token，需要切换受信客户端获取。",
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
    user_agent: Option<&str>,
    visitor_data: Option<&str>,
) -> Result<HttpText, TranscriptFailure> {
    let mut request = client.get(url.clone());
    if let Some(ua) = user_agent {
        request = request.header(header::USER_AGENT, ua);
    }
    if let Some(visitor) = visitor_data.filter(|value| is_valid_visitor_id(value)) {
        request = request.header("x-goog-visitor-id", visitor);
    }
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
        download_caption(
            &client,
            &original_url,
            catalog.consent_cookie.as_deref(),
            catalog.user_agent,
            catalog.visitor_data.as_deref(),
        ),
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
                    translation_body: None,
                    translation_language: None,
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
        download_caption(
            &client,
            &json3_url,
            catalog.consent_cookie.as_deref(),
            catalog.user_agent,
            catalog.visitor_data.as_deref(),
        ),
    )
    .await
    .map_err(|_| TranscriptFailure::new("timeout", "caption", "字幕正文请求超时。"))??;
    classify_caption_body(&response)?;
    Ok(TranscriptBody {
        video_id: video_id.to_owned(),
        track_id: track_id.to_owned(),
        body: response.body,
        content_type: response.content_type,
        translation_body: None,
        translation_language: None,
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
pub async fn youtube_transcript_ytdlp_fetch(
    video_id: String,
    preferred_lang: Option<String>,
    net: State<'_, YouTubeNet>,
) -> Result<TranscriptReply<TranscriptBody>, String> {
    let trace_id = Uuid::new_v4().simple().to_string();
    let proxy_url = net.proxy_url();
    let result = tokio::task::spawn_blocking(move || {
        crate::youtube::fetch_youtube_caption_without_cookies(
            &video_id,
            preferred_lang.as_deref(),
            proxy_url.as_deref(),
        )
        .map(|caption| TranscriptBody {
            video_id,
            track_id: format!("ytdlp:{}", caption.language),
            body: caption.body,
            content_type: caption.content_type.to_string(),
            translation_body: caption.translation_body,
            translation_language: caption.translation_language,
        })
        .map_err(|(code, message)| TranscriptFailure::new(code, "ytdlp", message))
    })
    .await
    .map_err(|_| "本地字幕提取任务意外退出。".to_string());
    Ok(reply(result?, trace_id))
}

#[tauri::command]
pub async fn youtube_transcript_browser_fetch(
    video_id: String,
    browser: String,
    preferred_lang: Option<String>,
    net: State<'_, YouTubeNet>,
) -> Result<TranscriptReply<TranscriptBody>, String> {
    let trace_id = Uuid::new_v4().simple().to_string();
    let proxy_url = net.proxy_url();
    let result = tokio::task::spawn_blocking(move || {
        crate::youtube::fetch_youtube_caption_with_browser(
            &video_id,
            &browser,
            preferred_lang.as_deref(),
            proxy_url.as_deref(),
        )
        .map(|caption| TranscriptBody {
            video_id,
            track_id: format!("browser:{}", caption.language),
            body: caption.body,
            content_type: caption.content_type.to_string(),
            translation_body: caption.translation_body,
            translation_language: caption.translation_language,
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
        let catalog = parse_catalog("dQw4w9WgXcQ", &data, None, None, None, None).unwrap();
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
        let error = parse_catalog("dQw4w9WgXcQ", &data, None, None, None, None)
            .err()
            .unwrap();
        assert_eq!(error.code, "requestBlocked");
        assert_eq!(error.stage, "player");
        assert_eq!(error.http_status, None);

        // Localized Chinese bot challenge and generic login gates also map to requestBlocked
        // rather than videoUnavailable so Layer 2 / browser recovery can proceed.
        let localized = json!({"playabilityStatus": {
            "status": "LOGIN_REQUIRED",
            "reason": "请登录以确认你不是机器人"
        }});
        assert_eq!(
            parse_catalog("dQw4w9WgXcQ", &localized, None, None, None, None)
                .err()
                .unwrap()
                .code,
            "requestBlocked"
        );

        // "page" must not falsely match "age" as ageRestricted.
        let reload = json!({"playabilityStatus": {
            "status": "UNPLAYABLE",
            "reason": "The page needs to be reloaded."
        }});
        assert_eq!(
            parse_catalog("dQw4w9WgXcQ", &reload, None, None, None, None)
                .err()
                .unwrap()
                .code,
            "videoUnavailable"
        );

        let private = json!({"playabilityStatus": {
            "status": "LOGIN_REQUIRED",
            "reason": "This is a private video."
        }});
        assert_eq!(
            parse_catalog("dQw4w9WgXcQ", &private, None, None, None, None)
                .err()
                .unwrap()
                .code,
            "videoUnavailable"
        );

        let age = json!({"playabilityStatus": {
            "status": "LOGIN_REQUIRED",
            "reason": "Sign in to confirm your age"
        }});
        assert_eq!(
            parse_catalog("dQw4w9WgXcQ", &age, None, None, None, None)
                .err()
                .unwrap()
                .code,
            "ageRestricted"
        );
    }

    #[test]
    fn extracts_embedded_watch_player_response_and_visitor_data() {
        let html = r#"
            <script>var dummy = "ytInitialPlayerResponse";</script>
            <script>var ytInitialPlayerResponse = {"responseContext":{"visitorData":"Cgt2aXNpdG9yXzEyMw%3D%3D"},"playabilityStatus":{"status":"OK"},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en","languageCode":"en","name":{"simpleText":"English ("quoted } brace")"}}]}}}; var other = 1;</script>
        "#;
        // Wait: escaped quotes inside JSON string:
        let valid_html = html.replace(r#""quoted } brace""#, r#"\"quoted } brace\""#);
        let parsed = extract_json_object_after(&valid_html, "ytInitialPlayerResponse").unwrap();
        let visitor = extract_visitor_data(&valid_html, Some(&parsed));
        assert_eq!(visitor.as_deref(), Some("Cgt2aXNpdG9yXzEyMw%3D%3D"));
        let catalog = parse_catalog("dQw4w9WgXcQ", &parsed, None, None, None, visitor).unwrap();
        assert!(has_direct_track(&catalog));
        assert_eq!(catalog.tracks[0].public.name, "English (\"quoted } brace\")");

        let xpe_only = json!({
            "playabilityStatus": {"status": "OK"},
            "captions": {"playerCaptionsTracklistRenderer": {
                "captionTracks": [
                    {"baseUrl": "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&exp=xpe&lang=en", "languageCode": "en"}
                ]
            }}
        });
        let xpe_catalog = parse_catalog("dQw4w9WgXcQ", &xpe_only, None, None, None, None).unwrap();
        assert!(!has_direct_track(&xpe_catalog));
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
            body: "<transcript><text start=\"1\" dur=\"2\">I am not a bot</text></transcript>"
                .into(),
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
