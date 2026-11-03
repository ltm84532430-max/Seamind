//! Shared, local task state for learning plans. Source media keep their own progress.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const DATABASE_FILE: &str = "learning-tasks.sqlite3";
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    origin_key TEXT UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY NOT NULL,
    plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
    parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    note TEXT,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    due_date TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    optional INTEGER NOT NULL DEFAULT 0,
    resources_json TEXT NOT NULL DEFAULT '[]',
    origin_key TEXT UNIQUE,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    archived_at INTEGER,
    source_key TEXT,
    source_present INTEGER NOT NULL DEFAULT 1,
    source_snapshot_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id, position);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, due_date);
CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    prerequisite_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY(task_id, prerequisite_id)
);
CREATE TABLE IF NOT EXISTS plan_sources (
    source_key TEXT PRIMARY KEY NOT NULL,
    plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL,
    title TEXT NOT NULL,
    last_synced_at INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);
"#;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskResource {
    pub kind: String,
    pub resource_id: String,
    pub title: String,
    pub root_path: Option<String>,
    pub relative_path: Option<String>,
    pub progress_key: Option<String>,
    #[serde(default)]
    pub book_id: Option<String>,
    pub href: Option<String>,
    pub start_seconds: Option<i64>,
    pub target_unit: Option<String>,
    pub target_value: Option<f64>,
    pub baseline: Option<f64>,
    pub manual_value: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanInput {
    pub id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub origin_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub origin_key: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInput {
    pub id: Option<String>,
    pub plan_id: Option<String>,
    pub parent_id: Option<String>,
    pub title: String,
    pub note: Option<String>,
    pub status: String,
    pub priority: i64,
    pub due_date: Option<String>,
    pub position: i64,
    pub optional: bool,
    #[serde(default)]
    pub resources: Vec<TaskResource>,
    #[serde(default)]
    pub prerequisite_ids: Vec<String>,
    pub origin_key: Option<String>,
    pub expected_revision: Option<i64>,
    pub completed_at: Option<i64>,
    pub archived_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub plan_id: Option<String>,
    pub parent_id: Option<String>,
    pub title: String,
    pub note: Option<String>,
    pub status: String,
    pub priority: i64,
    pub due_date: Option<String>,
    pub position: i64,
    pub optional: bool,
    pub resources: Vec<TaskResource>,
    pub prerequisite_ids: Vec<String>,
    pub origin_key: Option<String>,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
    pub archived_at: Option<i64>,
    pub source_key: Option<String>,
    pub source_present: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSource {
    pub source_key: String,
    pub plan_id: String,
    pub source_kind: String,
    pub title: String,
    pub last_synced_at: i64,
    pub sort_order: i64,
    pub task_count: usize,
    pub removed_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    pub plans: Vec<Plan>,
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub sources: Vec<PlanSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlan {
    pub plan: PlanInput,
    pub tasks: Vec<TaskInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncImportRequest {
    pub source: ImportPlan,
    pub target_plan_id: Option<String>,
    pub new_plan_title: Option<String>,
    #[serde(default)]
    pub create_new: bool,
    #[serde(default)]
    pub source_order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub plan_id: String,
    pub added: usize,
    pub already_present: usize,
    pub updated: usize,
    pub conflicts: usize,
    pub removed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SourceTaskSnapshot {
    title: String,
    note: Option<String>,
    due_date: Option<String>,
    position: i64,
    optional: bool,
    resources: Vec<TaskResource>,
    parent_id: Option<String>,
    prerequisite_ids: Vec<String>,
}

fn db_error(error: impl std::fmt::Display) -> String {
    format!("任务数据库操作失败：{error}")
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn open_path(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(db_error)?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(db_error)?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(db_error)?;
    conn.execute_batch(SCHEMA).map_err(db_error)?;
    let _ = conn.execute("ALTER TABLE tasks ADD COLUMN completed_at INTEGER", []);
    let _ = conn.execute("ALTER TABLE tasks ADD COLUMN archived_at INTEGER", []);
    let _ = conn.execute("ALTER TABLE tasks ADD COLUMN source_key TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE tasks ADD COLUMN source_present INTEGER NOT NULL DEFAULT 1",
        [],
    );
    let _ = conn.execute("ALTER TABLE tasks ADD COLUMN source_snapshot_json TEXT", []);
    let source_order_column_added = conn
        .execute(
            "ALTER TABLE plan_sources ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .is_ok();
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source_key, source_present)",
        [],
    )
    .map_err(db_error)?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived_at)",
        [],
    )
    .map_err(db_error)?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_plan_sources_order ON plan_sources(plan_id,sort_order,source_key)",
        [],
    )
    .map_err(db_error)?;
    backfill_legacy_plan_sources(&conn)?;
    if source_order_column_added {
        let mut stmt = conn
            .prepare("SELECT DISTINCT plan_id FROM plan_sources ORDER BY plan_id")
            .map_err(db_error)?;
        let plan_ids = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        drop(stmt);
        for plan_id in plan_ids {
            normalize_plan_source_order(&conn, &plan_id)?;
        }
    }
    Ok(conn)
}

fn backfill_legacy_plan_sources(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,origin_key,title,updated_at FROM plans
             WHERE origin_key IS NOT NULL ORDER BY created_at,id",
        )
        .map_err(db_error)?;
    let plans = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    drop(stmt);

    for (plan_id, source_key, title, last_synced_at) in plans {
        let already_linked: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM plan_sources WHERE source_key=?1)",
                params![source_key],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if already_linked {
            continue;
        }
        let task_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE plan_id=?1 AND source_key IS NULL",
                params![plan_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if task_count == 0 {
            continue;
        }
        let source_kind = serde_json::from_str::<Vec<String>>(&source_key)
            .ok()
            .and_then(|parts| parts.first().cloned())
            .unwrap_or_else(|| "legacy".to_string());
        let sort_order: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order)+1,0) FROM plan_sources WHERE plan_id=?1",
                params![plan_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        conn.execute(
            "INSERT OR IGNORE INTO plan_sources(
                source_key,plan_id,source_kind,title,last_synced_at,sort_order
             ) VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                source_key,
                plan_id,
                source_kind,
                title,
                last_synced_at,
                sort_order
            ],
        )
        .map_err(db_error)?;
        conn.execute(
            "UPDATE tasks SET source_key=?1 WHERE plan_id=?2 AND source_key IS NULL",
            params![source_key, plan_id],
        )
        .map_err(db_error)?;
    }
    Ok(())
}

