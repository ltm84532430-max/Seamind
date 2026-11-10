use bzip2::read::BzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sherpa_onnx::{
    OfflineRecognizer, OfflineRecognizerConfig, OnlineRecognizer, OnlineRecognizerConfig,
    SileroVadModelConfig, VadModelConfig, VoiceActivityDetector, Wave,
};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tar::Archive;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio::time::timeout;
use uuid::Uuid;

const STREAM_DIR: &str = "sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16";
const STREAM_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16.tar.bz2";
const STREAM_ARCHIVE_MAX: u64 = 512 * 1024 * 1024;

const PODCAST_DIR: &str = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17";
const PODCAST_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2";
const PODCAST_ARCHIVE_MAX: u64 = 240 * 1024 * 1024;

const VAD_FILE: &str = "silero_vad.onnx";
const VAD_URL: &str =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";
const VAD_MAX: u64 = 8 * 1024 * 1024;

const CAPTION_EVENT: &str = "feed-asr-caption";
const SAMPLE_RATE: i32 = 16_000;
const CHUNK_SAMPLES: usize = 8_000;
const ASR_THREADS: i32 = 2;
/// sherpa 的 Rust 绑定把这三项默认写成 0。C API 会原样传下去，
/// rule1 在静音和时长都为 0 时从第一帧就判定句尾，流式模型每 0.5 秒被 reset，结果一直是空的。
const ENDPOINT_RULE1_TRAILING_SILENCE: f32 = 2.4;
const ENDPOINT_RULE2_TRAILING_SILENCE: f32 = 1.2;
const ENDPOINT_RULE3_MIN_UTTERANCE: f32 = 20.0;
const FIRST_AUDIO_TIMEOUT: Duration = Duration::from_secs(8);
const LATER_AUDIO_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, PartialEq, Eq)]
enum AsrMode {
    Podcast,
    Streaming,
}

struct FeedAsrInner {
    children: Mutex<HashMap<String, Child>>,
    stopped: Mutex<HashSet<String>>,
    podcast: Mutex<Option<Arc<OfflineRecognizer>>>,
    streaming: Mutex<Option<Arc<OnlineRecognizer>>>,
    cues: Mutex<HashMap<String, Vec<StoredCue>>>,
}

impl Default for FeedAsrInner {
    fn default() -> Self {
        Self {
            children: Mutex::new(HashMap::new()),
            stopped: Mutex::new(HashSet::new()),
            podcast: Mutex::new(None),
            streaming: Mutex::new(None),
            cues: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Default)]
pub struct FeedAsrState {
    inner: Arc<FeedAsrInner>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedAsrStatus {
    pub model_installed: bool,
    pub streaming_model_installed: bool,
    pub ffmpeg_available: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedAsrDownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedAsrCaptionEvent {
    session_id: String,
    start: f64,
    end: f64,
    text: String,
    is_final: bool,
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredCue {
    start: f64,
    end: f64,
    text: String,
}

struct CachePaths {
    partial: PathBuf,
    final_path: PathBuf,
}

fn configure_streaming_endpoint(config: &mut OnlineRecognizerConfig) {
    config.enable_endpoint = true;
    config.rule1_min_trailing_silence = ENDPOINT_RULE1_TRAILING_SILENCE;
    config.rule2_min_trailing_silence = ENDPOINT_RULE2_TRAILING_SILENCE;
    config.rule3_min_utterance_length = ENDPOINT_RULE3_MIN_UTTERANCE;
    config.decoding_method = Some("greedy_search".to_string());
    config.model_config.num_threads = ASR_THREADS;
    config.model_config.provider = Some("cpu".to_string());
    config.model_config.model_type = None;
}

fn streaming_required_files() -> &'static [(&'static str, &'static str)] {
    &[
        (
            "encoder-epoch-99-avg-1.int8.onnx",
            "encoder-epoch-99-avg-1.int8.onnx",
        ),
        // 这个 2023-02-16 包的官方配置用 fp32 解码器。int8 解码器会把识别打成空结果。
        ("decoder-epoch-99-avg-1.onnx", "decoder-epoch-99-avg-1.onnx"),
        (
            "joiner-epoch-99-avg-1.int8.onnx",
            "joiner-epoch-99-avg-1.int8.onnx",
        ),
        ("tokens.txt", "tokens.txt"),
        ("test_wavs/0.wav", "test_wavs/0.wav"),
    ]
}

fn podcast_required_files() -> &'static [(&'static str, &'static str)] {
    &[
        ("model.int8.onnx", "model.int8.onnx"),
        ("tokens.txt", "tokens.txt"),
        ("test_wavs/zh.wav", "test_wavs/zh.wav"),
    ]
}

fn parse_mode(mode: Option<String>) -> AsrMode {
    if mode.as_deref() == Some("streaming") {
        AsrMode::Streaming
    } else {
        AsrMode::Podcast
    }
}

fn normalize_article_id(article_id: Option<String>) -> Option<String> {
    article_id.and_then(|id| {
        let trimmed = id.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn cache_key(article_id: Option<&str>, audio_url: &str) -> String {
    if let Some(id) = article_id.filter(|id| !id.is_empty()) {
        let safe: String = id
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
            .take(80)
            .collect();
        if safe.len() >= 6 {
            return format!("article-{safe}");
        }
        return format!("article-{:x}", Sha256::digest(id.as_bytes()));
    }
    let stable = audio_url.split('?').next().unwrap_or(audio_url);
    format!("{:x}", Sha256::digest(stable.as_bytes()))
}

fn entry_matches(entry: &Path, wanted: &str) -> bool {
    let parts: Vec<&str> = entry
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(name) => name.to_str(),
            _ => None,
        })
        .collect();
    if parts.iter().any(|part| *part == "64" || *part == "96") {
        return false;
    }
    let wanted_parts: Vec<&str> = Path::new(wanted)
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(name) => name.to_str(),
            _ => None,
        })
        .collect();
    parts.len() >= wanted_parts.len()
        && parts[parts.len() - wanted_parts.len()..] == wanted_parts[..]
}

fn clean_caption_text(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut cleaned = String::new();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '<' && chars.get(index + 1) == Some(&'|') {
            index += 2;
            while index < chars.len() {
                if chars[index] == '|' && chars.get(index + 1) == Some(&'>') {
                    index += 2;
                    break;
                }
                index += 1;
            }
            continue;
        }
        cleaned.push(chars[index]);
        index += 1;
    }
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_spoken_text(text: &str) -> bool {
    text.chars()
        .any(|ch| ch.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&ch))
}

