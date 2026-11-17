use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use uuid::Uuid;

const MAX_CODE_BYTES: usize = 120_000;
const EXEC_TIMEOUT_SECS: u64 = 60;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonEnvInfo {
    pub id: String,
    pub label: String,
    pub python_path: String,
    pub env_type: String,
    pub version: Option<String>,
    pub has_numpy: bool,
    pub has_matplotlib: bool,
    pub has_pandas: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonVarSummary {
    pub name: String,
    pub type_name: String,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonEvalResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    pub result_text: String,
    pub images: Vec<String>,
    pub svgs: Vec<String>,
    pub htmls: Vec<String>,
    pub latexes: Vec<String>,
    pub variables: Vec<PythonVarSummary>,
    pub error: Option<String>,
    pub duration_ms: u64,
}

struct KernelProcess {
    pid: Option<u32>,
    child: Child,
    stdin: ChildStdin,
    stdout_lines: Lines<BufReader<ChildStdout>>,
    python_path: String,
    cwd: Option<String>,
}

type SharedKernel = Arc<tokio::sync::Mutex<KernelProcess>>;

#[derive(Clone)]
struct KernelEntry {
    pid: Option<u32>,
    kernel: SharedKernel,
}

#[derive(Default)]
pub struct PythonKernelState(Mutex<HashMap<String, KernelEntry>>);

impl PythonKernelState {
    pub fn close_all(&self) {
        let entries: Vec<KernelEntry> = match self.0.lock() {
            Ok(mut guard) => guard.drain().map(|(_, entry)| entry).collect(),
            Err(_) => return,
        };
        for entry in entries {
            if let Some(pid_val) = entry.pid {
                kill_pid_only(pid_val);
            }
            if let Ok(mut guard) = entry.kernel.try_lock() {
                kill_process_tree(guard.pid, &mut guard.child);
            }
        }
    }
}

fn kill_pid_only(pid_val: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid_val.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid_val.to_string()])
            .output();
    }
}

fn kill_process_tree(pid: Option<u32>, child: &mut Child) {
    if let Some(pid_val) = pid {
        kill_pid_only(pid_val);
    }
    let _ = child.start_kill();
}

const EMBEDDED_KERNEL_DRIVER: &str = r#"
import ast, base64, contextlib, gc, io, json, sys, traceback

try:
    sys.stdin.reconfigure(encoding='utf-8', errors='replace')
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

try:
    import matplotlib
    matplotlib.use('Agg')
except Exception:
    pass

ns = {'__name__': '__main__'}

def _collect_vars(env):
    items = []
    for k, v in list(env.items()):
        if k.startswith('_'):
            continue
        tname = type(v).__name__
        if tname in ('module', 'function', 'builtin_function_or_method', 'type'):
            continue
        try:
            shape = getattr(v, 'shape', None)
            if shape is not None:
                preview = f"shape={shape} dtype={getattr(v, 'dtype', '?')}"
            else:
                r = repr(v)
                preview = r[:117] + '...' if len(r) > 120 else r
        except Exception:
            preview = '<unprintable>'
        items.append({'name': k, 'typeName': tname, 'preview': preview})
        if len(items) >= 64:
            break
    return items

def _extract_rich(val, htmls, svgs, images, latexes):
    if val is None:
        return ''
    try:
        if hasattr(val, '_repr_html_') and callable(val._repr_html_):
            h = val._repr_html_()
            if isinstance(h, str) and h.strip():
                htmls.append(h[:24000])
    except Exception:
        pass
    try:
        if hasattr(val, '_repr_svg_') and callable(val._repr_svg_):
            s = val._repr_svg_()
            if isinstance(s, str) and s.strip():
                svgs.append(s[:40000])
    except Exception:
        pass
    try:
        if hasattr(val, '_repr_png_') and callable(val._repr_png_):
            p = val._repr_png_()
            if isinstance(p, bytes) and len(p) > 0:
                images.append('data:image/png;base64,' + base64.b64encode(p).decode('ascii'))
            elif isinstance(p, str) and p.strip():
                images.append(p if p.startswith('data:') else 'data:image/png;base64,' + p.strip())
    except Exception:
        pass
    try:
        if hasattr(val, '_repr_latex_') and callable(val._repr_latex_):
            l = val._repr_latex_()
            if isinstance(l, str) and l.strip():
                latexes.append(l[:4000])
    except Exception:
        pass
    try:
        return repr(val)[:8000]
    except Exception:
        return '<unprintable>'

