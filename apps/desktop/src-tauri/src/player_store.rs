//! Local data for the player page: the channels the user follows, the videos they list, watch
//! progress, history and playlists. It follows the shape of NewPipe's database (subscriptions, a
//! feed of their latest videos, per-video playback state, history, local playlists) without
//! sharing any of its code.
//!
//! Everything here works on a `rusqlite::Connection` and takes the current time as an argument, so
//! it can be tested against an in-memory database. The Tauri commands and the network access live
//! in `player.rs`.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use uuid::Uuid;

pub const FAVORITES_ID: &str = "favorites";
pub const WATCH_LATER_ID: &str = "watch-later";

/// Playback is only remembered once it passed this point (or a quarter of the video), so opening a
/// video and leaving at once does not overwrite where the user really was.
const SAVE_THRESHOLD_SECONDS: f64 = 5.0;
/// Videos of followed channels older than this leave the local cache (unless something refers to
/// them): 13 weeks, as in NewPipe.
const FEED_RETENTION_SECONDS: i64 = 13 * 7 * 24 * 3600;
const MAX_TEXT_CHARS: usize = 500;
const MAX_DESCRIPTION_CHARS: usize = 4_000;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS channels (
    channel_id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    handle TEXT,
    avatar_url TEXT,
    description TEXT,
    subscribed_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    last_error TEXT
);
CREATE TABLE IF NOT EXISTS videos (
    video_id TEXT PRIMARY KEY NOT NULL,
    channel_id TEXT,
    channel_name TEXT,
    title TEXT NOT NULL,
    published_at INTEGER,
    published_approx INTEGER NOT NULL DEFAULT 0,
    duration_seconds INTEGER,
    view_count INTEGER,
    view_text TEXT,
    thumbnail_url TEXT,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_channel_published ON videos(channel_id, published_at DESC);
CREATE TABLE IF NOT EXISTS watch_state (
    video_id TEXT PRIMARY KEY NOT NULL,
    progress_seconds REAL NOT NULL,
    duration_seconds REAL,
    finished_override INTEGER,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
    video_id TEXT PRIMARY KEY NOT NULL,
    first_played_at INTEGER NOT NULL,
    last_played_at INTEGER NOT NULL,
    play_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_history_last ON history(last_played_at DESC);
CREATE TABLE IF NOT EXISTS playlists (
    playlist_id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    remote_id TEXT,
    channel_name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 10
);
CREATE TABLE IF NOT EXISTS playlist_items (
    playlist_id TEXT NOT NULL REFERENCES playlists(playlist_id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    video_id TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, position),
    UNIQUE (playlist_id, video_id)
);
CREATE INDEX IF NOT EXISTS idx_playlist_items_video ON playlist_items(video_id);
CREATE TABLE IF NOT EXISTS learning_paths (
    path_id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS learning_path_nodes (
    path_id TEXT NOT NULL REFERENCES learning_paths(path_id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    parent_id TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    note TEXT,
    video_id TEXT,
    start_seconds INTEGER NOT NULL DEFAULT 0,
    optional INTEGER NOT NULL DEFAULT 0,
    prerequisites_json TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (path_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_learning_path_nodes_video ON learning_path_nodes(video_id);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
";

// ---- types shared with the front end ------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub channel_id: String,
    pub name: String,
    pub handle: Option<String>,
    pub avatar_url: Option<String>,
    pub description: Option<String>,
    pub subscribed_at: i64,
    pub last_checked_at: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChannelInput {
    pub channel_id: String,
    pub name: String,
    pub handle: Option<String>,
    pub avatar_url: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoInput {
    pub video_id: String,
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
    pub title: String,
    /// Unix seconds. A listing that only says "5 days ago" gives an approximation and sets
    /// `published_approx`, which never replaces an exact date.
    pub published_at: Option<i64>,
    pub published_approx: bool,
    pub duration_seconds: Option<i64>,
    pub view_count: Option<i64>,
    pub view_text: Option<String>,
    pub thumbnail_url: Option<String>,
}

/// A video as a list shows it: what is known about it plus what the user did with it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoItem {
    #[serde(flatten)]
    pub video: VideoInput,
    pub progress_seconds: Option<f64>,
    pub finished: bool,
    pub last_played_at: Option<i64>,
    pub favorite: bool,
    pub watch_later: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchState {
    pub progress_seconds: f64,
    pub duration_seconds: Option<f64>,
    pub finished: bool,
    /// Where playback should start: the saved position, or the beginning once the video is watched.
    pub resume_seconds: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub playlist_id: String,
    pub name: String,
    /// "local" for the user's own lists, "course" for a YouTube playlist kept in step with YouTube.
    pub kind: String,
    pub remote_id: Option<String>,
    pub channel_name: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub item_count: i64,
    pub finished_count: i64,
    pub builtin: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlayerSettings {
    /// A channel is checked again for new videos once its last check is older than this.
    pub feed_update_threshold_seconds: i64,
    pub hide_finished_in_feed: bool,
    /// Start the next video of a course or playlist when one ends.
    pub autoplay_next: bool,
    /// Pause the video when the player page is left for another page.
    pub pause_when_hidden: bool,
}

impl Default for PlayerSettings {
    fn default() -> Self {
        Self {
            feed_update_threshold_seconds: 3600,
            hide_finished_in_feed: false,
            autoplay_next: true,
            pause_when_hidden: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub channels: Vec<Channel>,
    pub playlists: Vec<Playlist>,
    pub learning_paths: Vec<LearningPathSummary>,
    pub settings: PlayerSettings,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningPathSummary {
    pub path_id: String,
    pub title: String,
    pub description: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub node_count: i64,
    pub video_count: i64,
    pub finished_count: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LearningPathNodeInput {
    pub node_id: String,
    pub parent_id: Option<String>,
    pub position: i64,
    /// "stage" | "video" | "checkpoint"
    pub kind: String,
    pub title: String,
    pub note: Option<String>,
    pub video_id: Option<String>,
    pub start_seconds: i64,
    pub optional: bool,
    pub prerequisite_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LearningPathInput {
    pub path_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub nodes: Vec<LearningPathNodeInput>,
    pub videos: Vec<VideoInput>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningPathNode {
    pub node_id: String,
    pub parent_id: Option<String>,
    pub position: i64,
    pub kind: String,
    pub title: String,
    pub note: Option<String>,
    pub video_id: Option<String>,
    pub start_seconds: i64,
    pub optional: bool,
    pub prerequisite_ids: Vec<String>,
    pub video: Option<VideoItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningPathDetail {
    pub summary: LearningPathSummary,
    pub nodes: Vec<LearningPathNode>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FeedQuery {
    pub channel_id: Option<String>,
    pub hide_finished: bool,
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub added: usize,
    pub existing: usize,
    pub invalid: usize,
}

// ---- opening ------------------------------------------------------------------------------------

fn db_error(error: rusqlite::Error) -> String {
    format!("播放器数据库错误：{error}")
}

pub fn open(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(db_error)?;
    prepare(&connection)?;
    Ok(connection)
}

/// Creates the tables when they are missing and the two lists every library starts with.
pub fn prepare(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA busy_timeout = 3000;
             PRAGMA foreign_keys = ON;",
        )
        .map_err(db_error)?;
    connection.execute_batch(SCHEMA).map_err(db_error)?;
    connection
        .execute_batch(&format!(
            "INSERT OR IGNORE INTO playlists(playlist_id, name, kind, created_at, updated_at, sort_order)
                 VALUES ('{FAVORITES_ID}', '收藏', 'local', 0, 0, 0);
             INSERT OR IGNORE INTO playlists(playlist_id, name, kind, created_at, updated_at, sort_order)
                 VALUES ('{WATCH_LATER_ID}', '稍后看', 'local', 0, 0, 1);"
        ))
        .map_err(db_error)
}

// ---- validation helpers -------------------------------------------------------------------------

pub fn is_video_id(value: &str) -> bool {
    value.len() == 11
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

pub fn is_channel_id(value: &str) -> bool {
    value.len() == 24
        && value.starts_with("UC")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn is_remote_playlist_id(value: &str) -> bool {
    (2..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// The id of the playlist YouTube keeps of a channel's long videos (no Shorts, no live streams).
pub fn long_form_playlist_id(channel_id: &str) -> Option<String> {
    is_channel_id(channel_id).then(|| format!("UULF{}", &channel_id[2..]))
}

fn clean(value: &str, limit: usize) -> String {
    value.trim().chars().take(limit).collect()
}

fn clean_option(value: &Option<String>, limit: usize) -> Option<String> {
    value
        .as_deref()
        .map(|text| clean(text, limit))
        .filter(|text| !text.is_empty())
}

// ---- channels -----------------------------------------------------------------------------------

fn channel_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Channel> {
    Ok(Channel {
        channel_id: row.get(0)?,
        name: row.get(1)?,
        handle: row.get(2)?,
        avatar_url: row.get(3)?,
        description: row.get(4)?,
        subscribed_at: row.get(5)?,
        last_checked_at: row.get(6)?,
        last_error: row.get(7)?,
    })
}

const CHANNEL_COLUMNS: &str =
    "channel_id, name, handle, avatar_url, description, subscribed_at, last_checked_at, last_error";

pub fn channels(connection: &Connection) -> Result<Vec<Channel>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT {CHANNEL_COLUMNS} FROM channels ORDER BY name COLLATE NOCASE, channel_id"
        ))
        .map_err(db_error)?;
    let rows = statement
        .query_map([], channel_from_row)
        .map_err(db_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

pub fn channel(connection: &Connection, channel_id: &str) -> Result<Option<Channel>, String> {
    connection
        .query_row(
            &format!("SELECT {CHANNEL_COLUMNS} FROM channels WHERE channel_id = ?1"),
            params![channel_id],
            channel_from_row,
        )
        .optional()
        .map_err(db_error)
}

/// Follows a channel, or refreshes what is known about one that is already followed.
pub fn subscribe(connection: &Connection, input: &ChannelInput, now: i64) -> Result<Channel, String> {
    if !is_channel_id(&input.channel_id) {
        return Err("频道编号无效，应为以 UC 开头的 24 个字符。".to_string());
    }
    let name = clean(&input.name, MAX_TEXT_CHARS);
    let name = if name.is_empty() {
        input.channel_id.clone()
    } else {
        name
    };
    connection
        .execute(
            "INSERT INTO channels(channel_id, name, handle, avatar_url, description, subscribed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(channel_id) DO UPDATE SET
                 name = CASE WHEN ?7 THEN excluded.name ELSE name END,
                 handle = COALESCE(excluded.handle, handle),
                 avatar_url = COALESCE(excluded.avatar_url, avatar_url),
                 description = COALESCE(excluded.description, description)",
            params![
                input.channel_id,
                name,
                clean_option(&input.handle, 100),
                clean_option(&input.avatar_url, 1_000),
                clean_option(&input.description, MAX_DESCRIPTION_CHARS),
                now,
                !input.name.trim().is_empty(),
            ],
        )
        .map_err(db_error)?;
    channel(connection, &input.channel_id)?.ok_or_else(|| "订阅失败。".to_string())
}

/// Adds channels that are not followed yet; those that are keep what they have.
pub fn import_channels(
    connection: &Connection,
    inputs: &[ChannelInput],
    now: i64,
) -> Result<ImportSummary, String> {
    let transaction = connection.unchecked_transaction().map_err(db_error)?;
    let mut summary = ImportSummary::default();
    for input in inputs {
        if !is_channel_id(&input.channel_id) {
            summary.invalid += 1;
            continue;
        }
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM channels WHERE channel_id = ?1)",
                params![input.channel_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if exists {
            summary.existing += 1;
            continue;
        }
        subscribe(&transaction, input, now)?;
        summary.added += 1;
    }
    transaction.commit().map_err(db_error)?;
    Ok(summary)
}

pub fn unsubscribe(connection: &Connection, channel_id: &str, now: i64) -> Result<(), String> {
    connection
        .execute("DELETE FROM channels WHERE channel_id = ?1", params![channel_id])
        .map_err(db_error)?;
    prune(connection, now)
}

/// What a channel page learned about its channel, kept for the followed ones.
pub fn update_channel_info(connection: &Connection, input: &ChannelInput) -> Result<(), String> {
    connection
        .execute(
            "UPDATE channels SET
                 name = COALESCE(NULLIF(?2, ''), name),
                 handle = COALESCE(?3, handle),
                 avatar_url = COALESCE(?4, avatar_url),
                 description = COALESCE(?5, description)
             WHERE channel_id = ?1",
            params![
                input.channel_id,
                clean(&input.name, MAX_TEXT_CHARS),
                clean_option(&input.handle, 100),
                clean_option(&input.avatar_url, 1_000),
                clean_option(&input.description, MAX_DESCRIPTION_CHARS),
            ],
        )
        .map_err(db_error)?;
    Ok(())
}

pub fn mark_channel_checked(connection: &Connection, channel_id: &str, now: i64) -> Result<(), String> {
    connection
        .execute(
            "UPDATE channels SET last_checked_at = ?2, last_error = NULL WHERE channel_id = ?1",
            params![channel_id, now],
        )
        .map_err(db_error)?;
    Ok(())
}

/// A failed check leaves `last_checked_at` alone and records why, so the channel is tried again on
/// the next refresh.
pub fn mark_channel_error(connection: &Connection, channel_id: &str, message: &str) -> Result<(), String> {
    connection
        .execute(
            "UPDATE channels SET last_error = ?2 WHERE channel_id = ?1",
            params![channel_id, clean(message, MAX_TEXT_CHARS)],
        )
        .map_err(db_error)?;
    Ok(())
}

// ---- videos -------------------------------------------------------------------------------------

/// SQL that says whether a video counts as watched, for rows joined as `v` (videos) and `ws`
/// (watch_state): less than a minute left and at least three quarters played, as in NewPipe. A mark
/// the user made by hand wins over the rule.
const FINISHED_SQL: &str = "(CASE
        WHEN ws.video_id IS NULL THEN 0
        WHEN ws.finished_override IS NOT NULL THEN ws.finished_override
        WHEN COALESCE(v.duration_seconds, ws.duration_seconds) IS NULL THEN 0
        WHEN ws.progress_seconds >= COALESCE(v.duration_seconds, ws.duration_seconds) - 60
         AND ws.progress_seconds >= COALESCE(v.duration_seconds, ws.duration_seconds) * 0.75 THEN 1
        ELSE 0 END)";

fn item_columns() -> String {
    format!(
        "v.video_id, v.channel_id, v.channel_name, v.title, v.published_at, v.published_approx,
         COALESCE(v.duration_seconds, CAST(ws.duration_seconds AS INTEGER)), v.view_count, v.view_text,
         v.thumbnail_url, ws.progress_seconds, {FINISHED_SQL}, h.last_played_at,
         EXISTS(SELECT 1 FROM playlist_items f WHERE f.playlist_id = '{FAVORITES_ID}' AND f.video_id = v.video_id),
         EXISTS(SELECT 1 FROM playlist_items w WHERE w.playlist_id = '{WATCH_LATER_ID}' AND w.video_id = v.video_id)"
    )
}

const ITEM_JOINS: &str = "LEFT JOIN watch_state ws ON ws.video_id = v.video_id
     LEFT JOIN history h ON h.video_id = v.video_id";

fn item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<VideoItem> {
    Ok(VideoItem {
        video: VideoInput {
            video_id: row.get(0)?,
            channel_id: row.get(1)?,
            channel_name: row.get(2)?,
            title: row.get(3)?,
            published_at: row.get(4)?,
            published_approx: row.get::<_, i64>(5)? != 0,
            duration_seconds: row.get(6)?,
            view_count: row.get(7)?,
            view_text: row.get(8)?,
            thumbnail_url: row.get(9)?,
        },
        progress_seconds: row.get(10)?,
        finished: row.get::<_, i64>(11)? != 0,
        last_played_at: row.get(12)?,
        favorite: row.get::<_, i64>(13)? != 0,
        watch_later: row.get::<_, i64>(14)? != 0,
    })
}

fn upsert_video(connection: &Connection, video: &VideoInput, now: i64) -> Result<bool, String> {
    if !is_video_id(&video.video_id) {
        return Ok(false);
    }
    let title = clean(&video.title, MAX_TEXT_CHARS);
    let title = if title.is_empty() {
        video.video_id.clone()
    } else {
        title
    };
    let channel_id = video
        .channel_id
        .as_deref()
        .filter(|id| is_channel_id(id))
        .map(str::to_string);
    connection
        .execute(
            "INSERT INTO videos(video_id, channel_id, channel_name, title, published_at, published_approx,
                                duration_seconds, view_count, view_text, thumbnail_url, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(video_id) DO UPDATE SET
                 channel_id = COALESCE(excluded.channel_id, channel_id),
                 channel_name = COALESCE(excluded.channel_name, channel_name),
                 title = CASE WHEN ?12 THEN excluded.title ELSE title END,
                 published_at = CASE
                     WHEN excluded.published_at IS NULL THEN published_at
                     WHEN published_at IS NOT NULL AND published_approx = 0 AND excluded.published_approx = 1
                         THEN published_at
                     ELSE excluded.published_at END,
                 published_approx = CASE
                     WHEN excluded.published_at IS NULL THEN published_approx
                     WHEN published_at IS NOT NULL AND published_approx = 0 AND excluded.published_approx = 1
                         THEN published_approx
                     ELSE excluded.published_approx END,
                 duration_seconds = COALESCE(excluded.duration_seconds, duration_seconds),
                 view_count = COALESCE(excluded.view_count, view_count),
                 view_text = COALESCE(excluded.view_text, view_text),
                 thumbnail_url = COALESCE(excluded.thumbnail_url, thumbnail_url),
                 updated_at = excluded.updated_at",
            params![
                video.video_id,
                channel_id,
                clean_option(&video.channel_name, MAX_TEXT_CHARS),
                title,
                video.published_at,
                video.published_approx,
                video.duration_seconds.filter(|seconds| *seconds > 0),
                video.view_count.filter(|count| *count >= 0),
                clean_option(&video.view_text, 100),
                clean_option(&video.thumbnail_url, 1_000),
                now,
                !video.title.trim().is_empty(),
            ],
        )
        .map_err(db_error)?;
    Ok(true)
}

/// Saves what a listing told about its videos and returns them as list items, in the same order.
/// Entries without a valid video id are left out.
pub fn store_videos(connection: &Connection, videos: &[VideoInput], now: i64) -> Result<Vec<VideoItem>, String> {
    let transaction = connection.unchecked_transaction().map_err(db_error)?;
    let mut ids = Vec::with_capacity(videos.len());
    for video in videos {
        if upsert_video(&transaction, video, now)? {
            ids.push(video.video_id.clone());
        }
    }
    transaction.commit().map_err(db_error)?;
    video_items(connection, &ids)
}

pub fn video_items(connection: &Connection, video_ids: &[String]) -> Result<Vec<VideoItem>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT {} FROM videos v {ITEM_JOINS} WHERE v.video_id = ?1",
            item_columns()
        ))
        .map_err(db_error)?;
    let mut items = Vec::with_capacity(video_ids.len());
    for id in video_ids {
        if let Some(item) = statement
            .query_row(params![id], item_from_row)
            .optional()
            .map_err(db_error)?
        {
            items.push(item);
        }
    }
    Ok(items)
}

/// The newest videos of the followed channels, newest first. A video that has no date (the videos of
/// a playlist saved as a course come without one) is not a new upload, so it stays out of the feed
/// rather than showing up as if it had just been published.
pub fn feed(connection: &Connection, query: &FeedQuery) -> Result<Vec<VideoItem>, String> {
    let limit = if query.limit <= 0 { 60 } else { query.limit.min(500) };
    let mut statement = connection
        .prepare(&format!(
            "SELECT {} FROM videos v
             JOIN channels c ON c.channel_id = v.channel_id
             {ITEM_JOINS}
             WHERE (?1 IS NULL OR v.channel_id = ?1)
               AND v.published_at IS NOT NULL
               AND (?2 = 0 OR {FINISHED_SQL} = 0)
             ORDER BY v.published_at DESC, v.video_id
             LIMIT ?3 OFFSET ?4",
            item_columns()
        ))
        .map_err(db_error)?;
    let rows = statement
        .query_map(
            params![query.channel_id, query.hide_finished, limit, query.offset.max(0)],
            item_from_row,
        )
        .map_err(db_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

/// Removes cached videos nothing refers to any more: those of channels that are no longer followed,
/// and followed ones older than the retention period.
pub fn prune(connection: &Connection, now: i64) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM videos
             WHERE video_id NOT IN (SELECT video_id FROM playlist_items)
               AND video_id NOT IN (SELECT video_id FROM history)
               AND video_id NOT IN (SELECT video_id FROM watch_state)
               AND video_id NOT IN (SELECT video_id FROM learning_path_nodes WHERE video_id IS NOT NULL)
               AND (channel_id IS NULL
                    OR channel_id NOT IN (SELECT channel_id FROM channels)
                    OR COALESCE(published_at, updated_at) < ?1)",
            params![now - FEED_RETENTION_SECONDS],
        )
        .map_err(db_error)?;
    Ok(())
}

// ---- watch state and history --------------------------------------------------------------------

fn state_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WatchState> {
    let progress: f64 = row.get(0)?;
    let duration: Option<f64> = row.get(1)?;
    let finished = row.get::<_, i64>(2)? != 0;
    Ok(WatchState {
        progress_seconds: progress,
        duration_seconds: duration,
        finished,
        resume_seconds: if finished { 0.0 } else { progress },
    })
}

pub fn watch_state(connection: &Connection, video_id: &str) -> Result<Option<WatchState>, String> {
    connection
        .query_row(
            &format!(
                "SELECT ws.progress_seconds,
                        COALESCE(ws.duration_seconds, CAST(v.duration_seconds AS REAL)),
                        {FINISHED_SQL}
                 FROM watch_state ws LEFT JOIN videos v ON v.video_id = ws.video_id
                 WHERE ws.video_id = ?1"
            ),
            params![video_id],
            state_from_row,
        )
        .optional()
        .map_err(db_error)
}

/// Remembers where playback is, by NewPipe's rules: a position is only kept once it passed five
/// seconds or a quarter of the video, and an earlier one stays when a new visit ends sooner.
pub fn save_progress(
    connection: &Connection,
    video_id: &str,
    progress_seconds: f64,
    duration_seconds: Option<f64>,
    now: i64,
) -> Result<Option<WatchState>, String> {
    if !is_video_id(video_id) {
        return Err("视频编号无效。".to_string());
    }
    let duration = duration_seconds.filter(|seconds| seconds.is_finite() && *seconds > 0.0);
    if progress_seconds.is_finite() && progress_seconds >= 0.0 {
        let progress = duration.map_or(progress_seconds, |total| progress_seconds.min(total));
        let valid = progress > SAVE_THRESHOLD_SECONDS || duration.is_some_and(|total| progress > total / 4.0);
        if valid {
            connection
                .execute(
                    "INSERT INTO watch_state(video_id, progress_seconds, duration_seconds, finished_override, updated_at)
                     VALUES (?1, ?2, ?3, NULL, ?4)
                     ON CONFLICT(video_id) DO UPDATE SET
                         progress_seconds = excluded.progress_seconds,
                         duration_seconds = COALESCE(excluded.duration_seconds, duration_seconds),
                         finished_override = NULL,
                         updated_at = excluded.updated_at",
                    params![video_id, progress, duration, now],
                )
                .map_err(db_error)?;
        }
    }
    watch_state(connection, video_id)
}

/// Marks a video watched or not by hand.
pub fn set_watched(connection: &Connection, video_id: &str, watched: bool, now: i64) -> Result<(), String> {
    if !is_video_id(video_id) {
        return Err("视频编号无效。".to_string());
    }
    if watched {
        connection
            .execute(
                "INSERT INTO watch_state(video_id, progress_seconds, duration_seconds, finished_override, updated_at)
                 VALUES (?1,
                         COALESCE((SELECT CAST(duration_seconds AS REAL) FROM videos WHERE video_id = ?1), 0),
                         NULL, 1, ?2)
                 ON CONFLICT(video_id) DO UPDATE SET
                     progress_seconds = MAX(progress_seconds,
                         COALESCE((SELECT CAST(duration_seconds AS REAL) FROM videos WHERE video_id = ?1), 0)),
                     finished_override = 1,
                     updated_at = excluded.updated_at",
                params![video_id, now],
            )
            .map_err(db_error)?;
    } else {
        connection
            .execute("DELETE FROM watch_state WHERE video_id = ?1", params![video_id])
            .map_err(db_error)?;
    }
    Ok(())
}

/// Records that a video was opened, for the history list.
pub fn mark_played(connection: &Connection, video_id: &str, now: i64) -> Result<(), String> {
    if !is_video_id(video_id) {
        return Err("视频编号无效。".to_string());
    }
    connection
        .execute(
            "INSERT INTO history(video_id, first_played_at, last_played_at, play_count)
             VALUES (?1, ?2, ?2, 1)
             ON CONFLICT(video_id) DO UPDATE SET
                 last_played_at = excluded.last_played_at,
                 play_count = play_count + 1",
            params![video_id, now],
        )
        .map_err(db_error)?;
    Ok(())
}

pub fn history(connection: &Connection, limit: i64, offset: i64) -> Result<Vec<VideoItem>, String> {
    let limit = if limit <= 0 { 100 } else { limit.min(1_000) };
    let mut statement = connection
        .prepare(&format!(
            "SELECT {} FROM history h JOIN videos v ON v.video_id = h.video_id
             LEFT JOIN watch_state ws ON ws.video_id = v.video_id
             ORDER BY h.last_played_at DESC, v.video_id LIMIT ?1 OFFSET ?2",
            item_columns()
        ))
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![limit, offset.max(0)], item_from_row)
        .map_err(db_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

pub fn remove_from_history(connection: &Connection, video_id: &str) -> Result<(), String> {
    connection
        .execute("DELETE FROM history WHERE video_id = ?1", params![video_id])
        .map_err(db_error)?;
    Ok(())
}

pub fn clear_history(connection: &Connection) -> Result<(), String> {
    connection
        .execute("DELETE FROM history", [])
        .map_err(db_error)?;
    Ok(())
}

// ---- playlists ----------------------------------------------------------------------------------

fn playlist_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Playlist> {
    let playlist_id: String = row.get(0)?;
    Ok(Playlist {
        builtin: playlist_id == FAVORITES_ID || playlist_id == WATCH_LATER_ID,
        playlist_id,
        name: row.get(1)?,
        kind: row.get(2)?,
        remote_id: row.get(3)?,
        channel_name: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        item_count: row.get(7)?,
        finished_count: row.get(8)?,
    })
}

fn playlist_select() -> String {
    format!(
        "SELECT p.playlist_id, p.name, p.kind, p.remote_id, p.channel_name, p.created_at, p.updated_at,
                (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.playlist_id),
                (SELECT COUNT(*) FROM playlist_items i
                     JOIN videos v ON v.video_id = i.video_id
                     LEFT JOIN watch_state ws ON ws.video_id = i.video_id
                     WHERE i.playlist_id = p.playlist_id AND {FINISHED_SQL} = 1)
         FROM playlists p"
    )
}

pub fn playlists(connection: &Connection) -> Result<Vec<Playlist>, String> {
    let mut statement = connection
        .prepare(&format!(
            "{} ORDER BY p.sort_order, p.created_at, p.name COLLATE NOCASE",
            playlist_select()
        ))
        .map_err(db_error)?;
    let rows = statement
        .query_map([], playlist_from_row)
        .map_err(db_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

pub fn playlist(connection: &Connection, playlist_id: &str) -> Result<Option<Playlist>, String> {
    connection
        .query_row(
            &format!("{} WHERE p.playlist_id = ?1", playlist_select()),
            params![playlist_id],
            playlist_from_row,
        )
        .optional()
        .map_err(db_error)
}

pub fn playlist_create(connection: &Connection, name: &str, now: i64) -> Result<Playlist, String> {
    let name = clean(name, 80);
    if name.is_empty() {
        return Err("播放列表名称不能为空。".to_string());
    }
    let id = Uuid::new_v4().to_string();
    connection
        .execute(
            "INSERT INTO playlists(playlist_id, name, kind, created_at, updated_at) VALUES (?1, ?2, 'local', ?3, ?3)",
            params![id, name, now],
        )
        .map_err(db_error)?;
    playlist(connection, &id)?.ok_or_else(|| "创建播放列表失败。".to_string())
}

pub fn playlist_rename(connection: &Connection, playlist_id: &str, name: &str, now: i64) -> Result<(), String> {
    let name = clean(name, 80);
    if name.is_empty() {
        return Err("播放列表名称不能为空。".to_string());
    }
    if playlist_id == FAVORITES_ID || playlist_id == WATCH_LATER_ID {
        return Err("内置列表不能改名。".to_string());
    }
    connection
        .execute(
            "UPDATE playlists SET name = ?2, updated_at = ?3 WHERE playlist_id = ?1",
            params![playlist_id, name, now],
        )
        .map_err(db_error)?;
    Ok(())
}

pub fn playlist_delete(connection: &Connection, playlist_id: &str, now: i64) -> Result<(), String> {
    if playlist_id == FAVORITES_ID || playlist_id == WATCH_LATER_ID {
        return Err("内置列表不能删除。".to_string());
    }
    connection
        .execute("DELETE FROM playlists WHERE playlist_id = ?1", params![playlist_id])
        .map_err(db_error)?;
    prune(connection, now)
}

fn video_is_known(connection: &Connection, video_id: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM videos WHERE video_id = ?1)",
            params![video_id],
            |row| row.get(0),
        )
        .map_err(db_error)
}

/// Appends a video to a list; one that is already in it stays where it is.
pub fn playlist_add(connection: &Connection, playlist_id: &str, video_id: &str, now: i64) -> Result<(), String> {
    if !video_is_known(connection, video_id)? {
        return Err("这个视频的信息还没有保存，无法加入列表。".to_string());
    }
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM playlists WHERE playlist_id = ?1)",
            params![playlist_id],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if !exists {
        return Err("找不到这个播放列表。".to_string());
    }
    connection
        .execute(
            "INSERT OR IGNORE INTO playlist_items(playlist_id, position, video_id, added_at)
             VALUES (?1, COALESCE((SELECT MAX(position) + 1 FROM playlist_items WHERE playlist_id = ?1), 0), ?2, ?3)",
            params![playlist_id, video_id, now],
        )
        .map_err(db_error)?;
    connection
        .execute(
            "UPDATE playlists SET updated_at = ?2 WHERE playlist_id = ?1",
            params![playlist_id, now],
        )
        .map_err(db_error)?;
    Ok(())
}

pub fn playlist_remove(connection: &Connection, playlist_id: &str, video_id: &str, now: i64) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM playlist_items WHERE playlist_id = ?1 AND video_id = ?2",
            params![playlist_id, video_id],
        )
        .map_err(db_error)?;
    prune(connection, now)
}

/// Adds the video to the list, or takes it out when it is there. Returns whether it is in the list
/// afterwards.
pub fn playlist_toggle(connection: &Connection, playlist_id: &str, video_id: &str, now: i64) -> Result<bool, String> {
    let present: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM playlist_items WHERE playlist_id = ?1 AND video_id = ?2)",
            params![playlist_id, video_id],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if present {
        playlist_remove(connection, playlist_id, video_id, now)?;
        Ok(false)
    } else {
        playlist_add(connection, playlist_id, video_id, now)?;
        Ok(true)
    }
}

/// The videos of a list. The built-in lists show the newest addition first; a course and the
/// user's own lists keep their order.
pub fn playlist_items(connection: &Connection, playlist_id: &str) -> Result<Vec<VideoItem>, String> {
    let order = if playlist_id == FAVORITES_ID || playlist_id == WATCH_LATER_ID {
        "i.added_at DESC, i.position DESC"
    } else {
        "i.position ASC"
    };
    let mut statement = connection
        .prepare(&format!(
            "SELECT {} FROM playlist_items i JOIN videos v ON v.video_id = i.video_id {ITEM_JOINS}
             WHERE i.playlist_id = ?1 ORDER BY {order}",
            item_columns()
        ))
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![playlist_id], item_from_row)
        .map_err(db_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

/// Saves a YouTube playlist as a course: created the first time, afterwards its name and videos
/// are brought up to date.
pub fn course_save(
    connection: &Connection,
    remote_id: &str,
    name: &str,
    channel_name: Option<&str>,
    videos: &[VideoInput],
    now: i64,
) -> Result<Playlist, String> {
    if !is_remote_playlist_id(remote_id) {
        return Err("播放列表编号无效。".to_string());
    }
    let name = clean(name, 80);
    let name = if name.is_empty() { remote_id.to_string() } else { name };
    let transaction = connection.unchecked_transaction().map_err(db_error)?;
    let mut ids = Vec::with_capacity(videos.len());
    for video in videos {
        if upsert_video(&transaction, video, now)? && !ids.contains(&video.video_id) {
            ids.push(video.video_id.clone());
        }
    }
    let existing: Option<String> = transaction
        .query_row(
            "SELECT playlist_id FROM playlists WHERE remote_id = ?1",
            params![remote_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    let playlist_id = match existing {
        Some(id) => {
            transaction
                .execute(
                    "UPDATE playlists SET name = ?2, channel_name = ?3, updated_at = ?4 WHERE playlist_id = ?1",
                    params![id, name, channel_name.map(|value| clean(value, MAX_TEXT_CHARS)), now],
                )
                .map_err(db_error)?;
            id
        }
        None => {
            let id = Uuid::new_v4().to_string();
            transaction
                .execute(
                    "INSERT INTO playlists(playlist_id, name, kind, remote_id, channel_name, created_at, updated_at, sort_order)
                     VALUES (?1, ?2, 'course', ?3, ?4, ?5, ?5, 20)",
                    params![id, name, remote_id, channel_name.map(|value| clean(value, MAX_TEXT_CHARS)), now],
                )
                .map_err(db_error)?;
            id
        }
    };
    transaction
        .execute("DELETE FROM playlist_items WHERE playlist_id = ?1", params![playlist_id])
        .map_err(db_error)?;
    for (position, id) in ids.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO playlist_items(playlist_id, position, video_id, added_at) VALUES (?1, ?2, ?3, ?4)",
                params![playlist_id, position as i64, id, now],
            )
            .map_err(db_error)?;
    }
    transaction.commit().map_err(db_error)?;
    playlist(connection, &playlist_id)?.ok_or_else(|| "保存课程失败。".to_string())
}

// ---- learning paths -----------------------------------------------------------------------------

const MAX_LEARNING_PATH_NODES: usize = 200;

fn is_path_or_node_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' || byte == b':')
}

fn normalize_node_kind(kind: &str, has_video: bool) -> Result<&'static str, String> {
    match kind.trim() {
        "" => Ok(if has_video { "video" } else { "stage" }),
        "stage" => Ok("stage"),
        "video" => Ok("video"),
        "checkpoint" => Ok("checkpoint"),
        other => Err(format!("不支持的学习路径节点类型：{other}")),
    }
}

fn learning_path_summary_columns() -> String {
    format!(
        "p.path_id, p.title, p.description, p.created_at, p.updated_at,
         (SELECT COUNT(*) FROM learning_path_nodes n WHERE n.path_id = p.path_id),
         (SELECT COUNT(*) FROM learning_path_nodes n WHERE n.path_id = p.path_id AND n.video_id IS NOT NULL),
         (SELECT COALESCE(SUM(CASE WHEN {FINISHED_SQL} != 0 THEN 1 ELSE 0 END), 0)
          FROM learning_path_nodes n
          LEFT JOIN videos v ON v.video_id = n.video_id
          LEFT JOIN watch_state ws ON ws.video_id = n.video_id
          WHERE n.path_id = p.path_id AND n.video_id IS NOT NULL)"
    )
}

fn learning_path_summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LearningPathSummary> {
    Ok(LearningPathSummary {
        path_id: row.get(0)?,
        title: row.get(1)?,
        description: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        node_count: row.get(5)?,
        video_count: row.get(6)?,
        finished_count: row.get(7)?,
    })
}

pub fn learning_paths(connection: &Connection) -> Result<Vec<LearningPathSummary>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT {} FROM learning_paths p ORDER BY p.updated_at DESC, p.created_at DESC, p.path_id",
            learning_path_summary_columns()
        ))
        .map_err(db_error)?;
    let rows = statement
        .query_map([], learning_path_summary_from_row)
        .map_err(db_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

fn learning_path_summary(
    connection: &Connection,
    path_id: &str,
) -> Result<Option<LearningPathSummary>, String> {
    connection
        .query_row(
            &format!(
                "SELECT {} FROM learning_paths p WHERE p.path_id = ?1",
                learning_path_summary_columns()
            ),
            params![path_id],
            learning_path_summary_from_row,
        )
        .optional()
        .map_err(db_error)
}

pub fn learning_path_get(
    connection: &Connection,
    path_id: &str,
) -> Result<Option<LearningPathDetail>, String> {
    let Some(summary) = learning_path_summary(connection, path_id)? else {
        return Ok(None);
    };
    let mut statement = connection
        .prepare(
            "SELECT node_id, parent_id, position, kind, title, note, video_id,
                    start_seconds, optional, prerequisites_json
             FROM learning_path_nodes
             WHERE path_id = ?1
             ORDER BY position ASC, node_id ASC",
        )
        .map_err(db_error)?;
    let raw_nodes = statement
        .query_map(params![path_id], |row| {
            let prereq_text: String = row.get(9)?;
            let prerequisite_ids =
                serde_json::from_str::<Vec<String>>(&prereq_text).unwrap_or_default();
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)? != 0,
                prerequisite_ids,
            ))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;

    let mut video_ids = Vec::new();
    for entry in &raw_nodes {
        if let Some(ref vid) = entry.6 {
            if !video_ids.contains(vid) {
                video_ids.push(vid.clone());
            }
        }
    }
    let items = video_items(connection, &video_ids)?;
    let item_map: HashMap<String, VideoItem> = items
        .into_iter()
        .map(|item| (item.video.video_id.clone(), item))
        .collect();

    let nodes = raw_nodes
        .into_iter()
        .map(
            |(
                node_id,
                parent_id,
                position,
                kind,
                title,
                note,
                video_id,
                start_seconds,
                optional,
                prerequisite_ids,
            )| {
                let video = video_id.as_ref().and_then(|id| item_map.get(id).cloned());
                LearningPathNode {
                    node_id,
                    parent_id,
                    position,
                    kind,
                    title,
                    note,
                    video_id,
                    start_seconds,
                    optional,
                    prerequisite_ids,
                    video,
                }
            },
        )
        .collect();

    Ok(Some(LearningPathDetail { summary, nodes }))
}

struct ValidatedPathNode {
    node_id: String,
    parent_id: Option<String>,
    position: i64,
    kind: &'static str,
    title: String,
    note: Option<String>,
    video_id: Option<String>,
    start_seconds: i64,
    optional: bool,
    prerequisite_ids: Vec<String>,
}

fn validate_learning_path_nodes(
    nodes: &[LearningPathNodeInput],
) -> Result<Vec<ValidatedPathNode>, String> {
    if nodes.len() > MAX_LEARNING_PATH_NODES {
        return Err(format!(
            "单个学习路径最多包含 {MAX_LEARNING_PATH_NODES} 个节点。"
        ));
    }
    let mut seen_ids = HashSet::with_capacity(nodes.len());
    let mut normalized = Vec::with_capacity(nodes.len());

    for (index, raw) in nodes.iter().enumerate() {
        let node_id = raw.node_id.trim().to_string();
        if !is_path_or_node_id(&node_id) {
            return Err(format!(
                "第 {} 个节点的编号无效（仅限字母、数字、_、-、:，长度 1–64）。",
                index + 1
            ));
        }
        if !seen_ids.insert(node_id.clone()) {
            return Err(format!("学习路径存在重复的节点编号：{node_id}"));
        }

        let video_id = match raw.video_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(vid) => {
                if !is_video_id(vid) {
                    return Err(format!("节点「{}」的视频编号无效：{vid}", raw.title.trim()));
                }
                Some(vid.to_string())
            }
            None => None,
        };

        let kind = normalize_node_kind(&raw.kind, video_id.is_some())?;
        let title_clean = clean(&raw.title, MAX_TEXT_CHARS);
        let title = if title_clean.is_empty() {
            video_id.clone().unwrap_or_else(|| format!("节点 {}", index + 1))
        } else {
            title_clean
        };

        let parent_id = raw
            .parent_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        let mut prerequisite_ids = Vec::new();
        for req in &raw.prerequisite_ids {
            let trimmed = req.trim();
            if !trimmed.is_empty() && !prerequisite_ids.iter().any(|existing| existing == trimmed) {
                prerequisite_ids.push(trimmed.to_string());
            }
        }

        normalized.push(ValidatedPathNode {
            node_id,
            parent_id,
            position: raw.position,
            kind,
            title,
            note: clean_option(&raw.note, MAX_DESCRIPTION_CHARS),
            video_id,
            start_seconds: raw.start_seconds.max(0),
            optional: raw.optional,
            prerequisite_ids,
        });
    }

    // Verify all parent_id and prerequisite_ids exist and do not self-loop.
    let mut outgoing: HashMap<&str, Vec<&str>> = HashMap::with_capacity(normalized.len());
    for node in &normalized {
        outgoing.entry(node.node_id.as_str()).or_default();
    }
    for node in &normalized {
        if let Some(ref pid) = node.parent_id {
            if pid == &node.node_id {
                return Err(format!("节点「{}」不能将自身设为父节点。", node.title));
            }
            if !seen_ids.contains(pid) {
                return Err(format!(
                    "节点「{}」引用了不存在的父节点：{pid}",
                    node.title
                ));
            }
            outgoing
                .entry(pid.as_str())
                .or_default()
                .push(node.node_id.as_str());
        }
        for req in &node.prerequisite_ids {
            if req == &node.node_id {
                return Err(format!("节点「{}」不能将自身设为前置依赖。", node.title));
            }
            if !seen_ids.contains(req) {
                return Err(format!(
                    "节点「{}」引用了不存在的前置依赖节点：{req}",
                    node.title
                ));
            }
            outgoing
                .entry(req.as_str())
                .or_default()
                .push(node.node_id.as_str());
        }
    }

    // 3-color DFS cycle check across parent + prerequisite edges.
    let mut color: HashMap<&str, u8> = HashMap::with_capacity(normalized.len());
    fn has_cycle<'a>(
        current: &'a str,
        outgoing: &HashMap<&'a str, Vec<&'a str>>,
        color: &mut HashMap<&'a str, u8>,
    ) -> bool {
        match color.get(current).copied().unwrap_or(0) {
            1 => return true,
            2 => return false,
            _ => {}
        }
        color.insert(current, 1);
        if let Some(neighbors) = outgoing.get(current) {
            for &next in neighbors {
                if has_cycle(next, outgoing, color) {
                    return true;
                }
            }
        }
        color.insert(current, 2);
        false
    }

    for node in &normalized {
        if color.get(node.node_id.as_str()).copied().unwrap_or(0) == 0
            && has_cycle(node.node_id.as_str(), &outgoing, &mut color)
        {
            return Err("学习路径节点之间存在循环依赖（父子或前置关系成环）。".to_string());
        }
    }

    Ok(normalized)
}

pub fn learning_path_save(
    connection: &Connection,
    input: &LearningPathInput,
    now: i64,
) -> Result<LearningPathDetail, String> {
    let title = clean(&input.title, 120);
    if title.is_empty() {
        return Err("请填写学习路径标题。".to_string());
    }
    let description = clean_option(&input.description, MAX_DESCRIPTION_CHARS);
    let nodes = validate_learning_path_nodes(&input.nodes)?;

    let requested_id = input
        .path_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    if let Some(id) = requested_id {
        if !is_path_or_node_id(id) {
            return Err("学习路径编号格式无效。".to_string());
        }
    }

    let transaction = connection.unchecked_transaction().map_err(db_error)?;

    for video in &input.videos {
        upsert_video(&transaction, video, now)?;
    }
    for node in &nodes {
        if let Some(ref vid) = node.video_id {
            if !video_is_known(&transaction, vid)? {
                upsert_video(
                    &transaction,
                    &VideoInput {
                        video_id: vid.clone(),
                        title: node.title.clone(),
                        ..VideoInput::default()
                    },
                    now,
                )?;
            }
        }
    }

    let path_id = match requested_id {
        Some(id) => {
            let exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM learning_paths WHERE path_id = ?1)",
                    params![id],
                    |row| row.get(0),
                )
                .map_err(db_error)?;
            if exists {
                transaction
                    .execute(
                        "UPDATE learning_paths SET title = ?2, description = ?3, updated_at = ?4 WHERE path_id = ?1",
                        params![id, title, description, now],
                    )
                    .map_err(db_error)?;
            } else {
                transaction
                    .execute(
                        "INSERT INTO learning_paths(path_id, title, description, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?4)",
                        params![id, title, description, now],
                    )
                    .map_err(db_error)?;
            }
            id.to_string()
        }
        None => {
            let id = Uuid::new_v4().to_string();
            transaction
                .execute(
                    "INSERT INTO learning_paths(path_id, title, description, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?4)",
                    params![id, title, description, now],
                )
                .map_err(db_error)?;
            id
        }
    };

    transaction
        .execute(
            "DELETE FROM learning_path_nodes WHERE path_id = ?1",
            params![path_id],
        )
        .map_err(db_error)?;

    for node in &nodes {
        let prereq_json =
            serde_json::to_string(&node.prerequisite_ids).map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO learning_path_nodes(
                     path_id, node_id, parent_id, position, kind, title, note,
                     video_id, start_seconds, optional, prerequisites_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    path_id,
                    node.node_id,
                    node.parent_id,
                    node.position,
                    node.kind,
                    node.title,
                    node.note,
                    node.video_id,
                    node.start_seconds,
                    i64::from(node.optional),
                    prereq_json,
                ],
            )
            .map_err(db_error)?;
    }

    transaction.commit().map_err(db_error)?;
    prune(connection, now)?;
    learning_path_get(connection, &path_id)?.ok_or_else(|| "保存学习路径失败。".to_string())
}

pub fn learning_path_delete(connection: &Connection, path_id: &str, now: i64) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM learning_paths WHERE path_id = ?1",
            params![path_id],
        )
        .map_err(db_error)?;
    prune(connection, now)
}

// ---- settings and overview ----------------------------------------------------------------------

pub fn settings(connection: &Connection) -> Result<PlayerSettings, String> {
    let stored: Option<String> = connection
        .query_row("SELECT value FROM settings WHERE key = 'player'", [], |row| row.get(0))
        .optional()
        .map_err(db_error)?;
    Ok(stored
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default())
}

pub fn save_settings(connection: &Connection, settings: &PlayerSettings) -> Result<PlayerSettings, String> {
    let mut settings = settings.clone();
    // A day is the longest a feed is allowed to go without being checked.
    settings.feed_update_threshold_seconds = settings.feed_update_threshold_seconds.clamp(0, 7 * 24 * 3600);
    let text = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO settings(key, value) VALUES ('player', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![text],
        )
        .map_err(db_error)?;
    Ok(settings)
}

pub fn overview(connection: &Connection) -> Result<Overview, String> {
    Ok(Overview {
        channels: channels(connection)?,
        playlists: playlists(connection)?,
        learning_paths: learning_paths(connection)?,
        settings: settings(connection)?,
    })
}

// ---- backup -------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupChannel {
    pub channel_id: String,
    pub name: String,
    pub handle: Option<String>,
    pub avatar_url: Option<String>,
    pub description: Option<String>,
    pub subscribed_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupPlaylist {
    pub playlist_id: String,
    pub name: String,
    pub kind: String,
    pub remote_id: Option<String>,
    pub channel_name: Option<String>,
    pub video_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupState {
    pub video_id: String,
    pub progress_seconds: f64,
    pub duration_seconds: Option<f64>,
    pub finished_override: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupHistory {
    pub video_id: String,
    pub first_played_at: i64,
    pub last_played_at: i64,
    pub play_count: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupLearningPath {
    pub path_id: String,
    pub title: String,
    pub description: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub nodes: Vec<LearningPathNodeInput>,
}

/// Everything the user made, as one document that can be kept or moved to another machine. The
/// cached feed is not part of it: the next refresh brings it back.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Backup {
    pub format: String,
    pub version: u32,
    pub exported_at: i64,
    pub channels: Vec<BackupChannel>,
    pub playlists: Vec<BackupPlaylist>,
    pub learning_paths: Vec<BackupLearningPath>,
    pub videos: Vec<VideoInput>,
    pub states: Vec<BackupState>,
    pub history: Vec<BackupHistory>,
    pub settings: Option<PlayerSettings>,
}

pub const BACKUP_FORMAT: &str = "seamind-player-backup";

pub fn export_backup(connection: &Connection, now: i64) -> Result<Backup, String> {
    let channels = channels(connection)?
        .into_iter()
        .map(|channel| BackupChannel {
            channel_id: channel.channel_id,
            name: channel.name,
            handle: channel.handle,
            avatar_url: channel.avatar_url,
            description: channel.description,
            subscribed_at: channel.subscribed_at,
        })
        .collect();

    let mut playlists_out = Vec::new();
    for list in playlists(connection)? {
        let mut statement = connection
            .prepare("SELECT video_id FROM playlist_items WHERE playlist_id = ?1 ORDER BY position")
            .map_err(db_error)?;
        let video_ids = statement
            .query_map(params![list.playlist_id], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        playlists_out.push(BackupPlaylist {
            playlist_id: list.playlist_id,
            name: list.name,
            kind: list.kind,
            remote_id: list.remote_id,
            channel_name: list.channel_name,
            video_ids,
        });
    }

    let mut learning_paths_out = Vec::new();
    for path in learning_paths(connection)? {
        if let Some(detail) = learning_path_get(connection, &path.path_id)? {
            let nodes = detail
                .nodes
                .into_iter()
                .map(|node| LearningPathNodeInput {
                    node_id: node.node_id,
                    parent_id: node.parent_id,
                    position: node.position,
                    kind: node.kind,
                    title: node.title,
                    note: node.note,
                    video_id: node.video_id,
                    start_seconds: node.start_seconds,
                    optional: node.optional,
                    prerequisite_ids: node.prerequisite_ids,
                })
                .collect();
            learning_paths_out.push(BackupLearningPath {
                path_id: detail.summary.path_id,
                title: detail.summary.title,
                description: detail.summary.description,
                created_at: detail.summary.created_at,
                updated_at: detail.summary.updated_at,
                nodes,
            });
        }
    }

    // The videos the lists, the learning paths, the history and the watch states refer to, so they keep their titles.
    let mut statement = connection
        .prepare(
            "SELECT video_id, channel_id, channel_name, title, published_at, published_approx,
                    duration_seconds, view_count, view_text, thumbnail_url
             FROM videos
             WHERE video_id IN (SELECT video_id FROM playlist_items)
                OR video_id IN (SELECT video_id FROM learning_path_nodes WHERE video_id IS NOT NULL)
                OR video_id IN (SELECT video_id FROM history)
                OR video_id IN (SELECT video_id FROM watch_state)
             ORDER BY video_id",
        )
        .map_err(db_error)?;
    let videos = statement
        .query_map([], |row| {
            Ok(VideoInput {
                video_id: row.get(0)?,
                channel_id: row.get(1)?,
                channel_name: row.get(2)?,
                title: row.get(3)?,
                published_at: row.get(4)?,
                published_approx: row.get::<_, i64>(5)? != 0,
                duration_seconds: row.get(6)?,
                view_count: row.get(7)?,
                view_text: row.get(8)?,
                thumbnail_url: row.get(9)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;

    let mut statement = connection
        .prepare("SELECT video_id, progress_seconds, duration_seconds, finished_override, updated_at FROM watch_state ORDER BY video_id")
        .map_err(db_error)?;
    let states = statement
        .query_map([], |row| {
            Ok(BackupState {
                video_id: row.get(0)?,
                progress_seconds: row.get(1)?,
                duration_seconds: row.get(2)?,
                finished_override: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;

    let mut statement = connection
        .prepare("SELECT video_id, first_played_at, last_played_at, play_count FROM history ORDER BY last_played_at DESC")
        .map_err(db_error)?;
    let history = statement
        .query_map([], |row| {
            Ok(BackupHistory {
                video_id: row.get(0)?,
                first_played_at: row.get(1)?,
                last_played_at: row.get(2)?,
                play_count: row.get(3)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;

    Ok(Backup {
        format: BACKUP_FORMAT.to_string(),
        version: 1,
        exported_at: now,
        channels,
        playlists: playlists_out,
        learning_paths: learning_paths_out,
        videos,
        states,
        history,
        settings: Some(settings(connection)?),
    })
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub channels_added: usize,
    pub playlists_added: usize,
    pub learning_paths_added: usize,
    pub videos: usize,
}

/// Merges a backup into the database: channels and lists that are missing are added, items are
/// added to lists that exist, and for watch state and history the newer record wins.
pub fn import_backup(connection: &Connection, backup: &Backup, now: i64) -> Result<BackupSummary, String> {
    if backup.format != BACKUP_FORMAT {
        return Err("这不是 Seamind 播放器的备份文件。".to_string());
    }
    if backup.version != 1 {
        return Err("备份文件的版本太新，请先升级 Seamind。".to_string());
    }
    let transaction = connection.unchecked_transaction().map_err(db_error)?;
    let mut summary = BackupSummary::default();

    for channel in &backup.channels {
        if !is_channel_id(&channel.channel_id) {
            continue;
        }
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM channels WHERE channel_id = ?1)",
                params![channel.channel_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if !exists {
            transaction
                .execute(
                    "INSERT INTO channels(channel_id, name, handle, avatar_url, description, subscribed_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        channel.channel_id,
                        clean(&channel.name, MAX_TEXT_CHARS),
                        clean_option(&channel.handle, 100),
                        clean_option(&channel.avatar_url, 1_000),
                        clean_option(&channel.description, MAX_DESCRIPTION_CHARS),
                        if channel.subscribed_at > 0 { channel.subscribed_at } else { now },
                    ],
                )
                .map_err(db_error)?;
            summary.channels_added += 1;
        }
    }

    for video in &backup.videos {
        if upsert_video(&transaction, video, now)? {
            summary.videos += 1;
        }
    }

    for list in &backup.playlists {
        let builtin = list.playlist_id == FAVORITES_ID || list.playlist_id == WATCH_LATER_ID;
        let target = if builtin {
            Some(list.playlist_id.clone())
        } else if list.kind == "course" {
            match list.remote_id.as_deref().filter(|id| is_remote_playlist_id(id)) {
                Some(remote) => transaction
                    .query_row(
                        "SELECT playlist_id FROM playlists WHERE remote_id = ?1",
                        params![remote],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(db_error)?,
                None => continue,
            }
        } else {
            transaction
                .query_row(
                    "SELECT playlist_id FROM playlists WHERE playlist_id = ?1",
                    params![list.playlist_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(db_error)?
        };
        let target = match target {
            Some(id) => id,
            None => {
                let id = if Uuid::parse_str(&list.playlist_id).is_ok() {
                    list.playlist_id.clone()
                } else {
                    Uuid::new_v4().to_string()
                };
                let kind = if list.kind == "course" { "course" } else { "local" };
                transaction
                    .execute(
                        "INSERT INTO playlists(playlist_id, name, kind, remote_id, channel_name, created_at, updated_at, sort_order)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)",
                        params![
                            id,
                            clean(&list.name, 80),
                            kind,
                            list.remote_id.as_deref().filter(|remote| is_remote_playlist_id(remote)),
                            clean_option(&list.channel_name, MAX_TEXT_CHARS),
                            now,
                            if kind == "course" { 20 } else { 10 },
                        ],
                    )
                    .map_err(db_error)?;
                summary.playlists_added += 1;
                id
            }
        };
        for video_id in &list.video_ids {
            if video_is_known(&transaction, video_id)? {
                playlist_add(&transaction, &target, video_id, now)?;
            }
        }
    }

    for path in &backup.learning_paths {
        let title = clean(&path.title, 120);
        if title.is_empty() {
            continue;
        }
        let Ok(nodes) = validate_learning_path_nodes(&path.nodes) else {
            continue;
        };
        let candidate_id = if is_path_or_node_id(path.path_id.trim()) {
            path.path_id.trim().to_string()
        } else {
            Uuid::new_v4().to_string()
        };
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM learning_paths WHERE path_id = ?1)",
                params![candidate_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if exists {
            continue;
        }
        for node in &nodes {
            if let Some(ref vid) = node.video_id {
                if !video_is_known(&transaction, vid)? {
                    upsert_video(
                        &transaction,
                        &VideoInput {
                            video_id: vid.clone(),
                            title: node.title.clone(),
                            ..VideoInput::default()
                        },
                        now,
                    )?;
                }
            }
        }
        let created_at = if path.created_at > 0 { path.created_at } else { now };
        let updated_at = if path.updated_at > 0 { path.updated_at } else { created_at };
        transaction
            .execute(
                "INSERT INTO learning_paths(path_id, title, description, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    candidate_id,
                    title,
                    clean_option(&path.description, MAX_DESCRIPTION_CHARS),
                    created_at,
                    updated_at,
                ],
            )
            .map_err(db_error)?;
        for node in &nodes {
            let prereq_json =
                serde_json::to_string(&node.prerequisite_ids).map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "INSERT INTO learning_path_nodes(
                         path_id, node_id, parent_id, position, kind, title, note,
                         video_id, start_seconds, optional, prerequisites_json
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![
                        candidate_id,
                        node.node_id,
                        node.parent_id,
                        node.position,
                        node.kind,
                        node.title,
                        node.note,
                        node.video_id,
                        node.start_seconds,
                        i64::from(node.optional),
                        prereq_json,
                    ],
                )
                .map_err(db_error)?;
        }
        summary.learning_paths_added += 1;
    }

    for state in &backup.states {
        if !is_video_id(&state.video_id) {
            continue;
        }
        transaction
            .execute(
                "INSERT INTO watch_state(video_id, progress_seconds, duration_seconds, finished_override, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(video_id) DO UPDATE SET
                     progress_seconds = excluded.progress_seconds,
                     duration_seconds = COALESCE(excluded.duration_seconds, duration_seconds),
                     finished_override = excluded.finished_override,
                     updated_at = excluded.updated_at
                 WHERE excluded.updated_at > watch_state.updated_at",
                params![
                    state.video_id,
                    state.progress_seconds.max(0.0),
                    state.duration_seconds,
                    state.finished_override,
                    state.updated_at,
                ],
            )
            .map_err(db_error)?;
    }

    for entry in &backup.history {
        if !is_video_id(&entry.video_id) {
            continue;
        }
        transaction
            .execute(
                "INSERT INTO history(video_id, first_played_at, last_played_at, play_count)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(video_id) DO UPDATE SET
                     first_played_at = MIN(first_played_at, excluded.first_played_at),
                     last_played_at = MAX(last_played_at, excluded.last_played_at),
                     play_count = MAX(play_count, excluded.play_count)",
                params![entry.video_id, entry.first_played_at, entry.last_played_at, entry.play_count.max(1)],
            )
            .map_err(db_error)?;
    }

    transaction.commit().map_err(db_error)?;
    Ok(summary)
}

// ---- the YouTube feed (Atom) --------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct FeedEntry {
    pub video_id: String,
    pub title: String,
    pub published_at: Option<i64>,
    pub view_count: Option<i64>,
    pub thumbnail_url: Option<String>,
    pub is_short: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedFeed {
    pub title: Option<String>,
    /// The channel the feed belongs to, from its own author entry.
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
    pub entries: Vec<FeedEntry>,
}

fn child_text<'a>(node: roxmltree::Node<'a, 'a>, name: &str) -> Option<&'a str> {
    node.children()
        .find(|child| child.is_element() && child.tag_name().name() == name)
        .and_then(|child| child.text())
}

fn find_descendant<'a>(node: roxmltree::Node<'a, 'a>, name: &str) -> Option<roxmltree::Node<'a, 'a>> {
    node.descendants()
        .find(|child| child.is_element() && child.tag_name().name() == name)
}

/// Reads the Atom feed YouTube serves for a channel or a playlist.
pub fn parse_feed(xml: &str) -> Result<ParsedFeed, String> {
    let document = roxmltree::Document::parse(xml).map_err(|_| "YouTube 返回的不是有效的订阅源。".to_string())?;
    let root = document.root_element();
    if root.tag_name().name() != "feed" {
        return Err("YouTube 返回的不是有效的订阅源。".to_string());
    }
    let channel_name = root
        .children()
        .find(|child| child.is_element() && child.tag_name().name() == "author")
        .and_then(|author| child_text(author, "name"))
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty());
    let mut channel_id = child_text(root, "channelId")
        .map(str::trim)
        .filter(|id| is_channel_id(id))
        .map(str::to_string);

    let mut entries = Vec::new();
    for entry in root
        .children()
        .filter(|child| child.is_element() && child.tag_name().name() == "entry")
    {
        let Some(video_id) = child_text(entry, "videoId")
            .map(str::trim)
            .filter(|id| is_video_id(id))
        else {
            continue;
        };
        if channel_id.is_none() {
            channel_id = child_text(entry, "channelId")
                .map(str::trim)
                .filter(|id| is_channel_id(id))
                .map(str::to_string);
        }
        let title = child_text(entry, "title").unwrap_or("").trim().to_string();
        let published_at = child_text(entry, "published").and_then(parse_rfc3339);
        let link = entry
            .children()
            .filter(|child| child.is_element() && child.tag_name().name() == "link")
            .find(|child| child.attribute("rel").map_or(true, |rel| rel == "alternate"))
            .and_then(|child| child.attribute("href"))
            .unwrap_or("");
        let group = find_descendant(entry, "group");
        let view_count = group
            .and_then(|group| find_descendant(group, "statistics"))
            .and_then(|statistics| statistics.attribute("views"))
            .and_then(|views| views.trim().parse::<i64>().ok());
        let thumbnail_url = group
            .and_then(|group| find_descendant(group, "thumbnail"))
            .and_then(|thumbnail| thumbnail.attribute("url"))
            .map(str::to_string);
        entries.push(FeedEntry {
            video_id: video_id.to_string(),
            title,
            published_at,
            view_count,
            thumbnail_url,
            is_short: link.contains("/shorts/"),
        });
    }
    Ok(ParsedFeed {
        title: child_text(root, "title").map(|title| title.trim().to_string()),
        channel_id,
        channel_name,
        entries,
    })
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// `2026-10-16T16:15:20+00:00` (also with `Z`, an offset, or fractional seconds) as unix seconds.
pub fn parse_rfc3339(value: &str) -> Option<i64> {
    let value = value.trim();
    let (date, rest) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let split = rest.find(|c| c == 'Z' || c == '+' || c == '-').unwrap_or(rest.len());
    let (clock, zone) = rest.split_at(split);
    let mut clock_parts = clock.split(':');
    let hour: i64 = clock_parts.next()?.parse().ok()?;
    let minute: i64 = clock_parts.next()?.parse().ok()?;
    let second: i64 = clock_parts
        .next()
        .map_or(Some(0), |text| text.split('.').next()?.parse().ok())?;
    let offset = match zone {
        "" | "Z" => 0,
        _ => {
            let sign = if zone.starts_with('-') { -1 } else { 1 };
            let mut offset_parts = zone[1..].split(':');
            let offset_hours: i64 = offset_parts.next()?.parse().ok()?;
            let offset_minutes: i64 = offset_parts.next().map_or(Some(0), |text| text.parse().ok())?;
            sign * (offset_hours * 3600 + offset_minutes * 60)
        }
    };
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset)
}

/// The channel's videos from a parsed feed, as the rows the cache keeps. Shorts are left out.
pub fn feed_videos(feed: &ParsedFeed, channel_id: &str, channel_name: Option<&str>) -> Vec<VideoInput> {
    feed.entries
        .iter()
        .filter(|entry| !entry.is_short)
        .map(|entry| VideoInput {
            video_id: entry.video_id.clone(),
            channel_id: Some(channel_id.to_string()),
            channel_name: channel_name
                .map(str::to_string)
                .or_else(|| feed.channel_name.clone()),
            title: entry.title.clone(),
            published_at: entry.published_at,
            published_approx: false,
            duration_seconds: None,
            view_count: entry.view_count,
            view_text: None,
            thumbnail_url: entry.thumbnail_url.clone(),
        })
        .collect()
}

/// The ids of the videos in `videos` that the cache did not have before.
pub fn new_video_ids(connection: &Connection, videos: &[VideoInput]) -> Result<Vec<String>, String> {
    let mut known = HashSet::new();
    let mut statement = connection
        .prepare("SELECT 1 FROM videos WHERE video_id = ?1")
        .map_err(db_error)?;
    for video in videos {
        let exists = statement.exists(params![video.video_id]).map_err(db_error)?;
        if exists {
            known.insert(video.video_id.clone());
        }
    }
    Ok(videos
        .iter()
        .filter(|video| !known.contains(&video.video_id))
        .map(|video| video.video_id.clone())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;
    const DAY: i64 = 86_400;
    const CHANNEL_A: &str = "UCYO_jab_esuFRV4b17AJtAw";
    const CHANNEL_B: &str = "UCcabW7890RKJzL968QWEykA";

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        prepare(&connection).unwrap();
        connection
    }

    fn channel_input(id: &str, name: &str) -> ChannelInput {
        ChannelInput {
            channel_id: id.to_string(),
            name: name.to_string(),
            ..ChannelInput::default()
        }
    }

    fn video(id: &str, channel: &str, title: &str, published: i64) -> VideoInput {
        VideoInput {
            video_id: id.to_string(),
            channel_id: Some(channel.to_string()),
            channel_name: Some("频道".to_string()),
            title: title.to_string(),
            published_at: Some(published),
            ..VideoInput::default()
        }
    }

    const V1: &str = "aaaaaaaaaaa";
    const V2: &str = "bbbbbbbbbbb";
    const V3: &str = "ccccccccccc";
    const V4: &str = "ddddddddddd";

    #[test]
    fn preparing_twice_keeps_the_two_built_in_lists() {
        let connection = database();
        prepare(&connection).unwrap();
        let lists = playlists(&connection).unwrap();
        let names: Vec<_> = lists.iter().map(|list| (list.playlist_id.as_str(), list.name.as_str(), list.builtin)).collect();
        assert_eq!(names, vec![(FAVORITES_ID, "收藏", true), (WATCH_LATER_ID, "稍后看", true)]);
    }

    #[test]
    fn ids_are_checked_for_their_shape() {
        assert!(is_video_id("dQw4w9WgXcQ"));
        assert!(!is_video_id("dQw4w9WgXc"));
        assert!(!is_video_id("dQw4w9WgXc!"));
        assert!(is_channel_id(CHANNEL_A));
        assert!(!is_channel_id("UC123"));
        assert!(!is_channel_id("XXYO_jab_esuFRV4b17AJtAw"));
        assert_eq!(
            long_form_playlist_id(CHANNEL_A).as_deref(),
            Some("UULFYO_jab_esuFRV4b17AJtAw")
        );
        assert_eq!(long_form_playlist_id("nope"), None);
    }

    #[test]
    fn subscribing_keeps_the_first_date_and_refreshes_the_rest() {
        let connection = database();
        let first = subscribe(&connection, &channel_input(CHANNEL_A, "3B1B"), NOW).unwrap();
        assert_eq!(first.name, "3B1B");
        assert_eq!(first.subscribed_at, NOW);

        let again = subscribe(
            &connection,
            &ChannelInput {
                channel_id: CHANNEL_A.to_string(),
                name: "3Blue1Brown".to_string(),
                handle: Some("@3blue1brown".to_string()),
                avatar_url: Some("https://yt3.example/a.jpg".to_string()),
                description: None,
            },
            NOW + 100,
        )
        .unwrap();
        assert_eq!(again.subscribed_at, NOW);
        assert_eq!(again.name, "3Blue1Brown");
        assert_eq!(again.handle.as_deref(), Some("@3blue1brown"));
        assert_eq!(channels(&connection).unwrap().len(), 1);

        // A later call that knows nothing about the avatar does not erase it.
        let bare = subscribe(&connection, &channel_input(CHANNEL_A, ""), NOW + 200).unwrap();
        assert_eq!(bare.name, "3Blue1Brown");
        assert_eq!(bare.avatar_url.as_deref(), Some("https://yt3.example/a.jpg"));
    }

    #[test]
    fn a_bad_channel_id_is_refused_and_a_missing_name_falls_back_to_the_id() {
        let connection = database();
        assert!(subscribe(&connection, &channel_input("UC-short", "x"), NOW).is_err());
        let nameless = subscribe(&connection, &channel_input(CHANNEL_B, "  "), NOW).unwrap();
        assert_eq!(nameless.name, CHANNEL_B);
    }

    #[test]
    fn importing_counts_new_known_and_invalid_channels() {
        let connection = database();
        subscribe(&connection, &channel_input(CHANNEL_A, "已有"), NOW).unwrap();
        let summary = import_channels(
            &connection,
            &[
                channel_input(CHANNEL_A, "改名不该生效"),
                channel_input(CHANNEL_B, "CS50"),
                channel_input("bad", "x"),
            ],
            NOW,
        )
        .unwrap();
        assert_eq!(summary, ImportSummary { added: 1, existing: 1, invalid: 1 });
        let names: Vec<_> = channels(&connection).unwrap().into_iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["CS50".to_string(), "已有".to_string()]);
    }

    #[test]
    fn a_failed_check_is_remembered_and_cleared_by_the_next_good_one() {
        let connection = database();
        subscribe(&connection, &channel_input(CHANNEL_A, "A"), NOW).unwrap();
        mark_channel_checked(&connection, CHANNEL_A, NOW + 10).unwrap();
        mark_channel_error(&connection, CHANNEL_A, "网络超时").unwrap();
        let failed = channel(&connection, CHANNEL_A).unwrap().unwrap();
        assert_eq!(failed.last_checked_at, Some(NOW + 10));
        assert_eq!(failed.last_error.as_deref(), Some("网络超时"));
        mark_channel_checked(&connection, CHANNEL_A, NOW + 20).unwrap();
        let fine = channel(&connection, CHANNEL_A).unwrap().unwrap();
        assert_eq!((fine.last_checked_at, fine.last_error), (Some(NOW + 20), None));
    }

    #[test]
    fn storing_videos_keeps_what_is_known_when_a_listing_knows_less() {
        let connection = database();
        let mut exact = video(V1, CHANNEL_A, "RSS 标题", NOW - DAY);
        exact.view_count = Some(1234);
        store_videos(&connection, &[exact], NOW).unwrap();

        // A channel page knows the duration but only an approximate date.
        let mut page = video(V1, CHANNEL_A, "", NOW - 2 * DAY);
        page.published_approx = true;
        page.duration_seconds = Some(600);
        page.view_count = None;
        page.view_text = Some("1.2K 次观看".to_string());
        let items = store_videos(&connection, &[page], NOW + 1).unwrap();

        let stored = &items[0].video;
        assert_eq!(stored.title, "RSS 标题");
        assert_eq!(stored.published_at, Some(NOW - DAY));
        assert!(!stored.published_approx);
        assert_eq!(stored.duration_seconds, Some(600));
        assert_eq!(stored.view_count, Some(1234));
        assert_eq!(stored.view_text.as_deref(), Some("1.2K 次观看"));

        // An exact date does replace an approximate one.
        let mut approx_first = video(V2, CHANNEL_A, "二", NOW - 3 * DAY);
        approx_first.published_approx = true;
        store_videos(&connection, &[approx_first], NOW).unwrap();
        let exact_later = video(V2, CHANNEL_A, "二", NOW - 3 * DAY + 3600);
        let items = store_videos(&connection, &[exact_later], NOW).unwrap();
        assert_eq!(items[0].video.published_at, Some(NOW - 3 * DAY + 3600));
        assert!(!items[0].video.published_approx);
    }

    #[test]
    fn invalid_ids_are_skipped_and_the_order_of_the_input_is_kept() {
        let connection = database();
        let items = store_videos(
            &connection,
            &[
                video(V2, CHANNEL_A, "二", NOW),
                video("bad", CHANNEL_A, "坏", NOW),
                video(V1, CHANNEL_A, "一", NOW),
            ],
            NOW,
        )
        .unwrap();
        let ids: Vec<_> = items.iter().map(|item| item.video.video_id.as_str()).collect();
        assert_eq!(ids, vec![V2, V1]);
    }

    fn follow_with_videos(connection: &Connection) {
        subscribe(connection, &channel_input(CHANNEL_A, "A"), NOW).unwrap();
        subscribe(connection, &channel_input(CHANNEL_B, "B"), NOW).unwrap();
        store_videos(
            connection,
            &[
                video(V1, CHANNEL_A, "一", NOW - 3 * DAY),
                video(V2, CHANNEL_A, "二", NOW - 1 * DAY),
                video(V3, CHANNEL_B, "三", NOW - 2 * DAY),
            ],
            NOW,
        )
        .unwrap();
    }

    #[test]
    fn the_feed_is_the_followed_channels_newest_first() {
        let connection = database();
        follow_with_videos(&connection);
        // A video of a channel that is not followed stays out of the feed.
        store_videos(&connection, &[video(V4, "UCzzzzzzzzzzzzzzzzzzzzzz", "陌生", NOW)], NOW).unwrap();

        let all = feed(&connection, &FeedQuery::default()).unwrap();
        let ids: Vec<_> = all.iter().map(|item| item.video.video_id.as_str()).collect();
        assert_eq!(ids, vec![V2, V3, V1]);

        let only_b = feed(
            &connection,
            &FeedQuery { channel_id: Some(CHANNEL_B.to_string()), ..FeedQuery::default() },
        )
        .unwrap();
        assert_eq!(only_b.len(), 1);

        let paged = feed(&connection, &FeedQuery { limit: 1, offset: 1, ..FeedQuery::default() }).unwrap();
        assert_eq!(paged[0].video.video_id, V3);
    }

    #[test]
    fn a_video_without_a_date_is_not_a_new_upload() {
        let connection = database();
        follow_with_videos(&connection);
        // What a playlist saved as a course stores: the channel is known, the date is not.
        let undated = VideoInput { published_at: None, ..video(V4, CHANNEL_A, "课程里的旧视频", NOW) };
        store_videos(&connection, &[undated], NOW).unwrap();

        let ids: Vec<_> = feed(&connection, &FeedQuery::default())
            .unwrap()
            .into_iter()
            .map(|item| item.video.video_id)
            .collect();
        assert_eq!(ids, vec![V2, V3, V1]);
        assert!(video_items(&connection, &[V4.to_string()]).unwrap().len() == 1, "it is still known to the database");

        // Once a listing that does give the date has seen it, it belongs in the feed in its place.
        store_videos(&connection, &[video(V4, CHANNEL_A, "", NOW - 5 * DAY)], NOW).unwrap();
        let ids: Vec<_> = feed(&connection, &FeedQuery::default())
            .unwrap()
            .into_iter()
            .map(|item| item.video.video_id)
            .collect();
        assert_eq!(ids, vec![V2, V3, V1, V4]);
    }

    #[test]
    fn progress_is_remembered_by_newpipes_rules() {
        let connection = database();
        follow_with_videos(&connection);
        store_videos(&connection, &[VideoInput { duration_seconds: Some(1000), ..video(V1, CHANNEL_A, "一", NOW) }], NOW).unwrap();

        // Under five seconds nothing is saved.
        assert_eq!(save_progress(&connection, V1, 3.0, Some(1000.0), NOW).unwrap(), None);
        // Past five seconds it is.
        let saved = save_progress(&connection, V1, 42.0, Some(1000.0), NOW).unwrap().unwrap();
        assert_eq!(saved.progress_seconds, 42.0);
        assert_eq!(saved.resume_seconds, 42.0);
        assert!(!saved.finished);
        // A new visit that ends sooner leaves the earlier position alone.
        let kept = save_progress(&connection, V1, 2.0, Some(1000.0), NOW + 5).unwrap().unwrap();
        assert_eq!(kept.progress_seconds, 42.0);
        // Within the last minute and past three quarters: watched, and the next start is the beginning.
        let done = save_progress(&connection, V1, 960.0, Some(1000.0), NOW + 10).unwrap().unwrap();
        assert!(done.finished);
        assert_eq!(done.resume_seconds, 0.0);
        // Inside the last minute counts only past three quarters; early in a long video it does not.
        let near_the_end = save_progress(&connection, V2, 100.0, Some(120.0), NOW).unwrap().unwrap();
        assert!(near_the_end.finished, "100 of 120 s is inside the last minute and past 3/4");
        let quarter_left_but_long = save_progress(&connection, V3, 100.0, Some(400.0), NOW).unwrap().unwrap();
        assert!(!quarter_left_but_long.finished);
    }

    #[test]
    fn a_short_video_is_saved_after_a_quarter_even_before_five_seconds() {
        let connection = database();
        let state = save_progress(&connection, V1, 4.0, Some(10.0), NOW).unwrap().unwrap();
        assert_eq!(state.progress_seconds, 4.0);
        assert_eq!(save_progress(&connection, V2, 4.0, Some(100.0), NOW).unwrap(), None);
    }

    #[test]
    fn progress_beyond_the_end_is_cut_and_nonsense_is_ignored() {
        let connection = database();
        let state = save_progress(&connection, V1, 5000.0, Some(100.0), NOW).unwrap().unwrap();
        assert_eq!(state.progress_seconds, 100.0);
        assert!(save_progress(&connection, V2, f64::NAN, None, NOW).unwrap().is_none());
        assert!(save_progress(&connection, V2, -4.0, None, NOW).unwrap().is_none());
        assert!(save_progress(&connection, "bad", 10.0, None, NOW).is_err());
    }

    #[test]
    fn watched_can_be_set_by_hand_and_playing_again_clears_it() {
        let connection = database();
        follow_with_videos(&connection);
        set_watched(&connection, V1, true, NOW).unwrap();
        let item = &video_items(&connection, &[V1.to_string()]).unwrap()[0];
        assert!(item.finished);
        assert_eq!(watch_state(&connection, V1).unwrap().unwrap().resume_seconds, 0.0);

        // Playing it again and getting past five seconds replaces the manual mark.
        let state = save_progress(&connection, V1, 30.0, Some(600.0), NOW + 1).unwrap().unwrap();
        assert!(!state.finished);
        assert_eq!(state.resume_seconds, 30.0);

        set_watched(&connection, V1, false, NOW + 2).unwrap();
        assert_eq!(watch_state(&connection, V1).unwrap(), None);
        assert!(!video_items(&connection, &[V1.to_string()]).unwrap()[0].finished);
    }

    #[test]
    fn the_feed_can_hide_what_was_watched() {
        let connection = database();
        follow_with_videos(&connection);
        set_watched(&connection, V2, true, NOW).unwrap();
        let shown = feed(&connection, &FeedQuery { hide_finished: true, ..FeedQuery::default() }).unwrap();
        let ids: Vec<_> = shown.iter().map(|item| item.video.video_id.as_str()).collect();
        assert_eq!(ids, vec![V3, V1]);
        let everything = feed(&connection, &FeedQuery::default()).unwrap();
        assert_eq!(everything.len(), 3);
        assert!(everything.iter().find(|item| item.video.video_id == V2).unwrap().finished);
    }

    #[test]
    fn history_lists_the_latest_first_and_counts_plays() {
        let connection = database();
        follow_with_videos(&connection);
        mark_played(&connection, V1, NOW).unwrap();
        mark_played(&connection, V2, NOW + 10).unwrap();
        mark_played(&connection, V1, NOW + 20).unwrap();
        let items = history(&connection, 0, 0).unwrap();
        let ids: Vec<_> = items.iter().map(|item| item.video.video_id.as_str()).collect();
        assert_eq!(ids, vec![V1, V2]);
        assert_eq!(items[0].last_played_at, Some(NOW + 20));
        let count: i64 = connection
            .query_row("SELECT play_count FROM history WHERE video_id = ?1", params![V1], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);

        remove_from_history(&connection, V2).unwrap();
        assert_eq!(history(&connection, 0, 0).unwrap().len(), 1);
        clear_history(&connection).unwrap();
        assert!(history(&connection, 0, 0).unwrap().is_empty());
    }

    #[test]
    fn the_built_in_lists_show_the_newest_addition_first_and_flag_their_videos() {
        let connection = database();
        follow_with_videos(&connection);
        playlist_add(&connection, FAVORITES_ID, V1, NOW).unwrap();
        playlist_add(&connection, FAVORITES_ID, V2, NOW + 5).unwrap();
        playlist_add(&connection, WATCH_LATER_ID, V1, NOW + 6).unwrap();
        // Adding twice changes nothing.
        playlist_add(&connection, FAVORITES_ID, V1, NOW + 7).unwrap();

        let favourites = playlist_items(&connection, FAVORITES_ID).unwrap();
        let ids: Vec<_> = favourites.iter().map(|item| item.video.video_id.as_str()).collect();
        assert_eq!(ids, vec![V2, V1]);
        assert!(favourites[1].favorite && favourites[1].watch_later);
        assert!(favourites[0].favorite && !favourites[0].watch_later);
        let counts: Vec<_> = playlists(&connection).unwrap().iter().map(|list| list.item_count).collect();
        assert_eq!(counts, vec![2, 1]);
    }

    #[test]
    fn toggling_adds_and_removes() {
        let connection = database();
        follow_with_videos(&connection);
        assert!(playlist_toggle(&connection, FAVORITES_ID, V1, NOW).unwrap());
        assert!(!playlist_toggle(&connection, FAVORITES_ID, V1, NOW + 1).unwrap());
        assert!(playlist_items(&connection, FAVORITES_ID).unwrap().is_empty());
    }

    #[test]
    fn a_video_whose_details_were_not_saved_cannot_join_a_list() {
        let connection = database();
        assert!(playlist_add(&connection, FAVORITES_ID, V1, NOW).is_err());
        follow_with_videos(&connection);
        assert!(playlist_add(&connection, "missing", V1, NOW).is_err());
    }

    #[test]
    fn own_lists_can_be_made_renamed_and_deleted_but_the_built_in_ones_cannot() {
        let connection = database();
        follow_with_videos(&connection);
        let list = playlist_create(&connection, "  线性代数  ", NOW).unwrap();
        assert_eq!(list.name, "线性代数");
        assert_eq!(list.kind, "local");
        assert!(!list.builtin);
        assert!(playlist_create(&connection, "   ", NOW).is_err());

        playlist_rename(&connection, &list.playlist_id, "线代", NOW + 1).unwrap();
        playlist_add(&connection, &list.playlist_id, V2, NOW + 2).unwrap();
        playlist_add(&connection, &list.playlist_id, V1, NOW + 3).unwrap();
        // Own lists keep the order things were added in.
        let ids: Vec<_> = playlist_items(&connection, &list.playlist_id)
            .unwrap()
            .iter()
            .map(|item| item.video.video_id.clone())
            .collect();
        assert_eq!(ids, vec![V2.to_string(), V1.to_string()]);

        assert!(playlist_rename(&connection, FAVORITES_ID, "x", NOW).is_err());
        assert!(playlist_delete(&connection, WATCH_LATER_ID, NOW).is_err());
        playlist_delete(&connection, &list.playlist_id, NOW + 4).unwrap();
        assert_eq!(playlists(&connection).unwrap().len(), 2);
    }

    #[test]
    fn a_course_is_created_once_and_follows_its_playlist() {
        let connection = database();
        let first = course_save(
            &connection,
            "PLZHQObOWTQDPD3MizzM2xVFitgF8hE_ab",
            "线性代数的本质",
            Some("3Blue1Brown"),
            &[
                VideoInput { duration_seconds: Some(592), ..video(V1, CHANNEL_A, "一", NOW) },
                VideoInput { duration_seconds: Some(600), ..video(V2, CHANNEL_A, "二", NOW) },
            ],
            NOW,
        )
        .unwrap();
        assert_eq!(first.kind, "course");
        assert_eq!(first.item_count, 2);
        assert_eq!(first.channel_name.as_deref(), Some("3Blue1Brown"));

        save_progress(&connection, V1, 590.0, Some(592.0), NOW + 1).unwrap();
        let synced = course_save(
            &connection,
            "PLZHQObOWTQDPD3MizzM2xVFitgF8hE_ab",
            "线性代数的本质（更新）",
            Some("3Blue1Brown"),
            &[
                video(V2, CHANNEL_A, "二", NOW),
                video(V3, CHANNEL_A, "三", NOW),
                video(V1, CHANNEL_A, "一", NOW),
            ],
            NOW + 100,
        )
        .unwrap();
        assert_eq!(synced.playlist_id, first.playlist_id);
        assert_eq!(synced.name, "线性代数的本质（更新）");
        assert_eq!(synced.item_count, 3);
        assert_eq!(synced.finished_count, 1);
        let order: Vec<_> = playlist_items(&connection, &synced.playlist_id)
            .unwrap()
            .iter()
            .map(|item| item.video.video_id.clone())
            .collect();
        assert_eq!(order, vec![V2.to_string(), V3.to_string(), V1.to_string()]);

        assert!(course_save(&connection, "bad id!", "x", None, &[], NOW).is_err());
    }

    #[test]
    fn unfollowing_drops_the_unreferenced_videos_but_not_the_ones_in_a_list_or_the_history() {
        let connection = database();
        follow_with_videos(&connection);
        playlist_add(&connection, FAVORITES_ID, V1, NOW).unwrap();
        mark_played(&connection, V2, NOW).unwrap();

        unsubscribe(&connection, CHANNEL_A, NOW).unwrap();
        let remaining: Vec<String> = connection
            .prepare("SELECT video_id FROM videos ORDER BY video_id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(remaining, vec![V1.to_string(), V2.to_string(), V3.to_string()]);
        // V3 belongs to the other channel, which is still followed.
        unsubscribe(&connection, CHANNEL_B, NOW).unwrap();
        let after: i64 = connection.query_row("SELECT COUNT(*) FROM videos", [], |row| row.get(0)).unwrap();
        assert_eq!(after, 2);
    }

    #[test]
    fn old_videos_of_followed_channels_leave_the_cache_after_thirteen_weeks() {
        let connection = database();
        subscribe(&connection, &channel_input(CHANNEL_A, "A"), NOW).unwrap();
        store_videos(
            &connection,
            &[
                video(V1, CHANNEL_A, "旧", NOW - 100 * DAY),
                video(V2, CHANNEL_A, "新", NOW - 10 * DAY),
                video(V3, CHANNEL_A, "旧但收藏", NOW - 100 * DAY),
            ],
            NOW,
        )
        .unwrap();
        playlist_add(&connection, FAVORITES_ID, V3, NOW).unwrap();
        prune(&connection, NOW).unwrap();
        let ids: Vec<_> = feed(&connection, &FeedQuery::default()).unwrap().into_iter().map(|item| item.video.video_id).collect();
        assert_eq!(ids, vec![V2.to_string(), V3.to_string()]);
    }

    #[test]
    fn settings_default_and_are_clamped_when_saved() {
        let connection = database();
        assert_eq!(settings(&connection).unwrap(), PlayerSettings::default());
        let saved = save_settings(
            &connection,
            &PlayerSettings { feed_update_threshold_seconds: 10_000_000, hide_finished_in_feed: true, ..PlayerSettings::default() },
        )
        .unwrap();
        assert_eq!(saved.feed_update_threshold_seconds, 7 * 24 * 3600);
        let again = settings(&connection).unwrap();
        assert!(again.hide_finished_in_feed);
        assert_eq!(overview(&connection).unwrap().settings, again);
    }

    #[test]
    fn a_backup_round_trips_into_an_empty_database() {
        let source = database();
        follow_with_videos(&source);
        playlist_add(&source, FAVORITES_ID, V1, NOW).unwrap();
        let mine = playlist_create(&source, "我的", NOW).unwrap();
        playlist_add(&source, &mine.playlist_id, V2, NOW).unwrap();
        course_save(&source, "PLabcdefghijk", "课", Some("某人"), &[video(V3, CHANNEL_B, "三", NOW)], NOW).unwrap();
        save_progress(&source, V1, 50.0, Some(500.0), NOW).unwrap();
        mark_played(&source, V1, NOW + 3).unwrap();
        save_settings(&source, &PlayerSettings { autoplay_next: false, ..PlayerSettings::default() }).unwrap();

        let backup = export_backup(&source, NOW + 10).unwrap();
        assert_eq!(backup.format, BACKUP_FORMAT);
        // The cache of the feed is not in it, only what lists, history and states refer to.
        let backed_up: Vec<_> = backup.videos.iter().map(|video| video.video_id.as_str()).collect();
        assert_eq!(backed_up, vec![V1, V2, V3]);
        let text = serde_json::to_string(&backup).unwrap();

        let target = database();
        let summary = import_backup(&target, &serde_json::from_str(&text).unwrap(), NOW + 20).unwrap();
        assert_eq!(summary.channels_added, 2);
        assert_eq!(summary.playlists_added, 2);
        assert_eq!(channels(&target).unwrap().len(), 2);
        assert_eq!(playlist_items(&target, FAVORITES_ID).unwrap().len(), 1);
        assert_eq!(watch_state(&target, V1).unwrap().unwrap().progress_seconds, 50.0);
        assert_eq!(history(&target, 0, 0).unwrap().len(), 1);
        let names: Vec<_> = playlists(&target).unwrap().into_iter().map(|list| list.name).collect();
        assert_eq!(names, vec!["收藏", "稍后看", "我的", "课"]);

        // Importing the same backup again adds nothing.
        let again = import_backup(&target, &serde_json::from_str(&text).unwrap(), NOW + 30).unwrap();
        assert_eq!((again.channels_added, again.playlists_added), (0, 0));
        assert_eq!(playlists(&target).unwrap().len(), 4);
    }

    #[test]
    fn a_newer_state_wins_when_a_backup_is_merged() {
        let connection = database();
        follow_with_videos(&connection);
        save_progress(&connection, V1, 100.0, Some(1000.0), NOW + 50).unwrap();
        let mut backup = export_backup(&connection, NOW).unwrap();
        backup.states[0].progress_seconds = 10.0;
        backup.states[0].updated_at = NOW; // older than the stored one
        import_backup(&connection, &backup, NOW + 60).unwrap();
        assert_eq!(watch_state(&connection, V1).unwrap().unwrap().progress_seconds, 100.0);
        backup.states[0].updated_at = NOW + 500;
        import_backup(&connection, &backup, NOW + 60).unwrap();
        assert_eq!(watch_state(&connection, V1).unwrap().unwrap().progress_seconds, 10.0);
    }

    #[test]
    fn a_file_that_is_not_a_backup_is_refused() {
        let connection = database();
        assert!(import_backup(&connection, &Backup::default(), NOW).is_err());
        let too_new = Backup { format: BACKUP_FORMAT.to_string(), version: 9, ..Backup::default() };
        assert!(import_backup(&connection, &too_new, NOW).is_err());
    }

    // ---- feed parsing ----

    const FEED: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <link rel="self" href="http://www.youtube.com/feeds/videos.xml?playlist_id=UULFYO_jab_esuFRV4b17AJtAw"/>
 <id>yt:playlist:UULFYO_jab_esuFRV4b17AJtAw</id>
 <yt:playlistId>UULFYO_jab_esuFRV4b17AJtAw</yt:playlistId>
 <yt:channelId>YO_jab_esuFRV4b17AJtAw</yt:channelId>
 <title>Videos</title>
 <link rel="alternate" href="https://www.youtube.com/playlist?list=UULFYO_jab_esuFRV4b17AJtAw"/>
 <author>
  <name>3Blue1Brown</name>
  <uri>https://www.youtube.com/channel/UCYO_jab_esuFRV4b17AJtAw</uri>
 </author>
 <published>2015-03-06T19:57:18+00:00</published>
 <entry>
  <id>yt:video:LKrwhjOI8Nc</id>
  <yt:videoId>LKrwhjOI8Nc</yt:videoId>
  <yt:channelId>UCYO_jab_esuFRV4b17AJtAw</yt:channelId>
  <title>There's never been a better time &amp; place</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=LKrwhjOI8Nc"/>
  <author><name>3Blue1Brown</name><uri>https://www.youtube.com/channel/UCYO_jab_esuFRV4b17AJtAw</uri></author>
  <published>2026-10-16T16:15:20+00:00</published>
  <updated>2026-10-21T20:00:00+00:00</updated>
  <media:group>
   <media:title>There's never been a better time</media:title>
   <media:content url="https://www.youtube.com/v/LKrwhjOI8Nc?version=3" type="application/x-shockwave-flash" width="640" height="390"/>
   <media:thumbnail url="https://i2.ytimg.com/vi/LKrwhjOI8Nc/hqdefault.jpg" width="480" height="360"/>
   <media:description>desc</media:description>
   <media:community>
    <media:starRating count="42000" average="5.00" min="1" max="5"/>
    <media:statistics views="2375575"/>
   </media:community>
  </media:group>
 </entry>
 <entry>
  <yt:videoId>6U6Z6pb6ewI</yt:videoId>
  <title>A short one</title>
  <link rel="alternate" href="https://www.youtube.com/shorts/6U6Z6pb6ewI"/>
  <published>2026-10-12T17:11:45+08:00</published>
  <media:group><media:statistics views="9"/></media:group>
 </entry>
 <entry>
  <yt:videoId>broken</yt:videoId>
  <title>bad id</title>
 </entry>
</feed>"#;

    #[test]
    fn the_atom_feed_is_read_with_its_channel_and_entries() {
        let parsed = parse_feed(FEED).unwrap();
        assert_eq!(parsed.title.as_deref(), Some("Videos"));
        assert_eq!(parsed.channel_name.as_deref(), Some("3Blue1Brown"));
        // The feed's own <yt:channelId> lacks the UC prefix, so the id comes from the first entry.
        assert_eq!(parsed.channel_id.as_deref(), Some(CHANNEL_A));
        assert_eq!(parsed.entries.len(), 2, "the entry with a broken id is skipped");

        let first = &parsed.entries[0];
        assert_eq!(first.video_id, "LKrwhjOI8Nc");
        assert_eq!(first.title, "There's never been a better time & place");
        assert_eq!(first.published_at, Some(parse_rfc3339("2026-10-16T16:15:20+00:00").unwrap()));
        assert_eq!(first.view_count, Some(2_375_575));
        assert_eq!(first.thumbnail_url.as_deref(), Some("https://i2.ytimg.com/vi/LKrwhjOI8Nc/hqdefault.jpg"));
        assert!(!first.is_short);
        assert!(parsed.entries[1].is_short);
        assert_eq!(parsed.entries[1].view_count, Some(9));
    }

    #[test]
    fn shorts_do_not_reach_the_cache() {
        let parsed = parse_feed(FEED).unwrap();
        let videos = feed_videos(&parsed, CHANNEL_A, None);
        assert_eq!(videos.len(), 1);
        assert_eq!(videos[0].video_id, "LKrwhjOI8Nc");
        assert_eq!(videos[0].channel_id.as_deref(), Some(CHANNEL_A));
        assert_eq!(videos[0].channel_name.as_deref(), Some("3Blue1Brown"));
        assert_eq!(videos[0].duration_seconds, None);
    }

    #[test]
    fn text_that_is_not_a_feed_is_refused() {
        assert!(parse_feed("<html><body>Error 404</body></html>").is_err());
        assert!(parse_feed("not xml at all").is_err());
        assert!(parse_feed("").is_err());
    }

    #[test]
    fn dates_are_read_with_offsets_and_fractions() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("1970-01-02T00:00:00+00:00"), Some(86_400));
        assert_eq!(parse_rfc3339("2026-10-16T16:15:20+00:00"), Some(1_792_167_320));
        // 08:00 at +08:00 is midnight UTC.
        assert_eq!(parse_rfc3339("2026-10-12T08:00:00+08:00"), parse_rfc3339("2026-10-12T00:00:00Z"));
        assert_eq!(parse_rfc3339("2026-10-12T00:00:00.123Z"), parse_rfc3339("2026-10-12T00:00:00Z"));
        assert_eq!(parse_rfc3339("2026-10-11T19:00:00-05:00"), parse_rfc3339("2026-10-12T00:00:00Z"));
        assert_eq!(parse_rfc3339("2024-02-29T00:00:00Z"), Some(1_709_164_800));
        assert_eq!(parse_rfc3339("yesterday"), None);
        assert_eq!(parse_rfc3339("2026-13-01T00:00:00Z"), None);
    }

    #[test]
    fn new_videos_are_those_the_cache_lacked() {
        let connection = database();
        follow_with_videos(&connection);
        let incoming = vec![video(V1, CHANNEL_A, "一", NOW), video(V4, CHANNEL_A, "四", NOW)];
        assert_eq!(new_video_ids(&connection, &incoming).unwrap(), vec![V4.to_string()]);
    }

    #[test]
    fn the_field_names_are_the_ones_the_front_end_reads() {
        let connection = database();
        follow_with_videos(&connection);
        playlist_add(&connection, FAVORITES_ID, V1, NOW).unwrap();
        let item = serde_json::to_value(&feed(&connection, &FeedQuery::default()).unwrap()[0]).unwrap();
        for key in [
            "videoId", "channelId", "channelName", "title", "publishedAt", "publishedApprox", "durationSeconds",
            "viewCount", "viewText", "thumbnailUrl", "progressSeconds", "finished", "lastPlayedAt", "favorite",
            "watchLater",
        ] {
            assert!(item.get(key).is_some(), "{key} is missing from {item}");
        }
        let overview = serde_json::to_value(overview(&connection).unwrap()).unwrap();
        assert!(overview["channels"][0].get("subscribedAt").is_some());
        assert!(overview["playlists"][0].get("itemCount").is_some());
        assert!(overview["settings"].get("feedUpdateThresholdSeconds").is_some());
        let state = serde_json::to_value(save_progress(&connection, V1, 50.0, Some(100.0), NOW).unwrap().unwrap()).unwrap();
        assert!(state.get("resumeSeconds").is_some());

        // And the other direction: what the front end sends.
        let input: ChannelInput = serde_json::from_str(r#"{"channelId":"UCYO_jab_esuFRV4b17AJtAw","name":"x","avatarUrl":"u"}"#).unwrap();
        assert_eq!(input.avatar_url.as_deref(), Some("u"));
        let video: VideoInput = serde_json::from_str(r#"{"videoId":"aaaaaaaaaaa","title":"t","durationSeconds":5}"#).unwrap();
        assert_eq!(video.duration_seconds, Some(5));
        let query: FeedQuery = serde_json::from_str(r#"{"hideFinished":true,"limit":10}"#).unwrap();
        assert!(query.hide_finished);
    }

    #[test]
    fn learning_paths_save_track_progress_survive_prune_and_round_trip_backup() {
        let connection = database();
        let detail = learning_path_save(
            &connection,
            &LearningPathInput {
                path_id: Some("rust-systems".to_string()),
                title: "  Rust 系统编程进阶  ".to_string(),
                description: Some("从所有权到异步运行时".to_string()),
                nodes: vec![
                    LearningPathNodeInput {
                        node_id: "stage-1".to_string(),
                        parent_id: None,
                        position: 0,
                        kind: "stage".to_string(),
                        title: "第一阶段：内存与所有权".to_string(),
                        note: Some("核心基石".to_string()),
                        video_id: None,
                        start_seconds: 0,
                        optional: false,
                        prerequisite_ids: vec![],
                    },
                    LearningPathNodeInput {
                        node_id: "n-1".to_string(),
                        parent_id: Some("stage-1".to_string()),
                        position: 1,
                        kind: "video".to_string(),
                        title: "所有权与借用".to_string(),
                        note: None,
                        video_id: Some(V1.to_string()),
                        start_seconds: 15,
                        optional: false,
                        prerequisite_ids: vec![],
                    },
                    LearningPathNodeInput {
                        node_id: "n-2".to_string(),
                        parent_id: Some("stage-1".to_string()),
                        position: 2,
                        kind: "video".to_string(),
                        title: "生命周期标注".to_string(),
                        note: None,
                        video_id: Some(V2.to_string()),
                        start_seconds: 0,
                        optional: true,
                        prerequisite_ids: vec!["n-1".to_string()],
                    },
                    LearningPathNodeInput {
                        node_id: "n-merge".to_string(),
                        parent_id: None,
                        position: 3,
                        kind: "checkpoint".to_string(),
                        title: "阶段汇合实战".to_string(),
                        note: None,
                        video_id: Some(V3.to_string()),
                        start_seconds: 0,
                        optional: false,
                        // Diamond convergence: depends on both n-1 and n-2 (not a cycle).
                        prerequisite_ids: vec!["n-1".to_string(), "n-2".to_string()],
                    },
                ],
                videos: vec![
                    VideoInput {
                        duration_seconds: Some(600),
                        ..video(V1, CHANNEL_A, "Ownership Deep Dive", NOW - 200 * DAY)
                    },
                    VideoInput {
                        duration_seconds: Some(800),
                        ..video(V2, CHANNEL_A, "Lifetimes Explained", NOW - 200 * DAY)
                    },
                ],
            },
            NOW,
        )
        .unwrap();

        assert_eq!(detail.summary.path_id, "rust-systems");
        assert_eq!(detail.summary.title, "Rust 系统编程进阶");
        assert_eq!(detail.summary.node_count, 4);
        assert_eq!(detail.summary.video_count, 3);
        assert_eq!(detail.summary.finished_count, 0);
        // V3 was not in `input.videos`, yet fallback row was created so `video` is populated.
        assert_eq!(
            detail.nodes[3].video.as_ref().unwrap().video.title,
            "阶段汇合实战"
        );

        // Mark V1 watched and verify finished_count updates in summary + overview.
        set_watched(&connection, V1, true, NOW + 5).unwrap();
        let ov = overview(&connection).unwrap();
        assert_eq!(ov.learning_paths.len(), 1);
        assert_eq!(ov.learning_paths[0].finished_count, 1);

        // Prune must NOT delete old videos referenced by learning_path_nodes.
        prune(&connection, NOW + 100 * DAY).unwrap();
        assert_eq!(
            video_items(&connection, &[V1.to_string(), V2.to_string(), V3.to_string()])
                .unwrap()
                .len(),
            3
        );

        // Backup round-trip into an empty database.
        let backup = export_backup(&connection, NOW + 10).unwrap();
        assert_eq!(backup.learning_paths.len(), 1);
        let restored = database();
        let summary = import_backup(&restored, &backup, NOW + 20).unwrap();
        assert_eq!(summary.learning_paths_added, 1);
        let loaded = learning_path_get(&restored, "rust-systems").unwrap().unwrap();
        assert_eq!(loaded.nodes.len(), 4);
        assert_eq!(loaded.nodes[1].start_seconds, 15);
        assert_eq!(loaded.nodes[3].prerequisite_ids, vec!["n-1", "n-2"]);

        // Deleting removes the path and cascades nodes.
        learning_path_delete(&connection, "rust-systems", NOW + 30).unwrap();
        assert!(learning_paths(&connection).unwrap().is_empty());
        assert!(learning_path_get(&connection, "rust-systems").unwrap().is_none());
    }

    #[test]
    fn learning_paths_reject_cycles_and_missing_references() {
        let connection = database();
        // Prerequisite cycle: a -> b -> a
        let cyclic = LearningPathInput {
            path_id: None,
            title: "环路测试".to_string(),
            description: None,
            nodes: vec![
                LearningPathNodeInput {
                    node_id: "a".to_string(),
                    title: "A".to_string(),
                    prerequisite_ids: vec!["b".to_string()],
                    ..LearningPathNodeInput::default()
                },
                LearningPathNodeInput {
                    node_id: "b".to_string(),
                    title: "B".to_string(),
                    prerequisite_ids: vec!["a".to_string()],
                    ..LearningPathNodeInput::default()
                },
            ],
            videos: vec![],
        };
        assert!(learning_path_save(&connection, &cyclic, NOW).is_err());

        // Missing parent reference
        let missing_parent = LearningPathInput {
            path_id: None,
            title: "缺失父节点".to_string(),
            description: None,
            nodes: vec![LearningPathNodeInput {
                node_id: "a".to_string(),
                parent_id: Some("ghost".to_string()),
                title: "A".to_string(),
                ..LearningPathNodeInput::default()
            }],
            videos: vec![],
        };
        assert!(learning_path_save(&connection, &missing_parent, NOW).is_err());
    }
}