fn open(app: &AppHandle) -> Result<Connection, String> {
    let dir = app.path().app_local_data_dir().map_err(db_error)?;
    std::fs::create_dir_all(&dir).map_err(db_error)?;
    open_path(&dir.join(DATABASE_FILE))
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-:".contains(c))
}

fn clean_optional(value: &Option<String>, limit: usize) -> Result<Option<String>, String> {
    let Some(value) = value
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    if value.chars().count() > limit {
        return Err(format!("输入内容不能超过 {limit} 个字符。"));
    }
    Ok(Some(value.to_string()))
}

fn validate_due_date(value: &Option<String>) -> Result<Option<String>, String> {
    let value = clean_optional(value, 10)?;
    if let Some(date) = value.as_deref() {
        let bytes = date.as_bytes();
        if bytes.len() != 10
            || bytes[4] != b'-'
            || bytes[7] != b'-'
            || !bytes
                .iter()
                .enumerate()
                .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
        {
            return Err("截止日期格式无效。".to_string());
        }
        let year = date[0..4].parse::<u16>().unwrap_or(0);
        let month = date[5..7].parse::<u8>().unwrap_or(0);
        let day = date[8..10].parse::<u8>().unwrap_or(0);
        if year == 0 || !(1..=12).contains(&month) {
            return Err("截止日期格式无效。".to_string());
        }
        let days = match month {
            2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
            2 => 28,
            4 | 6 | 9 | 11 => 30,
            _ => 31,
        };
        if day == 0 || day > days {
            return Err("截止日期格式无效。".to_string());
        }
    }
    Ok(value)
}

