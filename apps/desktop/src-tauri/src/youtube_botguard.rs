use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{
    webview::PageLoadEvent, AppHandle, Manager, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tokio::sync::{oneshot, watch, Mutex};

const PAGE_URL: &str = "https://www.youtube.com/";
const PAGE_LOAD_TIMEOUT: Duration = Duration::from_secs(30);
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_millis(150);
const BOTGUARD_RUNTIME: &str =
    include_str!(concat!(env!("OUT_DIR"), "/youtube_botguard_runtime.js"));

#[derive(Default)]
pub struct YouTubeBotGuardState {
    lock: Mutex<()>,
}

#[tauri::command(rename_all = "camelCase")]
pub async fn youtube_botguard_snapshot(
    app: AppHandle,
    state: State<'_, YouTubeBotGuardState>,
    request_id: String,
    content_binding: String,
    challenge: Value,
    interpreter_javascript: String,
    yt_config: Value,
    user_agent: String,
) -> Result<Value, String> {
    let _guard = state.lock.lock().await;
    if interpreter_javascript.trim().is_empty() {
        return Err("YouTube returned an empty BotGuard interpreter.".to_string());
    }
    let label = window_label(&request_id)?;
    let window = get_or_create_window(&app, &label, &user_agent).await?;
    let payload = json!({
        "requestId": request_id,
        "contentBinding": content_binding,
        "challenge": challenge,
        "ytConfig": yt_config,
    });
    let payload = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
    let invocation = format!(
        "(() => {{ try {{ if (typeof window.__seamindBotGuardSnapshot !== 'function') return {{ error: 'BotGuard runtime did not initialize on YouTube origin.' }}; window.__seamindBotGuardSnapshot({payload}); return {{ started: true }}; }} catch (error) {{ return {{ error: String(error) }}; }} }})()"
    );
    // Native WebView evaluation bypasses the page's script-src/Trusted Types checks, as the
    // reference Electron implementation does with executeJavaScript. The interpreter still runs
    // in the isolated, hidden YouTube-origin WebView.
    let script = format!("{interpreter_javascript}\n;{invocation}");
    let result = async {
        let ack = evaluate_json(&window, script).await?;
        if let Some(error) = ack.get("error").and_then(Value::as_str) {
            return Err(error.to_string());
        }
        wait_for_result(&window, &request_id).await
    }
    .await;
    if result.is_err() {
        let _ = window.destroy();
    }
    result
}

#[tauri::command(rename_all = "camelCase")]
pub async fn youtube_botguard_mint(
    app: AppHandle,
    state: State<'_, YouTubeBotGuardState>,
    request_id: String,
    content_binding: String,
    integrity_token: String,
) -> Result<String, String> {
    let _guard = state.lock.lock().await;
    let label = window_label(&request_id)?;
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| "The hidden YouTube BotGuard WebView is unavailable.".to_string())?;
    let payload = json!({
        "requestId": request_id,
        "contentBinding": content_binding,
        "integrityToken": integrity_token,
    });
    let payload = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
    let script = format!(
        "(() => {{ try {{ if (typeof window.__seamindBotGuardMint !== 'function') return {{ error: 'BotGuard runtime is missing from the YouTube WebView.' }}; window.__seamindBotGuardMint({payload}); return {{ started: true }}; }} catch (error) {{ return {{ error: String(error) }}; }} }})()"
    );
    let token = async {
        let ack = evaluate_json(&window, script).await?;
        if let Some(error) = ack.get("error").and_then(Value::as_str) {
            return Err(error.to_string());
        }
        let result = wait_for_result(&window, &request_id).await?;
        result
            .get("token")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "YouTube BotGuard did not return a PO token.".to_string())
    }
    .await;
    let _ = window.destroy();
    token
}

#[tauri::command(rename_all = "camelCase")]
pub async fn youtube_botguard_discard(
    app: AppHandle,
    state: State<'_, YouTubeBotGuardState>,
    request_id: String,
) -> Result<(), String> {
    let _guard = state.lock.lock().await;
    if let Ok(label) = window_label(&request_id) {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.destroy();
        }
    }
    Ok(())
}

