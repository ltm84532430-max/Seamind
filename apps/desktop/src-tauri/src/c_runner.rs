use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Instant;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use uuid::Uuid;

const MAX_C_SOURCE_BYTES: usize = 120_000;
const MAX_STDIN_BYTES: usize = 65_536;
const COMPILE_TIMEOUT_SECS: u64 = 15;
const EXECUTE_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CEnvironmentInfo {
    pub available: bool,
    pub compiler_path: String,
    pub compiler_name: String,
    pub version: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CRunResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub stage: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CStageFileResult {
    pub file_path: String,
    pub file_name: String,
    pub command: String,
}

/// Strips Windows extended-length prefix (`\\?\` and `\\?\UNC\`) to prevent
/// external compilers, linkers, or shells from failing to resolve paths.
pub fn normalize_windows_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let path_str = path.to_string_lossy();
        if let Some(stripped) = path_str.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{stripped}"));
        }
        if let Some(stripped) = path_str.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    path.to_path_buf()
}

/// Dynamically locates the C/C++ compiler without hardcoding user-specific paths.
pub fn find_c_compiler() -> Option<PathBuf> {
    // 1. Try PATH first
    let probe_cmd = if cfg!(windows) { "where" } else { "which" };
    if let Ok(output) = std::process::Command::new(probe_cmd).arg("gcc").output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(first_line) = stdout.lines().next() {
                let candidate = PathBuf::from(first_line.trim());
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }

    // 2. On Windows, check standard system toolchain locations (MSYS2 / MinGW)
    #[cfg(windows)]
    {
        let standard_paths = [
            r"C:\msys64\ucrt64\bin\gcc.exe",
            r"C:\msys64\mingw64\bin\gcc.exe",
            r"C:\msys64\clang64\bin\clang.exe",
            r"C:\TDM-GCC-64\bin\gcc.exe",
            r"C:\MinGW\bin\gcc.exe",
        ];
        for candidate in standard_paths {
            let path = PathBuf::from(candidate);
            if path.exists() {
                return Some(path);
            }
        }
    }

    None
}

