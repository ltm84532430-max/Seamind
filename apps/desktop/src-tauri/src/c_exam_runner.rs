use crate::epub_exam::ExamCodeCase;
use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use uuid::Uuid;

const OUTPUT_LIMIT: usize = 64 * 1024;
const MEMORY_LIMIT: usize = 128 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseOutcome {
    pub visible: bool,
    pub passed: bool,
    pub stdout: String,
    pub stderr: String,
    pub expected_stdout: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeEvaluation {
    pub stage: String,
    pub error: String,
    pub passed: usize,
    pub total: usize,
    pub cases: Vec<CaseOutcome>,
}

struct Capture {
    stdout: String,
    stderr: String,
    exit_ok: bool,
    exceeded: bool,
    timed_out: bool,
}

async fn read_capped<R: AsyncRead + Unpin>(mut reader: R) -> (Vec<u8>, bool) {
    let mut saved = Vec::new();
    let mut exceeded = false;
    let mut buffer = [0u8; 4096];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(size) => {
                let available = OUTPUT_LIMIT.saturating_sub(saved.len());
                saved.extend_from_slice(&buffer[..size.min(available)]);
                if size > available {
                    exceeded = true;
                }
            }
        }
    }
    (saved, exceeded)
}

#[cfg(windows)]
struct ProcessJob(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for ProcessJob {}
#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn limit_process(child: &Child) -> Result<ProcessJob, String> {
    use windows_sys::Win32::System::JobObjects::*;
    let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if handle.is_null() {
        return Err("无法创建 C 题进程限制。".into());
    }
    let job = ProcessJob(handle);
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    info.ProcessMemoryLimit = MEMORY_LIMIT;
    let configured = unsafe {
        SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of_val(&info) as u32,
        )
    };
    if configured == 0 {
        return Err("无法配置 C 题内存限制。".into());
    }
    let process = child.raw_handle().ok_or("无法获取 C 题进程句柄。")?;
    let assigned = unsafe {
        AssignProcessToJobObject(handle, process as windows_sys::Win32::Foundation::HANDLE)
    };
    if assigned == 0 {
        return Err("无法限制 C 题运行进程。".into());
    }
    Ok(job)
}

async fn execute(
    mut command: Command,
    stdin: Option<&str>,
    seconds: u64,
    limit_memory: bool,
) -> Result<Capture, String> {
    command.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 C 题进程：{error}"))?;
    #[cfg(windows)]
    let _job = if limit_memory {
        Some(limit_process(&child)?)
    } else {
        None
    };
    #[cfg(not(windows))]
    let _ = limit_memory;
    if let Some(input) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(seconds),
                pipe.write_all(input.as_bytes()),
            )
            .await;
        }
    }
    let stdout = tokio::spawn(read_capped(
        child.stdout.take().ok_or("C 题标准输出不可用。")?,
    ));
    let stderr = tokio::spawn(read_capped(
        child.stderr.take().ok_or("C 题错误输出不可用。")?,
    ));
    let status = tokio::time::timeout(std::time::Duration::from_secs(seconds), child.wait()).await;
    let timed_out = status.is_err();
    if timed_out {
        let _ = child.kill().await;
    }
    let exit_ok = matches!(status, Ok(Ok(code)) if code.success());
    let (out, out_exceeded) = stdout.await.map_err(|_| "无法读取标准输出。")?;
    let (err, err_exceeded) = stderr.await.map_err(|_| "无法读取错误输出。")?;
    Ok(Capture {
        stdout: String::from_utf8_lossy(&out).into_owned(),
        stderr: String::from_utf8_lossy(&err).into_owned(),
        exit_ok,
        exceeded: out_exceeded || err_exceeded,
        timed_out,
    })
}

fn normalized_output(value: &str) -> String {
    value.replace("\r\n", "\n").trim_end().to_string()
}

