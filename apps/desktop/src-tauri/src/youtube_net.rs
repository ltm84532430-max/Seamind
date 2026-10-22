use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};
use url::Url;

const SETTINGS_FILE: &str = "youtube-settings.json";
const MAX_REDIRECTS: usize = 5;
const YT_DLP_RELEASE_BASE: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const YT_DLP_MAX_BYTES: u64 = 120 * 1024 * 1024;
const YT_DLP_SUMS_MAX_BYTES: u64 = 256 * 1024;
const DEFAULT_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

pub fn default_user_agent() -> &'static str {
    DEFAULT_USER_AGENT
}

/// Per-user directory shared by the yt-dlp lookup and the caches below.
pub fn seamind_data_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(not(windows))]
    let base = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("share"))
    });
    base.map(|base| base.join("Seamind"))
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct YouTubeSettings {
    pub proxy_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeSettingsView {
    proxy_url: Option<String>,
    /// The proxy the embedded WebView was started with; a different value needs a restart.
    webview_proxy_url: Option<String>,
}

static WEBVIEW_PROXY: OnceLock<Option<String>> = OnceLock::new();

/// Accepts `http`, `https`, `socks5` and `socks5h` proxies without credentials, because the same
/// value is handed to Chromium, reqwest, yt-dlp and mpv, which disagree about authentication.
pub fn normalize_proxy_url(value: &str) -> Result<Option<String>, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let url = Url::parse(trimmed)
        .map_err(|_| "代理地址格式无效，例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:7891。".to_string())?;
    if !matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h") {
        return Err("代理只支持 http、https、socks5 或 socks5h 协议。".to_string());
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("代理地址缺少主机名。".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("代理地址不要包含账号密码；请使用本机无需认证的代理端口。".to_string());
    }
    if !matches!(url.path(), "" | "/") || url.query().is_some() || url.fragment().is_some() {
        return Err("代理地址只需要协议、主机和端口。".to_string());
    }
    Ok(Some(url.as_str().trim_end_matches('/').to_string()))
}

fn settings_path() -> Option<PathBuf> {
    seamind_data_dir().map(|dir| dir.join(SETTINGS_FILE))
}

pub fn load_settings() -> YouTubeSettings {
    let Some(path) = settings_path() else {
        return YouTubeSettings::default();
    };
    let Ok(bytes) = std::fs::read(path) else {
        return YouTubeSettings::default();
    };
    let mut settings: YouTubeSettings = serde_json::from_slice(&bytes).unwrap_or_default();
    settings.proxy_url = settings
        .proxy_url
        .as_deref()
        .and_then(|value| normalize_proxy_url(value).ok().flatten());
    settings
}

fn save_settings(settings: &YouTubeSettings) -> Result<(), String> {
    let path = settings_path().ok_or_else(|| "无法确定 Seamind 的数据目录。".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("无法创建设置目录：{error}"))?;
    }
    let encoded = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    write_file_atomically(&path, &encoded).map_err(|error| format!("无法保存设置：{error}"))
}

pub fn write_file_atomically(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = path.with_extension(format!("tmp-{}-{nonce}", std::process::id()));
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(&temporary, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temporary);
    })
}

/// WebView2 only reads extra Chromium switches while it creates its environment, so the proxy has to
/// be in the process environment before the first window exists.
pub fn apply_webview_proxy_env() {
    let proxy = load_settings().proxy_url;
    if let Some(proxy) = &proxy {
        let flag = format!("--proxy-server={proxy}");
        let merged = match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
            Ok(existing) if !existing.trim().is_empty() => format!("{existing} {flag}"),
            _ => flag,
        };
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged);
    }
    let _ = WEBVIEW_PROXY.set(proxy);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RedirectScope {
    /// Follow redirects between the YouTube hosts the loopback proxy is allowed to reach.
    YouTube,
    /// Follow redirects between GitHub release hosts.
    GitHub,
}

