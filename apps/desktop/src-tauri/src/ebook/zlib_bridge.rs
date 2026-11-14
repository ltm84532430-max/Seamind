use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::Duration;
use tauri::AppHandle;

use crate::library::{path_to_relative_string, require_root, safe_file_stem, EpubBookDocument};

const BUILTIN_ZLIB_DOMAINS: &[&str] = &[
    "https://z-lib.gd",
    "https://z-lib.by",
    "https://z-lib.gl",
    "https://zlib.bz",
    "https://z-library.ec",
    "https://z-library.qa",
    "https://z-library.website",
    "https://article.sk",
    "https://articles.sk",
    "https://z-lib.fm",
    "https://z-lib.id",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZlibBook {
    pub id: String,
    pub hash: String,
    pub title: String,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub year: Option<String>,
    pub language: Option<String>,
    pub extension: Option<String>,
    pub filesize: Option<String>,
    pub cover: Option<String>,
    pub rating: Option<String>,
    pub pages: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZlibEnvironment {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub has_login: bool,
    pub active_domain: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZlibProfile {
    pub email: Option<String>,
    pub name: Option<String>,
    pub downloads_today: Option<u32>,
    pub downloads_limit: Option<u32>,
    pub daily_remaining: Option<u32>,
    pub daily_allowed: Option<u32>,
    pub active_domain: Option<String>,
    pub is_logged_in: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZlibDoctorResult {
    pub healthy_domains: Vec<String>,
    pub active_domain: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZlibSwitchDomainResult {
    pub active_domain: String,
    pub healthy_domains: Vec<String>,
    pub profile: Option<ZlibProfile>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZlibSearchResult {
    pub books: Vec<ZlibBook>,
    pub total: usize,
    pub query: String,
    pub source: String, // "cli" or "eapi"
}

enum LoginAttemptOutcome {
    Success {
        user_id: String,
        user_key: String,
        working_domain: String,
    },
    RetryableError(String),
    TerminalError(String),
}

fn json_text(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        serde_json::Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn first_text(item: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| item.get(*key).and_then(json_text))
}

fn first_u32(item: &serde_json::Value, keys: &[&str]) -> Option<u32> {
    keys.iter()
        .find_map(|key| item.get(*key).and_then(|value| value.as_u64()))
        .map(|n| n as u32)
}

/// Validates and canonicalizes an HTTPS Z-Library mirror domain without path, query, or port.
fn sanitize_zlib_domain(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let lower = trimmed.to_ascii_lowercase();
    let host = lower.strip_prefix("https://")?;
    if host.is_empty()
        || host.contains('/')
        || host.contains('?')
        || host.contains('#')
        || host.contains('@')
        || host.contains(':')
        || !host.contains('.')
        || host == "localhost"
        || host.chars().all(|c| c.is_ascii_digit() || c == '.')
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    {
        return None;
    }
    Some(format!("https://{host}"))
}

fn is_builtin_zlib_domain(domain: &str) -> bool {
    BUILTIN_ZLIB_DOMAINS
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(domain))
}

fn is_trusted_zlib_domain(domain: &str, doctor_domains: &[String]) -> bool {
    let Some(canonical) = sanitize_zlib_domain(domain) else {
        return false;
    };
    is_builtin_zlib_domain(&canonical)
        || doctor_domains
            .iter()
            .any(|item| item.eq_ignore_ascii_case(&canonical))
}

// 只检查本机已保存的会话，不把网络故障误判成退出登录。
fn zlib_session_path() -> Option<PathBuf> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    Some(
        PathBuf::from(home)
            .join(".config")
            .join("zlib")
            .join("session.json"),
    )
}

fn saved_session_domain(value: &serde_json::Value) -> Option<String> {
    let cookies = value.get("cookies")?;
    for name in ["remix_userid", "remix_userkey"] {
        if cookies.get(name).and_then(json_text).is_none() {
            return None;
        }
    }
    first_text(value, &["domain"]).and_then(|domain| sanitize_zlib_domain(&domain))
}

fn read_saved_session_domain() -> Option<String> {
    let bytes = std::fs::read(zlib_session_path()?).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    saved_session_domain(&value)
}

fn write_session_file(
    session_path: &Path,
    user_id: &str,
    user_key: &str,
    domain: &str,
) -> Result<(), String> {
    let canonical_domain =
        sanitize_zlib_domain(domain).ok_or_else(|| "无效的登录节点域名。".to_string())?;
    let directory = session_path
        .parent()
        .ok_or_else(|| "无法定位本地登录目录。".to_string())?;
    std::fs::create_dir_all(directory).map_err(|_| "无法创建本地登录目录。".to_string())?;

    let session = serde_json::json!({
        "cookies": { "remix_userid": user_id, "remix_userkey": user_key },
        "domain": canonical_domain,
        "mode": "eapi"
    });
    let session_bytes =
        serde_json::to_vec_pretty(&session).map_err(|_| "无法保存登录会话。".to_string())?;
    std::fs::write(session_path, session_bytes).map_err(|_| "无法写入本地登录会话。".to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(session_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "无法设置登录会话文件权限。".to_string())?;
    }

    Ok(())
}

/// Updates `"domain"` in an existing valid session file without touching saved cookies.
fn update_session_domain(session_path: &Path, new_domain: &str) -> Result<bool, String> {
    let canonical_domain =
        sanitize_zlib_domain(new_domain).ok_or_else(|| "无效的节点域名。".to_string())?;
    if !session_path.is_file() {
        return Ok(false);
    }

    let bytes =
        std::fs::read(session_path).map_err(|_| "无法读取本地登录会话文件。".to_string())?;
    let mut value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "本地登录会话文件格式无效。".to_string())?;
    if saved_session_domain(&value).is_none() {
        return Ok(false);
    }

    let obj = value
        .as_object_mut()
        .ok_or_else(|| "本地登录会话文件格式无效。".to_string())?;
    obj.insert("domain".to_string(), serde_json::json!(canonical_domain));

    let session_bytes =
        serde_json::to_vec_pretty(&value).map_err(|_| "无法保存节点配置。".to_string())?;
    std::fs::write(session_path, session_bytes).map_err(|_| "无法更新本地节点配置。".to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(session_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "无法设置登录会话文件权限。".to_string())?;
    }

    Ok(true)
}

/// Splits compound `"17735211:25efe8"` IDs returned by zlib CLI into `(id, hash)` cleanly.
fn normalize_book_id_parts(raw_id: &str, raw_hash: Option<&str>) -> Option<(String, String)> {
    let clean_id = raw_id.trim();
    if clean_id.is_empty() {
        return None;
    }

    let clean_hash = raw_hash.map(str::trim).filter(|value| !value.is_empty());
    if clean_id.contains(':') {
        let parts = clean_id
            .split(':')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        let id_part = *parts.first()?;
        let hash_part = clean_hash.or_else(|| parts.get(1).copied())?;
        return Some((id_part.to_string(), hash_part.to_string()));
    }

    let hash_part = clean_hash?;
    Some((clean_id.to_string(), hash_part.to_string()))
}

/// Validates and deduplicates `"id:hash"` (including recovering from legacy `"id:hash:hash"`).
fn normalize_book_id_hash(raw_id_hash: &str) -> Result<String, String> {
    let parts = raw_id_hash
        .split(':')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.len() < 2 {
        return Err("无效的书籍下载编号，请重新搜索后再试。".to_string());
    }
    Ok(format!("{}:{}", parts[0], parts[1]))
}

/// CLI 使用 name/authors/size，直连接口使用 title/author/filesizeString。
fn parse_zlib_book(item: &serde_json::Value) -> Option<ZlibBook> {
    let raw_id = first_text(item, &["id"])?;
    let raw_hash = first_text(item, &["hash"]);
    let (id, hash) = normalize_book_id_parts(&raw_id, raw_hash.as_deref())?;
    let author = first_text(item, &["author"]).or_else(|| {
        item.get("authors").and_then(|value| match value {
            serde_json::Value::Array(values) => {
                let names = values.iter().filter_map(json_text).collect::<Vec<_>>();
                (!names.is_empty()).then(|| names.join(", "))
            }
            other => json_text(other),
        })
    });

    Some(ZlibBook {
        id,
        hash,
        title: first_text(item, &["title", "name"]).unwrap_or_else(|| "未知书名".to_string()),
        author,
        publisher: first_text(item, &["publisher"]),
        year: first_text(item, &["year"]),
        language: first_text(item, &["language"]),
        extension: first_text(item, &["extension"]),
        filesize: first_text(item, &["filesizeString", "filesize", "size"]),
        cover: first_text(item, &["cover"]),
        rating: first_text(item, &["rating", "interestScore"]),
        pages: first_text(item, &["pages"]),
    })
}

fn parse_zlib_profile(val: &serde_json::Value, active_domain: Option<String>) -> ZlibProfile {
    let email = first_text(val, &["email"]);
    let name = first_text(val, &["name", "username"]);
    let user_id = first_text(val, &["id", "user_id", "userId"]);
    let downloads_today = first_u32(val, &["daily_amount", "downloads_today", "downloadsToday"]);
    let downloads_limit = first_u32(val, &["daily_allowed", "downloads_limit", "downloadsLimit"]);
    let daily_remaining = first_u32(
        val,
        &["daily_remaining", "downloads_remaining", "dailyRemaining"],
    )
    .or_else(|| match (downloads_limit, downloads_today) {
        (Some(limit), Some(today)) => Some(limit.saturating_sub(today)),
        _ => None,
    });
    let confirmed = val.get("confirmed").and_then(|v| v.as_bool());
    let is_logged_in =
        email.is_some() || name.is_some() || user_id.is_some() || confirmed == Some(true);

    ZlibProfile {
        email,
        name,
        downloads_today,
        downloads_limit,
        daily_remaining,
        daily_allowed: downloads_limit,
        active_domain,
        is_logged_in,
    }
}

fn parse_doctor_entry(entry: &serde_json::Value) -> Option<String> {
    match entry {
        serde_json::Value::String(text) => sanitize_zlib_domain(text),
        serde_json::Value::Object(map) => {
            for flag in ["ok", "healthy", "available", "reachable", "valid"] {
                if map.get(flag).and_then(|v| v.as_bool()) == Some(false) {
                    return None;
                }
            }
            if map
                .get("error")
                .and_then(json_text)
                .is_some()
            {
                return None;
            }
            first_text(entry, &["domain", "url", "host", "origin"])
                .and_then(|raw| sanitize_zlib_domain(&raw))
        }
        _ => None,
    }
}

fn parse_doctor_domains(value: &serde_json::Value) -> Vec<String> {
    let array = value.as_array().or_else(|| {
        ["healthy", "available", "domains", "results", "working", "data"]
            .iter()
            .find_map(|key| value.get(*key).and_then(|v| v.as_array()))
    });

    let mut seen = HashSet::new();
    let mut domains = Vec::new();
    for entry in array.into_iter().flatten() {
        if let Some(domain) = parse_doctor_entry(entry) {
            if seen.insert(domain.clone()) {
                domains.push(domain);
            }
        }
    }
    domains
}

fn build_search_cli_args(query: &str, ext: Option<&str>, count: u32) -> Vec<String> {
    let mut args = vec!["search".to_string(), query.to_string()];
    if let Some(extension) = ext.map(str::trim).filter(|value| !value.is_empty()) {
        args.push("--ext".to_string());
        args.push(extension.to_string());
    }
    args.push("--count".to_string());
    args.push(count.to_string());
    args.push("--json".to_string());
    args
}

/// Locates the `zlib` or `zlib.exe` binary on the host system.
pub fn find_zlib_binary(custom_path: Option<&str>) -> Option<PathBuf> {
    if let Some(custom) = custom_path {
        let p = PathBuf::from(custom);
        if p.is_file() {
            return Some(p);
        }
    }

    if let Ok(env_path) = std::env::var("ZLIB_PATH") {
        let p = PathBuf::from(env_path);
        if p.is_file() {
            return Some(p);
        }
    }

    let binary_name = if cfg!(windows) { "zlib.exe" } else { "zlib" };
    if let Ok(output) = build_hidden_command(if cfg!(windows) { "where" } else { "which" })
        .arg(binary_name)
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(first_line) = stdout.lines().next() {
                let candidate = PathBuf::from(first_line.trim());
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    #[cfg(windows)]
    {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let winget_root = PathBuf::from(&local_app_data)
                .join("Microsoft")
                .join("WinGet");
            let winget_link = winget_root.join("Links").join("zlib.exe");
            if winget_link.is_file() {
                return Some(winget_link);
            }
            // 某些 WinGet 安装没有建立 Links 别名，直接查找软件包内的程序。
            if let Ok(packages) = std::fs::read_dir(winget_root.join("Packages")) {
                for package in packages.flatten() {
                    if package
                        .file_name()
                        .to_string_lossy()
                        .starts_with("heartleo.zlib_")
                    {
                        let executable = package.path().join("zlib.exe");
                        if executable.is_file() {
                            return Some(executable);
                        }
                    }
                }
            }
        }

        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            let go_bin = PathBuf::from(&user_profile)
                .join("go")
                .join("bin")
                .join("zlib.exe");
            if go_bin.is_file() {
                return Some(go_bin);
            }
        }
    }

    None
}

fn build_hidden_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn command_error_text(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let clean_err = stderr.trim();
    if !clean_err.is_empty() {
        clean_err.to_string()
    } else {
        stdout.trim().to_string()
    }
}

/// Runs a command with the zlib binary and returns raw JSON output.
fn run_zlib_json(binary: &Path, args: &[&str]) -> Result<serde_json::Value, String> {
    let output = build_hidden_command(binary)
        .args(args)
        .output()
        .map_err(|e| format!("执行 zlib 失败：{e}"))?;

    if !output.status.success() {
        let message = command_error_text(&output);
        return Err(if message.is_empty() {
            "zlib 执行失败，未返回详细原因。".to_string()
        } else {
            format!("zlib 执行错误：{message}")
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim())
        .map_err(|e| format!("无法解析 zlib 返回的 JSON 数据：{e}"))
}

fn run_doctor_blocking(binary: &Path) -> Result<Vec<String>, String> {
    let val = run_zlib_json(binary, &["doctor", "--json"])?;
    Ok(parse_doctor_domains(&val))
}

fn fetch_profile_blocking(binary: &Path) -> Result<ZlibProfile, String> {
    let val = run_zlib_json(binary, &["profile", "--json"])?;
    Ok(parse_zlib_profile(&val, read_saved_session_domain()))
}

#[tauri::command]
pub async fn zlib_check_environment(custom_path: Option<String>) -> Result<ZlibEnvironment, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let binary = find_zlib_binary(custom_path.as_deref());
        let saved_domain = read_saved_session_domain();
        let mut env = ZlibEnvironment {
            installed: binary.is_some(),
            path: binary.as_ref().map(|p| p.to_string_lossy().to_string()),
            version: None,
            has_login: binary.is_some() && saved_domain.is_some(),
            active_domain: saved_domain,
        };

        if let Some(ref bin_path) = binary {
            if let Ok(output) = build_hidden_command(bin_path).arg("--version").output() {
                if output.status.success() {
                    env.version = Some(String::from_utf8_lossy(&output.stdout).trim().to_string());
                }
            }
        }

        Ok(env)
    })
    .await
    .map_err(|e| format!("检测 zlib 环境失败：{e}"))?
}

#[tauri::command]
pub async fn zlib_get_profile(custom_path: Option<String>) -> Result<ZlibProfile, String> {
    let binary = find_zlib_binary(custom_path.as_deref())
        .ok_or_else(|| "未找到 zlib 命令行程序。".to_string())?;
    tauri::async_runtime::spawn_blocking(move || fetch_profile_blocking(&binary))
        .await
        .map_err(|e| format!("读取账号状态失败：{e}"))?
}

#[tauri::command]
pub async fn zlib_doctor(custom_path: Option<String>) -> Result<ZlibDoctorResult, String> {
    let binary = find_zlib_binary(custom_path.as_deref())
        .ok_or_else(|| "未找到 zlib 命令行程序。".to_string())?;
    let healthy_domains = tauri::async_runtime::spawn_blocking(move || run_doctor_blocking(&binary))
        .await
        .map_err(|e| format!("检测可用节点失败：{e}"))??;
    Ok(ZlibDoctorResult {
        healthy_domains,
        active_domain: read_saved_session_domain(),
    })
}

#[tauri::command]
pub async fn zlib_switch_domain(
    domain: Option<String>,
    custom_path: Option<String>,
) -> Result<ZlibSwitchDomainResult, String> {
    let binary = find_zlib_binary(custom_path.as_deref())
        .ok_or_else(|| "未找到 zlib 命令行程序。".to_string())?;
    let bin_for_doctor = binary.clone();
    let healthy_domains =
        tauri::async_runtime::spawn_blocking(move || run_doctor_blocking(&bin_for_doctor))
            .await
            .map_err(|e| format!("检测可用节点失败：{e}"))?
            .unwrap_or_default();

    let current_domain = read_saved_session_domain();
    let target_domain = if let Some(requested) = domain {
        let canonical = sanitize_zlib_domain(&requested)
            .ok_or_else(|| "节点域名格式无效。".to_string())?;
        if !is_trusted_zlib_domain(&canonical, &healthy_domains) {
            return Err("仅允许切换到受信任的 Z-Library 官方镜像节点。".to_string());
        }
        canonical
    } else {
        healthy_domains
            .iter()
            .find(|candidate| Some((*candidate).as_str()) != current_domain.as_deref())
            .cloned()
            .or_else(|| healthy_domains.first().cloned())
            .ok_or_else(|| "未检测到可用节点，请检查网络或代理设置后重试。".to_string())?
    };

    let session_path =
        zlib_session_path().ok_or_else(|| "无法定位本地登录会话路径。".to_string())?;
    let updated = update_session_domain(&session_path, &target_domain)?;
    if !updated {
        return Ok(ZlibSwitchDomainResult {
            active_domain: target_domain,
            healthy_domains,
            profile: None,
            warning: Some("当前尚未登录，请登录以启用该节点。".to_string()),
        });
    }

    let profile_result =
        tauri::async_runtime::spawn_blocking(move || fetch_profile_blocking(&binary))
            .await
            .map_err(|e| format!("校验节点状态失败：{e}"))?;

    match profile_result {
        Ok(mut profile) => {
            profile.active_domain = Some(target_domain.clone());
            Ok(ZlibSwitchDomainResult {
                active_domain: target_domain,
                healthy_domains,
                profile: Some(profile),
                warning: None,
            })
        }
        Err(err) => Ok(ZlibSwitchDomainResult {
            active_domain: target_domain,
            healthy_domains,
            profile: None,
            warning: Some(err),
        }),
    }
}

#[tauri::command]
pub fn zlib_logout() -> Result<(), String> {
    if let Some(session_path) = zlib_session_path() {
        if session_path.exists() {
            std::fs::remove_file(&session_path)
                .map_err(|e| format!("清除本地登录会话失败：{e}"))?;
        }
    }
    Ok(())
}

async fn attempt_eapi_login(
    client: &reqwest::Client,
    initial_domain: &str,
    email: &str,
    password: &str,
    trusted_domains: &[String],
) -> LoginAttemptOutcome {
    let mut current_domain = initial_domain.to_string();

    for hop in 0..=2 {
        let response = match client
            .post(format!("{current_domain}/eapi/user/login"))
            .header(reqwest::header::ACCEPT, "application/json")
            .form(&[("email", email), ("password", password)])
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(err) => {
                return LoginAttemptOutcome::RetryableError(format!(
                    "连接登录节点 {current_domain} 失败：{err}"
                ));
            }
        };

        if response.status().is_redirection() {
            let redirect_domain = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .and_then(|location| {
                    if location.starts_with('/') {
                        Some(current_domain.clone())
                    } else {
                        reqwest::Url::parse(location)
                            .ok()
                            .and_then(|url| {
                                url.host_str().map(|host| format!("https://{host}"))
                            })
                            .and_then(|origin| sanitize_zlib_domain(&origin))
                    }
                });

            if let Some(next_domain) = redirect_domain {
                if hop < 2
                    && next_domain != current_domain
                    && is_trusted_zlib_domain(&next_domain, trusted_domains)
                {
                    current_domain = next_domain;
                    continue;
                }
            }
            return LoginAttemptOutcome::RetryableError(format!(
                "登录节点 {current_domain} 发生跳转。"
            ));
        }

        if !response.status().is_success() {
            return LoginAttemptOutcome::RetryableError(format!(
                "登录节点 {current_domain} 返回 HTTP {}",
                response.status()
            ));
        }

        let value: serde_json::Value = match response.json().await {
            Ok(parsed) => parsed,
            Err(_) => {
                return LoginAttemptOutcome::RetryableError(format!(
                    "登录节点 {current_domain} 没有返回有效的 JSON 数据。"
                ));
            }
        };

        if value.get("success").and_then(|v| v.as_i64()) != Some(1) {
            let server_err = value
                .get("error")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("登录失败，请核对邮箱、密码或账号状态。")
                .trim()
                .to_string();
            return LoginAttemptOutcome::TerminalError(server_err);
        }

        let Some(user) = value.get("user") else {
            return LoginAttemptOutcome::TerminalError("登录响应缺少用户信息。".to_string());
        };
        let Some(user_id) = first_text(user, &["id"]) else {
            return LoginAttemptOutcome::TerminalError("登录响应缺少用户编号。".to_string());
        };
        let Some(user_key) = first_text(user, &["remix_userkey", "remix_user_key"]) else {
            return LoginAttemptOutcome::TerminalError("登录响应缺少会话凭据。".to_string());
        };

        return LoginAttemptOutcome::Success {
            user_id,
            user_key,
            working_domain: current_domain,
        };
    }

    LoginAttemptOutcome::RetryableError("登录节点重定向次数过多。".to_string())
}

