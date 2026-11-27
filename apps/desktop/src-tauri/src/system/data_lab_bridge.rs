use axum::{
    extract::{DefaultBodyLimit, Json, State as AxumState},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use serde::Deserialize;
use serde_json::json;
use std::{
    net::TcpListener as StdTcpListener,
    path::PathBuf,
    sync::OnceLock,
    thread,
};
use uuid::Uuid;

use crate::data_lab::{
    self, DataBusDbSummary, DataDbConnectionInput, DataDbPgpassMatch,
};

const MAX_BRIDGE_BODY_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone)]
pub struct DataLabBridgeInfo {
    pub url: String,
    pub token: String,
}

static DATALAB_BRIDGE: OnceLock<Option<DataLabBridgeInfo>> = OnceLock::new();

#[derive(Clone)]
struct BridgeAuthState {
    token: String,
}

#[derive(Debug, Clone)]
pub struct PgpassRecord {
    pub host: String,
    pub port: String,
    pub database: String,
    pub username: String,
    pub password: String,
}

fn pgpass_candidate_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(explicit) = std::env::var("PGPASSFILE") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            paths.push(PathBuf::from(trimmed));
        }
    }
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            paths.push(PathBuf::from(appdata).join("postgresql").join("pgpass.conf"));
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(home) = std::env::var_os("HOME") {
            paths.push(PathBuf::from(home).join(".pgpass"));
        }
    }
    paths
}

pub fn parse_pgpass_line(raw: &str) -> Option<PgpassRecord> {
    let line = raw.trim_end_matches(&['\r', '\n'][..]);
    let trimmed = line.trim_start();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let mut fields: Vec<String> = Vec::with_capacity(5);
    let mut current = String::new();
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(next_ch) = chars.next() {
                if next_ch == ':' || next_ch == '\\' {
                    current.push(next_ch);
                } else {
                    current.push('\\');
                    current.push(next_ch);
                }
            } else {
                current.push('\\');
            }
        } else if ch == ':' && fields.len() < 4 {
            fields.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }
    fields.push(current);
    if fields.len() != 5 {
        return None;
    }
    Some(PgpassRecord {
        host: fields[0].clone(),
        port: fields[1].clone(),
        database: fields[2].clone(),
        username: fields[3].clone(),
        password: fields[4].clone(),
    })
}

fn pgpass_field_matches(pattern: &str, value: &str, case_insensitive: bool) -> bool {
    if pattern == "*" {
        return true;
    }
    if case_insensitive {
        pattern.eq_ignore_ascii_case(value)
    } else {
        pattern == value
    }
}

fn host_matches(pattern: &str, host: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    let norm = |h: &str| {
        let lower = h.trim().to_ascii_lowercase();
        if lower == "127.0.0.1" || lower == "::1" {
            "localhost".to_string()
        } else {
            lower
        }
    };
    pattern.eq_ignore_ascii_case(host) || norm(pattern) == norm(host)
}

pub fn match_pgpass_in_text(
    contents: &str,
    host: &str,
    port: u16,
    database: &str,
    username: &str,
) -> Option<PgpassRecord> {
    let port_str = port.to_string();
    for line in contents.lines() {
        let Some(rec) = parse_pgpass_line(line) else {
            continue;
        };
        if host_matches(&rec.host, host)
            && pgpass_field_matches(&rec.port, &port_str, false)
            && pgpass_field_matches(&rec.database, database, false)
            && pgpass_field_matches(&rec.username, username, false)
        {
            return Some(rec);
        }
    }
    None
}

fn find_pgpass_record(
    host: &str,
    port: u16,
    database: &str,
    username: &str,
) -> Option<(PathBuf, PgpassRecord)> {
    for path in pgpass_candidate_paths() {
        if !path.is_file() {
            continue;
        }
        let Ok(contents) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Some(rec) = match_pgpass_in_text(&contents, host, port, database, username) {
            return Some((path, rec));
        }
    }
    None
}

pub fn lookup_pgpass_password(
    host: &str,
    port: u16,
    database: &str,
    username: &str,
) -> Option<String> {
    find_pgpass_record(host, port, database, username)
        .map(|(_, rec)| rec.password)
        .filter(|pwd| !pwd.is_empty())
}

pub fn check_pgpass_match(
    host: &str,
    port: u16,
    database: &str,
    username: &str,
) -> DataDbPgpassMatch {
    if let Some((path, rec)) = find_pgpass_record(host, port, database, username) {
        return DataDbPgpassMatch {
            found: true,
            path: Some(path.to_string_lossy().to_string()),
            matched_host: Some(rec.host),
            matched_database: Some(rec.database),
            matched_user: Some(rec.username),
        };
    }
    DataDbPgpassMatch {
        found: false,
        path: pgpass_candidate_paths()
            .into_iter()
            .find(|p| p.is_file())
            .map(|p| p.to_string_lossy().to_string()),
        matched_host: None,
        matched_database: None,
        matched_user: None,
    }
}

