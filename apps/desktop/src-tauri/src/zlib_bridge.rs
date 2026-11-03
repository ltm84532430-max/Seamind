use std::path::{Path, PathBuf};
use std::process::Command;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::library::{safe_file_stem, require_root, path_to_relative_string, EpubBookDocument};

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
pub struct ZlibEnvironment {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub has_login: bool,
    pub active_domain: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
            let winget_glob = PathBuf::from(&local_app_data)
                .join("Microsoft")
                .join("WinGet")
                .join("Links")
                .join("zlib.exe");
            if winget_glob.is_file() {
                return Some(winget_glob);
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

    let output = cmd
        .output()
        .map_err(|e| format!("执行 zlib 失败：{e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("zlib 执行错误：{}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim())
        .map_err(|e| format!("无法解析 zlib 返回的 JSON 数据：{e}"))
}

#[tauri::command]
pub fn zlib_check_environment(custom_path: Option<String>) -> Result<ZlibEnvironment, String> {
    let binary = find_zlib_binary(custom_path.as_deref());
    let mut env = ZlibEnvironment {
        installed: binary.is_some(),
        path: binary.as_ref().map(|p| p.to_string_lossy().to_string()),
        version: None,
        has_login: false,
        active_domain: None,
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

        // Check if config/cookies exist
        if let Ok(val) = run_zlib_json(bin_path, &["profile", "--json"]) {
            if val.get("email").is_some() || val.get("username").is_some() {
                env.has_login = true;
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

    let email = val.get("email").and_then(|v| v.as_str()).map(|s| s.to_string());
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
        let mut books = Vec::new();

        let items = if let Some(arr) = val.as_array() {
            arr.clone()
        } else if let Some(arr) = val.get("books").and_then(|b| b.as_array()) {
            arr.clone()
        } else {
            Vec::new()
        };

        for item in items {
            let id = item.get("id").map(|v| v.to_string().trim_matches('"').to_string()).unwrap_or_default();
            let hash = item.get("hash").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("未知书名").to_string();
            let author = item.get("author").and_then(|v| v.as_str()).map(|s| s.to_string());
            let publisher = item.get("publisher").and_then(|v| v.as_str()).map(|s| s.to_string());
            let year = item.get("year").map(|v| v.to_string().trim_matches('"').to_string());
            let language = item.get("language").and_then(|v| v.as_str()).map(|s| s.to_string());
            let item_ext = item.get("extension").and_then(|v| v.as_str()).map(|s| s.to_string());
            let filesize = item
                .get("filesizeString")
                .or_else(|| item.get("filesize"))
                .map(|v| v.to_string().trim_matches('"').to_string());
            let cover = item.get("cover").and_then(|v| v.as_str()).map(|s| s.to_string());
            let rating = item.get("rating").map(|v| v.to_string().trim_matches('"').to_string());
            let pages = item.get("pages").map(|v| v.to_string().trim_matches('"').to_string());

            if !id.is_empty() && !hash.is_empty() {
                books.push(ZlibBook {
                    id,
                    hash,
                    title,
                    author,
                    publisher,
                    year,
                    language,
                    extension: item_ext,
                    filesize,
                    cover,
                    rating,
                    pages,
                });
            }
        }

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

        match client.post(&endpoint)
            .json(&payload)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(val) = resp.json::<serde_json::Value>().await {
                    let mut books = Vec::new();
                    if let Some(arr) = val.get("books").and_then(|b| b.as_array()) {
                        for item in arr {
                            let id = item.get("id").map(|v| v.to_string().trim_matches('"').to_string()).unwrap_or_default();
                            let hash = item.get("hash").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                            let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("未知书名").to_string();
                            let author = item.get("author").and_then(|v| v.as_str()).map(|s| s.to_string());
                            let publisher = item.get("publisher").and_then(|v| v.as_str()).map(|s| s.to_string());
                            let year = item.get("year").map(|v| v.to_string().trim_matches('"').to_string());
                            let language = item.get("language").and_then(|v| v.as_str()).map(|s| s.to_string());
                            let item_ext = item.get("extension").and_then(|v| v.as_str()).map(|s| s.to_string());
                            let filesize = item.get("filesizeString").or_else(|| item.get("filesize")).map(|v| v.to_string().trim_matches('"').to_string());
                            let cover = item.get("cover").and_then(|v| v.as_str()).map(|s| s.to_string());
                            let rating = item.get("rating").map(|v| v.to_string().trim_matches('"').to_string());
                            let pages = item.get("pages").map(|v| v.to_string().trim_matches('"').to_string());

                            if !id.is_empty() && !hash.is_empty() {
                                books.push(ZlibBook {
                                    id,
                                    hash,
                                    title,
                                    author,
                                    publisher,
                                    year,
                                    language,
                                    extension: item_ext,
                                    filesize,
                                    cover,
                                    rating,
                                    pages,
                                });
                            }
                        }
                    }
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
    std::fs::create_dir_all(&books_dir)
        .map_err(|e| format!("无法创建电子书书架目录：{e}"))?;

    let binary = find_zlib_binary(custom_path.as_deref())
        .ok_or_else(|| "下载功能需要使用 zlib 命令行程序。请先在电脑上安装 heartleo/zlib（如使用 winget install --id heartleo.zlib）。".to_string())?;

    // Record files in books_dir before download
    let existing_files: std::collections::HashSet<PathBuf> = std::fs::read_dir(&books_dir)
        .map(|iter| {
            iter.filter_map(|e| e.ok())
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default();

    let clean_id_hash = id_hash.trim();
    let mut cmd = Command::new(&binary);
    cmd.args(["download", clean_id_hash, "--dir", &books_dir.to_string_lossy()]);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().map_err(|e| format!("启动 zlib 下载失败：{e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let combined = if stderr.trim().is_empty() { stdout } else { stderr };
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
                return Err("下载成功，但在书架目录中未检测到新的 .epub 文件。请刷新书架。".to_string());
            }
        } else {
            return Err("下载完成，但未能定位新下载的电子书文件，请在书架点击“刷新”。".to_string());
        }
    };

    let relative = target_file
        .strip_prefix(&root)
        .map_err(|_| "电子书保存位置超出了文件库。".to_string())?;
    let relative_path = path_to_relative_string(relative);
    let metadata = std::fs::metadata(&target_file)
        .map_err(|e| format!("无法读取已下载电子书信息：{e}"))?;

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