#[tauri::command]
pub async fn c_check_environment() -> Result<CEnvironmentInfo, String> {
    let compiler = find_c_compiler();
    match compiler {
        Some(path) => {
            let mut cmd = Command::new(&path);
            cmd.arg("--version");
            #[cfg(windows)]
            {
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            match cmd.output().await {
                Ok(output) if output.status.success() => {
                    let text = String::from_utf8_lossy(&output.stdout);
                    let first_line = text.lines().next().unwrap_or("GCC").to_string();
                    let name = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("gcc")
                        .to_string();
                    Ok(CEnvironmentInfo {
                        available: true,
                        compiler_path: path.to_string_lossy().to_string(),
                        compiler_name: name,
                        version: first_line,
                        error: None,
                    })
                }
                Ok(output) => {
                    let err = String::from_utf8_lossy(&output.stderr).to_string();
                    Ok(CEnvironmentInfo {
                        available: false,
                        compiler_path: path.to_string_lossy().to_string(),
                        compiler_name: "gcc".to_string(),
                        version: String::new(),
                        error: Some(format!("编译器无法执行：{err}")),
                    })
                }
                Err(error) => Ok(CEnvironmentInfo {
                    available: false,
                    compiler_path: path.to_string_lossy().to_string(),
                    compiler_name: "gcc".to_string(),
                    version: String::new(),
                    error: Some(format!("启动编译器失败：{error}")),
                }),
            }
        }
        None => Ok(CEnvironmentInfo {
            available: false,
            compiler_path: String::new(),
            compiler_name: String::new(),
            version: String::new(),
            error: Some(
                "未检测到本地 C 语言编译器（gcc / clang）。建议安装 MSYS2 或添加 gcc 至系统 PATH。"
                    .to_string(),
            ),
        }),
    }
}

#[tauri::command]
pub async fn c_run_code(
    source: String,
    stdin_input: Option<String>,
    is_cpp: Option<bool>,
) -> Result<CRunResult, String> {
    if source.as_bytes().len() > MAX_C_SOURCE_BYTES {
        return Err("C 源码大小不能超过 120 KB。".to_string());
    }

    let compiler_path = find_c_compiler()
        .ok_or_else(|| "未找到 C 编译器 (gcc)。请确认本地已安装 MSYS2 或 GCC。".to_string())?;

    // If it's C++ and we found gcc, try to use g++ from the same directory
    let effective_compiler = if is_cpp.unwrap_or(false) {
        let parent = compiler_path.parent();
        let gpp = parent.map(|p| {
            if cfg!(windows) {
                p.join("g++.exe")
            } else {
                p.join("g++")
            }
        });
        if let Some(ref p) = gpp {
            if p.exists() {
                p.clone()
            } else {
                compiler_path.clone()
            }
        } else {
            compiler_path.clone()
        }
    } else {
        compiler_path.clone()
    };

    let start_time = Instant::now();
    let session_id = Uuid::new_v4().to_string();
    let temp_dir = std::env::temp_dir().join(format!("seamind-c-build-{session_id}"));
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("无法创建临时构建目录：{e}"))?;

    let file_ext = if is_cpp.unwrap_or(false) { "cpp" } else { "c" };
    let source_file = temp_dir.join(format!("main.{file_ext}"));
    let exe_name = if cfg!(windows) { "app.exe" } else { "app" };
    let output_exe = temp_dir.join(exe_name);

    if let Err(e) = std::fs::write(&source_file, source.as_bytes()) {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err(format!("无法写入临时源文件：{e}"));
    }

    // Step 1: Compile
    let mut compile_cmd = Command::new(&effective_compiler);
    compile_cmd.current_dir(&temp_dir);
    if let Some(parent) = effective_compiler.parent() {
        if let Ok(current_path) = std::env::var("PATH") {
            let parent_norm = normalize_windows_path(parent);
            compile_cmd.env(
                "PATH",
                format!("{};{}", parent_norm.display(), current_path),
            );
        }
    }
    // Explicit UTF-8 charset flags prevent Chinese mojibake on Windows console
    compile_cmd.args([
        "-finput-charset=UTF-8",
        "-fexec-charset=UTF-8",
        "-Wall",
        "-O2",
        source_file.to_str().unwrap_or("main.c"),
        "-lm",
        "-o",
        output_exe.to_str().unwrap_or(exe_name),
    ]);

    #[cfg(windows)]
    {
        compile_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let compile_future = compile_cmd.output();
    let compile_output = match tokio::time::timeout(
        std::time::Duration::from_secs(COMPILE_TIMEOUT_SECS),
        compile_future,
    )
    .await
    {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            let _ = std::fs::remove_dir_all(&temp_dir);
            return Err(format!("执行编译命令失败：{e}"));
        }
        Err(_) => {
            let _ = std::fs::remove_dir_all(&temp_dir);
            return Ok(CRunResult {
                success: false,
                stdout: String::new(),
                stderr: format!("编译超时（超过 {COMPILE_TIMEOUT_SECS} 秒），已终止。"),
                exit_code: Some(-1),
                duration_ms: start_time.elapsed().as_millis() as u64,
                stage: "compile".to_string(),
            });
        }
    };

    if !compile_output.status.success() {
        let stderr = String::from_utf8_lossy(&compile_output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&compile_output.stdout).to_string();
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Ok(CRunResult {
            success: false,
            stdout,
            stderr,
            exit_code: compile_output.status.code(),
            duration_ms: start_time.elapsed().as_millis() as u64,
            stage: "compile".to_string(),
        });
    }

    // Step 2: Execute
    let mut run_cmd = Command::new(&output_exe);
    run_cmd.current_dir(&temp_dir);
    if let Some(parent) = effective_compiler.parent() {
        if let Ok(current_path) = std::env::var("PATH") {
            let parent_norm = normalize_windows_path(parent);
            run_cmd.env(
                "PATH",
                format!("{};{}", parent_norm.display(), current_path),
            );
        }
    }
    run_cmd.stdout(std::process::Stdio::piped());
    run_cmd.stderr(std::process::Stdio::piped());
    if stdin_input.is_some() {
        run_cmd.stdin(std::process::Stdio::piped());
    } else {
        run_cmd.stdin(std::process::Stdio::null());
    }

    #[cfg(windows)]
    {
        run_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = match run_cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&temp_dir);
            return Err(format!("启动生成的可执行程序失败：{e}"));
        }
    };

    if let Some(stdin_text) = stdin_input {
        let input_bytes = stdin_text.as_bytes();
        let safe_bytes = &input_bytes[..input_bytes.len().min(MAX_STDIN_BYTES)];
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(safe_bytes).await;
            let _ = stdin.flush().await;
            drop(stdin);
        }
    }

    let stdout_stream = child.stdout.take();
    let stderr_stream = child.stderr.take();

    let stdout_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut stream) = stdout_stream {
            use tokio::io::AsyncReadExt;
            let _ = stream.read_to_end(&mut buf).await;
        }
        buf
    });
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut stream) = stderr_stream {
            use tokio::io::AsyncReadExt;
            let _ = stream.read_to_end(&mut buf).await;
        }
        buf
    });

    let wait_future = child.wait();
    let run_status = match tokio::time::timeout(
        std::time::Duration::from_secs(EXECUTE_TIMEOUT_SECS),
        wait_future,
    )
    .await
    {
        Ok(Ok(status)) => status,
        Ok(Err(e)) => {
            let _ = std::fs::remove_dir_all(&temp_dir);
            return Err(format!("等待程序运行结束失败：{e}"));
        }
        Err(_) => {
            // Timed out: kill the child process to prevent while(1) hanging
            let _ = child.kill().await;
            let _ = std::fs::remove_dir_all(&temp_dir);
            return Ok(CRunResult {
                success: false,
                stdout: String::new(),
                stderr: format!("运行超时（超过 {EXECUTE_TIMEOUT_SECS} 秒，已触发防死循环保护并自动终止）。如需多次交互，请使用「在终端运行」。"),
                exit_code: Some(-1),
                duration_ms: start_time.elapsed().as_millis() as u64,
                stage: "execution".to_string(),
            });
        }
    };

    let duration_ms = start_time.elapsed().as_millis() as u64;
    let stdout_bytes = stdout_task.await.unwrap_or_default();
    let stderr_bytes = stderr_task.await.unwrap_or_default();
    let stdout = String::from_utf8_lossy(&stdout_bytes).to_string();
    let stderr = String::from_utf8_lossy(&stderr_bytes).to_string();
    let exit_code = run_status.code();
    let success = run_status.success();

    // Clean up temporary files
    let _ = std::fs::remove_dir_all(&temp_dir);

    Ok(CRunResult {
        success,
        stdout,
        stderr,
        exit_code,
        duration_ms,
        stage: "execution".to_string(),
    })
}

