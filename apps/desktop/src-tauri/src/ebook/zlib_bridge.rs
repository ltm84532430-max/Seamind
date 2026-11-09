use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri::AppHandle;

use crate::library::{path_to_relative_string, require_root, safe_file_stem, EpubBookDocument};

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
    pub downloads_today: Option<u32>,
    pub downloads_limit: Option<u32>,
    pub is_logged_in: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZlibSearchResult {
    pub books: Vec<ZlibBook>,
    pub total: usize,
    pub query: String,
    pub source: String, // "cli" or "eapi"
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
    first_text(value, &["domain"])
}

fn read_saved_session_domain() -> Option<String> {
    let bytes = std::fs::read(zlib_session_path()?).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    saved_session_domain(&value)
}

/// CLI 使用 name/authors/size，直连接口使用 title/author/filesizeString。
fn parse_zlib_book(item: &serde_json::Value) -> Option<ZlibBook> {
    let id = first_text(item, &["id"])?;
    let hash = first_text(item, &["hash"])?;
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

    // Try `zlib` or `zlib.exe` on system PATH
    let binary_name = if cfg!(windows) { "zlib.exe" } else { "zlib" };
    if let Ok(output) = Command::new(if cfg!(windows) { "where" } else { "which" })
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

    // Common standard installation paths on Windows
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

/// Runs a command with the zlib binary and returns raw JSON output.
fn run_zlib_json(binary: &Path, args: &[&str]) -> Result<serde_json::Value, String> {
    let mut cmd = Command::new(binary);
    cmd.args(args);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().map_err(|e| format!("执行 zlib 失败：{e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("zlib 执行错误：{}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).map_err(|e| format!("无法解析 zlib 返回的 JSON 数据：{e}"))
}

#[tauri::command]
pub fn zlib_check_environment(custom_path: Option<String>) -> Result<ZlibEnvironment, String> {
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
        let mut cmd = Command::new(bin_path);
        cmd.arg("--version");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                env.version = Some(String::from_utf8_lossy(&output.stdout).trim().to_string());
            }
        }
    }

    Ok(env)
}

#[tauri::command]
pub fn zlib_get_profile(custom_path: Option<String>) -> Result<ZlibProfile, String> {
    let binary = find_zlib_binary(custom_path.as_deref())
        .ok_or_else(|| "未找到 zlib 命令行程序。".to_string())?;

    let val = run_zlib_json(&binary, &["profile", "--json"])?;

    let email = val
        .get("email")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let downloads_today = val
        .get("downloads_today")
        .or_else(|| val.get("downloadsToday"))
        .and_then(|v| v.as_u64())
        .map(|n| n as u32);
    let downloads_limit = val
        .get("downloads_limit")
        .or_else(|| val.get("downloadsLimit"))
        .and_then(|v| v.as_u64())
        .map(|n| n as u32);

    let is_logged_in = email.is_some() || val.get("username").is_some();

    Ok(ZlibProfile {
        email,
        downloads_today,
        downloads_limit,
        is_logged_in,
    })
}

