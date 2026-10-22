use serde::Serialize;
use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    env, fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    time,
};

const MAX_SOURCE_BYTES: usize = 50_000;
const MAX_SVG_BYTES: usize = 300_000;
const MAX_DIAGNOSTIC_BYTES: usize = 64_000;
const RENDER_TIMEOUT: Duration = Duration::from_secs(15);
const PROCESS_START_TIMEOUT: Duration = Duration::from_secs(5);
const PLANTUML_JAR: &str = "plantuml/plantuml-mit-1.2026.8.jar";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlantUmlRenderResult {
    pub svg: String,
    pub diagnostics: Vec<String>,
}

struct JavaRuntime {
    executable: PathBuf,
    version_text: String,
}

#[tauri::command]
pub async fn render_plantuml(
    app: AppHandle,
    source: String,
    dark: bool,
    authorized_include_directory: Option<String>,
    cache_key: Option<String>,
) -> Result<PlantUmlRenderResult, String> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err("PlantUML 源码超过 50 KB 上限。".into());
    }
    if source.trim().is_empty() {
        return Err("PlantUML 源码为空。".into());
    }

    let include_directory = canonical_include_directory(authorized_include_directory)?;
    let snapshot_path = if has_include_directive(&source) {
        None
    } else {
        snapshot_path(
            &app,
            cache_key.as_deref(),
            &source,
            dark,
            include_directory.as_deref(),
        )
    };
    if let Some(path) = snapshot_path.as_ref() {
        if fs::metadata(path)
            .is_ok_and(|metadata| metadata.len() <= MAX_SVG_BYTES as u64)
        {
            if let Ok(svg) = fs::read_to_string(path) {
                if svg.contains("<svg") {
                    return Ok(PlantUmlRenderResult {
                        svg,
                        diagnostics: vec!["使用本地 SVG 快照".to_string()],
                    });
                }
            }
        }
        let _ = fs::remove_file(path);
    }
    let jar_path = resolve_jar_path(&app)?;
    let java = find_supported_java().await?;
    let mut command = Command::new(&java.executable);
    command
        .arg("-Xms16m")
        .arg("-Xmx256m")
        .arg("-DPLANTUML_SECURITY_PROFILE=ALLOWLIST")
        .arg("-Dplantuml.allowlist.url=")
        .arg("-Dplantuml.allowlist.path=")
        .arg("-Dplantuml.include.path=");
    if let Some(directory) = include_directory.as_ref() {
        let directory = directory
            .to_str()
            .ok_or_else(|| "授权目录路径无法转换为 UTF-8。".to_string())?;
        command
            .arg(format!("-Dplantuml.allowlist.path={directory}"))
            .arg(format!("-Dplantuml.include.path={directory}"));
    }
    command.arg("-jar").arg(jar_path).arg("-pipe").arg("-tsvg");
    if dark {
        command.arg("-darkmode");
    }
    if !graphviz_available().await {
        command.arg("-Playout=smetana");
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.env("PLANTUML_SECURITY_PROFILE", "ALLOWLIST");
    command.env_remove("plantuml.allowlist.url");
    command.env_remove("plantuml.allowlist.path");
    command.env_remove("plantuml.include.path");
    if let Some(directory) = include_directory.as_ref() {
        if let Some(directory) = directory.to_str() {
            command.env("plantuml.allowlist.path", directory);
            command.env("plantuml.include.path", directory);
        }
    }
    hide_console(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 PlantUML Java 进程：{error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "PlantUML 输入流不可用。".to_string())?;
    stdin
        .write_all(source.as_bytes())
        .await
        .map_err(|error| format!("发送 PlantUML 源码失败：{error}"))?;
    drop(stdin);

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "PlantUML 输出流不可用。".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "PlantUML 诊断流不可用。".to_string())?;
    let stdout_task = tokio::spawn(read_capped(stdout, MAX_SVG_BYTES));
    let stderr_task = tokio::spawn(read_capped(stderr, MAX_DIAGNOSTIC_BYTES));

    let status = match time::timeout(RENDER_TIMEOUT, child.wait()).await {
        Ok(result) => result.map_err(|error| format!("等待 PlantUML 结束失败：{error}"))?,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err("PlantUML 渲染超过 15 秒，已终止。".into());
        }
    };

    let (svg_bytes, svg_truncated) = stdout_task
        .await
        .map_err(|error| format!("读取 PlantUML SVG 失败：{error}"))?
        .map_err(|error| format!("读取 PlantUML SVG 失败：{error}"))?;
    let (diagnostic_bytes, diagnostics_truncated) = stderr_task
        .await
        .map_err(|error| format!("读取 PlantUML 诊断失败：{error}"))?
        .map_err(|error| format!("读取 PlantUML 诊断失败：{error}"))?;
    if svg_truncated {
        return Err("PlantUML 输出超过 300 KB 上限。".into());
    }
    let svg = String::from_utf8(svg_bytes)
        .map_err(|_| "PlantUML 输出不是有效的 UTF-8 SVG。".to_string())?;
    let diagnostic_text = String::from_utf8_lossy(&diagnostic_bytes)
        .trim()
        .to_string();
    if !status.success() {
        let detail = if diagnostic_text.is_empty() {
            format!("Java 退出码 {:?}。", status.code())
        } else {
            diagnostic_text
        };
        return Err(format!("PlantUML 渲染失败：{detail}"));
    }

    let mut diagnostics = Vec::new();
    if !diagnostic_text.is_empty() {
        diagnostics.push(diagnostic_text);
    }
    if diagnostics_truncated {
        diagnostics.push("PlantUML 诊断信息已截断。".into());
    }
    diagnostics.push(format!("使用 Java {}。", java.version_text));

    if let Some(path) = snapshot_path {
        let _ = write_snapshot(&path, svg.as_bytes());
    }

    Ok(PlantUmlRenderResult { svg, diagnostics })
}

