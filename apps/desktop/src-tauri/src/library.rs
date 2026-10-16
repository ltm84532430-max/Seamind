use notify::Watcher;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{mpsc, Mutex},
    thread,
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

const SETTINGS_FILE: &str = "library.json";
const DATABASE_FILE: &str = "library-index.sqlite3";
const META_PREFIX: &str = "<!-- markmap-desktop: ";
const MAX_DOCUMENT_BYTES: usize = 5 * 1024 * 1024;
const MAX_DOCUMENTS: usize = 50_000;
const MAX_SEARCH_RESULTS: usize = 10_000;

#[derive(Default)]
pub struct WatcherState {
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibrarySettings {
    root_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapDocument {
    pub id: String,
    pub relative_path: String,
    pub title: String,
    pub category: String,
    pub map_type: String,
    pub tags: Vec<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySnapshot {
    pub root_path: Option<String>,
    pub documents: Vec<MapDocument>,
    pub categories: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    pub document: MapDocument,
    pub markdown: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDocumentInput {
    pub id: Option<String>,
    pub relative_path: Option<String>,
    pub title: String,
    pub category: String,
    pub map_type: String,
    pub tags: Vec<String>,
    pub markdown: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentMetadata {
    id: String,
    title: String,
    map_type: String,
    tags: Vec<String>,
    created_at: u64,
    updated_at: u64,
}

#[tauri::command]
pub fn library_status(app: AppHandle) -> Result<LibrarySnapshot, String> {
    let root = configured_root(&app)?;
    let snapshot = snapshot_for(&app, root.clone())?;
    if let Some(root) = root {
        let _ = start_library_watcher(&app, &root);
    }
    Ok(snapshot)
}

#[tauri::command]
pub fn set_library_root(app: AppHandle, path: String) -> Result<LibrarySnapshot, String> {
    let selected = PathBuf::from(path.trim());
    if selected.as_os_str().is_empty() {
        return Err("请选择有效的文件库目录。".to_string());
    }
    fs::create_dir_all(&selected).map_err(|error| format!("无法创建文件库目录：{error}"))?;
    let root = selected
        .canonicalize()
        .map_err(|error| format!("无法读取文件库目录：{error}"))?;
    if !root.is_dir() {
        return Err("所选路径不是文件夹。".to_string());
    }
    write_settings(
        &app,
        &LibrarySettings {
            root_path: Some(root.to_string_lossy().into_owned()),
        },
    )?;
    let snapshot = snapshot_for(&app, Some(root.clone()))?;
    let _ = start_library_watcher(&app, &root);
    Ok(snapshot)
}

#[tauri::command]
pub fn search_library(
    app: AppHandle,
    query: String,
    category: Option<String>,
) -> Result<Vec<MapDocument>, String> {
    let root = configured_root(&app)?;
    let Some(_root) = root else {
        return Ok(Vec::new());
    };
    let connection = open_database(&app)?;
    let query = query.trim().to_lowercase();
    let category = category.unwrap_or_default();
    let mut statement = connection
        .prepare(
            "SELECT id, relative_path, title, category, map_type, tags, created_at, updated_at
             FROM maps
             WHERE (?1 = '' OR instr(lower(title), ?1) > 0 OR instr(lower(category), ?1) > 0
                    OR instr(lower(map_type), ?1) > 0 OR instr(lower(tags), ?1) > 0
                    OR instr(lower(content), ?1) > 0)
               AND (?2 = '' OR category = ?2 OR substr(category, 1, length(?2) + 1) = ?2 || '/')
             ORDER BY updated_at DESC, title COLLATE NOCASE
             LIMIT ?3",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![query, category, MAX_SEARCH_RESULTS as i64], |row| {
            let tags_json: String = row.get(5)?;
            let tags = serde_json::from_str(&tags_json).unwrap_or_default();
            Ok(MapDocument {
                id: row.get(0)?,
                relative_path: row.get(1)?,
                title: row.get(2)?,
                category: row.get(3)?,
                map_type: row.get(4)?,
                tags,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(db_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

#[tauri::command]
pub fn open_document(app: AppHandle, relative_path: String) -> Result<OpenedDocument, String> {
    let root = require_root(&app)?;
    let relative = validate_markdown_path(&relative_path)?;
    let path = ensure_existing_inside_root(&root, &root.join(&relative))?;
    let content =
        fs::read_to_string(&path).map_err(|error| format!("无法打开思维导图：{error}"))?;
    if content.len() > MAX_DOCUMENT_BYTES {
        return Err("文件超过 5 MB，暂时无法在编辑器中打开。".to_string());
    }
    let relative_string = path_to_relative_string(&relative);
    let category = category_from_relative(&relative);
    let metadata = metadata_from_markdown(&content);
    let file_title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("未命名思维导图");
    let modified = modified_timestamp(&path);
    let fallback_map_type = default_map_type(&category);
    let tags = metadata
        .as_ref()
        .map(|meta| meta.tags.clone())
        .unwrap_or_default();
    let created_at = metadata
        .as_ref()
        .map(|meta| meta.created_at)
        .unwrap_or(modified);
    let updated_at = modified.max(metadata.as_ref().map(|meta| meta.updated_at).unwrap_or(0));
    let indexed_id = open_database(&app)?
        .query_row(
            "SELECT id FROM maps WHERE relative_path = ?1",
            params![relative_string],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    let document = MapDocument {
        id: indexed_id.unwrap_or_else(|| {
            metadata
                .as_ref()
                .map(|meta| meta.id.clone())
                .filter(|id| !id.is_empty())
                .unwrap_or_else(|| legacy_id(&relative_string))
        }),
        relative_path: relative_string,
        title: metadata
            .as_ref()
            .map(|meta| meta.title.clone())
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| first_heading(&content).unwrap_or_else(|| file_title.to_string())),
        category: category.clone(),
        map_type: metadata
            .as_ref()
            .map(|meta| meta.map_type.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or(fallback_map_type),
        tags,
        created_at,
        updated_at,
    };
    Ok(OpenedDocument {
        document,
        markdown: strip_metadata(&content).to_string(),
    })
}

#[tauri::command]
pub fn save_document(app: AppHandle, input: SaveDocumentInput) -> Result<MapDocument, String> {
    if input.markdown.len() > MAX_DOCUMENT_BYTES {
        return Err("思维导图超过 5 MB，无法保存。".to_string());
    }
    let markdown = input.markdown.trim().replace("\r\n", "\n");
    if markdown.is_empty() {
        return Err("思维导图内容不能为空。".to_string());
    }
    let title = input.title.trim();
    if title.is_empty() || title.chars().count() > 120 {
        return Err("标题不能为空，且最多 120 个字符。".to_string());
    }
    let title = title.to_string();
    let map_type = if input.map_type.trim().is_empty() {
        "通用".to_string()
    } else {
        input.map_type.trim().chars().take(40).collect::<String>()
    };
    let tags = normalize_tags(input.tags);
    let category = normalize_category(&input.category)?;
    let root = require_root(&app)?;
    let old_relative = input
        .relative_path
        .as_deref()
        .map(validate_markdown_path)
        .transpose()?;
    let old_absolute = old_relative
        .as_ref()
        .map(|relative| {
            let path = root.join(relative);
            if path.exists() {
                ensure_existing_inside_root(&root, &path)
            } else {
                Ok(path)
            }
        })
        .transpose()?;
    let previous_content = old_absolute
        .as_ref()
        .and_then(|path| fs::read_to_string(path).ok());
    let previous_meta = previous_content.as_deref().and_then(metadata_from_markdown);
    let id = input
        .id
        .filter(|id| !id.trim().is_empty())
        .or_else(|| previous_meta.as_ref().map(|meta| meta.id.clone()))
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = timestamp_now();
    let created_at = previous_meta
        .as_ref()
        .map(|meta| meta.created_at)
        .unwrap_or(now);
    let file_name = safe_file_stem(&title)?;
    let mut destination_relative = category_path(&category)?.join(format!("{file_name}.md"));
    if old_relative.is_none() {
        destination_relative = unique_path(&root, destination_relative)?;
    }
    let destination_candidate = root.join(&destination_relative);
    let existing_destination = if destination_candidate.exists() {
        Some(ensure_existing_inside_root(&root, &destination_candidate)?)
    } else {
        None
    };
    let same_existing_file = existing_destination
        .as_ref()
        .is_some_and(|destination| old_absolute.as_ref() == Some(destination));
    if existing_destination.is_some() && !same_existing_file {
        return Err("目标分类中已存在同名思维导图，请修改标题或分类。".to_string());
    }
    let parent_relative = destination_relative
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let parent = create_directory_inside_root(&root, parent_relative)?;
    let file_name = destination_relative
        .file_name()
        .ok_or_else(|| "思维导图文件名无效。".to_string())?;
    let destination = parent.join(file_name);
    if destination.exists() {
        ensure_existing_inside_root(&root, &destination)?;
    }

    let document = MapDocument {
        id: id.clone(),
        relative_path: path_to_relative_string(&destination_relative),
        title: title.clone(),
        category: category.clone(),
        map_type: map_type.clone(),
        tags: tags.clone(),
        created_at,
        updated_at: now,
    };
    let metadata = DocumentMetadata {
        id,
        title,
        map_type,
        tags: tags.clone(),
        created_at,
        updated_at: now,
    };
    let metadata_json = serde_json::to_string(&metadata)
        .map_err(|error| error.to_string())?
        .replace("-->", "--\\u003e");
    let file_content = format!("{META_PREFIX}{metadata_json} -->\n\n{markdown}\n");
    write_atomically(&destination, file_content.as_bytes())?;
    if let Some(old) = old_absolute {
        if !same_existing_file && old != destination && old.exists() {
            fs::remove_file(old)
                .map_err(|error| format!("已保存新文件，但无法移除旧文件：{error}"))?;
            remove_empty_parent_directories(&root, old_relative.as_deref());
        }
    }
    upsert_document(&app, &document, &markdown)?;
    Ok(document)
}

#[tauri::command]
pub fn delete_document(app: AppHandle, relative_path: String) -> Result<(), String> {
    let root = require_root(&app)?;
    let relative = validate_markdown_path(&relative_path)?;
    let path = ensure_existing_inside_root(&root, &root.join(&relative))?;
    fs::remove_file(&path).map_err(|error| format!("无法删除思维导图：{error}"))?;
    let connection = open_database(&app)?;
    connection
        .execute(
            "DELETE FROM maps WHERE relative_path = ?1",
            params![path_to_relative_string(&relative)],
        )
        .map_err(db_error)?;
    remove_empty_parent_directories(&root, Some(&relative));
    Ok(())
}

#[tauri::command]
pub fn create_category(app: AppHandle, category: String) -> Result<LibrarySnapshot, String> {
    let root = require_root(&app)?;
    let category = normalize_category(&category)?;
    let relative = category_path(&category)?;
    let _directory = create_directory_inside_root(&root, &relative)?;
    snapshot_for(&app, Some(root))
}

#[tauri::command]
pub fn rebuild_library_index(app: AppHandle) -> Result<LibrarySnapshot, String> {
    let root = configured_root(&app)?;
    snapshot_for(&app, root)
}

fn start_library_watcher(app: &AppHandle, root: &Path) -> Result<(), String> {
    let (sender, receiver) = mpsc::channel::<()>();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event.is_ok() {
            let _ = sender.send(());
        }
    })
    .map_err(|error| format!("无法监控文件库变化：{error}"))?;
    watcher
        .watch(root, notify::RecursiveMode::Recursive)
        .map_err(|error| format!("无法监控文件库目录：{error}"))?;

    let state = app.state::<WatcherState>();
    let previous = state
        .watcher
        .lock()
        .map_err(|_| "文件库监控状态异常。".to_string())?
        .replace(watcher);
    drop(previous);

    let app = app.clone();
    let root = root.to_path_buf();
    thread::spawn(move || {
        while receiver.recv().is_ok() {
            loop {
                match receiver.recv_timeout(Duration::from_millis(450)) {
                    Ok(()) => continue,
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            if configured_root(&app).ok().flatten().as_deref() != Some(root.as_path()) {
                continue;
            }
            if let Ok(snapshot) = snapshot_for(&app, Some(root.clone())) {
                let _ = app.emit("library-changed", snapshot);
            }
        }
    });
    Ok(())
}

fn snapshot_for(app: &AppHandle, root: Option<PathBuf>) -> Result<LibrarySnapshot, String> {
    let Some(root) = root else {
        return Ok(LibrarySnapshot {
            root_path: None,
            documents: Vec::new(),
            categories: Vec::new(),
        });
    };
    fs::create_dir_all(&root).map_err(|error| format!("无法访问文件库目录：{error}"))?;
    let (documents, categories) = scan_library(&root)?;
    replace_index(app, &documents, &root)?;
    Ok(LibrarySnapshot {
        root_path: Some(root.to_string_lossy().into_owned()),
        documents,
        categories,
    })
}

fn configured_root(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let settings = read_settings(app)?;
    if let Some(path) = settings.root_path {
        let root = PathBuf::from(path);
        if !root.is_dir() {
            return Err(format!(
                "找不到已配置的文件库目录：{}。请重新选择文件库位置。",
                root.display()
            ));
        }
        return root
            .canonicalize()
            .map(Some)
            .map_err(|error| format!("无法读取文件库目录：{error}"));
    }
    let documents = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_local_data_dir())
        .map_err(|error| format!("无法确定文件库默认位置：{error}"))?;
    let root = documents.join("Markmap Library");
    fs::create_dir_all(&root).map_err(|error| format!("无法创建默认文件库：{error}"))?;
    let root = root
        .canonicalize()
        .map_err(|error| format!("无法读取默认文件库：{error}"))?;
    write_settings(
        app,
        &LibrarySettings {
            root_path: Some(root.to_string_lossy().into_owned()),
        },
    )?;
    Ok(Some(root))
}

fn require_root(app: &AppHandle) -> Result<PathBuf, String> {
    configured_root(app)?.ok_or_else(|| "请先设置文件库目录。".to_string())
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位应用设置目录：{error}"))?;
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建应用设置目录：{error}"))?;
    Ok(directory.join(SETTINGS_FILE))
}

fn read_settings(app: &AppHandle) -> Result<LibrarySettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(LibrarySettings::default());
    }
    let text = fs::read_to_string(path).map_err(|error| format!("无法读取文件库设置：{error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("文件库设置格式无效：{error}"))
}

fn write_settings(app: &AppHandle, settings: &LibrarySettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let contents = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    write_atomically(&path, &contents)
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法定位 SQLite 数据目录：{error}"))?;
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建 SQLite 数据目录：{error}"))?;
    Ok(directory.join(DATABASE_FILE))
}

fn open_database(app: &AppHandle) -> Result<Connection, String> {
    let connection = Connection::open(database_path(app)?).map_err(db_error)?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA busy_timeout = 3000;
             CREATE TABLE IF NOT EXISTS maps (
                 id TEXT PRIMARY KEY NOT NULL,
                 relative_path TEXT NOT NULL UNIQUE,
                 title TEXT NOT NULL,
                 category TEXT NOT NULL,
                 map_type TEXT NOT NULL,
                 tags TEXT NOT NULL,
                 content TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_maps_updated ON maps(updated_at DESC);
             CREATE INDEX IF NOT EXISTS idx_maps_category ON maps(category);
             CREATE INDEX IF NOT EXISTS idx_maps_type ON maps(map_type);",
        )
        .map_err(db_error)?;
    Ok(connection)
}

fn replace_index(app: &AppHandle, documents: &[MapDocument], root: &Path) -> Result<(), String> {
    let connection = open_database(app)?;
    let transaction = connection.unchecked_transaction().map_err(db_error)?;
    transaction
        .execute("DELETE FROM maps", [])
        .map_err(db_error)?;
    for document in documents {
        let path = root.join(validate_markdown_path(&document.relative_path)?);
        let raw =
            fs::read_to_string(path).map_err(|error| format!("重建索引时无法读取文件：{error}"))?;
        upsert_with_connection(&transaction, document, strip_metadata(&raw))?;
    }
    transaction.commit().map_err(db_error)
}

fn upsert_document(app: &AppHandle, document: &MapDocument, markdown: &str) -> Result<(), String> {
    let connection = open_database(app)?;
    upsert_with_connection(&connection, document, markdown)
}

fn upsert_with_connection(
    connection: &Connection,
    document: &MapDocument,
    markdown: &str,
) -> Result<(), String> {
    let tags = serde_json::to_string(&document.tags).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO maps (id, relative_path, title, category, map_type, tags, content, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
               relative_path = excluded.relative_path,
               title = excluded.title,
               category = excluded.category,
               map_type = excluded.map_type,
               tags = excluded.tags,
               content = excluded.content,
               updated_at = excluded.updated_at",
            params![
                document.id,
                document.relative_path,
                document.title,
                document.category,
                document.map_type,
                tags,
                markdown,
                document.created_at,
                document.updated_at,
            ],
        )
        .map_err(db_error)?;
    Ok(())
}

fn scan_library(root: &Path) -> Result<(Vec<MapDocument>, Vec<String>), String> {
    let mut documents = Vec::new();
    let mut categories = Vec::new();
    scan_directory(root, root, &mut documents, &mut categories)?;
    let mut ids = HashSet::new();
    for document in &mut documents {
        if ids.insert(document.id.clone()) {
            continue;
        }
        let base = legacy_id(&document.relative_path);
        let mut candidate = base.clone();
        let mut suffix = 2;
        while !ids.insert(candidate.clone()) {
            candidate = format!("{base}:{suffix}");
            suffix += 1;
        }
        document.id = candidate;
    }
    documents.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    categories.sort_by_key(|category| category.to_lowercase());
    categories.dedup();
    Ok((documents, categories))
}

fn scan_directory(
    root: &Path,
    directory: &Path,
    documents: &mut Vec<MapDocument>,
    categories: &mut Vec<String>,
) -> Result<(), String> {
    let entries = fs::read_dir(directory).map_err(|error| format!("无法读取文件库：{error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("无法读取文件库项目：{error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("无法读取文件属性：{error}"))?;
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "分类目录超出了文件库位置。".to_string())?;
            let category = path_to_relative_string(relative);
            categories.push(category);
            scan_directory(root, &path, documents, categories)?;
        } else if file_type.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
        {
            if documents.len() >= MAX_DOCUMENTS {
                return Err(format!(
                    "文件库超过 {} 个 Markdown 文件，已停止索引。",
                    MAX_DOCUMENTS
                ));
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "思维导图文件超出了文件库位置。".to_string())?;
            let relative_path = path_to_relative_string(relative);
            let content = fs::read_to_string(&path)
                .map_err(|error| format!("无法读取思维导图 {relative_path}：{error}"))?;
            if content.len() > MAX_DOCUMENT_BYTES {
                continue;
            }
            let category = category_from_relative(relative);
            let metadata = metadata_from_markdown(&content);
            let fallback_title = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("未命名思维导图")
                .to_string();
            let modified = modified_timestamp(&path);
            let fallback_map_type = default_map_type(&category);
            let tags = metadata
                .as_ref()
                .map(|meta| meta.tags.clone())
                .unwrap_or_default();
            let created_at = metadata
                .as_ref()
                .map(|meta| meta.created_at)
                .unwrap_or(modified);
            let updated_at =
                modified.max(metadata.as_ref().map(|meta| meta.updated_at).unwrap_or(0));
            documents.push(MapDocument {
                id: metadata
                    .as_ref()
                    .map(|meta| meta.id.clone())
                    .filter(|id| !id.is_empty())
                    .unwrap_or_else(|| legacy_id(&relative_path)),
                relative_path,
                title: metadata
                    .as_ref()
                    .map(|meta| meta.title.clone())
                    .filter(|title| !title.is_empty())
                    .unwrap_or_else(|| first_heading(&content).unwrap_or(fallback_title)),
                category: category.clone(),
                map_type: metadata
                    .as_ref()
                    .map(|meta| meta.map_type.clone())
                    .filter(|value| !value.is_empty())
                    .unwrap_or(fallback_map_type),
                tags,
                created_at,
                updated_at,
            });
        }
    }
    Ok(())
}

fn metadata_from_markdown(markdown: &str) -> Option<DocumentMetadata> {
    let first_line = markdown
        .trim_start_matches('\u{feff}')
        .lines()
        .next()?
        .trim();
    let json = first_line.strip_prefix(META_PREFIX)?.strip_suffix(" -->")?;
    serde_json::from_str(json).ok()
}

fn strip_metadata(markdown: &str) -> &str {
    let normalized = markdown.trim_start_matches('\u{feff}');
    let Some((first_line, remaining)) = normalized.split_once('\n') else {
        return normalized;
    };
    if first_line.trim().starts_with(META_PREFIX) {
        remaining.trim_start_matches('\n')
    } else {
        normalized
    }
}

fn first_heading(markdown: &str) -> Option<String> {
    markdown.lines().find_map(|line| {
        let trimmed = line.trim();
        trimmed
            .strip_prefix("# ")
            .or_else(|| trimmed.strip_prefix("## "))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut normalized: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag.trim();
        if !tag.is_empty()
            && !normalized
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(tag))
        {
            normalized.push(tag.chars().take(40).collect());
        }
        if normalized.len() == 20 {
            break;
        }
    }
    normalized
}

fn normalize_category(value: &str) -> Result<String, String> {
    let normalized = value.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Ok("未分类".to_string());
    }
    let segments = normalized.split('/').collect::<Vec<_>>();
    if segments.len() > 16 {
        return Err("分类目录最多支持 16 层。".to_string());
    }
    let mut normalized_segments = Vec::with_capacity(segments.len());
    for segment in segments {
        if segment.trim().is_empty() || segment.trim() == "." || segment.trim() == ".." {
            return Err("分类名称中含有无效目录。".to_string());
        }
        normalized_segments.push(validate_name(segment)?);
    }
    Ok(normalized_segments.join("/"))
}

fn category_path(category: &str) -> Result<PathBuf, String> {
    let normalized = normalize_category(category)?;
    let mut path = PathBuf::new();
    for segment in normalized.split('/') {
        path.push(validate_name(segment)?);
    }
    Ok(path)
}

fn safe_file_stem(title: &str) -> Result<String, String> {
    let mut result = String::new();
    let mut previous_space = false;
    for ch in title.trim().chars() {
        let replace =
            matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || ch.is_control();
        let value = if replace { ' ' } else { ch };
        if value.is_whitespace() {
            if !previous_space {
                result.push(' ');
            }
            previous_space = true;
        } else {
            result.push(value);
            previous_space = false;
        }
    }
    let result = result.trim().trim_end_matches('.').trim_end().to_string();
    validate_name(&result)
}

fn validate_name(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('.').trim_end();
    if value.is_empty()
        || value.chars().any(|ch| {
            matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || ch.is_control()
        })
    {
        return Err("文件名或分类名含有 Windows 不支持的字符。".to_string());
    }
    let stem = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit())
    {
        return Err("该名称是 Windows 保留设备名，请换一个名称。".to_string());
    }
    Ok(value.to_string())
}

fn validate_markdown_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err("思维导图路径无效。".to_string());
    }
    for component in path.components() {
        match component {
            Component::Normal(name) => {
                let name = name
                    .to_str()
                    .ok_or_else(|| "思维导图路径包含无效字符。".to_string())?;
                validate_name(name)?;
            }
            _ => return Err("思维导图路径不能离开文件库目录。".to_string()),
        }
    }
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    {
        return Err("文件库只支持 Markdown 思维导图文件。".to_string());
    }
    Ok(path.to_path_buf())
}

fn ensure_existing_inside_root(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("无法读取文件库根目录：{error}"))?;
    let canonical_path = path
        .canonicalize()
        .map_err(|error| format!("找不到思维导图文件：{error}"))?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err("思维导图文件不能离开文件库目录。".to_string());
    }
    Ok(canonical_path)
}

fn create_directory_inside_root(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("无法读取文件库根目录：{error}"))?;
    let mut current = canonical_root.clone();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("分类目录不能离开文件库位置。".to_string());
        };
        let name = name
            .to_str()
            .ok_or_else(|| "分类目录包含无效字符。".to_string())?;
        validate_name(name)?;
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if !metadata.is_dir() {
                    return Err("分类路径中存在同名文件。".to_string());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|error| format!("无法创建分类文件夹：{error}"))?;
            }
            Err(error) => return Err(format!("无法读取分类目录：{error}")),
        }
        let canonical = current
            .canonicalize()
            .map_err(|error| format!("无法解析分类目录：{error}"))?;
        if !canonical.starts_with(&canonical_root) {
            return Err("分类目录不能离开文件库位置。".to_string());
        }
        current = canonical;
    }
    Ok(current)
}

