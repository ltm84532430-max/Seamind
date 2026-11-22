use std::fs;
use std::path::Path;
use std::process::Command;

const MAX_EXPORTED_HTML_BYTES: usize = 128 * 1024 * 1024;

fn validate_html_export_path(path: &Path) -> Result<(), String> {
    let trimmed = path.to_string_lossy().trim().to_string();
    if trimmed.is_empty() {
        return Err("请选择有效的 HTML 导出保存路径。".to_string());
    }
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "html" && ext != "htm" {
        return Err("导出文件扩展名必须是 .html 或 .htm。".to_string());
    }
    Ok(())
}

pub fn write_exported_html_sync(path: &Path, html: &str) -> Result<usize, String> {
    validate_html_export_path(path)?;
    let bytes = html.as_bytes();
    if bytes.is_empty() {
        return Err("导出的 HTML 内容为空。".to_string());
    }
    if bytes.len() > MAX_EXPORTED_HTML_BYTES {
        return Err("导出的 HTML 文件超过 128 MB 安全上限。".to_string());
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建导出目录：{error}"))?;
        }
    }

    let tmp_name = format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("export"),
        uuid::Uuid::new_v4()
    );
    let tmp_path = path.with_file_name(tmp_name);
    fs::write(&tmp_path, bytes).map_err(|error| format!("写入临时 HTML 文件失败：{error}"))?;
    if let Err(error) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("保存导出的 HTML 文件失败：{error}"));
    }
    Ok(bytes.len())
}

#[tauri::command]
pub async fn write_exported_mindmap_html(
    file_path: String,
    html: String,
) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || write_exported_html_sync(Path::new(&file_path), &html))
        .await
        .map_err(|error| format!("保存导出任务失败：{error}"))?
}

#[tauri::command]
pub fn open_exported_html_in_browser(file_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    validate_html_export_path(path)?;
    if !path.is_file() {
        return Err("找不到导出的 HTML 文件。".to_string());
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("无法定位 HTML 文件：{error}"))?;

    #[cfg(target_os = "windows")]
    {
        let target = canonical.to_string_lossy();
        let clean = target.strip_prefix(r"\\?\").unwrap_or(&target);
        Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", clean])
            .spawn()
            .map_err(|error| format!("无法在浏览器中打开：{error}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&canonical)
            .spawn()
            .map_err(|error| format!("无法在浏览器中打开：{error}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&canonical)
            .spawn()
            .map_err(|error| format!("无法在浏览器中打开：{error}"))?;
        return Ok(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_html_paths_and_writes_atomically() {
        let temp_dir =
            std::env::temp_dir().join(format!("seamind_export_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).unwrap();

        let bad_path = temp_dir.join("notes.txt");
        assert!(write_exported_html_sync(&bad_path, "<html></html>").is_err());

        let good_path = temp_dir.join("share.html");
        let content = "<!doctype html><html><body>OK</body></html>";
        let size = write_exported_html_sync(&good_path, content).unwrap();
        assert_eq!(size, content.len());
        assert_eq!(fs::read_to_string(&good_path).unwrap(), content);

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
