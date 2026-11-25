use crate::python_lab;
use rusqlite::{types::ValueRef, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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

fn memory_secrets() -> &'static Mutex<HashMap<String, String>> {
    MEMORY_DB_SECRETS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataColumnInfo {
    pub name: String,
    pub data_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDbTableSchema {
    pub name: String,
    pub schema: Option<String>,
    pub table_type: String,
    pub row_count: Option<u64>,
    pub columns: Vec<DataColumnInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDbTestResult {
    pub ok: bool,
    pub message: String,
    pub tables: Vec<DataDbTableSchema>,
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
    if let Ok(mut map) = memory_secrets().lock() {
        if password.is_empty() {
            map.remove(id);
        } else {
            map.insert(id.to_string(), password.clone());
        }
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

fn resolve_db_password(conn: &DataDbConnectionInput) -> Option<String> {
    if let Some(pwd) = conn.password.as_deref() {
        if !pwd.is_empty() {
            return Some(pwd.to_string());
        }
    }
    let id = conn.id.trim();
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
        if let Ok(mut col_stmt) = conn.prepare(&format!("PRAGMA table_info({quoted})")) {
            if let Ok(rows) = col_stmt.query_map([], |row| {
                let col_name: String = row.get(1)?;
                let col_type: String = row.get::<_, Option<String>>(2)?.unwrap_or_default();
                Ok(DataColumnInfo {
                    name: col_name,
                    data_type: if col_type.trim().is_empty() {
                        "ANY".to_string()
                    } else {
                        col_type
                    },
                })
            }) {
                columns = rows.filter_map(Result::ok).collect();
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
            columns,
        });
    }

    Ok(DataDbTestResult {
        ok: true,
        message: format!("已连接 SQLite，共发现 {} 张表/视图。", tables.len()),
        tables,
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
    engine_label: &str,
    start: std::time::Instant,
    export_target: Option<(&Path, &str)>,
) -> DataTableResult {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    if trimmed.is_empty() {
        return DataTableResult {
            ok: false,
            columns: vec![],
            rows: vec![],
            total_rows: None,
            truncated: false,
            engine: engine_label.to_string(),
            duration_ms: start.elapsed().as_millis() as u64,
            message: None,
            error: Some("SQL 语句为空。".to_string()),
            bus_table_path: None,
        };
    }

    match conn.prepare(trimmed) {
        Ok(mut stmt) => {
            let col_count = stmt.column_count();
            if col_count == 0 {
                match stmt.execute([]) {
                    Ok(affected) => DataTableResult {
                        ok: true,
                        columns: vec![],
                        rows: vec![],
                        total_rows: Some(affected as u64),
                        truncated: false,
                        engine: engine_label.to_string(),
                        duration_ms: start.elapsed().as_millis() as u64,
                        message: Some(format!("执行成功，影响 {affected} 行。")),
                        error: None,
                        bus_table_path: None,
                    },
                    Err(e) => DataTableResult {
                        ok: false,
                        columns: vec![],
                        rows: vec![],
                        total_rows: None,
                        truncated: false,
                        engine: engine_label.to_string(),
                        duration_ms: start.elapsed().as_millis() as u64,
                        message: None,
                        error: Some(format!("SQL 执行失败：{e}")),
                        bus_table_path: None,
                    },
                }
            } else {
                let mut columns: Vec<DataColumnInfo> = (0..col_count)
                    .map(|i| DataColumnInfo {
                        name: stmt.column_name(i).unwrap_or("col").to_string(),
                        data_type: "ANY".to_string(),
                    })
                    .collect();

                let mut rows_out = Vec::new();
                let mut export_rows: Vec<Vec<serde_json::Value>> = Vec::new();
                let collect_for_export = export_target.is_some();
                let export_cap = 50_000usize;
                let mut truncated = false;
                match stmt.query([]) {
                    Ok(mut qrows) => loop {
                        match qrows.next() {
                            Ok(Some(row)) => {
                                let mut vals = Vec::with_capacity(col_count);
                                for i in 0..col_count {
                                    let v = row
                                        .get_ref(i)
                                        .map(sqlite_val_to_json)
                                        .unwrap_or(serde_json::Value::Null);
                                    vals.push(v);
                                }
                                if rows_out.len() < max_rows {
                                    if collect_for_export {
                                        export_rows.push(vals.clone());
                                    }
                                    rows_out.push(vals);
                                } else {
                                    truncated = true;
                                    if collect_for_export && export_rows.len() < export_cap {
                                        export_rows.push(vals);
                                    } else {
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
                                    total_rows: None,
                                    truncated,
                                    engine: engine_label.to_string(),
                                    duration_ms: start.elapsed().as_millis() as u64,
                                    message: None,
                                    error: Some(format!("读取结果行失败：{e}")),
                                    bus_table_path: None,
                                };
                            }
                        }
                    },
                    Err(e) => {
                        return DataTableResult {
                            ok: false,
                            columns: vec![],
                            rows: vec![],
                            total_rows: None,
                            truncated: false,
                            engine: engine_label.to_string(),
                            duration_ms: start.elapsed().as_millis() as u64,
                            message: None,
                            error: Some(format!("SQL 查询失败：{e}")),
                            bus_table_path: None,
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
                    .and_then(|(dir, alias)| write_csv_bus_table(dir, alias, &columns, &export_rows));

                let total = if collect_for_export && export_rows.len() < export_cap {
                    Some(export_rows.len() as u64)
                } else if truncated {
                    None
                } else {
                    Some(rows_out.len() as u64)
                };
                DataTableResult {
                    ok: true,
                    columns,
                    rows: rows_out,
                    total_rows: total,
                    truncated,
                    engine: engine_label.to_string(),
                    duration_ms: start.elapsed().as_millis() as u64,
                    message: None,
                    error: None,
                    bus_table_path,
                }
            }
        }
        Err(first_err) => {
            // Multi-statement script fallback (DDL/DML batch)
            match conn.execute_batch(trimmed) {
                Ok(_) => DataTableResult {
                    ok: true,
                    columns: vec![],
                    rows: vec![],
                    total_rows: None,
                    truncated: false,
                    engine: engine_label.to_string(),
                    duration_ms: start.elapsed().as_millis() as u64,
                    message: Some("SQL 批处理执行成功。".to_string()),
                    error: None,
                    bus_table_path: None,
                },
                Err(_) => DataTableResult {
                    ok: false,
                    columns: vec![],
                    rows: vec![],
                    total_rows: None,
                    truncated: false,
                    engine: engine_label.to_string(),
                    duration_ms: start.elapsed().as_millis() as u64,
                    message: None,
                    error: Some(format!("SQL 语法或执行错误：{first_err}")),
                    bus_table_path: None,
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

def _open_pg(conn_cfg):
    host = conn_cfg.get('host') or '127.0.0.1'
    port = int(conn_cfg.get('port') or 5432)
    database = conn_cfg.get('database') or 'postgres'
    user = conn_cfg.get('username') or 'postgres'
    password = conn_cfg.get('password') or ''
    try:
        import psycopg
        c = psycopg.connect(host=host, port=port, dbname=database, user=user, password=password, connect_timeout=10)
        return c, 'PostgreSQL (psycopg3)'
    except ImportError:
        pass
    try:
        import psycopg2
        c = psycopg2.connect(host=host, port=port, dbname=database, user=user, password=password, connect_timeout=10)
        return c, 'PostgreSQL (psycopg2)'
    except ImportError:
        pass
    raise RuntimeError('未检测到 PostgreSQL 驱动。请在所选 Anaconda 环境中执行：pip install psycopg2-binary (或 pip install psycopg)')

def _open_mysql(conn_cfg):
    host = conn_cfg.get('host') or '127.0.0.1'
    port = int(conn_cfg.get('port') or 3306)
    database = conn_cfg.get('database') or ''
    user = conn_cfg.get('username') or 'root'
    password = conn_cfg.get('password') or ''
    try:
        import pymysql
        c = pymysql.connect(host=host, port=port, database=database or None, user=user, password=password, connect_timeout=10, charset='utf8mb4')
        return c, 'MySQL (PyMySQL)'
    except ImportError:
        pass
    try:
        import mysql.connector
        c = mysql.connector.connect(host=host, port=port, database=database or None, user=user, password=password, connection_timeout=10)
        return c, 'MySQL (mysql-connector)'
    except ImportError:
        pass
    raise RuntimeError('未检测到 MySQL 驱动。请在所选 Anaconda 环境中执行：pip install pymysql (或 pip install mysql-connector-python)')

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
            SELECT table_schema, table_name, column_name, data_type
            FROM information_schema.columns
            WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
            ORDER BY table_schema, table_name, ordinal_position
        """).fetchall()
        con.close()
        col_map = {}
        for sch, tbl, col, dt in col_rows:
            col_map.setdefault((sch, tbl), []).append({'name': str(col), 'dataType': str(dt)})
        tables = []
        for sch, tbl, ttype in rows:
            tables.append({
                'name': str(tbl),
                'schema': str(sch),
                'tableType': str(ttype).lower(),
                'rowCount': None,
                'columns': col_map.get((sch, tbl), []),
            })
        return {'ok': True, 'message': f'已连接 DuckDB，发现 {len(tables)} 张表/视图。', 'tables': tables, 'engine': 'DuckDB'}

    if db_type == 'postgres':
        c, engine = _open_pg(conn_cfg)
        try:
            cur = c.cursor()
            cur.execute("""
                SELECT table_schema, table_name, table_type
                FROM information_schema.tables
                WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                ORDER BY table_schema, table_name
                LIMIT 200
            """)
            trows = cur.fetchall()
            cur.execute("""
                SELECT table_schema, table_name, column_name, data_type
                FROM information_schema.columns
                WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                ORDER BY table_schema, table_name, ordinal_position
            """)
            crows = cur.fetchall()
            cur.close()
        finally:
            c.close()
        col_map = {}
        for sch, tbl, col, dt in crows:
            col_map.setdefault((sch, tbl), []).append({'name': str(col), 'dataType': str(dt)})
        tables = [{
            'name': str(tbl),
            'schema': str(sch),
            'tableType': str(ttype).lower(),
            'rowCount': None,
            'columns': col_map.get((sch, tbl), []),
        } for sch, tbl, ttype in trows]
        return {'ok': True, 'message': f'已连接 PostgreSQL，发现 {len(tables)} 张表/视图。', 'tables': tables, 'engine': engine}

    if db_type == 'mysql':
        c, engine = _open_mysql(conn_cfg)
        try:
            cur = c.cursor()
            cur.execute("""
                SELECT table_schema, table_name, table_type
                FROM information_schema.tables
                WHERE table_schema = DATABASE()
                ORDER BY table_name
                LIMIT 200
            """)
            trows = cur.fetchall()
            cur.execute("""
                SELECT table_schema, table_name, column_name, data_type
                FROM information_schema.columns
                WHERE table_schema = DATABASE()
                ORDER BY table_name, ordinal_position
            """)
            crows = cur.fetchall()
            cur.close()
        finally:
            c.close()
        col_map = {}
        for sch, tbl, col, dt in crows:
            col_map.setdefault((sch, tbl), []).append({'name': str(col), 'dataType': str(dt)})
        tables = [{
            'name': str(tbl),
            'schema': str(sch),
            'tableType': str(ttype).lower(),
            'rowCount': None,
            'columns': col_map.get((sch, tbl), []),
        } for sch, tbl, ttype in trows]
        return {'ok': True, 'message': f'已连接 MySQL，发现 {len(tables)} 张表/视图。', 'tables': tables, 'engine': engine}

    return {'ok': False, 'message': f'不支持的数据库类型：{db_type}', 'tables': [], 'engine': 'Unknown'}

def _query_sql(req):
    sql = (req.get('sql') or '').strip()
    max_rows = int(req.get('maxRows', 200))
    conn_cfg = req.get('connection')
    mounted = req.get('mountedFiles') or []
    export_bus = (req.get('exportBusTable') or '').strip()
    tables_dir = (req.get('tablesDir') or '').strip()
    db_type = (conn_cfg.get('dbType') or '').lower() if conn_cfg else 'duckdb'

    if db_type == 'duckdb':
        import duckdb
        fpath = (conn_cfg.get('filePath') or '').strip() if conn_cfg else ''
        con = duckdb.connect(fpath or ':memory:')
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
            res = con.execute(sql)
            desc = res.description
            if not desc:
                return {'ok': True, 'columns': [], 'rows': [], 'totalRows': None, 'truncated': False, 'engine': 'DuckDB', 'message': 'SQL 执行完成。', 'error': None, 'busTablePath': None}
            cols = [{'name': str(d[0]), 'dataType': str(d[1]) if len(d) > 1 and d[1] else 'ANY'} for d in desc]
            fetched = res.fetchmany(max_rows + 1)
            truncated = len(fetched) > max_rows
            if truncated:
                fetched = fetched[:max_rows]
            rows = [[_to_json_val(v) for v in r] for r in fetched]
            bus_path = None
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
                except Exception:
                    pass
            return {
                'ok': True,
                'columns': cols,
                'rows': rows,
                'totalRows': None if truncated else len(rows),
                'truncated': truncated,
                'engine': 'DuckDB',
                'message': None,
                'error': None,
                'busTablePath': bus_path,
            }
        finally:
            con.close()

    if db_type in ('postgres', 'mysql'):
        c, engine = _open_pg(conn_cfg) if db_type == 'postgres' else _open_mysql(conn_cfg)
        try:
            cur = c.cursor()
            cur.execute(sql)
            desc = cur.description
            if not desc:
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
                }
            cols = [{'name': str(d[0]), 'dataType': str(d[1]) if len(d) > 1 and d[1] else 'ANY'} for d in desc]
            fetch_cap = 50000 if (export_bus and tables_dir and os.path.isdir(tables_dir)) else (max_rows + 1)
            fetched_all = cur.fetchmany(fetch_cap)
            truncated = len(fetched_all) > max_rows
            preview_slice = fetched_all[:max_rows]
            rows = [[_to_json_val(v) for v in r] for r in preview_slice]
            bus_path = None
            if export_bus and tables_dir and os.path.isdir(tables_dir):
                safe_name = _safe_alias(export_bus)
                csv_target = os.path.join(tables_dir, f"{safe_name}.csv")
                pq_stale = os.path.join(tables_dir, f"{safe_name}.parquet")
                try:
                    import csv as _sm_csv
                    with open(csv_target, 'w', newline='', encoding='utf-8') as f:
                        w = _sm_csv.writer(f)
                        w.writerow([col['name'] for col in cols])
                        for r in fetched_all:
                            w.writerow([_to_json_val(v) for v in r])
                    if os.path.exists(pq_stale):
                        try:
                            os.remove(pq_stale)
                        except Exception:
                            pass
                    bus_path = csv_target
                except Exception:
                    pass
            cur.close()
            return {
                'ok': True,
                'columns': cols,
                'rows': rows,
                'totalRows': len(fetched_all) if not (len(fetched_all) == fetch_cap) else None,
                'truncated': truncated,
                'engine': engine,
                'message': None,
                'error': None,
                'busTablePath': bus_path,
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

async fn run_python_data_helper(
    python_path: &str,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let exe_path = python_lab::resolve_python_executable(python_path).ok_or_else(|| {
        format!("无法在路径 ({python_path}) 中找到 python 可执行文件。")
    })?;
    let exe_display = exe_path.to_string_lossy().to_string();
    let mut cmd = Command::new(&exe_path);
    cmd.args(["-u", "-c", EMBEDDED_DATA_ENGINE_PY]);
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

    if let Some(mut stdin) = child.stdin.take() {
        let input = serde_json::to_vec(&payload).map_err(|e| format!("序列化请求失败：{e}"))?;
        let _ = stdin.write_all(&input).await;
        let _ = stdin.shutdown().await;
    }

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(SQL_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| format!("数据引擎执行超过 {SQL_TIMEOUT_SECS} 秒超时。"))?
    .map_err(|e| format!("等待 Python 数据引擎失败：{e}"))?;

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

    Ok(DataDbTestResult {
        ok,
        message,
        tables,
        engine,
    })
}

#[tauri::command]
pub async fn data_lab_query_sql(
    sql: String,
    connection: Option<DataDbConnectionInput>,
    mounted_files: Option<Vec<DataMountedFileRef>>,
    python_path: Option<String>,
    max_rows: Option<usize>,
    export_bus_table: Option<String>,
    session_id: Option<String>,
) -> Result<DataTableResult, String> {
    let start = std::time::Instant::now();
    let limit = max_rows.unwrap_or(DEFAULT_MAX_ROWS).clamp(1, MAX_ALLOWED_ROWS);
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
            let db =
                Connection::open(fpath).map_err(|e| format!("打开 SQLite 文件失败：{e}"))?;
            let export_pair = match (&tables_dir_path, &export_alias) {
                (Some(dir), Some(alias)) => Some((dir.as_path(), alias.as_str())),
                _ => None,
            };
            return Ok(execute_sqlite_on_conn(
                &db,
                &sql,
                limit,
                "SQLite (Rust Native)",
                start,
                export_pair,
            ));
        }
    }

    // 2. Local files mode (no DB connection) or DuckDB connection
    let is_local_or_duck = connection
        .as_ref()
        .map(|c| c.db_type.eq_ignore_ascii_case("duckdb"))
        .unwrap_or(true);

    if is_local_or_duck {
        let preferred_py = connection
            .as_ref()
            .and_then(|c| c.python_path.as_deref())
            .or(python_path.as_deref());

        if let Some((py_exe, has_duckdb)) = pick_best_python(preferred_py, true) {
            if has_duckdb {
                let resp = run_python_data_helper(
                    &py_exe,
                    serde_json::json!({
                        "op": "query_sql",
                        "sql": sql,
                        "connection": connection,
                        "mountedFiles": files,
                        "maxRows": limit,
                        "exportBusTable": export_alias,
                        "tablesDir": tables_dir_path.as_ref().map(|p| p.to_string_lossy().to_string()),
                    }),
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
                    columns: vec![],
                    rows: vec![],
                    total_rows: None,
                    truncated: false,
                    engine: "DuckDB".to_string(),
                    duration_ms: start.elapsed().as_millis() as u64,
                    message: None,
                    error: Some(
                        "未在已检测的 Anaconda / Python 环境中找到 duckdb 包。请在终端执行：pip install duckdb"
                            .to_string(),
                    ),
                    bus_table_path: None,
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
                columns: vec![],
                rows: vec![],
                total_rows: None,
                truncated: false,
                engine: "DuckDB Required".to_string(),
                duration_ms: start.elapsed().as_millis() as u64,
                message: None,
                error: Some(
                    "直接对 Parquet 文件执行 SQL 需要 DuckDB 引擎。请在当前 Anaconda 环境中安装：pip install duckdb"
                        .to_string(),
                ),
                bus_table_path: None,
            });
        }

        let mem_conn = load_mounted_files_into_memory_sqlite(&files)?;
        let export_pair = match (&tables_dir_path, &export_alias) {
            (Some(dir), Some(alias)) => Some((dir.as_path(), alias.as_str())),
            _ => None,
        };
        return Ok(execute_sqlite_on_conn(
            &mem_conn,
            &sql,
            limit,
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
            columns: vec![],
            rows: vec![],
            total_rows: None,
            truncated: false,
            engine: conn.db_type.to_uppercase(),
            duration_ms: start.elapsed().as_millis() as u64,
            message: None,
            error: Some("未检测到本地 Python / Anaconda 环境，无法连接远程数据库。".to_string()),
            bus_table_path: None,
        });
    };

    let mut conn_payload = conn.clone();
    conn_payload.password = resolve_db_password(&conn);

    let resp = run_python_data_helper(
        &py_exe,
        serde_json::json!({
            "op": "query_sql",
            "sql": sql,
            "connection": conn_payload,
            "mountedFiles": [],
            "maxRows": limit,
            "exportBusTable": export_alias,
            "tablesDir": tables_dir_path.as_ref().map(|p| p.to_string_lossy().to_string()),
        }),
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
    }
}
