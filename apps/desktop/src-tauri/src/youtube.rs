use crate::media_resolver::{
    MediaProvider, MediaResolveRequest, MediaResolver, MediaType, PlaybackResolution,
};
use serde::Deserialize;
use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use url::Url;

const VIDEO_ID_LENGTH: usize = 11;
const EXTRACTOR_TIMEOUT_SECONDS: &str = "15";

#[tauri::command]
pub async fn youtube_resolve_playback(video_id: String) -> Result<PlaybackResolution, String> {
    if !is_valid_video_id(&video_id) {
        return Err("无效的 YouTube 视频编号。".to_string());
    }

    let request = MediaResolveRequest::youtube(video_id);
    tokio::task::spawn_blocking(move || YtDlpMediaResolver.resolve(&request))
        .await
        .map_err(|error| format!("本地视频解析任务失败：{error}"))?
}

struct YtDlpMediaResolver;

impl MediaResolver for YtDlpMediaResolver {
    fn resolve(&self, request: &MediaResolveRequest) -> Result<PlaybackResolution, String> {
        if request.provider != MediaProvider::YouTube {
            return Err("yt-dlp YouTube 解析器收到不支持的媒体来源。".to_string());
        }
        resolve_youtube_playback(&request.video_id)
    }
}

#[tauri::command]
pub async fn youtube_open_with_mpv(video_id: String, start_seconds: u64) -> Result<(), String> {
    if !is_valid_video_id(&video_id) {
        return Err("无效的 YouTube 视频编号。".to_string());
    }

    tokio::task::spawn_blocking(move || {
        let resolution = resolve_youtube_playback(&video_id)?;
        launch_resolved_media_with_mpv(resolution, start_seconds)
    })
        .await
        .map_err(|error| format!("外部播放器启动任务失败：{error}"))?
}

#[tauri::command]
pub async fn youtube_open_media_with_mpv(
    media_url: String,
    audio_url: Option<String>,
    start_seconds: u64,
) -> Result<(), String> {
    if !is_allowed_media_url(&media_url)
        || audio_url
            .as_deref()
            .is_some_and(|url| !is_allowed_media_url(url))
    {
        return Err("NewPipe 返回的媒体地址不在允许的 YouTube 视频域名内。".to_string());
    }

    tokio::task::spawn_blocking(move || {
        launch_mpv_media(&media_url, audio_url.as_deref(), start_seconds)
    })
    .await
    .map_err(|error| format!("外部播放器启动任务失败：{error}"))?
}