def _collect_plt_figures(images):
    plt = sys.modules.get('matplotlib.pyplot')
    if plt is None:
        return
    try:
        fignums = list(plt.get_fignums())
        for num in fignums[:8]:
            fig = plt.figure(num)
            buf = io.BytesIO()
            fig.savefig(buf, format='png', dpi=140, bbox_inches='tight')
            buf.seek(0)
            images.append('data:image/png;base64,' + base64.b64encode(buf.read()).decode('ascii'))
        if fignums:
            plt.close('all')
    except Exception:
        pass

def _run_code(code):
    out_buf = io.StringIO()
    err_buf = io.StringIO()
    images, svgs, htmls, latexes = [], [], [], []
    result_text = ''
    err_text = None
    ok = True
    try:
        tree = ast.parse(code, filename='<cell>', mode='exec')
        last_expr = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last_expr = tree.body.pop()
        with contextlib.redirect_stdout(out_buf), contextlib.redirect_stderr(err_buf):
            if tree.body:
                exec(compile(tree, '<cell>', 'exec'), ns, ns)
            if last_expr is not None:
                val = eval(compile(ast.Expression(last_expr.value), '<cell>', 'eval'), ns, ns)
                if val is not None:
                    ns['_'] = val
                    result_text = _extract_rich(val, htmls, svgs, images, latexes)
        _collect_plt_figures(images)
    except Exception:
        ok = False
        err_text = traceback.format_exc(limit=12)[-8000:]
    return {
        'ok': ok,
        'stdout': out_buf.getvalue()[:60000],
        'stderr': err_buf.getvalue()[:30000],
        'resultText': result_text,
        'images': images,
        'svgs': svgs,
        'htmls': htmls,
        'latexes': latexes,
        'variables': _collect_vars(ns),
        'error': err_text,
    }

for raw in sys.stdin:
    line = raw.strip()
    if not line:
        continue
    req_id = ''
    try:
        req = json.loads(line)
        req_id = str(req.get('id', ''))
        op = req.get('op', 'exec')
        if op == 'shutdown':
            break
        elif op == 'reset':
            ns = {'__name__': '__main__'}
            plt = sys.modules.get('matplotlib.pyplot')
            if plt is not None:
                try:
                    plt.close('all')
                except Exception:
                    pass
            gc.collect()
            payload = {
                'id': req_id, 'ok': True, 'stdout': '', 'stderr': '',
                'resultText': '', 'images': [], 'svgs': [], 'htmls': [],
                'latexes': [], 'variables': [], 'error': None
            }
        elif op == 'vars':
            payload = {
                'id': req_id, 'ok': True, 'stdout': '', 'stderr': '',
                'resultText': '', 'images': [], 'svgs': [], 'htmls': [],
                'latexes': [], 'variables': _collect_vars(ns), 'error': None
            }
        else:
            res = _run_code(str(req.get('code', '')))
            res['id'] = req_id
            payload = res
    except Exception as exc:
        payload = {
            'id': req_id, 'ok': False, 'stdout': '', 'stderr': '',
            'resultText': '', 'images': [], 'svgs': [], 'htmls': [],
            'latexes': [], 'variables': [], 'error': str(exc)
        }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + '\n')
    sys.stdout.flush()
"#;

fn normalize_path_key(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let trimmed = raw.trim_start_matches("\\\\?\\");
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

fn clean_display_path(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches("\\\\?\\")
        .to_string()
}

fn inspect_python_site_packages(python_path: &Path) -> (bool, bool, bool, Option<String>) {
    let Some(parent) = python_path.parent() else {
        return (false, false, false, None);
    };
    let root = if parent
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.eq_ignore_ascii_case("Scripts") || n.eq_ignore_ascii_case("bin"))
        .unwrap_or(false)
    {
        parent.parent().unwrap_or(parent)
    } else {
        parent
    };

    let site_dirs = if cfg!(windows) {
        vec![root.join("Lib").join("site-packages")]
    } else {
        let lib = root.join("lib");
        let mut found = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&lib) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("python") {
                    found.push(entry.path().join("site-packages"));
                }
            }
        }
        found
    };

    let mut has_numpy = false;
    let mut has_matplotlib = false;
    let mut has_pandas = false;
    for dir in site_dirs {
        if dir.join("numpy").exists() {
            has_numpy = true;
        }
        if dir.join("matplotlib").exists() {
            has_matplotlib = true;
        }
        if dir.join("pandas").exists() {
            has_pandas = true;
        }
    }

    let mut version = None;
    let conda_meta = root.join("conda-meta");
    if let Ok(entries) = std::fs::read_dir(&conda_meta) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(rest) = name.strip_prefix("python-") {
                if let Some(ver) = rest.split('-').next() {
                    version = Some(ver.to_string());
                    break;
                }
            }
        }
    }
    if version.is_none() {
        if let Ok(cfg) = std::fs::read_to_string(root.join("pyvenv.cfg")) {
            for line in cfg.lines() {
                if let Some(ver) = line.strip_prefix("version =") {
                    version = Some(ver.trim().to_string());
                    break;
                }
            }
        }
    }

    (has_numpy, has_matplotlib, has_pandas, version)
}

