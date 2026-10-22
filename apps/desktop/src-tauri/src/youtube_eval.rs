use rquickjs::{Context, Runtime};
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

const MAX_SCRIPT_BYTES: usize = 4 * 1024 * 1024;
const MAX_RESULT_BYTES: usize = 64 * 1024;
const MEMORY_LIMIT_BYTES: usize = 128 * 1024 * 1024;
const STACK_LIMIT_BYTES: usize = 1024 * 1024;
const EVAL_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_CACHE_VALUE_BYTES: usize = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES: usize = 6;

fn describe_exception(ctx: &rquickjs::Ctx<'_>) -> String {
    let value = ctx.catch();
    value
        .as_exception()
        .and_then(|exception| exception.message())
        .or_else(|| value.as_string().and_then(|text| text.to_string().ok()))
        .unwrap_or_else(|| "脚本执行失败。".to_string())
}

/// Runs the script YouTube.js builds from the player (a function body that returns the deciphered
/// values) in a fresh QuickJS context with no I/O, bounded memory, stack and run time. The result is
/// returned as JSON.
pub fn eval_player_script(script: &str, timeout: Duration) -> Result<String, String> {
    if script.len() > MAX_SCRIPT_BYTES {
        return Err("播放器脚本过大。".to_string());
    }
    let runtime = Runtime::new().map_err(|error| format!("无法启动脚本引擎：{error}"))?;
    runtime.set_memory_limit(MEMORY_LIMIT_BYTES);
    runtime.set_max_stack_size(STACK_LIMIT_BYTES);
    let deadline = Instant::now() + timeout;
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() > deadline)));
    let context = Context::full(&runtime).map_err(|error| format!("无法创建脚本环境：{error}"))?;

    let source = format!("JSON.stringify((function () {{\n{script}\n}})()) ?? 'null'");
    let result = context.with(|ctx| {
        ctx.eval::<String, _>(source).map_err(|error| match error {
            rquickjs::Error::Exception => describe_exception(&ctx),
            other => other.to_string(),
        })
    })?;
    if result.len() > MAX_RESULT_BYTES {
        return Err("脚本返回的结果过大。".to_string());
    }
    Ok(result)
}

#[tauri::command]
pub async fn youtube_eval_script(script: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || eval_player_script(&script, EVAL_TIMEOUT))
        .await
        .map_err(|error| format!("脚本任务失败：{error}"))?
}

fn player_cache_dir() -> Result<PathBuf, String> {
    crate::youtube_net::seamind_data_dir()
        .map(|dir| dir.join("cache").join("youtube-player"))
        .ok_or_else(|| "无法确定 Seamind 的缓存目录。".to_string())
}

fn cache_file(key: &str) -> Result<PathBuf, String> {
    let valid = !key.is_empty()
        && key.len() <= 64
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    if !valid {
        return Err("缓存键无效。".to_string());
    }
    Ok(player_cache_dir()?.join(format!("{key}.cache")))
}

fn prune_cache(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(SystemTime, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|extension| extension == "cache"))
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .collect();
    files.sort_by(|left, right| right.0.cmp(&left.0));
    for (_, path) in files.into_iter().skip(MAX_CACHE_ENTRIES) {
        let _ = std::fs::remove_file(path);
    }
}

/// Opaque text storage for YouTube.js, which caches the processed player script per player version
/// so only the first video after a player update pays for downloading and parsing it.
#[tauri::command]
pub async fn youtube_player_cache_get(key: String) -> Result<Option<String>, String> {
    let path = cache_file(&key)?;
    match std::fs::read_to_string(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取播放器缓存：{error}")),
    }
}

#[tauri::command]
pub async fn youtube_player_cache_set(key: String, value: String) -> Result<(), String> {
    if value.len() > MAX_CACHE_VALUE_BYTES {
        return Err("播放器缓存内容过大。".to_string());
    }
    let path = cache_file(&key)?;
    let dir = player_cache_dir()?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("无法创建缓存目录：{error}"))?;
    crate::youtube_net::write_file_atomically(&path, value.as_bytes())
        .map_err(|error| format!("无法写入播放器缓存：{error}"))?;
    prune_cache(&dir);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Same shape as the script YouTube.js assembles: an extracted function exposed through
    /// `exportedVars`, followed by a `process` wrapper whose result is returned.
    const SYNTHETIC_PLAYER_SCRIPT: &str = r#"