fn has_cjk(text: &str) -> bool {
    text.chars()
        .any(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch))
}

fn ranges_overlap(start: f64, end: f64, cue: &StoredCue) -> bool {
    let left = start.max(cue.start);
    let right = end.min(cue.end);
    let overlap = (right - left).max(0.0);
    let incoming = (end - start).max(0.05);
    let existing = (cue.end - cue.start).max(0.05);
    overlap / incoming.min(existing) >= 0.6
}

fn cue_already_known(cues: &[StoredCue], start: f64, end: f64) -> bool {
    cues.iter().any(|cue| ranges_overlap(start, end, cue))
}

fn remember_cue(cues: &mut Vec<StoredCue>, cue: StoredCue) -> bool {
    if let Some(existing) = cues
        .iter_mut()
        .find(|item| ranges_overlap(cue.start, cue.end, item))
    {
        if cue.text.chars().count() > existing.text.chars().count() {
            *existing = cue;
            return true;
        }
        return false;
    }
    cues.push(cue);
    cues.sort_by(|left, right| {
        left.start
            .partial_cmp(&right.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    if cues.len() > 400 {
        let extra = cues.len() - 400;
        cues.drain(0..extra);
    }
    true
}

fn cues_near(cues: &[StoredCue], start_at: f64) -> Vec<StoredCue> {
    let mut near: Vec<StoredCue> = cues
        .iter()
        .filter(|cue| cue.end >= start_at - 0.4 && cue.start <= start_at + 20.0)
        .cloned()
        .collect();
    near.sort_by(|left, right| {
        (left.start - start_at)
            .abs()
            .partial_cmp(&(right.start - start_at).abs())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    near.truncate(6);
    near.sort_by(|left, right| {
        left.start
            .partial_cmp(&right.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    near
}

fn ffmpeg_failure_message(stderr: &str) -> String {
    let line = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .next_back()
        .unwrap_or("");
    if line.is_empty() {
        "FFmpeg 没有解码出音频，请检查该播客音源是否可访问".to_string()
    } else {
        let mut short = line.to_string();
        if short.chars().count() > 180 {
            short = short.chars().take(180).collect();
        }
        format!("FFmpeg 拉取或解码音频失败：{short}")
    }
}

fn models_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("models"))
        .map_err(|error| format!("无法定位本地字幕模型目录：{error}"))
}

fn nonempty(path: &Path) -> bool {
    path.metadata().is_ok_and(|meta| meta.len() > 0)
}

fn files_ready(directory: &Path, files: &[(&str, &str)]) -> bool {
    files
        .iter()
        .all(|(_, name)| nonempty(&directory.join(name)))
}

fn streaming_ready(root: &Path) -> bool {
    files_ready(&root.join(STREAM_DIR), streaming_required_files())
}

fn podcast_ready(root: &Path) -> bool {
    files_ready(&root.join(PODCAST_DIR), podcast_required_files()) && nonempty(&root.join(VAD_FILE))
}

fn ffmpeg_is_available() -> bool {
    StdCommand::new("ffmpeg")
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn status_from_root(root: &Path) -> FeedAsrStatus {
    FeedAsrStatus {
        model_installed: podcast_ready(root),
        streaming_model_installed: streaming_ready(root),
        ffmpeg_available: ffmpeg_is_available(),
    }
}

fn audio_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法定位播客缓存目录：{error}"))?
        .join("feed-audio-cache");
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建播客缓存目录：{error}"))?;
    Ok(dir)
}

fn cache_paths_for(
    app: &AppHandle,
    article_id: Option<&str>,
    audio_url: &str,
) -> Result<CachePaths, String> {
    let dir = audio_cache_dir(app)?;
    let key = cache_key(article_id, audio_url);
    Ok(CachePaths {
        partial: dir.join(format!("{key}.partial.wav")),
        final_path: dir.join(format!("{key}.wav")),
    })
}

fn ready_cache(paths: &CachePaths) -> Option<PathBuf> {
    if nonempty(&paths.final_path) {
        Some(paths.final_path.clone())
    } else {
        None
    }
}

fn cue_store_path(app: &AppHandle, key: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法定位字幕缓存目录：{error}"))?
        .join("feed-asr-cues");
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建字幕缓存目录：{error}"))?;
    Ok(dir.join(format!("{key}.json")))
}

fn read_cues(path: &Path) -> Vec<StoredCue> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_cues(path: &Path, cues: &[StoredCue]) {
    if let Ok(text) = serde_json::to_string(cues) {
        let _ = fs::write(path, text);
    }
}

#[tauri::command]
pub fn feed_asr_get_status(app: AppHandle) -> Result<FeedAsrStatus, String> {
    Ok(status_from_root(&models_root(&app)?))
}

#[tauri::command]
pub fn feed_asr_cached_audio(
    app: AppHandle,
    audio_url: String,
    article_id: Option<String>,
) -> Result<Option<String>, String> {
    let article_id = normalize_article_id(article_id);
    let paths = cache_paths_for(&app, article_id.as_deref(), &audio_url)?;
    let Some(path) = ready_cache(&paths) else {
        return Ok(None);
    };
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|error| format!("无法授权播放已缓存的播客音频：{error}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn feed_asr_install_model(
    app: AppHandle,
    state: tauri::State<'_, FeedAsrState>,
    on_progress: Channel<FeedAsrDownloadProgress>,
    model_kind: Option<String>,
) -> Result<FeedAsrStatus, String> {
    let mode = parse_mode(model_kind);
    let root = models_root(&app)?;
    fs::create_dir_all(&root).map_err(|error| format!("无法创建字幕模型目录：{error}"))?;
    match mode {
        AsrMode::Podcast => {
            ensure_archive(
                &root,
                PODCAST_DIR,
                PODCAST_URL,
                PODCAST_ARCHIVE_MAX,
                podcast_required_files(),
                "正在下载播客字幕模型（SenseVoice，约 160MB）",
                "Seamind 本地播客字幕模型\n上游：FunAudioLLM/SenseVoice，经 sherpa-onnx 发布 int8 版\n来源：https://github.com/k2-fsa/sherpa-onnx\n许可证：以模型上游许可为准\n",
                &on_progress,
            )
            .await?;
            ensure_vad(&root, &on_progress).await?;
            let inner = Arc::clone(&state.inner);
            let root_for_check = root.clone();
            let recognizer =
                tokio::task::spawn_blocking(move || load_podcast_recognizer(&root_for_check))
                    .await
                    .map_err(|error| format!("播客字幕模型自检失败：{error}"))??;
            *inner.podcast.lock().await = Some(recognizer);
        }
        AsrMode::Streaming => {
            ensure_archive(
                &root,
                STREAM_DIR,
                STREAM_URL,
                STREAM_ARCHIVE_MAX,
                streaming_required_files(),
                "正在下载低延迟字幕模型",
                "Seamind 本地低延迟字幕模型\n上游：sherpa-onnx streaming-zipformer-small-bilingual-zh-en-2023-02-16\n解码器使用压缩包中的 fp32 decoder-epoch-99-avg-1.onnx\n来源：https://github.com/k2-fsa/sherpa-onnx\n许可证：Apache-2.0（以模型上游许可为准）\n",
                &on_progress,
            )
            .await?;
            let inner = Arc::clone(&state.inner);
            let root_for_check = root.clone();
            let recognizer =
                tokio::task::spawn_blocking(move || load_streaming_recognizer(&root_for_check))
                    .await
                    .map_err(|error| format!("低延迟字幕模型自检失败：{error}"))??;
            *inner.streaming.lock().await = Some(recognizer);
        }
    }
    let _ = on_progress.send(FeedAsrDownloadProgress {
        downloaded_bytes: 1,
        total_bytes: Some(1),
        label: "模型自检通过".to_string(),
    });
    feed_asr_get_status(app)
}

async fn ensure_vad(
    root: &Path,
    on_progress: &Channel<FeedAsrDownloadProgress>,
) -> Result<(), String> {
    let destination = root.join(VAD_FILE);
    if nonempty(&destination) && destination.metadata().is_ok_and(|meta| meta.len() > 50_000) {
        return Ok(());
    }
    let temporary = root.join(format!("{VAD_FILE}.download.tmp"));
    download_to(
        &temporary,
        VAD_URL,
        VAD_MAX,
        "正在下载语音切分模型",
        on_progress,
    )
    .await?;
    if temporary.metadata().is_ok_and(|meta| meta.len() < 50_000) {
        let _ = fs::remove_file(&temporary);
        return Err("语音切分模型下载内容不完整".to_string());
    }
    let _ = fs::remove_file(&destination);
    fs::rename(&temporary, &destination)
        .map_err(|error| format!("无法保存语音切分模型：{error}"))?;
    Ok(())
}

async fn ensure_archive(
    root: &Path,
    dir_name: &str,
    url: &str,
    max_bytes: u64,
    files: &'static [(&'static str, &'static str)],
    label: &str,
    source_note: &str,
    on_progress: &Channel<FeedAsrDownloadProgress>,
) -> Result<(), String> {
    let model_dir = root.join(dir_name);
    if files_ready(&model_dir, files) {
        return Ok(());
    }
    fs::create_dir_all(&model_dir).map_err(|error| format!("无法创建模型目录：{error}"))?;
    let archive_path = root.join(format!("{dir_name}.tar.bz2"));
    if !nonempty(&archive_path) {
        let temporary = root.join(format!("{dir_name}.tar.bz2.download.tmp"));
        download_to(&temporary, url, max_bytes, label, on_progress).await?;
        if temporary
            .metadata()
            .is_ok_and(|meta| meta.len() < 1_000_000)
        {
            let _ = fs::remove_file(&temporary);
            return Err("字幕模型下载内容不完整".to_string());
        }
        let _ = fs::remove_file(&archive_path);
        fs::rename(&temporary, &archive_path)
            .map_err(|error| format!("无法保存字幕模型压缩包：{error}"))?;
    }
    let archive_for_extract = archive_path.clone();
    let dir_for_extract = model_dir.clone();
    let files = files.to_vec();
    let note = source_note.to_string();
    tokio::task::spawn_blocking(move || {
        extract_selected(&archive_for_extract, &dir_for_extract, &files)?;
        fs::write(dir_for_extract.join("MODEL_SOURCE.txt"), note)
            .map_err(|error| format!("无法保存模型来源说明：{error}"))?;
        if !files_ready(&dir_for_extract, &files) {
            return Err("字幕模型压缩包缺少所需文件".to_string());
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("字幕模型解压任务失败：{error}"))?
}

async fn download_to(
    destination: &Path,
    url: &str,
    max_bytes: u64,
    label: &str,
    on_progress: &Channel<FeedAsrDownloadProgress>,
) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建下载目录：{error}"))?;
    }
    let _ = fs::remove_file(destination);
    let client = reqwest::Client::builder()
        .user_agent("Seamind/0.1.0 local podcast captions")
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|error| format!("无法准备模型下载：{error}"))?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("字幕模型下载失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("字幕模型服务器返回 HTTP {}", response.status()));
    }
    let total_bytes = response.content_length();
    if total_bytes.is_some_and(|size| size > max_bytes) {
        return Err("字幕模型下载体积超过安全上限".to_string());
    }
    let mut file =
        File::create(destination).map_err(|error| format!("无法保存字幕模型：{error}"))?;
    let mut downloaded_bytes = 0_u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("字幕模型下载中断：{error}"))?
    {
        downloaded_bytes = downloaded_bytes.saturating_add(chunk.len() as u64);
        if downloaded_bytes > max_bytes {
            return Err("字幕模型下载体积超过安全上限".to_string());
        }
        file.write_all(&chunk)
            .map_err(|error| format!("无法写入字幕模型：{error}"))?;
        let _ = on_progress.send(FeedAsrDownloadProgress {
            downloaded_bytes,
            total_bytes,
            label: label.to_string(),
        });
    }
    file.sync_all()
        .map_err(|error| format!("无法完成字幕模型写入：{error}"))?;
    if downloaded_bytes == 0 {
        return Err("字幕模型下载内容为空".to_string());
    }
    Ok(())
}

fn extract_selected(
    archive_path: &Path,
    destination: &Path,
    files: &[(&str, &str)],
) -> Result<(), String> {
    let file =
        File::open(archive_path).map_err(|error| format!("无法打开字幕模型压缩包：{error}"))?;
    let decoder = BzDecoder::new(file);
    let mut archive = Archive::new(decoder);
    let mut found = HashSet::new();
    for entry in archive
        .entries()
        .map_err(|error| format!("字幕模型压缩包无法读取：{error}"))?
    {
        let mut entry = entry.map_err(|error| format!("字幕模型文件损坏：{error}"))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry
            .path()
            .map_err(|error| format!("字幕模型文件路径无效：{error}"))?;
        let Some((_, dest_name)) = files
            .iter()
            .copied()
            .find(|(wanted, _)| entry_matches(&path, wanted))
        else {
            continue;
        };
        let output_path = destination.join(dest_name);
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建模型子目录：{error}"))?;
        }
        entry
            .unpack(&output_path)
            .map_err(|error| format!("无法解压字幕模型文件：{error}"))?;
        found.insert(dest_name);
    }
    if let Some((_, missing)) = files
        .iter()
        .copied()
        .find(|(_, name)| !found.contains(name) && !nonempty(&destination.join(name)))
    {
        return Err(format!("字幕模型压缩包缺少 {missing}"));
    }
    Ok(())
}

fn load_podcast_recognizer(root: &Path) -> Result<Arc<OfflineRecognizer>, String> {
    let directory = root.join(PODCAST_DIR);
    if !podcast_ready(root) {
        return Err("请先下载播客字幕模型".to_string());
    }
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.sense_voice.model = Some(
        directory
            .join("model.int8.onnx")
            .to_string_lossy()
            .into_owned(),
    );
    config.model_config.sense_voice.language = Some("auto".to_string());
    config.model_config.sense_voice.use_itn = true;
    config.model_config.tokens = Some(directory.join("tokens.txt").to_string_lossy().into_owned());
    config.model_config.num_threads = ASR_THREADS;
    config.model_config.provider = Some("cpu".to_string());
    config.decoding_method = Some("greedy_search".to_string());
    let recognizer = OfflineRecognizer::create(&config).ok_or_else(|| {
        "播客字幕模型没有生效：SenseVoice 无法加载。请重新安装字幕模型。".to_string()
    })?;
    let wave_path = directory.join("test_wavs").join("zh.wav");
    let wave = Wave::read(&wave_path.to_string_lossy())
        .ok_or_else(|| "播客字幕模型没有生效：无法读取自检音频。".to_string())?;
    let text = decode_offline(&recognizer, wave.samples(), wave.sample_rate());
    if !has_cjk(&text) {
        return Err(format!(
            "播客字幕模型没有生效：自检结果是「{}」，没有识别出中文。",
            preview_text(&text)
        ));
    }
    self_check_vad(&root.join(VAD_FILE), wave.samples(), wave.sample_rate())?;
    Ok(Arc::new(recognizer))
}

fn load_streaming_recognizer(root: &Path) -> Result<Arc<OnlineRecognizer>, String> {
    let directory = root.join(STREAM_DIR);
    if !streaming_ready(root) {
        return Err("低延迟模型缺少 fp32 解码器或自检音频，请重新安装。".to_string());
    }
    let mut config = OnlineRecognizerConfig::default();
    config.model_config.transducer.encoder = Some(
        directory
            .join("encoder-epoch-99-avg-1.int8.onnx")
            .to_string_lossy()
            .into_owned(),
    );
    config.model_config.transducer.decoder = Some(
        directory
            .join("decoder-epoch-99-avg-1.onnx")
            .to_string_lossy()
            .into_owned(),
    );
    config.model_config.transducer.joiner = Some(
        directory
            .join("joiner-epoch-99-avg-1.int8.onnx")
            .to_string_lossy()
            .into_owned(),
    );
    config.model_config.tokens = Some(directory.join("tokens.txt").to_string_lossy().into_owned());
    configure_streaming_endpoint(&mut config);
    let recognizer = OnlineRecognizer::create(&config)
        .ok_or_else(|| "低延迟字幕模型没有生效：识别引擎无法加载。请重新安装。".to_string())?;
    let wave_path = directory.join("test_wavs").join("0.wav");
    let wave = Wave::read(&wave_path.to_string_lossy())
        .ok_or_else(|| "低延迟字幕模型没有生效：无法读取自检音频。".to_string())?;
    let text = decode_streaming_wave(&recognizer, wave.samples(), wave.sample_rate());
    if !text.contains("昨天") && !text.contains("星期三") {
        return Err(format!(
            "低延迟字幕模型没有生效：自检结果是「{}」，其中没有「昨天」或「星期三」。",
            preview_text(&text)
        ));
    }
    Ok(Arc::new(recognizer))
}

fn preview_text(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        "（空）".to_string()
    } else if trimmed.chars().count() > 40 {
        format!("{}…", trimmed.chars().take(40).collect::<String>())
    } else {
        trimmed.to_string()
    }
}

fn decode_offline(recognizer: &OfflineRecognizer, samples: &[f32], sample_rate: i32) -> String {
    let stream = recognizer.create_stream();
    stream.accept_waveform(sample_rate, samples);
    recognizer.decode(&stream);
    clean_caption_text(
        &stream
            .get_result()
            .map(|result| result.text)
            .unwrap_or_default(),
    )
}

fn decode_streaming_wave(
    recognizer: &OnlineRecognizer,
    samples: &[f32],
    sample_rate: i32,
) -> String {
    let stream = recognizer.create_stream();
    let mut offset = 0;
    while offset < samples.len() {
        let end = (offset + 1_600).min(samples.len());
        stream.accept_waveform(sample_rate, &samples[offset..end]);
        offset = end;
        while recognizer.is_ready(&stream) {
            recognizer.decode(&stream);
        }
    }
    stream.input_finished();
    while recognizer.is_ready(&stream) {
        recognizer.decode(&stream);
    }
    clean_caption_text(
        &recognizer
            .get_result(&stream)
            .map(|result| result.text)
            .unwrap_or_default(),
    )
}

fn self_check_vad(model: &Path, samples: &[f32], sample_rate: i32) -> Result<(), String> {
    let vad = create_vad(model)?;
    let samples = resample_linear(samples, sample_rate, SAMPLE_RATE);
    accept_vad_windows(&vad, &samples);
    vad.flush();
    if vad.is_empty() {
        return Err("语音切分模型没有生效：无法从自检音频里分出语句。".to_string());
    }
    Ok(())
}

fn create_vad(model: &Path) -> Result<VoiceActivityDetector, String> {
    let mut config = VadModelConfig::default();
    config.silero_vad = SileroVadModelConfig {
        model: Some(model.to_string_lossy().into_owned()),
        threshold: 0.5,
        min_silence_duration: 0.6,
        min_speech_duration: 0.4,
        window_size: 512,
        max_speech_duration: 18.0,
    };
    config.sample_rate = SAMPLE_RATE;
    config.num_threads = 1;
    config.provider = Some("cpu".to_string());
    config.debug = false;
    VoiceActivityDetector::create(&config, 30.0)
        .ok_or_else(|| "语音切分模型没有生效：Silero VAD 无法加载。".to_string())
}

fn resample_linear(samples: &[f32], from_rate: i32, to_rate: i32) -> Vec<f32> {
    if from_rate == to_rate || from_rate <= 0 || samples.is_empty() {
        return samples.to_vec();
    }
    let out_len =
        ((samples.len() as f64) * f64::from(to_rate) / f64::from(from_rate)).round() as usize;
    if out_len == 0 {
        return Vec::new();
    }
    let mut output = Vec::with_capacity(out_len);
    for index in 0..out_len {
        let position = index as f64 * f64::from(from_rate) / f64::from(to_rate);
        let left = position.floor() as usize;
        let right = (left + 1).min(samples.len() - 1);
        let mix = (position - left as f64) as f32;
        output.push(samples[left] * (1.0 - mix) + samples[right] * mix);
    }
    output
}

fn accept_vad_windows(vad: &VoiceActivityDetector, samples: &[f32]) {
    let mut offset = 0;
    while offset < samples.len() {
        let end = (offset + 512).min(samples.len());
        vad.accept_waveform(&samples[offset..end]);
        offset = end;
    }
}

#[tauri::command]
pub async fn feed_asr_start(
    app: AppHandle,
    state: tauri::State<'_, FeedAsrState>,
    audio_url: String,
    start_at: f64,
    playback_rate: f64,
    article_id: Option<String>,
    mode: Option<String>,
) -> Result<String, String> {
    let parsed_url = url::Url::parse(&audio_url).map_err(|_| "播客音频地址无效".to_string())?;
    if !matches!(parsed_url.scheme(), "http" | "https") || parsed_url.host_str().is_none() {
        return Err("实时字幕只支持 HTTP 或 HTTPS 播客音源".to_string());
    }
    if !start_at.is_finite() || start_at < 0.0 {
        return Err("字幕起始时间无效".to_string());
    }
    if !playback_rate.is_finite() || !(0.5..=3.0).contains(&playback_rate) {
        return Err("播放速度超出字幕识别范围".to_string());
    }
    if !ffmpeg_is_available() {
        return Err("实时字幕需要本机安装 FFmpeg 并将其加入 PATH".to_string());
    }

    let mode = parse_mode(mode);
    let article_id = normalize_article_id(article_id);
    let root = models_root(&app)?;
    let inner = Arc::clone(&state.inner);
    let engine = match mode {
        AsrMode::Podcast => {
            if !podcast_ready(&root) {
                return Err("请先下载播客字幕模型".to_string());
            }
            let recognizer = podcast_engine(&inner, &root).await?;
            let vad_path = root.join(VAD_FILE);
            let vad = tokio::task::spawn_blocking(move || create_vad(&vad_path))
                .await
                .map_err(|error| format!("语音切分模型加载失败：{error}"))??;
            SessionEngine::Podcast { recognizer, vad }
        }
        AsrMode::Streaming => {
            if !streaming_ready(&root) {
                return Err("低延迟模型缺少 fp32 解码器或自检音频，请重新安装。".to_string());
            }
            let recognizer = streaming_engine(&inner, &root).await?;
            let stream = recognizer.create_stream();
            SessionEngine::Streaming { recognizer, stream }
        }
    };

    let cache = cache_paths_for(&app, article_id.as_deref(), &audio_url)?;
    let cached = ready_cache(&cache);
    let mirror = if cached.is_some() {
        None
    } else {
        let _ = fs::remove_file(&cache.partial);
        Some(cache.partial.clone())
    };
    let input = cached
        .clone()
        .map(DecoderInput::Local)
        .unwrap_or(DecoderInput::Remote(audio_url));
    let mut decoder = spawn_decoder(&input, start_at, playback_rate, mirror.clone())?;
    watch_stderr(decoder.stderr.take(), Arc::clone(&decoder.stderr_text));

    let session_id = Uuid::new_v4().to_string();
    {
        let mut stopped = inner.stopped.lock().await;
        let mut children = inner.children.lock().await;
        let previous = children.drain().collect::<Vec<_>>();
        for (id, mut child) in previous {
            stopped.insert(id);
            let _ = child.kill().await;
        }
        children.insert(session_id.clone(), decoder.child);
    }

    let cue_key = cache_key(article_id.as_deref(), input.url_or_empty());
    let known = load_cues(&app, &inner, &cue_key).await;
    let app_for_worker = app.clone();
    let worker_id = session_id.clone();
    let stderr_text = Arc::clone(&decoder.stderr_text);
    tauri::async_runtime::spawn(async move {
        transcribe_session(SessionRun {
            app: app_for_worker,
            inner,
            session_id: worker_id,
            stdout: decoder.stdout,
            stderr_text,
            engine: Some(engine),
            start_at,
            utterance_start: start_at,
            last_partial: String::new(),
            cue_key,
            known,
            mirror,
        })
        .await;
    });
    Ok(session_id)
}

enum DecoderInput {
    Remote(String),
    Local(PathBuf),
}

impl DecoderInput {
    fn url_or_empty(&self) -> &str {
        match self {
            Self::Remote(url) => url,
            Self::Local(_) => "",
        }
    }
}

struct SpawnedDecoder {
    child: Child,
    stdout: ChildStdout,
    stderr: Option<ChildStderr>,
    stderr_text: Arc<Mutex<String>>,
}

fn spawn_decoder(
    input: &DecoderInput,
    start_at: f64,
    playback_rate: f64,
    mirror: Option<PathBuf>,
) -> Result<SpawnedDecoder, String> {
    let mut command = Command::new("ffmpeg");
    command
        .arg("-nostdin")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-y");
    match input {
        DecoderInput::Remote(_) => {
            command
                .arg("-user_agent")
                .arg("Seamind/0.1.0")
                .arg("-rw_timeout")
                .arg("15000000")
                .arg("-protocol_whitelist")
                .arg("http,https,tcp,tls,crypto");
        }
        DecoderInput::Local(_) => {}
    }
    command.arg("-readrate").arg(format!("{playback_rate:.3}"));
    if start_at > 0.0 {
        command.arg("-ss").arg(format!("{start_at:.3}"));
    }
    command.arg("-i");
    match input {
        DecoderInput::Remote(url) => {
            command.arg(url);
        }
        DecoderInput::Local(path) => {
            command.arg(path);
        }
    }
    if let Some(partial) = &mirror {
        if let Some(parent) = partial.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建播客缓存目录：{error}"))?;
        }
        // 同一次拉取同时写下一次可播放的 wav，避免下次再请求音源。
        command.args([
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
        ]);
        command.arg(partial);
    }
    command
        .args([
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 FFmpeg：{error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 FFmpeg 音频流".to_string())?;
    let stderr = child.stderr.take();
    Ok(SpawnedDecoder {
        child,
        stdout,
        stderr,
        stderr_text: Arc::new(Mutex::new(String::new())),
    })
}

fn watch_stderr(stderr: Option<ChildStderr>, slot: Arc<Mutex<String>>) {
    let Some(mut stderr) = stderr else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let mut chunk = [0_u8; 1024];
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let mut text = slot.lock().await;
                    text.push_str(&String::from_utf8_lossy(&chunk[..count]));
                    if text.len() > 4_000 {
                        let drop_count = text.len() - 3_000;
                        text.drain(..drop_count);
                    }
                }
            }
        }
    });
}