pub fn ensure_datalab_bridge() -> Option<DataLabBridgeInfo> {
    DATALAB_BRIDGE
        .get_or_init(|| start_datalab_bridge().ok())
        .clone()
}

fn start_datalab_bridge() -> Result<DataLabBridgeInfo, String> {
    let listener = StdTcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("无法绑定 DataLab 本地桥接端口：{e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("无法配置 DataLab 桥接非阻塞模式：{e}"))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("无法获取 DataLab 桥接地址：{e}"))?;
    let url = format!("http://{addr}");
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let state = BridgeAuthState {
        token: token.clone(),
    };

    thread::Builder::new()
        .name("seamind-datalab-bridge".to_string())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(err) => {
                    eprintln!("Seamind DataLab bridge runtime error: {err}");
                    return;
                }
            };
            runtime.block_on(async move {
                let listener = match tokio::net::TcpListener::from_std(listener) {
                    Ok(l) => l,
                    Err(err) => {
                        eprintln!("Seamind DataLab bridge listener error: {err}");
                        return;
                    }
                };
                let router = Router::new()
                    .route("/db/resolve", post(handle_resolve_db))
                    .route("/db/tables", post(handle_list_tables))
                    .route("/db/query-to-bus", post(handle_query_to_bus))
                    .layer(DefaultBodyLimit::max(MAX_BRIDGE_BODY_BYTES))
                    .with_state(state);
                if let Err(err) = axum::serve(listener, router).await {
                    eprintln!("Seamind DataLab bridge stopped: {err}");
                }
            });
        })
        .map_err(|e| format!("无法启动 DataLab 桥接线程：{e}"))?;

    Ok(DataLabBridgeInfo { url, token })
}

fn verify_auth(headers: &HeaderMap, expected_token: &str) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|tok| tok == expected_token)
        .unwrap_or(false)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextFilePayload {
    #[serde(default)]
    db_connections: Vec<DataBusDbSummary>,
    #[serde(default)]
    base_profile: Option<ContextBaseProfile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextBaseProfile {
    python_path: Option<String>,
    default_connection_id: Option<String>,
}

fn load_context_connection(
    session_id: Option<&str>,
    conn_ref: Option<&str>,
) -> Result<(DataDbConnectionInput, Option<String>), String> {
    let (_, bus_dir, _, _) = data_lab::ensure_session_bus_dirs(session_id)?;
    let ctx_path = bus_dir.join("context.json");
    let raw = std::fs::read_to_string(&ctx_path)
        .map_err(|_| "未找到 DataLab 会话上下文，请先在「数据」面板建立数据库连接。".to_string())?;
    let ctx: ContextFilePayload =
        serde_json::from_str(&raw).map_err(|e| format!("解析 DataLab 上下文失败：{e}"))?;
    let py_path = ctx
        .base_profile
        .as_ref()
        .and_then(|p| p.python_path.clone())
        .filter(|s| !s.trim().is_empty() && s != "pyodide");

    let target_ref = conn_ref
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| {
            ctx.base_profile
                .as_ref()
                .and_then(|p| p.default_connection_id.clone())
                .filter(|s| !s.trim().is_empty())
        });

    let found = if let Some(ref key) = target_ref {
        ctx.db_connections.iter().find(|c| {
            c.id == *key
                || c.name.eq_ignore_ascii_case(key)
                || c.database
                    .as_deref()
                    .map(|d| d.eq_ignore_ascii_case(key))
                    .unwrap_or(false)
        })
    } else if ctx.db_connections.len() == 1 {
        ctx.db_connections.first()
    } else {
        None
    };

    let Some(summary) = found else {
        let available: Vec<String> = ctx
            .db_connections
            .iter()
            .map(|c| format!("{} ({})", c.name, c.database.as_deref().unwrap_or(&c.db_type)))
            .collect();
        return Err(format!(
            "未找到数据库连接 {}。可用连接：{}",
            target_ref.as_deref().unwrap_or("(未指定)"),
            if available.is_empty() {
                "无".to_string()
            } else {
                available.join(", ")
            }
        ));
    };

    let mut input = DataDbConnectionInput {
        id: summary.id.clone(),
        name: summary.name.clone(),
        db_type: summary.db_type.clone(),
        file_path: summary.file_path.clone(),
        host: summary.host.clone(),
        port: summary.port,
        database: summary.database.clone(),
        username: summary.username.clone(),
        password: None,
        python_path: py_path.clone(),
        read_only: summary.read_only.or(Some(true)),
        ssl_mode: summary.ssl_mode.clone(),
        statement_timeout_sec: summary.statement_timeout_sec,
    };
    input.password = data_lab::resolve_db_password(&input);
    Ok((input, py_path))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveDbRequest {
    connection: Option<String>,
    session_id: Option<String>,
}

async fn handle_resolve_db(
    AxumState(state): AxumState<BridgeAuthState>,
    headers: HeaderMap,
    Json(req): Json<ResolveDbRequest>,
) -> Response {
    if !verify_auth(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "ok": false, "error": "Unauthorized DataLab bridge request" })),
        )
            .into_response();
    }
    match load_context_connection(req.session_id.as_deref(), req.connection.as_deref()) {
        Ok((conn, _)) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "connection": conn })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::OK,
            Json(json!({ "ok": false, "error": err })),
        )
            .into_response(),
    }
}

