use crate::media_resolver::{
    MediaProvider, MediaResolveRequest, MediaResolver, MediaType, PlaybackResolution,
};
use crate::youtube_net::{seamind_data_dir, YouTubeNet};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::State;
use url::Url;

const VIDEO_ID_LENGTH: usize = 11;
const EXTRACTOR_TIMEOUT_SECONDS: &str = "15";
const YT_DLP_TIMEOUT: Duration = Duration::from_secs(60);
const NEWPIPE_TIMEOUT: Duration = Duration::from_secs(120);
const CAPABILITY_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const EXTRACTOR_PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const RESOLUTION_MAX_AGE: Duration = Duration::from_secs(2 * 60 * 60);
const RESOLUTION_EXPIRY_MARGIN: u64 = 5 * 60;
const RESOLUTION_UNKNOWN_EXPIRY_AGE: Duration = Duration::from_secs(10 * 60);
const MAX_CACHED_RESOLUTIONS: usize = 32;

#[derive(Default)]
struct JobControl {
    cancelled: AtomicBool,
}

impl JobControl {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
}

struct CachedResolution {
    resolution: PlaybackResolution,
    expires_at: Instant,
}

#[derive(Default)]
struct JobsInner {
    active: Mutex<HashMap<String, Arc<JobControl>>>,
    resolutions: Mutex<HashMap<String, CachedResolution>>,
}

/// Remembers which resolver processes a request started, so closing the player can stop them, and
/// keeps resolved media addresses until they expire, so a second action on the same video does not
/// pay for another resolution.
#[derive(Clone, Default)]
pub struct YouTubeJobs(Arc<JobsInner>);

struct JobGuard {
    jobs: YouTubeJobs,
    request_id: Option<String>,
    control: Arc<JobControl>,
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        let Some(request_id) = &self.request_id else {
            return;
        };
        if let Ok(mut active) = self.jobs.0.active.lock() {
            if active
                .get(request_id)
                .is_some_and(|current| Arc::ptr_eq(current, &self.control))
            {
                active.remove(request_id);
            }
        }
    }
}