enum SessionEngine {
    Podcast {
        recognizer: Arc<OfflineRecognizer>,
        vad: VoiceActivityDetector,
    },
    Streaming {
        recognizer: Arc<OnlineRecognizer>,
        stream: sherpa_onnx::OnlineStream,
    },
}

struct SessionRun {
    app: AppHandle,
    inner: Arc<FeedAsrInner>,
    session_id: String,
    stdout: ChildStdout,
    stderr_text: Arc<Mutex<String>>,
    engine: Option<SessionEngine>,
    start_at: f64,
    utterance_start: f64,
    last_partial: String,
    cue_key: String,
    known: Vec<StoredCue>,
    mirror: Option<PathBuf>,
}

async fn podcast_engine(
    inner: &FeedAsrInner,
    root: &Path,
) -> Result<Arc<OfflineRecognizer>, String> {
    if let Some(engine) = inner.podcast.lock().await.clone() {
        return Ok(engine);
    }
    let root = root.to_path_buf();
    let engine = tokio::task::spawn_blocking(move || load_podcast_recognizer(&root))
        .await
        .map_err(|error| format!("播客字幕模型加载失败：{error}"))??;
    let mut slot = inner.podcast.lock().await;
    if let Some(existing) = slot.clone() {
        return Ok(existing);
    }
    *slot = Some(Arc::clone(&engine));
    Ok(engine)
}

