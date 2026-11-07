use bzip2::read::BzDecoder;
use serde::Serialize;
use sherpa_onnx::{OnlineRecognizer, OnlineRecognizerConfig};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::time::Duration;
use tar::Archive;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use uuid::Uuid;

const MODEL_DIR_NAME: &str = "sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16";
const MODEL_ARCHIVE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16.tar.bz2";
const MODEL_ARCHIVE_MAX_BYTES: u64 = 512 * 1024 * 1024;
const CAPTION_EVENT: &str = "feed-asr-caption";
const SAMPLE_RATE: i32 = 16_000;
const CHUNK_SAMPLES: usize = 8_000;

#[derive(Default)]
pub struct FeedAsrState {
    // 一次只保留一个播客识别进程，切换节目时会先结束旧进程。
    children: Mutex<HashMap<String, Child>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedAsrStatus {
    pub model_installed: bool,
    pub ffmpeg_available: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedAsrDownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
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

fn model_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("models").join(MODEL_DIR_NAME))
        .map_err(|error| format!("无法定位本地字幕模型目录：{error}"))
}

fn model_files_installed(directory: &Path) -> bool {
    [
        "encoder-epoch-99-avg-1.int8.onnx",
        "decoder-epoch-99-avg-1.int8.onnx",
        "joiner-epoch-99-avg-1.int8.onnx",
        "tokens.txt",
    ]
    .iter()
    .all(|name| {
        directory
            .join(name)
            .metadata()
            .is_ok_and(|meta| meta.len() > 0)
    })
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

#[tauri::command]
pub fn feed_asr_get_status(app: AppHandle) -> Result<FeedAsrStatus, String> {
    let model_dir = model_directory(&app)?;
    Ok(FeedAsrStatus {
        model_installed: model_files_installed(&model_dir),
        ffmpeg_available: ffmpeg_is_available(),
    })
}

#[tauri::command]
pub async fn feed_asr_install_model(
    app: AppHandle,
    on_progress: Channel<FeedAsrDownloadProgress>,
) -> Result<FeedAsrStatus, String> {
    let model_dir = model_directory(&app)?;
    if model_files_installed(&model_dir) {
        return feed_asr_get_status(app);
    }

    let parent = model_dir
        .parent()
        .ok_or_else(|| "字幕模型目录无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建字幕模型目录：{error}"))?;
    let archive_path = parent.join(format!("{MODEL_DIR_NAME}.download.tmp"));
    let staging_dir = parent.join(format!("{MODEL_DIR_NAME}.installing"));
    let _ = fs::remove_file(&archive_path);
    if staging_dir.exists() {
        fs::remove_dir_all(&staging_dir)
            .map_err(|error| format!("无法清理旧模型临时目录：{error}"))?;
    }

    let result = download_model_archive(&archive_path, &on_progress).await;
    if let Err(error) = result {
        let _ = fs::remove_file(&archive_path);
        return Err(error);
    }

    let archive_for_extract = archive_path.clone();
    let staging_for_extract = staging_dir.clone();
    let extract_result = tokio::task::spawn_blocking(move || {
        extract_quantized_model(&archive_for_extract, &staging_for_extract)
    })
    .await
    .map_err(|error| format!("字幕模型解压任务失败：{error}"))?;
    let _ = fs::remove_file(&archive_path);
    if let Err(error) = extract_result {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(error);
    }

    if model_dir.exists() {
        fs::remove_dir_all(&model_dir).map_err(|error| format!("无法替换旧字幕模型：{error}"))?;
    }
    fs::rename(&staging_dir, &model_dir)
        .map_err(|error| format!("无法完成字幕模型安装：{error}"))?;
    if !model_files_installed(&model_dir) {
        let _ = fs::remove_dir_all(&model_dir);
        return Err("字幕模型文件校验失败，请重新下载".to_string());
    }

    feed_asr_get_status(app)
}

