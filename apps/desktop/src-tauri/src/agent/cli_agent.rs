use crate::agent_bridge::{AgentBridgeState, CliMcpSession};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

const MAX_CLI_PROMPT_CHARS: usize = 64_000;
const CLI_RUN_TIMEOUT_SECS: u64 = 180;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliEngineStatus {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub path: Option<String>,
    pub hint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliAgentStreamEvent {
    pub run_id: String,
    pub engine: String,
    pub kind: String,
    pub text: String,
    pub tool_name: Option<String>,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliAgentRunResult {
    pub run_id: String,
    pub engine: String,
    pub success: bool,
    pub exit_code: Option<i32>,
    pub reply: String,
    pub stderr: String,
    pub events_count: usize,
    pub duration_ms: u64,
    pub used_mcp: bool,
}

#[derive(Clone)]
pub struct ActiveCliRun {
    pub pid: Option<u32>,
    pub cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct CliAgentState(pub Mutex<HashMap<String, ActiveCliRun>>);

impl CliAgentState {
    pub fn cancel_all(&self) {
        let runs: Vec<ActiveCliRun> = match self.0.lock() {
            Ok(mut guard) => guard.drain().map(|(_, run)| run).collect(),
            Err(_) => return,
        };
        for run in runs {
            run.cancelled.store(true, Ordering::SeqCst);
            if let Some(pid) = run.pid {
                kill_pid_tree(pid);
            }
        }
    }
}

fn kill_pid_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output();
    }
}

fn resolve_cli_binary(engine: &str) -> Option<PathBuf> {
    let candidates: &[&str] = match engine {
        "claude" => {
            if cfg!(windows) {
                &["claude.cmd", "claude.exe", "claude"]
            } else {
                &["claude"]
            }
        }
        "codex" => {
            if cfg!(windows) {
                &["codex.cmd", "codex.exe", "codex"]
            } else {
                &["codex"]
            }
        }
        "agy" => {
            if cfg!(windows) {
                &["agy.cmd", "agy.exe", "agy"]
            } else {
                &["agy"]
            }
        }
        _ => return None,
    };

    let where_cmd = if cfg!(windows) { "where.exe" } else { "which" };
    for name in candidates {
        let mut cmd = std::process::Command::new(where_cmd);
        cmd.arg(name);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                if let Some(first) = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .map(str::trim)
                    .find(|l| !l.is_empty())
                {
                    let p = PathBuf::from(first);
                    if p.exists() {
                        return Some(p);
                    }
                }
            }
        }
    }

    #[cfg(windows)]
    {
        let mut extra_dirs: Vec<PathBuf> = Vec::new();
        if let Some(appdata) = std::env::var_os("APPDATA") {
            extra_dirs.push(PathBuf::from(appdata).join("npm"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let l = PathBuf::from(local);
            extra_dirs.push(l.join("Programs").join("Antigravity").join("bin"));
            extra_dirs.push(l.join("Programs").join("agy").join("bin"));
        }
        if let Some(home) = std::env::var_os("USERPROFILE") {
            let h = PathBuf::from(home);
            extra_dirs.push(h.join(".local").join("bin"));
            extra_dirs.push(h.join(".claude").join("local"));
        }
        for dir in extra_dirs {
            for name in candidates {
                let p = dir.join(name);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }

    None
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Default)]
struct StreamParseAcc {
    assistant_chunks: Vec<String>,
    events_count: usize,
}

fn parse_cli_output_line(
    line: &str,
    acc: &mut StreamParseAcc,
) -> Option<(String, String, Option<String>)> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    acc.events_count += 1;

    if trimmed.starts_with('{') {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
            let typ = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if typ == "result" {
                if let Some(res) = val.get("result").and_then(|v| v.as_str()) {
                    if !res.trim().is_empty() && acc.assistant_chunks.is_empty() {
                        acc.assistant_chunks.push(res.to_string());
                    }
                    return Some(("text".to_string(), res.to_string(), None));
                }
            }
            if typ == "assistant" {
                if let Some(contents) = val
                    .pointer("/message/content")
                    .and_then(|v| v.as_array())
                {
                    let mut text_parts = Vec::new();
                    let mut last_tool = None;
                    for item in contents {
                        match item.get("type").and_then(|v| v.as_str()) {
                            Some("text") => {
                                if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                                    if !t.is_empty() {
                                        acc.assistant_chunks.push(t.to_string());
                                        text_parts.push(t.to_string());
                                    }
                                }
                            }
                            Some("tool_use") => {
                                let name = item
                                    .get("name")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("tool")
                                    .to_string();
                                last_tool = Some(name.clone());
                                text_parts.push(format!("调用工具: {name}"));
                            }
                            _ => {}
                        }
                    }
                    if !text_parts.is_empty() {
                        let kind = if last_tool.is_some() { "tool" } else { "text" };
                        return Some((kind.to_string(), text_parts.join("\n"), last_tool));
                    }
                }
            }
            // Codex `--json` style item.completed
            if typ == "item.completed" {
                if let Some(text) = val.pointer("/item/text").and_then(|v| v.as_str()) {
                    acc.assistant_chunks.push(text.to_string());
                    return Some(("text".to_string(), text.to_string(), None));
                }
                if let Some(cmd) = val.pointer("/item/command").and_then(|v| v.as_str()) {
                    return Some(("tool".to_string(), cmd.to_string(), Some("shell".to_string())));
                }
            }
            if let Some(msg) = val
                .get("delta")
                .or_else(|| val.get("text"))
                .or_else(|| val.get("message"))
                .and_then(|v| v.as_str())
            {
                if !msg.is_empty() {
                    acc.assistant_chunks.push(msg.to_string());
                    return Some(("text".to_string(), msg.to_string(), None));
                }
            }
            return Some(("status".to_string(), trimmed.to_string(), None));
        }
    }

    acc.assistant_chunks.push(trimmed.to_string());
    Some(("text".to_string(), trimmed.to_string(), None))
}

