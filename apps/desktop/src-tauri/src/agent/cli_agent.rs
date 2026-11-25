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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliModelOption {
    pub id: String,
    pub label: String,
    pub family: String,
    pub tier: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliModelsCatalog {
    pub engine: String,
    pub current_default: Option<String>,
    pub models: Vec<String>,
    pub options: Vec<CliModelOption>,
    pub source: String,
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
        "gemini" => {
            if cfg!(windows) {
                &["gemini.cmd", "gemini.exe", "gemini"]
            } else {
                &["gemini"]
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
            // Gemini CLI `--output-format stream-json` events
            if typ == "message" {
                let role = val.get("role").and_then(|v| v.as_str()).unwrap_or("");
                if role == "assistant" {
                    if let Some(content) = val.get("content").and_then(|v| v.as_str()) {
                        if !content.is_empty() {
                            acc.assistant_chunks.push(content.to_string());
                            return Some(("text".to_string(), content.to_string(), None));
                        }
                    }
                }
            }
            if typ == "tool_use" {
                let name = val
                    .get("tool_name")
                    .or_else(|| val.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool")
                    .to_string();
                return Some(("tool".to_string(), format!("调用工具: {name}"), Some(name)));
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
            "agy",
            "Antigravity CLI (agy)",
            "已检测到 agy，支持切换谷歌/多模型并自动挂载 Seamind MCP。",
            "未检测到 agy 命令；请在 Antigravity IDE 设置中安装 SHELL 命令。",
        ),
        (
            "gemini",
            "Google Gemini CLI",
            "已检测到 gemini，支持切换 Gemini 系列模型并自动挂载 Seamind MCP。",
            "未检测到 gemini（可用 `npm i -g @google/gemini-cli` 安装）。",
        ),
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

fn strip_ansi_codes(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

fn read_json_default_model(path: PathBuf) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let val: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if let Some(s) = val.get("model").and_then(|v| v.as_str()) {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(s) = val.pointer("/model/name").and_then(|v| v.as_str()) {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn split_family_and_tier(label: &str) -> (String, Option<String>) {
    let trimmed = label.trim();
    if let Some(open) = trimmed.rfind('(') {
        if trimmed.ends_with(')') && open > 0 {
            let fam = trimmed[..open].trim();
            let tier = trimmed[open + 1..trimmed.len() - 1].trim();
            if !fam.is_empty() && !tier.is_empty() {
                return (fam.to_string(), Some(tier.to_string()));
            }
        }
    }
    (trimmed.to_string(), None)
}

fn parse_agy_model_line(clean: &str) -> Option<CliModelOption> {
    let mut parts = clean.splitn(2, |c: char| c.is_whitespace());
    let first = parts.next()?.trim();
    let rest = parts.next().map(str::trim).unwrap_or("");
    if first.is_empty() {
        return None;
    }
    // Check if first token looks like a slug id (e.g. `gemini-4-neon-high` or `gpt-oss-120b-medium`)
    let is_slug = first.contains('-')
        && first
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if is_slug && !rest.is_empty() {
        // Strip any trailing extra metadata after double-space or tab
        let label = rest.split("  ").next().unwrap_or(rest).trim();
        let (family, tier) = split_family_and_tier(label);
        return Some(CliModelOption {
            id: first.to_string(),
            label: label.to_string(),
            family,
            tier,
        });
    }
    let label = clean.split("  ").next().unwrap_or(clean).trim();
    let (family, tier) = split_family_and_tier(label);
    Some(CliModelOption {
        id: label.to_string(),
        label: label.to_string(),
        family,
        tier,
    })
}

fn make_preset_option(id: &str, label: &str) -> CliModelOption {
    let (family, tier) = split_family_and_tier(label);
    CliModelOption {
        id: id.to_string(),
        label: label.to_string(),
        family,
        tier,
    }
}

#[tauri::command]
pub async fn cli_agent_list_models(engine: String) -> Result<CliModelsCatalog, String> {
    let engine_id = engine.trim().to_lowercase();
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);

    let mut options: Vec<CliModelOption> = Vec::new();
    let mut push_opt = |opt: CliModelOption| {
        if !opt.id.is_empty()
            && !options
                .iter()
                .any(|o| o.id.eq_ignore_ascii_case(&opt.id) || o.label.eq_ignore_ascii_case(&opt.label))
        {
            options.push(opt);
        }
    };

    match engine_id.as_str() {
        "agy" => {
            let current_default = home.as_ref().and_then(|h| {
                read_json_default_model(
                    h.join(".gemini")
                        .join("antigravity-cli")
                        .join("settings.json"),
                )
            });
            let mut source = "presets".to_string();
            let mut found_live = 0usize;
            if let Some(bin) = resolve_cli_binary("agy") {
                let is_cmd = cfg!(windows)
                    && bin
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
                        .unwrap_or(false);
                let mut cmd = if is_cmd {
                    let mut c = Command::new("cmd.exe");
                    c.arg("/d").arg("/c").arg(&bin).arg("models");
                    c
                } else {
                    let mut c = Command::new(&bin);
                    c.arg("models");
                    c
                };
                cmd.stdin(std::process::Stdio::null());
                cmd.stdout(std::process::Stdio::piped());
                cmd.stderr(std::process::Stdio::null());
                #[cfg(windows)]
                cmd.creation_flags(0x08000000);
                if let Ok(Ok(out)) =
                    tokio::time::timeout(std::time::Duration::from_secs(8), cmd.output()).await
                {
                    if out.status.success() {
                        let text = strip_ansi_codes(&String::from_utf8_lossy(&out.stdout));
                        for line in text.lines() {
                            let clean = line
                                .trim()
                                .trim_start_matches(['*', '-', '•', '>', '✓', '●', ' '])
                                .trim();
                            if clean.is_empty()
                                || clean.starts_with("Available")
                                || clean.starts_with("Models")
                                || clean.starts_with("Use ")
                                || clean.starts_with("---")
                                || clean.len() > 120
                            {
                                continue;
                            }
                            let lower = clean.to_lowercase();
                            if lower.contains("gemini")
                                || lower.contains("claude")
                                || lower.contains("gpt")
                                || lower.contains("orchestrator")
                                || lower.contains("o3")
                                || lower.contains("o4")
                            {
                                if let Some(opt) = parse_agy_model_line(clean) {
                                    push_opt(opt);
                                    found_live += 1;
                                }
                            }
                        }
                        if found_live > 0 {
                            source = "agy models".to_string();
                        }
                    }
                }
            }
            // Only fall back to curated presets if `agy models` returned no live models
            if found_live == 0 {
                if let Some(ref def) = current_default {
                    push_opt(make_preset_option(def, def));
                }
                for (id, label) in [
                    ("Gemini 3.1 Pro (High)", "Gemini 3.1 Pro (High)"),
                    ("Gemini 3.1 Pro (Low)", "Gemini 3.1 Pro (Low)"),
                    ("Gemini 3 Flash", "Gemini 3 Flash"),
                    ("Gemini 2.5 Pro", "Gemini 2.5 Pro"),
                    ("Gemini 2.5 Flash", "Gemini 2.5 Flash"),
                    ("Claude Sonnet 4.6 (Thinking)", "Claude Sonnet 4.6 (Thinking)"),
                    ("Claude Opus 4.6 (Thinking)", "Claude Opus 4.6 (Thinking)"),
                ] {
                    push_opt(make_preset_option(id, label));
                }
            }
            let models = options.iter().map(|o| o.id.clone()).collect();
            Ok(CliModelsCatalog {
                engine: engine_id,
                current_default,
                models,
                options,
                source,
            })
        }
        "gemini" => {
            let current_default = home
                .as_ref()
                .and_then(|h| read_json_default_model(h.join(".gemini").join("settings.json")));
            if let Some(ref def) = current_default {
                push_opt(make_preset_option(def, def));
            }
            for (id, label) in [
                ("gemini-2.5-pro", "Gemini 2.5 Pro"),
                ("gemini-2.5-flash", "Gemini 2.5 Flash"),
                ("gemini-2.5-flash-lite", "Gemini 2.5 Flash (Lite)"),
                ("gemini-3-pro-preview", "Gemini 3 Pro (Preview)"),
                ("gemini-3-flash-preview", "Gemini 3 Flash (Preview)"),
                ("auto-gemini-2.5", "Auto Gemini 2.5"),
            ] {
                push_opt(make_preset_option(id, label));
            }
            let models = options.iter().map(|o| o.id.clone()).collect();
            Ok(CliModelsCatalog {
                engine: engine_id,
                current_default,
                models,
                options,
                source: "gemini presets".to_string(),
            })
        }
        "claude" => {
            for (id, label) in [
                ("claude-sonnet-4-6", "Claude Sonnet 4.6"),
                ("claude-opus-4-6", "Claude Opus 4.6"),
                ("claude-haiku-4-5", "Claude Haiku 4.5"),
                ("sonnet", "Sonnet (Latest)"),
                ("opus", "Opus (Latest)"),
                ("haiku", "Haiku (Latest)"),
            ] {
                push_opt(make_preset_option(id, label));
            }
            let models = options.iter().map(|o| o.id.clone()).collect();
            Ok(CliModelsCatalog {
                engine: engine_id,
                current_default: None,
                models,
                options,
                source: "claude presets".to_string(),
            })
        }
        "codex" => {
            for (id, label) in [
                ("gpt-5.4", "GPT-5.4"),
                ("gpt-5.3-codex", "GPT-5.3 (Codex)"),
                ("o3", "o3"),
                ("o4-mini", "o4-mini"),
                ("gpt-4.1", "GPT-4.1"),
            ] {
                push_opt(make_preset_option(id, label));
            }
            let models = options.iter().map(|o| o.id.clone()).collect();
            Ok(CliModelsCatalog {
                engine: engine_id,
                current_default: None,
                models,
                options,
                source: "codex presets".to_string(),
            })
        }
        _ => Err(format!("不支持的 CLI 引擎：{engine}")),
    }
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
    model: Option<String>,
) -> Result<CliAgentRunResult, String> {
    let engine_id = engine.trim().to_lowercase();
    if !matches!(engine_id.as_str(), "claude" | "codex" | "agy" | "gemini") {
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

    let clean_cwd = cwd
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_start_matches("\\\\?\\").to_string());

    let want_mcp = attach_mcp.unwrap_or(true);
    let mcp_session = if want_mcp {
        agent_bridge.create_cli_session().ok()
    } else {
        None
    };

    let use_mcp_workspace_dir =
        mcp_session.is_some() && matches!(engine_id.as_str(), "agy" | "gemini");

    let cwd_note = if use_mcp_workspace_dir {
        clean_cwd
            .as_ref()
            .map(|d| format!("[用户工作目录]\n{d}\n提示：你已挂载 `seamind` MCP 服务，可优先调用 `datalab_list_sources`、`datalab_read_notebook`、`datalab_update_cell`、`datalab_push_cell`、`datalab_run_cell`、`datalab_delete_cell`、`datalab_query_sql`、`code_run_python`、`datalab_run_r` 等全量 Seamind 工具。"))
    } else {
        None
    };

    let mut prompt_sections: Vec<String> = Vec::new();
    if let Some(sys) = system_prompt
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        prompt_sections.push(format!("[系统约定]\n{sys}"));
    }
    if let Some(note) = cwd_note {
        prompt_sections.push(note);
    }
    prompt_sections.push(format!("[任务]\n{prompt_trimmed}"));
    let combined_prompt = prompt_sections.join("\n\n");

    let selected_model = model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 160)
        .map(str::to_string);

    let mut args: Vec<String> = Vec::new();
    match engine_id.as_str() {
        "claude" => {
            if let Some(ref m) = selected_model {
                args.push("--model".to_string());
                args.push(m.clone());
            }
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
            if let Some(ref m) = selected_model {
                args.push("-m".to_string());
                args.push(m.clone());
            }
            args.push("--json".to_string());
            args.push(combined_prompt);
        }
        "gemini" => {
            if let Some(ref m) = selected_model {
                args.push("-m".to_string());
                args.push(m.clone());
            }
            args.push("-p".to_string());
            args.push(combined_prompt);
            args.push("-o".to_string());
            args.push("stream-json".to_string());
            args.push("--skip-trust".to_string());
            if mcp_session.is_some() {
                args.push("--allowed-mcp-server-names".to_string());
                args.push("seamind".to_string());
            }
            if let Some(ref dir) = clean_cwd {
                if PathBuf::from(dir).is_dir() {
                    args.push("--include-directories".to_string());
                    args.push(dir.clone());
                }
            }
        }
        _ => {
            // agy headless execution with optional model flag
            if let Some(ref m) = selected_model {
                args.push("--model".to_string());
                args.push(m.clone());
            }
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

    if use_mcp_workspace_dir {
        if let Some(ref s) = mcp_session {
            if s.agy_workspace_dir.is_dir() {
                cmd.current_dir(&s.agy_workspace_dir);
            }
        }
    } else if let Some(ref dir) = clean_cwd {
        let p = PathBuf::from(dir);
        if p.is_dir() {
            cmd.current_dir(p);
        }
    }
    if let Some(ref dir) = clean_cwd {
        cmd.env("SEAMIND_WORKSPACE_CWD", dir);
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

    #[test]
    fn parses_agy_model_lines_into_family_and_tier() {
        let opt1 = parse_agy_model_line("gemini-4-neon-high Gemini 4 Neon (High)")
            .expect("should parse neon high");
        assert_eq!(opt1.id, "gemini-4-neon-high");
        assert_eq!(opt1.label, "Gemini 4 Neon (High)");
        assert_eq!(opt1.family, "Gemini 4 Neon");
        assert_eq!(opt1.tier.as_deref(), Some("High"));

        let opt2 = parse_agy_model_line("gemini-pro-orchestrator Orchestrator (Carbon)")
            .expect("should parse orchestrator");
        assert_eq!(opt2.id, "gemini-pro-orchestrator");
        assert_eq!(opt2.family, "Orchestrator");
        assert_eq!(opt2.tier.as_deref(), Some("Carbon"));

        let opt3 = parse_agy_model_line("claude-opus-5-5-medium Claude Opus 5.5 (Medium)")
            .expect("should parse claude opus");
        assert_eq!(opt3.id, "claude-opus-5-5-medium");
        assert_eq!(opt3.family, "Claude Opus 5.5");
        assert_eq!(opt3.tier.as_deref(), Some("Medium"));

        let opt4 = parse_agy_model_line("Gemini 3 Flash").expect("should parse label only");
        assert_eq!(opt4.id, "Gemini 3 Flash");
        assert_eq!(opt4.family, "Gemini 3 Flash");
        assert_eq!(opt4.tier, None);
    }
}