async fn download_model_archive(
    archive_path: &Path,
    on_progress: &Channel<FeedAsrDownloadProgress>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent("Seamind/0.1.0 local podcast captions")
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|error| format!("无法准备模型下载：{error}"))?;
    let mut response = client
        .get(MODEL_ARCHIVE_URL)
        .send()
        .await
        .map_err(|error| format!("字幕模型下载失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("字幕模型服务器返回 HTTP {}", response.status()));
    }
    let total_bytes = response.content_length();
    if total_bytes.is_some_and(|size| size > MODEL_ARCHIVE_MAX_BYTES) {
        return Err("字幕模型下载体积超过安全上限".to_string());
    }

    let mut file =
        File::create(archive_path).map_err(|error| format!("无法保存字幕模型：{error}"))?;
    let mut downloaded_bytes = 0_u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("字幕模型下载中断：{error}"))?
    {
        downloaded_bytes = downloaded_bytes.saturating_add(chunk.len() as u64);
        if downloaded_bytes > MODEL_ARCHIVE_MAX_BYTES {
            return Err("字幕模型下载体积超过安全上限".to_string());
        }
        file.write_all(&chunk)
            .map_err(|error| format!("无法写入字幕模型：{error}"))?;
        let _ = on_progress.send(FeedAsrDownloadProgress {
            downloaded_bytes,
            total_bytes,
        });
    }
    file.sync_all()
        .map_err(|error| format!("无法完成字幕模型写入：{error}"))?;
    if downloaded_bytes == 0 {
        return Err("字幕模型下载内容为空".to_string());
    }
    Ok(())
}

