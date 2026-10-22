use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, Request, Response, StatusCode},
    routing::any,
    Router,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State as TauriState};
use url::Url;
use uuid::Uuid;

use crate::youtube_net::{default_user_agent, RedirectScope, YouTubeNet};

const MAX_REQUEST_BODY_BYTES: usize = 1_048_576;
const MAX_TARGET_URL_BYTES: usize = 8_192;
const API_TIMEOUT: Duration = Duration::from_secs(45);
const TOKEN_HEADER: &str = "x-seamind-token";
const USER_AGENT_HEADER: &str = "x-seamind-ua";
const ALLOWED_HOST_SUFFIXES: [&str; 3] = ["googlevideo.com", "youtube.com", "ytimg.com"];
const ALLOWED_ORIGINS: [&str; 5] = [
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
    "http://127.0.0.1:1420",
    "http://localhost:1420",
];
const FORWARDED_REQUEST_HEADERS: [&str; 9] = [
    "accept",
    "accept-language",
    "content-type",
    "range",
    "if-range",
    "x-goog-visitor-id",
    "x-goog-api-format-version",
    "x-youtube-client-name",
    "x-youtube-client-version",
];
const PASSED_RESPONSE_HEADERS: [&str; 4] = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
];
const EXPOSED_RESPONSE_HEADERS: &str = "content-length, content-range, content-type, accept-ranges";

/// Debug builds and tests may point the proxy at a loopback upstream; release builds never do.
static ALLOW_LOOPBACK_UPSTREAM: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyEndpoint {
    pub origin: String,
    pub token: String,
}

type ClientProvider = Box<dyn Fn() -> Result<reqwest::Client, String> + Send + Sync>;

const REDIRECT_MEMORY_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_REMEMBERED_REDIRECTS: usize = 256;

/// googlevideo often answers the first request for a stream with a redirect to a nearer cache node,
/// and that redirect closes the connection. Behind a proxy or VPN every new connection costs a full
/// TLS handshake over the slow path, so a player's small segment requests were each paying for two.
/// Remembering where an address ended up lets later requests go straight to the final node and reuse
/// its keep-alive connection.
#[derive(Default)]
struct RedirectMemory(Mutex<HashMap<String, (Url, Instant)>>);

impl RedirectMemory {
    fn get(&self, from: &Url) -> Option<Url> {
        let entries = self.0.lock().ok()?;
        let (to, stored_at) = entries.get(from.as_str())?;
        (stored_at.elapsed() < REDIRECT_MEMORY_TTL).then(|| to.clone())
    }

    fn remember(&self, from: &Url, to: &Url) {
        let Ok(mut entries) = self.0.lock() else {
            return;
        };
        entries.retain(|_, (_, stored_at)| stored_at.elapsed() < REDIRECT_MEMORY_TTL);
        if entries.len() >= MAX_REMEMBERED_REDIRECTS {
            if let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, (_, stored_at))| *stored_at)
                .map(|(key, _)| key.clone())
            {
                entries.remove(&oldest);
            }
        }
        entries.insert(from.as_str().to_string(), (to.clone(), Instant::now()));
    }

    fn forget(&self, from: &Url) {
        if let Ok(mut entries) = self.0.lock() {
            entries.remove(from.as_str());
        }
    }
}

struct ProxyContext {
    token: String,
    host: String,
    client: ClientProvider,
    redirects: RedirectMemory,
}

fn host_matches(host: &str, suffix: &str) -> bool {
    host == suffix
        || host
            .strip_suffix(suffix)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

fn is_allowed_target_with(url: &Url, allow_loopback: bool) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    if allow_loopback && url.scheme() == "http" && matches!(host, "127.0.0.1" | "localhost") {
        return true;
    }
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && ALLOWED_HOST_SUFFIXES
            .iter()
            .any(|suffix| host_matches(host, suffix))
}

/// The only places the proxy will talk to: YouTube's API and player scripts, its media servers and
/// its thumbnail host. Redirects are re-checked against the same rule.
pub fn is_allowed_target(url: &Url) -> bool {
    is_allowed_target_with(url, ALLOW_LOOPBACK_UPSTREAM.load(Ordering::Relaxed))
}

fn is_media_host(url: &Url) -> bool {
    url.host_str()
        .is_some_and(|host| host_matches(host, "googlevideo.com"))
}

