use serde::Serialize;
#[cfg(windows)]
use serde::Deserialize;
#[cfg(windows)]
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPostgresInstance {
    pub service_name: String,
    pub display_name: String,
    pub state: String,
    pub port: u16,
    pub port_source: String,
}

#[cfg(windows)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowsServiceRecord {
    service_name: String,
    display_name: String,
    state: String,
    path_name: String,
}

#[cfg(windows)]
fn system_tool(relative_path: &str) -> PathBuf {
    let root = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("WINDIR"))
        .unwrap_or_else(|| "C:\\Windows".into());
    PathBuf::from(root).join("System32").join(relative_path)
}

#[cfg(windows)]
fn service_data_dir(path_name: &str) -> Option<PathBuf> {
    let re = regex::Regex::new(r#"(?i)(?:^|\s)-D\s+(?:"([^"]+)"|([^\s]+))"#).ok()?;
    let captures = re.captures(path_name)?;
    Some(PathBuf::from(
        captures.get(1).or_else(|| captures.get(2))?.as_str(),
    ))
}

#[cfg(windows)]
fn configured_port(data_dir: &Path) -> Option<u16> {
    let re = regex::Regex::new(r#"(?m)^\s*port\s*=\s*'?([0-9]{1,5})'?(?:\s|#|$)"#).ok()?;
    let mut port = None;
    for filename in ["postgresql.conf", "postgresql.auto.conf"] {
        if let Ok(contents) = std::fs::read_to_string(data_dir.join(filename)) {
            for captures in re.captures_iter(&contents) {
                port = captures
                    .get(1)
                    .and_then(|m| m.as_str().parse::<u16>().ok())
                    .filter(|p| *p > 0);
            }
        }
    }
    port
}

#[cfg(windows)]
async fn discover_windows_services() -> Result<Vec<WindowsServiceRecord>, String> {
    // The script is fixed and accepts no UI input. Restrict results to pg_ctl Windows services.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$items = @(Get-CimInstance Win32_Service | Where-Object {
  $_.PathName -match '(?i)\\pg_ctl\.exe[" ]' -and $_.PathName -match '(?i)\brunservice\b'
} | ForEach-Object {
  [pscustomobject]@{
    serviceName = $_.Name
    displayName = $_.DisplayName
    state = $_.State
    pathName = $_.PathName
  }
})
ConvertTo-Json -InputObject $items -Compress -Depth 3
"#;
    let mut command = tokio::process::Command::new(system_tool("WindowsPowerShell\\v1.0\\powershell.exe"));
    command.args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT]);
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(std::time::Duration::from_secs(15), command.output())
        .await
        .map_err(|_| "查找本机 PostgreSQL 服务超时。".to_string())?
        .map_err(|e| format!("无法查询 Windows 服务：{e}"))?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        return Err(format!("查询 Windows 服务失败：{}", error.trim()));
    }
    let stdout = String::from_utf8(output.stdout)
        .map_err(|_| "Windows 服务列表编码无效。".to_string())?;
    serde_json::from_str(stdout.trim().trim_start_matches('\u{feff}'))
        .map_err(|e| format!("无法解析 PostgreSQL 服务列表：{e}"))
}

#[tauri::command]
pub async fn data_lab_discover_local_postgres() -> Result<Vec<LocalPostgresInstance>, String> {
    #[cfg(windows)]
    {
        let services = discover_windows_services().await?;
        return Ok(services
            .into_iter()
            .map(|service| {
                let detected_port = service_data_dir(&service.path_name)
                    .as_deref()
                    .and_then(configured_port);
                LocalPostgresInstance {
                    service_name: service.service_name,
                    display_name: service.display_name,
                    state: service.state,
                    port: detected_port.unwrap_or(5432),
                    port_source: if detected_port.is_some() {
                        "config".to_string()
                    } else {
                        "default".to_string()
                    },
                }
            })
            .collect());
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub async fn data_lab_start_local_postgres(
    service_name: String,
) -> Result<LocalPostgresInstance, String> {
    #[cfg(windows)]
    {
        let requested = service_name.trim();
        let candidate = data_lab_discover_local_postgres()
            .await?
            .into_iter()
            .find(|instance| instance.service_name == requested)
            .ok_or_else(|| "未找到受支持的本机 PostgreSQL 服务。请重新扫描。".to_string())?;
        if candidate.state.eq_ignore_ascii_case("Running") {
            return Ok(candidate);
        }
        if !candidate.state.eq_ignore_ascii_case("Stopped") {
            return Err(format!("服务当前处于 {} 状态，请稍后重试。", candidate.state));
        }
        let mut command = tokio::process::Command::new(system_tool("sc.exe"));
        command.args(["start", &candidate.service_name]);
        command.creation_flags(0x08000000);
        let output = tokio::time::timeout(std::time::Duration::from_secs(20), command.output())
            .await
            .map_err(|_| "启动 PostgreSQL 服务超时。".to_string())?
            .map_err(|e| format!("无法启动 PostgreSQL 服务：{e}"))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stdout);
            let error = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "启动 PostgreSQL 服务失败。{} {}",
                detail.trim(),
                error.trim()
            ));
        }
        for _ in 0..8 {
            if let Some(updated) = data_lab_discover_local_postgres()
                .await?
                .into_iter()
                .find(|instance| instance.service_name == requested)
            {
                if updated.state.eq_ignore_ascii_case("Running") {
                    return Ok(updated);
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        }
        Err("PostgreSQL 服务尚未进入运行状态，请检查 Windows 服务日志。".to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = service_name;
        Err("当前平台尚不支持启动本机 PostgreSQL 服务。".to_string())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn extracts_data_directory_from_service_command() {
        let path = r#""C:\Program Files\PostgreSQL\17\bin\pg_ctl.exe" runservice -N "postgresql-x64-17" -D "C:\Program Files\PostgreSQL\17\data" -w"#;
        assert_eq!(
            service_data_dir(path).unwrap(),
            PathBuf::from(r"C:\Program Files\PostgreSQL\17\data")
        );
    }
}