#[tauri::command]
pub fn cli_agent_detect() -> Result<Vec<CliEngineStatus>, String> {
    let specs = [
        (
            "claude",
            "Claude Code CLI",
            "已检测到 claude，可直接无头执行并反向挂载 Seamind MCP 工具。",
            "未检测到 claude（可用 `npm i -g @anthropic-ai/claude-code` 安装）。",
        ),
        (
            "codex",
            "Codex CLI",
            "已检测到 codex，可用于代码重构、沙盒排错与仓库检索协同。",
            "未检测到 codex（可用 `npm i -g @openai/codex` 安装）。",
        ),
        (
            "agy",
            "Antigravity CLI (agy)",
            "已检测到 agy，可注入 Seamind 插件包协作。",
            "未检测到 agy 命令；请在 Antigravity IDE 设置中安装 SHELL 命令。",
        ),
    ];

    Ok(specs
        .into_iter()
        .map(|(id, label, ok_hint, miss_hint)| {
            let path = resolve_cli_binary(id);
            let available = path.is_some();
            CliEngineStatus {
                id: id.to_string(),
                label: label.to_string(),
                available,
                path: path.map(|p| p.to_string_lossy().to_string()),
                hint: if available {
                    ok_hint.to_string()
                } else {
                    miss_hint.to_string()
                },
            }
        })
        .collect())
}

fn cleanup_mcp_session(session: Option<CliMcpSession>) {
    if let Some(s) = session {
        let _ = std::fs::remove_file(s.config_path);
        let _ = std::fs::remove_dir_all(s.agy_workspace_dir);
    }
}

