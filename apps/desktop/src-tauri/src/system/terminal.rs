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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalCwdEvent {
    session_id: String,
    cwd: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalBellEvent {
    session_id: String,
}

const MAX_OUTPUT_BATCH_BYTES: usize = 32_768;
const OUTPUT_COALESCE_WINDOW_MS: u64 = 4;
const BELL_THROTTLE_MS: u64 = 450;

#[derive(Clone, Copy, PartialEq, Eq)]
enum OscScanState {
    Normal,
    Esc,
    Osc,
    OscEsc,
}

struct OscTelemetryScanner {
    state: OscScanState,
    osc_buf: Vec<u8>,
}

impl OscTelemetryScanner {
    fn new() -> Self {
        Self {
            state: OscScanState::Normal,
            osc_buf: Vec::with_capacity(256),
        }
    }

    fn feed(&mut self, bytes: &[u8]) -> (Option<String>, bool) {
        let mut latest_cwd: Option<String> = None;
        let mut rang_bell = false;

        for &b in bytes {
            match self.state {
                OscScanState::Normal => {
                    if b == 0x1b {
                        self.state = OscScanState::Esc;
                    } else if b == 0x07 {
                        rang_bell = true;
                    }
                }
                OscScanState::Esc => {
                    if b == b']' {
                        self.state = OscScanState::Osc;
                        self.osc_buf.clear();
                    } else if b == 0x1b {
                        self.state = OscScanState::Esc;
                    } else {
                        self.state = OscScanState::Normal;
                    }
                }
                OscScanState::Osc => {
                    if b == 0x07 {
                        if let Some(cwd) = parse_osc7_payload(&self.osc_buf) {
                            latest_cwd = Some(cwd);
                        }
                        self.osc_buf.clear();
                        self.state = OscScanState::Normal;
                    } else if b == 0x1b {
                        self.state = OscScanState::OscEsc;
                    } else if self.osc_buf.len() < 1024 {
                        self.osc_buf.push(b);
                    }
                }
                OscScanState::OscEsc => {
                    if b == b'\\' {
                        if let Some(cwd) = parse_osc7_payload(&self.osc_buf) {
                            latest_cwd = Some(cwd);
                        }
                        self.osc_buf.clear();
                        self.state = OscScanState::Normal;
                    } else {
                        self.osc_buf.clear();
                        self.state = if b == b']' {
                            OscScanState::Osc
                        } else if b == 0x1b {
                            OscScanState::Esc
                        } else {
                            OscScanState::Normal
                        };
                    }
                }
            }
        }

        (latest_cwd, rang_bell)
    }
}

fn strip_windows_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

fn parse_osc7_payload(payload: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(payload).ok()?;
    let rest = text.strip_prefix("7;")?;
    let trimmed = rest.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("file://") {
        let parsed = url::Url::parse(trimmed).ok()?;
        if let Ok(path_buf) = parsed.to_file_path() {
            return Some(strip_windows_verbatim_prefix(&path_buf.to_string_lossy()));
        }
        // 兼容在 Windows 上运行 WSL/Linux shell 时发出的类 Unix OSC 7 路径
        return Some(parsed.path().to_string());
    }
    Some(strip_windows_verbatim_prefix(trimmed))
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

fn terminal_size(
    cols: u16,
    rows: u16,
    pixel_width: Option<u16>,
    pixel_height: Option<u16>,
) -> PtySize {
    PtySize {
        rows: rows.clamp(1, 200),
        cols: cols.clamp(2, 500),
        pixel_width: pixel_width.unwrap_or(0),
        pixel_height: pixel_height.unwrap_or(0),
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
    pixel_width: Option<u16>,
    pixel_height: Option<u16>,
    shell: Option<String>,
) -> Result<String, String> {
    let requested_path = if cwd.trim().is_empty() {
        std::env::current_dir().map_err(|_| "无法读取当前工作目录。".to_string())?
    } else {
        PathBuf::from(strip_windows_verbatim_prefix(cwd.trim()))
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
        .openpty(terminal_size(cols, rows, pixel_width, pixel_height))
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

    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(64);
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(length) => {
                    if tx.send(buffer[..length].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let output_app = app.clone();
    let output_session_id = session_id.clone();
    thread::spawn(move || {
        let mut scanner = OscTelemetryScanner::new();
        let mut last_cwd: Option<String> = None;
        let mut last_bell: Option<std::time::Instant> = None;
        let coalesce_window = std::time::Duration::from_millis(OUTPUT_COALESCE_WINDOW_MS);
        let bell_throttle = std::time::Duration::from_millis(BELL_THROTTLE_MS);

        while let Ok(first) = rx.recv() {
            let mut batch = first;
            if batch.len() < MAX_OUTPUT_BATCH_BYTES {
                let deadline = std::time::Instant::now() + coalesce_window;
                loop {
                    match rx.try_recv() {
                        Ok(more) => {
                            batch.extend_from_slice(&more);
                            if batch.len() >= MAX_OUTPUT_BATCH_BYTES {
                                break;
                            }
                        }
                        Err(std::sync::mpsc::TryRecvError::Empty) => {
                            if batch.len() < 512 {
                                // 按键回显等小包零延迟直发
                                break;
                            }
                            let remaining =
                                deadline.saturating_duration_since(std::time::Instant::now());
                            if remaining.is_zero() {
                                break;
                            }
                            match rx.recv_timeout(remaining) {
                                Ok(more) => {
                                    batch.extend_from_slice(&more);
                                    if batch.len() >= MAX_OUTPUT_BATCH_BYTES {
                                        break;
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                        Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
                    }
                }
            }

            let (cwd_update, rang_bell) = scanner.feed(&batch);
            let _ = output_app.emit(
                "seamind-terminal-output",
                TerminalOutput {
                    session_id: output_session_id.clone(),
                    data: batch,
                },
            );
            if let Some(next_cwd) = cwd_update {
                if last_cwd.as_deref() != Some(next_cwd.as_str()) {
                    last_cwd = Some(next_cwd.clone());
                    let _ = output_app.emit(
                        "seamind-terminal-cwd",
                        TerminalCwdEvent {
                            session_id: output_session_id.clone(),
                            cwd: next_cwd,
                        },
                    );
                }
            }
            if rang_bell {
                let now = std::time::Instant::now();
                let should_emit = last_bell
                    .map(|prev| now.duration_since(prev) >= bell_throttle)
                    .unwrap_or(true);
                if should_emit {
                    last_bell = Some(now);
                    let _ = output_app.emit(
                        "seamind-terminal-bell",
                        TerminalBellEvent {
                            session_id: output_session_id.clone(),
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
    pixel_width: Option<u16>,
    pixel_height: Option<u16>,
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
        .resize(terminal_size(cols, rows, pixel_width, pixel_height))
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
        r#"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null; $env:SEAMIND_AGY_DIR = '{agy_dir}'; $env:SEAMIND_CLAUDE_MCP_CONFIG = '{config_path}'; $env:GEMINI_CLI_SYSTEM_DEFAULTS_PATH = '{config_path}'; $env:SEAMIND_MCP_URL = '{endpoint}'; function global:Resolve-SeamindAgyPath {{ $cmd = Get-Command agy -All -ErrorAction SilentlyContinue | Where-Object {{ $_.CommandType -in @('Application', 'ExternalScript') }} | Select-Object -First 1; if ($cmd) {{ return $cmd.Source }}; foreach ($candidate in @("$env:LOCALAPPDATA\agy\bin\agy.exe", "$env:LOCALAPPDATA\agy\bin\agy.cmd", "$env:USERPROFILE\.gemini\antigravity\bin\agy.exe", "$env:USERPROFILE\.gemini\antigravity\bin\agy.cmd", "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\agy.cmd", "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\agy.exe")) {{ if ($candidate -and (Test-Path -LiteralPath $candidate)) {{ return $candidate }} }}; return $null }}; function global:seamind-agy {{ $exe = Resolve-SeamindAgyPath; if (-not $exe) {{ Write-Error 'Google Antigravity CLI (agy) 未安装或不在 PATH 中。'; return }}; if ($args.Count -gt 0 -and $args[0] -in @('mcp', 'plugin', 'auth', 'login', 'logout', 'update', 'upgrade', 'help', 'version', '--help', '-h', '--version', '-v')) {{ & $exe @args; return }}; & $exe --add-dir $env:SEAMIND_AGY_DIR @args }}; function global:agy {{ seamind-agy @args }}; $global:SeamindClaudeExecutable = Get-Command claude -All -ErrorAction SilentlyContinue | Where-Object {{ $_.CommandType -in @('Application', 'ExternalScript') }} | Select-Object -First 1; function global:seamind-claude {{ if (-not $global:SeamindClaudeExecutable) {{ Write-Error 'Claude Code CLI 未安装或不在 PATH 中。'; return }}; & $global:SeamindClaudeExecutable.Source --mcp-config $env:SEAMIND_CLAUDE_MCP_CONFIG @args }}; function global:claude {{ seamind-claude @args }}; $global:SeamindCodexExecutable = Get-Command codex -All -ErrorAction SilentlyContinue | Where-Object {{ $_.CommandType -in @('Application', 'ExternalScript') }} | Select-Object -First 1; function global:seamind-codex {{ if (-not $global:SeamindCodexExecutable) {{ Write-Error 'Codex CLI 未安装或不在 PATH 中。'; return }}; & $global:SeamindCodexExecutable.Source -c "mcp_servers.seamind.url=""$env:SEAMIND_MCP_URL""" -c 'mcp_servers.seamind.bearer_token_env_var="SEAMIND_MCP_TOKEN"' @args }}; function global:codex {{ seamind-codex @args }}; $global:__SeamindOrigPrompt = $function:prompt; function global:prompt {{ try {{ if ($PWD.Provider.Name -eq 'FileSystem') {{ [Console]::Write(([char]27) + ']7;' + ([System.Uri]::new($PWD.ProviderPath)).AbsoluteUri + ([char]7)) }} }} catch {{}}; if ($global:__SeamindOrigPrompt) {{ & $global:__SeamindOrigPrompt }} else {{ "PS $PWD> " }} }}; Write-Host 'Seamind MCP 已接入当前终端会话。运行 agy / claude / codex 即可调用导图、知识库与播放器学习路径工具。' -ForegroundColor DarkCyan"#
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osc_scanner_parses_split_osc7_cwd_and_distinguishes_bell() {
        let mut scanner = OscTelemetryScanner::new();
        let (cwd1, bell1) = scanner.feed(b"\x1b]7;file:///C:/Users/l8453/Desk");
        assert_eq!(cwd1, None);
        assert!(!bell1);

        let (cwd2, bell2) = scanner.feed(b"top/books\x07PS> \x07");
        assert!(bell2);
        let cwd_text = cwd2.expect("cwd should parse");
        assert!(cwd_text.ends_with("books"), "unexpected cwd: {cwd_text}");

        // ST 结束符 (\x1b\) 也应正确解析且不触发铃声
        let (cwd3, bell3) = scanner.feed(b"\x1b]7;file://wsl/home/demo\x1b\\ok");
        assert!(!bell3);
        assert!(cwd3.as_deref().unwrap_or_default().ends_with("demo"));

        // 无 host 的 Unix 路径在 Windows 宿主下回退保留 /path
        let (cwd4, bell4) = scanner.feed(b"\x1b]7;file:///var/log/app\x1b\\");
        assert!(!bell4);
        assert_eq!(cwd4.as_deref(), Some("/var/log/app"));
    }

    #[test]
    fn strip_windows_verbatim_handles_local_and_unc_paths() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\Users\l8453\Desktop\books"),
            r"C:\Users\l8453\Desktop\books"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\UNC\server\share\dir"),
            r"\\server\share\dir"
        );
    }
}