/// 直接通过 HTTPS 登录，避免把密码放进 zlib 子进程的命令行参数。
#[tauri::command]
pub async fn zlib_login(email: String, password: String) -> Result<(), String> {
    if find_zlib_binary(None).is_none() {
        return Err("请先安装 zlib 命令行程序，安装后重新打开找书窗口。".to_string());
    }
    let email = email.trim();
    if email.is_empty() || password.is_empty() {
        return Err("请输入邮箱和密码。".to_string());
    }

    // 固定官方 CLI 的默认 EAPI 域名，不允许界面输入任意地址接收凭据。
    const DOMAIN: &str = "https://z-lib.gd";
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化登录连接。".to_string())?;
    let response = client
        .post(format!("{DOMAIN}/eapi/user/login"))
        .header(reqwest::header::ACCEPT, "application/json")
        .form(&[("email", email), ("password", password.as_str())])
        .send()
        .await
        .map_err(|_| "连接登录服务失败，请检查网络后重试。".to_string())?;
    if response.status().is_redirection() {
        return Err("当前登录节点发生跳转。请在终端运行 zlib doctor 检查可用节点。".to_string());
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "登录服务没有返回有效数据。".to_string())?;
    if value.get("success").and_then(|v| v.as_i64()) != Some(1) {
        return Err(value
            .get("error")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("登录失败，请核对邮箱、密码或账号状态。")
            .to_string());
    }
    let user = value
        .get("user")
        .ok_or_else(|| "登录响应缺少用户信息。".to_string())?;
    let user_id = user
        .get("id")
        .and_then(|v| {
            v.as_str()
                .map(str::to_string)
                .or_else(|| v.as_u64().map(|n| n.to_string()))
        })
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "登录响应缺少用户编号。".to_string())?;
    let user_key = user
        .get("remix_userkey")
        .or_else(|| user.get("remix_user_key"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "登录响应缺少会话凭据。".to_string())?;

    let session_path = zlib_session_path().ok_or_else(|| "无法定位当前用户目录。".to_string())?;
    let directory = session_path
        .parent()
        .ok_or_else(|| "无法定位本地登录目录。".to_string())?;
    std::fs::create_dir_all(&directory).map_err(|_| "无法创建本地登录目录。".to_string())?;
    let session = serde_json::json!({
        "cookies": { "remix_userid": user_id, "remix_userkey": user_key },
        "domain": DOMAIN,
        "mode": "eapi"
    });
    let session_bytes =
        serde_json::to_vec_pretty(&session).map_err(|_| "无法保存登录会话。".to_string())?;
    std::fs::write(&session_path, session_bytes)
        .map_err(|_| "无法写入本地登录会话。".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&session_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "无法设置登录会话文件权限。".to_string())?;
    }
    Ok(())
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
    let target_count = count.unwrap_or(20).to_string();
    let extension = ext.unwrap_or_else(|| "epub".to_string());

    if let Some(ref bin_path) = binary {
        // Run via heartleo/zlib CLI
        let args = [
            "search",
            &clean_query,
            "--ext",
            &extension,
            "--count",
            &target_count,
            "--json",
        ];

        let val = run_zlib_json(bin_path, &args)?;
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
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| format!("无法构建网络请求客户端：{e}"))?;

    // Well-known public mirrors
    let domains = ["https://z-lib.gd", "https://z-lib.fm", "https://z-lib.id"];
    let mut last_err = String::new();

    for domain in domains {
        let endpoint = format!("{domain}/eapi/book/search");
        let payload = serde_json::json!({
            "message": clean_query,
            "extensions": [extension],
            "limit": count.unwrap_or(20)
        });

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

    Err(format!("无法完成在线搜书。若尚未安装 zlib，建议安装 heartleo/zlib 获得最佳连接稳定性。\n详细原因：{last_err}"))
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

    let binary = find_zlib_binary(custom_path.as_deref())
        .ok_or_else(|| "下载功能需要使用 zlib 命令行程序。请先在电脑上安装 heartleo/zlib（如使用 winget install --id heartleo.zlib）。".to_string())?;

    // Record files in books_dir before download
    let existing_files: std::collections::HashSet<PathBuf> = std::fs::read_dir(&books_dir)
        .map(|iter| iter.filter_map(|e| e.ok()).map(|e| e.path()).collect())
        .unwrap_or_default();

    let clean_id_hash = id_hash.trim();
    let mut cmd = Command::new(&binary);
    cmd.args([
        "download",
        clean_id_hash,
        "--dir",
        &books_dir.to_string_lossy(),
    ]);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("启动 zlib 下载失败：{e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let combined = if stderr.trim().is_empty() {
            stdout
        } else {
            stderr
        };
        return Err(format!("下载失败：{}", combined.trim()));
    }

    // Find the newly downloaded file
    let mut downloaded_path: Option<PathBuf> = None;
    if let Ok(iter) = std::fs::read_dir(&books_dir) {
        for entry in iter.flatten() {
            let path = entry.path();
            if path.is_file() && !existing_files.contains(&path) {
                if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                    if ext.eq_ignore_ascii_case("epub") {
                        downloaded_path = Some(path);
                        break;
                    }
                }
            }
        }
    }

    // If title was specified and we found a matching or newly created file
    let target_file = if let Some(path) = downloaded_path {
        path
    } else {
        // Fallback search by title
        if let Some(t) = title {
            let safe = safe_file_stem(&t).unwrap_or(t);
            let candidate = books_dir.join(format!("{safe}.epub"));
            if candidate.is_file() {
                candidate
            } else {
                return Err(
                    "下载成功，但在书架目录中未检测到新的 .epub 文件。请刷新书架。".to_string(),
                );
            }
        } else {
            return Err("下载完成，但未能定位新下载的电子书文件，请在书架点击“刷新”。".to_string());
        }
    };

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
    use super::{parse_zlib_book, saved_session_domain, ZlibEnvironment};
    use serde_json::json;

    #[test]
    fn cli_book_uses_name_authors_and_size() {
        let book = parse_zlib_book(&json!({
            "id": 123,
            "hash": "abc",
            "name": "热力学导论",
            "authors": ["作者甲", "作者乙"],
            "size": "2 MB",
            "year": 2024
        }))
        .unwrap();
        assert_eq!(book.title, "热力学导论");
        assert_eq!(book.author.as_deref(), Some("作者甲, 作者乙"));
        assert_eq!(book.filesize.as_deref(), Some("2 MB"));
        assert_eq!(book.year.as_deref(), Some("2024"));
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