#[tauri::command]
pub fn c_stage_source_file(
    source: String,
    suggested_name: Option<String>,
    workspace_root: Option<String>,
    is_cpp: Option<bool>,
) -> Result<CStageFileResult, String> {
    if source.as_bytes().len() > MAX_C_SOURCE_BYTES {
        return Err("C 源码大小不能超过 120 KB。".to_string());
    }

    let ext = if is_cpp.unwrap_or(false) { "cpp" } else { "c" };
    let raw_stem = suggested_name
        .unwrap_or_else(|| format!("code_{}", &Uuid::new_v4().to_string()[..8]))
        .trim()
        .replace(|c: char| !c.is_alphanumeric() && c != '_' && c != '-', "_");
    let safe_stem = if raw_stem.is_empty() {
        "main".to_string()
    } else {
        raw_stem
    };
    let file_name = format!("{safe_stem}.{ext}");

    let raw_base_dir = if let Some(root) = workspace_root.filter(|r| !r.trim().is_empty()) {
        let clean_root = normalize_windows_path(Path::new(&root));
        let p = clean_root.join(".seamind").join("scratch");
        let _ = std::fs::create_dir_all(&p);
        p
    } else {
        let p = std::env::temp_dir().join("seamind-scratch");
        let _ = std::fs::create_dir_all(&p);
        p
    };
    let base_dir = normalize_windows_path(&raw_base_dir);

    let file_path = base_dir.join(&file_name);
    std::fs::write(&file_path, source.as_bytes()).map_err(|e| format!("无法写入代码文件：{e}"))?;

    let exe_name = if cfg!(windows) {
        format!("{safe_stem}.exe")
    } else {
        safe_stem.clone()
    };
    let compiler = if is_cpp.unwrap_or(false) {
        "g++"
    } else {
        "gcc"
    };

    let bin_path_injection = if let Some(compiler_path) = find_c_compiler() {
        if let Some(parent) = compiler_path.parent() {
            let parent_norm = normalize_windows_path(parent);
            let parent_str = parent_norm.to_string_lossy().replace('/', "\\");
            if cfg!(windows) {
                format!("if ($env:PATH -notlike '*{parent_str}*') {{ $env:PATH = '{parent_str};' + $env:PATH }}; ")
            } else {
                String::new()
            }
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    let base_dir_str = base_dir.to_string_lossy().replace('/', "\\");

    let command = if cfg!(windows) {
        format!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null; {bin_path_injection}Set-Location -LiteralPath '{base_dir_str}'; {compiler} -finput-charset=UTF-8 -fexec-charset=UTF-8 -Wall -O2 '{file_name}' -lm -o '{exe_name}'; if ($?) {{ .\\'{exe_name}' }}"
        )
    } else {
        let unix_base_str = base_dir.to_string_lossy().replace('\\', "/");
        format!(
            "cd '{unix_base_str}' && {compiler} -Wall -O2 '{file_name}' -lm -o '{exe_name}' && ./{exe_name}"
        )
    };

    Ok(CStageFileResult {
        file_path: file_path.to_string_lossy().to_string(),
        file_name,
        command,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_c_compiler() {
        let compiler = find_c_compiler();
        // If gcc is installed on this test machine, it should find it
        if let Some(ref path) = compiler {
            assert!(path.exists());
        }
    }

    #[test]
    fn test_stage_source_file() {
        let result = c_stage_source_file(
            "#include <stdio.h>\nint main() { return 0; }".to_string(),
            Some("test_sample".to_string()),
            None,
            Some(false),
        )
        .expect("stage should succeed");

        assert_eq!(result.file_name, "test_sample.c");
        assert!(result.command.contains("gcc"));
        assert!(result.command.contains("-lm"));
        assert!(Path::new(&result.file_path).exists());
        let _ = std::fs::remove_file(&result.file_path);
    }
}