pub(crate) fn retain_plantuml_snapshot_for_source(
    app: &AppHandle,
    cache_key: &str,
    source: &str,
) {
    let Some(directory) = snapshot_directory(app, cache_key) else {
        return;
    };
    let keep_prefix = format!("{}-", cache_hash(source));
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if path.is_file()
            && file_name.ends_with(".svg")
            && !file_name.starts_with(&keep_prefix)
        {
            let _ = fs::remove_file(path);
        }
    }
}

pub(crate) fn delete_plantuml_snapshot_cache(app: &AppHandle, cache_key: &str) {
    if let Some(directory) = snapshot_directory(app, cache_key) {
        let _ = fs::remove_dir_all(directory);
    }
}

fn snapshot_directory(app: &AppHandle, cache_key: &str) -> Option<PathBuf> {
    app.path()
        .app_cache_dir()
        .ok()
        .map(|directory| {
            directory
                .join("plantuml-snapshots")
                .join("v1")
                .join(cache_hash(cache_key))
        })
}

fn snapshot_path(
    app: &AppHandle,
    cache_key: Option<&str>,
    source: &str,
    dark: bool,
    include_directory: Option<&std::path::Path>,
) -> Option<PathBuf> {
    let owner = cache_key.unwrap_or("content-addressed");
    let source_hash = cache_hash(source);
    let include_path = include_directory
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let render_key = format!("{PLANTUML_JAR}\0{source}\0{dark}\0{include_path}");
    snapshot_directory(app, owner).map(|directory| {
        directory.join(format!("{source_hash}-{}.svg", cache_hash(&render_key)))
    })
}

fn cache_hash(value: &str) -> String {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn has_include_directive(source: &str) -> bool {
    source.lines().any(|line| {
        line.trim_start()
            .to_ascii_lowercase()
            .starts_with("!include")
    })
}

fn write_snapshot(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SNAPSHOT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    let Some(directory) = path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(directory)?;
    let sequence = SNAPSHOT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = path.with_extension(format!("tmp-{}-{sequence}", std::process::id()));
    fs::write(&temporary, contents)?;
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
    }
    match fs::rename(&temporary, path) {
        Ok(()) => Ok(()),
        Err(_error) if path.is_file() => {
            let _ = fs::remove_file(&temporary);
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            Err(error)
        }
    }
}

fn resolve_jar_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_directory) = app.path().resource_dir() {
        let bundled = resource_directory.join(PLANTUML_JAR);
        if bundled.is_file() {
            return Ok(java_compatible_path(bundled));
        }
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(PLANTUML_JAR);
    if development.is_file() {
        return Ok(java_compatible_path(development));
    }
    Err("找不到随应用提供的 PlantUML MIT JAR。".into())
}

fn java_compatible_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let path = path.to_string_lossy();
        if let Some(unc_path) = path.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc_path}"));
        }
        if let Some(drive_path) = path.strip_prefix(r"\\?\") {
            return PathBuf::from(drive_path);
        }
        return PathBuf::from(path.as_ref());
    }

    #[cfg(not(windows))]
    path
}

fn canonical_include_directory(raw: Option<String>) -> Result<Option<PathBuf>, String> {
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let path = PathBuf::from(raw.trim());
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("授权的 PlantUML include 目录不可访问：{error}"))?;
    if !canonical.is_dir() {
        return Err("PlantUML include 授权必须指向一个文件夹。".into());
    }
    Ok(Some(java_compatible_path(canonical)))
}