fn is_valid_video_id(video_id: &str) -> bool {
    video_id.len() == VIDEO_ID_LENGTH
        && video_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn launch_resolved_media_with_mpv(
    resolution: PlaybackResolution,
    start_seconds: u64,
) -> Result<(), String> {
    let (media_url, audio_url) = match resolution {
        PlaybackResolution::Html5 { url, .. } => (url, None),
        PlaybackResolution::Mpv {
            media_url: Some(media_url),
            audio_url,
            ..
        } => (media_url, audio_url),
        PlaybackResolution::Mpv {
            media_url: None,
            reason,
            ..
        } => {
            return Err(format!(
                "解析器没有返回可交给外部播放器的媒体地址：{reason}"
            ));
        }
    };

    if !is_allowed_media_url(&media_url)
        || audio_url
            .as_deref()
            .is_some_and(|url| !is_allowed_media_url(url))
    {
        return Err("解析器返回的媒体地址不在允许的 YouTube 视频域名内。".to_string());
    }

    launch_mpv_media(&media_url, audio_url.as_deref(), start_seconds)
}

fn launch_mpv_media(
    media_url: &str,
    audio_url: Option<&str>,
    start_seconds: u64,
) -> Result<(), String> {
    let player = std::env::var_os("SEAMIND_MPV_PATH").unwrap_or_else(|| "mpv".into());
    match spawn_mpv_media(&player, media_url, audio_url, start_seconds) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && audio_url.is_none() => {
            launch_ffplay_media(media_url, start_seconds).map_err(|ffplay_error| {
                if ffplay_error.kind() == std::io::ErrorKind::NotFound {
                    "未找到 mpv 或 ffplay。请安装其中一个播放器，或设置 SEAMIND_MPV_PATH。"
                        .to_string()
                } else {
                    format!("无法启动 mpv 或 ffplay：{ffplay_error}")
                }
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(
            "分离的音视频流需要 mpv。请安装 mpv 并加入 PATH，或设置 SEAMIND_MPV_PATH。".to_string(),
        ),
        Err(error) => Err(format!("无法启动 mpv：{error}")),
    }
}

fn spawn_mpv_media(
    player: &std::ffi::OsStr,
    media_url: &str,
    audio_url: Option<&str>,
    start_seconds: u64,
) -> std::io::Result<()> {
    let mut command = Command::new(player);
    command
        .arg("--force-window=immediate")
        .arg("--ytdl=no")
        .arg("--no-terminal");
    if let Some(audio_url) = audio_url {
        command.arg(format!("--audio-file={audio_url}"));
    }
    if start_seconds > 0 {
        command.arg(format!("--start={start_seconds}"));
    }
    command
        .arg("--")
        .arg(media_url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    command.spawn().map(|_| ())
}

fn launch_ffplay_media(media_url: &str, start_seconds: u64) -> std::io::Result<()> {
    let mut command = Command::new("ffplay");
    command.arg("-hide_banner").arg("-loglevel").arg("error");
    if start_seconds > 0 {
        command.arg("-ss").arg(start_seconds.to_string());
    }
    command.arg("-i").arg(media_url).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command.spawn().map(|_| ())
}

#[derive(Debug, Deserialize)]
struct YtDlpFormat {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    ext: Option<String>,
    #[serde(default)]
    protocol: Option<String>,
    #[serde(default)]
    vcodec: Option<String>,
    #[serde(default)]
    acodec: Option<String>,
}

#[derive(Debug, Deserialize)]
struct YtDlpInfo {
    #[serde(flatten)]
    format: YtDlpFormat,
    #[serde(default)]
    requested_formats: Option<Vec<YtDlpFormat>>,
}

fn resolve_youtube_playback(video_id: &str) -> Result<PlaybackResolution, String> {
    if let Some(program) = newpipe_bridge_program() {
        match resolve_with_newpipe_bridge(&program, video_id) {
            Ok(resolution) => return Ok(resolution),
            Err(bridge_error) => {
                return resolve_youtube_playback_with_yt_dlp(video_id).map_err(|fallback_error| {
                    format!(
                        "NewPipe 辅助进程失败：{bridge_error}；yt-dlp 后备解析也失败：{fallback_error}"
                    )
                });
            }
        }
    }

    resolve_youtube_playback_with_yt_dlp(video_id)
}

fn newpipe_bridge_program() -> Option<std::ffi::OsString> {
    if let Some(program) = std::env::var_os("SEAMIND_NEWPIPE_BRIDGE") {
        return Some(program);
    }

    #[cfg(windows)]
    {
        let profile = std::env::var_os("USERPROFILE")?;
        let bridge = std::path::PathBuf::from(profile)
            .join("Desktop")
            .join("NewPipe")
            .join("seamind-newpipe-bridge.ps1");
        if bridge.is_file() {
            return Some(bridge.into_os_string());
        }
    }

    None
}

fn resolve_with_newpipe_bridge(
    program: &std::ffi::OsStr,
    video_id: &str,
) -> Result<PlaybackResolution, String> {
    let video_url = format!("https://www.youtube.com/watch?v={video_id}");
    let response_file = NewPipeBridgeTempFile::create()?;
    let bridge_path = std::path::Path::new(program);
    let mut command = if bridge_path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("ps1"))
    {
        let mut powershell = Command::new("powershell.exe");
        powershell
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(program);
        powershell
    } else {
        Command::new(program)
    };
    command
        .arg("--seamind-resolve")
        .arg(video_url)
        .arg("--output-file")
        .arg(response_file.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 NewPipe 辅助进程：{error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "NewPipe 辅助进程未提供标准输出。".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "NewPipe 辅助进程未提供错误输出。".to_string())?;
    let stdout_reader = thread::spawn(move || read_all(stdout));
    let stderr_reader = thread::spawn(move || read_all(stderr));

    let deadline = Instant::now() + Duration::from_secs(60);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err("NewPipe 解析超过 60 秒，已终止辅助进程。".to_string());
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!("读取 NewPipe 辅助进程状态失败：{error}"));
            }
        }
    };

    let _stdout = stdout_reader
        .join()
        .map_err(|_| "读取 NewPipe 辅助进程输出时发生线程错误。".to_string())?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "读取 NewPipe 辅助进程错误输出时发生线程错误。".to_string())?;
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr);
        return Err(truncate_message(detail.trim(), 500));
    }

    let response = std::fs::read(response_file.path())
        .map_err(|error| format!("读取 NewPipe 辅助进程响应文件失败：{error}"))?;
    parse_newpipe_bridge_response(&response)
}