fn push_unique_domain(targets: &mut Vec<String>, candidate: &str) {
    if let Some(canonical) = sanitize_zlib_domain(candidate) {
        if !targets.iter().any(|existing| existing == &canonical) {
            targets.push(canonical);
        }
    }
}

/// 直接通过 HTTPS 登录，避免把密码放进 zlib 子进程的命令行参数。
#[tauri::command]
pub async fn zlib_login(
    email: String,
    password: String,
    custom_path: Option<String>,
) -> Result<ZlibProfile, String> {
    let binary = find_zlib_binary(custom_path.as_deref())
        .ok_or_else(|| "请先安装 zlib 命令行程序，安装后重新打开找书窗口。".to_string())?;
    let email = email.trim().to_string();
    if email.is_empty() || password.is_empty() {
        return Err("请输入邮箱和密码。".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(18))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化登录连接。".to_string())?;

    let mut initial_candidates = Vec::new();
    if let Some(saved) = read_saved_session_domain() {
        if is_builtin_zlib_domain(&saved) {
            push_unique_domain(&mut initial_candidates, &saved);
        }
    }
    for domain in ["https://z-lib.gd", "https://z-lib.by", "https://z-lib.gl"] {
        push_unique_domain(&mut initial_candidates, domain);
    }

    let mut tried = HashSet::new();
    let mut trusted_domains = BUILTIN_ZLIB_DOMAINS
        .iter()
        .map(|s| (*s).to_string())
        .collect::<Vec<_>>();
    let mut last_err = String::from("连接登录服务失败，请检查网络后重试。");

    let mut attempt_list = initial_candidates;
    for pass in 0..2 {
        for domain in attempt_list {
            if !tried.insert(domain.clone()) {
                continue;
            }
            match attempt_eapi_login(&client, &domain, &email, &password, &trusted_domains).await {
                LoginAttemptOutcome::Success {
                    user_id,
                    user_key,
                    working_domain,
                } => {
                    let session_path = zlib_session_path()
                        .ok_or_else(|| "无法定位当前用户目录。".to_string())?;
                    write_session_file(&session_path, &user_id, &user_key, &working_domain)?;

                    let bin_verify = binary.clone();
                    let mut profile = tauri::async_runtime::spawn_blocking(move || {
                        fetch_profile_blocking(&bin_verify)
                    })
                    .await
                    .map_err(|e| format!("校验登录会话失败：{e}"))??;
                    if profile.email.is_none() {
                        profile.email = Some(email);
                    }
                    profile.active_domain = Some(working_domain);
                    return Ok(profile);
                }
                LoginAttemptOutcome::TerminalError(err) => return Err(err),
                LoginAttemptOutcome::RetryableError(err) => {
                    last_err = err;
                }
            }
        }

        if pass == 0 {
            let bin_doctor = binary.clone();
            let discovered = tauri::async_runtime::spawn_blocking(move || {
                run_doctor_blocking(&bin_doctor)
            })
            .await
            .ok()
            .and_then(|res| res.ok())
            .unwrap_or_default();

            let mut fallback_candidates = Vec::new();
            for domain in discovered {
                if !trusted_domains.iter().any(|existing| existing == &domain) {
                    trusted_domains.push(domain.clone());
                }
                if !tried.contains(&domain) {
                    fallback_candidates.push(domain);
                }
            }
            for builtin in BUILTIN_ZLIB_DOMAINS {
                if !tried.contains(*builtin) {
                    push_unique_domain(&mut fallback_candidates, builtin);
                }
            }
            if fallback_candidates.is_empty() {
                break;
            }
            attempt_list = fallback_candidates;
        } else {
            break;
        }
    }

    Err(last_err)
}

#[tauri::command]
pub async fn zlib_search(
    query: String,
    ext: Option<String>,
    count: Option<u32>,
    custom_path: Option<String>,
) -> Result<ZlibSearchResult, String> {
    let clean_query = query.trim().to_string();
    if clean_query.is_empty() {
        return Ok(ZlibSearchResult {
            books: Vec::new(),
            total: 0,
            query: clean_query,
            source: "empty".to_string(),
        });
    }

    let binary = find_zlib_binary(custom_path.as_deref());
    let target_count = count.unwrap_or(20);
    let extension = ext
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if let Some(bin_path) = binary {
        let query_arg = clean_query.clone();
        let ext_arg = extension.clone();
        let val = tauri::async_runtime::spawn_blocking(move || {
            let args_owned = build_search_cli_args(&query_arg, ext_arg.as_deref(), target_count);
            let arg_refs = args_owned.iter().map(String::as_str).collect::<Vec<_>>();
            run_zlib_json(&bin_path, &arg_refs)
        })
        .await
        .map_err(|e| format!("执行搜索失败：{e}"))??;

        let items = val
            .as_array()
            .or_else(|| val.get("books").and_then(|books| books.as_array()));
        let books = items
            .into_iter()
            .flatten()
            .filter_map(parse_zlib_book)
            .collect::<Vec<_>>();

        let total = books.len();
        return Ok(ZlibSearchResult {
            books,
            total,
            query: clean_query,
            source: "cli".to_string(),
        });
    }

    // Fallback: Query Z-Library EAPI via HTTP directly if CLI is not yet installed
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| format!("无法构建网络请求客户端：{e}"))?;

    let mut domains = Vec::new();
    if let Some(saved) = read_saved_session_domain() {
        push_unique_domain(&mut domains, &saved);
    }
    for mirror in ["https://z-lib.gd", "https://z-lib.by", "https://z-lib.gl"] {
        push_unique_domain(&mut domains, mirror);
    }

    let mut payload = serde_json::json!({
        "message": clean_query,
        "limit": target_count
    });
    if let Some(ext_val) = extension {
        payload["extensions"] = serde_json::json!([ext_val]);
    }

    let mut last_err = String::new();
    for domain in domains {
        let endpoint = format!("{domain}/eapi/book/search");
        match client
            .post(&endpoint)
            .json(&payload)
            .header(
                "User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            )
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(val) = resp.json::<serde_json::Value>().await {
                    let books = val
                        .get("books")
                        .and_then(|items| items.as_array())
                        .into_iter()
                        .flatten()
                        .filter_map(parse_zlib_book)
                        .collect::<Vec<_>>();
                    let total = books.len();
                    return Ok(ZlibSearchResult {
                        books,
                        total,
                        query: clean_query,
                        source: "eapi".to_string(),
                    });
                }
            }
            Ok(resp) => {
                last_err = format!("节点 {domain} 返回 HTTP {}", resp.status());
            }
            Err(e) => {
                last_err = format!("连接节点 {domain} 失败：{e}");
            }
        }
    }

    Err(format!(
        "无法完成在线搜书。若尚未安装 zlib，建议安装 heartleo/zlib 获得最佳连接稳定性。\n详细原因：{last_err}"
    ))
}