fn collect_candidate_envs(cwd: Option<&str>) -> Vec<PythonEnvInfo> {
    let mut seen = HashSet::<String>::new();
    let mut results = Vec::<PythonEnvInfo>::new();

    let mut push_candidate = |path: PathBuf, label: String, env_type: &str| {
        if !path.is_file() {
            return;
        }
        let lower = path.to_string_lossy().to_lowercase();
        if lower.contains("windowsapps\\python") {
            return;
        }
        let key = normalize_path_key(&path);
        if !seen.insert(key.clone()) {
            return;
        }
        let (has_numpy, has_matplotlib, has_pandas, version) = inspect_python_site_packages(&path);
        results.push(PythonEnvInfo {
            id: format!("py-{}", results.len() + 1),
            label,
            python_path: clean_display_path(&path),
            env_type: env_type.to_string(),
            version,
            has_numpy,
            has_matplotlib,
            has_pandas,
        });
    };

    if let Some(prefix) = std::env::var_os("CONDA_PREFIX") {
        let root = PathBuf::from(prefix);
        let name = std::env::var("CONDA_DEFAULT_ENV").unwrap_or_else(|_| "active".to_string());
        let exe = if cfg!(windows) {
            root.join("python.exe")
        } else {
            root.join("bin").join("python")
        };
        push_candidate(exe, format!("Conda · {name}"), "conda");
    }

    if let Some(cwd_str) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
        let cwd_path = PathBuf::from(cwd_str.trim_start_matches("\\\\?\\"));
        for venv_name in [".venv", "venv"] {
            let exe = if cfg!(windows) {
                cwd_path.join(venv_name).join("Scripts").join("python.exe")
            } else {
                cwd_path.join(venv_name).join("bin").join("python")
            };
            push_candidate(exe, format!("工作区 {venv_name}"), "venv");
        }
    }

    #[cfg(windows)]
    {
        let mut conda_roots: Vec<PathBuf> = Vec::new();
        for env_key in ["USERPROFILE", "LOCALAPPDATA", "PROGRAMDATA"] {
            if let Some(base) = std::env::var_os(env_key) {
                let b = PathBuf::from(base);
                for dist in ["anaconda3", "miniconda3", "miniforge3", "mambaforge"] {
                    conda_roots.push(b.join(dist));
                }
            }
        }
        for drive in ["C:\\", "D:\\", "E:\\"] {
            for dist in ["anaconda3", "miniconda3", "miniforge3"] {
                conda_roots.push(PathBuf::from(drive).join(dist));
            }
        }
        for root in conda_roots {
            if !root.is_dir() {
                continue;
            }
            let dist_name = root
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("conda");
            push_candidate(
                root.join("python.exe"),
                format!("Conda base ({dist_name})"),
                "conda",
            );
            let envs_dir = root.join("envs");
            if let Ok(entries) = std::fs::read_dir(envs_dir) {
                for entry in entries.flatten() {
                    if entry.path().is_dir() {
                        let env_name = entry.file_name().to_string_lossy().to_string();
                        push_candidate(
                            entry.path().join("python.exe"),
                            format!("Conda · {env_name}"),
                            "conda",
                        );
                    }
                }
            }
        }
    }

    let where_cmd = if cfg!(windows) { "where.exe" } else { "which" };
    let args: &[&str] = if cfg!(windows) { &["python"] } else { &["-a", "python3"] };
    let mut cmd = std::process::Command::new(where_cmd);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    if let Ok(output) = cmd.output() {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let p = PathBuf::from(line.trim());
                let name = p
                    .parent()
                    .and_then(|dir| dir.file_name())
                    .and_then(|s| s.to_str())
                    .unwrap_or("System");
                let label = if line.to_lowercase().contains("conda") {
                    format!("Conda · {name}")
                } else {
                    format!("System Python ({name})")
                };
                push_candidate(p, label, "system");
            }
        }
    }

    results
}