struct NewPipeBridgeTempFile(std::path::PathBuf);

impl NewPipeBridgeTempFile {
    fn create() -> Result<Self, String> {
        let root = std::env::temp_dir();
        for attempt in 0..16_u8 {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = root.join(format!(
                "seamind-newpipe-{}-{nonce}-{attempt}.json",
                std::process::id()
            ));
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(_) => return Ok(Self(path)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("无法创建 NewPipe 临时响应文件：{error}")),
            }
        }
        Err("无法分配唯一的 NewPipe 临时响应文件。".to_string())
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for NewPipeBridgeTempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn read_all(mut reader: impl Read) -> Vec<u8> {
    let mut output = Vec::new();
    let _ = reader.read_to_end(&mut output);
    output
}

fn parse_newpipe_bridge_response(output: &[u8]) -> Result<PlaybackResolution, String> {
    let resolution: PlaybackResolution = serde_json::from_slice(output)
        .map_err(|error| format!("无法读取 NewPipe 辅助进程响应：{error}"))?;
    if let PlaybackResolution::Html5 { url, .. } = &resolution {
        if !is_allowed_media_url(url) {
            return Err("NewPipe 返回的媒体地址不在允许的 YouTube 视频域名内。".to_string());
        }
    }
    if let PlaybackResolution::Mpv {
        media_url,
        audio_url,
        ..
    } = &resolution
    {
        if media_url
            .as_deref()
            .is_some_and(|url| !is_allowed_media_url(url))
            || audio_url
                .as_deref()
                .is_some_and(|url| !is_allowed_media_url(url))
        {
            return Err("NewPipe 返回了不受信任的媒体地址。".to_string());
        }
    }
    Ok(resolution)
}

fn resolve_youtube_playback_with_yt_dlp(video_id: &str) -> Result<PlaybackResolution, String> {
    let video_url = format!("https://www.youtube.com/watch?v={video_id}");
    let candidates = extractor_candidates();
    for (program, prefix_args) in candidates {
        let mut command = Command::new(&program);
        command
            .args(prefix_args)
            .args([
                "--ignore-config",
                "--no-warnings",
                "--no-playlist",
                "--quiet",
                "--no-progress",
                "--socket-timeout",
                EXTRACTOR_TIMEOUT_SECONDS,
                "--retries",
                "0",
                "--extractor-retries",
                "0",
                "--format",
                "best[ext=mp4][vcodec^=avc1][acodec^=mp4a][protocol=https]/bestvideo*+bestaudio/best",
                "--dump-single-json",
                "--skip-download",
                &video_url,
            ])
            .stdin(std::process::Stdio::null());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }

        let output = match command.output() {
            Ok(output) => output,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("无法启动 yt-dlp：{error}")),
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = stderr.trim();
            if detail.contains("Sign in to confirm") || detail.contains("not a bot") {
                return Err(
                    "YouTube 要求先完成人工验证；Seamind 不会读取浏览器 Cookie。请改用官方内嵌播放器或在 YouTube 打开。"
                        .to_string(),
                );
            }
            if detail.contains("No video formats found") || detail.contains("Requested format") {
                return Ok(PlaybackResolution::Mpv {
                    provider: "yt-dlp".to_string(),
                    media_type: MediaType::Unsupported,
                    media_url: None,
                    audio_url: None,
                    reason: "yt-dlp 没有提供可供 WebView 使用的直连媒体流；交由 mpv 重新解析 YouTube 视频。"
                        .to_string(),
                });
            }
            return Err(format!(
                "yt-dlp 无法解析该视频：{}",
                truncate_message(detail, 360)
            ));
        }

        let info: YtDlpInfo = serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("无法读取 yt-dlp 媒体信息：{error}"))?;
        return Ok(playback_resolution_from_info(info));
    }

    if let Some(path) = std::env::var_os("SEAMIND_YT_DLP_PATH") {
        return Err(format!(
            "SEAMIND_YT_DLP_PATH 指向的程序无法启动：{}",
            std::path::PathBuf::from(path).display()
        ));
    }

    Err(
        "未找到 yt-dlp。请安装 yt-dlp 并加入系统 PATH，或设置 SEAMIND_YT_DLP_PATH 指向可执行文件。"
            .to_string(),
    )
}

