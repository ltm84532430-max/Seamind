use crate::agent_bridge::AgentBridgeState;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

const MAX_TERMINAL_INPUT_BYTES: usize = 65_536;
const MAX_TERMINAL_SCRIPT_BYTES: usize = 40_000;
const MAX_TERMINAL_SESSIONS: usize = 16;

#[derive(Default, Clone)]
pub struct TerminalState {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
    active_sessions: Arc<AtomicUsize>,
}

struct TerminalSession {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    cleanup_paths: Vec<PathBuf>,
    active_sessions: Arc<AtomicUsize>,
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = self.killer.kill();
        remove_temp_files(&self.cleanup_paths);
        self.active_sessions.fetch_sub(1, Ordering::SeqCst);
    }
}

struct TerminalSessionReservation {
    active_sessions: Arc<AtomicUsize>,
    committed: bool,
}

impl TerminalSessionReservation {
    fn reserve(active_sessions: Arc<AtomicUsize>) -> Result<Self, String> {
        let mut current = active_sessions.load(Ordering::SeqCst);
        loop {
            if current >= MAX_TERMINAL_SESSIONS {
                return Err(format!(
                    "终端最多同时运行 {MAX_TERMINAL_SESSIONS} 个会话，请先关闭不需要的标签。"
                ));
            }
            match active_sessions.compare_exchange_weak(
                current,
                current + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => {
                    return Ok(Self {
                        active_sessions,
                        committed: false,
                    });
                }
                Err(actual) => current = actual,
            }
        }
    }

    fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for TerminalSessionReservation {
    fn drop(&mut self) {
        if !self.committed {
            self.active_sessions.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

impl TerminalState {
    pub fn close_all(&self) {
        let sessions = self
            .sessions
            .lock()
            .map(|mut sessions| {
                sessions
                    .drain()
                    .map(|(_, session)| session)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        // 在会话表锁外释放资源，避免结束进程和清理文件时阻塞其他会话。
        drop(sessions);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: String,
    data: Vec<u8>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    session_id: String,
}

#[tauri::command]
pub fn terminal_stage_script(source: String) -> Result<String, String> {
    if source.as_bytes().len() > MAX_TERMINAL_SCRIPT_BYTES {
        return Err("终端脚本不能超过 40 KB。".to_string());
    }
    let path = std::env::temp_dir().join(format!("seamind-terminal-{}.ps1", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "无法创建临时终端脚本。".to_string())?;
    file.write_all(&[0xEF, 0xBB, 0xBF])
        .and_then(|_| file.write_all(source.as_bytes()))
        .map_err(|_| {
            let _ = std::fs::remove_file(&path);
            "无法写入临时终端脚本。".to_string()
        })?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn terminal_remove_script(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let temp_directory = std::env::temp_dir()
        .canonicalize()
        .map_err(|_| "无法访问临时目录。".to_string())?;
    let parent = path
        .parent()
        .and_then(|parent| parent.canonicalize().ok())
        .ok_or_else(|| "临时脚本路径无效。".to_string())?;
    if parent != temp_directory
        || !file_name.starts_with("seamind-terminal-")
        || !file_name.ends_with(".ps1")
    {
        return Err("拒绝删除临时目录以外的文件。".to_string());
    }
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("无法清理临时终端脚本。".to_string()),
    }
}

fn terminal_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.clamp(1, 200),
        cols: cols.clamp(2, 500),
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalShellOption {
    pub id: String,
    pub name: String,
    pub badge: String,
    pub description: String,
    pub available: bool,
}

#[tauri::command]
pub fn terminal_detect_shells() -> Vec<TerminalShellOption> {
    let mut list = Vec::new();
    list.push(TerminalShellOption {
        id: "powershell".to_string(),
        name: "PowerShell".to_string(),
        badge: "PWSH".to_string(),
        description: "Windows 宿主终端，已预注入 Seamind MCP 智能体环境".to_string(),
        available: true,
    });

    #[cfg(windows)]
    {
        let git_bash_exists = PathBuf::from(r"C:\Program Files\Git\bin\bash.exe").exists()
            || PathBuf::from(r"C:\Program Files (x86)\Git\bin\bash.exe").exists();
        list.push(TerminalShellOption {
            id: "bash".to_string(),
            name: "Git Bash".to_string(),
            badge: "BASH".to_string(),
            description: if git_bash_exists {
                "GNU Bash 环境，内置 Linux 常用工具链".to_string()
            } else {
                "未检测到 Git for Windows 安装路径".to_string()
            },
            available: git_bash_exists,
        });

        let wsl_path = PathBuf::from(r"C:\Windows\System32\wsl.exe");
        let wsl_exists = wsl_path.exists();
        list.push(TerminalShellOption {
            id: "wsl".to_string(),
            name: "WSL Linux".to_string(),
            badge: "WSL".to_string(),
            description: if wsl_exists {
                "已检测到 wsl.exe；可用发行版将在会话启动时确认".to_string()
            } else {
                "未开启或未安装 WSL".to_string()
            },
            available: wsl_exists,
        });

        list.push(TerminalShellOption {
            id: "cmd".to_string(),
            name: "Command Prompt".to_string(),
            badge: "CMD".to_string(),
            description: "Windows 经典命令行外壳".to_string(),
            available: true,
        });
    }

    #[cfg(not(windows))]
    {
        list.push(TerminalShellOption {
            id: "bash".to_string(),
            name: "Bash / Zsh".to_string(),
            badge: "UNIX".to_string(),
            description: "原生 Unix 命令行".to_string(),
            available: true,
        });
    }

    list
}

#[tauri::command]
pub fn terminal_start(
    app: AppHandle,
    state: State<'_, TerminalState>,
    agent_bridge: State<'_, AgentBridgeState>,
    cwd: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
) -> Result<String, String> {
    let requested_path = if cwd.trim().is_empty() {
        std::env::current_dir().map_err(|_| "无法读取当前工作目录。".to_string())?
    } else {
        PathBuf::from(cwd.trim())
    };
    let raw_directory = requested_path
        .canonicalize()
        .map_err(|_| "终端工作目录不存在或无法访问。".to_string())?;
    let working_directory = crate::c_runner::normalize_windows_path(&raw_directory);
    if !working_directory.is_dir() {
        return Err("终端工作目录必须是文件夹。".to_string());
    }
    let reservation = TerminalSessionReservation::reserve(state.active_sessions.clone())?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(terminal_size(cols, rows))
        .map_err(|error| format!("创建终端失败：{error}"))?;

    let cli_session = agent_bridge.create_cli_session()?;
    let mcp_config_path = cli_session.config_path.clone();
    let agy_workspace_dir = cli_session.agy_workspace_dir.clone();
    let cleanup_paths = vec![mcp_config_path.clone(), agy_workspace_dir.clone()];

    #[cfg(windows)]
    let mut command = match shell.as_deref() {
        Some("wsl") => {
            let mut cmd = CommandBuilder::new("wsl.exe");
            cmd.arg("--cd");
            cmd.arg(&working_directory);
            cmd
        }
        Some("bash") => {
            let git_bash = PathBuf::from(r"C:\Program Files\Git\bin\bash.exe");
            let bash_bin = if git_bash.exists() {
                git_bash
            } else {
                PathBuf::from("bash.exe")
            };
            let mut cmd = CommandBuilder::new(bash_bin);
            cmd.arg("-l");
            cmd
        }
        Some("cmd") => {
            let cmd = CommandBuilder::new("cmd.exe");
            cmd
        }
        _ => {
            let mut command = CommandBuilder::new("powershell.exe");
            command.arg("-NoLogo");
            command.arg("-NoExit");
            command.arg("-Command");
            command.arg(create_powershell_bootstrap(
                &mcp_config_path,
                &agy_workspace_dir,
                &cli_session.endpoint,
            ));
            command
        }
    };
    #[cfg(not(windows))]
    let mut command = {
        let shell_bin = shell
            .unwrap_or_else(|| std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string()));
        let mut command = CommandBuilder::new(shell_bin);
        command.arg("-l");
        command
    };
    command.cwd(working_directory);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    let config_path_text = mcp_config_path.to_string_lossy().to_string();
    let agy_dir_text = agy_workspace_dir.to_string_lossy().to_string();
    command.env("SEAMIND_AGY_DIR", &agy_dir_text);
    command.env("SEAMIND_CLAUDE_MCP_CONFIG", &config_path_text);
    command.env("GEMINI_CLI_SYSTEM_DEFAULTS_PATH", &config_path_text);
    command.env("SEAMIND_MCP_URL", &cli_session.endpoint);
    command.env("SEAMIND_MCP_TOKEN", &cli_session.token);

    let mut child = match pair.slave.spawn_command(command) {
        Ok(child) => child,
        Err(error) => {
            remove_temp_files(&cleanup_paths);
            return Err(format!("启动终端 Shell 失败：{error}"));
        }
    };
    let killer = child.clone_killer();
    let mut reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let mut killer = killer;
            let _ = killer.kill();
            remove_temp_files(&cleanup_paths);
            return Err(format!("读取终端输出失败：{error}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let mut killer = killer;
            let _ = killer.kill();
            remove_temp_files(&cleanup_paths);
            return Err(format!("初始化终端输入失败：{error}"));
        }
    };
    drop(pair.slave);

    let session_id = Uuid::new_v4().to_string();
    let sessions = state.sessions.clone();
    let mut session_map = match sessions.lock() {
        Ok(sessions) => sessions,
        Err(_) => {
            let mut killer = killer;
            let _ = killer.kill();
            remove_temp_files(&cleanup_paths);
            return Err("终端会话状态不可用。".to_string());
        }
    };
    session_map.insert(
        session_id.clone(),
        TerminalSession {
            writer: Arc::new(Mutex::new(writer)),
            master: Arc::new(Mutex::new(pair.master)),
            killer,
            cleanup_paths,
            active_sessions: state.active_sessions.clone(),
        },
    );
    drop(session_map);
    reservation.commit();

    let output_app = app.clone();
    let output_session_id = session_id.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(length) => {
                    let _ = output_app.emit(
                        "seamind-terminal-output",
                        TerminalOutput {
                            session_id: output_session_id.clone(),
                            data: buffer[..length].to_vec(),
                        },
                    );
                }
            }
        }
    });

    let exit_session_id = session_id.clone();
    let cleanup_session_id = session_id.clone();
    thread::spawn(move || {
        let _ = child.wait();
        let _ = app.emit(
            "seamind-terminal-exit",
            TerminalExit {
                session_id: exit_session_id,
            },
        );
        let finished_session = sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(&cleanup_session_id));
        drop(finished_session);
    });

    Ok(session_id)
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, TerminalState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    if data.len() > MAX_TERMINAL_INPUT_BYTES {
        return Err("单次终端输入不能超过 64 KB。".to_string());
    }
    let writer = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "终端会话状态不可用。".to_string())?;
        sessions
            .get(&session_id)
            .map(|session| session.writer.clone())
            .ok_or_else(|| "终端会话已经关闭。".to_string())?
    };
    let mut writer = writer
        .lock()
        .map_err(|_| "终端会话输入通道不可用。".to_string())?;
    writer
        .write_all(&data)
        .and_then(|_| writer.flush())
        .map_err(|error| format!("发送终端输入失败：{error}"))
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, TerminalState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let master = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "终端会话状态不可用。".to_string())?;
        sessions
            .get(&session_id)
            .map(|session| session.master.clone())
            .ok_or_else(|| "终端会话已经关闭。".to_string())?
    };
    let master = master
        .lock()
        .map_err(|_| "终端会话控制通道不可用。".to_string())?;
    master
        .resize(terminal_size(cols, rows))
        .map_err(|error| format!("调整终端大小失败：{error}"))
}