const exportedVars = (function (g) {
  function reverse(value) { return value.split('').reverse().join(''); }
  function nsigFunction(url, sp, s) {
    const n = decodeURIComponent((/[?&]n=([^&]*)/.exec(url) || [])[1] || '');
    return {
      get(name) { return name === 'n' ? encodeURIComponent(reverse(n)) : undefined; },
      refresh() {},
    };
  }
  return { nsigFunction };
})({});

function process(n = "", sp = "", s = "") {
  const ctor = exportedVars.nsigFunction("https://example.invalid/videoplayback?n=" + encodeURIComponent(n), sp, s);
  const nResult = ctor.get('n');
  return { n: nResult ? decodeURIComponent(nResult) : undefined };
}

return process("abcdef", "", "");
"#;

    #[test]
    fn evaluates_a_player_style_script() {
        let result =
            eval_player_script(SYNTHETIC_PLAYER_SCRIPT, Duration::from_secs(5)).expect("script runs");
        assert_eq!(result, r#"{"n":"fedcba"}"#);
    }

    #[test]
    fn reports_script_errors() {
        let error = eval_player_script("throw new Error('no decipher function');", Duration::from_secs(5))
            .expect_err("must fail");
        assert!(error.contains("no decipher function"), "{error}");
        let syntax = eval_player_script("return (;", Duration::from_secs(5)).expect_err("must fail");
        assert!(!syntax.is_empty());
    }

    #[test]
    fn maps_undefined_results_to_null() {
        assert_eq!(
            eval_player_script("return undefined;", Duration::from_secs(5)).unwrap(),
            "null"
        );
    }

    #[test]
    fn interrupts_runaway_scripts() {
        let started = Instant::now();
        let error = eval_player_script("while (true) {}", Duration::from_millis(300)).expect_err("must stop");
        assert!(started.elapsed() < Duration::from_secs(3), "took {:?}", started.elapsed());
        assert!(!error.is_empty());
    }

    #[test]
    fn caps_memory_use() {
        let error = eval_player_script(
            "let s = 'x'.repeat(1 << 20); const parts = []; while (true) { parts.push(s + parts.length); }",
            Duration::from_secs(20),
        )
        .expect_err("must hit a limit");
        assert!(!error.is_empty());
    }

    #[test]
    fn rejects_oversized_scripts_and_results() {
        assert!(eval_player_script(&"a".repeat(MAX_SCRIPT_BYTES + 1), Duration::from_secs(1)).is_err());
        let result = eval_player_script(
            "return 'y'.repeat(70000);",
            Duration::from_secs(5),
        );
        assert!(result.expect_err("too large").contains("过大"));
    }

    #[test]
    fn has_no_ambient_io() {
        for probe in ["return typeof std;", "return typeof os;", "return typeof require;", "return typeof process;", "return typeof fetch;"] {
            assert_eq!(
                eval_player_script(probe, Duration::from_secs(5)).unwrap(),
                r#""undefined""#,
                "{probe}"
            );
        }
    }

    #[test]
    fn validates_cache_keys() {
        assert!(cache_file("67288f35").is_ok());
        assert!(cache_file("player_id-1").is_ok());
        for key in ["", "../escape", "a/b", "a\\b", "a.b", &"k".repeat(65)] {
            assert!(cache_file(key).is_err(), "{key:?}");
        }
    }

    /// Run with `SEAMIND_PLAYER_FIXTURE=<json>` pointing at a script captured from the live player
    /// (`{"script": "...", "expected": {...}}`) to check the engine against Google's real code.
    #[test]
    #[ignore = "needs a captured player fixture"]
    fn evaluates_a_real_player_fixture() {
        let path = std::env::var("SEAMIND_PLAYER_FIXTURE").expect("SEAMIND_PLAYER_FIXTURE");
        let fixture: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let script = fixture["script"].as_str().unwrap();
        let result = eval_player_script(script, Duration::from_secs(8)).unwrap();
        assert_eq!(result, fixture["expected"].to_string());
    }
}