async fn find_supported_java() -> Result<JavaRuntime, String> {
    let mut candidates = java_candidates();
    let mut seen = HashSet::new();
    candidates.retain(|path| seen.insert(path.clone()));
    let mut detected = Vec::new();
    for candidate in candidates {
        let mut command = Command::new(&candidate);
        command
            .arg("-version")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        hide_console(&mut command);
        let result = time::timeout(PROCESS_START_TIMEOUT, command.output()).await;
        let Ok(Ok(output)) = result else {
            continue;
        };
        let version_stderr = String::from_utf8_lossy(&output.stderr);
        let version_stdout = String::from_utf8_lossy(&output.stdout);
        let version_text = version_stderr
            .lines()
            .chain(version_stdout.lines())
            .next()
            .unwrap_or_default()
            .trim()
            .to_string();
        let Some(major_version) = parse_java_major(&version_text) else {
            continue;
        };
        detected.push(format!("Java {major_version} ({})", candidate.display()));
        if major_version >= 11 {
            return Ok(JavaRuntime {
                executable: candidate,
                version_text,
            });
        }
    }
    if detected.is_empty() {
        Err("PlantUML 需要 Java 11 或更高版本，但未找到可运行的 Java。请安装 Java 11+ 后重启 Seamind。".into())
    } else {
        Err(format!(
            "PlantUML 需要 Java 11 或更高版本；检测到 {}。请安装 Java 11+ 后重启 Seamind。",
            detected.join("、")
        ))
    }
}

fn java_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(java_home) = env::var_os("JAVA_HOME") {
        candidates.push(
            PathBuf::from(java_home)
                .join("bin")
                .join(java_executable_name()),
        );
    }
    if let Some(path) = env::var_os("PATH") {
        candidates.extend(
            env::split_paths(&path).map(|directory| directory.join(java_executable_name())),
        );
    }
    #[cfg(windows)]
    {
        for base in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            let Some(root) = env::var_os(base).map(PathBuf::from) else {
                continue;
            };
            for vendor in [
                "Microsoft",
                "Java",
                "Eclipse Adoptium",
                "Zulu",
                "Amazon Corretto",
                "BellSoft",
            ] {
                let vendor_path = root.join(vendor);
                let Ok(entries) = std::fs::read_dir(vendor_path) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let candidate = entry.path().join("bin").join(java_executable_name());
                    if candidate.is_file() {
                        candidates.push(candidate);
                    }
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        for root in [
            "/Library/Java/JavaVirtualMachines",
            "/System/Library/Java/JavaVirtualMachines",
        ] {
            if let Ok(entries) = std::fs::read_dir(root) {
                for entry in entries.flatten() {
                    let candidate = entry.path().join("Contents/Home/bin/java");
                    if candidate.is_file() {
                        candidates.push(candidate);
                    }
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(entries) = std::fs::read_dir("/usr/lib/jvm") {
            for entry in entries.flatten() {
                let candidate = entry.path().join("bin/java");
                if candidate.is_file() {
                    candidates.push(candidate);
                }
            }
        }
    }
    candidates
}

fn java_executable_name() -> &'static str {
    if cfg!(windows) {
        "java.exe"
    } else {
        "java"
    }
}

fn parse_java_major(version_text: &str) -> Option<u32> {
    let quoted = version_text
        .split('"')
        .nth(1)
        .unwrap_or(version_text)
        .trim();
    let numeric = quoted
        .split(|character: char| !character.is_ascii_digit() && character != '.')
        .find(|part| !part.is_empty())?;
    let mut segments = numeric
        .split('.')
        .filter_map(|part| part.parse::<u32>().ok());
    let first = segments.next()?;
    if first == 1 {
        segments.next()
    } else {
        Some(first)
    }
}

async fn graphviz_available() -> bool {
    let mut command = Command::new(if cfg!(windows) { "dot.exe" } else { "dot" });
    command
        .arg("-V")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    hide_console(&mut command);
    matches!(
        time::timeout(Duration::from_secs(2), command.status()).await,
        Ok(Ok(status)) if status.success()
    )
}

async fn read_capped<R: AsyncRead + Unpin>(
    mut reader: R,
    limit: usize,
) -> std::io::Result<(Vec<u8>, bool)> {
    let mut output = Vec::with_capacity(limit.min(16_384));
    let mut buffer = [0_u8; 8_192];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let remaining = limit.saturating_sub(output.len());
        let keep = remaining.min(count);
        output.extend_from_slice(&buffer[..keep]);
        truncated |= keep < count;
    }
    Ok((output, truncated))
}

#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.as_std_mut().creation_flags(0x08000000);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}
