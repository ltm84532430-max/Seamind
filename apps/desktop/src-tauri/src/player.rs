//! Commands behind the player page: the local database (see `player_store`) and the two small
//! requests that are made from the Rust side, a channel's feed and a video's title.
//!
//! Browsing a channel, a playlist or a video's details goes through YouTube.js in the page and the
//! loopback proxy, as playback does. The feed is fetched here because it is a plain Atom document,
//! needs the configured proxy, and is the request a refresh makes for every followed channel.

use crate::player_store as store;
use crate::youtube_net::{RedirectScope, YouTubeNet};
use reqwest::StatusCode;
use rusqlite::Connection;
use serde::Serialize;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

const DATABASE_FILE: &str = "player.sqlite3";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(25);
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const ATOM_ACCEPT: &str = "application/atom+xml, application/xml, text/xml, */*;q=0.8";

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    // A debug build can be pointed at another file, so checks never touch the user's own data.
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("SEAMIND_PLAYER_DB") {
        let path = PathBuf::from(path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("无法创建播放器数据目录：{error}"))?;
        }
        return Ok(path);
    }
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法定位播放器数据目录：{error}"))?;
    std::fs::create_dir_all(&directory).map_err(|error| format!("无法创建播放器数据目录：{error}"))?;
    Ok(directory.join(DATABASE_FILE))
}