async fn streaming_engine(
    inner: &FeedAsrInner,
    root: &Path,
) -> Result<Arc<OnlineRecognizer>, String> {
    if let Some(engine) = inner.streaming.lock().await.clone() {
        return Ok(engine);
    }
    let root = root.to_path_buf();
    let engine = tokio::task::spawn_blocking(move || load_streaming_recognizer(&root))
        .await
        .map_err(|error| format!("低延迟字幕模型加载失败：{error}"))??;
    let mut slot = inner.streaming.lock().await;
    if let Some(existing) = slot.clone() {
        return Ok(existing);
    }
    *slot = Some(Arc::clone(&engine));
    Ok(engine)
}

async fn load_cues(app: &AppHandle, inner: &FeedAsrInner, key: &str) -> Vec<StoredCue> {
    let mut cues = inner.cues.lock().await;
    if let Some(existing) = cues.get(key) {
        return existing.clone();
    }
    let loaded = cue_store_path(app, key)
        .ok()
        .map(|path| read_cues(&path))
        .unwrap_or_default();
    cues.insert(key.to_string(), loaded.clone());
    loaded
}

async fn remember_and_store(
    app: &AppHandle,
    inner: &FeedAsrInner,
    key: &str,
    cue: StoredCue,
) -> bool {
    let stored = {
        let mut cues = inner.cues.lock().await;
        let entry = cues.entry(key.to_string()).or_default();
        if !remember_cue(entry, cue) {
            return false;
        }
        entry.clone()
    };
    if let Ok(path) = cue_store_path(app, key) {
        write_cues(&path, &stored);
    }
    true
}