#[tauri::command]
pub async fn cli_agent_run(
    app: AppHandle,
    state: State<'_, CliAgentState>,
    agent_bridge: State<'_, AgentBridgeState>,
    run_id: String,
    engine: String,
    prompt: String,
    system_prompt: Option<String>,
    cwd: Option<String>,
    attach_mcp: Option<bool>,
) -> Result<CliAgentRunResult, String> {
    let engine_id = engine.trim().to_lowercase();
    if !matches!(engine_id.as_str(), "claude" | "codex" | "agy") {
        return Err(format!("不支持的 CLI 引擎：{engine}"));
    }
    let prompt_trimmed = prompt.trim();
    if prompt_trimmed.is_empty() {
        return Err("发送给 CLI 的指令不能为空。".to_string());
    }
    if prompt_trimmed.chars().count() > MAX_CLI_PROMPT_CHARS {
        return Err("发送给 CLI 的上下文超出长度上限。".to_string());
    }

    let bin_path = resolve_cli_binary(&engine_id).ok_or_else(|| {
        format!("本机未找到 `{engine_id}` CLI，请先安装并在终端完成登录认证。")
    })?;

    let combined_prompt = match system_prompt.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(sys) => format!("[系统约定]\n{sys}\n\n[任务]\n{prompt_trimmed}"),
        None => prompt_trimmed.to_string(),
    };

    let want_mcp = attach_mcp.unwrap_or(true);
    let mcp_session = if want_mcp {
        agent_bridge.create_cli_session().ok()
    } else {
        None
    };

    let mut args: Vec<String> = Vec::new();
    match engine_id.as_str() {
        "claude" => {
            args.push("-p".to_string());
            args.push(combined_prompt);
            args.push("--output-format".to_string());
            args.push("stream-json".to_string());
            args.push("--verbose".to_string());
            if let Some(ref s) = mcp_session {
                args.push("--mcp-config".to_string());
                args.push(s.config_path.to_string_lossy().to_string());
            }
        }
        "codex" => {
            args.push("exec".to_string());
            args.push("--json".to_string());
            args.push(combined_prompt);
        }
        _ => {
            // agy headless attempt: pass prompt cleanly; falls back clearly if interactive-only
            args.push("-p".to_string());
            args.push(combined_prompt);
        }
    }

    let is_cmd_wrapper = cfg!(windows)
        && bin_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
            .unwrap_or(false);

    let mut cmd = if is_cmd_wrapper {
        let mut c = Command::new("cmd.exe");
        c.arg("/d").arg("/c").arg(&bin_path).args(&args);
        c
    } else {
        let mut c = Command::new(&bin_path);
        c.args(&args);
        c
    };

    if let Some(dir) = cwd.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(dir.trim_start_matches("\\\\?\\"));
        if p.is_dir() {
            cmd.current_dir(p);
        }
    } else if let Some(ref s) = mcp_session {
        if engine_id == "agy" && s.agy_workspace_dir.is_dir() {
            cmd.current_dir(&s.agy_workspace_dir);
        }
    }

    if let Some(ref s) = mcp_session {
        cmd.env("SEAMIND_MCP_ENDPOINT", &s.endpoint);
        cmd.env("SEAMIND_MCP_TOKEN", &s.token);
        cmd.env("SEAMIND_MCP_CONFIG", s.config_path.to_string_lossy().to_string());
    }

    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    let start_time = std::time::Instant::now();
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            cleanup_mcp_session(mcp_session);
            return Err(format!("启动 {engine_id} 进程失败：{e}"));
        }
    };

    let pid = child.id();
    let cancelled_flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut guard) = state.0.lock() {
        guard.insert(
            run_id.clone(),
            ActiveCliRun {
                pid,
                cancelled: cancelled_flag.clone(),
            },
        );
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let app_clone = app.clone();
    let run_id_clone = run_id.clone();
    let engine_clone = engine_id.clone();

    let stdout_task = tokio::spawn(async move {
        let mut acc = StreamParseAcc::default();
        if let Some(stream) = stdout {
            let mut lines = BufReader::new(stream).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some((kind, text, tool_name)) = parse_cli_output_line(&line, &mut acc) {
                    let _ = app_clone.emit(
                        "seamind-cli-agent-event",
                        CliAgentStreamEvent {
                            run_id: run_id_clone.clone(),
                            engine: engine_clone.clone(),
                            kind,
                            text,
                            tool_name,
                            timestamp_ms: now_ms(),
                        },
                    );
                }
            }
        }
        acc
    });

    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        if let Some(stream) = stderr {
            let mut lines = BufReader::new(stream).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if buf.len() < 24_000 {
                    buf.push_str(&line);
                    buf.push('\n');
                }
            }
        }
        buf
    });

    let status_res = tokio::time::timeout(
        std::time::Duration::from_secs(CLI_RUN_TIMEOUT_SECS),
        child.wait(),
    )
    .await;

    let timed_out = status_res.is_err();
    let exit_code = match status_res {
        Ok(Ok(status)) => status.code(),
        Ok(Err(_)) => None,
        Err(_) => {
            if let Some(p) = pid {
                kill_pid_tree(p);
            }
            let _ = child.start_kill();
            None
        }
    };

    if let Ok(mut guard) = state.0.lock() {
        guard.remove(&run_id);
    }

    let acc = stdout_task.await.unwrap_or_default();
    let mut stderr_text = stderr_task.await.unwrap_or_default();
    if timed_out {
        stderr_text.push_str(&format!(
            "\n[执行超时] 超过 {CLI_RUN_TIMEOUT_SECS} 秒已自动中断。"
        ));
    }
    if cancelled_flag.load(Ordering::SeqCst) {
        stderr_text.push_str("\n[已由用户手动终止]");
    }

    let used_mcp = mcp_session.is_some();
    cleanup_mcp_session(mcp_session);

    let success = !timed_out && !cancelled_flag.load(Ordering::SeqCst) && exit_code == Some(0);
    let reply = acc.assistant_chunks.join("\n").trim().to_string();

    Ok(CliAgentRunResult {
        run_id,
        engine: engine_id,
        success,
        exit_code,
        reply,
        stderr: stderr_text.trim().to_string(),
        events_count: acc.events_count,
        duration_ms: start_time.elapsed().as_millis() as u64,
        used_mcp,
    })
}

