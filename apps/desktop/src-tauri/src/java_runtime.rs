use crate::youtube_net::{seamind_data_dir, RedirectScope, YouTubeNet};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use zip::ZipArchive;

const TEMURIN_ASSETS_URL: &str = "https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse";
const MAX_JRE_DOWNLOAD_BYTES: u64 = 120 * 1024 * 1024;
const MAX_JRE_UNPACKED_BYTES: u64 = 500 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct AdoptiumAsset {
    binary: AdoptiumBinary,
    version_data: AdoptiumVersion,
}

#[derive(Debug, Deserialize)]
struct AdoptiumBinary {
    package: AdoptiumPackage,
}

#[derive(Debug, Deserialize)]
struct AdoptiumPackage {
    link: String,
    checksum: String,
}

#[derive(Debug, Deserialize)]
struct AdoptiumVersion {
    semver: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JavaInstallProgress {
    downloaded: u64,
    total: Option<u64>,
}

#[tauri::command]
pub async fn plantuml_install_java_runtime(
    app: AppHandle,
    net: State<'_, YouTubeNet>,
) -> Result<String, String> {
    if !cfg!(windows) {
        return Err("Seamind 管理的 Java 运行环境目前只支持 Windows。".to_string());
    }
    if crate::plantuml::has_supported_java().await {
        return Ok("已检测到可用的 Java 11+，没有重复下载。".to_string());
    }

    let client = net.client(RedirectScope::RuntimeDownloads)?;
    let assets = client
        .get(TEMURIN_ASSETS_URL)
        .send()
        .await
        .map_err(|error| format!("无法查询 Eclipse Temurin Java 运行环境：{error}"))?
        .error_for_status()
        .map_err(|error| format!("查询 Eclipse Temurin Java 运行环境失败：{error}"))?
        .json::<Vec<AdoptiumAsset>>()
        .await
        .map_err(|error| format!("无法读取 Eclipse Temurin 下载信息：{error}"))?;
    let asset = assets
        .into_iter()
        .next()
        .ok_or_else(|| "Eclipse Temurin 没有提供适用于当前 Windows x64 的 JRE。".to_string())?;
    let version = asset.version_data.semver.trim().to_string();
    let expected_sha256 = asset.binary.package.checksum.trim().to_ascii_lowercase();
    if expected_sha256.len() != 64
        || !expected_sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("Eclipse Temurin 返回的 SHA-256 校验值无效。".to_string());
    }
    let download_url = url::Url::parse(&asset.binary.package.link)
        .map_err(|_| "Eclipse Temurin 返回的下载地址无效。".to_string())?;
    if download_url.scheme() != "https"
        || !download_url
            .host_str()
            .is_some_and(|host| host == "github.com" || host.ends_with(".github.com"))
    {
        return Err("Eclipse Temurin 下载地址不在允许的 HTTPS 发布域名中。".to_string());
    }

    let tools = seamind_data_dir()
        .ok_or_else(|| "无法确定 Seamind 的本地组件目录。".to_string())?
        .join("tools");
    let java_root = tools.join("java");
    fs::create_dir_all(&java_root).map_err(|error| format!("无法创建 Java 组件目录：{error}"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let archive_path = java_root.join(format!("jre-{nonce}.zip.download"));
    let staging_path = java_root.join(format!(".staging-{nonce}"));

    let result = download_and_install_java(
        &app,
        &client,
        &asset.binary.package.link,
        &expected_sha256,
        &version,
        &archive_path,
        &staging_path,
        &java_root,
    )
    .await;
    let _ = fs::remove_file(&archive_path);
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging_path);
    }
    result
}