fn window_label(request_id: &str) -> Result<String, String> {
    let id = uuid::Uuid::parse_str(request_id)
        .map_err(|_| "Invalid YouTube BotGuard request id.".to_string())?;
    Ok(format!("youtube-botguard-{}", id.simple()))
}

// YouTube may redirect to consent or another canonical subdomain; mirror the runtime allowlist.
fn is_youtube_host(host: &str) -> bool {
    host == "youtube.com" || host.ends_with(".youtube.com")
}

async fn get_or_create_window(
    app: &AppHandle,
    label: &str,
    user_agent: &str,
) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(label) {
        return Ok(window);
    }

    let url = PAGE_URL
        .parse()
        .map_err(|error: url::ParseError| error.to_string())?;
    let (ready_tx, mut ready_rx) = watch::channel(false);
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("YouTube BotGuard")
        .inner_size(1920.0, 1080.0)
        .resizable(false)
        .decorations(false)
        .focusable(false)
        .skip_taskbar(true)
        .visible(false)
        .incognito(true)
        .user_agent(user_agent)
        .initialization_script(BOTGUARD_RUNTIME)
        .on_navigation(|url| {
            url.scheme() == "https"
                && url.host_str().is_some_and(is_youtube_host)
        })
        .on_page_load(move |_, payload| {
            if payload.event() == PageLoadEvent::Finished
                && payload.url().scheme() == "https"
                && payload.url().host_str().is_some_and(is_youtube_host)
            {
                ready_tx.send_replace(true);
            }
        })
        .build()
        .map_err(|error| format!("Could not create the hidden YouTube WebView: {error}"))?;

    let loaded = tokio::time::timeout(PAGE_LOAD_TIMEOUT, async {
        loop {
            if *ready_rx.borrow() {
                return Ok(());
            }
            ready_rx
                .changed()
                .await
                .map_err(|_| "YouTube WebView closed before loading.".to_string())?;
        }
    })
    .await;
    match loaded {
        Ok(Ok(())) => Ok(window),
        Ok(Err(error)) => {
            let _ = window.close();
            Err(error)
        }
        Err(_) => {
            let _ = window.close();
            Err("Timed out loading the hidden YouTube WebView.".to_string())
        }
    }
}

async fn evaluate_json(window: &WebviewWindow, script: String) -> Result<Value, String> {
    let (sender, receiver) = oneshot::channel();
    let sender = Arc::new(StdMutex::new(Some(sender)));
    let callback_sender = Arc::clone(&sender);
    window
        .eval_with_callback(script, move |result| {
            if let Ok(mut sender) = callback_sender.lock() {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(result);
                }
            }
        })
        .map_err(|error| format!("Could not evaluate BotGuard script: {error}"))?;
    let result = tokio::time::timeout(SCRIPT_TIMEOUT, receiver)
        .await
        .map_err(|_| "Timed out evaluating BotGuard script.".to_string())?
        .map_err(|_| "YouTube WebView closed before returning a result.".to_string())?;
    serde_json::from_str(&result)
        .map_err(|error| format!("Invalid result from YouTube BotGuard WebView: {error}"))
}

async fn wait_for_result(window: &WebviewWindow, request_id: &str) -> Result<Value, String> {
    let deadline = Instant::now() + SCRIPT_TIMEOUT;
    loop {
        let result = evaluate_json(
            window,
            "(() => window.__seamindBotGuardResult ?? null)()".to_string(),
        )
        .await?;
        if result
            .get("requestId")
            .and_then(Value::as_str)
            .is_some_and(|id| id == request_id)
        {
            if result.get("ok").and_then(Value::as_bool) == Some(true) {
                return Ok(result);
            }
            return Err(result
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("YouTube BotGuard failed.")
                .to_string());
        }
        if Instant::now() >= deadline {
            return Err("Timed out waiting for YouTube BotGuard.".to_string());
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}