async fn transcribe_session(mut run: SessionRun) {
    for cue in cues_near(&run.known, run.start_at) {
        emit_caption(
            &run.app,
            &run.session_id,
            cue.start,
            cue.end,
            cue.text,
            true,
            None,
        );
    }

    let mut processed_samples = 0_u64;
    let mut bytes = vec![0_u8; CHUNK_SAMPLES * std::mem::size_of::<f32>()];
    let mut failure: Option<String> = None;
    let mut clean_eof = false;
    loop {
        if session_stopped(&run.inner, &run.session_id).await {
            break;
        }
        let limit = if processed_samples == 0 {
            FIRST_AUDIO_TIMEOUT
        } else {
            LATER_AUDIO_TIMEOUT
        };
        let read = timeout(limit, read_pcm_chunk(&mut run.stdout, &mut bytes)).await;
        let filled = match read {
            Ok(Ok(0)) => {
                clean_eof = true;
                break;
            }
            Ok(Ok(count)) => count,
            Ok(Err(_)) | Err(_) => {
                failure = Some(if processed_samples == 0 {
                    current_ffmpeg_error(&run.stderr_text).await
                } else {
                    "音频流中断，字幕已停止。".to_string()
                });
                break;
            }
        };
        let usable_bytes = filled / 4 * 4;
        if usable_bytes == 0 {
            clean_eof = true;
            break;
        }
        let samples = decode_f32le(&bytes[..usable_bytes]);
        processed_samples = processed_samples.saturating_add(samples.len() as u64);
        let chunk_end = run.start_at + processed_samples as f64 / f64::from(SAMPLE_RATE);
        if let Err(error) = consume_samples(&mut run, &samples, chunk_end).await {
            failure = Some(error);
            break;
        }
    }

    let stopped = session_stopped(&run.inner, &run.session_id).await;
    if !stopped {
        if processed_samples > 0 {
            let end = run.start_at + processed_samples as f64 / f64::from(SAMPLE_RATE);
            if let Err(error) = finish_engine(&mut run, end).await {
                if failure.is_none() {
                    failure = Some(error);
                }
            }
        }
        if let Some(message) = failure.clone() {
            emit_caption(
                &run.app,
                &run.session_id,
                run.start_at,
                run.start_at,
                String::new(),
                true,
                Some(message),
            );
        } else if processed_samples == 0 {
            let message = current_ffmpeg_error(&run.stderr_text).await;
            emit_caption(
                &run.app,
                &run.session_id,
                run.start_at,
                run.start_at,
                String::new(),
                true,
                Some(message),
            );
        }
    }

    if let Some(mut child) = run.inner.children.lock().await.remove(&run.session_id) {
        if !clean_eof {
            let _ = child.kill().await;
        }
        let _ = child.wait().await;
    }
    // 播放结束时前端会先停掉识别进程。只要 wav 已经写满这次解码的样本，就留下给下次播放。
    let mirror_ready = run
        .mirror
        .as_ref()
        .is_some_and(|partial| mirror_covers_samples(partial, processed_samples));
    if clean_eof && mirror_ready {
        commit_mirror(run.mirror.as_ref());
    } else if let Some(partial) = &run.mirror {
        let _ = fs::remove_file(partial);
    }
    run.inner.stopped.lock().await.remove(&run.session_id);
}

