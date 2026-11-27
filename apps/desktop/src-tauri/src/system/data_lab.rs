use crate::data_lab_bridge;
use crate::python_lab;
use rusqlite::{types::ValueRef, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const DATALAB_KEYRING_SERVICE: &str = "com.markmap.desktop.datalab";
const DEFAULT_MAX_ROWS: usize = 200;
const MAX_ALLOWED_ROWS: usize = 2_000;
const SQL_TIMEOUT_SECS: u64 = 60;
const FALLBACK_SQLITE_MAX_LOAD_ROWS: usize = 50_000;

static MEMORY_DB_SECRETS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static ACTIVE_SQL_PIDS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
static CANCELLED_SQL_IDS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn memory_secrets() -> &'static Mutex<HashMap<String, String>> {
    MEMORY_DB_SECRETS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn active_sql_pids() -> &'static Mutex<HashMap<String, u32>> {
    ACTIVE_SQL_PIDS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cancelled_sql_ids() -> &'static Mutex<HashSet<String>> {
    CANCELLED_SQL_IDS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn kill_sql_pid(pid_val: u32) {
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataColumnInfo {
    pub name: String,
    pub data_type: String,
    #[serde(default)]
    pub nullable: Option<bool>,
    #[serde(default)]
    pub is_primary_key: Option<bool>,
    #[serde(default)]
    pub is_unique: Option<bool>,
    #[serde(default)]
    pub default_value: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataTableResult {
    pub ok: bool,
    pub columns: Vec<DataColumnInfo>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub total_rows: Option<u64>,
    pub truncated: bool,
    pub engine: String,
    pub duration_ms: u64,
    pub message: Option<String>,
    pub error: Option<String>,
    pub bus_table_path: Option<String>,
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub page_size: Option<u32>,
    #[serde(default)]
    pub has_more: Option<bool>,
    #[serde(default)]
    pub read_only: Option<bool>,
    #[serde(default)]
    pub exported_rows: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataBusEntry {
    pub name: String,
    pub format: String,
    pub path: String,
    pub size_bytes: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataBusInfo {
    pub session_id: String,
    pub bus_dir: String,
    pub tables_dir: String,
    pub artifacts_dir: String,
    pub tables: Vec<DataBusEntry>,
    pub artifacts: Vec<DataBusEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataBusDbSummary {
    pub id: String,
    pub name: String,
    pub db_type: String,
    pub file_path: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    #[serde(default)]
    pub read_only: Option<bool>,
    #[serde(default)]
    pub ssl_mode: Option<String>,
    #[serde(default)]
    pub statement_timeout_sec: Option<u32>,
}

pub(crate) fn sanitize_session_id(session_id: Option<&str>) -> String {
    let raw = session_id.unwrap_or("default").trim();
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('_');
    if trimmed.is_empty() {
        "default".to_string()
    } else {
        trimmed.chars().take(48).collect()
    }
}

pub(crate) fn ensure_session_bus_dirs(
    session_id: Option<&str>,
) -> Result<(String, PathBuf, PathBuf, PathBuf), String> {
    let sid = sanitize_session_id(session_id);
    let bus_dir = std::env::temp_dir().join("seamind_datalab_bus").join(&sid);
    let tables_dir = bus_dir.join("tables");
    let artifacts_dir = bus_dir.join("artifacts");
    std::fs::create_dir_all(&tables_dir)
        .map_err(|e| format!("创建共享数据总线 tables 目录失败：{e}"))?;
    std::fs::create_dir_all(&artifacts_dir)
        .map_err(|e| format!("创建共享数据总线 artifacts 目录失败：{e}"))?;
    Ok((sid, bus_dir, tables_dir, artifacts_dir))
}

fn scan_bus_dir(dir: &Path, allowed_exts: &[&str]) -> Vec<DataBusEntry> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        if !allowed_exts.iter().any(|a| *a == ext) {
            continue;
        }
        let stem = p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("item")
            .to_string();
        let meta = entry.metadata().ok();
        let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let updated_at_ms = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(DataBusEntry {
            name: stem,
            format: ext,
            path: p.to_string_lossy().to_string(),
            size_bytes,
            updated_at_ms,
        });
    }
    out.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
    out
}

#[tauri::command]
pub fn data_lab_bus_info(session_id: Option<String>) -> Result<DataBusInfo, String> {
    let (sid, bus_dir, tables_dir, artifacts_dir) =
        ensure_session_bus_dirs(session_id.as_deref())?;
    let tables = scan_bus_dir(&tables_dir, &["parquet", "csv", "tsv", "json"]);
    let artifacts = scan_bus_dir(&artifacts_dir, &["png", "svg", "html", "csv", "pdf"]);
    Ok(DataBusInfo {
        session_id: sid,
        bus_dir: bus_dir.to_string_lossy().to_string(),
        tables_dir: tables_dir.to_string_lossy().to_string(),
        artifacts_dir: artifacts_dir.to_string_lossy().to_string(),
        tables,
        artifacts,
    })
}

#[tauri::command]
pub fn data_lab_sync_context(
    session_id: Option<String>,
    mounted_files: Vec<DataMountedFileRef>,
    db_connections: Vec<DataBusDbSummary>,
    default_python_path: Option<String>,
    default_rscript_path: Option<String>,
    default_connection_id: Option<String>,
) -> Result<DataBusInfo, String> {
    let (sid, bus_dir, tables_dir, artifacts_dir) =
        ensure_session_bus_dirs(session_id.as_deref())?;
    let ctx = serde_json::json!({
        "sessionId": sid,
        "mountedFiles": mounted_files,
        "dbConnections": db_connections,
        "baseProfile": {
            "pythonPath": default_python_path,
            "rscriptPath": default_rscript_path,
            "defaultConnectionId": default_connection_id,
        },
        "updatedAtMs": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    });
    let ctx_path = bus_dir.join("context.json");
    let serialized =
        serde_json::to_string_pretty(&ctx).map_err(|e| format!("序列化数据底座上下文失败：{e}"))?;
    std::fs::write(&ctx_path, serialized)
        .map_err(|e| format!("写入共享上下文 context.json 失败：{e}"))?;
    let tables = scan_bus_dir(&tables_dir, &["parquet", "csv", "tsv", "json"]);
    let artifacts = scan_bus_dir(&artifacts_dir, &["png", "svg", "html", "csv", "pdf"]);
    Ok(DataBusInfo {
        session_id: sid,
        bus_dir: bus_dir.to_string_lossy().to_string(),
        tables_dir: tables_dir.to_string_lossy().to_string(),
        artifacts_dir: artifacts_dir.to_string_lossy().to_string(),
        tables,
        artifacts,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataFileInspection {
    pub path: String,
    pub file_name: String,
    pub format: String,
    pub size_bytes: u64,
    pub row_count: Option<u64>,
    pub columns: Vec<DataColumnInfo>,
    pub preview_rows: Vec<Vec<serde_json::Value>>,
    pub engine: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDbConnectionInput {
    pub id: String,
    pub name: String,
    pub db_type: String,
    pub file_path: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub python_path: Option<String>,
    #[serde(default)]
    pub read_only: Option<bool>,
    #[serde(default)]
    pub ssl_mode: Option<String>,
    #[serde(default)]
    pub statement_timeout_sec: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDbForeignKey {
    pub column: String,
    #[serde(default)]
    pub ref_schema: Option<String>,
    pub ref_table: String,
    pub ref_column: String,
    #[serde(default)]
    pub constraint_name: Option<String>,
    #[serde(default)]
    pub on_update: Option<String>,
    #[serde(default)]
    pub on_delete: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDbCustomType {
    pub name: String,
    #[serde(default)]
    pub schema: Option<String>,
    pub kind: String,
    #[serde(default)]
    pub values: Vec<String>,
    #[serde(default)]
    pub fields: Vec<DataColumnInfo>,
    #[serde(default)]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDbIndexInfo {
    pub name: String,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub unique: bool,
    #[serde(default)]
    pub primary: bool,
    #[serde(default)]
    pub definition: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDbTableSchema {
    pub name: String,
    pub schema: Option<String>,
    pub table_type: String,
    pub row_count: Option<u64>,
    pub columns: Vec<DataColumnInfo>,
    #[serde(default)]
    pub estimated_rows: Option<i64>,
    #[serde(default)]
    pub total_bytes: Option<u64>,
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    pub primary_keys: Vec<String>,
    #[serde(default)]
    pub foreign_keys: Vec<DataDbForeignKey>,
    #[serde(default)]
    pub indexes: Vec<DataDbIndexInfo>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDbDatabaseEntry {
    pub name: String,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub encoding: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDbPgpassMatch {
    pub found: bool,
    pub path: Option<String>,
    pub matched_host: Option<String>,
    pub matched_database: Option<String>,
    pub matched_user: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDbColumnProfile {
    pub name: String,
    pub data_type: String,
    #[serde(default)]
    pub nullable: Option<bool>,
    #[serde(default)]
    pub is_primary_key: bool,
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    pub null_fraction: Option<f64>,
    #[serde(default)]
    pub n_distinct: Option<f64>,
    #[serde(default)]
    pub most_common_vals: Vec<String>,
    #[serde(default)]
    pub min_value: Option<String>,
    #[serde(default)]
    pub max_value: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDbTableProfile {
    pub ok: bool,
    pub schema: Option<String>,
    pub table_name: String,
    pub table_type: String,
    pub estimated_rows: Option<i64>,
    pub total_bytes: Option<u64>,
    pub comment: Option<String>,
    #[serde(default)]
    pub primary_keys: Vec<String>,
    #[serde(default)]
    pub foreign_keys: Vec<DataDbForeignKey>,
    #[serde(default)]
    pub indexes: Vec<DataDbIndexInfo>,
    #[serde(default)]
    pub columns: Vec<DataDbColumnProfile>,
    #[serde(default)]
    pub sample_columns: Vec<DataColumnInfo>,
    #[serde(default)]
    pub sample_rows: Vec<Vec<serde_json::Value>>,
    pub engine: String,
    pub duration_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDbTestResult {
    pub ok: bool,
    pub message: String,
    pub tables: Vec<DataDbTableSchema>,
    #[serde(default)]
    pub custom_types: Vec<DataDbCustomType>,
    pub engine: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataMountedFileRef {
    pub alias: String,
    pub path: String,
    pub format: String,
}

#[cfg(windows)]
fn db_secret_entry(connection_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(DATALAB_KEYRING_SERVICE, connection_id)
        .map_err(|_| "无法访问 Windows 凭据管理器。".to_string())
}

#[tauri::command]
pub fn data_lab_save_db_password(connection_id: String, password: String) -> Result<(), String> {
    let id = connection_id.trim();
    if id.is_empty() {
        return Err("连接 ID 不能为空。".to_string());
    }
    #[cfg(windows)]
    {
        let entry = db_secret_entry(id)?;
        if password.is_empty() {
            let _ = entry.delete_credential();
        } else {
            entry
                .set_password(&password)
                .map_err(|e| format!("保存数据库密码到系统凭据库失败：{e}"))?;
        }
    }
    if let Ok(mut map) = memory_secrets().lock() {
        if password.is_empty() {
            map.remove(id);
        } else {
            map.insert(id.to_string(), password);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn data_lab_delete_db_password(connection_id: String) -> Result<(), String> {
    let id = connection_id.trim();
    if id.is_empty() {
        return Ok(());
    }
    if let Ok(mut map) = memory_secrets().lock() {
        map.remove(id);
    }
    #[cfg(windows)]
    {
        if let Ok(entry) = db_secret_entry(id) {
            let _ = entry.delete_credential();
        }
    }
    Ok(())
}

pub(crate) fn resolve_db_password(conn: &DataDbConnectionInput) -> Option<String> {
    if let Some(pwd) = conn.password.as_deref() {
        if !pwd.is_empty() {
            return Some(pwd.to_string());
        }
    }
    if let Some(saved) = resolve_saved_db_password(&conn.id) {
        return Some(saved);
    }
    if conn.db_type.eq_ignore_ascii_case("postgres") {
        let host = conn.host.as_deref().unwrap_or("127.0.0.1");
        let port = conn.port.unwrap_or(5432);
        let database = conn.database.as_deref().unwrap_or("postgres");
        let username = conn.username.as_deref().unwrap_or("postgres");
        if let Some(pwd) = data_lab_bridge::lookup_pgpass_password(host, port, database, username) {
            return Some(pwd);
        }
        if let Ok(env_pwd) = std::env::var("PGPASSWORD") {
            if !env_pwd.is_empty() {
                return Some(env_pwd);
            }
        }
    }
    None
}

fn resolve_saved_db_password(connection_id: &str) -> Option<String> {
    let id = connection_id.trim();
    if id.is_empty() {
        return None;
    }
    if let Ok(map) = memory_secrets().lock() {
        if let Some(pwd) = map.get(id) {
            return Some(pwd.clone());
        }
    }
    #[cfg(windows)]
    {
        if let Ok(entry) = db_secret_entry(id) {
            if let Ok(pwd) = entry.get_password() {
                if !pwd.is_empty() {
                    return Some(pwd);
                }
            }
        }
    }
    None
}

#[tauri::command]
pub fn data_lab_copy_db_password(
    source_connection_id: String,
    target_connection_id: String,
) -> Result<bool, String> {
    let target = target_connection_id.trim();
    if target.is_empty() || target == source_connection_id.trim() {
        return Err("目标连接 ID 无效。".to_string());
    }
    let Some(password) = resolve_saved_db_password(&source_connection_id) else {
        return Ok(false);
    };
    data_lab_save_db_password(target.to_string(), password)?;
    Ok(true)
}

fn detect_file_format(path: &Path) -> String {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .as_deref()
    {
        Some("parquet") | Some("pq") => "parquet".to_string(),
        Some("tsv") => "tsv".to_string(),
        Some("csv") => "csv".to_string(),
        Some("jsonl") | Some("ndjson") => "jsonl".to_string(),
        Some("json") => "json".to_string(),
        Some("xlsx") | Some("xls") => "excel".to_string(),
        Some("duckdb") | Some("ddb") => "duckdb".to_string(),
        Some("sqlite") | Some("sqlite3") | Some("db") => "sqlite".to_string(),
        Some(other) => other.to_string(),
        None => "csv".to_string(),
    }
}

fn quote_sql_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn sanitize_alias(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        "dataset".to_string()
    } else if trimmed
        .chars()
        .next()
        .map(|c| c.is_ascii_digit())
        .unwrap_or(false)
    {
        format!("t_{trimmed}")
    } else {
        trimmed.to_string()
    }
}

fn parse_delimited_line(line: &str, delimiter: char) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut chars = line.chars().peekable();
    let mut in_quotes = false;

    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    current.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                current.push(ch);
            }
        } else if ch == '"' && current.is_empty() {
            in_quotes = true;
        } else if ch == delimiter {
            fields.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }
    fields.push(current);
    fields
}

fn infer_scalar_value(raw: &str) -> serde_json::Value {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("null")
        || trimmed.eq_ignore_ascii_case("na")
        || trimmed.eq_ignore_ascii_case("nan")
    {
        return serde_json::Value::Null;
    }
    if trimmed.eq_ignore_ascii_case("true") {
        return serde_json::Value::Bool(true);
    }
    if trimmed.eq_ignore_ascii_case("false") {
        return serde_json::Value::Bool(false);
    }
    if let Ok(iv) = trimmed.parse::<i64>() {
        return serde_json::Value::Number(iv.into());
    }
    if let Ok(fv) = trimmed.parse::<f64>() {
        if fv.is_finite() {
            if let Some(num) = serde_json::Number::from_f64(fv) {
                return serde_json::Value::Number(num);
            }
        }
    }
    serde_json::Value::String(trimmed.to_string())
}

fn infer_column_type(values: &[serde_json::Value]) -> String {
    let mut saw_int = false;
    let mut saw_float = false;
    let mut saw_bool = false;
    let mut saw_str = false;

    for v in values {
        match v {
            serde_json::Value::Null => {}
            serde_json::Value::Bool(_) => saw_bool = true,
            serde_json::Value::Number(n) => {
                if n.is_i64() || n.is_u64() {
                    saw_int = true;
                } else {
                    saw_float = true;
                }
            }
            _ => saw_str = true,
        }
    }

    if saw_str {
        "VARCHAR".to_string()
    } else if saw_float || (saw_int && saw_bool) {
        if saw_bool {
            "VARCHAR".to_string()
        } else {
            "DOUBLE".to_string()
        }
    } else if saw_int {
        "BIGINT".to_string()
    } else if saw_bool {
        "BOOLEAN".to_string()
    } else {
        "VARCHAR".to_string()
    }
}

fn inspect_delimited_native(
    path: &Path,
    format: &str,
    size_bytes: u64,
    max_rows: usize,
) -> Result<DataFileInspection, String> {
    let file = File::open(path).map_err(|e| format!("无法打开数据文件：{e}"))?;
    let reader = BufReader::new(file);
    let delimiter = if format == "tsv" { '\t' } else { ',' };

    let mut lines = reader.lines();
    let header_line = match lines.next() {
        Some(Ok(l)) => l.trim_start_matches('\u{feff}').to_string(),
        Some(Err(e)) => return Err(format!("读取表头失败：{e}")),
        None => return Err("文件为空。".to_string()),
    };
    let raw_headers = parse_delimited_line(&header_line, delimiter);
    let col_count = raw_headers.len().max(1);
    let col_names: Vec<String> = raw_headers
        .into_iter()
        .enumerate()
        .map(|(i, h)| {
            let trimmed = h.trim();
            if trimmed.is_empty() {
                format!("col_{}", i + 1)
            } else {
                trimmed.to_string()
            }
        })
        .collect();

    let mut preview_rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut sample_cols: Vec<Vec<serde_json::Value>> = vec![Vec::new(); col_count];
    let mut row_count: u64 = 0;

    for line_res in lines {
        let line = match line_res {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }
        row_count += 1;
        if preview_rows.len() < max_rows || row_count <= 64 {
            let fields = parse_delimited_line(&line, delimiter);
            let mut row_vals = Vec::with_capacity(col_count);
            for idx in 0..col_count {
                let val = fields
                    .get(idx)
                    .map(|s| infer_scalar_value(s))
                    .unwrap_or(serde_json::Value::Null);
                if row_count <= 64 {
                    sample_cols[idx].push(val.clone());
                }
                row_vals.push(val);
            }
            if preview_rows.len() < max_rows {
                preview_rows.push(row_vals);
            }
        }
    }

    let columns: Vec<DataColumnInfo> = col_names
        .into_iter()
        .enumerate()
        .map(|(idx, name)| DataColumnInfo {
            name,
            data_type: infer_column_type(&sample_cols[idx]),
            ..Default::default()
        })
        .collect();

    Ok(DataFileInspection {
        path: path.to_string_lossy().to_string(),
        file_name: path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("dataset")
            .to_string(),
        format: format.to_string(),
        size_bytes,
        row_count: Some(row_count),
        columns,
        preview_rows,
        engine: "Rust Native CSV".to_string(),
    })
}

fn inspect_json_native(
    path: &Path,
    format: &str,
    size_bytes: u64,
    max_rows: usize,
) -> Result<DataFileInspection, String> {
    let mut objects: Vec<serde_json::Map<String, serde_json::Value>> = Vec::new();
    let mut total_rows: u64 = 0;

    if format == "jsonl" {
        let file = File::open(path).map_err(|e| format!("无法打开 JSONL 文件：{e}"))?;
        let reader = BufReader::new(file);
        for line_res in reader.lines() {
            let line = match line_res {
                Ok(l) => l,
                Err(_) => continue,
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            total_rows += 1;
            if objects.len() < max_rows.max(64) {
                if let Ok(serde_json::Value::Object(map)) = serde_json::from_str(trimmed) {
                    objects.push(map);
                }
            }
        }
    } else {
        let raw = std::fs::read_to_string(path).map_err(|e| format!("读取 JSON 文件失败：{e}"))?;
        let parsed: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("JSON 格式解析失败：{e}"))?;
        match parsed {
            serde_json::Value::Array(arr) => {
                total_rows = arr.len() as u64;
                for item in arr.into_iter().take(max_rows.max(64)) {
                    if let serde_json::Value::Object(map) = item {
                        objects.push(map);
                    }
                }
            }
            serde_json::Value::Object(map) => {
                total_rows = 1;
                objects.push(map);
            }
            _ => return Err("JSON 根节点必须是对象或对象数组。".to_string()),
        }
    }

    let mut col_names: Vec<String> = Vec::new();
    for obj in &objects {
        for key in obj.keys() {
            if !col_names.contains(key) {
                col_names.push(key.clone());
            }
        }
    }

    let mut sample_cols: Vec<Vec<serde_json::Value>> = vec![Vec::new(); col_names.len()];
    let mut preview_rows: Vec<Vec<serde_json::Value>> = Vec::new();

    for (row_idx, obj) in objects.iter().enumerate() {
        let mut row = Vec::with_capacity(col_names.len());
        for (col_idx, name) in col_names.iter().enumerate() {
            let val = obj
                .get(name)
                .cloned()
                .map(|v| match v {
                    serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
                        serde_json::Value::String(v.to_string())
                    }
                    other => other,
                })
                .unwrap_or(serde_json::Value::Null);
            sample_cols[col_idx].push(val.clone());
            row.push(val);
        }
        if row_idx < max_rows {
            preview_rows.push(row);
        }
    }

    let columns: Vec<DataColumnInfo> = col_names
        .into_iter()
        .enumerate()
        .map(|(i, name)| DataColumnInfo {
            name,
            data_type: infer_column_type(&sample_cols[i]),
            ..Default::default()
        })
        .collect();

    Ok(DataFileInspection {
        path: path.to_string_lossy().to_string(),
        file_name: path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("dataset")
            .to_string(),
        format: format.to_string(),
        size_bytes,
        row_count: Some(total_rows),
        columns,
        preview_rows,
        engine: "Rust Native JSON".to_string(),
    })
}

fn sqlite_val_to_json(val: ValueRef<'_>) -> serde_json::Value {
    match val {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(i) => serde_json::Value::Number(i.into()),
        ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        ValueRef::Text(bytes) => {
            serde_json::Value::String(String::from_utf8_lossy(bytes).to_string())
        }
        ValueRef::Blob(bytes) => serde_json::Value::String(format!("<BLOB {} bytes>", bytes.len())),
    }
}

fn inspect_sqlite_schema(path: &Path) -> Result<DataDbTestResult, String> {
    if !path.is_file() {
        return Err(format!("SQLite 文件不存在：{}", path.display()));
    }
    let conn = Connection::open(path).map_err(|e| format!("打开 SQLite 数据库失败：{e}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .map_err(|e| format!("查询 SQLite 元数据失败：{e}"))?;

    let table_pairs: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| format!("读取表列表失败：{e}"))?
        .filter_map(Result::ok)
        .collect();

    let mut tables = Vec::with_capacity(table_pairs.len());
    for (name, table_type) in table_pairs {
        let quoted = quote_sql_ident(&name);
        let mut columns = Vec::new();
        let mut primary_keys = Vec::new();
        if let Ok(mut col_stmt) = conn.prepare(&format!("PRAGMA table_info({quoted})")) {
            if let Ok(rows) = col_stmt.query_map([], |row| {
                let col_name: String = row.get(1)?;
                let col_type: String = row.get::<_, Option<String>>(2)?.unwrap_or_default();
                let not_null: i64 = row.get::<_, i64>(3).unwrap_or(0);
                let default_val: Option<String> = row.get::<_, Option<String>>(4).unwrap_or(None);
                let pk_pos: i64 = row.get::<_, i64>(5).unwrap_or(0);
                Ok((
                    DataColumnInfo {
                        name: col_name.clone(),
                        data_type: if col_type.trim().is_empty() {
                            "ANY".to_string()
                        } else {
                            col_type
                        },
                        nullable: Some(not_null == 0),
                        is_primary_key: Some(pk_pos > 0),
                        is_unique: None,
                        default_value: default_val,
                        comment: None,
                    },
                    pk_pos,
                    col_name,
                ))
            }) {
                let mut pk_pairs: Vec<(i64, String)> = Vec::new();
                for (info, pk_pos, col_name) in rows.filter_map(Result::ok) {
                    if pk_pos > 0 {
                        pk_pairs.push((pk_pos, col_name));
                    }
                    columns.push(info);
                }
                pk_pairs.sort_by_key(|(pos, _)| *pos);
                primary_keys = pk_pairs.into_iter().map(|(_, n)| n).collect();
            }
        }
        let mut foreign_keys = Vec::new();
        if let Ok(mut fk_stmt) = conn.prepare(&format!("PRAGMA foreign_key_list({quoted})")) {
            if let Ok(rows) = fk_stmt.query_map([], |row| {
                Ok(DataDbForeignKey {
                    ref_table: row.get::<_, String>(2)?,
                    column: row.get::<_, String>(3)?,
                    ref_column: row.get::<_, String>(4)?,
                    ref_schema: Some("main".to_string()),
                    constraint_name: None,
                    on_update: row.get::<_, Option<String>>(5).unwrap_or(None),
                    on_delete: row.get::<_, Option<String>>(6).unwrap_or(None),
                })
            }) {
                foreign_keys = rows.filter_map(Result::ok).collect();
            }
        }
        let mut indexes = Vec::new();
        let mut unique_single_cols: HashSet<String> = HashSet::new();
        if let Ok(mut idx_stmt) = conn.prepare(&format!("PRAGMA index_list({quoted})")) {
            let idx_entries: Vec<(String, bool, String)> = idx_stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2).unwrap_or(0) != 0,
                        row.get::<_, String>(3).unwrap_or_default(),
                    ))
                })
                .ok()
                .map(|rows| rows.filter_map(Result::ok).collect())
                .unwrap_or_default();
            for (idx_name, is_unique, origin) in idx_entries {
                let q_idx = quote_sql_ident(&idx_name);
                let mut idx_cols = Vec::new();
                if let Ok(mut info_stmt) = conn.prepare(&format!("PRAGMA index_info({q_idx})")) {
                    if let Ok(rows) = info_stmt.query_map([], |row| row.get::<_, Option<String>>(2)) {
                        idx_cols = rows.filter_map(Result::ok).flatten().collect();
                    }
                }
                if is_unique && idx_cols.len() == 1 {
                    unique_single_cols.insert(idx_cols[0].clone());
                }
                indexes.push(DataDbIndexInfo {
                    name: idx_name,
                    columns: idx_cols,
                    unique: is_unique,
                    primary: origin == "pk",
                    definition: None,
                });
            }
        }
        for col in &mut columns {
            if unique_single_cols.contains(&col.name) {
                col.is_unique = Some(true);
            }
        }
        let row_count = conn
            .query_row(&format!("SELECT COUNT(*) FROM {quoted}"), [], |r| {
                r.get::<_, i64>(0)
            })
            .ok()
            .and_then(|v| u64::try_from(v).ok());

        tables.push(DataDbTableSchema {
            name,
            schema: Some("main".to_string()),
            table_type,
            row_count,
            estimated_rows: row_count.map(|v| v as i64),
            columns,
            primary_keys,
            foreign_keys,
            indexes,
            ..Default::default()
        });
    }

    Ok(DataDbTestResult {
        ok: true,
        message: format!("已连接 SQLite，共发现 {} 张表/视图。", tables.len()),
        tables,
        custom_types: Vec::new(),
        engine: "SQLite (Rust Native)".to_string(),
    })
}

fn write_csv_bus_table(
    tables_dir: &Path,
    alias: &str,
    columns: &[DataColumnInfo],
    rows: &[Vec<serde_json::Value>],
) -> Option<String> {
    if columns.is_empty() {
        return None;
    }
    let safe = sanitize_alias(alias);
    let csv_path = tables_dir.join(format!("{safe}.csv"));
    let pq_stale = tables_dir.join(format!("{safe}.parquet"));
    let escape = |raw: &str| -> String {
        if raw.contains(',') || raw.contains('"') || raw.contains('\n') || raw.contains('\r') {
            format!("\"{}\"", raw.replace('"', "\"\""))
        } else {
            raw.to_string()
        }
    };
    let mut out = String::new();
    for (idx, col) in columns.iter().enumerate() {
        if idx > 0 {
            out.push(',');
        }
        out.push_str(&escape(&col.name));
    }
    out.push('\n');
    for row in rows {
        for (idx, val) in row.iter().enumerate() {
            if idx > 0 {
                out.push(',');
            }
            let cell = match val {
                serde_json::Value::Null => String::new(),
                serde_json::Value::String(s) => escape(s),
                other => escape(&other.to_string()),
            };
            out.push_str(&cell);
        }
        out.push('\n');
    }
    if std::fs::write(&csv_path, out).is_ok() {
        let _ = std::fs::remove_file(pq_stale);
        Some(csv_path.to_string_lossy().to_string())
    } else {
        None
    }
}

fn execute_sqlite_on_conn(
    conn: &Connection,
    sql: &str,
    max_rows: usize,
    page: u32,
    read_only: bool,
    engine_label: &str,
    start: std::time::Instant,
    export_target: Option<(&Path, &str, usize)>,
) -> DataTableResult {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    let page_num = page.max(1);
    let offset = (page_num as usize - 1).saturating_mul(max_rows);
    if trimmed.is_empty() {
        return DataTableResult {
            ok: false,
            engine: engine_label.to_string(),
            duration_ms: start.elapsed().as_millis() as u64,
            error: Some("SQL 语句为空。".to_string()),
            page: Some(page_num),
            page_size: Some(max_rows as u32),
            read_only: Some(read_only),
            ..Default::default()
        };
    }

    match conn.prepare(trimmed) {
        Ok(mut stmt) => {
            let col_count = stmt.column_count();
            if col_count == 0 {
                if read_only {
                    return DataTableResult {
                        ok: false,
                        engine: engine_label.to_string(),
                        duration_ms: start.elapsed().as_millis() as u64,
                        error: Some("当前连接已开启只读研究模式，已阻止写入/DDL 语句。".to_string()),
                        read_only: Some(true),
                        ..Default::default()
                    };
                }
                match stmt.execute([]) {
                    Ok(affected) => DataTableResult {
                        ok: true,
                        total_rows: Some(affected as u64),
                        engine: engine_label.to_string(),
                        duration_ms: start.elapsed().as_millis() as u64,
                        message: Some(format!("执行成功，影响 {affected} 行。")),
                        read_only: Some(false),
                        ..Default::default()
                    },
                    Err(e) => DataTableResult {
                        ok: false,
                        engine: engine_label.to_string(),
                        duration_ms: start.elapsed().as_millis() as u64,
                        error: Some(format!("SQL 执行失败：{e}")),
                        read_only: Some(false),
                        ..Default::default()
                    },
                }
            } else {
                let mut columns: Vec<DataColumnInfo> = (0..col_count)
                    .map(|i| DataColumnInfo {
                        name: stmt.column_name(i).unwrap_or("col").to_string(),
                        data_type: "ANY".to_string(),
                        ..Default::default()
                    })
                    .collect();

                let mut rows_out = Vec::new();
                let mut export_rows: Vec<Vec<serde_json::Value>> = Vec::new();
                let collect_for_export = export_target.is_some();
                let export_cap = export_target.map(|(_, _, cap)| cap).unwrap_or(50_000);
                let mut has_more = false;
                let mut seen: usize = 0;
                match stmt.query([]) {
                    Ok(mut qrows) => loop {
                        match qrows.next() {
                            Ok(Some(row)) => {
                                let in_page = seen >= offset && rows_out.len() < max_rows;
                                let need_export = collect_for_export && export_rows.len() < export_cap;
                                if in_page || need_export {
                                    let mut vals = Vec::with_capacity(col_count);
                                    for i in 0..col_count {
                                        let v = row
                                            .get_ref(i)
                                            .map(sqlite_val_to_json)
                                            .unwrap_or(serde_json::Value::Null);
                                        vals.push(v);
                                    }
                                    if in_page {
                                        if need_export {
                                            export_rows.push(vals.clone());
                                        }
                                        rows_out.push(vals);
                                    } else if need_export {
                                        export_rows.push(vals);
                                    }
                                } else if seen >= offset + max_rows {
                                    has_more = true;
                                    break;
                                }
                                seen += 1;
                                if seen > offset + max_rows {
                                    has_more = true;
                                    if !collect_for_export || export_rows.len() >= export_cap {
                                        break;
                                    }
                                }
                            }
                            Ok(None) => break,
                            Err(e) => {
                                return DataTableResult {
                                    ok: false,
                                    columns,
                                    rows: rows_out,
                                    truncated: has_more,
                                    engine: engine_label.to_string(),
                                    duration_ms: start.elapsed().as_millis() as u64,
                                    error: Some(format!("读取结果行失败：{e}")),
                                    page: Some(page_num),
                                    page_size: Some(max_rows as u32),
                                    has_more: Some(has_more),
                                    read_only: Some(read_only),
                                    ..Default::default()
                                };
                            }
                        }
                    },
                    Err(e) => {
                        return DataTableResult {
                            ok: false,
                            engine: engine_label.to_string(),
                            duration_ms: start.elapsed().as_millis() as u64,
                            error: Some(format!("SQL 查询失败：{e}")),
                            read_only: Some(read_only),
                            ..Default::default()
                        };
                    }
                }

                for (col_idx, col) in columns.iter_mut().enumerate() {
                    let sample: Vec<serde_json::Value> = rows_out
                        .iter()
                        .take(32)
                        .filter_map(|r| r.get(col_idx).cloned())
                        .collect();
                    col.data_type = infer_column_type(&sample);
                }

                let bus_table_path = export_target
                    .and_then(|(dir, alias, _)| write_csv_bus_table(dir, alias, &columns, &export_rows));
                let exported_rows = if bus_table_path.is_some() {
                    Some(export_rows.len() as u64)
                } else {
                    None
                };

                let total = if collect_for_export && export_rows.len() < export_cap {
                    Some(export_rows.len() as u64)
                } else if has_more {
                    None
                } else {
                    Some((offset + rows_out.len()) as u64)
                };
                DataTableResult {
                    ok: true,
                    columns,
                    rows: rows_out,
                    total_rows: total,
                    truncated: has_more,
                    engine: engine_label.to_string(),
                    duration_ms: start.elapsed().as_millis() as u64,
                    message: None,
                    error: None,
                    bus_table_path,
                    page: Some(page_num),
                    page_size: Some(max_rows as u32),
                    has_more: Some(has_more),
                    read_only: Some(read_only),
                    exported_rows,
                }
            }
        }
        Err(first_err) => {
            if read_only {
                return DataTableResult {
                    ok: false,
                    engine: engine_label.to_string(),
                    duration_ms: start.elapsed().as_millis() as u64,
                    error: Some(format!("SQL 语法错误或只读模式不允许批处理：{first_err}")),
                    read_only: Some(true),
                    ..Default::default()
                };
            }
            // Multi-statement script fallback (DDL/DML batch)
            match conn.execute_batch(trimmed) {
                Ok(_) => DataTableResult {
                    ok: true,
                    engine: engine_label.to_string(),
                    duration_ms: start.elapsed().as_millis() as u64,
                    message: Some("SQL 批处理执行成功。".to_string()),
                    read_only: Some(false),
                    ..Default::default()
                },
                Err(_) => DataTableResult {
                    ok: false,
                    engine: engine_label.to_string(),
                    duration_ms: start.elapsed().as_millis() as u64,
                    error: Some(format!("SQL 语法或执行错误：{first_err}")),
                    read_only: Some(false),
                    ..Default::default()
                },
            }
        }
    }
}

fn load_mounted_files_into_memory_sqlite(
    mounted_files: &[DataMountedFileRef],
) -> Result<Connection, String> {
    let conn =
        Connection::open_in_memory().map_err(|e| format!("初始化内存 SQLite 引擎失败：{e}"))?;

    for file_ref in mounted_files {
        let p = PathBuf::from(&file_ref.path);
        if !p.is_file() {
            continue;
        }
        let fmt = if file_ref.format.trim().is_empty() {
            detect_file_format(&p)
        } else {
            file_ref.format.to_lowercase()
        };
        let table_name = sanitize_alias(&file_ref.alias);

        if fmt == "csv" || fmt == "tsv" {
            let delimiter = if fmt == "tsv" { '\t' } else { ',' };
            let file = File::open(&p).map_err(|e| format!("打开 {} 失败：{e}", file_ref.path))?;
            let mut lines = BufReader::new(file).lines();
            let header_line = match lines.next() {
                Some(Ok(l)) => l.trim_start_matches('\u{feff}').to_string(),
                _ => continue,
            };
            let raw_headers = parse_delimited_line(&header_line, delimiter);
            if raw_headers.is_empty() {
                continue;
            }
            let headers: Vec<String> = raw_headers
                .into_iter()
                .enumerate()
                .map(|(i, h)| {
                    let t = h.trim();
                    if t.is_empty() {
                        format!("col_{}", i + 1)
                    } else {
                        t.to_string()
                    }
                })
                .collect();

            let col_defs: Vec<String> = headers
                .iter()
                .map(|h| format!("{} TEXT", quote_sql_ident(h)))
                .collect();
            let create_sql = format!(
                "CREATE TABLE {} ({})",
                quote_sql_ident(&table_name),
                col_defs.join(", ")
            );
            conn.execute(&create_sql, [])
                .map_err(|e| format!("建表 {table_name} 失败：{e}"))?;

            let placeholders = vec!["?"; headers.len()].join(", ");
            let insert_sql = format!(
                "INSERT INTO {} VALUES ({placeholders})",
                quote_sql_ident(&table_name)
            );
            conn.execute_batch("BEGIN TRANSACTION;")
                .map_err(|e| format!("事务启动失败：{e}"))?;
            {
                let mut stmt = conn
                    .prepare(&insert_sql)
                    .map_err(|e| format!("准备插入失败：{e}"))?;
                let mut loaded = 0usize;
                for line_res in lines {
                    if loaded >= FALLBACK_SQLITE_MAX_LOAD_ROWS {
                        break;
                    }
                    let Ok(line) = line_res else { continue };
                    if line.trim().is_empty() {
                        continue;
                    }
                    let fields = parse_delimited_line(&line, delimiter);
                    let mut params: Vec<rusqlite::types::Value> = Vec::with_capacity(headers.len());
                    for idx in 0..headers.len() {
                        let v = match fields.get(idx).map(|s| infer_scalar_value(s)) {
                            Some(serde_json::Value::Null) | None => rusqlite::types::Value::Null,
                            Some(serde_json::Value::Bool(b)) => {
                                rusqlite::types::Value::Integer(if b { 1 } else { 0 })
                            }
                            Some(serde_json::Value::Number(n)) => {
                                if let Some(iv) = n.as_i64() {
                                    rusqlite::types::Value::Integer(iv)
                                } else if let Some(fv) = n.as_f64() {
                                    rusqlite::types::Value::Real(fv)
                                } else {
                                    rusqlite::types::Value::Text(n.to_string())
                                }
                            }
                            Some(serde_json::Value::String(s)) => rusqlite::types::Value::Text(s),
                            Some(other) => rusqlite::types::Value::Text(other.to_string()),
                        };
                        params.push(v);
                    }
                    let _ = stmt.execute(rusqlite::params_from_iter(params.iter()));
                    loaded += 1;
                }
            }
            let _ = conn.execute_batch("COMMIT;");
        } else if fmt == "json" || fmt == "jsonl" {
            let inspected = inspect_json_native(&p, &fmt, 0, FALLBACK_SQLITE_MAX_LOAD_ROWS)?;
            if inspected.columns.is_empty() {
                continue;
            }
            let col_defs: Vec<String> = inspected
                .columns
                .iter()
                .map(|c| format!("{} TEXT", quote_sql_ident(&c.name)))
                .collect();
            let create_sql = format!(
                "CREATE TABLE {} ({})",
                quote_sql_ident(&table_name),
                col_defs.join(", ")
            );
            conn.execute(&create_sql, [])
                .map_err(|e| format!("建表 {table_name} 失败：{e}"))?;
            let placeholders = vec!["?"; inspected.columns.len()].join(", ");
            let insert_sql = format!(
                "INSERT INTO {} VALUES ({placeholders})",
                quote_sql_ident(&table_name)
            );
            conn.execute_batch("BEGIN TRANSACTION;")
                .map_err(|e| format!("事务启动失败：{e}"))?;
            {
                let mut stmt = conn
                    .prepare(&insert_sql)
                    .map_err(|e| format!("准备插入失败：{e}"))?;
                for row in inspected.preview_rows {
                    let params: Vec<rusqlite::types::Value> = row
                        .into_iter()
                        .map(|val| match val {
                            serde_json::Value::Null => rusqlite::types::Value::Null,
                            serde_json::Value::Bool(b) => {
                                rusqlite::types::Value::Integer(if b { 1 } else { 0 })
                            }
                            serde_json::Value::Number(n) => {
                                if let Some(iv) = n.as_i64() {
                                    rusqlite::types::Value::Integer(iv)
                                } else if let Some(fv) = n.as_f64() {
                                    rusqlite::types::Value::Real(fv)
                                } else {
                                    rusqlite::types::Value::Text(n.to_string())
                                }
                            }
                            serde_json::Value::String(s) => rusqlite::types::Value::Text(s),
                            other => rusqlite::types::Value::Text(other.to_string()),
                        })
                        .collect();
                    let _ = stmt.execute(rusqlite::params_from_iter(params.iter()));
                }
            }
            let _ = conn.execute_batch("COMMIT;");
        }
    }

    Ok(conn)
}

fn pick_best_python(preferred: Option<&str>, prefer_duckdb: bool) -> Option<(String, bool)> {
    let resolved_pref = preferred.and_then(python_lab::resolve_python_executable);
    let extra_owned: Vec<String> = resolved_pref
        .as_ref()
        .map(|p| vec![p.to_string_lossy().to_string()])
        .unwrap_or_default();
    let envs = python_lab::collect_candidate_envs(
        None,
        if extra_owned.is_empty() {
            None
        } else {
            Some(extra_owned.as_slice())
        },
    );
    if let Some(ref pref_path) = resolved_pref {
        let pref_str = pref_path.to_string_lossy().to_string();
        let matched = envs
            .iter()
            .find(|e| e.python_path.eq_ignore_ascii_case(&pref_str));
        let has_duck = matched.map(|e| e.has_duckdb).unwrap_or(false);
        if !prefer_duckdb || has_duck {
            return Some((pref_str, has_duck));
        }
    }

    if prefer_duckdb {
        if let Some(env) = envs.iter().find(|e| e.has_duckdb) {
            return Some((env.python_path.clone(), true));
        }
    }
    if let Some(pref_path) = resolved_pref {
        return Some((pref_path.to_string_lossy().to_string(), false));
    }
    if let Some(env) = envs.iter().find(|e| e.has_pyarrow || e.has_pandas) {
        return Some((env.python_path.clone(), env.has_duckdb));
    }
    if let Some(env) = envs.iter().find(|e| e.has_sqlalchemy) {
        return Some((env.python_path.clone(), env.has_duckdb));
    }
    envs.first().map(|e| (e.python_path.clone(), e.has_duckdb))
}

const EMBEDDED_DATA_ENGINE_PY: &str = r#"
import datetime, decimal, json, math, os, sys

try:
    sys.stdin.reconfigure(encoding='utf-8', errors='replace')
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

def _to_json_val(v):
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return None
        return v
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time)):
        return v.isoformat()
    if isinstance(v, (bytes, bytearray, memoryview)):
        return f"<BYTES {len(v)}>"
    if isinstance(v, (list, dict)):
        try:
            return json.dumps(v, ensure_ascii=False, default=str)[:400]
        except Exception:
            return str(v)[:400]
    s = str(v)
    return s[:800] if len(s) > 800 else s

def _quote_ident(name):
    return '"' + str(name).replace('"', '""') + '"'

def _quote_str(val):
    return "'" + str(val).replace("'", "''") + "'"

def _safe_alias(raw):
    out = ''.join(ch if (ch.isalnum() or ch == '_') else '_' for ch in str(raw or 'dataset')).strip('_')
    if not out:
        return 'dataset'
    if out[0].isdigit():
        return 't_' + out
    return out

def _inspect_file(req):
    path = req['path']
    fmt = req.get('format', 'csv').lower()
    max_rows = int(req.get('maxRows', 20))
    size_bytes = os.path.getsize(path) if os.path.exists(path) else 0
    file_name = os.path.basename(path)

    # 1. Try DuckDB first for Parquet / CSV / JSON
    if fmt in ('parquet', 'csv', 'tsv', 'json', 'jsonl'):
        try:
            import duckdb
            con = duckdb.connect(':memory:')
            p_sql = _quote_str(path)
            if fmt == 'parquet':
                src = f"read_parquet({p_sql})"
            elif fmt == 'tsv':
                src = f"read_csv_auto({p_sql}, delim='\\t')"
            elif fmt == 'csv':
                src = f"read_csv_auto({p_sql})"
            else:
                src = f"read_json_auto({p_sql})"
            desc = con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()
            cols = [{'name': str(r[0]), 'dataType': str(r[1])} for r in desc]
            cnt = con.execute(f"SELECT COUNT(*) FROM {src}").fetchone()[0]
            rows = con.execute(f"SELECT * FROM {src} LIMIT {max_rows}").fetchall()
            con.close()
            return {
                'ok': True,
                'inspection': {
                    'path': path,
                    'fileName': file_name,
                    'format': fmt,
                    'sizeBytes': size_bytes,
                    'rowCount': int(cnt),
                    'columns': cols,
                    'previewRows': [[_to_json_val(c) for c in r] for r in rows],
                    'engine': 'DuckDB',
                }
            }
        except Exception as duck_err:
            if fmt != 'parquet':
                pass
            else:
                duck_msg = str(duck_err)

    # 2. Try PyArrow for Parquet
    if fmt == 'parquet':
        try:
            import pyarrow.parquet as pq
            pf = pq.ParquetFile(path)
            schema = pf.schema_arrow
            cols = [{'name': f.name, 'dataType': str(f.type)} for f in schema]
            total = pf.metadata.num_rows if pf.metadata else None
            batch_rows = []
            for batch in pf.iter_batches(batch_size=max_rows):
                d = batch.to_pydict()
                n = len(next(iter(d.values()), [])) if d else 0
                for i in range(min(n, max_rows - len(batch_rows))):
                    batch_rows.append([_to_json_val(d[c['name']][i]) for c in cols])
                if len(batch_rows) >= max_rows:
                    break
            return {
                'ok': True,
                'inspection': {
                    'path': path,
                    'fileName': file_name,
                    'format': fmt,
                    'sizeBytes': size_bytes,
                    'rowCount': total,
                    'columns': cols,
                    'previewRows': batch_rows,
                    'engine': 'PyArrow',
                }
            }
        except Exception:
            pass

    # 3. Try Pandas (Excel / Parquet / CSV / JSON)
    try:
        import pandas as pd
        if fmt == 'parquet':
            df = pd.read_parquet(path)
        elif fmt == 'excel':
            df = pd.read_excel(path)
        elif fmt == 'tsv':
            df = pd.read_csv(path, sep='\t')
        elif fmt == 'csv':
            df = pd.read_csv(path)
        elif fmt == 'jsonl':
            df = pd.read_json(path, lines=True)
        else:
            df = pd.read_json(path)
        cols = [{'name': str(c), 'dataType': str(df[c].dtype)} for c in df.columns]
        preview = df.head(max_rows).values.tolist()
        return {
            'ok': True,
            'inspection': {
                'path': path,
                'fileName': file_name,
                'format': fmt,
                'sizeBytes': size_bytes,
                'rowCount': int(len(df)),
                'columns': cols,
                'previewRows': [[_to_json_val(c) for c in r] for r in preview],
                'engine': 'Pandas',
            }
        }
    except Exception as exc:
        hint = '请确认当前 Anaconda 环境已安装 duckdb / pyarrow / pandas'
        if fmt == 'excel':
            hint = '读取 Excel 需要在 Anaconda 环境中安装 pandas 与 openpyxl：pip install pandas openpyxl'
        elif fmt == 'parquet':
            hint = '读取 Parquet 需要在 Anaconda 环境中安装 duckdb 或 pyarrow：pip install duckdb pyarrow'
        return {'ok': False, 'error': f'解析 {fmt.upper()} 文件失败：{exc}（{hint}）'}

def _open_pg(conn_cfg, read_only=False, timeout_sec=30):
    host = conn_cfg.get('host') or '127.0.0.1'
    port = int(conn_cfg.get('port') or 5432)
    database = conn_cfg.get('database') or 'postgres'
    user = conn_cfg.get('username') or 'postgres'
    password = conn_cfg.get('password') or ''
    sslmode = (conn_cfg.get('sslMode') or 'prefer').strip() or 'prefer'
    timeout_ms = max(1000, min(600000, int(timeout_sec or 30) * 1000))
    c = None
    engine = 'PostgreSQL'
    try:
        import psycopg
        c = psycopg.connect(
            host=host,
            port=port,
            dbname=database,
            user=user,
            password=password,
            sslmode=sslmode,
            connect_timeout=10,
        )
        engine = 'PostgreSQL (psycopg3)'
    except ImportError:
        pass
    if c is None:
        try:
            import psycopg2
            c = psycopg2.connect(
                host=host,
                port=port,
                dbname=database,
                user=user,
                password=password,
                sslmode=sslmode,
                connect_timeout=10,
            )
            engine = 'PostgreSQL (psycopg2)'
        except ImportError:
            raise RuntimeError('未检测到 PostgreSQL 驱动。请在所选 Anaconda 环境中执行：pip install psycopg[binary] (或 pip install psycopg2-binary)')
    try:
        with c.cursor() as setup_cur:
            setup_cur.execute(f"SET statement_timeout = '{timeout_ms}ms'")
            if read_only:
                setup_cur.execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
        c.commit()
    except Exception:
        try:
            c.rollback()
        except Exception:
            pass
    return c, engine

def _open_mysql(conn_cfg, read_only=False, timeout_sec=30):
    host = conn_cfg.get('host') or '127.0.0.1'
    port = int(conn_cfg.get('port') or 3306)
    database = conn_cfg.get('database') or ''
    user = conn_cfg.get('username') or 'root'
    password = conn_cfg.get('password') or ''
    c = None
    engine = 'MySQL'
    try:
        import pymysql
        c = pymysql.connect(host=host, port=port, database=database or None, user=user, password=password, connect_timeout=10, read_timeout=int(timeout_sec or 30), charset='utf8mb4')
        engine = 'MySQL (PyMySQL)'
    except ImportError:
        pass
    if c is None:
        try:
            import mysql.connector
            c = mysql.connector.connect(host=host, port=port, database=database or None, user=user, password=password, connection_timeout=10)
            engine = 'MySQL (mysql-connector)'
        except ImportError:
            raise RuntimeError('未检测到 MySQL 驱动。请在所选 Anaconda 环境中执行：pip install pymysql (或 pip install mysql-connector-python)')
    if read_only:
        try:
            cur = c.cursor()
            cur.execute("SET SESSION TRANSACTION READ ONLY")
            cur.close()
        except Exception:
            pass
    return c, engine

def _pg_resolve_col_types(conn, desc):
    if not desc:
        return []
    oids = sorted({int(d[1]) for d in desc if len(d) > 1 and isinstance(d[1], int)})
    oid_map = {}
    if oids:
        try:
            with conn.cursor() as tcur:
                placeholders = ','.join(str(x) for x in oids)
                tcur.execute(f"SELECT oid, pg_catalog.format_type(oid, NULL) FROM pg_catalog.pg_type WHERE oid IN ({placeholders})")
                for oid_val, tname in tcur.fetchall():
                    oid_map[int(oid_val)] = str(tname)
        except Exception:
            pass
    cols = []
    for d in desc:
        raw_t = d[1] if len(d) > 1 else None
        if isinstance(raw_t, int):
            dt = oid_map.get(raw_t, str(raw_t))
        elif raw_t:
            dt = str(raw_t)
        else:
            dt = 'ANY'
        cols.append({'name': str(d[0]), 'dataType': dt})
    return cols

def _pg_build_dsn(cfg):
    def _q(val):
        s = str(val or '')
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"
    parts = [
        f"host={_q(cfg.get('host') or '127.0.0.1')}",
        f"port={int(cfg.get('port') or 5432)}",
        f"dbname={_q(cfg.get('database') or 'postgres')}",
        f"user={_q(cfg.get('username') or 'postgres')}",
    ]
    if cfg.get('password'):
        parts.append(f"password={_q(cfg.get('password'))}")
    sslmode = (cfg.get('sslMode') or 'prefer').strip() or 'prefer'
    parts.append(f"sslmode={_q(sslmode)}")
    return ' '.join(parts)

def _pg_is_cursor_eligible(sql):
    import re
    cleaned = re.sub(r'^\s*(?:--[^\n]*\n|/\*[\s\S]*?\*/\s*)*', '', sql or '').strip()
    if not cleaned:
        return False
    if ';' in cleaned.rstrip(';'):
        return False
    return bool(re.match(r'^(?:SELECT|WITH|TABLE|VALUES)\b', cleaned, re.IGNORECASE))

def _parse_pg_array_preview(raw_val, limit=5):
    if raw_val is None:
        return []
    if isinstance(raw_val, (list, tuple)):
        return [str(x)[:80] for x in raw_val[:limit]]
    s = str(raw_val).strip()
    if s.startswith('{') and s.endswith('}'):
        inner = s[1:-1]
        if not inner:
            return []
        parts = []
        cur = []
        in_q = False
        esc = False
        for ch in inner:
            if esc:
                cur.append(ch)
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == '"':
                in_q = not in_q
            elif ch == ',' and not in_q:
                parts.append(''.join(cur)[:80])
                cur = []
                if len(parts) >= limit:
                    return parts
            else:
                cur.append(ch)
        if cur or inner.endswith(','):
            parts.append(''.join(cur)[:80])
        return parts[:limit]
    return [s[:80]]

def _write_bus_file(tables_dir, export_bus, cols, fetched_rows):
    if not (export_bus and tables_dir and os.path.isdir(tables_dir) and cols):
        return None
    safe_name = _safe_alias(export_bus)
    pq_target = os.path.join(tables_dir, f"{safe_name}.parquet")
    csv_target = os.path.join(tables_dir, f"{safe_name}.csv")
    col_names = [col['name'] for col in cols]
    try:
        import pyarrow as _pa
        import pyarrow.parquet as _pq
        col_data = {}
        for idx, cname in enumerate(col_names):
            vals = [r[idx] if idx < len(r) else None for r in fetched_rows]
            clean_vals = [float(v) if isinstance(v, decimal.Decimal) else v for v in vals]
            try:
                col_data[cname] = _pa.array(clean_vals)
            except Exception:
                col_data[cname] = _pa.array([_to_json_val(v) for v in vals])
        table = _pa.table(col_data)
        _pq.write_table(table, pq_target)
        if os.path.exists(csv_target):
            try:
                os.remove(csv_target)
            except Exception:
                pass
        return pq_target
    except Exception:
        pass
    try:
        import pandas as _pd
        norm_rows = [[float(v) if isinstance(v, decimal.Decimal) else v for v in r] for r in fetched_rows]
        df = _pd.DataFrame(norm_rows, columns=col_names)
        df.to_parquet(pq_target, index=False)
        if os.path.exists(csv_target):
            try:
                os.remove(csv_target)
            except Exception:
                pass
        return pq_target
    except Exception:
        pass
    try:
        import csv as _sm_csv
        with open(csv_target, 'w', newline='', encoding='utf-8') as f:
            w = _sm_csv.writer(f)
            w.writerow(col_names)
            for r in fetched_rows:
                w.writerow([_to_json_val(v) for v in r])
        if os.path.exists(pq_target):
            try:
                os.remove(pq_target)
            except Exception:
                pass
        return csv_target
    except Exception:
        return None

def _list_pg_databases(req):
    conn_cfg = dict(req['connection'])
    c = None
    last_err = None
    candidates = [conn_cfg.get('database') or 'postgres', 'postgres', 'template1']
    tried = set()
    for db_cand in candidates:
        if db_cand in tried:
            continue
        tried.add(db_cand)
        try:
            attempt = dict(conn_cfg)
            attempt['database'] = db_cand
            c, engine = _open_pg(attempt, read_only=True, timeout_sec=15)
            break
        except Exception as exc:
            last_err = exc
    if c is None:
        raise last_err or RuntimeError('连接 PostgreSQL 实例失败')
    try:
        with c.cursor() as cur:
            cur.execute("""
                SELECT
                    d.datname,
                    pg_catalog.pg_database_size(d.datname) AS size_bytes,
                    pg_catalog.pg_get_userbyid(d.datdba) AS owner,
                    pg_catalog.pg_encoding_to_char(d.encoding) AS encoding
                FROM pg_catalog.pg_database d
                WHERE d.datistemplate = false
                  AND pg_catalog.has_database_privilege(d.datname, 'CONNECT')
                ORDER BY (d.datname = current_database()) DESC, size_bytes DESC NULLS LAST, d.datname ASC
            """)
            dbs = [{
                'name': str(r[0]),
                'sizeBytes': int(r[1]) if r[1] is not None else None,
                'owner': str(r[2]) if r[2] is not None else None,
                'encoding': str(r[3]) if r[3] is not None else None,
            } for r in cur.fetchall()]
        return {'ok': True, 'databases': dbs, 'engine': engine}
    finally:
        c.close()

def _create_pg_database(req):
    conn_cfg = req['connection']
    database_name = req['databaseName']
    c, engine = _open_pg(conn_cfg, read_only=False, timeout_sec=30)
    try:
        c.autocommit = True
        cur = c.cursor()
        try:
            cur.execute('CREATE DATABASE "' + database_name + '"')
        finally:
            cur.close()
    finally:
        c.close()
    return {'ok': True, 'message': f'数据库 {database_name} 已创建。', 'engine': engine}

def _test_db(req):
    conn_cfg = req['connection']
    db_type = (conn_cfg.get('dbType') or '').lower()
    if db_type == 'duckdb':
        try:
            import duckdb
        except ImportError:
            return {'ok': False, 'message': '未检测到 DuckDB。请在当前 Anaconda 环境中执行：pip install duckdb', 'tables': [], 'engine': 'DuckDB'}
        fpath = (conn_cfg.get('filePath') or '').strip() or ':memory:'
        con = duckdb.connect(fpath, read_only=(fpath != ':memory:' and os.path.exists(fpath)))
        rows = con.execute("""
            SELECT table_schema, table_name, table_type
            FROM information_schema.tables
            WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
            ORDER BY table_schema, table_name
        """).fetchall()
        col_rows = con.execute("""
            SELECT table_schema, table_name, column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
            ORDER BY table_schema, table_name, ordinal_position
        """).fetchall()
        con.close()
        col_map = {}
        for sch, tbl, col, dt, is_null in col_rows:
            col_map.setdefault((sch, tbl), []).append({
                'name': str(col),
                'dataType': str(dt),
                'nullable': str(is_null).upper() != 'NO',
            })
        tables = []
        for sch, tbl, ttype in rows:
            tables.append({
                'name': str(tbl),
                'schema': str(sch),
                'tableType': str(ttype).lower(),
                'rowCount': None,
                'estimatedRows': None,
                'totalBytes': None,
                'comment': None,
                'primaryKeys': [],
                'foreignKeys': [],
                'indexes': [],
                'columns': col_map.get((sch, tbl), []),
            })
        return {'ok': True, 'message': f'已连接 DuckDB，发现 {len(tables)} 张表/视图。', 'tables': tables, 'engine': 'DuckDB'}

    if db_type == 'postgres':
        c, engine = _open_pg(conn_cfg, read_only=True, timeout_sec=20)
        _pg_fk_action = {
            'a': 'NO ACTION',
            'r': 'RESTRICT',
            'c': 'CASCADE',
            'n': 'SET NULL',
            'd': 'SET DEFAULT',
        }
        try:
            cur = c.cursor()
            cur.execute("""
                SELECT
                    n.nspname AS schema_name,
                    c.relname AS table_name,
                    CASE c.relkind
                        WHEN 'r' THEN 'table'
                        WHEN 'p' THEN 'partitioned table'
                        WHEN 'v' THEN 'view'
                        WHEN 'm' THEN 'materialized view'
                        WHEN 'f' THEN 'foreign table'
                        ELSE 'table'
                    END AS table_type,
                    CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint ELSE NULL END AS est_rows,
                    CASE WHEN c.relkind IN ('r', 'p', 'm') THEN pg_catalog.pg_total_relation_size(c.oid) ELSE NULL END AS total_bytes,
                    pg_catalog.obj_description(c.oid, 'pg_class') AS table_comment
                FROM pg_catalog.pg_class c
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
                  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                  AND n.nspname NOT LIKE 'pg_temp_%'
                  AND n.nspname NOT LIKE 'pg_toast_temp_%'
                ORDER BY n.nspname, c.relname
                LIMIT 2000
            """)
            trows = cur.fetchall()
            cur.execute("""
                SELECT
                    n.nspname AS schema_name,
                    c.relname AS table_name,
                    a.attname AS column_name,
                    pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
                    NOT a.attnotnull AS nullable,
                    pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_val,
                    pg_catalog.col_description(a.attrelid, a.attnum) AS col_comment
                FROM pg_catalog.pg_attribute a
                JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
                WHERE a.attnum > 0
                  AND NOT a.attisdropped
                  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                  AND n.nspname NOT LIKE 'pg_temp_%'
                  AND n.nspname NOT LIKE 'pg_toast_temp_%'
                ORDER BY n.nspname, c.relname, a.attnum
            """)
            crows = cur.fetchall()
            cur.execute("""
                SELECT
                    n.nspname AS schema_name,
                    c.relname AS table_name,
                    a.attname AS column_name,
                    array_position(con.conkey, a.attnum) AS pk_pos
                FROM pg_catalog.pg_constraint con
                JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
                WHERE con.contype = 'p'
                  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                ORDER BY n.nspname, c.relname, pk_pos
            """)
            pk_rows = cur.fetchall()
            cur.execute("""
                SELECT
                    n.nspname AS schema_name,
                    c.relname AS table_name,
                    a.attname AS column_name,
                    rn.nspname AS ref_schema,
                    rc.relname AS ref_table,
                    ra.attname AS ref_column,
                    con.conname AS constraint_name,
                    con.confupdtype::text AS on_update,
                    con.confdeltype::text AS on_delete
                FROM pg_catalog.pg_constraint con
                JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid
                JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
                JOIN unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, ref_attnum, ord) ON true
                JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                JOIN pg_catalog.pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.ref_attnum
                WHERE con.contype = 'f'
                  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                ORDER BY n.nspname, c.relname, con.conname, k.ord
            """)
            fk_rows = cur.fetchall()
            idx_rows = []
            try:
                cur.execute("""
                    SELECT
                        n.nspname AS schema_name,
                        t.relname AS table_name,
                        ic.relname AS index_name,
                        ix.indisunique,
                        ix.indisprimary,
                        pg_catalog.pg_get_indexdef(ix.indexrelid),
                        ARRAY(
                            SELECT a.attname
                            FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
                            LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                            ORDER BY k.ord
                        )
                    FROM pg_catalog.pg_index ix
                    JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
                    JOIN pg_catalog.pg_class ic ON ic.oid = ix.indexrelid
                    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
                    WHERE t.relkind IN ('r', 'p', 'm')
                      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                      AND n.nspname NOT LIKE 'pg_temp_%'
                    ORDER BY n.nspname, t.relname, ix.indisprimary DESC, ic.relname
                """)
                idx_rows = cur.fetchall()
            except Exception:
                idx_rows = []
            custom_types = []
            try:
                cur.execute("""
                    SELECT
                        n.nspname AS schema_name,
                        t.typname AS type_name,
                        t.typtype::text AS type_kind,
                        pg_catalog.obj_description(t.oid, 'pg_type') AS type_comment,
                        ARRAY(
                            SELECT e.enumlabel
                            FROM pg_catalog.pg_enum e
                            WHERE e.enumtypid = t.oid
                            ORDER BY e.enumsortorder
                        ) AS enum_values,
                        t.typrelid
                    FROM pg_catalog.pg_type t
                    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
                    LEFT JOIN pg_catalog.pg_class tc ON tc.oid = t.typrelid
                    WHERE t.typtype IN ('e', 'c')
                      AND (t.typtype = 'e' OR tc.relkind = 'c')
                      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                      AND n.nspname NOT LIKE 'pg_temp_%'
                    ORDER BY n.nspname, t.typname
                    LIMIT 300
                """)
                type_rows = cur.fetchall()
                comp_relids = [int(r[5]) for r in type_rows if r[2] == 'c' and r[5]]
                comp_fields = {}
                if comp_relids:
                    placeholders = ','.join(str(x) for x in comp_relids)
                    cur.execute(f"""
                        SELECT attrelid, attname, pg_catalog.format_type(atttypid, atttypmod)
                        FROM pg_catalog.pg_attribute
                        WHERE attrelid IN ({placeholders}) AND attnum > 0 AND NOT attisdropped
                        ORDER BY attrelid, attnum
                    """)
                    for relid, aname, atype in cur.fetchall():
                        comp_fields.setdefault(int(relid), []).append({
                            'name': str(aname),
                            'dataType': str(atype),
                        })
                for sch, tname, tkind, tcomment, evals, relid in type_rows:
                    custom_types.append({
                        'schema': str(sch),
                        'name': str(tname),
                        'kind': 'enum' if tkind == 'e' else 'composite',
                        'values': [str(v) for v in (evals or []) if v is not None],
                        'fields': comp_fields.get(int(relid), []) if tkind == 'c' and relid else [],
                        'comment': str(tcomment) if tcomment else None,
                    })
            except Exception:
                custom_types = []
            cur.close()
        finally:
            c.close()

        pk_map = {}
        pk_set = {}
        for sch, tbl, col, _pos in pk_rows:
            key = (str(sch), str(tbl))
            pk_map.setdefault(key, []).append(str(col))
            pk_set.setdefault(key, set()).add(str(col))

        fk_map = {}
        for sch, tbl, col, rsch, rtbl, rcol, cname, upd, dele in fk_rows:
            fk_map.setdefault((str(sch), str(tbl)), []).append({
                'column': str(col),
                'refSchema': str(rsch),
                'refTable': str(rtbl),
                'refColumn': str(rcol),
                'constraintName': str(cname),
                'onUpdate': _pg_fk_action.get(str(upd or '').lower(), 'NO ACTION'),
                'onDelete': _pg_fk_action.get(str(dele or '').lower(), 'NO ACTION'),
            })

        idx_map = {}
        uniq_single_col = {}
        for sch, tbl, iname, is_u, is_p, idef, icols in idx_rows:
            key = (str(sch), str(tbl))
            col_list = [str(x) for x in (icols or []) if x]
            if is_u and len(col_list) == 1:
                uniq_single_col.setdefault(key, set()).add(col_list[0])
            idx_map.setdefault(key, []).append({
                'name': str(iname),
                'unique': bool(is_u),
                'primary': bool(is_p),
                'definition': str(idef) if idef else None,
                'columns': col_list,
            })

        col_map = {}
        for sch, tbl, col, dt, nullable, default_val, comment in crows:
            key = (str(sch), str(tbl))
            cname = str(col)
            col_map.setdefault(key, []).append({
                'name': cname,
                'dataType': str(dt),
                'nullable': bool(nullable),
                'isPrimaryKey': cname in pk_set.get(key, set()),
                'isUnique': cname in uniq_single_col.get(key, set()),
                'defaultValue': str(default_val) if default_val is not None else None,
                'comment': str(comment) if comment else None,
            })

        tables = []
        schema_names = set()
        for sch, tbl, ttype, est_rows, total_bytes, comment in trows:
            s_str, t_str = str(sch), str(tbl)
            schema_names.add(s_str)
            est_val = int(est_rows) if est_rows is not None else None
            tables.append({
                'name': t_str,
                'schema': s_str,
                'tableType': str(ttype),
                'rowCount': est_val if (est_val is not None and est_val >= 0) else None,
                'estimatedRows': est_val,
                'totalBytes': int(total_bytes) if total_bytes is not None else None,
                'comment': str(comment) if comment else None,
                'primaryKeys': pk_map.get((s_str, t_str), []),
                'foreignKeys': fk_map.get((s_str, t_str), []),
                'indexes': idx_map.get((s_str, t_str), []),
                'columns': col_map.get((s_str, t_str), []),
            })
        db_label = conn_cfg.get('database') or 'postgres'
        return {
            'ok': True,
            'message': f'已连接 {db_label}（{len(schema_names)} 个 Schema · {len(tables)} 张表/视图）。',
            'tables': tables,
            'customTypes': custom_types,
            'engine': engine,
        }

    if db_type == 'mysql':
        c, engine = _open_mysql(conn_cfg, read_only=True, timeout_sec=20)
        try:
            cur = c.cursor()
            cur.execute("""
                SELECT table_schema, table_name, table_type, table_rows, (data_length + index_length), table_comment
                FROM information_schema.tables
                WHERE table_schema = DATABASE()
                ORDER BY table_name
                LIMIT 500
            """)
            trows = cur.fetchall()
            cur.execute("""
                SELECT table_schema, table_name, column_name, column_type, is_nullable, column_key, column_default, column_comment
                FROM information_schema.columns
                WHERE table_schema = DATABASE()
                ORDER BY table_name, ordinal_position
            """)
            crows = cur.fetchall()
            fk_rows = []
            try:
                cur.execute("""
                    SELECT
                        k.table_schema, k.table_name, k.column_name,
                        k.referenced_table_schema, k.referenced_table_name, k.referenced_column_name,
                        k.constraint_name, rc.update_rule, rc.delete_rule
                    FROM information_schema.key_column_usage k
                    LEFT JOIN information_schema.referential_constraints rc
                      ON rc.constraint_schema = k.table_schema AND rc.constraint_name = k.constraint_name
                    WHERE k.table_schema = DATABASE()
                      AND k.referenced_table_name IS NOT NULL
                    ORDER BY k.table_name, k.constraint_name, k.ordinal_position
                """)
                fk_rows = cur.fetchall()
            except Exception:
                fk_rows = []
            idx_rows = []
            try:
                cur.execute("""
                    SELECT table_schema, table_name, index_name, non_unique, column_name, seq_in_index
                    FROM information_schema.statistics
                    WHERE table_schema = DATABASE()
                    ORDER BY table_name, index_name, seq_in_index
                """)
                idx_rows = cur.fetchall()
            except Exception:
                idx_rows = []
            cur.close()
        finally:
            c.close()
        fk_map = {}
        for sch, tbl, col, rsch, rtbl, rcol, cname, upd, dele in fk_rows:
            fk_map.setdefault((str(sch), str(tbl)), []).append({
                'column': str(col),
                'refSchema': str(rsch) if rsch else None,
                'refTable': str(rtbl),
                'refColumn': str(rcol),
                'constraintName': str(cname) if cname else None,
                'onUpdate': str(upd) if upd else 'NO ACTION',
                'onDelete': str(dele) if dele else 'NO ACTION',
            })
        idx_group = {}
        for sch, tbl, iname, non_u, col, _seq in idx_rows:
            gkey = (str(sch), str(tbl), str(iname))
            entry = idx_group.setdefault(gkey, {
                'name': str(iname),
                'unique': int(non_u or 0) == 0,
                'primary': str(iname).upper() == 'PRIMARY',
                'definition': None,
                'columns': [],
            })
            entry['columns'].append(str(col))
        idx_map = {}
        for (sch, tbl, _iname), item in idx_group.items():
            idx_map.setdefault((sch, tbl), []).append(item)
        col_map = {}
        pk_map = {}
        for sch, tbl, col, dt, is_null, ckey, cdef, comment in crows:
            key = (str(sch), str(tbl))
            ck = str(ckey or '').upper()
            is_pk = ck == 'PRI'
            if is_pk:
                pk_map.setdefault(key, []).append(str(col))
            col_map.setdefault(key, []).append({
                'name': str(col),
                'dataType': str(dt),
                'nullable': str(is_null).upper() != 'NO',
                'isPrimaryKey': is_pk,
                'isUnique': ck == 'UNI',
                'defaultValue': str(cdef) if cdef is not None else None,
                'comment': str(comment) if comment else None,
            })
        tables = [{
            'name': str(tbl),
            'schema': str(sch),
            'tableType': str(ttype).lower(),
            'rowCount': int(est_r) if est_r is not None else None,
            'estimatedRows': int(est_r) if est_r is not None else None,
            'totalBytes': int(tbytes) if tbytes is not None else None,
            'comment': str(comment) if comment else None,
            'primaryKeys': pk_map.get((str(sch), str(tbl)), []),
            'foreignKeys': fk_map.get((str(sch), str(tbl)), []),
            'indexes': idx_map.get((str(sch), str(tbl)), []),
            'columns': col_map.get((str(sch), str(tbl)), []),
        } for sch, tbl, ttype, est_r, tbytes, comment in trows]
        return {'ok': True, 'message': f'已连接 MySQL，发现 {len(tables)} 张表/视图。', 'tables': tables, 'customTypes': [], 'engine': engine}

    return {'ok': False, 'message': f'不支持的数据库类型：{db_type}', 'tables': [], 'engine': 'Unknown'}

def _profile_table(req):
    conn_cfg = req['connection']
    db_type = (conn_cfg.get('dbType') or '').lower()
    schema = (req.get('schema') or '').strip() or None
    table_name = (req.get('tableName') or '').strip()
    sample_rows_cap = max(0, min(20, int(req.get('sampleRows', 5))))
    if not table_name:
        return {'ok': False, 'tableName': '', 'tableType': 'table', 'engine': db_type.upper(), 'error': '表名不能为空。'}

    if db_type == 'postgres':
        target_schema = schema or 'public'
        c, engine = _open_pg(conn_cfg, read_only=True, timeout_sec=15)
        try:
            with c.cursor() as cur:
                cur.execute("""
                    SELECT
                        CASE c.relkind
                            WHEN 'r' THEN 'table'
                            WHEN 'p' THEN 'partitioned table'
                            WHEN 'v' THEN 'view'
                            WHEN 'm' THEN 'materialized view'
                            WHEN 'f' THEN 'foreign table'
                            ELSE 'table'
                        END,
                        CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint ELSE NULL END,
                        CASE WHEN c.relkind IN ('r', 'p', 'm') THEN pg_catalog.pg_total_relation_size(c.oid) ELSE NULL END,
                        pg_catalog.obj_description(c.oid, 'pg_class')
                    FROM pg_catalog.pg_class c
                    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = %s AND c.relname = %s
                    LIMIT 1
                """, (target_schema, table_name))
                tinfo = cur.fetchone()
                if not tinfo:
                    return {'ok': False, 'schema': target_schema, 'tableName': table_name, 'tableType': 'table', 'engine': engine, 'error': f'未找到表 {target_schema}.{table_name}'}
                table_type, est_rows, total_bytes, table_comment = tinfo

                cur.execute("""
                    SELECT
                        a.attname,
                        pg_catalog.format_type(a.atttypid, a.atttypmod),
                        NOT a.attnotnull,
                        pg_catalog.col_description(a.attrelid, a.attnum)
                    FROM pg_catalog.pg_attribute a
                    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
                    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = %s AND c.relname = %s AND a.attnum > 0 AND NOT a.attisdropped
                    ORDER BY a.attnum
                """, (target_schema, table_name))
                col_rows = cur.fetchall()

                cur.execute("""
                    SELECT a.attname
                    FROM pg_catalog.pg_constraint con
                    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
                    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                    JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
                    WHERE con.contype = 'p' AND n.nspname = %s AND c.relname = %s
                    ORDER BY array_position(con.conkey, a.attnum)
                """, (target_schema, table_name))
                pks = [str(r[0]) for r in cur.fetchall()]
                pk_set = set(pks)

                cur.execute("""
                    SELECT
                        a.attname, rn.nspname, rc.relname, ra.attname, con.conname
                    FROM pg_catalog.pg_constraint con
                    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
                    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                    JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid
                    JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
                    JOIN unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, ref_attnum, ord) ON true
                    JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                    JOIN pg_catalog.pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.ref_attnum
                    WHERE con.contype = 'f' AND n.nspname = %s AND c.relname = %s
                    ORDER BY con.conname, k.ord
                """, (target_schema, table_name))
                fks = [{
                    'column': str(r[0]),
                    'refSchema': str(r[1]),
                    'refTable': str(r[2]),
                    'refColumn': str(r[3]),
                    'constraintName': str(r[4]),
                } for r in cur.fetchall()]

                cur.execute("""
                    SELECT
                        ic.relname,
                        ix.indisunique,
                        ix.indisprimary,
                        pg_catalog.pg_get_indexdef(ix.indexrelid),
                        ARRAY(
                            SELECT a.attname
                            FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
                            LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                            ORDER BY k.ord
                        )
                    FROM pg_catalog.pg_index ix
                    JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
                    JOIN pg_catalog.pg_class ic ON ic.oid = ix.indexrelid
                    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
                    WHERE n.nspname = %s AND t.relname = %s
                    ORDER BY ix.indisprimary DESC, ic.relname
                """, (target_schema, table_name))
                indexes = [{
                    'name': str(r[0]),
                    'unique': bool(r[1]),
                    'primary': bool(r[2]),
                    'definition': str(r[3]) if r[3] else None,
                    'columns': [str(x) for x in (r[4] or []) if x],
                } for r in cur.fetchall()]

                stats_map = {}
                try:
                    cur.execute("""
                        SELECT
                            attname,
                            null_frac,
                            n_distinct,
                            most_common_vals::text,
                            histogram_bounds::text
                        FROM pg_catalog.pg_stats
                        WHERE schemaname = %s AND tablename = %s
                    """, (target_schema, table_name))
                    for att, nf, nd, mcv, hist in cur.fetchall():
                        bounds = _parse_pg_array_preview(hist, limit=1000)
                        stats_map[str(att)] = {
                            'nullFraction': float(nf) if nf is not None else None,
                            'nDistinct': float(nd) if nd is not None else None,
                            'mostCommonVals': _parse_pg_array_preview(mcv, limit=6),
                            'minValue': bounds[0] if len(bounds) >= 1 else None,
                            'maxValue': bounds[-1] if len(bounds) >= 2 else None,
                        }
                except Exception:
                    pass

                columns = []
                for cname, dtype, nullable, comment in col_rows:
                    c_str = str(cname)
                    st = stats_map.get(c_str, {})
                    columns.append({
                        'name': c_str,
                        'dataType': str(dtype),
                        'nullable': bool(nullable),
                        'isPrimaryKey': c_str in pk_set,
                        'comment': str(comment) if comment else None,
                        'nullFraction': st.get('nullFraction'),
                        'nDistinct': st.get('nDistinct'),
                        'mostCommonVals': st.get('mostCommonVals', []),
                        'minValue': st.get('minValue'),
                        'maxValue': st.get('maxValue'),
                    })

                sample_cols = []
                sample_rows = []
                if sample_rows_cap > 0:
                    try:
                        q_tbl = f"{_quote_ident(target_schema)}.{_quote_ident(table_name)}"
                        cur.execute(f"SELECT * FROM {q_tbl} LIMIT {sample_rows_cap}")
                        sample_cols = _pg_resolve_col_types(c, cur.description)
                        sample_rows = [[_to_json_val(v) for v in r] for r in cur.fetchall()]
                    except Exception:
                        pass

            return {
                'ok': True,
                'schema': target_schema,
                'tableName': table_name,
                'tableType': str(table_type),
                'estimatedRows': int(est_rows) if est_rows is not None else None,
                'totalBytes': int(total_bytes) if total_bytes is not None else None,
                'comment': str(table_comment) if table_comment else None,
                'primaryKeys': pks,
                'foreignKeys': fks,
                'indexes': indexes,
                'columns': columns,
                'sampleColumns': sample_cols,
                'sampleRows': sample_rows,
                'engine': engine,
                'error': None,
            }
        finally:
            c.close()

    if db_type == 'duckdb':
        import duckdb
        fpath = (conn_cfg.get('filePath') or '').strip() or ':memory:'
        con = duckdb.connect(fpath, read_only=(fpath != ':memory:' and os.path.exists(fpath)))
        try:
            q_tbl = f"{_quote_ident(schema)}.{_quote_ident(table_name)}" if schema else _quote_ident(table_name)
            desc = con.execute(f"DESCRIBE SELECT * FROM {q_tbl}").fetchall()
            cols = [{
                'name': str(r[0]),
                'dataType': str(r[1]),
                'nullable': str(r[2]).upper() != 'NO' if len(r) > 2 else None,
                'isPrimaryKey': False,
                'mostCommonVals': [],
            } for r in desc]
            cnt = con.execute(f"SELECT COUNT(*) FROM {q_tbl}").fetchone()[0]
            srows = []
            scols = [{'name': c['name'], 'dataType': c['dataType']} for c in cols]
            if sample_rows_cap > 0:
                srows = [[_to_json_val(v) for v in r] for r in con.execute(f"SELECT * FROM {q_tbl} LIMIT {sample_rows_cap}").fetchall()]
            return {
                'ok': True,
                'schema': schema or 'main',
                'tableName': table_name,
                'tableType': 'table',
                'estimatedRows': int(cnt),
                'totalBytes': None,
                'comment': None,
                'primaryKeys': [],
                'foreignKeys': [],
                'indexes': [],
                'columns': cols,
                'sampleColumns': scols,
                'sampleRows': srows,
                'engine': 'DuckDB',
                'error': None,
            }
        finally:
            con.close()

    if db_type == 'mysql':
        c, engine = _open_mysql(conn_cfg, read_only=True, timeout_sec=15)
        try:
            cur = c.cursor()
            cur.execute("""
                SELECT column_name, column_type, is_nullable, column_key, column_comment
                FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = %s
                ORDER BY ordinal_position
            """, (table_name,))
            pks = []
            cols = []
            for cname, dtype, is_null, ckey, comment in cur.fetchall():
                is_pk = str(ckey or '').upper() == 'PRI'
                if is_pk:
                    pks.append(str(cname))
                cols.append({
                    'name': str(cname),
                    'dataType': str(dtype),
                    'nullable': str(is_null).upper() != 'NO',
                    'isPrimaryKey': is_pk,
                    'comment': str(comment) if comment else None,
                    'mostCommonVals': [],
                })
            srows = []
            scols = [{'name': x['name'], 'dataType': x['dataType']} for x in cols]
            if sample_rows_cap > 0:
                safe_t = '`' + table_name.replace('`', '``') + '`'
                cur.execute(f"SELECT * FROM {safe_t} LIMIT {sample_rows_cap}")
                srows = [[_to_json_val(v) for v in r] for r in cur.fetchall()]
            cur.close()
            return {
                'ok': True,
                'schema': conn_cfg.get('database'),
                'tableName': table_name,
                'tableType': 'table',
                'estimatedRows': None,
                'totalBytes': None,
                'comment': None,
                'primaryKeys': pks,
                'foreignKeys': [],
                'indexes': [],
                'columns': cols,
                'sampleColumns': scols,
                'sampleRows': srows,
                'engine': engine,
                'error': None,
            }
        finally:
            c.close()

    return {'ok': False, 'schema': schema, 'tableName': table_name, 'tableType': 'table', 'engine': db_type.upper(), 'error': f'暂不支持剖析 {db_type} 表。'}

def _query_sql(req):
    sql = (req.get('sql') or '').strip()
    max_rows = max(1, min(2000, int(req.get('maxRows', 200))))
    page = max(1, int(req.get('page', 1)))
    offset = (page - 1) * max_rows
    conn_cfg = req.get('connection')
    mounted = req.get('mountedFiles') or []
    attach_conns = req.get('attachConnections') or []
    export_bus = (req.get('exportBusTable') or '').strip()
    export_max_rows = max(max_rows, min(1000000, int(req.get('exportMaxRows', 200000))))
    tables_dir = (req.get('tablesDir') or '').strip()
    db_type = (conn_cfg.get('dbType') or '').lower() if conn_cfg else 'duckdb'
    read_only = bool(req.get('readOnly')) if req.get('readOnly') is not None else bool(conn_cfg.get('readOnly', True) if conn_cfg else True)
    timeout_sec = max(1, min(600, int(req.get('statementTimeoutSec') or (conn_cfg.get('statementTimeoutSec') if conn_cfg else 30) or 30)))

    if db_type == 'duckdb':
        import duckdb
        fpath = (conn_cfg.get('filePath') or '').strip() if conn_cfg else ''
        con = duckdb.connect(fpath or ':memory:', read_only=(read_only and bool(fpath) and fpath != ':memory:' and os.path.exists(fpath)))
        try:
            for item in mounted:
                p = item.get('path') or ''
                if not p or not os.path.exists(p):
                    continue
                alias = _safe_alias(item.get('alias') or os.path.splitext(os.path.basename(p))[0])
                fmt = (item.get('format') or '').lower()
                p_sql = _quote_str(p)
                if fmt == 'parquet':
                    con.execute(f"CREATE OR REPLACE TEMP VIEW {_quote_ident(alias)} AS SELECT * FROM read_parquet({p_sql})")
                elif fmt == 'tsv':
                    con.execute(f"CREATE OR REPLACE TEMP VIEW {_quote_ident(alias)} AS SELECT * FROM read_csv_auto({p_sql}, delim='\\t')")
                elif fmt == 'csv':
                    con.execute(f"CREATE OR REPLACE TEMP VIEW {_quote_ident(alias)} AS SELECT * FROM read_csv_auto({p_sql})")
                elif fmt in ('json', 'jsonl'):
                    con.execute(f"CREATE OR REPLACE TEMP VIEW {_quote_ident(alias)} AS SELECT * FROM read_json_auto({p_sql})")

            attached_names = []
            pg_ext_loaded = False
            for ac in attach_conns:
                ac_type = str(ac.get('dbType') or '').lower()
                ac_alias = _safe_alias(ac.get('database') or ac.get('name') or ac.get('id') or 'db').lower()
                try:
                    if ac_type == 'postgres':
                        if not pg_ext_loaded:
                            try:
                                con.execute("LOAD postgres")
                            except Exception:
                                con.execute("INSTALL postgres; LOAD postgres")
                            pg_ext_loaded = True
                        dsn = _pg_build_dsn(ac).replace("'", "''")
                        con.execute(f"ATTACH '{dsn}' AS {_quote_ident(ac_alias)} (TYPE POSTGRES, READ_ONLY)")
                        attached_names.append(ac_alias)
                    elif ac_type == 'sqlite' and ac.get('filePath'):
                        p_sql = _quote_str(ac.get('filePath'))
                        con.execute(f"ATTACH {p_sql} AS {_quote_ident(ac_alias)} (TYPE SQLITE, READ_ONLY)")
                        attached_names.append(ac_alias)
                    elif ac_type == 'duckdb' and ac.get('filePath'):
                        p_sql = _quote_str(ac.get('filePath'))
                        con.execute(f"ATTACH {p_sql} AS {_quote_ident(ac_alias)} (READ_ONLY)")
                        attached_names.append(ac_alias)
                except Exception:
                    pass

            res = con.execute(sql)
            desc = res.description
            if not desc:
                return {'ok': True, 'columns': [], 'rows': [], 'totalRows': None, 'truncated': False, 'engine': 'DuckDB', 'message': 'SQL 执行完成。', 'error': None, 'busTablePath': None, 'page': page, 'pageSize': max_rows, 'hasMore': False, 'readOnly': read_only}
            cols = [{'name': str(d[0]), 'dataType': str(d[1]) if len(d) > 1 and d[1] else 'ANY'} for d in desc]
            if offset > 0:
                remaining_skip = offset
                while remaining_skip > 0:
                    skipped = res.fetchmany(min(2000, remaining_skip))
                    if not skipped:
                        break
                    remaining_skip -= len(skipped)
            fetched = res.fetchmany(max_rows + 1)
            has_more = len(fetched) > max_rows
            if has_more:
                fetched = fetched[:max_rows]
            rows = [[_to_json_val(v) for v in r] for r in fetched]
            bus_path = None
            exported_rows = None
            if export_bus and tables_dir and os.path.isdir(tables_dir):
                safe_name = _safe_alias(export_bus)
                clean_q = sql.rstrip().rstrip(';')
                pq_target = os.path.join(tables_dir, f"{safe_name}.parquet")
                csv_stale = os.path.join(tables_dir, f"{safe_name}.csv")
                try:
                    con.execute(f"COPY ({clean_q}) TO {_quote_str(pq_target)} (FORMAT PARQUET)")
                    if os.path.exists(csv_stale):
                        try:
                            os.remove(csv_stale)
                        except Exception:
                            pass
                    bus_path = pq_target
                    try:
                        exported_rows = int(con.execute(f"SELECT COUNT(*) FROM read_parquet({_quote_str(pq_target)})").fetchone()[0])
                    except Exception:
                        pass
                except Exception:
                    pass
            eng_label = f"DuckDB (联邦: {', '.join(attached_names)})" if attached_names else 'DuckDB'
            return {
                'ok': True,
                'columns': cols,
                'rows': rows,
                'totalRows': None if has_more else (offset + len(rows)),
                'truncated': has_more,
                'engine': eng_label,
                'message': None,
                'error': None,
                'busTablePath': bus_path,
                'page': page,
                'pageSize': max_rows,
                'hasMore': has_more,
                'readOnly': read_only,
                'exportedRows': exported_rows,
            }
        finally:
            con.close()

    if db_type == 'postgres':
        c, engine = _open_pg(conn_cfg, read_only=read_only, timeout_sec=timeout_sec)
        try:
            use_server_cursor = _pg_is_cursor_eligible(sql)
            bus_path = None
            exported_rows = None
            if use_server_cursor:
                import uuid as _uuid
                cname = 'sm_cur_' + _uuid.uuid4().hex[:12]
                cur = c.cursor(name=cname)
                cur.itersize = 500
                try:
                    cur.execute(sql)
                    preview_raw = []
                    export_raw = []
                    collect_export = bool(export_bus and tables_dir and os.path.isdir(tables_dir))
                    has_more = False
                    seen = 0
                    while True:
                        batch = cur.fetchmany(500)
                        if not batch:
                            break
                        for r in batch:
                            if seen >= offset and len(preview_raw) < max_rows:
                                preview_raw.append(r)
                            elif seen >= offset + max_rows:
                                has_more = True
                            if collect_export and len(export_raw) < export_max_rows:
                                export_raw.append(r)
                            seen += 1
                            if has_more and (not collect_export or len(export_raw) >= export_max_rows):
                                break
                        if has_more and (not collect_export or len(export_raw) >= export_max_rows):
                            break
                    desc = cur.description
                    cur.close()
                    cols = _pg_resolve_col_types(c, desc)
                    rows = [[_to_json_val(v) for v in r] for r in preview_raw]
                    if collect_export and cols:
                        bus_path = _write_bus_file(tables_dir, export_bus, cols, export_raw)
                        if bus_path:
                            exported_rows = len(export_raw)
                    return {
                        'ok': True,
                        'columns': cols,
                        'rows': rows,
                        'totalRows': None if has_more else (offset + len(rows)),
                        'truncated': has_more,
                        'engine': engine,
                        'message': None,
                        'error': None,
                        'busTablePath': bus_path,
                        'page': page,
                        'pageSize': max_rows,
                        'hasMore': has_more,
                        'readOnly': read_only,
                        'exportedRows': exported_rows,
                    }
                except Exception:
                    try:
                        cur.close()
                    except Exception:
                        pass
                    try:
                        c.rollback()
                    except Exception:
                        pass

            cur = c.cursor()
            cur.execute(sql)
            desc = cur.description
            if not desc:
                if not read_only:
                    c.commit()
                rc = cur.rowcount if cur.rowcount is not None and cur.rowcount >= 0 else None
                cur.close()
                return {
                    'ok': True,
                    'columns': [],
                    'rows': [],
                    'totalRows': rc,
                    'truncated': False,
                    'engine': engine,
                    'message': f'执行成功，影响 {rc} 行。' if rc is not None else 'SQL 执行成功。',
                    'error': None,
                    'busTablePath': None,
                    'page': page,
                    'pageSize': max_rows,
                    'hasMore': False,
                    'readOnly': read_only,
                }
            cols = _pg_resolve_col_types(c, desc)
            collect_export = bool(export_bus and tables_dir and os.path.isdir(tables_dir))
            fetch_cap = export_max_rows if collect_export else (offset + max_rows + 1)
            fetched_all = cur.fetchmany(fetch_cap)
            has_more = len(fetched_all) > (offset + max_rows)
            preview_slice = fetched_all[offset:offset + max_rows]
            rows = [[_to_json_val(v) for v in r] for r in preview_slice]
            if collect_export and cols:
                bus_path = _write_bus_file(tables_dir, export_bus, cols, fetched_all)
                if bus_path:
                    exported_rows = len(fetched_all)
            cur.close()
            return {
                'ok': True,
                'columns': cols,
                'rows': rows,
                'totalRows': None if has_more else (offset + len(rows)),
                'truncated': has_more,
                'engine': engine,
                'message': None,
                'error': None,
                'busTablePath': bus_path,
                'page': page,
                'pageSize': max_rows,
                'hasMore': has_more,
                'readOnly': read_only,
                'exportedRows': exported_rows,
            }
        finally:
            c.close()

    if db_type == 'mysql':
        c, engine = _open_mysql(conn_cfg, read_only=read_only, timeout_sec=timeout_sec)
        try:
            cur = c.cursor()
            cur.execute(sql)
            desc = cur.description
            if not desc:
                if not read_only:
                    c.commit()
                rc = cur.rowcount if cur.rowcount is not None and cur.rowcount >= 0 else None
                cur.close()
                return {
                    'ok': True,
                    'columns': [],
                    'rows': [],
                    'totalRows': rc,
                    'truncated': False,
                    'engine': engine,
                    'message': f'执行成功，影响 {rc} 行。' if rc is not None else 'SQL 执行成功。',
                    'error': None,
                    'busTablePath': None,
                    'page': page,
                    'pageSize': max_rows,
                    'hasMore': False,
                    'readOnly': read_only,
                }
            cols = [{'name': str(d[0]), 'dataType': str(d[1]) if len(d) > 1 and d[1] else 'ANY'} for d in desc]
            collect_export = bool(export_bus and tables_dir and os.path.isdir(tables_dir))
            fetch_cap = export_max_rows if collect_export else (offset + max_rows + 1)
            fetched_all = cur.fetchmany(fetch_cap)
            has_more = len(fetched_all) > (offset + max_rows)
            preview_slice = fetched_all[offset:offset + max_rows]
            rows = [[_to_json_val(v) for v in r] for r in preview_slice]
            bus_path = None
            exported_rows = None
            if collect_export and cols:
                bus_path = _write_bus_file(tables_dir, export_bus, cols, fetched_all)
                if bus_path:
                    exported_rows = len(fetched_all)
            cur.close()
            return {
                'ok': True,
                'columns': cols,
                'rows': rows,
                'totalRows': None if has_more else (offset + len(rows)),
                'truncated': has_more,
                'engine': engine,
                'message': None,
                'error': None,
                'busTablePath': bus_path,
                'page': page,
                'pageSize': max_rows,
                'hasMore': has_more,
                'readOnly': read_only,
                'exportedRows': exported_rows,
            }
        finally:
            c.close()

    return {'ok': False, 'columns': [], 'rows': [], 'totalRows': None, 'truncated': False, 'engine': 'Unknown', 'message': None, 'error': f'不支持的数据库类型：{db_type}', 'busTablePath': None}

def main():
    raw = sys.stdin.read()
    req = json.loads(raw)
    op = req.get('op')
    try:
        if op == 'inspect_file':
            out = _inspect_file(req)
        elif op == 'test_db':
            out = _test_db(req)
        elif op == 'list_pg_databases':
            out = _list_pg_databases(req)
        elif op == 'profile_table':
            out = _profile_table(req)
        elif op == 'create_pg_database':
            out = _create_pg_database(req)
        elif op == 'query_sql':
            out = _query_sql(req)
        else:
            out = {'ok': False, 'error': f'Unknown op: {op}'}
    except Exception as exc:
        out = {'ok': False, 'error': str(exc), 'message': str(exc)}
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    sys.stdout.flush()

if __name__ == '__main__':
    main()
"#;

fn ensure_data_engine_script() -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(EMBEDDED_DATA_ENGINE_PY.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    let short_hash = &digest[..12];
    let dir = std::env::temp_dir().join("seamind_datalab_bus").join("scripts");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("创建数据引擎脚本目录失败：{e}"))?;
    let path = dir.join(format!("seamind_data_engine_{short_hash}.py"));
    if !path.is_file()
        || std::fs::metadata(&path)
            .map(|m| m.len() != EMBEDDED_DATA_ENGINE_PY.len() as u64)
            .unwrap_or(true)
    {
        let tmp = dir.join(format!(
            "seamind_data_engine_{short_hash}_{}.tmp",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&tmp, EMBEDDED_DATA_ENGINE_PY.as_bytes())
            .map_err(|e| format!("写入 Python 数据引擎脚本失败：{e}"))?;
        if std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::write(&path, EMBEDDED_DATA_ENGINE_PY.as_bytes());
            let _ = std::fs::remove_file(&tmp);
        }
    }
    Ok(path)
}

async fn run_python_data_helper(
    python_path: &str,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    run_python_data_helper_with_options(python_path, payload, None, SQL_TIMEOUT_SECS).await
}

async fn run_python_data_helper_with_options(
    python_path: &str,
    payload: serde_json::Value,
    query_id: Option<&str>,
    timeout_secs: u64,
) -> Result<serde_json::Value, String> {
    let exe_path = python_lab::resolve_python_executable(python_path).ok_or_else(|| {
        format!("无法在路径 ({python_path}) 中找到 python 可执行文件。")
    })?;
    let exe_display = exe_path.to_string_lossy().to_string();
    let script_path = ensure_data_engine_script()?;
    let mut cmd = Command::new(&exe_path);
    // Execute from a cached .py file to avoid Windows' 32KB CreateProcess command-line limit (os error 206).
    cmd.args(["-X", "utf8", "-u"]).arg(&script_path);
    python_lab::apply_python_env_activation(&mut cmd, &exe_path);
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 Python 数据引擎 ({exe_display}) 失败：{e}"))?;

    let tracked_qid = query_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    if let (Some(ref qid), Some(pid)) = (&tracked_qid, child.id()) {
        if let Ok(mut map) = active_sql_pids().lock() {
            map.insert(qid.clone(), pid);
        }
    }

    if let Some(mut stdin) = child.stdin.take() {
        let input = serde_json::to_vec(&payload).map_err(|e| format!("序列化请求失败：{e}"))?;
        let _ = stdin.write_all(&input).await;
        let _ = stdin.shutdown().await;
    }

    let eff_timeout = timeout_secs.clamp(5, 620);
    let wait_res = tokio::time::timeout(
        std::time::Duration::from_secs(eff_timeout),
        child.wait_with_output(),
    )
    .await;

    let was_cancelled = if let Some(ref qid) = tracked_qid {
        if let Ok(mut map) = active_sql_pids().lock() {
            map.remove(qid);
        }
        cancelled_sql_ids()
            .lock()
            .map(|mut set| set.remove(qid))
            .unwrap_or(false)
    } else {
        false
    };

    if was_cancelled {
        return Ok(serde_json::json!({
            "ok": false,
            "error": "SQL 查询已手动取消。"
        }));
    }

    let output = match wait_res {
        Ok(res) => res.map_err(|e| format!("等待 Python 数据引擎失败：{e}"))?,
        Err(_) => {
            return Err(format!("数据引擎执行超过 {eff_timeout} 秒超时。"));
        }
    };

    let stdout_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr_str = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if stdout_str.is_empty() {
        return Err(if stderr_str.is_empty() {
            "Python 数据引擎未返回结果。".to_string()
        } else {
            format!("Python 数据引擎报错：{stderr_str}")
        });
    }

    serde_json::from_str::<serde_json::Value>(&stdout_str)
        .map_err(|e| format!("解析数据引擎响应失败：{e} ({stdout_str})"))
}

#[tauri::command]
pub async fn data_lab_inspect_file(
    path: String,
    python_path: Option<String>,
    max_rows: Option<usize>,
) -> Result<DataFileInspection, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("文件路径不能为空。".to_string());
    }
    let file_path = PathBuf::from(trimmed);
    if !file_path.is_file() {
        return Err(format!("找不到数据文件：{}", file_path.display()));
    }
    let meta = std::fs::metadata(&file_path).map_err(|e| format!("读取文件信息失败：{e}"))?;
    let size_bytes = meta.len();
    let format = detect_file_format(&file_path);
    let limit = max_rows.unwrap_or(20).clamp(1, 200);

    if format == "csv" || format == "tsv" {
        return inspect_delimited_native(&file_path, &format, size_bytes, limit);
    }
    if format == "json" || format == "jsonl" {
        return inspect_json_native(&file_path, &format, size_bytes, limit);
    }
    if format == "sqlite" {
        let test = inspect_sqlite_schema(&file_path)?;
        let cols: Vec<DataColumnInfo> = test
            .tables
            .iter()
            .map(|t| DataColumnInfo {
                name: t.name.clone(),
                data_type: format!("{} ({} cols)", t.table_type, t.columns.len()),
                ..Default::default()
            })
            .collect();
        return Ok(DataFileInspection {
            path: file_path.to_string_lossy().to_string(),
            file_name: file_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("sqlite.db")
                .to_string(),
            format,
            size_bytes,
            row_count: Some(test.tables.len() as u64),
            columns: cols,
            preview_rows: vec![],
            engine: test.engine,
        });
    }

    // Parquet / Excel / DuckDB via Python data engine (prefer env with duckdb or pyarrow/pandas)
    let Some((py_exe, _)) = pick_best_python(python_path.as_deref(), true) else {
        return Err(format!(
            "解析 {} 文件需要本地 Python/Anaconda 环境（建议安装 duckdb 或 pyarrow）。",
            format.to_uppercase()
        ));
    };

    let resp = run_python_data_helper(
        &py_exe,
        serde_json::json!({
            "op": "inspect_file",
            "path": trimmed,
            "format": format,
            "maxRows": limit,
        }),
    )
    .await?;

    if resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        let insp_val = resp
            .get("inspection")
            .cloned()
            .ok_or_else(|| "数据引擎缺少 inspection 字段。".to_string())?;
        serde_json::from_value(insp_val).map_err(|e| format!("解析文件元信息失败：{e}"))
    } else {
        Err(resp
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("文件解析失败。")
            .to_string())
    }
}

#[tauri::command]
pub async fn data_lab_test_connection(
    connection: DataDbConnectionInput,
) -> Result<DataDbTestResult, String> {
    let db_type = connection.db_type.trim().to_lowercase();
    if db_type == "sqlite" {
        let path_str = connection
            .file_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "请指定 SQLite 数据库文件路径。".to_string())?;
        return inspect_sqlite_schema(Path::new(path_str));
    }

    let want_duckdb = db_type == "duckdb";
    let Some((py_exe, _)) = pick_best_python(connection.python_path.as_deref(), want_duckdb) else {
        return Err(
            "未检测到可用的本地 Python / Anaconda 环境。请在「环境」面板选择或添加一个 Anaconda 环境。"
                .to_string(),
        );
    };

    let mut conn_payload = connection.clone();
    conn_payload.password = resolve_db_password(&connection);

    let resp = run_python_data_helper(
        &py_exe,
        serde_json::json!({
            "op": "test_db",
            "connection": conn_payload,
        }),
    )
    .await?;

    let ok = resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let message = resp
        .get("message")
        .or_else(|| resp.get("error"))
        .and_then(|v| v.as_str())
        .unwrap_or(if ok { "连接成功。" } else { "连接失败。" })
        .to_string();
    let engine = resp
        .get("engine")
        .and_then(|v| v.as_str())
        .unwrap_or("Python DB")
        .to_string();
    let tables: Vec<DataDbTableSchema> = resp
        .get("tables")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let custom_types: Vec<DataDbCustomType> = resp
        .get("customTypes")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    Ok(DataDbTestResult {
        ok,
        message,
        tables,
        custom_types,
        engine,
    })
}

#[tauri::command]
pub async fn data_lab_create_postgres_database(
    connection: DataDbConnectionInput,
    database_name: String,
) -> Result<String, String> {
    if !connection.db_type.eq_ignore_ascii_case("postgres") {
        return Err("仅支持创建 PostgreSQL 数据库。".to_string());
    }
    let name = database_name.trim();
    if !valid_postgres_database_name(name) {
        return Err("数据库名必须以字母或下划线开头，且只包含字母、数字、下划线，最长 63 字符。".to_string());
    }
    let Some((py_exe, _)) = pick_best_python(connection.python_path.as_deref(), false) else {
        return Err("未检测到可用的本地 Python / Anaconda 环境。".to_string());
    };
    let mut conn_payload = connection.clone();
    conn_payload.password = resolve_db_password(&connection);
    let resp = run_python_data_helper(
        &py_exe,
        serde_json::json!({
            "op": "create_pg_database",
            "connection": conn_payload,
            "databaseName": name,
        }),
    )
    .await?;
    let message = resp
        .get("message")
        .or_else(|| resp.get("error"))
        .and_then(|value| value.as_str())
        .unwrap_or("创建 PostgreSQL 数据库失败。")
        .to_string();
    if resp.get("ok").and_then(|value| value.as_bool()) == Some(true) {
        Ok(message)
    } else {
        Err(message)
    }
}

fn valid_postgres_database_name(name: &str) -> bool {
    name.len() <= 63
        && !name.is_empty()
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[cfg(test)]
mod postgres_database_name_tests {
    use super::valid_postgres_database_name;

    #[test]
    fn accepts_identifiers_and_rejects_sql_fragments() {
        assert!(valid_postgres_database_name("research_2026"));
        assert!(!valid_postgres_database_name(""));
        assert!(!valid_postgres_database_name("2026_research"));
        assert!(!valid_postgres_database_name("research\"; DROP DATABASE postgres; --"));
        assert!(!valid_postgres_database_name(&"a".repeat(64)));
    }
}

#[tauri::command]
pub fn data_lab_check_pgpass(
    host: String,
    port: Option<u16>,
    database: Option<String>,
    username: Option<String>,
) -> Result<DataDbPgpassMatch, String> {
    let h = if host.trim().is_empty() {
        "127.0.0.1"
    } else {
        host.trim()
    };
    let p = port.unwrap_or(5432);
    let d = database
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("postgres");
    let u = username
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("postgres");
    Ok(data_lab_bridge::check_pgpass_match(h, p, d, u))
}

#[tauri::command]
pub async fn data_lab_list_databases(
    connection: DataDbConnectionInput,
) -> Result<Vec<DataDbDatabaseEntry>, String> {
    if !connection.db_type.eq_ignore_ascii_case("postgres") {
        return Err("目前仅 PostgreSQL 支持拉取实例下的数据库列表。".to_string());
    }
    let Some((py_exe, _)) = pick_best_python(connection.python_path.as_deref(), false) else {
        return Err("未检测到可用的本地 Python / Anaconda 环境。".to_string());
    };
    let mut conn_payload = connection.clone();
    conn_payload.password = resolve_db_password(&connection);
    let resp = run_python_data_helper(
        &py_exe,
        serde_json::json!({
            "op": "list_pg_databases",
            "connection": conn_payload,
        }),
    )
    .await?;
    if resp.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        let list: Vec<DataDbDatabaseEntry> = resp
            .get("databases")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        Ok(list)
    } else {
        Err(resp
            .get("error")
            .or_else(|| resp.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or("读取 PostgreSQL 数据库列表失败。")
            .to_string())
    }
}

#[tauri::command]
pub async fn data_lab_inspect_table_detail(
    connection: DataDbConnectionInput,
    schema: Option<String>,
    table_name: String,
) -> Result<DataDbTableSchema, String> {
    let profile = data_lab_profile_table(connection, schema, table_name.clone(), Some(0)).await?;
    if !profile.ok {
        return Err(profile
            .error
            .unwrap_or_else(|| format!("读取表 {table_name} 结构失败。")));
    }
    Ok(DataDbTableSchema {
        name: profile.table_name,
        schema: profile.schema,
        table_type: profile.table_type,
        row_count: profile
            .estimated_rows
            .and_then(|v| u64::try_from(v).ok()),
        estimated_rows: profile.estimated_rows,
        total_bytes: profile.total_bytes,
        comment: profile.comment,
        primary_keys: profile.primary_keys,
        foreign_keys: profile.foreign_keys,
        indexes: profile.indexes,
        columns: profile
            .columns
            .into_iter()
            .map(|c| DataColumnInfo {
                name: c.name,
                data_type: c.data_type,
                nullable: c.nullable,
                is_primary_key: Some(c.is_primary_key),
                comment: c.comment,
                ..Default::default()
            })
            .collect(),
    })
}

#[tauri::command]
pub async fn data_lab_profile_table(
    connection: DataDbConnectionInput,
    schema: Option<String>,
    table_name: String,
    sample_rows: Option<usize>,
) -> Result<DataDbTableProfile, String> {
    let start = std::time::Instant::now();
    let db_type = connection.db_type.trim().to_lowercase();
    let sample_cap = sample_rows.unwrap_or(5).min(20);

    if db_type == "sqlite" {
        let path_str = connection
            .file_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "请指定 SQLite 数据库文件路径。".to_string())?;
        let test = inspect_sqlite_schema(Path::new(path_str))?;
        let Some(tbl) = test
            .tables
            .into_iter()
            .find(|t| t.name.eq_ignore_ascii_case(table_name.trim()))
        else {
            return Err(format!("在 SQLite 中未找到表 {}", table_name.trim()));
        };
        let mut sample_columns = Vec::new();
        let mut sample_rows_out = Vec::new();
        if sample_cap > 0 {
            if let Ok(db) = Connection::open_with_flags(path_str, OpenFlags::SQLITE_OPEN_READ_ONLY)
            {
                let res = execute_sqlite_on_conn(
                    &db,
                    &format!("SELECT * FROM {} LIMIT {}", quote_sql_ident(&tbl.name), sample_cap),
                    sample_cap,
                    1,
                    true,
                    "SQLite (Rust Native)",
                    start,
                    None,
                );
                if res.ok {
                    sample_columns = res.columns;
                    sample_rows_out = res.rows;
                }
            }
        }
        return Ok(DataDbTableProfile {
            ok: true,
            schema: tbl.schema,
            table_name: tbl.name,
            table_type: tbl.table_type,
            estimated_rows: tbl.estimated_rows,
            total_bytes: None,
            comment: None,
            primary_keys: tbl.primary_keys,
            foreign_keys: tbl.foreign_keys,
            indexes: tbl.indexes,
            columns: tbl
                .columns
                .into_iter()
                .map(|c| DataDbColumnProfile {
                    name: c.name,
                    data_type: c.data_type,
                    nullable: c.nullable,
                    is_primary_key: c.is_primary_key.unwrap_or(false),
                    comment: c.comment,
                    ..Default::default()
                })
                .collect(),
            sample_columns,
            sample_rows: sample_rows_out,
            engine: test.engine,
            duration_ms: start.elapsed().as_millis() as u64,
            error: None,
        });
    }

    let want_duckdb = db_type == "duckdb";
    let Some((py_exe, _)) = pick_best_python(connection.python_path.as_deref(), want_duckdb) else {
        return Err("未检测到可用的本地 Python / Anaconda 环境。".to_string());
    };
    let mut conn_payload = connection.clone();
    conn_payload.password = resolve_db_password(&connection);

    let resp = run_python_data_helper(
        &py_exe,
        serde_json::json!({
            "op": "profile_table",
            "connection": conn_payload,
            "schema": schema,
            "tableName": table_name,
            "sampleRows": sample_cap,
        }),
    )
    .await?;

    let mut profile: DataDbTableProfile = serde_json::from_value(resp).map_err(|e| {
        format!("解析数据表剖析结果失败：{e}")
    })?;
    profile.duration_ms = start.elapsed().as_millis() as u64;
    Ok(profile)
}

#[tauri::command]
pub fn data_lab_cancel_sql(query_id: String) -> Result<bool, String> {
    let qid = query_id.trim();
    if qid.is_empty() {
        return Ok(false);
    }
    if let Ok(mut set) = cancelled_sql_ids().lock() {
        set.insert(qid.to_string());
    }
    let pid = active_sql_pids()
        .lock()
        .ok()
        .and_then(|mut map| map.remove(qid));
    if let Some(pid_val) = pid {
        kill_sql_pid(pid_val);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn data_lab_query_sql(
    sql: String,
    connection: Option<DataDbConnectionInput>,
    mounted_files: Option<Vec<DataMountedFileRef>>,
    python_path: Option<String>,
    max_rows: Option<usize>,
    export_bus_table: Option<String>,
    session_id: Option<String>,
    page: Option<u32>,
    read_only: Option<bool>,
    query_id: Option<String>,
    export_max_rows: Option<usize>,
    attach_connections: Option<Vec<DataDbConnectionInput>>,
    statement_timeout_sec: Option<u32>,
) -> Result<DataTableResult, String> {
    let start = std::time::Instant::now();
    let limit = max_rows.unwrap_or(DEFAULT_MAX_ROWS).clamp(1, MAX_ALLOWED_ROWS);
    let page_num = page.unwrap_or(1).max(1);
    let effective_read_only = read_only
        .or_else(|| connection.as_ref().and_then(|c| c.read_only))
        .unwrap_or(true);
    let export_cap = export_max_rows.unwrap_or(200_000).clamp(limit, 1_000_000);
    let timeout_sec = statement_timeout_sec
        .or_else(|| connection.as_ref().and_then(|c| c.statement_timeout_sec))
        .unwrap_or(30)
        .clamp(1, 600);
    let mut files = mounted_files.unwrap_or_default();
    let bus_dirs = ensure_session_bus_dirs(session_id.as_deref()).ok();
    let tables_dir_path = bus_dirs.as_ref().map(|(_, _, t, _)| t.clone());
    let export_alias = export_bus_table
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    // Auto-register existing shared bus tables alongside mounted files so SQL can query Python/R outputs directly
    if let Some(ref tdir) = tables_dir_path {
        for entry in scan_bus_dir(tdir, &["parquet", "csv"]) {
            if !files
                .iter()
                .any(|f| f.alias.eq_ignore_ascii_case(&entry.name))
            {
                files.push(DataMountedFileRef {
                    alias: entry.name,
                    path: entry.path,
                    format: entry.format,
                });
            }
        }
    }

    // 1. SQLite direct connection (zero dependency, instant native Rust)
    if let Some(conn) = &connection {
        if conn.db_type.eq_ignore_ascii_case("sqlite") {
            let fpath = conn
                .file_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "请先指定 SQLite 文件路径。".to_string())?;
            let db = if effective_read_only {
                Connection::open_with_flags(fpath, OpenFlags::SQLITE_OPEN_READ_ONLY)
            } else {
                Connection::open(fpath)
            }
            .map_err(|e| format!("打开 SQLite 文件失败：{e}"))?;
            let export_pair = match (&tables_dir_path, &export_alias) {
                (Some(dir), Some(alias)) => Some((dir.as_path(), alias.as_str(), export_cap)),
                _ => None,
            };
            return Ok(execute_sqlite_on_conn(
                &db,
                &sql,
                limit,
                page_num,
                effective_read_only,
                "SQLite (Rust Native)",
                start,
                export_pair,
            ));
        }
    }

    // 2. Local files mode (no DB connection) or DuckDB connection (with optional federated Postgres ATTACH!)
    let is_local_or_duck = connection
        .as_ref()
        .map(|c| c.db_type.eq_ignore_ascii_case("duckdb"))
        .unwrap_or(true);

    if is_local_or_duck {
        let preferred_py = connection
            .as_ref()
            .and_then(|c| c.python_path.as_deref())
            .or(python_path.as_deref());

        let resolved_attaches: Vec<DataDbConnectionInput> = attach_connections
            .unwrap_or_default()
            .into_iter()
            .map(|mut ac| {
                ac.password = resolve_db_password(&ac);
                ac
            })
            .collect();

        if let Some((py_exe, has_duckdb)) = pick_best_python(preferred_py, true) {
            if has_duckdb {
                let resp = run_python_data_helper_with_options(
                    &py_exe,
                    serde_json::json!({
                        "op": "query_sql",
                        "sql": sql,
                        "connection": connection,
                        "mountedFiles": files,
                        "attachConnections": resolved_attaches,
                        "maxRows": limit,
                        "page": page_num,
                        "readOnly": effective_read_only,
                        "exportBusTable": export_alias,
                        "exportMaxRows": export_cap,
                        "statementTimeoutSec": timeout_sec,
                        "tablesDir": tables_dir_path.as_ref().map(|p| p.to_string_lossy().to_string()),
                    }),
                    query_id.as_deref(),
                    (timeout_sec as u64) + 15,
                )
                .await?;
                return Ok(parse_python_table_result(resp, "DuckDB", start));
            }
        }

        // If connection is explicitly DuckDB, we need DuckDB installed
        if let Some(conn) = &connection {
            if conn.db_type.eq_ignore_ascii_case("duckdb") {
                return Ok(DataTableResult {
                    ok: false,
                    engine: "DuckDB".to_string(),
                    duration_ms: start.elapsed().as_millis() as u64,
                    error: Some(
                        "未在已检测的 Anaconda / Python 环境中找到 duckdb 包。请在终端执行：pip install duckdb"
                            .to_string(),
                    ),
                    ..Default::default()
                });
            }
        }

        // Zero-install fallback for local CSV / TSV / JSON / JSONL files via Rust in-memory SQLite!
        let has_parquet = files
            .iter()
            .any(|f| f.format.eq_ignore_ascii_case("parquet"))
            || sql.to_lowercase().contains(".parquet");
        if has_parquet {
            return Ok(DataTableResult {
                ok: false,
                engine: "DuckDB Required".to_string(),
                duration_ms: start.elapsed().as_millis() as u64,
                error: Some(
                    "直接对 Parquet 文件执行 SQL 需要 DuckDB 引擎。请在当前 Anaconda 环境中安装：pip install duckdb"
                        .to_string(),
                ),
                ..Default::default()
            });
        }

        let mem_conn = load_mounted_files_into_memory_sqlite(&files)?;
        let export_pair = match (&tables_dir_path, &export_alias) {
            (Some(dir), Some(alias)) => Some((dir.as_path(), alias.as_str(), export_cap)),
            _ => None,
        };
        return Ok(execute_sqlite_on_conn(
            &mem_conn,
            &sql,
            limit,
            page_num,
            false,
            "SQLite In-Memory (CSV/JSON)",
            start,
            export_pair,
        ));
    }

    // 3. PostgreSQL / MySQL via Python DB driver
    let conn = connection.expect("connection is Some for pg/mysql");
    let preferred_py = conn.python_path.as_deref().or(python_path.as_deref());
    let Some((py_exe, _)) = pick_best_python(preferred_py, false) else {
        return Ok(DataTableResult {
            ok: false,
            engine: conn.db_type.to_uppercase(),
            duration_ms: start.elapsed().as_millis() as u64,
            error: Some("未检测到本地 Python / Anaconda 环境，无法连接远程数据库。".to_string()),
            ..Default::default()
        });
    };

    let mut conn_payload = conn.clone();
    conn_payload.password = resolve_db_password(&conn);

    let resp = run_python_data_helper_with_options(
        &py_exe,
        serde_json::json!({
            "op": "query_sql",
            "sql": sql,
            "connection": conn_payload,
            "mountedFiles": [],
            "maxRows": limit,
            "page": page_num,
            "readOnly": effective_read_only,
            "exportBusTable": export_alias,
            "exportMaxRows": export_cap,
            "statementTimeoutSec": timeout_sec,
            "tablesDir": tables_dir_path.as_ref().map(|p| p.to_string_lossy().to_string()),
        }),
        query_id.as_deref(),
        (timeout_sec as u64) + 15,
    )
    .await?;

    Ok(parse_python_table_result(
        resp,
        &conn.db_type.to_uppercase(),
        start,
    ))
}

fn parse_python_table_result(
    resp: serde_json::Value,
    fallback_engine: &str,
    start: std::time::Instant,
) -> DataTableResult {
    let ok = resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let columns: Vec<DataColumnInfo> = resp
        .get("columns")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let rows: Vec<Vec<serde_json::Value>> = resp
        .get("rows")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let total_rows = resp.get("totalRows").and_then(|v| v.as_u64());
    let truncated = resp
        .get("truncated")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let engine = resp
        .get("engine")
        .and_then(|v| v.as_str())
        .unwrap_or(fallback_engine)
        .to_string();
    let message = resp
        .get("message")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let error = resp
        .get("error")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let bus_table_path = resp
        .get("busTablePath")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let page = resp
        .get("page")
        .and_then(|v| v.as_u64())
        .and_then(|v| u32::try_from(v).ok());
    let page_size = resp
        .get("pageSize")
        .and_then(|v| v.as_u64())
        .and_then(|v| u32::try_from(v).ok());
    let has_more = resp.get("hasMore").and_then(|v| v.as_bool());
    let read_only = resp.get("readOnly").and_then(|v| v.as_bool());
    let exported_rows = resp.get("exportedRows").and_then(|v| v.as_u64());

    DataTableResult {
        ok,
        columns,
        rows,
        total_rows,
        truncated,
        engine,
        duration_ms: start.elapsed().as_millis() as u64,
        message,
        error,
        bus_table_path,
        page,
        page_size,
        has_more,
        read_only,
        exported_rows,
    }
}

const MAX_ER_EXPORT_BYTES: usize = 128 * 1024 * 1024;
const ALLOWED_ER_EXPORT_EXTS: &[&str] = &["png", "pdf", "svg", "sql", "dbml", "mmd", "md", "json"];

fn validate_er_export_path(path: &Path) -> Result<(), String> {
    let trimmed = path.to_string_lossy().trim().to_string();
    if trimmed.is_empty() {
        return Err("请选择有效的导出保存路径。".to_string());
    }
    let ext = path
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !ALLOWED_ER_EXPORT_EXTS.contains(&ext.as_str()) {
        return Err(format!(
            "不支持的 ER 导出文件扩展名：.{}（允许：png/pdf/svg/sql/dbml/mmd/md/json）",
            ext
        ));
    }
    Ok(())
}

pub fn write_er_export_bytes_sync(path: &Path, bytes: &[u8]) -> Result<usize, String> {
    validate_er_export_path(path)?;
    if bytes.is_empty() {
        return Err("导出文件内容为空。".to_string());
    }
    if bytes.len() > MAX_ER_EXPORT_BYTES {
        return Err("导出文件超过 128 MB 安全上限。".to_string());
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建导出目录：{error}"))?;
        }
    }

    let tmp_name = format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("er-export"),
        uuid::Uuid::new_v4()
    );
    let tmp_path = path.with_file_name(tmp_name);
    std::fs::write(&tmp_path, bytes)
        .map_err(|error| format!("写入临时导出文件失败：{error}"))?;
    if let Err(error) = std::fs::rename(&tmp_path, path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("保存导出文件失败：{error}"));
    }
    Ok(bytes.len())
}

#[tauri::command]
pub async fn data_lab_write_er_export(
    file_path: String,
    data_base64: String,
) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        use base64::Engine as _;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(data_base64.trim())
            .map_err(|error| format!("导出数据 Base64 解码失败：{error}"))?;
        write_er_export_bytes_sync(Path::new(&file_path), &decoded)
    })
    .await
    .map_err(|error| format!("执行文件保存任务失败：{error}"))?
}