fn open(app: &AppHandle) -> Result<Connection, String> {
    store::open(&database_path(app)?)
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

// ---- the database -------------------------------------------------------------------------------

#[tauri::command(async)]
pub fn player_overview(app: AppHandle) -> Result<store::Overview, String> {
    store::overview(&open(&app)?)
}

#[tauri::command(async)]
pub fn player_settings_save(app: AppHandle, settings: store::PlayerSettings) -> Result<store::PlayerSettings, String> {
    store::save_settings(&open(&app)?, &settings)
}

#[tauri::command(async)]
pub fn player_subscribe(app: AppHandle, channel: store::ChannelInput) -> Result<store::Channel, String> {
    store::subscribe(&open(&app)?, &channel, now())
}

#[tauri::command(async)]
pub fn player_unsubscribe(app: AppHandle, channel_id: String) -> Result<(), String> {
    store::unsubscribe(&open(&app)?, &channel_id, now())
}

#[tauri::command(async)]
pub fn player_update_channel(app: AppHandle, channel: store::ChannelInput) -> Result<(), String> {
    store::update_channel_info(&open(&app)?, &channel)
}

#[tauri::command(async)]
pub fn player_import_channels(
    app: AppHandle,
    channels: Vec<store::ChannelInput>,
) -> Result<store::ImportSummary, String> {
    store::import_channels(&open(&app)?, &channels, now())
}

#[tauri::command(async)]
pub fn player_store_videos(app: AppHandle, videos: Vec<store::VideoInput>) -> Result<Vec<store::VideoItem>, String> {
    store::store_videos(&open(&app)?, &videos, now())
}

#[tauri::command(async)]
pub fn player_video_items(app: AppHandle, video_ids: Vec<String>) -> Result<Vec<store::VideoItem>, String> {
    store::video_items(&open(&app)?, &video_ids)
}

#[tauri::command(async)]
pub fn player_feed(app: AppHandle, query: store::FeedQuery) -> Result<Vec<store::VideoItem>, String> {
    store::feed(&open(&app)?, &query)
}

#[tauri::command(async)]
pub fn player_history(app: AppHandle, limit: i64, offset: i64) -> Result<Vec<store::VideoItem>, String> {
    store::history(&open(&app)?, limit, offset)
}

#[tauri::command(async)]
pub fn player_history_remove(app: AppHandle, video_id: String) -> Result<(), String> {
    store::remove_from_history(&open(&app)?, &video_id)
}

#[tauri::command(async)]
pub fn player_history_clear(app: AppHandle) -> Result<(), String> {
    store::clear_history(&open(&app)?)
}

#[tauri::command(async)]
pub fn player_mark_played(app: AppHandle, video_id: String) -> Result<(), String> {
    store::mark_played(&open(&app)?, &video_id, now())
}

#[tauri::command(async)]
pub fn player_save_progress(
    app: AppHandle,
    video_id: String,
    progress_seconds: f64,
    duration_seconds: Option<f64>,
) -> Result<Option<store::WatchState>, String> {
    store::save_progress(&open(&app)?, &video_id, progress_seconds, duration_seconds, now())
}

#[tauri::command(async)]
pub fn player_watch_state(app: AppHandle, video_id: String) -> Result<Option<store::WatchState>, String> {
    store::watch_state(&open(&app)?, &video_id)
}

#[tauri::command(async)]
pub fn player_set_watched(app: AppHandle, video_id: String, watched: bool) -> Result<(), String> {
    store::set_watched(&open(&app)?, &video_id, watched, now())
}

#[tauri::command(async)]
pub fn player_playlist_create(app: AppHandle, name: String) -> Result<store::Playlist, String> {
    store::playlist_create(&open(&app)?, &name, now())
}

#[tauri::command(async)]
pub fn player_playlist_rename(app: AppHandle, playlist_id: String, name: String) -> Result<(), String> {
    store::playlist_rename(&open(&app)?, &playlist_id, &name, now())
}

#[tauri::command(async)]
pub fn player_playlist_delete(app: AppHandle, playlist_id: String) -> Result<(), String> {
    store::playlist_delete(&open(&app)?, &playlist_id, now())
}

#[tauri::command(async)]
pub fn player_playlist_add(app: AppHandle, playlist_id: String, video_id: String) -> Result<(), String> {
    store::playlist_add(&open(&app)?, &playlist_id, &video_id, now())
}

#[tauri::command(async)]
pub fn player_playlist_remove(app: AppHandle, playlist_id: String, video_id: String) -> Result<(), String> {
    store::playlist_remove(&open(&app)?, &playlist_id, &video_id, now())
}

#[tauri::command(async)]
pub fn player_playlist_toggle(app: AppHandle, playlist_id: String, video_id: String) -> Result<bool, String> {
    store::playlist_toggle(&open(&app)?, &playlist_id, &video_id, now())
}

#[tauri::command(async)]
pub fn player_playlist_items(app: AppHandle, playlist_id: String) -> Result<Vec<store::VideoItem>, String> {
    store::playlist_items(&open(&app)?, &playlist_id)
}

#[tauri::command(async)]
pub fn player_course_save(
    app: AppHandle,
    remote_id: String,
    name: String,
    channel_name: Option<String>,
    videos: Vec<store::VideoInput>,
) -> Result<store::Playlist, String> {
    store::course_save(&open(&app)?, &remote_id, &name, channel_name.as_deref(), &videos, now())
}

#[tauri::command(async)]
pub fn player_learning_path_get(
    app: AppHandle,
    path_id: String,
) -> Result<Option<store::LearningPathDetail>, String> {
    store::learning_path_get(&open(&app)?, &path_id)
}

#[tauri::command(async)]
pub fn player_learning_path_save(
    app: AppHandle,
    input: store::LearningPathInput,
) -> Result<store::LearningPathDetail, String> {
    store::learning_path_save(&open(&app)?, &input, now())
}

#[tauri::command(async)]
pub fn player_learning_path_delete(app: AppHandle, path_id: String) -> Result<(), String> {
    store::learning_path_delete(&open(&app)?, &path_id, now())
}

#[tauri::command(async)]
pub fn player_export_backup(app: AppHandle) -> Result<String, String> {
    let backup = store::export_backup(&open(&app)?, now())?;
    serde_json::to_string_pretty(&backup).map_err(|error| format!("无法生成备份：{error}"))
}

#[tauri::command(async)]
pub fn player_import_backup(app: AppHandle, text: String) -> Result<store::BackupSummary, String> {
    let backup: store::Backup =
        serde_json::from_str(&text).map_err(|_| "这不是 Seamind 播放器的备份文件。".to_string())?;
    store::import_backup(&open(&app)?, &backup, now())
}

// ---- the network --------------------------------------------------------------------------------

fn network_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "连接 YouTube 超时。".to_string()
    } else if error.is_connect() {
        "无法连接到 YouTube，请检查网络或代理设置。".to_string()
    } else {
        format!("请求 YouTube 失败：{error}")
    }
}

/// Waits before the first and the second repeat of a request the connection dropped. Through a
/// proxy a connection is now and then refused or cut off and works a moment later.
const RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(700), Duration::from_millis(1500)];

/// Why a request failed, and whether asking again could help.
#[derive(Debug)]
struct Failure {
    message: String,
    transient: bool,
}