async fn session_stopped(inner: &FeedAsrInner, session_id: &str) -> bool {
    inner.stopped.lock().await.contains(session_id)
}

async fn current_ffmpeg_error(stderr_text: &Mutex<String>) -> String {
    ffmpeg_failure_message(&stderr_text.lock().await)
}

async fn read_pcm_chunk(stdout: &mut ChildStdout, bytes: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < bytes.len() {
        match stdout.read(&mut bytes[filled..]).await? {
            0 => break,
            count => filled += count,
        }
    }
    Ok(filled)
}

fn decode_f32le(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|sample| f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]))
        .map(|sample| {
            if sample.is_finite() {
                sample.clamp(-1.0, 1.0)
            } else {
                0.0
            }
        })
        .collect()
}

async fn consume_samples(
    run: &mut SessionRun,
    samples: &[f32],
    chunk_end: f64,
) -> Result<(), String> {
    match run.engine.take() {
        Some(SessionEngine::Podcast { recognizer, vad }) => {
            accept_vad_windows(&vad, samples);
            let segments = pop_vad_segments(&vad, run.start_at);
            let decoded = publish_segments(run, &recognizer, segments).await;
            run.engine = Some(SessionEngine::Podcast { recognizer, vad });
            decoded
        }
        Some(SessionEngine::Streaming { recognizer, stream }) => {
            let samples = samples.to_vec();
            let recognizer_for_decode = Arc::clone(&recognizer);
            let (stream, text, is_final) = tokio::task::spawn_blocking(move || {
                stream.accept_waveform(SAMPLE_RATE, &samples);
                while recognizer_for_decode.is_ready(&stream) {
                    recognizer_for_decode.decode(&stream);
                }
                let is_final = recognizer_for_decode.is_endpoint(&stream);
                let text = clean_caption_text(
                    &recognizer_for_decode
                        .get_result(&stream)
                        .map(|result| result.text)
                        .unwrap_or_default(),
                );
                if is_final {
                    recognizer_for_decode.reset(&stream);
                }
                (stream, text, is_final)
            })
            .await
            .map_err(|error| format!("字幕识别中断：{error}"))?;
            run.engine = Some(SessionEngine::Streaming { recognizer, stream });
            publish_streaming(run, chunk_end, text, is_final).await;
            Ok(())
        }
        None => Ok(()),
    }
}