#[tauri::command]
pub fn terminal_close(state: State<'_, TerminalState>, session_id: String) -> Result<(), String> {
    let session = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "终端会话状态不可用。".to_string())?;
        sessions.remove(&session_id)
    };
    drop(session);
    Ok(())
}

#[cfg(windows)]
fn create_powershell_bootstrap(
    config_path: &PathBuf,
    agy_workspace_dir: &PathBuf,
    endpoint: &str,
) -> String {
    let config_path = config_path.to_string_lossy().replace('\'', "''");
    let agy_dir = agy_workspace_dir.to_string_lossy().replace('\'', "''");
    let endpoint = endpoint.replace('\'', "''");
    format!(
        r#"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null; $env:SEAMIND_AGY_DIR = '{agy_dir}'; $env:SEAMIND_CLAUDE_MCP_CONFIG = '{config_path}'; $env:GEMINI_CLI_SYSTEM_DEFAULTS_PATH = '{config_path}'; $env:SEAMIND_MCP_URL = '{endpoint}'; function global:Resolve-SeamindAgyPath {{ $cmd = Get-Command agy -All -ErrorAction SilentlyContinue | Where-Object {{ $_.CommandType -in @('Application', 'ExternalScript') }} | Select-Object -First 1; if ($cmd) {{ return $cmd.Source }}; foreach ($candidate in @("$env:LOCALAPPDATA\agy\bin\agy.exe", "$env:LOCALAPPDATA\agy\bin\agy.cmd", "$env:USERPROFILE\.gemini\antigravity\bin\agy.exe", "$env:USERPROFILE\.gemini\antigravity\bin\agy.cmd", "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\agy.cmd", "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\agy.exe")) {{ if ($candidate -and (Test-Path -LiteralPath $candidate)) {{ return $candidate }} }}; return $null }}; function global:seamind-agy {{ $exe = Resolve-SeamindAgyPath; if (-not $exe) {{ Write-Error 'Google Antigravity CLI (agy) 未安装或不在 PATH 中。'; return }}; if ($args.Count -gt 0 -and $args[0] -in @('mcp', 'plugin', 'auth', 'login', 'logout', 'update', 'upgrade', 'help', 'version', '--help', '-h', '--version', '-v')) {{ & $exe @args; return }}; & $exe --add-dir $env:SEAMIND_AGY_DIR @args }}; function global:agy {{ seamind-agy @args }}; $global:SeamindClaudeExecutable = Get-Command claude -All -ErrorAction SilentlyContinue | Where-Object {{ $_.CommandType -in @('Application', 'ExternalScript') }} | Select-Object -First 1; function global:seamind-claude {{ if (-not $global:SeamindClaudeExecutable) {{ Write-Error 'Claude Code CLI 未安装或不在 PATH 中。'; return }}; & $global:SeamindClaudeExecutable.Source --mcp-config $env:SEAMIND_CLAUDE_MCP_CONFIG @args }}; function global:claude {{ seamind-claude @args }}; $global:SeamindCodexExecutable = Get-Command codex -All -ErrorAction SilentlyContinue | Where-Object {{ $_.CommandType -in @('Application', 'ExternalScript') }} | Select-Object -First 1; function global:seamind-codex {{ if (-not $global:SeamindCodexExecutable) {{ Write-Error 'Codex CLI 未安装或不在 PATH 中。'; return }}; & $global:SeamindCodexExecutable.Source -c "mcp_servers.seamind.url=""$env:SEAMIND_MCP_URL""" -c 'mcp_servers.seamind.bearer_token_env_var="SEAMIND_MCP_TOKEN"' @args }}; function global:codex {{ seamind-codex @args }}; Write-Host 'Seamind MCP 已接入当前终端会话。运行 agy / claude / codex 即可调用导图、知识库与播放器学习路径工具。' -ForegroundColor DarkCyan"#
    )
}

fn remove_temp_files(paths: &[PathBuf]) {
    for path in paths {
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(path);
        } else {
            let _ = std::fs::remove_file(path);
        }
    }
}