impl Failure {
    fn permanent(message: impl Into<String>) -> Self {
        Failure { message: message.into(), transient: false }
    }

    /// A refused or dropped connection is worth asking again; a timeout already cost its whole wait.
    fn from_network(error: &reqwest::Error) -> Self {
        Failure { message: network_error(error), transient: !error.is_timeout() }
    }
}

/// Runs `operation` again after each of `delays` for as long as it fails in a way that may pass.
async fn with_retries<T, F, Fut>(delays: &[Duration], mut operation: F) -> Result<T, Failure>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, Failure>>,
{
    let mut repeats = 0;
    loop {
        match operation().await {
            Err(failure) if failure.transient && repeats < delays.len() => {
                tokio::time::sleep(delays[repeats]).await;
                repeats += 1;
            }
            other => return other,
        }
    }
}

async fn get_text_once(client: &reqwest::Client, url: &str, accept: &str) -> Result<(StatusCode, String), Failure> {
    let response = tokio::time::timeout(
        REQUEST_TIMEOUT,
        client
            .get(url)
            .header("accept", accept)
            .header("accept-language", "en-US,en;q=0.9")
            .send(),
    )
    .await
    .map_err(|_| Failure::permanent("连接 YouTube 超时。"))?
    .map_err(|error| Failure::from_network(&error))?;
    let status = response.status();
    let bytes = tokio::time::timeout(REQUEST_TIMEOUT, response.bytes())
        .await
        .map_err(|_| Failure::permanent("读取 YouTube 的回应超时。"))?
        .map_err(|error| Failure::from_network(&error))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(Failure::permanent("YouTube 的回应过大。"));
    }
    Ok((status, String::from_utf8_lossy(&bytes).into_owned()))
}

async fn get_text(client: &reqwest::Client, url: &str, accept: &str) -> Result<(StatusCode, String), String> {
    with_retries(&RETRY_DELAYS, || get_text_once(client, url, accept))
        .await
        .map_err(|failure| failure.message)
}

fn status_error(status: StatusCode) -> String {
    match status.as_u16() {
        404 => "找不到这个频道，它可能已被删除。".to_string(),
        403 | 429 => "YouTube 暂时限制了请求，请稍后再试。".to_string(),
        code => format!("YouTube 返回了 HTTP {code}。"),
    }
}

#[derive(Debug)]
struct FetchedFeed {
    channel_name: Option<String>,
    videos: Vec<store::VideoInput>,
}

fn read_feed(status: StatusCode, body: &str, channel_id: &str) -> Result<FetchedFeed, String> {
    if !status.is_success() {
        return Err(status_error(status));
    }
    let parsed = store::parse_feed(body)?;
    Ok(FetchedFeed {
        channel_name: parsed.channel_name.clone(),
        videos: store::feed_videos(&parsed, channel_id, None),
    })
}