fn playback_resolution_from_info(info: YtDlpInfo) -> PlaybackResolution {
    let requested_formats = info.requested_formats.as_deref().unwrap_or_default();
    if requested_formats.len() > 1 {
        let requested_protocols = requested_formats
            .iter()
            .filter_map(|format| format.protocol.as_deref())
            .map(str::to_ascii_lowercase)
            .collect::<Vec<_>>();
        let media_type = if requested_protocols
            .iter()
            .any(|protocol| protocol.contains("m3u8") || protocol.contains("hls"))
        {
            MediaType::Hls
        } else if requested_protocols
            .iter()
            .any(|protocol| protocol.contains("dash") || protocol.contains("mpd"))
        {
            MediaType::Dash
        } else {
            MediaType::SeparateStreams
        };
        return PlaybackResolution::Mpv {
            provider: "yt-dlp".to_string(),
            media_type,
            media_url: None,
            audio_url: None,
            reason: match media_type {
                MediaType::Hls => "检测到由多个片段组成的 HLS 流，交由 mpv 处理。",
                MediaType::Dash => "检测到分离的 DASH 流，交由 mpv 管理音视频片段。",
                _ => "视频与音频由独立流组成，交由 mpv 合并播放。",
            }
            .to_string(),
        };
    }

    let format = requested_formats.first().unwrap_or(&info.format);
    let protocol = format
        .protocol
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let media_type = if protocol.contains("m3u8") || protocol.contains("hls") {
        MediaType::Hls
    } else if protocol.contains("dash") || protocol.contains("mpd") {
        MediaType::Dash
    } else if format.vcodec.as_deref() == Some("none") || format.acodec.as_deref() == Some("none") {
        MediaType::SeparateStreams
    } else {
        MediaType::Unsupported
    };

    if !matches!(media_type, MediaType::Unsupported) {
        return PlaybackResolution::Mpv {
            provider: "yt-dlp".to_string(),
            media_type,
            media_url: None,
            audio_url: None,
            reason: match media_type {
                MediaType::Hls => "检测到 HLS 流，交由 mpv 处理播放列表和缓冲。",
                MediaType::Dash => "检测到 DASH 流，交由 mpv 管理分段媒体。",
                MediaType::SeparateStreams => "视频和音频需要分别处理，交由 mpv 管理媒体流。",
                _ => "当前媒体类型交由 mpv 播放。",
            }
            .to_string(),
        };
    }

    let is_browser_mp4 = format.ext.as_deref() == Some("mp4")
        && protocol == "https"
        && format
            .vcodec
            .as_deref()
            .is_some_and(|codec| codec.starts_with("avc1"))
        && format
            .acodec
            .as_deref()
            .is_some_and(|codec| codec.starts_with("mp4a"));
    if is_browser_mp4 {
        if let Some(url) = format
            .url
            .as_deref()
            .filter(|url| is_allowed_media_url(url))
        {
            return PlaybackResolution::Html5 {
                provider: "yt-dlp".to_string(),
                media_type: MediaType::ProgressiveMp4,
                url: url.to_string(),
                mime_type: "video/mp4".to_string(),
            };
        }
    }

    PlaybackResolution::Mpv {
        provider: "yt-dlp".to_string(),
        media_type: MediaType::Unsupported,
        media_url: None,
        audio_url: None,
        reason: "该格式不满足内嵌 WebView 的 MP4/H.264/AAC 条件，交由 mpv 处理。".to_string(),
    }
}

fn extractor_candidates() -> Vec<(std::ffi::OsString, Vec<std::ffi::OsString>)> {
    if let Some(path) = std::env::var_os("SEAMIND_YT_DLP_PATH") {
        return vec![(path.into(), Vec::new())];
    }

    vec![
        ("yt-dlp".into(), Vec::new()),
        ("yt-dlp.exe".into(), Vec::new()),
    ]
}

fn is_allowed_media_url(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && (host == "googlevideo.com" || host.ends_with(".googlevideo.com"))
}