fn pop_vad_segments(vad: &VoiceActivityDetector, origin: f64) -> Vec<(f64, Vec<f32>)> {
    let mut segments = Vec::new();
    while !vad.is_empty() {
        let Some(segment) = vad.front() else {
            break;
        };
        let start = origin + segment.start() as f64 / f64::from(SAMPLE_RATE);
        let samples = segment.samples().to_vec();
        drop(segment);
        vad.pop();
        if samples.len() >= 512 {
            segments.push((start, samples));
        }
    }
    segments
}

async fn publish_segments(
    run: &mut SessionRun,
    recognizer: &Arc<OfflineRecognizer>,
    segments: Vec<(f64, Vec<f32>)>,
) -> Result<(), String> {
    for (start, samples) in segments {
        let end = start + samples.len() as f64 / f64::from(SAMPLE_RATE);
        if cue_already_known(&run.known, start, end) {
            continue;
        }
        let recognizer = Arc::clone(recognizer);
        let text =
            tokio::task::spawn_blocking(move || decode_offline(&recognizer, &samples, SAMPLE_RATE))
                .await
                .map_err(|error| format!("字幕识别中断：{error}"))?;
        if !is_spoken_text(&text) {
            continue;
        }
        let cue = StoredCue {
            start,
            end,
            text: text.clone(),
        };
        if remember_and_store(&run.app, &run.inner, &run.cue_key, cue.clone()).await {
            run.known.push(cue);
            emit_caption(&run.app, &run.session_id, start, end, text, true, None);
        }
    }
    Ok(())
}

async fn publish_streaming(run: &mut SessionRun, chunk_end: f64, text: String, is_final: bool) {
    let start = run.utterance_start;
    if is_final {
        run.utterance_start = chunk_end;
        run.last_partial.clear();
        if !is_spoken_text(&text) || cue_already_known(&run.known, start, chunk_end) {
            return;
        }
        let cue = StoredCue {
            start,
            end: chunk_end,
            text: text.clone(),
        };
        if remember_and_store(&run.app, &run.inner, &run.cue_key, cue.clone()).await {
            run.known.push(cue);
            emit_caption(
                &run.app,
                &run.session_id,
                start,
                chunk_end,
                text,
                true,
                None,
            );
        }
        return;
    }
    if !is_spoken_text(&text) || text == run.last_partial {
        return;
    }
    run.last_partial = text.clone();
    emit_caption(
        &run.app,
        &run.session_id,
        start,
        chunk_end,
        text,
        false,
        None,
    );
}

async fn finish_engine(run: &mut SessionRun, end: f64) -> Result<(), String> {
    match run.engine.take() {
        Some(SessionEngine::Podcast { recognizer, vad }) => {
            vad.flush();
            let segments = pop_vad_segments(&vad, run.start_at);
            let decoded = publish_segments(run, &recognizer, segments).await;
            run.engine = Some(SessionEngine::Podcast { recognizer, vad });
            decoded
        }
        Some(SessionEngine::Streaming { recognizer, stream }) => {
            let recognizer_for_decode = Arc::clone(&recognizer);
            let text = tokio::task::spawn_blocking(move || {
                stream.input_finished();
                while recognizer_for_decode.is_ready(&stream) {
                    recognizer_for_decode.decode(&stream);
                }
                clean_caption_text(
                    &recognizer_for_decode
                        .get_result(&stream)
                        .map(|result| result.text)
                        .unwrap_or_default(),
                )
            })
            .await
            .map_err(|error| format!("字幕识别中断：{error}"))?;
            let stream = recognizer.create_stream();
            run.engine = Some(SessionEngine::Streaming { recognizer, stream });
            publish_streaming(run, end, text, true).await;
            Ok(())
        }
        None => Ok(()),
    }
}

fn mirror_covers_samples(partial: &Path, samples: u64) -> bool {
    if samples == 0 {
        return false;
    }
    let Ok(meta) = partial.metadata() else {
        return false;
    };
    let expected = 44_u64.saturating_add(samples.saturating_mul(2));
    meta.len() > 44 && meta.len().saturating_add(8_192) >= expected
}

