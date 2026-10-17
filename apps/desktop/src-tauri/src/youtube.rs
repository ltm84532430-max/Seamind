use std::process::Command;
use url::Url;

const VIDEO_ID_LENGTH: usize = 11;
const EXTRACTOR_TIMEOUT_SECONDS: &str = "15";

#[tauri::command]
pub async fn youtube_local_playback_source(video_id: String) -> Result<String, String> {
    if !is_valid_video_id(&video_id) {
        return Err("无效的 YouTube 视频编号。".to_string());
    }

    tokio::task::spawn_blocking(move || extract_progressive_mp4_url(&video_id))
        .await
        .map_err(|error| format!("本地视频解析任务失败：{error}"))?
}

#[tauri::command]
pub async fn youtube_open_with_mpv(video_id: String, start_seconds: u64) -> Result<(), String> {
    if !is_valid_video_id(&video_id) {
        return Err("无效的 YouTube 视频编号。".to_string());
    }

    tokio::task::spawn_blocking(move || launch_mpv(&video_id, start_seconds))
        .await
        .map_err(|error| format!("外部播放器启动任务失败：{error}"))?
}

fn is_valid_video_id(video_id: &str) -> bool {
    video_id.len() == VIDEO_ID_LENGTH
        && video_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn launch_mpv(video_id: &str, start_seconds: u64) -> Result<(), String> {
    if !is_extractor_available() {
        return Err(
            "外部播放器需要已安装的 yt-dlp。请安装后加入系统 PATH，或设置 SEAMIND_YT_DLP_PATH。"
                .to_string(),
        );
    }

    let player = std::env::var_os("SEAMIND_MPV_PATH").unwrap_or_else(|| "mpv".into());
    let video_url = format!("https://www.youtube.com/watch?v={video_id}");
    let mut command = Command::new(player);
    command
        .arg("--force-window=immediate")
        .arg("--ytdl=yes")
        .arg("--ytdl-format=best")
        .arg("--no-terminal");
    if start_seconds > 0 {
        command.arg(format!("--start={start_seconds}"));
    }
    if let Some(extractor_path) = std::env::var_os("SEAMIND_YT_DLP_PATH") {
        command.arg(format!(
            "--script-opts=ytdl_hook-ytdl_path={}",
            std::path::PathBuf::from(extractor_path).display()
        ));
    }
    command
        .arg("--")
        .arg(video_url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    command.spawn().map(|_| ()).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "未找到 mpv。请安装 mpv 并加入系统 PATH，或设置 SEAMIND_MPV_PATH。".to_string()
        } else {
            format!("无法启动 mpv：{error}")
        }
    })
}

fn is_extractor_available() -> bool {
    extractor_candidates()
        .into_iter()
        .any(|(program, prefix_args)| {
            Command::new(program)
                .args(prefix_args)
                .arg("--version")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
        })
}

fn extract_progressive_mp4_url(video_id: &str) -> Result<String, String> {
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
                "best[ext=mp4][vcodec^=avc1][acodec^=mp4a][protocol=https]",
                "--get-url",
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
                return Err(
                    "该视频没有可供网页直接播放的 HTTPS H.264/AAC MP4 流。请使用 YouTube 内嵌播放器。"
                        .to_string(),
                );
            }
            return Err(format!(
                "yt-dlp 无法解析该视频：{}",
                truncate_message(detail, 360)
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut urls = stdout
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty());
        let Some(stream_url) = urls.next() else {
            return Err("yt-dlp 没有返回可播放的视频地址。".to_string());
        };
        if urls.next().is_some() {
            return Err(
                "yt-dlp 返回了多个媒体地址；当前网页播放器只接受单文件 MP4 流。".to_string(),
            );
        }

        if !is_allowed_media_url(stream_url) {
            return Err("yt-dlp 返回的媒体地址不在允许的 YouTube 视频域名内。".to_string());
        }
        return Ok(stream_url.to_string());
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
    use super::{is_allowed_media_url, is_valid_video_id};

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
}
