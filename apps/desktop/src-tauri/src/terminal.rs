use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

const MAX_TERMINAL_INPUT_BYTES: usize = 65_536;

#[derive(Default, Clone)]
pub struct TerminalState {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
}

struct TerminalSession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
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

fn terminal_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.clamp(1, 200),
        cols: cols.clamp(2, 500),
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[tauri::command]
pub fn terminal_start(
    app: AppHandle,
    state: State<'_, TerminalState>,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let requested_path = if cwd.trim().is_empty() {
        std::env::current_dir().map_err(|_| "无法读取当前工作目录。".to_string())?
    } else {
        PathBuf::from(cwd.trim())
    };
    let working_directory = requested_path
        .canonicalize()
        .map_err(|_| "终端工作目录不存在或无法访问。".to_string())?;
    if !working_directory.is_dir() {
        return Err("终端工作目录必须是文件夹。".to_string());
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(terminal_size(cols, rows))
        .map_err(|error| format!("创建终端失败：{error}"))?;

    #[cfg(windows)]
    let mut command = {
        let mut command = CommandBuilder::new("powershell.exe");
        command.arg("-NoLogo");
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut command = CommandBuilder::new(shell);
        command.arg("-l");
        command
    };
    command.cwd(working_directory);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("启动终端 Shell 失败：{error}"))?;
    let killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("读取终端输出失败：{error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("初始化终端输入失败：{error}"))?;
    drop(pair.slave);

    let session_id = Uuid::new_v4().to_string();
    let sessions = state.sessions.clone();
    sessions
        .lock()
        .map_err(|_| "终端会话状态不可用。".to_string())?
        .insert(
            session_id.clone(),
            TerminalSession {
                writer,
                master: pair.master,
                killer,
            },
        );

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
        if let Ok(mut sessions) = sessions.lock() {
            sessions.remove(&cleanup_session_id);
        }
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
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "终端会话状态不可用。".to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "终端会话已经关闭。".to_string())?;
    session
        .writer
        .write_all(&data)
        .and_then(|_| session.writer.flush())
        .map_err(|error| format!("发送终端输入失败：{error}"))
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, TerminalState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "终端会话状态不可用。".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "终端会话已经关闭。".to_string())?;
    session
        .master
        .resize(terminal_size(cols, rows))
        .map_err(|error| format!("调整终端大小失败：{error}"))
}

#[tauri::command]
pub fn terminal_close(state: State<'_, TerminalState>, session_id: String) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "终端会话状态不可用。".to_string())?;
    if let Some(mut session) = sessions.remove(&session_id) {
        let _ = session.killer.kill();
    }
    Ok(())
}