async fn handle_list_tables(
    AxumState(state): AxumState<BridgeAuthState>,
    headers: HeaderMap,
    Json(req): Json<ResolveDbRequest>,
) -> Response {
    if !verify_auth(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "ok": false, "error": "Unauthorized DataLab bridge request" })),
        )
            .into_response();
    }
    let (conn, _) = match load_context_connection(req.session_id.as_deref(), req.connection.as_deref()) {
        Ok(v) => v,
        Err(err) => {
            return (StatusCode::OK, Json(json!({ "ok": false, "error": err }))).into_response();
        }
    };
    match data_lab::data_lab_test_connection(conn).await {
        Ok(res) => (StatusCode::OK, Json(json!(res))).into_response(),
        Err(err) => (StatusCode::OK, Json(json!({ "ok": false, "error": err }))).into_response(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryToBusRequest {
    connection: Option<String>,
    sql: String,
    bus_name: Option<String>,
    max_rows: Option<usize>,
    read_only: Option<bool>,
    session_id: Option<String>,
}

async fn handle_query_to_bus(
    AxumState(state): AxumState<BridgeAuthState>,
    headers: HeaderMap,
    Json(req): Json<QueryToBusRequest>,
) -> Response {
    if !verify_auth(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "ok": false, "error": "Unauthorized DataLab bridge request" })),
        )
            .into_response();
    }
    let (conn, py_path) =
        match load_context_connection(req.session_id.as_deref(), req.connection.as_deref()) {
            Ok(v) => v,
            Err(err) => {
                return (StatusCode::OK, Json(json!({ "ok": false, "error": err }))).into_response();
            }
        };
    let export_alias = req
        .bus_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("_tmp_q_{}", Uuid::new_v4().simple()));
    let export_cap = req.max_rows.unwrap_or(200_000).clamp(1, 1_000_000);
    let effective_ro = req.read_only.or(conn.read_only).or(Some(true));
    let timeout_sec = conn.statement_timeout_sec;

    match data_lab::data_lab_query_sql(
        req.sql,
        Some(conn),
        None,
        py_path,
        Some(100),
        Some(export_alias.clone()),
        req.session_id,
        Some(1),
        effective_ro,
        None,
        Some(export_cap),
        None,
        timeout_sec,
    )
    .await
    {
        Ok(res) => {
            let path = res.bus_table_path.clone();
            (
                StatusCode::OK,
                Json(json!({
                    "ok": res.ok,
                    "busName": export_alias,
                    "path": path,
                    "columns": res.columns,
                    "rowCount": res.exported_rows.or(res.total_rows).unwrap_or(res.rows.len() as u64),
                    "truncated": res.truncated,
                    "engine": res.engine,
                    "durationMs": res.duration_ms,
                    "message": res.message,
                    "error": res.error,
                })),
            )
                .into_response()
        }
        Err(err) => (
            StatusCode::OK,
            Json(json!({ "ok": false, "error": err })),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pgpass_with_escapes_and_wildcards() {
        let text = r#"
# comment line
127.0.0.1:5432:*:postgres:pa\:ss\\word
localhost:5433:FED:analyst:secret123
"#;
        let m1 = match_pgpass_in_text(text, "localhost", 5432, "FED", "postgres").unwrap();
        assert_eq!(m1.password, r"pa:ss\word");
        let m2 = match_pgpass_in_text(text, "127.0.0.1", 5433, "FED", "analyst").unwrap();
        assert_eq!(m2.password, "secret123");
        assert!(match_pgpass_in_text(text, "127.0.0.1", 5433, "other", "analyst").is_none());
    }
}