#[tauri::command]
pub fn python_kernel_detect_envs(cwd: Option<String>) -> Result<Vec<PythonEnvInfo>, String> {
    Ok(collect_candidate_envs(cwd.as_deref()))
}

async fn spawn_kernel_process(
    python_path: &str,
    cwd: Option<&str>,
) -> Result<KernelProcess, String> {
    let mut cmd = Command::new(python_path);
    cmd.args(["-u", "-c", EMBEDDED_KERNEL_DRIVER]);
    if let Some(dir) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(dir.trim_start_matches("\\\\?\\"));
        if p.is_dir() {
            cmd.current_dir(p);
        }
    }
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("MPLBACKEND", "Agg");
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 Python 内核 ({python_path}) 失败：{e}"))?;
    let pid = child.id();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法连接 Python 内核标准输入。".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法连接 Python 内核标准输出。".to_string())?;

    Ok(KernelProcess {
        pid,
        child,
        stdin,
        stdout_lines: BufReader::new(stdout).lines(),
        python_path: python_path.to_string(),
        cwd: cwd.map(|s| s.to_string()),
    })
}

async fn send_kernel_request(
    kernel: &SharedKernel,
    request: serde_json::Value,
) -> Result<PythonEvalResult, String> {
    let start = std::time::Instant::now();
    let line = format!(
        "{}\n",
        serde_json::to_string(&request).map_err(|e| format!("编码内核请求失败：{e}"))?
    );
    let mut guard = kernel.lock().await;
    guard
        .stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("写入 Python 内核失败（可能已退出）：{e}"))?;
    guard
        .stdin
        .flush()
        .await
        .map_err(|e| format!("刷新 Python 内核输入失败：{e}"))?;

    let read_res = tokio::time::timeout(
        std::time::Duration::from_secs(EXEC_TIMEOUT_SECS),
        guard.stdout_lines.next_line(),
    )
    .await;

    let raw_line = match read_res {
        Ok(Ok(Some(line))) => line,
        Ok(Ok(None)) => return Err("Python 内核已意外终止。".to_string()),
        Ok(Err(e)) => return Err(format!("读取 Python 内核响应失败：{e}")),
        Err(_) => {
            kill_process_tree(guard.pid, &mut guard.child);
            return Err(format!(
                "Python 执行超过 {EXEC_TIMEOUT_SECS} 秒超时，已终止当前内核。请点击「重启内核」。"
            ));
        }
    };

    let parsed: serde_json::Value =
        serde_json::from_str(&raw_line).map_err(|e| format!("解析内核输出失败：{e}"))?;
    Ok(PythonEvalResult {
        ok: parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
        stdout: parsed
            .get("stdout")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        stderr: parsed
            .get("stderr")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        result_text: parsed
            .get("resultText")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        images: serde_json::from_value(parsed.get("images").cloned().unwrap_or(serde_json::json!([])))
            .unwrap_or_default(),
        svgs: serde_json::from_value(parsed.get("svgs").cloned().unwrap_or(serde_json::json!([])))
            .unwrap_or_default(),
        htmls: serde_json::from_value(parsed.get("htmls").cloned().unwrap_or(serde_json::json!([])))
            .unwrap_or_default(),
        latexes: serde_json::from_value(parsed.get("latexes").cloned().unwrap_or(serde_json::json!([])))
            .unwrap_or_default(),
        variables: serde_json::from_value(
            parsed.get("variables").cloned().unwrap_or(serde_json::json!([])),
        )
        .unwrap_or_default(),
        error: parsed
            .get("error")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
pub async fn python_kernel_start(
    state: State<'_, PythonKernelState>,
    python_path: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let resolved_path = match python_path.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(path) => path,
        None => collect_candidate_envs(cwd.as_deref())
            .into_iter()
            .next()
            .map(|env| env.python_path)
            .ok_or_else(|| "未检测到本地 Python / Conda 环境，可直接使用 Pyodide 沙盒。".to_string())?,
    };

    let kernel_id = format!("pyk-{}", Uuid::new_v4());
    let proc = spawn_kernel_process(&resolved_path, cwd.as_deref()).await?;
    let pid = proc.pid;
    let shared = Arc::new(tokio::sync::Mutex::new(proc));

    state
        .0
        .lock()
        .map_err(|_| "Python 内核管理器不可用。".to_string())?
        .insert(kernel_id.clone(), KernelEntry { pid, kernel: shared });
    Ok(kernel_id)
}

fn get_kernel(state: &State<'_, PythonKernelState>, kernel_id: &str) -> Result<SharedKernel, String> {
    state
        .0
        .lock()
        .map_err(|_| "Python 内核管理器不可用。".to_string())?
        .get(kernel_id)
        .map(|entry| entry.kernel.clone())
        .ok_or_else(|| "Python 内核会话不存在或已关闭。".to_string())
}

#[tauri::command]
pub async fn python_kernel_eval(
    state: State<'_, PythonKernelState>,
    kernel_id: String,
    code: String,
) -> Result<PythonEvalResult, String> {
    if code.as_bytes().len() > MAX_CODE_BYTES {
        return Err("单格 Python 代码不能超过 120 KB。".to_string());
    }
    let kernel = get_kernel(&state, &kernel_id)?;
    let req_id = Uuid::new_v4().to_string();
    send_kernel_request(
        &kernel,
        serde_json::json!({ "id": req_id, "op": "exec", "code": code }),
    )
    .await
}

#[tauri::command]
pub async fn python_kernel_reset(
    state: State<'_, PythonKernelState>,
    kernel_id: String,
) -> Result<PythonEvalResult, String> {
    let kernel = get_kernel(&state, &kernel_id)?;
    let req_id = Uuid::new_v4().to_string();
    let res = send_kernel_request(&kernel, serde_json::json!({ "id": req_id, "op": "reset" })).await;
    if res.is_ok() {
        return res;
    }
    // If the kernel died after timeout, transparently respawn a fresh process.
    let (python_path, cwd) = {
        let mut guard = kernel.lock().await;
        kill_process_tree(guard.pid, &mut guard.child);
        (guard.python_path.clone(), guard.cwd.clone())
    };
    let fresh = spawn_kernel_process(&python_path, cwd.as_deref()).await?;
    {
        let mut guard = kernel.lock().await;
        *guard = fresh;
    }
    Ok(PythonEvalResult {
        ok: true,
        stdout: String::new(),
        stderr: String::new(),
        result_text: String::new(),
        images: Vec::new(),
        svgs: Vec::new(),
        htmls: Vec::new(),
        latexes: Vec::new(),
        variables: Vec::new(),
        error: None,
        duration_ms: 0,
    })
}

#[tauri::command]
pub async fn python_kernel_vars(
    state: State<'_, PythonKernelState>,
    kernel_id: String,
) -> Result<Vec<PythonVarSummary>, String> {
    let kernel = get_kernel(&state, &kernel_id)?;
    let req_id = Uuid::new_v4().to_string();
    let res = send_kernel_request(&kernel, serde_json::json!({ "id": req_id, "op": "vars" })).await?;
    Ok(res.variables)
}

#[tauri::command]
pub async fn python_kernel_close(
    state: State<'_, PythonKernelState>,
    kernel_id: String,
) -> Result<(), String> {
    let entry = state
        .0
        .lock()
        .map_err(|_| "Python 内核管理器不可用。".to_string())?
        .remove(&kernel_id);
    if let Some(item) = entry {
        if let Some(pid_val) = item.pid {
            kill_pid_only(pid_val);
        }
        let mut guard = item.kernel.lock().await;
        kill_process_tree(guard.pid, &mut guard.child);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_driver_has_valid_json_protocol_markers() {
        assert!(EMBEDDED_KERNEL_DRIVER.contains("ast.parse(code"));
        assert!(EMBEDDED_KERNEL_DRIVER.contains("matplotlib.use('Agg')"));
        assert!(EMBEDDED_KERNEL_DRIVER.contains("'resultText'"));
    }

    #[test]
    fn detect_envs_deduplicates_paths() {
        let envs = collect_candidate_envs(None);
        let mut unique = HashSet::new();
        for env in &envs {
            let key = env.python_path.to_lowercase();
            assert!(unique.insert(key), "duplicate python path: {}", env.python_path);
        }
    }
}
