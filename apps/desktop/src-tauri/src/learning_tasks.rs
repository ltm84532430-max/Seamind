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
    archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id, position);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived_at);
CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    prerequisite_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY(task_id, prerequisite_id)
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    pub plans: Vec<Plan>,
    pub tasks: Vec<Task>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlan {
    pub plan: PlanInput,
    pub tasks: Vec<TaskInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub plan_id: String,
    pub added: usize,
    pub already_present: usize,
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
    Ok(conn)
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
    let mut stmt = conn.prepare("SELECT id,plan_id,parent_id,title,note,status,priority,due_date,position,optional,resources_json,origin_key,revision,created_at,updated_at,completed_at,archived_at FROM tasks ORDER BY position,created_at,id").map_err(db_error)?;
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
    Ok(TaskSnapshot { plans, tasks })
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

fn import_plan(
    conn: &Connection,
    draft: &ImportPlan,
    timestamp: i64,
) -> Result<ImportResult, String> {
    if draft.tasks.len() > 1000 {
        return Err("单次导入最多包含 1000 个任务。".to_string());
    }
    let origin = draft
        .plan
        .origin_key
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| "导入计划缺少来源标识。".to_string())?;
    let tx = conn.unchecked_transaction().map_err(db_error)?;
    let existing_plan: Option<String> = tx
        .query_row(
            "SELECT id FROM plans WHERE origin_key=?1",
            params![origin],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    let plan_id = match existing_plan {
        Some(id) => id,
        None => write_plan(&tx, &draft.plan, timestamp)?,
    };
    let mut mapping = HashMap::new();
    let mut pending = Vec::new();
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
            .filter(|v| !v.trim().is_empty())
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
        mapping.insert(proposed.to_string(), actual);
        if existing.is_some() {
            already_present += 1;
        } else {
            pending.push(input.clone());
        }
    }
    // Insert nodes first; parent and prerequisite references are applied afterwards.
    for input in &pending {
        let mut node = input.clone();
        node.id = mapping.get(input.id.as_deref().unwrap_or("")).cloned();
        node.plan_id = Some(plan_id.clone());
        node.parent_id = None;
        node.prerequisite_ids.clear();
        node.expected_revision = None;
        write_task(&tx, &node, timestamp)?;
    }
    for input in &pending {
        let id = mapping
            .get(input.id.as_deref().unwrap_or(""))
            .ok_or_else(|| "导入编号映射失败。".to_string())?;
        if let Some(parent) = &input.parent_id {
            let target = mapping
                .get(parent)
                .ok_or_else(|| "导入任务的父节点不存在。".to_string())?;
            tx.execute(
                "UPDATE tasks SET parent_id=?1 WHERE id=?2",
                params![target, id],
            )
            .map_err(db_error)?;
        }
        for prerequisite in &input.prerequisite_ids {
            let target = mapping
                .get(prerequisite)
                .ok_or_else(|| "导入任务的前置节点不存在。".to_string())?;
            tx.execute(
                "INSERT OR IGNORE INTO task_dependencies(task_id,prerequisite_id) VALUES (?1,?2)",
                params![id, target],
            )
            .map_err(db_error)?;
        }
    }
    validate_graph(&tx)?;
    tx.commit().map_err(db_error)?;
    Ok(ImportResult {
        plan_id,
        added: pending.len(),
        already_present,
    })
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

#[tauri::command(async)]
pub fn learning_tasks_archive_done(app: AppHandle, plan_id: Option<String>) -> Result<usize, String> {
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
