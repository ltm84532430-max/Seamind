use serde::{Deserialize, Serialize};
use std::fs;

const PENDING_COMPONENTS_FILE: &str = "pending-components.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingComponents {
    pub plantuml_java: bool,
    pub yt_dlp: bool,
}

fn pending_components_path() -> Result<std::path::PathBuf, String> {
    crate::youtube_net::seamind_data_dir()
        .map(|directory| directory.join(PENDING_COMPONENTS_FILE))
        .ok_or_else(|| "无法确定 Seamind 的本地组件目录。".to_string())
}

#[tauri::command]
pub fn installer_get_pending_components() -> Result<Option<PendingComponents>, String> {
    let path = pending_components_path()?;
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取安装器的组件选择：{error}")),
    };
    let selection: PendingComponents = serde_json::from_str(&content)
        .map_err(|error| format!("安装器组件选择文件无效：{error}"))?;
    if !selection.plantuml_java && !selection.yt_dlp {
        return Ok(None);
    }
    Ok(Some(selection))
}

#[tauri::command]
pub fn installer_clear_pending_components() -> Result<(), String> {
    let path = pending_components_path()?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法清除已处理的组件选择：{error}")),
    }
}