/// Media servers are the only hosts whose redirects are stable enough to remember; a loopback
/// upstream stands in for them when a debug build or a test allows one.
fn is_redirect_worth_remembering(url: &Url) -> bool {
    is_media_host(url)
        || (ALLOW_LOOPBACK_UPSTREAM.load(Ordering::Relaxed)
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost")))
}

fn is_allowed_origin(origin: &str) -> bool {
    ALLOWED_ORIGINS.contains(&origin)
}

fn tokens_match(expected: &str, provided: &str) -> bool {
    expected.len() == provided.len()
        && expected
            .bytes()
            .zip(provided.bytes())
            .fold(0_u8, |difference, (left, right)| difference | (left ^ right))
            == 0
}

fn valid_user_agent(value: &HeaderValue) -> Option<HeaderValue> {
    let bytes = value.as_bytes();
    (!bytes.is_empty() && bytes.len() <= 512 && bytes.iter().all(|byte| (0x20..0x7f).contains(byte)))
        .then(|| value.clone())
}

/// Builds the headers that go upstream: a fixed allow-list from the page, a YouTube-looking
/// Origin/Referer, and the user agent the page asked for. Cookies and credentials never pass.
fn upstream_headers(incoming: &HeaderMap, target: &Url) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for name in FORWARDED_REQUEST_HEADERS {
        if let Some(value) = incoming.get(name) {
            headers.insert(HeaderName::from_static(name), value.clone());
        }
    }
    let user_agent = incoming
        .get(USER_AGENT_HEADER)
        .and_then(valid_user_agent)
        .unwrap_or_else(|| HeaderValue::from_static(default_user_agent()));
    headers.insert(header::USER_AGENT, user_agent);
    headers.insert(header::ORIGIN, HeaderValue::from_static("https://www.youtube.com"));
    headers.insert(header::REFERER, HeaderValue::from_static("https://www.youtube.com/"));
    if is_media_host(target) || incoming.contains_key(header::RANGE) {
        headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    }
    headers
}

struct ProxyError {
    status: StatusCode,
    message: String,
}

impl ProxyError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

fn target_from_query(query: Option<&str>) -> Result<Url, ProxyError> {
    let raw = url::form_urlencoded::parse(query.unwrap_or_default().as_bytes())
        .find_map(|(key, value)| (key == "u").then(|| value.into_owned()))
        .ok_or_else(|| ProxyError::new(StatusCode::BAD_REQUEST, "缺少目标地址。"))?;
    if raw.len() > MAX_TARGET_URL_BYTES {
        return Err(ProxyError::new(StatusCode::BAD_REQUEST, "目标地址过长。"));
    }
    Url::parse(&raw).map_err(|_| ProxyError::new(StatusCode::BAD_REQUEST, "目标地址无效。"))
}

fn origin_of(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

fn authorize(ctx: &ProxyContext, headers: &HeaderMap) -> Result<(), ProxyError> {
    let host_ok = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| host == ctx.host);
    if !host_ok {
        return Err(ProxyError::new(StatusCode::FORBIDDEN, "主机头不匹配。"));
    }
    if let Some(origin) = origin_of(headers) {
        if !is_allowed_origin(&origin) {
            return Err(ProxyError::new(StatusCode::FORBIDDEN, "来源不被允许。"));
        }
    }
    let token_ok = headers
        .get(TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|token| tokens_match(&ctx.token, token));
    if !token_ok {
        return Err(ProxyError::new(StatusCode::UNAUTHORIZED, "访问令牌无效。"));
    }
    Ok(())
}

fn apply_cors(response: &mut Response<Body>, origin: Option<&str>) {
    let Some(origin) = origin.filter(|origin| is_allowed_origin(origin)) else {
        return;
    };
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(origin) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static(EXPOSED_RESPONSE_HEADERS),
    );
}

fn error_response(error: ProxyError, origin: Option<&str>) -> Response<Body> {
    let body = serde_json::json!({ "error": error.message }).to_string();
    let mut response = Response::builder()
        .status(error.status)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .body(Body::from(body))
        .unwrap_or_default();
    apply_cors(&mut response, origin);
    response
}

fn preflight(ctx: &ProxyContext, headers: &HeaderMap) -> Result<Response<Body>, ProxyError> {
    let host_ok = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| host == ctx.host);
    let origin = origin_of(headers).filter(|origin| is_allowed_origin(origin));
    let (true, Some(origin)) = (host_ok, origin) else {
        return Err(ProxyError::new(StatusCode::FORBIDDEN, "来源不被允许。"));
    };

    let requested = headers
        .get(header::ACCESS_CONTROL_REQUEST_HEADERS)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let acceptable = requested
        .split(',')
        .map(|name| name.trim().to_ascii_lowercase())
        .filter(|name| !name.is_empty())
        .all(|name| {
            name == TOKEN_HEADER
                || name == USER_AGENT_HEADER
                || FORWARDED_REQUEST_HEADERS.contains(&name.as_str())
        });
    if !acceptable {
        return Err(ProxyError::new(StatusCode::FORBIDDEN, "请求头不被允许。"));
    }

    let mut response = Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, POST, OPTIONS")
        .header(header::ACCESS_CONTROL_MAX_AGE, "600")
        .header("access-control-allow-private-network", "true")
        .body(Body::empty())
        .unwrap_or_default();
    if let Ok(value) = HeaderValue::from_str(requested) {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_HEADERS, value);
    }
    apply_cors(&mut response, Some(&origin));
    Ok(response)
}