fn is_valid_request_id(request_id: &str) -> bool {
    !request_id.is_empty()
        && request_id.len() <= 64
        && request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

impl YouTubeJobs {
    fn begin(&self, request_id: Option<String>) -> Result<JobGuard, String> {
        if request_id.as_deref().is_some_and(|id| !is_valid_request_id(id)) {
            return Err("无效的请求编号。".to_string());
        }
        let control = Arc::new(JobControl::default());
        if let Some(request_id) = &request_id {
            let mut active = self.0.active.lock().map_err(|_| "任务状态不可用。".to_string())?;
            if let Some(previous) = active.insert(request_id.clone(), control.clone()) {
                previous.cancel();
            }
        }
        Ok(JobGuard {
            jobs: self.clone(),
            request_id,
            control,
        })
    }

    fn cancel(&self, request_id: &str) {
        if let Ok(active) = self.0.active.lock() {
            if let Some(control) = active.get(request_id) {
                control.cancel();
            }
        }
    }

    fn cached_resolution(&self, video_id: &str) -> Option<PlaybackResolution> {
        let mut cache = self.0.resolutions.lock().ok()?;
        match cache.get(video_id) {
            Some(entry) if entry.expires_at > Instant::now() => Some(entry.resolution.clone()),
            Some(_) => {
                cache.remove(video_id);
                None
            }
            None => None,
        }
    }

    fn store_resolution(&self, video_id: &str, resolution: &PlaybackResolution) {
        let ttl = resolution_ttl(resolution, unix_now());
        let Some(ttl) = ttl else {
            return;
        };
        let Ok(mut cache) = self.0.resolutions.lock() else {
            return;
        };
        let now = Instant::now();
        cache.retain(|_, entry| entry.expires_at > now);
        if cache.len() >= MAX_CACHED_RESOLUTIONS {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, entry)| entry.expires_at)
                .map(|(key, _)| key.clone())
            {
                cache.remove(&oldest);
            }
        }
        cache.insert(
            video_id.to_string(),
            CachedResolution {
                resolution: resolution.clone(),
                expires_at: now + ttl,
            },
        );
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// googlevideo addresses carry their own deadline, either as `?expire=` or as an `/expire/<ts>/`
/// path segment in manifest URLs.
fn media_expiry_unix(value: &str) -> Option<u64> {
    let url = Url::parse(value).ok()?;
    if let Some((_, expire)) = url.query_pairs().find(|(key, _)| key == "expire") {
        return expire.parse().ok();
    }
    let mut segments = url.path_segments()?;
    while let Some(segment) = segments.next() {
        if segment == "expire" {
            return segments.next()?.parse().ok();
        }
    }
    None
}

fn resolution_ttl(resolution: &PlaybackResolution, now_unix: u64) -> Option<Duration> {
    let urls: Vec<&str> = match resolution {
        PlaybackResolution::Html5 { url, .. } => vec![url.as_str()],
        PlaybackResolution::Mpv {
            media_url,
            audio_url,
            ..
        } => media_url
            .iter()
            .chain(audio_url.iter())
            .map(String::as_str)
            .collect(),
    };
    if urls.is_empty() {
        return None;
    }
    let earliest = urls.iter().filter_map(|url| media_expiry_unix(url)).min();
    match earliest {
        Some(expiry) => {
            let remaining = expiry.checked_sub(now_unix + RESOLUTION_EXPIRY_MARGIN)?;
            (remaining > 0).then(|| Duration::from_secs(remaining).min(RESOLUTION_MAX_AGE))
        }
        None => Some(RESOLUTION_UNKNOWN_EXPIRY_AGE),
    }
}

#[cfg(windows)]
mod process_job {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// A Windows job object that owns a resolver process and everything it spawns (yt-dlp starts
    /// Node, the NewPipe bridge starts Gradle and Java). Dropping it kills whatever is left.
    pub struct ProcessJob(HANDLE);

    impl ProcessJob {
        pub fn attach(child: &std::process::Child) -> Option<Self> {
            // SAFETY: plain Win32 calls on a handle created here and a process handle owned by `child`.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let configured = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if configured == 0 || AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0 {
                    CloseHandle(job);
                    return None;
                }
                Some(Self(job))
            }
        }

        pub fn terminate(&self) {
            // SAFETY: `self.0` is a valid job handle until drop.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for ProcessJob {
        fn drop(&mut self) {
            // SAFETY: closing the handle we created; KILL_ON_JOB_CLOSE ends any leftover process.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(not(windows))]
mod process_job {
    pub struct ProcessJob;

    impl ProcessJob {
        pub fn attach(_child: &std::process::Child) -> Option<Self> {
            None
        }

        pub fn terminate(&self) {}
    }
}

fn kill_process_tree(child: &mut std::process::Child, job: Option<&process_job::ProcessJob>) {
    if let Some(job) = job {
        job.terminate();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubePlaybackCapabilities {
    extractor: Option<String>,
    extractor_managed: bool,
    /// Every extractor that exists was too slow to answer, which is not the same as "not installed".
    extractor_timed_out: bool,
    ejs_available: Option<bool>,
    newpipe_bridge_configured: bool,
    node_available: bool,
    mpv_available: bool,
    ffplay_available: bool,
    ffmpeg_available: bool,
    proxy_url: Option<String>,
}

#[tauri::command]
pub async fn youtube_playback_capabilities(
    net: State<'_, YouTubeNet>,
) -> Result<YouTubePlaybackCapabilities, String> {
    let proxy_url = net.proxy_url();
    tokio::task::spawn_blocking(move || {
        thread::scope(|scope| {
            let extractor = scope.spawn(extractor_summary);
            let node = scope.spawn(|| executable_available("node", "--version"));
            let mpv = scope.spawn(|| {
                std::env::var_os("SEAMIND_MPV_PATH")
                    .as_deref()
                    .map(|path| executable_available(path, "--version"))
                    .unwrap_or_else(|| executable_available("mpv", "--version"))
            });
            let ffplay = scope.spawn(|| executable_available("ffplay", "-version"));
            let ffmpeg = scope.spawn(|| executable_available("ffmpeg", "-version"));
            let extractor = extractor.join().unwrap_or_default();
            YouTubePlaybackCapabilities {
                extractor: extractor.label,
                extractor_managed: extractor.managed,
                extractor_timed_out: extractor.timed_out,
                ejs_available: extractor.ejs_available,
                newpipe_bridge_configured: newpipe_bridge_program().is_some(),
                node_available: node.join().unwrap_or(false),
                mpv_available: mpv.join().unwrap_or(false),
                ffplay_available: ffplay.join().unwrap_or(false),
                ffmpeg_available: ffmpeg.join().unwrap_or(false),
                proxy_url,
            }
        })
    })
    .await
    .map_err(|error| format!("读取播放器环境失败：{error}"))
}

#[derive(Default)]
struct ExtractorProbe {
    label: Option<String>,
    managed: bool,
    ejs_available: Option<bool>,
    timed_out: bool,
}

/// The first extractor that answers `--version`, whether it is the copy Seamind installed, and — for
/// a source checkout — whether the JavaScript challenge solver package is importable. A cold Python
/// start can take several seconds, so a slow answer is reported as such instead of as "not found".
fn extractor_summary() -> ExtractorProbe {
    let mut timed_out = false;
    for (program, prefix_args) in extractor_candidates() {
        let mut command = Command::new(&program);
        command.args(prefix_args).arg("--version");
        let version = match run_hidden(command, EXTRACTOR_PROBE_TIMEOUT) {
            Ok(version) if !version.is_empty() => version,
            Err(HiddenRunError::TimedOut) => {
                timed_out = true;
                continue;
            }
            _ => continue,
        };
        let source_checkout = program == std::ffi::OsStr::new("py");
        let ejs_available = source_checkout.then(|| {
            let mut check = Command::new("py");
            check.args(["-c", "import importlib.util,sys;sys.exit(0 if importlib.util.find_spec('yt_dlp_ejs') else 1)"]);
            run_hidden(check, EXTRACTOR_PROBE_TIMEOUT).is_ok()
        });
        let managed = seamind_data_dir()
            .map(|dir| dir.join("tools"))
            .is_some_and(|tools| std::path::Path::new(&program).starts_with(tools));
        let label = if source_checkout {
            format!("yt-dlp {version}（桌面源码）")
        } else {
            format!("yt-dlp {version}")
        };
        return ExtractorProbe {
            label: Some(label),
            managed,
            ejs_available,
            timed_out: false,
        };
    }
    ExtractorProbe {
        timed_out,
        ..ExtractorProbe::default()
    }
}

fn executable_available(program: impl AsRef<std::ffi::OsStr>, version_arg: &str) -> bool {
    let mut command = Command::new(program);
    command.arg(version_arg);
    run_hidden_with_timeout(command, CAPABILITY_PROBE_TIMEOUT).is_ok()
}

fn hide_command_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = command;
}

enum HiddenRunError {
    TimedOut,
    Failed(String),
}

fn run_hidden(mut command: Command, timeout: Duration) -> Result<String, HiddenRunError> {
    hide_command_window(&mut command);
    command.stdin(Stdio::null());
    let output = run_command_bounded(command, timeout, None).map_err(|error| {
        if error.kind() == std::io::ErrorKind::TimedOut {
            HiddenRunError::TimedOut
        } else {
            HiddenRunError::Failed(format!("无法运行外部程序：{error}"))
        }
    })?;
    if !output.status.success() {
        return Err(HiddenRunError::Failed(format!("外部程序退出码：{}", output.status)));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Runs a short helper without a console window and returns its trimmed standard output. A process
/// that does not finish in time is killed together with its children.
pub fn run_hidden_with_timeout(command: Command, timeout: Duration) -> Result<String, String> {
    run_hidden(command, timeout).map_err(|error| match error {
        HiddenRunError::TimedOut => format!("外部程序超过 {} 秒仍未结束，已终止。", timeout.as_secs()),
        HiddenRunError::Failed(message) => message,
    })
}

#[tauri::command]
pub fn youtube_cancel(jobs: State<'_, YouTubeJobs>, request_id: String) {
    jobs.cancel(&request_id);
}

#[tauri::command]
pub async fn youtube_resolve_playback(
    jobs: State<'_, YouTubeJobs>,
    net: State<'_, YouTubeNet>,
    video_id: String,
    request_id: Option<String>,
) -> Result<PlaybackResolution, String> {
    if !is_valid_video_id(&video_id) {
        return Err("无效的 YouTube 视频编号。".to_string());
    }

    let jobs = jobs.inner().clone();
    let proxy = net.proxy_url();
    tokio::task::spawn_blocking(move || {
        if let Some(cached) = jobs.cached_resolution(&video_id) {
            return Ok(cached);
        }
        let guard = jobs.begin(request_id)?;
        let request = MediaResolveRequest::youtube(video_id.clone());
        let resolution = YtDlpMediaResolver {
            control: guard.control.clone(),
            proxy,
        }
        .resolve(&request)?;
        jobs.store_resolution(&video_id, &resolution);
        Ok(resolution)
    })
    .await
    .map_err(|error| format!("本地视频解析任务失败：{error}"))?
}

#[tauri::command]
pub async fn youtube_resolve_playback_with_browser(
    jobs: State<'_, YouTubeJobs>,
    net: State<'_, YouTubeNet>,
    video_id: String,
    browser: String,
    request_id: Option<String>,
) -> Result<PlaybackResolution, String> {
    if !is_valid_video_id(&video_id) {
        return Err("无效的 YouTube 视频编号。".to_string());
    }
    if !matches!(browser.as_str(), "edge" | "chrome" | "firefox") {
        return Err("只支持 Edge、Chrome 或 Firefox 浏览器会话。".to_string());
    }
    let jobs = jobs.inner().clone();
    let proxy = net.proxy_url();
    tokio::task::spawn_blocking(move || {
        let guard = jobs.begin(request_id)?;
        let resolution = resolve_youtube_playback_with_yt_dlp(
            &video_id,
            Some(&browser),
            &guard.control,
            proxy.as_deref(),
        )?;
        jobs.store_resolution(&video_id, &resolution);
        Ok(resolution)
    })
    .await
    .map_err(|error| format!("浏览器会话解析任务失败：{error}"))?
}

struct YtDlpMediaResolver {
    control: Arc<JobControl>,
    proxy: Option<String>,
}

impl MediaResolver for YtDlpMediaResolver {
    fn resolve(&self, request: &MediaResolveRequest) -> Result<PlaybackResolution, String> {
        if request.provider != MediaProvider::YouTube {
            return Err("yt-dlp YouTube 解析器收到不支持的媒体来源。".to_string());
        }
        resolve_youtube_playback(&request.video_id, &self.control, self.proxy.as_deref())
    }
}

#[tauri::command]
pub async fn youtube_open_with_mpv(
    jobs: State<'_, YouTubeJobs>,
    net: State<'_, YouTubeNet>,
    video_id: String,
    start_seconds: u64,
    request_id: Option<String>,
) -> Result<(), String> {
    if !is_valid_video_id(&video_id) {
        return Err("无效的 YouTube 视频编号。".to_string());
    }

    let jobs = jobs.inner().clone();
    let proxy = net.proxy_url();
    tokio::task::spawn_blocking(move || {
        let resolution = match jobs.cached_resolution(&video_id) {
            Some(cached) => cached,
            None => {
                let guard = jobs.begin(request_id)?;
                let resolution =
                    resolve_youtube_playback(&video_id, &guard.control, proxy.as_deref())?;
                jobs.store_resolution(&video_id, &resolution);
                resolution
            }
        };
        launch_resolved_media_with_mpv(resolution, start_seconds, proxy.as_deref())
    })
    .await
    .map_err(|error| format!("外部播放器启动任务失败：{error}"))?
}

#[tauri::command]
pub async fn youtube_open_media_with_mpv(
    net: State<'_, YouTubeNet>,
    media_url: String,
    audio_url: Option<String>,
    user_agent: Option<String>,
    referer: Option<String>,
    start_seconds: u64,
) -> Result<(), String> {
    if !is_allowed_media_url(&media_url)
        || audio_url
            .as_deref()
            .is_some_and(|url| !is_allowed_media_url(url))
    {
        return Err("解析器返回的媒体地址不在允许的 YouTube 视频域名内。".to_string());
    }
    validate_playback_headers(user_agent.as_deref(), referer.as_deref())?;

    let proxy = net.proxy_url();
    tokio::task::spawn_blocking(move || {
        launch_mpv_media(
            &media_url,
            audio_url.as_deref(),
            user_agent.as_deref(),
            referer.as_deref(),
            start_seconds,
            proxy.as_deref(),
        )
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
    proxy: Option<&str>,
) -> Result<(), String> {
    let (media_url, audio_url, user_agent, referer) = match resolution {
        PlaybackResolution::Html5 { url, .. } => (url, None, None, None),
        PlaybackResolution::Mpv {
            media_url: Some(media_url),
            audio_url,
            user_agent,
            referer,
            ..
        } => (media_url, audio_url, user_agent, referer),
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

    launch_mpv_media(&media_url, audio_url.as_deref(), user_agent.as_deref(), referer.as_deref(), start_seconds, proxy)
}

/// mpv and FFmpeg read their HTTP proxy from the environment, and neither can use a SOCKS proxy.
fn apply_player_proxy_env(command: &mut Command, proxy: Option<&str>) {
    if let Some(proxy) = proxy.filter(|proxy| proxy.starts_with("http://") || proxy.starts_with("https://")) {
        command.env("http_proxy", proxy).env("https_proxy", proxy);
    }
}

fn launch_mpv_media(
    media_url: &str,
    audio_url: Option<&str>,
    user_agent: Option<&str>,
    referer: Option<&str>,
    start_seconds: u64,
    proxy: Option<&str>,
) -> Result<(), String> {
    validate_playback_headers(user_agent, referer)?;
    let player = std::env::var_os("SEAMIND_MPV_PATH").unwrap_or_else(|| "mpv".into());
    match spawn_mpv_media(&player, media_url, audio_url, user_agent, referer, start_seconds, proxy) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && audio_url.is_none() => {
            launch_ffplay_media(media_url, user_agent, referer, start_seconds, proxy).map_err(|ffplay_error| {
                if ffplay_error.kind() == std::io::ErrorKind::NotFound {
                    "未找到 mpv 或 ffplay。请安装其中一个播放器，或设置 SEAMIND_MPV_PATH。"
                        .to_string()
                } else {
                    format!("无法启动 mpv 或 ffplay：{ffplay_error}")
                }
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            launch_split_media_with_ffmpeg(
                media_url,
                audio_url.expect("audio URL in split-stream branch"),
                user_agent,
                referer,
                start_seconds,
                proxy,
            )
            .map_err(|ffmpeg_error| {
                if ffmpeg_error.kind() == std::io::ErrorKind::NotFound {
                    "分离音视频流需要 mpv，或同时安装 ffmpeg 和 ffplay。".to_string()
                } else {
                    format!("无法使用 ffmpeg 和 ffplay 播放分离音视频：{ffmpeg_error}")
                }
            })
        }
        Err(error) => Err(format!("无法启动 mpv：{error}")),
    }
}

fn spawn_mpv_media(
    player: &std::ffi::OsStr,
    media_url: &str,
    audio_url: Option<&str>,
    user_agent: Option<&str>,
    referer: Option<&str>,
    start_seconds: u64,
    proxy: Option<&str>,
) -> std::io::Result<()> {
    let mut command = Command::new(player);
    apply_player_proxy_env(&mut command, proxy);
    command
        .arg("--force-window=immediate")
        .arg("--ytdl=no")
        .arg("--no-terminal");
    if let Some(user_agent) = user_agent {
        command.arg(format!("--user-agent={user_agent}"));
    }
    if let Some(referer) = referer {
        command.arg(format!("--referrer={referer}"));
    }
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

fn launch_ffplay_media(
    media_url: &str,
    user_agent: Option<&str>,
    referer: Option<&str>,
    start_seconds: u64,
    proxy: Option<&str>,
) -> std::io::Result<()> {
    let mut command = Command::new("ffplay");
    apply_player_proxy_env(&mut command, proxy);
    command.arg("-hide_banner").arg("-loglevel").arg("error");
    if let Some(user_agent) = user_agent {
        command.arg("-user_agent").arg(user_agent);
    }
    if let Some(referer) = referer {
        command.arg("-referer").arg(referer);
    }
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

fn launch_split_media_with_ffmpeg(
    video_url: &str,
    audio_url: &str,
    user_agent: Option<&str>,
    referer: Option<&str>,
    start_seconds: u64,
    proxy: Option<&str>,
) -> std::io::Result<()> {
    let mut ffmpeg = Command::new("ffmpeg");
    apply_player_proxy_env(&mut ffmpeg, proxy);
    ffmpeg.arg("-hide_banner").arg("-loglevel").arg("error");
    for url in [video_url, audio_url] {
        if let Some(user_agent) = user_agent {
            ffmpeg.arg("-user_agent").arg(user_agent);
        }
        if let Some(referer) = referer {
            ffmpeg.arg("-referer").arg(referer);
        }
        if start_seconds > 0 {
            ffmpeg.arg("-ss").arg(start_seconds.to_string());
        }
        ffmpeg.arg("-i").arg(url);
    }
    ffmpeg
        .args(["-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-f", "matroska", "pipe:1"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        ffmpeg.creation_flags(0x0800_0000);
    }
    let mut ffmpeg_child = ffmpeg.spawn()?;
    let stream = ffmpeg_child.stdout.take().expect("piped ffmpeg stdout");
    let mut ffplay = Command::new("ffplay");
    apply_player_proxy_env(&mut ffplay, proxy);
    ffplay
        .args(["-hide_banner", "-loglevel", "error", "-autoexit", "-i", "pipe:0"])
        .stdin(Stdio::from(stream))
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Err(error) = ffplay.spawn() {
        let _ = ffmpeg_child.kill();
        let _ = ffmpeg_child.wait();
        return Err(error);
    }
    Ok(())
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
    #[serde(default)]
    manifest_url: Option<String>,
    #[serde(default)]
    http_headers: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Deserialize)]
struct YtDlpInfo {
    #[serde(flatten)]
    format: YtDlpFormat,
    #[serde(default)]
    requested_formats: Option<Vec<YtDlpFormat>>,
}

const CANCELLED_MESSAGE: &str = "已取消解析。";

fn resolve_youtube_playback(
    video_id: &str,
    control: &JobControl,
    proxy: Option<&str>,
) -> Result<PlaybackResolution, String> {
    if let Some(program) = newpipe_bridge_program() {
        return match resolve_with_newpipe_bridge(&program, video_id, control) {
            Ok(resolution) => Ok(resolution),
            Err(_) if control.is_cancelled() => Err(CANCELLED_MESSAGE.to_string()),
            Err(bridge_error) => resolve_youtube_playback_with_yt_dlp(video_id, None, control, proxy)
                .map_err(|fallback_error| {
                    format!(
                        "NewPipe 辅助进程失败：{bridge_error}；yt-dlp 后备解析也失败：{fallback_error}"
                    )
                }),
        };
    }

    resolve_youtube_playback_with_yt_dlp(video_id, None, control, proxy)
}

/// The NewPipe bridge compiles with Gradle on first use and may open a verification window, so it
/// only runs when `SEAMIND_NEWPIPE_BRIDGE` names it explicitly.
fn newpipe_bridge_program() -> Option<std::ffi::OsString> {
    std::env::var_os("SEAMIND_NEWPIPE_BRIDGE")
}

fn resolve_with_newpipe_bridge(
    program: &std::ffi::OsStr,
    video_id: &str,
    control: &JobControl,
) -> Result<PlaybackResolution, String> {
    let video_url = format!("https://www.youtube.com/watch?v={video_id}");
    let response_file = NewPipeBridgeTempFile::create()?;
    let bridge_path = std::path::Path::new(program);
    let is_powershell_script = bridge_path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("ps1"));
    let mut command = if is_powershell_script {
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

    if is_powershell_script {
        command
            .arg("-Action")
            .arg("resolve")
            .arg("-VideoUrl")
            .arg(&video_url)
            .arg("-OutputFile")
            .arg(response_file.path());
    } else {
        command
            .arg("--seamind-resolve")
            .arg(video_url)
            .arg("--output-file")
            .arg(response_file.path());
    }

    command.stdin(Stdio::null());
    hide_command_window(&mut command);

    let output = run_command_bounded(command, NEWPIPE_TIMEOUT, Some(control)).map_err(|error| {
        match error.kind() {
            std::io::ErrorKind::TimedOut => format!(
                "NewPipe 解析超过 {} 秒，已终止辅助进程及其子进程。",
                NEWPIPE_TIMEOUT.as_secs()
            ),
            std::io::ErrorKind::Interrupted => CANCELLED_MESSAGE.to_string(),
            _ => format!("无法运行 NewPipe 辅助进程：{error}"),
        }
    })?;
    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = [stdout.trim(), stderr.trim()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        return Err(truncate_message(&detail, 500));
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

/// Runs a helper to completion, killing it and everything it started when it exceeds `timeout`
/// (`TimedOut`) or when the job is cancelled (`Interrupted`). The reader threads are left to finish
/// on their own after a kill, because a straggler holding a pipe must not block the caller.
fn run_command_bounded(
    mut command: Command,
    timeout: Duration,
    control: Option<&JobControl>,
) -> std::io::Result<Output> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let job = process_job::ProcessJob::attach(&child);
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let stdout_reader = thread::spawn(move || read_all(stdout));
    let stderr_reader = thread::spawn(move || read_all(stderr));
    let deadline = Instant::now() + timeout;
    let status = loop {
        if control.is_some_and(JobControl::is_cancelled) {
            kill_process_tree(&mut child, job.as_ref());
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "cancelled"));
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                kill_process_tree(&mut child, job.as_ref());
                return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "timed out"));
            }
            Err(error) => {
                kill_process_tree(&mut child, job.as_ref());
                return Err(error);
            }
        }
    };
    // Closing the job ends any helper the process left behind, which also releases its pipes.
    drop(job);
    Ok(Output {
        status,
        stdout: stdout_reader.join().unwrap_or_default(),
        stderr: stderr_reader.join().unwrap_or_default(),
    })
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
        if media_url.is_none() {
            return Err("NewPipe 没有返回可交给播放器的媒体地址。".to_string());
        }
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

fn resolve_youtube_playback_with_yt_dlp(
    video_id: &str,
    browser: Option<&str>,
    control: &JobControl,
    proxy: Option<&str>,
) -> Result<PlaybackResolution, String> {
    let video_url = format!("https://www.youtube.com/watch?v={video_id}");
    let candidates = extractor_candidates();
    for (program, prefix_args) in candidates {
        let mut command = Command::new(&program);
        command
            .args(prefix_args)
            .args([
                "--ignore-config",
                "--no-playlist",
                "--quiet",
                "--no-progress",
                "--socket-timeout",
                EXTRACTOR_TIMEOUT_SECONDS,
                "--retries",
                "0",
                "--extractor-retries",
                "0",
                "--js-runtimes",
                "node",
                "--format",
                "best[ext=mp4][vcodec^=avc1][acodec^=mp4a][protocol=https]/bestvideo[ext=mp4][vcodec^=avc1][protocol=https]+bestaudio[ext=m4a][acodec^=mp4a][protocol=https]/bestvideo*+bestaudio/best",
                "--dump-single-json",
                "--skip-download",
            ]);
        if let Some(proxy) = proxy {
            command.arg("--proxy").arg(proxy);
        }
        if let Some(browser) = browser {
            command.arg("--cookies-from-browser").arg(browser);
        }
        command.arg(&video_url).stdin(std::process::Stdio::null());
        hide_command_window(&mut command);

        let output = match run_command_bounded(command, YT_DLP_TIMEOUT, Some(control)) {
            Ok(output) => output,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                return Err(CANCELLED_MESSAGE.to_string());
            }
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {
                return Err(format!(
                    "yt-dlp 解析超过 {} 秒，已终止进程及其子进程。",
                    YT_DLP_TIMEOUT.as_secs()
                ));
            }
            Err(error) => return Err(format!("无法启动 yt-dlp：{error}")),
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = stderr.trim();
            if detail.contains("Sign in to confirm") || detail.contains("not a bot") {
                return Err(if browser.is_some() {
                    "YouTube 仍要求真人验证。请先在所选浏览器完成验证，并确认浏览器与 Seamind 使用同一网络出口。".to_string()
                } else {
                    "YouTube 要求登录或真人验证。可以主动选择浏览器会话重试，或在 YouTube 页面打开。".to_string()
                });
            }
            if detail.contains("No video formats found") || detail.contains("Requested format") {
                return Err("yt-dlp 没有找到可播放的媒体格式。".to_string());
            }
            if browser.is_some() {
                if detail.contains("Could not copy") || detail.contains("Failed to decrypt") || detail.contains("failed to decrypt") {
                    return Err("无法读取所选浏览器的本机会话；请关闭浏览器后重试，或改用其他浏览器。".to_string());
                }
                return Err("所选浏览器会话仍无法解析此视频；请在浏览器中确认登录与真人验证状态。".to_string());
            }
            return Err(format!(
                "yt-dlp 无法解析该视频：{}",
                truncate_message(detail, 360)
            ));
        }

        let info: YtDlpInfo = serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("无法读取 yt-dlp 媒体信息：{error}"))?;
        return playback_resolution_from_info(info);
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

fn playback_resolution_from_info(info: YtDlpInfo) -> Result<PlaybackResolution, String> {
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
        let video = requested_formats
            .iter()
            .find(|format| format.vcodec.as_deref() != Some("none"))
            .ok_or_else(|| "yt-dlp 没有返回视频流。".to_string())?;
        let audio = requested_formats
            .iter()
            .find(|format| format.acodec.as_deref() != Some("none"))
            .filter(|audio| !std::ptr::eq(*audio, video));
        let media_url = playable_format_url(video)?;
        let audio_url = audio.map(playable_format_url).transpose()?;
        if video.acodec.as_deref() == Some("none") && audio_url.is_none() {
            return Err("yt-dlp 只返回了无声视频流，无法组合播放。".to_string());
        }
        return Ok(PlaybackResolution::Mpv {
            provider: "yt-dlp".to_string(),
            media_type,
            media_url: Some(media_url),
            audio_url,
            user_agent: format_header(video, "User-Agent"),
            referer: format_header(video, "Referer"),
            reason: match media_type {
                MediaType::Hls => "检测到由多个片段组成的 HLS 流，交由 mpv 处理。",
                MediaType::Dash => "检测到分离的 DASH 流，交由 mpv 管理音视频片段。",
                _ => "视频与音频由独立流组成，交由 mpv 合并播放。",
            }
            .to_string(),
        });
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
        return Ok(PlaybackResolution::Mpv {
            provider: "yt-dlp".to_string(),
            media_type,
            media_url: Some(playable_format_url(format)?),
            audio_url: None,
            user_agent: format_header(format, "User-Agent"),
            referer: format_header(format, "Referer"),
            reason: match media_type {
                MediaType::Hls => "检测到 HLS 流，交由 mpv 处理播放列表和缓冲。",
                MediaType::Dash => "检测到 DASH 流，交由 mpv 管理分段媒体。",
                MediaType::SeparateStreams => "视频和音频需要分别处理，交由 mpv 管理媒体流。",
                _ => "当前媒体类型交由 mpv 播放。",
            }
            .to_string(),
        });
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
            return Ok(PlaybackResolution::Html5 {
                provider: "yt-dlp".to_string(),
                media_type: MediaType::ProgressiveMp4,
                url: url.to_string(),
                mime_type: "video/mp4".to_string(),
            });
        }
    }

    Ok(PlaybackResolution::Mpv {
        provider: "yt-dlp".to_string(),
        media_type: MediaType::Unsupported,
        media_url: Some(playable_format_url(format)?),
        audio_url: None,
        user_agent: format_header(format, "User-Agent"),
        referer: format_header(format, "Referer"),
        reason: "该格式不满足内嵌 WebView 的 MP4/H.264/AAC 条件，交由 mpv 处理。".to_string(),
    })
}

fn format_header(format: &YtDlpFormat, name: &str) -> Option<String> {
    format.http_headers.as_ref()?.iter().find_map(|(key, value)| {
        key.eq_ignore_ascii_case(name).then(|| value.clone())
    })
}

fn validate_playback_headers(user_agent: Option<&str>, referer: Option<&str>) -> Result<(), String> {
    for value in [user_agent, referer].into_iter().flatten() {
        if value.len() > 512 || value.chars().any(char::is_control) {
            return Err("媒体请求头包含不安全的字符。".to_string());
        }
    }
    if let Some(referer) = referer {
        let url = Url::parse(referer).map_err(|_| "媒体来源地址无效。".to_string())?;
        let host = url.host_str().unwrap_or_default();
        if url.scheme() != "https" || !(host == "youtube.com" || host.ends_with(".youtube.com")) {
            return Err("媒体来源地址不在允许的 YouTube 域名内。".to_string());
        }
    }
    Ok(())
}

fn playable_format_url(format: &YtDlpFormat) -> Result<String, String> {
    let protocol = format.protocol.as_deref().unwrap_or_default().to_ascii_lowercase();
    let candidate = if protocol.contains("m3u8") || protocol.contains("hls") || protocol.contains("dash") || protocol.contains("mpd") {
        format.manifest_url.as_deref().or(format.url.as_deref())
    } else {
        format.url.as_deref()
    };
    let url = candidate.ok_or_else(|| "yt-dlp 没有返回可播放的媒体地址。".to_string())?;
    if !is_allowed_media_url(url) {
        return Err("yt-dlp 返回的媒体地址不在允许的 YouTube 视频域名内。".to_string());
    }
    Ok(url.to_string())
}

fn extractor_candidates() -> Vec<(std::ffi::OsString, Vec<std::ffi::OsString>)> {
    if let Some(path) = std::env::var_os("SEAMIND_YT_DLP_PATH") {
        return vec![(path.into(), Vec::new())];
    }

    let mut candidates = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            for path in [directory.join("tools").join("yt-dlp.exe"), directory.join("yt-dlp.exe")] {
                if path.is_file() {
                    candidates.push((path.into_os_string(), Vec::new()));
                }
            }
        }
    }
    if let Some(data_dir) = seamind_data_dir() {
        let path = data_dir.join("tools").join("yt-dlp.exe");
        if path.is_file() {
            candidates.push((path.into_os_string(), Vec::new()));
        }
    }
    #[cfg(windows)]
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let source = std::path::PathBuf::from(profile)
            .join("Desktop")
            .join("yt-dlp")
            .join("yt_dlp")
            .join("__main__.py");
        if source.is_file() {
            candidates.push(("py".into(), vec![source.into_os_string()]));
        }
    }
    candidates.extend([
        ("yt-dlp".into(), Vec::new()),
        ("yt-dlp.exe".into(), Vec::new()),
    ]);
    candidates
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
        is_allowed_media_url, is_valid_request_id, is_valid_video_id, media_expiry_unix,
        parse_newpipe_bridge_response, playback_resolution_from_info, resolution_ttl,
        run_command_bounded, JobControl, MediaType, PlaybackResolution, YouTubeJobs, YtDlpInfo,
    };
    use std::process::Command;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    fn html5_resolution(url: &str) -> PlaybackResolution {
        PlaybackResolution::Html5 {
            provider: "yt-dlp".to_string(),
            media_type: MediaType::ProgressiveMp4,
            url: url.to_string(),
            mime_type: "video/mp4".to_string(),
        }
    }

    fn resolution_from_json(json: &str) -> PlaybackResolution {
        let info: YtDlpInfo = serde_json::from_str(json).expect("valid yt-dlp fixture");
        playback_resolution_from_info(info).expect("playable yt-dlp fixture")
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

        let rejected: YtDlpInfo = serde_json::from_str(
            r#"{"url":"https://example.com/video.mp4","ext":"mp4","protocol":"https","vcodec":"avc1.640028","acodec":"mp4a.40.2"}"#,
        ).expect("valid yt-dlp fixture");
        assert!(playback_resolution_from_info(rejected).is_err());
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

    #[test]
    fn reads_media_expiry_from_query_and_manifest_paths() {
        assert_eq!(
            media_expiry_unix("https://rr1---sn-a.googlevideo.com/videoplayback?expire=1792611561&ei=x"),
            Some(1_792_611_561)
        );
        assert_eq!(
            media_expiry_unix(
                "https://manifest.googlevideo.com/api/manifest/hls_variant/expire/1792611561/ei/x/playlist.m3u8"
            ),
            Some(1_792_611_561)
        );
        assert_eq!(media_expiry_unix("https://rr1---sn-a.googlevideo.com/videoplayback"), None);
        assert_eq!(media_expiry_unix("not a url"), None);
    }

    #[test]
    fn caches_resolutions_until_shortly_before_they_expire() {
        let now = 1_000_000;
        let soon = html5_resolution(&format!("https://rr1---sn-a.googlevideo.com/videoplayback?expire={}", now + 60));
        assert_eq!(resolution_ttl(&soon, now), None, "inside the safety margin");

        let later = html5_resolution(&format!("https://rr1---sn-a.googlevideo.com/videoplayback?expire={}", now + 3_600));
        assert_eq!(resolution_ttl(&later, now), Some(Duration::from_secs(3_600 - 300)));

        let far = html5_resolution(&format!("https://rr1---sn-a.googlevideo.com/videoplayback?expire={}", now + 86_400));
        assert_eq!(resolution_ttl(&far, now), Some(Duration::from_secs(2 * 60 * 60)));

        let undated = html5_resolution("https://rr1---sn-a.googlevideo.com/videoplayback");
        assert_eq!(resolution_ttl(&undated, now), Some(Duration::from_secs(10 * 60)));

        let empty = PlaybackResolution::Mpv {
            provider: "yt-dlp".to_string(),
            media_type: MediaType::Unsupported,
            media_url: None,
            audio_url: None,
            user_agent: None,
            referer: None,
            reason: String::new(),
        };
        assert_eq!(resolution_ttl(&empty, now), None);
    }

    #[test]
    fn serves_a_cached_resolution_only_while_it_is_valid() {
        let jobs = YouTubeJobs::default();
        let future = super::unix_now() + 3_600;
        let fresh = html5_resolution(&format!("https://rr1---sn-a.googlevideo.com/videoplayback?expire={future}"));
        jobs.store_resolution("aqz-KE-bpKQ", &fresh);
        assert!(jobs.cached_resolution("aqz-KE-bpKQ").is_some());
        assert!(jobs.cached_resolution("other-video").is_none());

        let stale = html5_resolution("https://rr1---sn-a.googlevideo.com/videoplayback?expire=1");
        jobs.store_resolution("old-video-1", &stale);
        assert!(jobs.cached_resolution("old-video-1").is_none());
    }

    #[test]
    fn a_new_job_with_the_same_id_cancels_the_previous_one() {
        let jobs = YouTubeJobs::default();
        let first = jobs.begin(Some("dialog-1".to_string())).unwrap();
        assert!(!first.control.is_cancelled());
        let second = jobs.begin(Some("dialog-1".to_string())).unwrap();
        assert!(first.control.is_cancelled());
        assert!(!second.control.is_cancelled());

        jobs.cancel("dialog-1");
        assert!(second.control.is_cancelled());

        drop(first);
        assert!(
            jobs.0.active.lock().unwrap().contains_key("dialog-1"),
            "a finished older job must not unregister the newer one"
        );
        drop(second);
        assert!(jobs.0.active.lock().unwrap().is_empty());
    }

    #[test]
    fn validates_request_ids() {
        assert!(is_valid_request_id("youtube-1729-ab_C"));
        for id in ["", "has space", "../x", &"a".repeat(65)] {
            assert!(!is_valid_request_id(id), "{id:?}");
        }
        assert!(YouTubeJobs::default().begin(Some("bad id".to_string())).is_err());
    }

    #[cfg(windows)]
    fn powershell(script: &str) -> Command {
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        super::hide_command_window(&mut command);
        command
    }

    #[cfg(windows)]
    fn process_is_running(pid: u32) -> bool {
        let output = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .expect("tasklist");
        String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
    }

    #[cfg(windows)]
    fn sleeping_grandchild_script(pid_file: &std::path::Path) -> String {
        format!(
            "$p = Start-Process -FilePath ping -ArgumentList '-n','120','127.0.0.1' -WindowStyle Hidden -PassThru; Set-Content -Path '{}' -Value $p.Id; Start-Sleep 120",
            pid_file.display()
        )
    }

    #[cfg(windows)]
    fn read_pid_when_written(pid_file: &std::path::Path) -> u32 {
        let started = Instant::now();
        loop {
            if let Ok(text) = std::fs::read_to_string(pid_file) {
                if let Ok(pid) = text.trim().parse() {
                    return pid;
                }
            }
            assert!(started.elapsed() < Duration::from_secs(20), "grandchild pid was never written");
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_timeout_ends_the_whole_process_tree() {
        let pid_file = std::env::temp_dir().join(format!("seamind-tree-timeout-{}.pid", std::process::id()));
        let _ = std::fs::remove_file(&pid_file);
        let command = powershell(&sleeping_grandchild_script(&pid_file));
        let error = run_command_bounded(command, Duration::from_secs(8), None).expect_err("must time out");
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);

        let grandchild = read_pid_when_written(&pid_file);
        std::thread::sleep(Duration::from_millis(500));
        assert!(!process_is_running(grandchild), "the grandchild survived the timeout");
        let _ = std::fs::remove_file(&pid_file);
    }

    #[cfg(windows)]
    #[test]
    fn cancelling_a_job_stops_it_promptly() {
        let pid_file = std::env::temp_dir().join(format!("seamind-tree-cancel-{}.pid", std::process::id()));
        let _ = std::fs::remove_file(&pid_file);
        let control = Arc::new(JobControl::default());
        let canceller = {
            let control = control.clone();
            let pid_file = pid_file.clone();
            std::thread::spawn(move || {
                let pid = read_pid_when_written(&pid_file);
                control.cancel();
                pid
            })
        };
        let started = Instant::now();
        let command = powershell(&sleeping_grandchild_script(&pid_file));
        let error = run_command_bounded(command, Duration::from_secs(60), Some(&control)).expect_err("must be cancelled");
        assert_eq!(error.kind(), std::io::ErrorKind::Interrupted);
        assert!(started.elapsed() < Duration::from_secs(30), "took {:?}", started.elapsed());

        let grandchild = canceller.join().unwrap();
        std::thread::sleep(Duration::from_millis(500));
        assert!(!process_is_running(grandchild), "the grandchild survived cancellation");
        let _ = std::fs::remove_file(&pid_file);
    }

    #[cfg(windows)]
    #[test]
    fn leftover_helpers_are_closed_when_the_main_process_exits() {
        let pid_file = std::env::temp_dir().join(format!("seamind-tree-exit-{}.pid", std::process::id()));
        let _ = std::fs::remove_file(&pid_file);
        let script = format!(
            "$p = Start-Process -FilePath ping -ArgumentList '-n','120','127.0.0.1' -WindowStyle Hidden -PassThru; Set-Content -Path '{}' -Value $p.Id",
            pid_file.display()
        );
        let output = run_command_bounded(powershell(&script), Duration::from_secs(30), None).expect("script exits");
        assert!(output.status.success());
        let grandchild = read_pid_when_written(&pid_file);
        std::thread::sleep(Duration::from_millis(500));
        assert!(!process_is_running(grandchild), "a helper outlived its parent");
        let _ = std::fs::remove_file(&pid_file);
    }
}