/// The channel's latest long videos. YouTube keeps an uploads playlist without Shorts and live
/// streams for every channel (its id is the channel's with `UULF` for `UC`); the channel's own feed
/// mixes the Shorts in, so it is only the fallback for a channel without that playlist.
async fn fetch_channel_feed(client: &reqwest::Client, channel_id: &str) -> Result<FetchedFeed, String> {
    let long_form = store::long_form_playlist_id(channel_id).ok_or_else(|| "频道编号无效。".to_string())?;
    let url = format!("https://www.youtube.com/feeds/videos.xml?playlist_id={long_form}");
    let (status, body) = get_text(client, &url, ATOM_ACCEPT).await?;
    if status != StatusCode::NOT_FOUND {
        return read_feed(status, &body, channel_id);
    }
    let url = format!("https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}");
    let (status, body) = get_text(client, &url, ATOM_ACCEPT).await?;
    read_feed(status, &body, channel_id)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedFetchResult {
    channel_name: Option<String>,
    total: usize,
    new_video_ids: Vec<String>,
}

/// Checks one channel for new videos and keeps them. A failure is recorded on the channel, which
/// makes the next refresh try it again.
#[tauri::command]
pub async fn player_fetch_feed(
    app: AppHandle,
    net: State<'_, YouTubeNet>,
    channel_id: String,
) -> Result<FeedFetchResult, String> {
    if !store::is_channel_id(&channel_id) {
        return Err("频道编号无效。".to_string());
    }
    let client = net.client(RedirectScope::YouTube)?;
    let outcome = fetch_channel_feed(&client, &channel_id).await;
    let connection = open(&app)?;
    let timestamp = now();
    match outcome {
        Ok(fetched) => {
            let new_video_ids = store::new_video_ids(&connection, &fetched.videos)?;
            let videos: Vec<store::VideoInput> = fetched
                .videos
                .into_iter()
                .map(|mut video| {
                    video.channel_name = video.channel_name.or_else(|| fetched.channel_name.clone());
                    video
                })
                .collect();
            store::store_videos(&connection, &videos, timestamp)?;
            store::mark_channel_checked(&connection, &channel_id, timestamp)?;
            store::prune(&connection, timestamp)?;
            Ok(FeedFetchResult {
                channel_name: fetched.channel_name,
                total: videos.len(),
                new_video_ids,
            })
        }
        Err(message) => {
            store::mark_channel_error(&connection, &channel_id, &message)?;
            Err(message)
        }
    }
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoBasics {
    video_id: String,
    title: String,
    channel_name: Option<String>,
}

fn parse_oembed(video_id: &str, text: &str) -> Result<VideoBasics, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| "YouTube 没有返回视频信息。".to_string())?;
    let title = value
        .get("title")
        .and_then(|title| title.as_str())
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .ok_or_else(|| "YouTube 没有返回视频标题。".to_string())?;
    Ok(VideoBasics {
        video_id: video_id.to_string(),
        title: title.to_string(),
        channel_name: value
            .get("author_name")
            .and_then(|name| name.as_str())
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string),
    })
}