fn extract_quantized_model(archive_path: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| format!("无法创建模型解压目录：{error}"))?;
    let file =
        File::open(archive_path).map_err(|error| format!("无法打开字幕模型压缩包：{error}"))?;
    let decoder = BzDecoder::new(file);
    let mut archive = Archive::new(decoder);
    let required = [
        "encoder-epoch-99-avg-1.int8.onnx",
        "decoder-epoch-99-avg-1.int8.onnx",
        "joiner-epoch-99-avg-1.int8.onnx",
        "tokens.txt",
    ];

    for entry in archive
        .entries()
        .map_err(|error| format!("字幕模型压缩包无法读取：{error}"))?
    {
        let mut entry = entry.map_err(|error| format!("字幕模型文件损坏：{error}"))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let name = entry
            .path()
            .map_err(|error| format!("字幕模型文件路径无效：{error}"))?
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_owned);
        let Some(name) = name.filter(|name| required.contains(&name.as_str())) else {
            continue;
        };
        let output_path = destination.join(&name);
        entry
            .unpack(&output_path)
            .map_err(|error| format!("无法解压字幕模型文件：{error}"))?;
    }

    if !model_files_installed(destination) {
        return Err("字幕模型压缩包缺少所需的中英双语模型文件".to_string());
    }
    fs::write(
        destination.join("MODEL_SOURCE.txt"),
        "Seamind 本地字幕模型\n上游项目：sherpa-onnx\n模型：streaming-zipformer-small-bilingual-zh-en-2023-02-16\n来源：https://github.com/k2-fsa/sherpa-onnx\n模型许可证：Apache-2.0（以模型上游许可为准）\n",
    )
    .map_err(|error| format!("无法保存模型来源说明：{error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn feed_asr_start(
    app: AppHandle,
    state: State<'_, FeedAsrState>,
    audio_url: String,
    start_at: f64,
    playback_rate: f64,
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

    let directory = model_directory(&app)?;
    if !model_files_installed(&directory) {
        return Err("请先下载本地字幕模型".to_string());
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
            .join("decoder-epoch-99-avg-1.int8.onnx")
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
    config.enable_endpoint = true;
    config.decoding_method = Some("greedy_search".to_string());

    let recognizer = tokio::task::spawn_blocking(move || OnlineRecognizer::create(&config))
        .await
        .map_err(|error| format!("字幕识别引擎启动失败：{error}"))?
        .ok_or_else(|| "本地字幕识别引擎无法加载模型".to_string())?;
    let stream = recognizer.create_stream();

    let session_id = Uuid::new_v4().to_string();
    let mut command = Command::new("ffmpeg");
    command
        .arg("-nostdin")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-protocol_whitelist")
        .arg("http,https,tcp,tls,crypto")
        .arg("-readrate")
        .arg(format!("{playback_rate:.3}"));
    if start_at > 0.0 {
        command.arg("-ss").arg(format!("{start_at:.3}"));
    }
    command
        .arg("-i")
        .arg(audio_url)
        .args([
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
        .stderr(Stdio::null())
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

    {
        let mut children = state.children.lock().await;
        for (_, mut previous) in children.drain() {
            let _ = previous.kill().await;
        }
        children.insert(session_id.clone(), child);
    }

    let app_for_worker = app.clone();
    let worker_session_id = session_id.clone();
    tauri::async_runtime::spawn(async move {
        transcribe_ffmpeg_output(
            app_for_worker,
            worker_session_id,
            stdout,
            recognizer,
            stream,
            start_at,
        )
        .await;
    });

    Ok(session_id)
}

async fn transcribe_ffmpeg_output(
    app: AppHandle,
    session_id: String,
    mut stdout: tokio::process::ChildStdout,
    recognizer: OnlineRecognizer,
    stream: sherpa_onnx::OnlineStream,
    start_at: f64,
) {
    let mut processed_samples = 0_u64;
    let mut utterance_start = start_at;
    let mut last_text = String::new();
    let mut bytes = vec![0_u8; CHUNK_SAMPLES * std::mem::size_of::<f32>()];

    loop {
        let mut filled = 0;
        while filled < bytes.len() {
            match stdout.read(&mut bytes[filled..]).await {
                Ok(0) => break,
                Ok(count) => filled += count,
                Err(_) => break,
            }
        }
        let usable_bytes = filled / 4 * 4;
        if usable_bytes == 0 {
            break;
        }

        let samples = bytes[..usable_bytes]
            .chunks_exact(4)
            .map(|sample| f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]))
            .map(|sample| {
                if sample.is_finite() {
                    sample.clamp(-1.0, 1.0)
                } else {
                    0.0
                }
            })
            .collect::<Vec<_>>();
        stream.accept_waveform(SAMPLE_RATE, &samples);
        while recognizer.is_ready(&stream) {
            recognizer.decode(&stream);
        }
        processed_samples = processed_samples.saturating_add(samples.len() as u64);
        let end = start_at + processed_samples as f64 / SAMPLE_RATE as f64;
        let is_final = recognizer.is_endpoint(&stream);
        let text = recognizer
            .get_result(&stream)
            .map(|result| result.text.trim().to_string())
            .unwrap_or_default();

        if !text.is_empty() && (text != last_text || is_final) {
            let _ = app.emit(
                CAPTION_EVENT,
                FeedAsrCaptionEvent {
                    session_id: session_id.clone(),
                    start: utterance_start,
                    end,
                    text: text.clone(),
                    is_final,
                    error: None,
                },
            );
        }
        last_text = text;
        if is_final {
            recognizer.reset(&stream);
            utterance_start = end;
            last_text.clear();
        }
    }

    if processed_samples > 0 {
        stream.input_finished();
        while recognizer.is_ready(&stream) {
            recognizer.decode(&stream);
        }
        if let Some(result) = recognizer.get_result(&stream) {
            let text = result.text.trim().to_string();
            if !text.is_empty() {
                let _ = app.emit(
                    CAPTION_EVENT,
                    FeedAsrCaptionEvent {
                        session_id: session_id.clone(),
                        start: utterance_start,
                        end: start_at + processed_samples as f64 / SAMPLE_RATE as f64,
                        text,
                        is_final: true,
                        error: None,
                    },
                );
            }
        }
    }

    if processed_samples == 0 {
        let _ = app.emit(
            CAPTION_EVENT,
            FeedAsrCaptionEvent {
                session_id,
                start: start_at,
                end: start_at,
                text: String::new(),
                is_final: true,
                error: Some("FFmpeg 没有解码出音频，请检查该播客音源是否可访问".to_string()),
            },
        );
    }
}

#[tauri::command]
pub async fn feed_asr_stop(
    state: State<'_, FeedAsrState>,
    session_id: String,
) -> Result<(), String> {
    let child = state.children.lock().await.remove(&session_id);
    if let Some(mut child) = child {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    Ok(())
}