fn commit_mirror(partial: Option<&PathBuf>) {
    let Some(partial) = partial else {
        return;
    };
    if !nonempty(partial) {
        let _ = fs::remove_file(partial);
        return;
    }
    let Some(name) = partial.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    let Some(final_name) = name.strip_suffix(".partial.wav") else {
        return;
    };
    let Some(parent) = partial.parent() else {
        return;
    };
    let final_path = parent.join(format!("{final_name}.wav"));
    let _ = fs::remove_file(&final_path);
    if fs::rename(partial, &final_path).is_err() {
        let _ = fs::remove_file(partial);
    }
}

fn emit_caption(
    app: &AppHandle,
    session_id: &str,
    start: f64,
    end: f64,
    text: String,
    is_final: bool,
    error: Option<String>,
) {
    let _ = app.emit(
        CAPTION_EVENT,
        FeedAsrCaptionEvent {
            session_id: session_id.to_string(),
            start,
            end,
            text,
            is_final,
            error,
        },
    );
}

#[tauri::command]
pub async fn feed_asr_stop(
    state: tauri::State<'_, FeedAsrState>,
    session_id: String,
) -> Result<(), String> {
    state.inner.stopped.lock().await.insert(session_id.clone());
    if let Some(mut child) = state.inner.children.lock().await.remove(&session_id) {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        cache_key, clean_caption_text, configure_streaming_endpoint, cue_already_known, cues_near,
        entry_matches, ffmpeg_failure_message, is_spoken_text, mirror_covers_samples, remember_cue,
        streaming_required_files, StoredCue,
    };
    use sherpa_onnx::OnlineRecognizerConfig;
    use std::path::Path;

    #[test]
    fn streaming_endpoint_rules_are_explicit_and_model_type_stays_empty() {
        let mut config = OnlineRecognizerConfig::default();
        configure_streaming_endpoint(&mut config);
        assert!(config.enable_endpoint);
        assert_eq!(config.rule1_min_trailing_silence, 2.4);
        assert_eq!(config.rule2_min_trailing_silence, 1.2);
        assert_eq!(config.rule3_min_utterance_length, 20.0);
        assert_eq!(config.model_config.num_threads, 2);
        assert!(config.model_config.model_type.is_none());
        assert_eq!(config.decoding_method.as_deref(), Some("greedy_search"));
    }

    #[test]
    fn streaming_package_keeps_the_fp32_decoder_and_test_wav() {
        let files = streaming_required_files();
        assert!(files
            .iter()
            .any(|(_, dest)| *dest == "decoder-epoch-99-avg-1.onnx"));
        assert!(files.iter().any(|(_, dest)| *dest == "test_wavs/0.wav"));
        assert!(!files
            .iter()
            .any(|(_, dest)| *dest == "decoder-epoch-99-avg-1.int8.onnx"));
    }

    #[test]
    fn archive_entry_matching_skips_int8_decoder_and_speed_buckets() {
        assert!(entry_matches(
            Path::new("sherpa/decoder-epoch-99-avg-1.onnx"),
            "decoder-epoch-99-avg-1.onnx"
        ));
        assert!(!entry_matches(
            Path::new("sherpa/decoder-epoch-99-avg-1.int8.onnx"),
            "decoder-epoch-99-avg-1.onnx"
        ));
        assert!(!entry_matches(
            Path::new("sherpa/64/encoder-epoch-99-avg-1.int8.onnx"),
            "encoder-epoch-99-avg-1.int8.onnx"
        ));
        assert!(entry_matches(
            Path::new("sherpa/test_wavs/0.wav"),
            "test_wavs/0.wav"
        ));
    }

    #[test]
    fn sensevoice_tags_are_removed_and_blank_text_is_not_spoken() {
        assert_eq!(
            clean_caption_text("<|zh|><|NEUTRAL|><|Speech|><|withitn|>昨天是星期三。"),
            "昨天是星期三。"
        );
        assert!(!is_spoken_text("，。 "));
        assert!(is_spoken_text("昨天"));
        assert!(is_spoken_text("hello"));
    }

    #[test]
    fn cached_cues_cover_repeats_and_leave_new_ranges_open() {
        let mut cues = Vec::new();
        assert!(remember_cue(
            &mut cues,
            StoredCue {
                start: 1.0,
                end: 4.0,
                text: "你好世界".to_string(),
            }
        ));
        assert!(!remember_cue(
            &mut cues,
            StoredCue {
                start: 1.2,
                end: 3.8,
                text: "你好".to_string(),
            }
        ));
        assert!(cue_already_known(&cues, 1.1, 3.5));
        assert!(!cue_already_known(&cues, 10.0, 12.0));
        let near = cues_near(&cues, 0.0);
        assert_eq!(near.len(), 1);
        assert!(cues_near(&cues, 30.0).is_empty());
    }

    #[test]
    fn complete_wav_mirror_is_kept_and_a_short_one_is_not() {
        let dir = std::env::temp_dir().join(format!("seamind-asr-mirror-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let partial = dir.join("episode.partial.wav");
        std::fs::write(&partial, vec![0_u8; 44 + 16_000 * 2]).unwrap();
        assert!(mirror_covers_samples(&partial, 16_000));
        std::fs::write(&partial, vec![0_u8; 1_000]).unwrap();
        assert!(!mirror_covers_samples(&partial, 16_000));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ffmpeg_errors_surface_the_decoder_line() {
        assert_eq!(
            ffmpeg_failure_message("Server returned 403 Forbidden (access denied)\n"),
            "FFmpeg 拉取或解码音频失败：Server returned 403 Forbidden (access denied)"
        );
        assert_eq!(
            ffmpeg_failure_message("  \n"),
            "FFmpeg 没有解码出音频，请检查该播客音源是否可访问"
        );
    }

    #[test]
    fn cache_key_follows_the_article_and_ignores_signed_query() {
        assert_eq!(
            cache_key(Some("episode-1"), "https://cdn.example/a.mp3?token=1"),
            cache_key(Some("episode-1"), "https://cdn.example/b.mp3?token=2")
        );
        assert_eq!(
            cache_key(None, "https://cdn.example/a.mp3?token=1"),
            cache_key(None, "https://cdn.example/a.mp3?token=2")
        );
        assert_ne!(
            cache_key(None, "https://cdn.example/a.mp3"),
            cache_key(None, "https://cdn.example/b.mp3")
        );
    }
}