async fn download_and_install_java(
    app: &AppHandle,
    client: &reqwest::Client,
    download_url: &str,
    expected_sha256: &str,
    version: &str,
    archive_path: &Path,
    staging_path: &Path,
    java_root: &Path,
) -> Result<String, String> {
    let mut response = client
        .get(download_url)
        .send()
        .await
        .map_err(|error| format!("无法下载 Eclipse Temurin Java：{error}"))?
        .error_for_status()
        .map_err(|error| format!("下载 Eclipse Temurin Java 失败：{error}"))?;
    let total = response.content_length();
    if total.is_some_and(|size| size > MAX_JRE_DOWNLOAD_BYTES) {
        return Err("Java 运行环境下载大小超过安全上限。".to_string());
    }

    let mut file = tokio::fs::File::create(archive_path)
        .await
        .map_err(|error| format!("无法创建 Java 下载临时文件：{error}"))?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Java 下载中断：{error}"))?
    {
        downloaded += chunk.len() as u64;
        if downloaded > MAX_JRE_DOWNLOAD_BYTES {
            return Err("Java 运行环境下载大小超过安全上限。".to_string());
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("写入 Java 下载临时文件失败：{error}"))?;
        let _ = app.emit(
            "seamind-java-install-progress",
            JavaInstallProgress { downloaded, total },
        );
    }
    file.flush()
        .await
        .map_err(|error| format!("保存 Java 下载文件失败：{error}"))?;
    drop(file);

    let actual_sha256 = format!("{:x}", hasher.finalize());
    if actual_sha256 != expected_sha256 {
        return Err("Java 运行环境 SHA-256 校验失败，下载文件已丢弃。".to_string());
    }

    let archive_for_extract = archive_path.to_path_buf();
    let staging_for_extract = staging_path.to_path_buf();
    let java_relative_path = tokio::task::spawn_blocking(move || {
        extract_java_archive(&archive_for_extract, &staging_for_extract)
    })
    .await
    .map_err(|error| format!("Java 解压任务失败：{error}"))??;

    let safe_version = version
        .chars()
        .take(80)
        .map(|character| {
            if character.is_ascii_alphanumeric() || ".+-_".contains(character) {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if safe_version.is_empty() {
        return Err("Eclipse Temurin 返回的 Java 版本号无效。".to_string());
    }
    let destination = java_root.join(format!("temurin-{safe_version}"));
    if destination.exists() {
        if !destination.join(&java_relative_path).is_file() {
            return Err(
                "同版本 Java 目录已存在，但运行文件不完整；为保护目录内容，未覆盖它。".to_string(),
            );
        }
        fs::remove_dir_all(staging_path)
            .map_err(|error| format!("无法清理重复下载的 Java 临时目录：{error}"))?;
    } else {
        fs::rename(staging_path, &destination)
            .map_err(|error| format!("无法安装 Java 运行环境：{error}"))?;
    }

    let managed_relative_path = PathBuf::from(
        destination
            .file_name()
            .ok_or_else(|| "Java 安装目录名称无效。".to_string())?,
    )
    .join(java_relative_path);
    let active_path = java_root.join("active-java.txt");
    let active_nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let active_temp = java_root.join(format!("active-java-{active_nonce}.tmp"));
    fs::write(
        &active_temp,
        managed_relative_path.to_string_lossy().as_bytes(),
    )
    .map_err(|error| format!("无法记录 Seamind 管理的 Java 运行环境：{error}"))?;
    if active_path.exists() {
        fs::remove_file(&active_path)
            .map_err(|error| format!("无法更新 Java 运行环境记录：{error}"))?;
    }
    fs::rename(&active_temp, &active_path)
        .map_err(|error| format!("无法启用新安装的 Java 运行环境：{error}"))?;
    Ok(format!("已安装 Eclipse Temurin Java {version}。"))
}

fn extract_java_archive(archive_path: &Path, staging_path: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(staging_path).map_err(|error| format!("无法创建 Java 临时目录：{error}"))?;
    let archive_file =
        File::open(archive_path).map_err(|error| format!("无法读取 Java 下载文件：{error}"))?;
    let mut archive = ZipArchive::new(archive_file)
        .map_err(|error| format!("Java 下载文件不是有效 ZIP：{error}"))?;
    let mut extracted_bytes = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("无法读取 Java 压缩包条目：{error}"))?;
        let relative_path = entry
            .enclosed_name()
            .ok_or_else(|| "Java 压缩包包含越界路径，已取消安装。".to_string())?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Java 压缩包包含符号链接，已取消安装。".to_string());
        }
        let destination = staging_path.join(relative_path);
        if entry.is_dir() {
            fs::create_dir_all(&destination)
                .map_err(|error| format!("无法创建 Java 目录：{error}"))?;
            continue;
        }
        extracted_bytes = extracted_bytes.saturating_add(entry.size());
        if extracted_bytes > MAX_JRE_UNPACKED_BYTES {
            return Err("Java 运行环境解压大小超过安全上限。".to_string());
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建 Java 目录：{error}"))?;
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(|error| format!("无法写入 Java 文件：{error}"))?;
        io::copy(&mut entry, &mut output)
            .map_err(|error| format!("解压 Java 文件失败：{error}"))?;
    }
    find_java_executable(staging_path, 0)
        .and_then(|path| path.strip_prefix(staging_path).ok().map(Path::to_path_buf))
        .ok_or_else(|| "Java 压缩包中没有可运行的 bin/java.exe。".to_string())
}

fn find_java_executable(directory: &Path, depth: usize) -> Option<PathBuf> {
    if depth > 6 {
        return None;
    }
    let entries = fs::read_dir(directory).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = entry.file_type().ok()?;
        if file_type.is_file()
            && path.file_name().is_some_and(|name| name == "java.exe")
            && path
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name == "bin")
        {
            return Some(path);
        }
        if file_type.is_dir() {
            if let Some(found) = find_java_executable(&path, depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

pub(crate) fn managed_java_candidate() -> Option<PathBuf> {
    let java_root = seamind_data_dir()?.join("tools").join("java");
    let relative = fs::read_to_string(java_root.join("active-java.txt")).ok()?;
    let relative = PathBuf::from(relative.trim());
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }
    let root = java_root.canonicalize().ok()?;
    let candidate = java_root.join(relative).canonicalize().ok()?;
    if candidate.starts_with(&root) && candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}