fn unique_path(root: &Path, requested: PathBuf) -> Result<PathBuf, String> {
    if !root.join(&requested).exists() {
        return Ok(requested);
    }
    let parent = requested.parent().unwrap_or_else(|| Path::new(""));
    let stem = requested
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("思维导图");
    for number in 2..=9_999 {
        let candidate = parent.join(format!("{stem} ({number}).md"));
        if !root.join(&candidate).exists() {
            return Ok(candidate);
        }
    }
    Err("同名思维导图过多，无法生成新文件名。".to_string())
}

fn write_atomically(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "文件没有有效的父目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建文件夹：{error}"))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("document.md");
    let token = Uuid::new_v4().simple().to_string();
    let temporary = parent.join(format!(".{file_name}.{token}.tmp"));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("无法创建临时保存文件：{error}"))?;
    if let Err(error) = file.write_all(contents).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法写入思维导图：{error}"));
    }
    drop(file);

    if path.exists() {
        let backup = parent.join(format!(".{file_name}.{token}.bak"));
        fs::rename(path, &backup).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            format!("无法安全替换旧文件：{error}")
        })?;
        if let Err(error) = fs::rename(&temporary, path) {
            let _ = fs::rename(&backup, path);
            let _ = fs::remove_file(&temporary);
            return Err(format!("无法完成文件保存：{error}"));
        }
        let _ = fs::remove_file(backup);
    } else if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法完成文件保存：{error}"));
    }
    Ok(())
}

fn path_to_relative_string(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn category_from_relative(relative: &Path) -> String {
    let parent = relative.parent().unwrap_or_else(|| Path::new(""));
    path_to_relative_string(parent)
}

fn default_map_type(category: &str) -> String {
    category
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("通用")
        .to_string()
}

fn timestamp_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn modified_timestamp(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or_else(timestamp_now)
}

fn legacy_id(relative_path: &str) -> String {
    format!("legacy:{relative_path}")
}

fn remove_empty_parent_directories(root: &Path, relative: Option<&Path>) {
    let Some(relative) = relative else { return };
    let Some(mut directory) = root.join(relative).parent().map(Path::to_path_buf) else {
        return;
    };
    while directory != root && directory.starts_with(root) {
        match fs::remove_dir(&directory) {
            Ok(()) => {
                let Some(parent) = directory.parent().map(Path::to_path_buf) else {
                    break;
                };
                directory = parent;
            }
            Err(_) => break,
        }
    }
}

fn db_error(error: rusqlite::Error) -> String {
    format!("SQLite 文件库错误：{error}")
}