fn parse_download_json_path(books_dir: &Path, stdout: &str) -> Option<PathBuf> {
    let val: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;
    let raw = first_text(&val, &["path", "file", "file_path", "filePath", "saved_path", "savedPath"])?;
    let candidate = PathBuf::from(&raw);
    let resolved = if candidate.is_absolute() {
        candidate
    } else {
        books_dir.join(candidate)
    };
    resolved.is_file().then_some(resolved)
}

fn resolve_downloaded_book_path(
    books_dir: &Path,
    existing_files: &HashSet<PathBuf>,
    stdout: &str,
    title: Option<&str>,
) -> Result<PathBuf, String> {
    if let Some(json_path) = parse_download_json_path(books_dir, stdout) {
        return Ok(json_path);
    }

    let mut fallback_non_epub: Option<PathBuf> = None;
    if let Ok(iter) = std::fs::read_dir(books_dir) {
        for entry in iter.flatten() {
            let path = entry.path();
            if path.is_file() && !existing_files.contains(&path) {
                let is_epub = path
                    .extension()
                    .and_then(|s| s.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("epub"))
                    .unwrap_or(false);
                if is_epub {
                    return Ok(path);
                }
                if fallback_non_epub.is_none() {
                    fallback_non_epub = Some(path);
                }
            }
        }
    }

    if let Some(other_path) = fallback_non_epub {
        return Ok(other_path);
    }

    if let Some(raw_title) = title {
        let safe = safe_file_stem(raw_title).unwrap_or_else(|_| raw_title.to_string());
        let candidate = books_dir.join(format!("{safe}.epub"));
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    Err("下载完成，但未能定位新下载的电子书文件，请在书架点击“刷新”。".to_string())
}

#[tauri::command]
pub async fn zlib_download_book(
    app: AppHandle,
    id_hash: String,
    title: Option<String>,
    custom_path: Option<String>,
) -> Result<EpubBookDocument, String> {
    let root = require_root(&app)?;
    let books_dir = root.join("books");
    std::fs::create_dir_all(&books_dir).map_err(|e| format!("无法创建电子书书架目录：{e}"))?;

    let binary = find_zlib_binary(custom_path.as_deref()).ok_or_else(|| {
        "下载功能需要使用 zlib 命令行程序。请先在电脑上安装 heartleo/zlib（如使用 winget install --id heartleo.zlib）。"
            .to_string()
    })?;
    let clean_id_hash = normalize_book_id_hash(&id_hash)?;

    let existing_files: HashSet<PathBuf> = std::fs::read_dir(&books_dir)
        .map(|iter| iter.filter_map(|e| e.ok()).map(|e| e.path()).collect())
        .unwrap_or_default();

    let books_dir_clone = books_dir.clone();
    let title_clone = title.clone();
    let target_file = tauri::async_runtime::spawn_blocking(move || {
        let books_dir_str = books_dir_clone.to_string_lossy().to_string();
        let mut output = build_hidden_command(&binary)
            .args([
                "download",
                &clean_id_hash,
                "--dir",
                &books_dir_str,
                "--json",
            ])
            .output()
            .map_err(|e| format!("启动 zlib 下载失败：{e}"))?;

        if !output.status.success() {
            let err_text = command_error_text(&output);
            if err_text.contains("unknown flag") && err_text.contains("--json") {
                output = build_hidden_command(&binary)
                    .args(["download", &clean_id_hash, "--dir", &books_dir_str])
                    .output()
                    .map_err(|e| format!("启动 zlib 下载失败：{e}"))?;
            }
        }

        if !output.status.success() {
            let err_text = command_error_text(&output);
            return Err(format!("下载失败：{err_text}"));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        resolve_downloaded_book_path(
            &books_dir_clone,
            &existing_files,
            &stdout,
            title_clone.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("执行下载任务失败：{e}"))??;

    let is_epub = target_file
        .extension()
        .and_then(|s| s.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("epub"))
        .unwrap_or(false);
    if !is_epub {
        let file_name = target_file
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("电子书文件");
        return Err(format!(
            "已将《{file_name}》下载到 books 目录；当前电子书阅读器仅支持将 .epub 格式加入书架。"
        ));
    }

    let relative = target_file
        .strip_prefix(&root)
        .map_err(|_| "电子书保存位置超出了文件库。".to_string())?;
    let relative_path = path_to_relative_string(relative);
    let metadata =
        std::fs::metadata(&target_file).map_err(|e| format!("无法读取已下载电子书信息：{e}"))?;

    let file_stem = target_file
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("电子书")
        .to_string();

    Ok(EpubBookDocument {
        relative_path,
        title: file_stem,
        category: "books".to_string(),
        file_size: metadata.len(),
        updated_at: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_search_cli_args, normalize_book_id_hash, parse_doctor_domains, parse_zlib_book,
        parse_zlib_profile, resolve_downloaded_book_path, sanitize_zlib_domain,
        saved_session_domain, update_session_domain, write_session_file, ZlibEnvironment,
    };
    use serde_json::json;
    use std::collections::HashSet;
    use uuid::Uuid;

    #[test]
    fn cli_book_splits_compound_id_hash_and_uses_name_authors() {
        let book = parse_zlib_book(&json!({
            "id": "17735211:25efe8",
            "hash": "25efe8",
            "name": "深入理解计算机系统",
            "authors": ["作者甲", "作者乙"],
            "size": "2 MB",
            "year": 2024
        }))
        .unwrap();
        assert_eq!(book.id, "17735211");
        assert_eq!(book.hash, "25efe8");
        assert_eq!(book.title, "深入理解计算机系统");
        assert_eq!(book.author.as_deref(), Some("作者甲, 作者乙"));
        assert_eq!(book.filesize.as_deref(), Some("2 MB"));
        assert_eq!(book.year.as_deref(), Some("2024"));
    }

    #[test]
    fn cli_book_recovers_hash_when_only_compound_id_is_present() {
        let book = parse_zlib_book(&json!({
            "id": "17735211:25efe8",
            "name": "计算机组成原理"
        }))
        .unwrap();
        assert_eq!(book.id, "17735211");
        assert_eq!(book.hash, "25efe8");
    }

    #[test]
    fn normalize_book_id_hash_heals_duplicate_suffix() {
        assert_eq!(
            normalize_book_id_hash("17735211:25efe8:25efe8").unwrap(),
            "17735211:25efe8"
        );
        assert_eq!(
            normalize_book_id_hash(" 17735211:25efe8 ").unwrap(),
            "17735211:25efe8"
        );
        assert!(normalize_book_id_hash("17735211").is_err());
    }

    #[test]
    fn eapi_book_still_uses_title_and_author() {
        let book = parse_zlib_book(&json!({
            "id": "456",
            "hash": "def",
            "title": "物理学概论",
            "author": "作者丙",
            "filesizeString": "3 MB"
        }))
        .unwrap();
        assert_eq!(book.title, "物理学概论");
        assert_eq!(book.author.as_deref(), Some("作者丙"));
        assert_eq!(book.filesize.as_deref(), Some("3 MB"));
    }

    #[test]
    fn profile_parser_reads_cli_daily_quota_fields() {
        let profile = parse_zlib_profile(
            &json!({
                "id": "46060107",
                "name": "reader_one",
                "daily_amount": 3,
                "daily_allowed": 10,
                "daily_remaining": 7,
                "confirmed": true,
                "quota_known": true
            }),
            Some("https://z-lib.gd".to_string()),
        );
        assert!(profile.is_logged_in);
        assert_eq!(profile.name.as_deref(), Some("reader_one"));
        assert_eq!(profile.downloads_today, Some(3));
        assert_eq!(profile.downloads_limit, Some(10));
        assert_eq!(profile.daily_remaining, Some(7));
        assert_eq!(profile.daily_allowed, Some(10));
        assert_eq!(profile.active_domain.as_deref(), Some("https://z-lib.gd"));
    }

    #[test]
    fn search_args_omit_ext_for_all_formats() {
        assert_eq!(
            build_search_cli_args("计算机", None, 20),
            vec!["search", "计算机", "--count", "20", "--json"]
        );
        assert_eq!(
            build_search_cli_args("计算机", Some("  "), 20),
            vec!["search", "计算机", "--count", "20", "--json"]
        );
        assert_eq!(
            build_search_cli_args("计算机", Some("epub"), 20),
            vec!["search", "计算机", "--ext", "epub", "--count", "20", "--json"]
        );
    }

    #[test]
    fn doctor_parser_filters_unhealthy_and_unsafe_domains() {
        let domains = parse_doctor_domains(&json!([
            "https://z-lib.gd/",
            "http://insecure.example.com",
            "https://z-lib.by",
            "https://z-lib.gd"
        ]));
        assert_eq!(domains, vec!["https://z-lib.gd", "https://z-lib.by"]);

        let obj_domains = parse_doctor_domains(&json!({
            "results": [
                { "domain": "https://z-lib.gl", "ok": true },
                { "domain": "https://down.z-lib.org", "ok": false },
                { "domain": "https://127.0.0.1", "ok": true },
                { "url": "https://zlib.bz", "error": "" }
            ]
        }));
        assert_eq!(obj_domains, vec!["https://z-lib.gl", "https://zlib.bz"]);
        assert!(sanitize_zlib_domain("https://localhost").is_none());
        assert!(sanitize_zlib_domain("https://z-lib.gd/path").is_none());
    }

    #[test]
    fn session_write_and_domain_update_preserve_cookies() {
        let temp_dir = std::env::temp_dir().join(format!("zlib-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let session_path = temp_dir.join("session.json");

        write_session_file(&session_path, "42", "secret-key", "https://z-lib.gd").unwrap();
        let updated = update_session_domain(&session_path, "https://z-lib.by").unwrap();
        assert!(updated);

        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&session_path).unwrap()).unwrap();
        assert_eq!(saved_session_domain(&raw).as_deref(), Some("https://z-lib.by"));
        assert_eq!(raw["cookies"]["remix_userid"], json!("42"));
        assert_eq!(raw["cookies"]["remix_userkey"], json!("secret-key"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn resolve_downloaded_book_path_reads_json_and_diffs_dir() {
        let temp_dir = std::env::temp_dir().join(format!("zlib-dl-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let epub_path = temp_dir.join("demo.epub");
        std::fs::write(&epub_path, b"epub").unwrap();

        let from_json = resolve_downloaded_book_path(
            &temp_dir,
            &HashSet::new(),
            &json!({ "path": epub_path.to_string_lossy() }).to_string(),
            None,
        )
        .unwrap();
        assert_eq!(from_json, epub_path);

        let from_diff =
            resolve_downloaded_book_path(&temp_dir, &HashSet::new(), "", None).unwrap();
        assert_eq!(from_diff, epub_path);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn saved_session_is_detected_without_a_network_profile_request() {
        let session = json!({
            "cookies": { "remix_userid": "123", "remix_userkey": "secret" },
            "domain": "https://z-lib.gd",
            "mode": "eapi"
        });
        assert_eq!(
            saved_session_domain(&session).as_deref(),
            Some("https://z-lib.gd")
        );
        assert!(saved_session_domain(&json!({
            "cookies": { "remix_userid": "123", "remix_userkey": "" },
            "domain": "https://z-lib.gd"
        }))
        .is_none());
    }

    #[test]
    fn environment_fields_match_frontend_camel_case_contract() {
        let environment = ZlibEnvironment {
            installed: true,
            path: None,
            version: None,
            has_login: true,
            active_domain: Some("https://z-lib.gd".to_string()),
        };
        let value = serde_json::to_value(environment).unwrap();
        assert_eq!(value.get("hasLogin"), Some(&json!(true)));
        assert_eq!(value.get("activeDomain"), Some(&json!("https://z-lib.gd")));
        assert!(value.get("has_login").is_none());
    }
}