fn validate_resources(resources: &[TaskResource]) -> Result<String, String> {
    if resources.len() > 20 {
        return Err("一个任务最多关联 20 个资源。".to_string());
    }
    for resource in resources {
        if !matches!(resource.kind.as_str(), "ebook" | "youtube")
            || resource.resource_id.trim().is_empty()
            || resource.resource_id.len() > 2048
            || resource.title.chars().count() > 500
            || resource.root_path.as_ref().is_some_and(|v| v.len() > 4096)
            || resource
                .relative_path
                .as_ref()
                .is_some_and(|v| v.len() > 4096)
            || resource
                .progress_key
                .as_ref()
                .is_some_and(|v| v.len() > 4096)
            || resource
                .book_id
                .as_ref()
                .is_some_and(|v| v.trim().is_empty() || v.len() > 4096)
            || resource.href.as_ref().is_some_and(|v| v.len() > 4096)
            || resource.start_seconds.is_some_and(|v| v < 0)
            || [
                resource.target_value,
                resource.baseline,
                resource.manual_value,
            ]
            .iter()
            .flatten()
            .any(|v| !v.is_finite() || *v < 0.0)
        {
            return Err("任务关联资源的数据无效。".to_string());
        }
        if resource.kind == "ebook"
            && (resource.root_path.as_deref().unwrap_or("").is_empty()
                || resource.relative_path.as_deref().unwrap_or("").is_empty())
        {
            return Err("电子书资源缺少书库或相对路径。".to_string());
        }
        if resource.kind == "youtube"
            && (resource.resource_id.len() != 11
                || !resource
                    .resource_id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
        {
            return Err("YouTube 视频编号无效。".to_string());
        }
        if resource
            .target_unit
            .as_deref()
            .is_some_and(|unit| !matches!(unit, "chapters" | "words" | "seconds"))
        {
            return Err("任务目标单位无效。".to_string());
        }
    }
    serde_json::to_string(resources).map_err(db_error)
}

fn write_plan(conn: &Connection, input: &PlanInput, timestamp: i64) -> Result<String, String> {
    let title = input.title.trim();
    if title.is_empty() || title.chars().count() > 160 {
        return Err("计划标题需为 1 到 160 个字符。".to_string());
    }
    let id = input
        .id
        .clone()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    if !valid_id(&id) {
        return Err("计划编号无效。".to_string());
    }
    let description = clean_optional(&input.description, 4000)?;
    let origin = clean_optional(&input.origin_key, 4096)?;
    conn.execute(
        "INSERT INTO plans(id,title,description,origin_key,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,updated_at=excluded.updated_at",
        params![id,title,description,origin,timestamp],
    ).map_err(db_error)?;
    Ok(id)
}

fn write_task(conn: &Connection, input: &TaskInput, timestamp: i64) -> Result<String, String> {
    let id = input
        .id
        .clone()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    if !valid_id(&id) {
        return Err("任务编号无效。".to_string());
    }
    let title = input.title.trim();
    if title.is_empty() || title.chars().count() > 240 {
        return Err("任务标题需为 1 到 240 个字符。".to_string());
    }
    if !matches!(
        input.status.as_str(),
        "todo" | "doing" | "done" | "cancelled"
    ) {
        return Err("任务状态无效。".to_string());
    }
    if !(0..=3).contains(&input.priority) {
        return Err("任务优先级无效。".to_string());
    }
    let note = clean_optional(&input.note, 4000)?;
    let due_date = validate_due_date(&input.due_date)?;
    let origin = clean_optional(&input.origin_key, 4096)?;
    let resources = validate_resources(&input.resources)?;
    for reference in [&input.plan_id, &input.parent_id].into_iter().flatten() {
        if !valid_id(reference) {
            return Err("任务关联编号无效。".to_string());
        }
    }
    let current_revision: Option<i64> = conn
        .query_row(
            "SELECT revision FROM tasks WHERE id=?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    if let (Some(current), Some(expected)) = (current_revision, input.expected_revision) {
        if current != expected {
            return Err("任务已在其他位置更新，请刷新后重试。".to_string());
        }
    }
    let completed_at = if input.status == "done" {
        input.completed_at.or(Some(timestamp))
    } else {
        None
    };
    let archived_at = input.archived_at;
    conn.execute(
        "INSERT INTO tasks(id,plan_id,parent_id,title,note,status,priority,due_date,position,optional,resources_json,origin_key,revision,created_at,updated_at,completed_at,archived_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,1,?13,?13,?14,?15)
         ON CONFLICT(id) DO UPDATE SET plan_id=excluded.plan_id,parent_id=excluded.parent_id,title=excluded.title,
           note=excluded.note,status=excluded.status,priority=excluded.priority,due_date=excluded.due_date,
           position=excluded.position,optional=excluded.optional,resources_json=excluded.resources_json,
           revision=tasks.revision+1,updated_at=excluded.updated_at,
           completed_at=excluded.completed_at,
           archived_at=excluded.archived_at",
        params![id,input.plan_id,input.parent_id,title,note,input.status,input.priority,due_date,input.position,i64::from(input.optional),resources,origin,timestamp,completed_at,archived_at],
    ).map_err(db_error)?;
    conn.execute(
        "DELETE FROM task_dependencies WHERE task_id=?1",
        params![id],
    )
    .map_err(db_error)?;
    let mut seen = HashSet::new();
    for prerequisite in &input.prerequisite_ids {
        if !valid_id(prerequisite) || prerequisite == &id {
            return Err("任务前置依赖无效。".to_string());
        }
        if seen.insert(prerequisite) {
            conn.execute(
                "INSERT INTO task_dependencies(task_id,prerequisite_id) VALUES (?1,?2)",
                params![id, prerequisite],
            )
            .map_err(db_error)?;
        }
    }
    Ok(id)
}

fn validate_graph(conn: &Connection) -> Result<(), String> {
    let mut graph: HashMap<String, Vec<String>> = HashMap::new();
    let mut stmt = conn
        .prepare("SELECT id,parent_id FROM tasks")
        .map_err(db_error)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(db_error)?;
    for row in rows {
        let (id, parent) = row.map_err(db_error)?;
        graph.entry(id.clone()).or_default();
        if let Some(parent) = parent {
            graph.entry(parent).or_default().push(id);
        }
    }
    let mut stmt = conn
        .prepare("SELECT task_id,prerequisite_id FROM task_dependencies")
        .map_err(db_error)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?;
    for row in rows {
        let (task, pre) = row.map_err(db_error)?;
        graph.entry(pre).or_default().push(task);
    }
    fn visit(
        node: &str,
        graph: &HashMap<String, Vec<String>>,
        colors: &mut HashMap<String, u8>,
    ) -> bool {
        match colors.get(node).copied().unwrap_or(0) {
            1 => return true,
            2 => return false,
            _ => {}
        }
        colors.insert(node.to_string(), 1);
        if let Some(next) = graph.get(node) {
            for child in next {
                if visit(child, graph, colors) {
                    return true;
                }
            }
        }
        colors.insert(node.to_string(), 2);
        false
    }
    let mut colors = HashMap::new();
    for node in graph.keys() {
        if visit(node, &graph, &mut colors) {
            return Err("任务父子或前置关系存在循环。".to_string());
        }
    }
    Ok(())
}

fn snapshot(conn: &Connection) -> Result<TaskSnapshot, String> {
    let mut stmt = conn.prepare("SELECT id,title,description,origin_key,created_at,updated_at FROM plans ORDER BY created_at,id").map_err(db_error)?;
    let plans = stmt
        .query_map([], |row| {
            Ok(Plan {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                origin_key: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let mut stmt = conn.prepare("SELECT id,plan_id,parent_id,title,note,status,priority,due_date,position,optional,resources_json,origin_key,revision,created_at,updated_at,completed_at,archived_at,source_key,source_present FROM tasks ORDER BY position,created_at,id").map_err(db_error)?;
    let mut tasks = stmt
        .query_map([], |row| {
            let resources: String = row.get(10)?;
            Ok(Task {
                id: row.get(0)?,
                plan_id: row.get(1)?,
                parent_id: row.get(2)?,
                title: row.get(3)?,
                note: row.get(4)?,
                status: row.get(5)?,
                priority: row.get(6)?,
                due_date: row.get(7)?,
                position: row.get(8)?,
                optional: row.get::<_, i64>(9)? != 0,
                resources: serde_json::from_str(&resources).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        10,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?,
                prerequisite_ids: Vec::new(),
                origin_key: row.get(11)?,
                revision: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
                completed_at: row.get(15)?,
                archived_at: row.get(16)?,
                source_key: row.get(17)?,
                source_present: row.get::<_, i64>(18)? != 0,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let mut dep = conn.prepare("SELECT prerequisite_id FROM task_dependencies WHERE task_id=?1 ORDER BY prerequisite_id").map_err(db_error)?;
    for task in &mut tasks {
        task.prerequisite_ids = dep
            .query_map(params![task.id], |row| row.get(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
    }
    let mut stmt = conn
        .prepare(
            "SELECT s.source_key,s.plan_id,s.source_kind,s.title,s.last_synced_at,s.sort_order,
                    SUM(CASE WHEN t.source_present=1 THEN 1 ELSE 0 END),
                    SUM(CASE WHEN t.source_present=0 THEN 1 ELSE 0 END)
             FROM plan_sources s LEFT JOIN tasks t ON t.source_key=s.source_key
             GROUP BY s.source_key,s.plan_id,s.source_kind,s.title,s.last_synced_at,s.sort_order
             ORDER BY s.plan_id,s.sort_order,s.title,s.source_key",
        )
        .map_err(db_error)?;
    let sources = stmt
        .query_map([], |row| {
            Ok(PlanSource {
                source_key: row.get(0)?,
                plan_id: row.get(1)?,
                source_kind: row.get(2)?,
                title: row.get(3)?,
                last_synced_at: row.get(4)?,
                sort_order: row.get(5)?,
                task_count: row.get::<_, Option<i64>>(6)?.unwrap_or(0) as usize,
                removed_count: row.get::<_, Option<i64>>(7)?.unwrap_or(0) as usize,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(TaskSnapshot {
        plans,
        tasks,
        sources,
    })
}

fn save_task(conn: &Connection, input: &TaskInput, timestamp: i64) -> Result<Task, String> {
    let tx = conn.unchecked_transaction().map_err(db_error)?;
    let id = write_task(&tx, input, timestamp)?;
    validate_graph(&tx)?;
    let task = snapshot(&tx)?
        .tasks
        .into_iter()
        .find(|task| task.id == id)
        .ok_or_else(|| "保存后找不到任务。".to_string())?;
    tx.commit().map_err(db_error)?;
    Ok(task)
}

fn merge_source_field<T: Clone + PartialEq>(
    current: &T,
    previous_source: &T,
    incoming_source: &T,
) -> (T, bool) {
    if current == previous_source {
        (incoming_source.clone(), false)
    } else if incoming_source == previous_source || current == incoming_source {
        (current.clone(), false)
    } else {
        (current.clone(), true)
    }
}

fn reorder_plan_source(
    conn: &Connection,
    plan_id: &str,
    source_key: &str,
    requested_order: Option<i64>,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT source_key FROM plan_sources
             WHERE plan_id=?1 ORDER BY sort_order,title,source_key",
        )
        .map_err(db_error)?;
    let mut keys = stmt
        .query_map(params![plan_id], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    drop(stmt);

    keys.retain(|key| key != source_key);
    let index = requested_order
        .filter(|order| *order >= 0)
        .map(|order| order as usize)
        .unwrap_or(keys.len())
        .min(keys.len());
    keys.insert(index, source_key.to_string());
    for (position, key) in keys.iter().enumerate() {
        conn.execute(
            "UPDATE plan_sources SET sort_order=?1 WHERE plan_id=?2 AND source_key=?3",
            params![position as i64, plan_id, key],
        )
        .map_err(db_error)?;
    }
    Ok(())
}

fn normalize_plan_source_order(conn: &Connection, plan_id: &str) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT source_key FROM plan_sources
             WHERE plan_id=?1 ORDER BY sort_order,title,source_key",
        )
        .map_err(db_error)?;
    let keys = stmt
        .query_map(params![plan_id], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    drop(stmt);
    for (position, key) in keys.iter().enumerate() {
        conn.execute(
            "UPDATE plan_sources SET sort_order=?1 WHERE plan_id=?2 AND source_key=?3",
            params![position as i64, plan_id, key],
        )
        .map_err(db_error)?;
    }
    Ok(())
}

fn import_plan_with_target(
    conn: &Connection,
    draft: &ImportPlan,
    requested_target_id: Option<&str>,
    new_plan_title: Option<&str>,
    create_new: bool,
    requested_source_order: Option<i64>,
    timestamp: i64,
) -> Result<ImportResult, String> {
    if draft.tasks.len() > 1000 {
        return Err("单次导入最多包含 1000 个任务。".to_string());
    }
    let source_key = draft
        .plan
        .origin_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "导入计划缺少来源标识。".to_string())?;
    let source_kind = serde_json::from_str::<Vec<String>>(source_key)
        .ok()
        .and_then(|parts| parts.first().cloned())
        .unwrap_or_else(|| "legacy".to_string());
    let tx = conn.unchecked_transaction().map_err(db_error)?;

    let mapped_plan: Option<String> = tx
        .query_row(
            "SELECT plan_id FROM plan_sources WHERE source_key=?1",
            params![source_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    let existing_source_order: Option<i64> = tx
        .query_row(
            "SELECT sort_order FROM plan_sources WHERE source_key=?1",
            params![source_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    let legacy_plan: Option<String> = tx
        .query_row(
            "SELECT id FROM plans WHERE origin_key=?1",
            params![source_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    let plan_id = if let Some(target_id) = requested_target_id {
        if !valid_id(target_id) {
            return Err("目标计划编号无效。".to_string());
        }
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM plans WHERE id=?1)",
                params![target_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if !exists {
            return Err("目标计划已不存在，请刷新后重试。".to_string());
        }
        target_id.to_string()
    } else if !create_new && mapped_plan.is_some() {
        mapped_plan.clone().unwrap()
    } else if !create_new && legacy_plan.is_some() {
        legacy_plan.clone().unwrap()
    } else {
        let title = new_plan_title
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(draft.plan.title.as_str());
        let plan = PlanInput {
            id: None,
            title: title.to_string(),
            description: draft.plan.description.clone(),
            origin_key: if create_new || new_plan_title.is_some() {
                None
            } else {
                draft.plan.origin_key.clone()
            },
        };
        write_plan(&tx, &plan, timestamp)?
    };

    let mut mapping = HashMap::new();
    let mut existing_ids = HashSet::new();
    let mut already_present = 0;
    for input in &draft.tasks {
        let proposed = input
            .id
            .as_deref()
            .filter(|id| valid_id(id))
            .ok_or_else(|| "导入任务缺少有效编号。".to_string())?;
        let task_origin = input
            .origin_key
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "导入任务缺少来源标识。".to_string())?;
        if mapping.contains_key(proposed) {
            return Err("导入任务编号重复。".to_string());
        }
        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM tasks WHERE origin_key=?1",
                params![task_origin],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        let actual = existing
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        mapping.insert(proposed.to_string(), actual.clone());
        if existing.is_some() {
            already_present += 1;
            existing_ids.insert(actual);
        }
    }

    let mut removed = 0usize;
    {
        let mut stmt = tx
            .prepare("SELECT id FROM tasks WHERE source_key=?1 AND source_present=1")
            .map_err(db_error)?;
        let old_ids = stmt
            .query_map(params![source_key], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        for id in old_ids {
            if !mapping.values().any(|mapped| mapped == &id) {
                removed += 1;
            }
        }
    }
    tx.execute(
        "UPDATE tasks SET source_present=0 WHERE source_key=?1",
        params![source_key],
    )
    .map_err(db_error)?;
    tx.execute(
        "UPDATE tasks SET plan_id=?1 WHERE source_key=?2",
        params![plan_id, source_key],
    )
    .map_err(db_error)?;
    tx.execute(
        "INSERT INTO plan_sources(source_key,plan_id,source_kind,title,last_synced_at)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(source_key) DO UPDATE SET plan_id=excluded.plan_id,
           source_kind=excluded.source_kind,title=excluded.title,last_synced_at=excluded.last_synced_at",
        params![source_key,plan_id,source_kind,draft.plan.title,timestamp],
    )
    .map_err(db_error)?;
    let retained_source_order = if mapped_plan.as_deref() == Some(plan_id.as_str()) {
        existing_source_order
    } else {
        None
    };
    reorder_plan_source(
        &tx,
        &plan_id,
        source_key,
        requested_source_order.or(retained_source_order),
    )?;
    if let Some(previous_plan_id) = mapped_plan
        .as_deref()
        .filter(|previous_plan_id| *previous_plan_id != plan_id)
    {
        normalize_plan_source_order(&tx, previous_plan_id)?;
    }

    let mut added = 0usize;
    let mut updated = 0usize;
    let mut conflicts = 0usize;
    for input in &draft.tasks {
        let proposed = input.id.as_deref().unwrap_or("");
        let id = mapping
            .get(proposed)
            .ok_or_else(|| "导入编号映射失败。".to_string())?;
        let parent_id = input
            .parent_id
            .as_ref()
            .map(|parent| {
                mapping
                    .get(parent)
                    .cloned()
                    .ok_or_else(|| "导入任务的父节点不存在。".to_string())
            })
            .transpose()?;
        let mut prerequisite_ids = input
            .prerequisite_ids
            .iter()
            .map(|prerequisite| {
                mapping
                    .get(prerequisite)
                    .cloned()
                    .ok_or_else(|| "导入任务的前置节点不存在。".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        prerequisite_ids.sort();
        prerequisite_ids.dedup();
        let incoming = SourceTaskSnapshot {
            title: input.title.trim().to_string(),
            note: clean_optional(&input.note, 4000)?,
            due_date: validate_due_date(&input.due_date)?,
            position: input.position,
            optional: input.optional,
            resources: input.resources.clone(),
            parent_id: parent_id.clone(),
            prerequisite_ids: prerequisite_ids.clone(),
        };
        let previous_source: Option<String> = tx
            .query_row(
                "SELECT source_snapshot_json FROM tasks WHERE id=?1",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?
            .flatten();

        if !existing_ids.contains(id) {
            let mut node = input.clone();
            node.id = Some(id.clone());
            node.plan_id = Some(plan_id.clone());
            node.parent_id = None;
            node.prerequisite_ids.clear();
            node.expected_revision = None;
            write_task(&tx, &node, timestamp)?;
            tx.execute(
                "UPDATE tasks SET parent_id=?1,source_key=?2,source_present=1,source_snapshot_json=?3 WHERE id=?4",
                params![parent_id,source_key,serde_json::to_string(&incoming).map_err(db_error)?,id],
            )
            .map_err(db_error)?;
            for prerequisite in &prerequisite_ids {
                tx.execute(
                    "INSERT OR IGNORE INTO task_dependencies(task_id,prerequisite_id) VALUES (?1,?2)",
                    params![id, prerequisite],
                )
                .map_err(db_error)?;
            }
            added += 1;
            continue;
        }

        let current: Option<(String,Option<String>,Option<String>,i64,bool,String,Option<String>)> = tx
            .query_row(
                "SELECT title,note,due_date,position,optional,resources_json,parent_id FROM tasks WHERE id=?1",
                params![id],
                |row| {
                    let optional: i64 = row.get(4)?;
                    Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,optional != 0,row.get(5)?,row.get(6)?))
                },
            )
            .optional()
            .map_err(db_error)?;
        let Some((
            current_title,
            current_note,
            current_due_date,
            current_position,
            current_optional,
            current_resources_json,
            current_parent_id,
        )) = current
        else {
            return Err("导入映射的任务已不存在，请刷新后重试。".to_string());
        };
        let current_resources: Vec<TaskResource> =
            serde_json::from_str(&current_resources_json).map_err(db_error)?;
        let mut current_prerequisites = {
            let mut stmt = tx
                .prepare("SELECT prerequisite_id FROM task_dependencies WHERE task_id=?1 ORDER BY prerequisite_id")
                .map_err(db_error)?;
            let rows = stmt
                .query_map(params![id], |row| row.get::<_, String>(0))
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?;
            rows
        };
        current_prerequisites.sort();
        let current_snapshot = SourceTaskSnapshot {
            title: current_title,
            note: current_note,
            due_date: current_due_date,
            position: current_position,
            optional: current_optional,
            resources: current_resources,
            parent_id: current_parent_id,
            prerequisite_ids: current_prerequisites,
        };
        let previous: Option<SourceTaskSnapshot> = previous_source
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(db_error)?;
        let Some(previous) = previous else {
            conflicts += [
                current_snapshot.title != incoming.title,
                current_snapshot.note != incoming.note,
                current_snapshot.due_date != incoming.due_date,
                current_snapshot.position != incoming.position,
                current_snapshot.optional != incoming.optional,
                current_snapshot.resources != incoming.resources,
                current_snapshot.parent_id != incoming.parent_id,
                current_snapshot.prerequisite_ids != incoming.prerequisite_ids,
            ]
            .into_iter()
            .filter(|changed| *changed)
            .count();
            tx.execute(
                "UPDATE tasks SET plan_id=?1,source_key=?2,source_present=1,source_snapshot_json=?3 WHERE id=?4",
                params![plan_id,source_key,serde_json::to_string(&incoming).map_err(db_error)?,id],
            )
            .map_err(db_error)?;
            continue;
        };

        let (title, title_conflict) =
            merge_source_field(&current_snapshot.title, &previous.title, &incoming.title);
        let (note, note_conflict) =
            merge_source_field(&current_snapshot.note, &previous.note, &incoming.note);
        let (due_date, due_conflict) = merge_source_field(
            &current_snapshot.due_date,
            &previous.due_date,
            &incoming.due_date,
        );
        let (position, position_conflict) = merge_source_field(
            &current_snapshot.position,
            &previous.position,
            &incoming.position,
        );
        let (optional, optional_conflict) = merge_source_field(
            &current_snapshot.optional,
            &previous.optional,
            &incoming.optional,
        );
        let (resources, resources_conflict) = merge_source_field(
            &current_snapshot.resources,
            &previous.resources,
            &incoming.resources,
        );
        let (merged_parent, parent_conflict) = merge_source_field(
            &current_snapshot.parent_id,
            &previous.parent_id,
            &incoming.parent_id,
        );
        let (merged_prerequisites, prerequisites_conflict) = merge_source_field(
            &current_snapshot.prerequisite_ids,
            &previous.prerequisite_ids,
            &incoming.prerequisite_ids,
        );
        conflicts += [
            title_conflict,
            note_conflict,
            due_conflict,
            position_conflict,
            optional_conflict,
            resources_conflict,
            parent_conflict,
            prerequisites_conflict,
        ]
        .into_iter()
        .filter(|conflict| *conflict)
        .count();
        let changed = title != current_snapshot.title
            || note != current_snapshot.note
            || due_date != current_snapshot.due_date
            || position != current_snapshot.position
            || optional != current_snapshot.optional
            || resources != current_snapshot.resources
            || merged_parent != current_snapshot.parent_id
            || merged_prerequisites != current_snapshot.prerequisite_ids
            || current_snapshot.parent_id.is_none() && parent_id.is_some();
        tx.execute(
            "UPDATE tasks SET plan_id=?1,parent_id=?2,title=?3,note=?4,due_date=?5,position=?6,optional=?7,resources_json=?8,source_key=?9,source_present=1,source_snapshot_json=?10,revision=revision+?11,updated_at=CASE WHEN ?11=1 THEN ?12 ELSE updated_at END WHERE id=?13",
            params![plan_id,merged_parent,title,note,due_date,position,i64::from(optional),serde_json::to_string(&resources).map_err(db_error)?,source_key,serde_json::to_string(&incoming).map_err(db_error)?,i64::from(changed),timestamp,id],
        )
        .map_err(db_error)?;
        if merged_prerequisites != current_snapshot.prerequisite_ids {
            tx.execute(
                "DELETE FROM task_dependencies WHERE task_id=?1",
                params![id],
            )
            .map_err(db_error)?;
            for prerequisite in &merged_prerequisites {
                tx.execute(
                    "INSERT INTO task_dependencies(task_id,prerequisite_id) VALUES (?1,?2)",
                    params![id, prerequisite],
                )
                .map_err(db_error)?;
            }
        }
        if changed {
            updated += 1;
        }
    }
    validate_graph(&tx)?;
    tx.commit().map_err(db_error)?;
    Ok(ImportResult {
        plan_id,
        added,
        already_present,
        updated,
        conflicts,
        removed,
    })
}

fn import_plan(
    conn: &Connection,
    draft: &ImportPlan,
    timestamp: i64,
) -> Result<ImportResult, String> {
    import_plan_with_target(conn, draft, None, None, false, None, timestamp)
}

#[tauri::command(async)]
pub fn learning_tasks_snapshot(app: AppHandle) -> Result<TaskSnapshot, String> {
    snapshot(&open(&app)?)
}

#[tauri::command(async)]
pub fn learning_tasks_save_plan(app: AppHandle, input: PlanInput) -> Result<TaskSnapshot, String> {
    let conn = open(&app)?;
    write_plan(&conn, &input, now())?;
    snapshot(&conn)
}

#[tauri::command(async)]
pub fn learning_tasks_save_task(app: AppHandle, input: TaskInput) -> Result<Task, String> {
    save_task(&open(&app)?, &input, now())
}

#[tauri::command(async)]
pub fn learning_tasks_delete_task(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("任务编号无效。".to_string());
    }
    open(&app)?
        .execute("DELETE FROM tasks WHERE id=?1", params![id])
        .map_err(db_error)?;
    Ok(())
}

#[tauri::command(async)]
pub fn learning_tasks_import_plan(
    app: AppHandle,
    draft: ImportPlan,
) -> Result<ImportResult, String> {
    import_plan(&open(&app)?, &draft, now())
}

#[tauri::command]
pub fn learning_tasks_sync_plan(
    app: AppHandle,
    request: SyncImportRequest,
) -> Result<ImportResult, String> {
    import_plan_with_target(
        &open(&app)?,
        &request.source,
        request.target_plan_id.as_deref(),
        request.new_plan_title.as_deref(),
        request.create_new,
        request.source_order,
        now(),
    )
}

#[tauri::command(async)]
pub fn learning_tasks_archive_done(
    app: AppHandle,
    plan_id: Option<String>,
) -> Result<usize, String> {
    let conn = open(&app)?;
    let timestamp = now();
    let count = match plan_id.as_deref() {
        Some(plan) => conn.execute(
            "UPDATE tasks SET archived_at=?1, updated_at=?1 WHERE status='done' AND archived_at IS NULL AND plan_id=?2",
            params![timestamp, plan],
        ),
        None => conn.execute(
            "UPDATE tasks SET archived_at=?1, updated_at=?1 WHERE status='done' AND archived_at IS NULL",
            params![timestamp],
        ),
    }
    .map_err(db_error)?;
    Ok(count)
}

#[tauri::command(async)]
pub fn learning_tasks_unarchive_task(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("任务编号无效。".to_string());
    }
    let conn = open(&app)?;
    let timestamp = now();
    conn.execute(
        "UPDATE tasks SET archived_at=NULL, updated_at=?2 WHERE id=?1",
        params![id, timestamp],
    )
    .map_err(db_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        open_path(Path::new(":memory:")).unwrap()
    }
    fn task(id: &str) -> TaskInput {
        TaskInput {
            id: Some(id.into()),
            plan_id: None,
            parent_id: None,
            title: id.into(),
            note: None,
            status: "todo".into(),
            priority: 0,
            due_date: None,
            position: 0,
            optional: false,
            resources: vec![],
            prerequisite_ids: vec![],
            origin_key: None,
            expected_revision: None,
            completed_at: None,
            archived_at: None,
        }
    }
    #[test]
    fn rejects_cycles_and_preserves_previous_state() {
        let conn = db();
        save_task(&conn, &task("a"), 1).unwrap();
        let mut b = task("b");
        b.prerequisite_ids = vec!["a".into()];
        save_task(&conn, &b, 2).unwrap();
        let mut a = task("a");
        a.prerequisite_ids = vec!["b".into()];
        assert!(save_task(&conn, &a, 3).is_err());
        assert!(snapshot(&conn)
            .unwrap()
            .tasks
            .iter()
            .find(|t| t.id == "a")
            .unwrap()
            .prerequisite_ids
            .is_empty());
    }
    #[test]
    fn import_is_idempotent_and_preserves_task_state() {
        let conn = db();
        let mut a = task("source-a");
        a.origin_key = Some("legacy:a".into());
        let draft = ImportPlan {
            plan: PlanInput {
                id: None,
                title: "Plan".into(),
                description: None,
                origin_key: Some("legacy:plan".into()),
            },
            tasks: vec![a],
        };
        assert_eq!(import_plan(&conn, &draft, 1).unwrap().added, 1);
        let saved = snapshot(&conn).unwrap().tasks.remove(0);
        let mut edit = task(&saved.id);
        edit.title = "Edited".into();
        edit.status = "done".into();
        edit.plan_id = saved.plan_id;
        edit.origin_key = saved.origin_key;
        edit.expected_revision = Some(saved.revision);
        save_task(&conn, &edit, 2).unwrap();
        let again = import_plan(&conn, &draft, 3).unwrap();
        assert_eq!((again.added, again.already_present), (0, 1));
        let tasks = snapshot(&conn).unwrap().tasks;
        assert_eq!(
            (
                tasks.len(),
                tasks[0].status.as_str(),
                tasks[0].title.as_str()
            ),
            (1, "done", "Edited")
        );
    }
    #[test]
    fn stale_revision_is_rejected() {
        let conn = db();
        let saved = save_task(&conn, &task("a"), 1).unwrap();
        let mut edit = task("a");
        edit.expected_revision = Some(saved.revision);
        save_task(&conn, &edit, 2).unwrap();
        assert!(save_task(&conn, &edit, 3).is_err());
    }
    #[test]
    fn corrupt_resource_data_is_reported() {
        let conn = db();
        save_task(&conn, &task("a"), 1).unwrap();
        conn.execute(
            "UPDATE tasks SET resources_json = 'invalid' WHERE id = 'a'",
            [],
        )
        .unwrap();
        assert!(snapshot(&conn).is_err());
    }

    #[test]
    fn due_date_respects_calendar_days_and_leap_years() {
        for invalid in [
            "2026-02-29",
            "2026-02-31",
            "2026-04-31",
            "1900-02-29",
            "0000-01-01",
        ] {
            assert!(
                validate_due_date(&Some(invalid.into())).is_err(),
                "{invalid}"
            );
        }
        for valid in ["2024-02-29", "2000-02-29", "2026-12-31"] {
            assert_eq!(
                validate_due_date(&Some(valid.into())).unwrap().as_deref(),
                Some(valid)
            );
        }
    }

    #[test]
    fn changing_deadline_preserves_other_task_fields_and_rejects_stale_drag() {
        let conn = db();
        let mut original = task("calendar-item");
        original.title = "Read chapter".into();
        original.due_date = Some("2026-10-28".into());
        let saved = save_task(&conn, &original, 1).unwrap();

        let mut moved = original.clone();
        moved.due_date = Some("2026-10-29".into());
        moved.expected_revision = Some(saved.revision);
        save_task(&conn, &moved, 2).unwrap();
        assert!(save_task(&conn, &moved, 3).is_err());

        let current = snapshot(&conn).unwrap().tasks.remove(0);
        assert_eq!(current.due_date.as_deref(), Some("2026-10-29"));
        assert_eq!(current.title, "Read chapter");
    }

    #[test]
    fn archives_completed_tasks_and_unarchives() {
        let conn = db();
        let mut t1 = task("t1");
        t1.status = "done".into();
        save_task(&conn, &t1, 10).unwrap();

        let t2 = task("t2");
        save_task(&conn, &t2, 10).unwrap();

        let s = snapshot(&conn).unwrap();
        let t1_saved = s.tasks.iter().find(|t| t.id == "t1").unwrap();
        assert_eq!(t1_saved.completed_at, Some(10));
        assert_eq!(t1_saved.archived_at, None);

        conn.execute(
            "UPDATE tasks SET archived_at=20, updated_at=20 WHERE status='done' AND archived_at IS NULL",
            [],
        )
        .unwrap();

        let s2 = snapshot(&conn).unwrap();
        let t1_archived = s2.tasks.iter().find(|t| t.id == "t1").unwrap();
        assert_eq!(t1_archived.archived_at, Some(20));

        conn.execute(
            "UPDATE tasks SET archived_at=NULL, updated_at=30 WHERE id='t1'",
            [],
        )
        .unwrap();
        let s3 = snapshot(&conn).unwrap();
        assert_eq!(
            s3.tasks.iter().find(|t| t.id == "t1").unwrap().archived_at,
            None
        );
    }
}