fn truncate_message(message: &str, max_chars: usize) -> String {
    let cleaned = message
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let mut chars = cleaned.chars();
    let shortened = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{shortened}…")
    } else {
        shortened
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_allowed_media_url, is_valid_video_id, parse_newpipe_bridge_response,
        playback_resolution_from_info, MediaType, PlaybackResolution, YtDlpInfo,
    };

    fn resolution_from_json(json: &str) -> PlaybackResolution {
        let info: YtDlpInfo = serde_json::from_str(json).expect("valid yt-dlp fixture");
        playback_resolution_from_info(info)
    }

    #[test]
    fn accepts_only_youtube_video_ids() {
        assert!(is_valid_video_id("aqz-KE-bpKQ"));
        assert!(!is_valid_video_id("short"));
        assert!(!is_valid_video_id("aqz-KE-bpKQ/other"));
    }

    #[test]
    fn allows_only_https_googlevideo_media_urls() {
        assert!(is_allowed_media_url(
            "https://rr1---sn.googlevideo.com/videoplayback?token=secret"
        ));
        assert!(!is_allowed_media_url(
            "http://rr1---sn.googlevideo.com/videoplayback"
        ));
        assert!(!is_allowed_media_url("https://example.com/video.mp4"));
        assert!(!is_allowed_media_url("https://notgooglevideo.com/video"));
        assert!(!is_allowed_media_url(
            "https://user@rr1---sn.googlevideo.com/videoplayback"
        ));
        assert!(!is_allowed_media_url(
            "https://rr1---sn.googlevideo.com:8443/videoplayback"
        ));
    }

    #[test]
    fn selects_html5_only_for_allowed_progressive_mp4() {
        let result = resolution_from_json(
            r#"{"url":"https://rr1---sn.googlevideo.com/videoplayback?token=secret","ext":"mp4","protocol":"https","vcodec":"avc1.640028","acodec":"mp4a.40.2"}"#,
        );
        assert!(matches!(
            result,
            PlaybackResolution::Html5 {
                media_type: MediaType::ProgressiveMp4,
                ..
            }
        ));

        let rejected = resolution_from_json(
            r#"{"url":"https://example.com/video.mp4","ext":"mp4","protocol":"https","vcodec":"avc1.640028","acodec":"mp4a.40.2"}"#,
        );
        assert!(matches!(
            rejected,
            PlaybackResolution::Mpv {
                media_type: MediaType::Unsupported,
                ..
            }
        ));
    }

    #[test]
    fn routes_hls_dash_and_separate_streams_to_mpv() {
        let hls = resolution_from_json(
            r#"{"url":"https://rr1---sn.googlevideo.com/playlist.m3u8","ext":"mp4","protocol":"m3u8_native","vcodec":"avc1.640028","acodec":"mp4a.40.2"}"#,
        );
        assert!(matches!(
            hls,
            PlaybackResolution::Mpv {
                media_type: MediaType::Hls,
                ..
            }
        ));

        let dash = resolution_from_json(
            r#"{"url":"https://rr1---sn.googlevideo.com/manifest.mpd","ext":"mp4","protocol":"http_dash_segments","vcodec":"avc1.640028","acodec":"mp4a.40.2"}"#,
        );
        assert!(matches!(
            dash,
            PlaybackResolution::Mpv {
                media_type: MediaType::Dash,
                ..
            }
        ));

        let separate = resolution_from_json(
            r#"{"requested_formats":[{"url":"https://rr1---sn.googlevideo.com/video","protocol":"https","vcodec":"avc1.640028","acodec":"none"},{"url":"https://rr1---sn.googlevideo.com/audio","protocol":"https","vcodec":"none","acodec":"opus"}]}"#,
        );
        assert!(matches!(
            separate,
            PlaybackResolution::Mpv {
                media_type: MediaType::SeparateStreams,
                ..
            }
        ));
    }

    #[test]
    fn accepts_only_allowlisted_newpipe_bridge_urls() {
        let result = parse_newpipe_bridge_response(
            br#"{"backend":"html5","provider":"newpipe","mediaType":"progressiveMp4","url":"https://rr1---sn.googlevideo.com/videoplayback?token=secret","mimeType":"video/mp4"}"#,
        )
        .expect("allowlisted NewPipe response");
        assert!(matches!(result, PlaybackResolution::Html5 { .. }));

        let rejected = parse_newpipe_bridge_response(
            br#"{"backend":"html5","provider":"newpipe","mediaType":"progressiveMp4","url":"https://example.com/video.mp4","mimeType":"video/mp4"}"#,
        );
        assert!(rejected.is_err());

        let hls = parse_newpipe_bridge_response(
            br#"{"backend":"mpv","provider":"newpipe","mediaType":"hls","mediaUrl":"https://manifest.googlevideo.com/api/manifest/hls_variant/playlist.m3u8?token=secret","reason":"HLS"}"#,
        )
        .expect("allowlisted HLS response");
        assert!(matches!(
            hls,
            PlaybackResolution::Mpv {
                media_type: MediaType::Hls,
                media_url: Some(_),
                ..
            }
        ));

        let rejected_hls = parse_newpipe_bridge_response(
            br#"{"backend":"mpv","provider":"newpipe","mediaType":"hls","mediaUrl":"https://example.com/playlist.m3u8","reason":"HLS"}"#,
        );
        assert!(rejected_hls.is_err());
    }
}