#[tauri::command]
pub fn cli_agent_cancel(state: State<'_, CliAgentState>, run_id: String) -> Result<(), String> {
    let run = state
        .0
        .lock()
        .map_err(|_| "CLI Agent 状态不可用。".to_string())?
        .remove(&run_id);
    if let Some(active) = run {
        active.cancelled.store(true, Ordering::SeqCst);
        if let Some(pid) = active.pid {
            kill_pid_tree(pid);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_stream_json_text_and_tool_use() {
        let mut acc = StreamParseAcc::default();
        let line1 = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mindmap_get_current","input":{}}]}}"#;
        let parsed1 = parse_cli_output_line(line1, &mut acc).expect("should parse tool_use");
        assert_eq!(parsed1.0, "tool");
        assert_eq!(parsed1.2.as_deref(), Some("mindmap_get_current"));

        let line2 = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"导图核心结论如下"}]}}"#;
        let parsed2 = parse_cli_output_line(line2, &mut acc).expect("should parse text");
        assert_eq!(parsed2.0, "text");
        assert_eq!(parsed2.1, "导图核心结论如下");
        assert_eq!(acc.assistant_chunks, vec!["导图核心结论如下"]);
    }

    #[test]
    fn parses_plain_text_fallback_lines() {
        let mut acc = StreamParseAcc::default();
        let parsed = parse_cli_output_line("hello from cli", &mut acc).unwrap();
        assert_eq!(parsed.0, "text");
        assert_eq!(parsed.1, "hello from cli");
        assert_eq!(acc.events_count, 1);
    }
}