#[tauri::command]
pub fn data_lab_open_er_export(
    file_path: String,
    reveal_in_folder: Option<bool>,
) -> Result<(), String> {
    let path = Path::new(&file_path);
    validate_er_export_path(path)?;
    if !path.is_file() {
        return Err("找不到已导出的文件。".to_string());
    }
    let canonical =
        std::fs::canonicalize(path).map_err(|error| format!("无法定位导出文件：{error}"))?;
    let reveal = reveal_in_folder.unwrap_or(false);

    #[cfg(target_os = "windows")]
    {
        let target = canonical.to_string_lossy();
        let clean = target.strip_prefix(r"\\?\").unwrap_or(&target);
        if reveal {
            std::process::Command::new("explorer")
                .arg(format!("/select,{clean}"))
                .spawn()
                .map_err(|error| format!("无法打开所在文件夹：{error}"))?;
        } else {
            std::process::Command::new("rundll32")
                .args(["url.dll,FileProtocolHandler", clean])
                .spawn()
                .map_err(|error| format!("无法使用系统默认程序打开文件：{error}"))?;
        }
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if reveal {
            cmd.arg("-R");
        }
        cmd.arg(&canonical)
            .spawn()
            .map_err(|error| format!("无法打开导出文件：{error}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target_arg = if reveal {
            canonical.parent().unwrap_or(&canonical)
        } else {
            canonical.as_path()
        };
        std::process::Command::new("xdg-open")
            .arg(target_arg)
            .spawn()
            .map_err(|error| format!("无法打开导出文件：{error}"))?;
        return Ok(());
    }
}

#[cfg(test)]
mod er_export_tests {
    use super::*;

    #[test]
    fn writes_png_and_pdf_exports_atomically_and_rejects_invalid_extensions() {
        let temp_dir =
            std::env::temp_dir().join(format!("seamind_er_export_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let bad = temp_dir.join("evil.exe");
        assert!(write_er_export_bytes_sync(&bad, b"MZ").is_err());

        let png = temp_dir.join("us_market.png");
        let png_bytes = b"\x89PNG\r\n\x1a\nfake";
        assert_eq!(
            write_er_export_bytes_sync(&png, png_bytes).unwrap(),
            png_bytes.len()
        );
        assert_eq!(std::fs::read(&png).unwrap(), png_bytes);

        let pdf = temp_dir.join("us_market.pdf");
        let pdf_bytes = b"%PDF-1.4\n%%EOF\n";
        assert_eq!(
            write_er_export_bytes_sync(&pdf, pdf_bytes).unwrap(),
            pdf_bytes.len()
        );
        assert_eq!(std::fs::read(&pdf).unwrap(), pdf_bytes);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