fn map_upstream_error(error: reqwest::Error) -> ProxyError {
    if error.is_timeout() {
        ProxyError::new(StatusCode::GATEWAY_TIMEOUT, "连接 YouTube 超时。")
    } else if error.is_connect() {
        ProxyError::new(StatusCode::BAD_GATEWAY, "无法连接 YouTube，请检查网络或代理。")
    } else {
        ProxyError::new(StatusCode::BAD_GATEWAY, "请求 YouTube 失败。")
    }
}

async fn forward(
    ctx: &ProxyContext,
    request: Request<Body>,
) -> Result<Response<Body>, ProxyError> {
    let (parts, body) = request.into_parts();
    authorize(ctx, &parts.headers)?;
    let method = match parts.method {
        Method::GET | Method::HEAD | Method::POST => parts.method.clone(),
        _ => {
            return Err(ProxyError::new(StatusCode::METHOD_NOT_ALLOWED, "不支持该请求方法。"));
        }
    };
    let target = target_from_query(parts.uri.query())?;
    if !is_allowed_target(&target) {
        return Err(ProxyError::new(
            StatusCode::FORBIDDEN,
            "目标地址不在允许的 YouTube 域名内。",
        ));
    }
    let payload = axum::body::to_bytes(body, MAX_REQUEST_BODY_BYTES)
        .await
        .map_err(|_| ProxyError::new(StatusCode::PAYLOAD_TOO_LARGE, "请求内容过大。"))?;

    let client = (ctx.client)().map_err(|message| ProxyError::new(StatusCode::BAD_GATEWAY, message))?;
    let send = |url: &Url| {
        let mut request = client
            .request(method.clone(), url.clone())
            .headers(upstream_headers(&parts.headers, url));
        if !payload.is_empty() {
            request = request.body(payload.clone());
        }
        if !is_media_host(url) {
            request = request.timeout(API_TIMEOUT);
        }
        request.send()
    };

    // Only repeatable requests may skip a hop that was seen before, and only to somewhere the
    // proxy would have been allowed to follow anyway.
    let repeatable = matches!(method, Method::GET | Method::HEAD);
    let remembered = repeatable
        .then(|| ctx.redirects.get(&target))
        .flatten()
        .filter(is_allowed_target);
    let mut upstream = send(remembered.as_ref().unwrap_or(&target)).await;
    if remembered.is_some()
        && upstream
            .as_ref()
            .map_or(true, |response| !response.status().is_success())
    {
        // The node that answered last time no longer does: forget it and ask the original address.
        ctx.redirects.forget(&target);
        upstream = send(&target).await;
    }
    let upstream = upstream.map_err(map_upstream_error)?;
    if remembered.is_none()
        && repeatable
        && is_redirect_worth_remembering(&target)
        && upstream.status().is_success()
        && upstream.url() != &target
        && is_allowed_target(upstream.url())
    {
        ctx.redirects.remember(&target, upstream.url());
    }
    if upstream.status().is_redirection() {
        return Err(ProxyError::new(
            StatusCode::BAD_GATEWAY,
            "YouTube 返回了不受信任的重定向。",
        ));
    }

    let mut response = Response::builder().status(upstream.status());
    for name in PASSED_RESPONSE_HEADERS {
        if let Some(value) = upstream.headers().get(name) {
            response = response.header(name, value);
        }
    }
    response
        .body(Body::from_stream(upstream.bytes_stream()))
        .map_err(|_| ProxyError::new(StatusCode::BAD_GATEWAY, "无法转发 YouTube 响应。"))
}

async fn handle(State(ctx): State<Arc<ProxyContext>>, request: Request<Body>) -> Response<Body> {
    let origin = origin_of(request.headers());
    if request.method() == Method::OPTIONS {
        return preflight(&ctx, request.headers())
            .unwrap_or_else(|error| error_response(error, origin.as_deref()));
    }
    match forward(&ctx, request).await {
        Ok(mut response) => {
            apply_cors(&mut response, origin.as_deref());
            response
        }
        Err(error) => error_response(error, origin.as_deref()),
    }
}