fn is_github_host(host: &str) -> bool {
    host == "github.com" || host.ends_with(".github.com") || host.ends_with(".githubusercontent.com")
}

fn redirect_policy(scope: RedirectScope) -> reqwest::redirect::Policy {
    match scope {
        RedirectScope::YouTube => reqwest::redirect::Policy::custom(|attempt| {
            let allowed = attempt.previous().len() < MAX_REDIRECTS
                && crate::youtube_proxy::is_allowed_target(attempt.url());
            if allowed {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }),
        RedirectScope::GitHub => reqwest::redirect::Policy::custom(|attempt| {
            let allowed = attempt.previous().len() < MAX_REDIRECTS
                && attempt.url().scheme() == "https"
                && attempt.url().host_str().is_some_and(is_github_host);
            if allowed {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }),
    }
}

pub(crate) fn build_client(proxy: Option<&str>, scope: RedirectScope) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(DEFAULT_USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        // Behind a proxy or VPN a new connection costs about a second of TLS handshake, so keep the
        // idle ones around between a player's segment requests.
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_keepalive(Duration::from_secs(30))
        .redirect(redirect_policy(scope));
    if let Some(proxy) = proxy {
        let proxy = reqwest::Proxy::all(proxy).map_err(|_| "代理地址无效。".to_string())?;
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|error| format!("无法创建网络客户端：{error}"))
}

pub struct YouTubeNet {
    settings: RwLock<YouTubeSettings>,
    clients: Mutex<HashMap<RedirectScope, reqwest::Client>>,
    endpoint: tokio::sync::OnceCell<crate::youtube_proxy::ProxyEndpoint>,
}

impl Default for YouTubeNet {
    fn default() -> Self {
        Self {
            settings: RwLock::new(load_settings()),
            clients: Mutex::new(HashMap::new()),
            endpoint: tokio::sync::OnceCell::new(),
        }
    }
}

impl YouTubeNet {
    pub fn settings(&self) -> YouTubeSettings {
        self.settings
            .read()
            .map(|settings| settings.clone())
            .unwrap_or_default()
    }

    pub fn proxy_url(&self) -> Option<String> {
        self.settings().proxy_url
    }

    pub fn client(&self, scope: RedirectScope) -> Result<reqwest::Client, String> {
        let mut clients = self
            .clients
            .lock()
            .map_err(|_| "网络客户端状态不可用。".to_string())?;
        if let Some(client) = clients.get(&scope) {
            return Ok(client.clone());
        }
        let client = build_client(self.proxy_url().as_deref(), scope)?;
        clients.insert(scope, client.clone());
        Ok(client)
    }

    pub fn endpoint(&self) -> &tokio::sync::OnceCell<crate::youtube_proxy::ProxyEndpoint> {
        &self.endpoint
    }

    fn view(&self) -> YouTubeSettingsView {
        YouTubeSettingsView {
            proxy_url: self.proxy_url(),
            webview_proxy_url: WEBVIEW_PROXY.get().cloned().flatten(),
        }
    }
}

#[tauri::command]
pub fn youtube_get_settings(net: State<'_, YouTubeNet>) -> YouTubeSettingsView {
    net.view()
}

#[tauri::command]
pub fn youtube_set_settings(
    net: State<'_, YouTubeNet>,
    proxy_url: Option<String>,
) -> Result<YouTubeSettingsView, String> {
    let proxy_url = match proxy_url.as_deref() {
        Some(value) => normalize_proxy_url(value)?,
        None => None,
    };
    let updated = YouTubeSettings { proxy_url };
    save_settings(&updated)?;
    *net
        .settings
        .write()
        .map_err(|_| "设置状态不可用。".to_string())? = updated;
    net.clients
        .lock()
        .map_err(|_| "网络客户端状态不可用。".to_string())?
        .clear();
    Ok(net.view())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgress {
    downloaded: u64,
    total: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YtDlpInstall {
    path: String,
    version: String,
    sha256: String,
}

fn expected_sha256(sums: &str, file_name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (hash, name) = line.split_once(char::is_whitespace)?;
        let name = name.trim().trim_start_matches('*');
        (name == file_name && hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .then(|| hash.to_ascii_lowercase())
    })
}

fn looks_like_ytdlp_version(version: &str) -> bool {
    let mut parts = version.trim().split('.');
    let year = parts.next().unwrap_or_default();
    year.len() == 4
        && year.bytes().all(|byte| byte.is_ascii_digit())
        && parts
            .next()
            .is_some_and(|month| month.len() == 2 && month.bytes().all(|byte| byte.is_ascii_digit()))
}

async fn read_limited_text(response: reqwest::Response, limit: u64) -> Result<String, String> {
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取下载内容失败：{error}"))?
    {
        if bytes.len() as u64 + chunk.len() as u64 > limit {
            return Err("下载的校验文件过大。".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "校验文件不是有效文本。".to_string())
}

/// Installs or updates the official `yt-dlp.exe` under `%LOCALAPPDATA%\Seamind\tools`, where the
/// resolver already looks first. The binary is checked against the release's `SHA2-256SUMS` and must
/// report a version before it replaces the previous copy.
#[tauri::command]
pub async fn youtube_install_ytdlp(
    app: AppHandle,
    net: State<'_, YouTubeNet>,
) -> Result<YtDlpInstall, String> {
    if !cfg!(windows) {
        return Err("一键安装目前只支持 Windows；请手动安装 yt-dlp 并加入 PATH。".to_string());
    }
    let tools = seamind_data_dir()
        .ok_or_else(|| "无法确定 Seamind 的数据目录。".to_string())?
        .join("tools");
    let client = net.client(RedirectScope::GitHub)?;
    install_ytdlp_from(YT_DLP_RELEASE_BASE, &client, &tools, |progress| {
        let _ = app.emit("youtube-install-progress", progress);
    })
    .await
}

async fn install_ytdlp_from(
    base_url: &str,
    client: &reqwest::Client,
    tools: &std::path::Path,
    mut on_progress: impl FnMut(InstallProgress),
) -> Result<YtDlpInstall, String> {
    std::fs::create_dir_all(tools).map_err(|error| format!("无法创建工具目录：{error}"))?;

    let sums_response = client
        .get(format!("{base_url}/SHA2-256SUMS"))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| format!("无法下载 yt-dlp 校验文件：{error}"))?;
    if !sums_response.status().is_success() {
        return Err(format!("下载 yt-dlp 校验文件失败：HTTP {}", sums_response.status()));
    }
    let sums = read_limited_text(sums_response, YT_DLP_SUMS_MAX_BYTES).await?;
    let expected = expected_sha256(&sums, "yt-dlp.exe")
        .ok_or_else(|| "发布页的校验文件中没有 yt-dlp.exe。".to_string())?;

    let mut response = client
        .get(format!("{base_url}/yt-dlp.exe"))
        .send()
        .await
        .map_err(|error| format!("无法下载 yt-dlp：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载 yt-dlp 失败：HTTP {}", response.status()));
    }
    let total = response.content_length();
    if total.is_some_and(|total| total > YT_DLP_MAX_BYTES) {
        return Err("yt-dlp 文件大小异常，已取消安装。".to_string());
    }

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let staged = tools.join(format!("yt-dlp.exe.{}-{nonce}.download", std::process::id()));
    let result = download_and_install(
        &mut response,
        total,
        &staged,
        tools,
        &expected,
        &mut on_progress,
    )
    .await;
    if result.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    result
}

async fn download_and_install(
    response: &mut reqwest::Response,
    total: Option<u64>,
    staged: &std::path::Path,
    tools: &std::path::Path,
    expected: &str,
    on_progress: &mut impl FnMut(InstallProgress),
) -> Result<YtDlpInstall, String> {
    use tokio::io::AsyncWriteExt;

    let mut file = tokio::fs::File::create(staged)
        .await
        .map_err(|error| format!("无法写入 yt-dlp：{error}"))?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;
    let mut last_report = Instant::now();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("下载 yt-dlp 中断：{error}"))?
    {
        downloaded += chunk.len() as u64;
        if downloaded > YT_DLP_MAX_BYTES {
            return Err("yt-dlp 文件大小异常，已取消安装。".to_string());
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("写入 yt-dlp 失败：{error}"))?;
        if last_report.elapsed() >= Duration::from_millis(250) {
            last_report = Instant::now();
            on_progress(InstallProgress { downloaded, total });
        }
    }
    file.flush()
        .await
        .map_err(|error| format!("写入 yt-dlp 失败：{error}"))?;
    drop(file);
    on_progress(InstallProgress { downloaded, total });

    let actual = format!("{:x}", hasher.finalize());
    if actual != expected {
        return Err("yt-dlp 校验失败：下载内容与发布页的 SHA-256 不一致，已丢弃。".to_string());
    }

    let version = {
        let staged = staged.to_path_buf();
        tokio::task::spawn_blocking(move || {
            let mut command = std::process::Command::new(&staged);
            command.arg("--version");
            crate::youtube::run_hidden_with_timeout(command, Duration::from_secs(30))
        })
        .await
        .map_err(|error| format!("验证 yt-dlp 失败：{error}"))?
        .map_err(|error| format!("下载的 yt-dlp 无法运行：{error}"))?
    };
    if !looks_like_ytdlp_version(&version) {
        return Err("下载的文件不是有效的 yt-dlp。".to_string());
    }

    let target = tools.join("yt-dlp.exe");
    std::fs::rename(staged, &target).map_err(|error| {
        format!("无法替换 yt-dlp（可能正在使用，请稍后重试）：{error}")
    })?;
    Ok(YtDlpInstall {
        path: target.display().to_string(),
        version: version.trim().to_string(),
        sha256: actual,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_supported_proxy_urls() {
        assert_eq!(normalize_proxy_url("  ").unwrap(), None);
        assert_eq!(
            normalize_proxy_url("http://127.0.0.1:7890/").unwrap().as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            normalize_proxy_url("socks5://localhost:7891").unwrap().as_deref(),
            Some("socks5://localhost:7891")
        );
    }

    #[test]
    fn rejects_unsafe_or_ambiguous_proxy_urls() {
        for value in [
            "127.0.0.1:7890",
            "ftp://127.0.0.1:21",
            "http://user:pass@127.0.0.1:7890",
            "http://127.0.0.1:7890/path",
            "http://127.0.0.1:7890?x=1",
            "http://",
        ] {
            assert!(normalize_proxy_url(value).is_err(), "{value} should be rejected");
        }
    }

    #[test]
    fn finds_the_checksum_for_the_requested_asset() {
        let sums = "\
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  yt-dlp\r
BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB  yt-dlp.exe\r
cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc *yt-dlp_x86.exe\r
";
        assert_eq!(
            expected_sha256(sums, "yt-dlp.exe").as_deref(),
            Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        );
        assert_eq!(
            expected_sha256(sums, "yt-dlp_x86.exe").as_deref(),
            Some("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")
        );
        assert_eq!(expected_sha256(sums, "missing.exe"), None);
        assert_eq!(expected_sha256("short  yt-dlp.exe", "yt-dlp.exe"), None);
    }

    #[test]
    fn validates_ytdlp_version_output() {
        assert!(looks_like_ytdlp_version("2026.08.19\r\n"));
        assert!(!looks_like_ytdlp_version("Microsoft Windows"));
        assert!(!looks_like_ytdlp_version(""));
    }

    #[test]
    fn github_redirects_stay_on_github_hosts() {
        assert!(is_github_host("github.com"));
        assert!(is_github_host("release-assets.githubusercontent.com"));
        assert!(!is_github_host("evilgithub.com"));
        assert!(!is_github_host("github.com.evil.example"));
    }

    /// Serves a fake release directory so the installer's checks can be exercised without GitHub.
    async fn release_server(sums: String, binary: Vec<u8>) -> String {
        use axum::{routing::get, Router};
        let router = Router::new()
            .route("/SHA2-256SUMS", get(move || async move { sums.clone() }))
            .route("/yt-dlp.exe", get(move || async move { binary.clone() }));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        format!("http://127.0.0.1:{port}")
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn scratch_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("seamind-install-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn discards_a_download_that_does_not_match_the_published_checksum() {
        let tools = scratch_dir("mismatch");
        std::fs::write(tools.join("yt-dlp.exe"), b"previous").unwrap();
        let base = release_server(
            format!("{}  yt-dlp.exe\n", sha256_hex(b"genuine release")),
            b"tampered release".to_vec(),
        )
        .await;
        let client = build_client(None, RedirectScope::GitHub).unwrap();

        let error = install_ytdlp_from(&base, &client, &tools, |_| {}).await.unwrap_err();
        assert!(error.contains("校验失败"), "{error}");
        assert_eq!(std::fs::read(tools.join("yt-dlp.exe")).unwrap(), b"previous");
        let leftovers = std::fs::read_dir(&tools)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".download"))
            .count();
        assert_eq!(leftovers, 0, "the staged download must be removed");
        let _ = std::fs::remove_dir_all(&tools);
    }

    #[tokio::test]
    async fn keeps_the_previous_copy_when_the_download_cannot_run() {
        let tools = scratch_dir("not-runnable");
        std::fs::write(tools.join("yt-dlp.exe"), b"previous").unwrap();
        let binary = b"this is a text file, not a program".to_vec();
        let base = release_server(format!("{}  yt-dlp.exe\n", sha256_hex(&binary)), binary).await;
        let client = build_client(None, RedirectScope::GitHub).unwrap();

        let error = install_ytdlp_from(&base, &client, &tools, |_| {}).await.unwrap_err();
        assert!(error.contains("无法运行") || error.contains("不是有效"), "{error}");
        assert_eq!(std::fs::read(tools.join("yt-dlp.exe")).unwrap(), b"previous");
        let _ = std::fs::remove_dir_all(&tools);
    }

    #[tokio::test]
    async fn refuses_a_release_whose_checksum_file_lacks_the_binary() {
        let tools = scratch_dir("no-entry");
        let base = release_server("abc  something-else.exe\n".to_string(), b"x".to_vec()).await;
        let client = build_client(None, RedirectScope::GitHub).unwrap();
        let error = install_ytdlp_from(&base, &client, &tools, |_| {}).await.unwrap_err();
        assert!(error.contains("没有 yt-dlp.exe"), "{error}");
        let _ = std::fs::remove_dir_all(&tools);
    }

    /// `cargo test live_installs -- --ignored` downloads the real release (about 20 MB) into a
    /// temporary directory, never into the user's Seamind folder.
    #[tokio::test]
    #[ignore = "downloads about 20 MB from GitHub"]
    async fn live_installs_the_official_ytdlp_into_a_temporary_directory() {
        let tools = scratch_dir("live");
        let client = build_client(None, RedirectScope::GitHub).unwrap();
        let mut last = None;
        let installed = install_ytdlp_from(YT_DLP_RELEASE_BASE, &client, &tools, |progress| {
            last = Some(progress)
        })
        .await
        .expect("install the official yt-dlp");

        println!("installed {} at {}", installed.version, installed.path);
        assert!(tools.join("yt-dlp.exe").is_file());
        assert!(looks_like_ytdlp_version(&installed.version));
        assert_eq!(installed.sha256.len(), 64);
        let progress = last.expect("progress was reported");
        assert_eq!(Some(progress.downloaded), progress.total);
        let _ = std::fs::remove_dir_all(&tools);
    }
}