/// A video's title and channel name, for a link the user pasted. YouTube's oEmbed answer is tiny and
/// does not go through the bot check that stream addresses do.
#[tauri::command]
pub async fn player_fetch_video_info(net: State<'_, YouTubeNet>, video_id: String) -> Result<VideoBasics, String> {
    if !store::is_video_id(&video_id) {
        return Err("视频编号无效。".to_string());
    }
    let client = net.client(RedirectScope::YouTube)?;
    let mut url = url::Url::parse("https://www.youtube.com/oembed").map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("url", &format!("https://www.youtube.com/watch?v={video_id}"))
        .append_pair("format", "json");
    let (status, body) = get_text(&client, url.as_str(), "application/json").await?;
    match status.as_u16() {
        200 => parse_oembed(&video_id, &body),
        401 => Err("这个视频不允许嵌入，读不到它的标题。".to_string()),
        404 => Err("找不到这个视频，它可能已被删除或设为私享。".to_string()),
        403 | 429 => Err("YouTube 暂时限制了请求，请稍后再试。".to_string()),
        code => Err(format!("YouTube 返回了 HTTP {code}。")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_feed_that_answers_404_names_the_cause() {
        let error = read_feed(StatusCode::NOT_FOUND, "<html></html>", "UCYO_jab_esuFRV4b17AJtAw").unwrap_err();
        assert!(error.contains("找不到"));
        assert!(read_feed(StatusCode::TOO_MANY_REQUESTS, "", "UCYO_jab_esuFRV4b17AJtAw")
            .unwrap_err()
            .contains("限制"));
        assert!(read_feed(StatusCode::INTERNAL_SERVER_ERROR, "", "UCYO_jab_esuFRV4b17AJtAw")
            .unwrap_err()
            .contains("500"));
    }

    #[test]
    fn a_good_feed_gives_its_channel_name_and_leaves_the_shorts_out() {
        let body = r#"<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
            <title>Videos</title><author><name>频道甲</name></author>
            <entry><yt:videoId>aaaaaaaaaaa</yt:videoId><title>长</title><link rel="alternate" href="https://www.youtube.com/watch?v=aaaaaaaaaaa"/><published>2026-10-01T00:00:00+00:00</published></entry>
            <entry><yt:videoId>bbbbbbbbbbb</yt:videoId><title>短</title><link rel="alternate" href="https://www.youtube.com/shorts/bbbbbbbbbbb"/></entry>
        </feed>"#;
        let fetched = read_feed(StatusCode::OK, body, "UCYO_jab_esuFRV4b17AJtAw").unwrap();
        assert_eq!(fetched.channel_name.as_deref(), Some("频道甲"));
        assert_eq!(fetched.videos.len(), 1);
        assert_eq!(fetched.videos[0].video_id, "aaaaaaaaaaa");
        assert_eq!(fetched.videos[0].channel_id.as_deref(), Some("UCYO_jab_esuFRV4b17AJtAw"));
    }

    #[test]
    fn oembed_gives_the_title_and_the_author() {
        let basics = parse_oembed(
            "dQw4w9WgXcQ",
            r#"{"title":" Never Gonna Give You Up ","author_name":"Rick Astley","author_url":"https://www.youtube.com/@RickAstley"}"#,
        )
        .unwrap();
        assert_eq!(
            basics,
            VideoBasics {
                video_id: "dQw4w9WgXcQ".to_string(),
                title: "Never Gonna Give You Up".to_string(),
                channel_name: Some("Rick Astley".to_string()),
            }
        );
        assert!(parse_oembed("dQw4w9WgXcQ", r#"{"title":"  "}"#).is_err());
        assert!(parse_oembed("dQw4w9WgXcQ", "Unauthorized").is_err());
    }

    fn dropped() -> Failure {
        Failure { message: "连接被中断".to_string(), transient: true }
    }

    #[tokio::test]
    async fn a_dropped_connection_is_asked_again_and_the_later_answer_counts() {
        let calls = std::cell::Cell::new(0);
        let outcome = with_retries(&[Duration::ZERO, Duration::ZERO], || {
            calls.set(calls.get() + 1);
            let attempt = calls.get();
            async move { if attempt < 3 { Err(dropped()) } else { Ok("answer") } }
        })
        .await;
        assert_eq!(outcome.unwrap(), "answer");
        assert_eq!(calls.get(), 3);
    }

    #[tokio::test]
    async fn the_last_failure_is_returned_when_every_repeat_fails() {
        let calls = std::cell::Cell::new(0);
        let outcome: Result<(), Failure> = with_retries(&[Duration::ZERO], || {
            calls.set(calls.get() + 1);
            async { Err(dropped()) }
        })
        .await;
        assert_eq!(outcome.unwrap_err().message, "连接被中断");
        assert_eq!(calls.get(), 2, "one try and one repeat");
    }

    #[tokio::test]
    async fn a_failure_that_asking_again_cannot_fix_is_not_repeated() {
        let calls = std::cell::Cell::new(0);
        let outcome: Result<(), Failure> = with_retries(&[Duration::ZERO, Duration::ZERO], || {
            calls.set(calls.get() + 1);
            async { Err(Failure::permanent("连接 YouTube 超时。")) }
        })
        .await;
        assert_eq!(outcome.unwrap_err().message, "连接 YouTube 超时。");
        assert_eq!(calls.get(), 1);
    }

    #[tokio::test]
    async fn a_good_answer_is_not_repeated() {
        let calls = std::cell::Cell::new(0);
        let outcome = with_retries(&[Duration::ZERO, Duration::ZERO], || {
            calls.set(calls.get() + 1);
            async { Ok::<_, Failure>(7) }
        })
        .await;
        assert_eq!(outcome.unwrap(), 7);
        assert_eq!(calls.get(), 1);
    }

    /// Asks YouTube for a real channel's feed; needs network access.
    #[tokio::test]
    #[ignore = "needs network access to YouTube"]
    async fn live_feed_of_a_real_channel_has_no_shorts() {
        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0")
            .build()
            .unwrap();
        let fetched = fetch_channel_feed(&client, "UCYO_jab_esuFRV4b17AJtAw").await.unwrap();
        assert_eq!(fetched.channel_name.as_deref(), Some("3Blue1Brown"));
        assert!(fetched.videos.len() >= 5, "{} videos", fetched.videos.len());
        assert!(fetched.videos.iter().all(|video| video.published_at.is_some()));
    }

    /// Asks YouTube for a real video's oEmbed answer; needs network access.
    #[tokio::test]
    #[ignore = "needs network access to YouTube"]
    async fn live_oembed_of_a_real_video() {
        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0")
            .build()
            .unwrap();
        let (status, body) = get_text(
            &client,
            "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json",
            "application/json",
        )
        .await
        .unwrap();
        assert_eq!(status, StatusCode::OK);
        let basics = parse_oembed("dQw4w9WgXcQ", &body).unwrap();
        assert!(basics.title.contains("Never Gonna Give You Up"));
    }
}