pub async fn evaluate_c(
    source: &str,
    cases: &[ExamCodeCase],
    include_hidden: bool,
) -> Result<CodeEvaluation, String> {
    if source.as_bytes().len() > 120_000 {
        return Err("C 源码大小不能超过 120 KB。".into());
    }
    let compiler = crate::c_runner::find_c_compiler().ok_or("未检测到本地 C 编译器。")?;
    let directory = std::env::temp_dir().join(format!("seamind-exam-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&directory).map_err(|error| format!("无法创建临时目录：{error}"))?;
    let result = evaluate_in_directory(source, cases, include_hidden, &compiler, &directory).await;
    let _ = std::fs::remove_dir_all(directory);
    result
}

async fn evaluate_in_directory(
    source: &str,
    cases: &[ExamCodeCase],
    include_hidden: bool,
    compiler: &PathBuf,
    directory: &PathBuf,
) -> Result<CodeEvaluation, String> {
    let source_path = directory.join("answer.c");
    let executable = directory.join(if cfg!(windows) {
        "answer.exe"
    } else {
        "answer"
    });
    std::fs::write(&source_path, source).map_err(|error| format!("无法写入 C 源码：{error}"))?;
    let mut compile = Command::new(compiler);
    compile.current_dir(directory).args([
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-O0",
        "-finput-charset=UTF-8",
        "-fexec-charset=UTF-8",
    ]);
    if let Some(parent) = compiler.parent() {
        if let Ok(current_path) = std::env::var("PATH") {
            compile.env(
                "PATH",
                format!(
                    "{};{}",
                    crate::c_runner::normalize_windows_path(parent).display(),
                    current_path
                ),
            );
        }
    }
    compile
        .arg(crate::c_runner::normalize_windows_path(&source_path))
        .arg("-lm")
        .arg("-o")
        .arg(crate::c_runner::normalize_windows_path(&executable));
    let built = execute(compile, None, 15, false).await?;
    if built.timed_out || built.exceeded || !built.exit_ok {
        return Ok(CodeEvaluation {
            stage: "compile".into(),
            error: if built.timed_out {
                "编译超时。".into()
            } else if built.exceeded {
                "编译输出超过 64 KB。".into()
            } else {
                built.stderr
            },
            passed: 0,
            total: cases
                .iter()
                .filter(|case| include_hidden || !case.hidden)
                .count(),
            cases: Vec::new(),
        });
    }
    let selected = cases
        .iter()
        .filter(|case| include_hidden || !case.hidden)
        .collect::<Vec<_>>();
    let mut outcomes = Vec::new();
    for case in selected {
        let mut run = Command::new(crate::c_runner::normalize_windows_path(&executable));
        run.current_dir(directory);
        if let Some(parent) = compiler.parent() {
            if let Ok(current_path) = std::env::var("PATH") {
                run.env(
                    "PATH",
                    format!(
                        "{};{}",
                        crate::c_runner::normalize_windows_path(parent).display(),
                        current_path
                    ),
                );
            }
        }
        let output = execute(run, Some(&case.stdin), 2, true).await?;
        let passed = output.exit_ok
            && !output.timed_out
            && !output.exceeded
            && normalized_output(&output.stdout) == normalized_output(&case.expected_stdout);
        outcomes.push(CaseOutcome {
            visible: !case.hidden,
            passed,
            stdout: if case.hidden {
                String::new()
            } else {
                output.stdout
            },
            stderr: if output.timed_out {
                "运行超时。".into()
            } else if output.exceeded {
                "输出超过 64 KB。".into()
            } else {
                output.stderr
            },
            expected_stdout: if case.hidden {
                None
            } else {
                Some(case.expected_stdout.clone())
            },
        });
    }
    let passed = outcomes.iter().filter(|case| case.passed).count();
    Ok(CodeEvaluation {
        stage: "execution".into(),
        error: String::new(),
        passed,
        total: outcomes.len(),
        cases: outcomes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cases() -> Vec<ExamCodeCase> {
        vec![
            ExamCodeCase {
                stdin: "2\n".into(),
                expected_stdout: "4\n".into(),
                hidden: false,
            },
            ExamCodeCase {
                stdin: "3\n".into(),
                expected_stdout: "9\n".into(),
                hidden: true,
            },
        ]
    }

    #[tokio::test]
    async fn compiles_once_and_checks_public_and_hidden_cases() {
        if crate::c_runner::find_c_compiler().is_none() {
            return;
        }
        let source = "#include <stdio.h>\nint main(void){int x; if(scanf(\"%d\",&x)!=1)return 1; printf(\"%d\\n\",x*x);return 0;}";
        let public = evaluate_c(source, &cases(), false).await.unwrap();
        assert_eq!((public.passed, public.total), (1, 1));
        let all = evaluate_c(source, &cases(), true).await.unwrap();
        assert_eq!((all.passed, all.total), (2, 2));
        assert!(all.cases[1].expected_stdout.is_none());
    }

    #[tokio::test]
    async fn reports_compile_failure_timeout_and_output_limit() {
        if crate::c_runner::find_c_compiler().is_none() {
            return;
        }
        let invalid = evaluate_c("int main( {", &cases(), false).await.unwrap();
        assert_eq!(invalid.stage, "compile");
        let infinite = evaluate_c("int main(void){while(1){} return 0;}", &cases(), false)
            .await
            .unwrap();
        assert!(infinite.cases[0].stderr.contains("超时"));
        let flood = evaluate_c(
            "#include <stdio.h>\nint main(void){for(int i=0;i<100000;i++)putchar('x');}",
            &cases(),
            false,
        )
        .await
        .unwrap();
        assert!(flood.cases[0].stderr.contains("64 KB"));
    }
}