async fn start(client: ClientProvider) -> Result<ProxyEndpoint, String> {
    #[cfg(debug_assertions)]
    if std::env::var_os("SEAMIND_YT_PROXY_ALLOW_LOOPBACK").is_some_and(|value| value == "1") {
        ALLOW_LOOPBACK_UPSTREAM.store(true, Ordering::Relaxed);
    }

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|_| "无法启动 Seamind 本地媒体代理。".to_string())?;
    let address = listener
        .local_addr()
        .map_err(|_| "无法读取 Seamind 本地媒体代理地址。".to_string())?;
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let context = Arc::new(ProxyContext {
        token: token.clone(),
        host: address.to_string(),
        client,
        redirects: RedirectMemory::default(),
    });
    let router = Router::new().route("/fetch", any(handle)).with_state(context);
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("Seamind media proxy stopped: {error}");
        }
    });
    Ok(ProxyEndpoint {
        origin: format!("http://{address}"),
        token,
    })
}

/// Starts the loopback proxy on first use. The page sends `x-seamind-token` and the target as
/// `?u=`; the proxy adds the headers YouTube expects and relays the stream with CORS enabled.
#[tauri::command]
pub async fn youtube_proxy_info(
    app: AppHandle,
    net: TauriState<'_, YouTubeNet>,
) -> Result<ProxyEndpoint, String> {
    let endpoint = net
        .endpoint()
        .get_or_try_init(|| async move {
            let provider: ClientProvider = Box::new(move || {
                app.state::<YouTubeNet>().client(RedirectScope::YouTube)
            });
            start(provider).await
        })
        .await?;
    Ok(endpoint.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;

    fn url(value: &str) -> Url {
        Url::parse(value).expect("test url")
    }

    #[test]
    fn allows_only_youtube_hosts_over_https() {
        for allowed in [
            "https://www.youtube.com/youtubei/v1/player",
            "https://youtube.com/iframe_api",
            "https://rr1---sn-abc.googlevideo.com/videoplayback?x=1",
            "https://manifest.googlevideo.com/api/manifest/hls_variant",
            "https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg",
        ] {
            assert!(is_allowed_target_with(&url(allowed), false), "{allowed}");
        }
        for denied in [
            "http://www.youtube.com/",
            "https://example.com/",
            "https://notyoutube.com/",
            "https://youtube.com.evil.example/",
            "https://www.youtube.com:8443/",
            "https://user@www.youtube.com/",
            "https://googlevideo.com.example/",
            "http://127.0.0.1:9/",
            "ftp://www.youtube.com/",
        ] {
            assert!(!is_allowed_target_with(&url(denied), false), "{denied}");
        }
        assert!(is_allowed_target_with(&url("http://127.0.0.1:9/"), true));
        assert!(!is_allowed_target_with(&url("http://example.com/"), true));
    }

    #[test]
    fn accepts_only_app_origins() {
        assert!(is_allowed_origin("http://tauri.localhost"));
        assert!(is_allowed_origin("http://127.0.0.1:1420"));
        assert!(!is_allowed_origin("https://www.youtube.com"));
        assert!(!is_allowed_origin("http://evil.localhost"));
        assert!(!is_allowed_origin("null"));
    }

    #[test]
    fn compares_tokens_without_short_circuiting() {
        assert!(tokens_match("abc123", "abc123"));
        assert!(!tokens_match("abc123", "abc124"));
        assert!(!tokens_match("abc123", "abc12"));
        assert!(!tokens_match("abc123", ""));
    }

    #[test]
    fn builds_upstream_headers_from_an_allow_list() {
        let mut incoming = HeaderMap::new();
        incoming.insert("range", HeaderValue::from_static("bytes=0-99"));
        incoming.insert("cookie", HeaderValue::from_static("SID=secret"));
        incoming.insert("authorization", HeaderValue::from_static("Bearer secret"));
        incoming.insert("origin", HeaderValue::from_static("http://tauri.localhost"));
        incoming.insert("referer", HeaderValue::from_static("http://tauri.localhost/"));
        incoming.insert("x-seamind-token", HeaderValue::from_static("token"));
        incoming.insert("x-goog-visitor-id", HeaderValue::from_static("visitor"));
        incoming.insert(
            "x-seamind-ua",
            HeaderValue::from_static("com.example.app/1.0 (Linux; U; Android 12)"),
        );

        let headers = upstream_headers(&incoming, &url("https://rr1---sn-a.googlevideo.com/videoplayback"));
        assert_eq!(headers["range"], "bytes=0-99");
        assert_eq!(headers["x-goog-visitor-id"], "visitor");
        assert_eq!(headers["user-agent"], "com.example.app/1.0 (Linux; U; Android 12)");
        assert_eq!(headers["origin"], "https://www.youtube.com");
        assert_eq!(headers["referer"], "https://www.youtube.com/");
        assert_eq!(headers["accept-encoding"], "identity");
        for dropped in ["cookie", "authorization", "x-seamind-token", "x-seamind-ua"] {
            assert!(!headers.contains_key(dropped), "{dropped} must not be forwarded");
        }
    }

    #[test]
    fn falls_back_to_the_default_user_agent_for_bad_values() {
        let mut incoming = HeaderMap::new();
        incoming.insert("x-seamind-ua", HeaderValue::from_bytes(b"agent-\xe9").unwrap());
        let headers = upstream_headers(&incoming, &url("https://www.youtube.com/youtubei/v1/player"));
        assert_eq!(headers["user-agent"], default_user_agent());
        assert!(!headers.contains_key("accept-encoding"));
    }

    #[test]
    fn extracts_the_target_from_the_query() {
        let target = target_from_query(Some("u=https%3A%2F%2Fwww.youtube.com%2Fiframe_api%3Fa%3D1%26b%3D2"))
            .ok()
            .expect("target");
        assert_eq!(target.as_str(), "https://www.youtube.com/iframe_api?a=1&b=2");
        assert!(target_from_query(None).is_err());
        assert!(target_from_query(Some("x=1")).is_err());
        assert!(target_from_query(Some("u=not a url")).is_err());
    }

    /// What the test upstream saw, in order, plus counters for the endpoints that change over time.
    #[derive(Default)]
    struct UpstreamState {
        requested: Mutex<Vec<String>>,
        moving_calls: std::sync::atomic::AtomicUsize,
        first_node_hits: std::sync::atomic::AtomicUsize,
    }

    impl UpstreamState {
        fn requested(&self) -> Vec<String> {
            self.requested.lock().unwrap().clone()
        }
    }

    async fn upstream() -> (u16, Arc<UpstreamState>) {
        async fn echo(request: Request<Body>) -> axum::Json<serde_json::Value> {
            let (parts, body) = request.into_parts();
            let bytes = axum::body::to_bytes(body, 1 << 20).await.unwrap_or_default();
            let header = |name: &str| {
                parts
                    .headers
                    .get(name)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string)
            };
            axum::Json(serde_json::json!({
                "method": parts.method.as_str(),
                "range": header("range"),
                "userAgent": header("user-agent"),
                "origin": header("origin"),
                "referer": header("referer"),
                "cookie": header("cookie"),
                "token": header("x-seamind-token"),
                "body": String::from_utf8_lossy(&bytes),
            }))
        }
        async fn partial() -> Response<Body> {
            Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_TYPE, "video/mp4")
                .header(header::CONTENT_RANGE, "bytes 0-9/100")
                .header(header::SET_COOKIE, "tracker=1")
                .body(Body::from(vec![7_u8; 10]))
                .unwrap()
        }
        async fn hop() -> Response<Body> {
            Response::builder()
                .status(StatusCode::FOUND)
                .header(header::LOCATION, "/echo")
                .body(Body::empty())
                .unwrap()
        }
        async fn leave() -> Response<Body> {
            Response::builder()
                .status(StatusCode::FOUND)
                .header(header::LOCATION, "https://example.com/elsewhere")
                .body(Body::empty())
                .unwrap()
        }
        // Hands out a new "node" on every call; the first node answers once and then stops.
        async fn moving(State(state): State<Arc<UpstreamState>>) -> Response<Body> {
            let call = state.moving_calls.fetch_add(1, Ordering::SeqCst) + 1;
            Response::builder()
                .status(StatusCode::FOUND)
                .header(header::LOCATION, format!("/node?v={call}"))
                .body(Body::empty())
                .unwrap()
        }
        async fn node(
            State(state): State<Arc<UpstreamState>>,
            request: Request<Body>,
        ) -> Response<Body> {
            let version = request.uri().query().unwrap_or_default().to_string();
            let gone = version == "v=1" && state.first_node_hits.fetch_add(1, Ordering::SeqCst) >= 1;
            Response::builder()
                .status(if gone { StatusCode::GONE } else { StatusCode::OK })
                .body(Body::from(format!("node-{version}")))
                .unwrap()
        }
        async fn record(
            State(state): State<Arc<UpstreamState>>,
            request: Request<Body>,
            next: axum::middleware::Next,
        ) -> Response<Body> {
            state.requested.lock().unwrap().push(request.uri().path().to_string());
            next.run(request).await
        }
        let state = Arc::new(UpstreamState::default());
        let router = Router::new()
            .route("/echo", any(echo))
            .route("/partial", get(partial))
            .route("/hop", get(hop))
            .route("/leave", get(leave))
            .route("/moving", get(moving))
            .route("/node", get(node))
            .layer(axum::middleware::from_fn_with_state(state.clone(), record))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (port, state)
    }

    struct Harness {
        endpoint: ProxyEndpoint,
        upstream_port: u16,
        upstream: Arc<UpstreamState>,
        http: reqwest::Client,
    }

    impl Harness {
        async fn new() -> Self {
            ALLOW_LOOPBACK_UPSTREAM.store(true, Ordering::Relaxed);
            let (upstream_port, upstream) = upstream().await;
            let client = crate::youtube_net::build_client(None, RedirectScope::YouTube).unwrap();
            let endpoint = start(Box::new(move || Ok(client.clone()))).await.unwrap();
            Self {
                endpoint,
                upstream_port,
                upstream,
                http: reqwest::Client::new(),
            }
        }

        fn fetch(&self, path: &str) -> reqwest::RequestBuilder {
            let target = format!("http://127.0.0.1:{}{path}", self.upstream_port);
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("u", &target)
                .finish();
            self.http
                .get(format!("{}/fetch?{query}", self.endpoint.origin))
                .header("origin", "http://tauri.localhost")
                .header(TOKEN_HEADER, &self.endpoint.token)
        }
    }

    #[tokio::test]
    async fn relays_requests_with_youtube_headers_and_cors() {
        let harness = Harness::new().await;
        let response = harness
            .fetch("/echo")
            .header("range", "bytes=5-9")
            .header("cookie", "SID=secret")
            .header(USER_AGENT_HEADER, "Seamind-Test/1")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers()["access-control-allow-origin"],
            "http://tauri.localhost"
        );
        let echoed: serde_json::Value = response.json().await.unwrap();
        assert_eq!(echoed["method"], "GET");
        assert_eq!(echoed["range"], "bytes=5-9");
        assert_eq!(echoed["userAgent"], "Seamind-Test/1");
        assert_eq!(echoed["origin"], "https://www.youtube.com");
        assert_eq!(echoed["referer"], "https://www.youtube.com/");
        assert!(echoed["cookie"].is_null(), "cookies must not reach YouTube");
        assert!(echoed["token"].is_null(), "the proxy token must not reach YouTube");
    }

    #[tokio::test]
    async fn forwards_post_bodies_and_media_status_codes() {
        let harness = Harness::new().await;
        let target = format!("http://127.0.0.1:{}/echo", harness.upstream_port);
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("u", &target)
            .finish();
        let response = harness
            .http
            .post(format!("{}/fetch?{query}", harness.endpoint.origin))
            .header("origin", "http://tauri.localhost")
            .header(TOKEN_HEADER, &harness.endpoint.token)
            .body(r#"{"videoId":"abc"}"#)
            .send()
            .await
            .unwrap();
        let echoed: serde_json::Value = response.json().await.unwrap();
        assert_eq!(echoed["method"], "POST");
        assert_eq!(echoed["body"], r#"{"videoId":"abc"}"#);

        let partial = harness.fetch("/partial").send().await.unwrap();
        assert_eq!(partial.status(), 206);
        assert_eq!(partial.headers()["content-range"], "bytes 0-9/100");
        assert!(!partial.headers().contains_key("set-cookie"));
        assert_eq!(partial.bytes().await.unwrap().len(), 10);
    }

    #[tokio::test]
    async fn follows_allowed_redirects_but_not_others() {
        let harness = Harness::new().await;
        let followed: serde_json::Value = harness.fetch("/hop").send().await.unwrap().json().await.unwrap();
        assert_eq!(followed["method"], "GET");

        let blocked = harness.fetch("/leave").send().await.unwrap();
        assert_eq!(blocked.status(), 502);
    }

    #[tokio::test]
    async fn remembers_where_a_redirect_ended_up() {
        let harness = Harness::new().await;
        for _ in 0..3 {
            let response = harness.fetch("/hop").send().await.unwrap();
            assert_eq!(response.status(), 200);
        }
        // The first request pays for the redirect; the others go straight to the final address.
        assert_eq!(harness.upstream.requested(), ["/hop", "/echo", "/echo", "/echo"]);
    }

    #[tokio::test]
    async fn forgets_a_remembered_redirect_that_stops_working() {
        let harness = Harness::new().await;
        let body = |response: reqwest::Response| async move { response.text().await.unwrap() };

        assert_eq!(body(harness.fetch("/moving").send().await.unwrap()).await, "node-v=1");
        // The remembered node has gone away, so the proxy retries the original address, which hands
        // out a new one, and the caller never sees the failure.
        let second = harness.fetch("/moving").send().await.unwrap();
        assert_eq!(second.status(), 200);
        assert_eq!(body(second).await, "node-v=2");
        assert_eq!(
            harness.upstream.requested(),
            ["/moving", "/node", "/node", "/moving", "/node"]
        );
    }

    #[tokio::test]
    async fn does_not_remember_redirects_for_requests_with_a_body() {
        let harness = Harness::new().await;
        let target = format!("http://127.0.0.1:{}/hop", harness.upstream_port);
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("u", &target)
            .finish();
        for _ in 0..2 {
            let response = harness
                .http
                .post(format!("{}/fetch?{query}", harness.endpoint.origin))
                .header("origin", "http://tauri.localhost")
                .header(TOKEN_HEADER, &harness.endpoint.token)
                .body("x")
                .send()
                .await
                .unwrap();
            // The upstream /hop only answers GET, so a POST ends at 405 either way.
            assert_eq!(response.status(), 405);
        }
        assert_eq!(harness.upstream.requested(), ["/hop", "/hop"]);
    }

    #[tokio::test]
    async fn rejects_unauthorized_callers() {
        let harness = Harness::new().await;
        let base = format!("{}/fetch?u=https%3A%2F%2Fwww.youtube.com%2F", harness.endpoint.origin);

        let missing = harness.http.get(&base).send().await.unwrap();
        assert_eq!(missing.status(), 401);

        let wrong = harness.http.get(&base).header(TOKEN_HEADER, "nope").send().await.unwrap();
        assert_eq!(wrong.status(), 401);

        let foreign_origin = harness
            .http
            .get(&base)
            .header(TOKEN_HEADER, &harness.endpoint.token)
            .header("origin", "https://evil.example")
            .send()
            .await
            .unwrap();
        assert_eq!(foreign_origin.status(), 403);

        let off_list = harness
            .http
            .get(format!("{}/fetch?u=https%3A%2F%2Fexample.com%2F", harness.endpoint.origin))
            .header(TOKEN_HEADER, &harness.endpoint.token)
            .send()
            .await
            .unwrap();
        assert_eq!(off_list.status(), 403);

        let rebinding = harness
            .http
            .get(&base)
            .header(TOKEN_HEADER, &harness.endpoint.token)
            .header("host", "attacker.example")
            .send()
            .await
            .unwrap();
        assert_eq!(rebinding.status(), 403);
    }

    /// `cargo test live_ -- --ignored` talks to the real service: it asks YouTube for a public video
    /// the way the native player does and then reads a few bytes of media, both through the proxy.
    #[tokio::test]
    #[ignore = "needs network access to YouTube"]
    async fn live_player_request_and_media_range_through_the_proxy() {
        let client = crate::youtube_net::build_client(None, RedirectScope::YouTube).unwrap();
        let endpoint = start(Box::new(move || Ok(client.clone()))).await.unwrap();
        let http = reqwest::Client::new();
        let through_proxy = |target: &str| {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("u", target)
                .finish();
            (
                format!("{}/fetch?{query}", endpoint.origin),
                endpoint.token.clone(),
            )
        };

        let (player_url, token) = through_proxy("https://www.youtube.com/youtubei/v1/player?prettyPrint=false");
        let body = serde_json::json!({
            "context": { "client": {
                "clientName": "VISIONOS", "clientVersion": "1.02",
                "deviceMake": "Apple", "deviceModel": "RealityDevice17,1",
                "osName": "visionOS", "osVersion": "26.5.23O471",
                "hl": "en", "gl": "US", "timeZone": "UTC", "utcOffsetMinutes": 0
            } },
            "videoId": "dQw4w9WgXcQ",
            "contentCheckOk": true, "racyCheckOk": true,
            "playbackContext": { "contentPlaybackContext": { "html5Preference": "HTML5_PREF_WANTS" } }
        });
        let response = http
            .post(player_url)
            .header("origin", "http://tauri.localhost")
            .header(TOKEN_HEADER, &token)
            .header("content-type", "application/json")
            .header("x-youtube-client-name", "101")
            .header("x-youtube-client-version", "1.02")
            .header(USER_AGENT_HEADER, "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15")
            .body(body.to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let player: serde_json::Value = response.json().await.unwrap();
        let status = player["playabilityStatus"]["status"].as_str().unwrap_or_default().to_string();
        assert_eq!(status, "OK", "playability: {}", player["playabilityStatus"]);

        let media_url = player["streamingData"]["adaptiveFormats"]
            .as_array()
            .and_then(|formats| formats.iter().find(|format| format["itag"] == 140))
            .and_then(|format| format["url"].as_str())
            .expect("an itag 140 audio url")
            .to_string();
        let (media_proxy_url, token) = through_proxy(&media_url);
        let media = http
            .get(media_proxy_url)
            .header("origin", "http://tauri.localhost")
            .header(TOKEN_HEADER, &token)
            .header("range", "bytes=0-1023")
            .send()
            .await
            .unwrap();
        assert_eq!(media.status(), 206);
        assert!(media.headers()["content-range"].to_str().unwrap().starts_with("bytes 0-1023/"));
        assert_eq!(media.bytes().await.unwrap().len(), 1024);
    }

    /// `cargo test live_throughput -- --ignored --nocapture` downloads the same 3 MB of a public
    /// video with several client settings and prints the speed of each, to show what the link and the
    /// HTTP/2 flow-control windows allow.
    #[tokio::test]
    #[ignore = "needs network access to YouTube"]
    async fn live_throughput_by_client_settings() {
        let player = crate::youtube_net::build_client(None, RedirectScope::YouTube).unwrap();
        let body = serde_json::json!({
            "context": { "client": {
                "clientName": "VISIONOS", "clientVersion": "1.02",
                "deviceMake": "Apple", "deviceModel": "RealityDevice17,1",
                "osName": "visionOS", "osVersion": "26.5.23O471",
                "hl": "en", "gl": "US", "timeZone": "UTC", "utcOffsetMinutes": 0
            } },
            "videoId": "dQw4w9WgXcQ", "contentCheckOk": true, "racyCheckOk": true
        });
        let info: serde_json::Value = player
            .post("https://www.youtube.com/youtubei/v1/player?prettyPrint=false")
            .header("x-youtube-client-name", "101")
            .header("x-youtube-client-version", "1.02")
            .header("origin", "https://www.youtube.com")
            .json(&body)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let media = info["streamingData"]["adaptiveFormats"]
            .as_array()
            .unwrap()
            .iter()
            .find(|format| format["itag"] == 137)
            .and_then(|format| format["url"].as_str())
            .expect("an itag 137 url")
            .to_string();

        let variants: Vec<(&str, reqwest::ClientBuilder)> = vec![
            ("http2 defaults", reqwest::Client::builder()),
            (
                "http2 adaptive window",
                reqwest::Client::builder().http2_adaptive_window(true),
            ),
            (
                "http2 2MB/8MB windows",
                reqwest::Client::builder()
                    .http2_initial_stream_window_size(2 * 1024 * 1024)
                    .http2_initial_connection_window_size(8 * 1024 * 1024),
            ),
            ("http1 only", reqwest::Client::builder().http1_only()),
        ];
        // Small requests, like a player's segments: the cost of the redirect hop googlevideo adds.
        {
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::limited(5))
                .user_agent(default_user_agent())
                .build()
                .unwrap();
            let ranged = |url: String, from: u32| {
                client
                    .get(url)
                    .header("range", format!("bytes={from}-{}", from + 99_999))
                    .header("origin", "https://www.youtube.com")
                    .header("referer", "https://www.youtube.com/")
                    .send()
            };
            let first = ranged(media.clone(), 0).await.unwrap();
            let final_url = first.url().to_string();
            let _ = first.bytes().await;
            println!(
                "redirected: {}",
                final_url != media && !final_url.starts_with(&media[..40])
            );
            for (label, url) in [("via original url", media.clone()), ("via final url   ", final_url)] {
                let mut times = Vec::new();
                for step in 1..=5 {
                    let started = std::time::Instant::now();
                    let response = ranged(url.clone(), step * 100_000).await.unwrap();
                    let _ = response.bytes().await.unwrap();
                    times.push(format!("{:.2}s", started.elapsed().as_secs_f64()));
                }
                println!("100 KB ranges {label}: {}", times.join(" "));
            }
        }

        for (label, builder) in variants {
            let client = builder
                .redirect(reqwest::redirect::Policy::limited(5))
                .user_agent(default_user_agent())
                .build()
                .unwrap();
            let started = std::time::Instant::now();
            let response = client
                .get(&media)
                .header("range", "bytes=1000000-4000000")
                .header("origin", "https://www.youtube.com")
                .header("referer", "https://www.youtube.com/")
                .send()
                .await
                .unwrap();
            let status = response.status();
            let version = response.version();
            let bytes = response.bytes().await.unwrap().len();
            let seconds = started.elapsed().as_secs_f64();
            println!(
                "{label:<24} {status} {version:?} {bytes} bytes in {seconds:.2}s = {:.2} Mbit/s",
                bytes as f64 * 8.0 / 1e6 / seconds
            );
        }
    }

    #[tokio::test]
    async fn answers_cors_preflight_for_allowed_headers_only() {
        let harness = Harness::new().await;
        let url = format!("{}/fetch?u=https%3A%2F%2Fwww.youtube.com%2F", harness.endpoint.origin);
        let allowed = harness
            .http
            .request(Method::OPTIONS, &url)
            .header("origin", "http://tauri.localhost")
            .header("access-control-request-method", "GET")
            .header("access-control-request-headers", "range, x-seamind-token")
            .header("access-control-request-private-network", "true")
            .send()
            .await
            .unwrap();
        assert_eq!(allowed.status(), 204);
        assert_eq!(allowed.headers()["access-control-allow-origin"], "http://tauri.localhost");
        assert_eq!(allowed.headers()["access-control-allow-private-network"], "true");

        let denied = harness
            .http
            .request(Method::OPTIONS, &url)
            .header("origin", "http://tauri.localhost")
            .header("access-control-request-headers", "authorization")
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), 403);
    }
}
