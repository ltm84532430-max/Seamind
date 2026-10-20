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
const HISTORY_DATABASE_FILE: &str = "document-history.sqlite3";
const META_PREFIX: &str = "<!-- markmap-desktop: ";
const MAX_DOCUMENT_BYTES: usize = 5 * 1024 * 1024;
const MAX_HTML_ASSET_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_HTML_ASSET_BUNDLE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_HTML_ASSET_FILES: usize = 2_000;
const MAX_GENERATED_HTML_ASSET_BYTES: usize = 256 * 1024;
const MAX_GENERATED_HTML_ASSETS: usize = 8;
const MAX_DOCUMENTS: usize = 50_000;
const MAX_EPUB_BOOKS: usize = 10_000;
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
pub struct EpubBookDocument {
    pub relative_path: String,
    pub title: String,
    pub category: String,
    pub file_size: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySnapshot {
    pub root_path: Option<String>,
    pub documents: Vec<MapDocument>,
    pub books: Vec<EpubBookDocument>,
    pub categories: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    pub document: MapDocument,
    pub markdown: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHtmlAsset {
    pub asset_id: String,
    pub entry_path: String,
    pub title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedHtmlAssetInput {
    pub asset_id: String,
    pub entry_path: String,
    pub title: String,
    pub html: String,
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
    pub history_source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentVersion {
    pub version_id: String,
    pub document_id: String,
    pub relative_path: String,
    pub title: String,
    pub category: String,
    pub map_type: String,
    pub tags: Vec<String>,
    pub source: String,
    pub created_at: u64,
    pub markdown_bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentVersionSnapshot {
    #[serde(flatten)]
    pub version: DocumentVersion,
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
    let markdown = strip_metadata(&content).to_string();
    let _ = record_document_version(&app, &document, &markdown, "baseline");
    Ok(OpenedDocument { document, markdown })
}

#[tauri::command]
pub fn open_epub_book(app: AppHandle, relative_path: String) -> Result<String, String> {
    let root = require_root(&app)?;
    let relative = validate_epub_path(&relative_path)?;
    let path = ensure_existing_inside_root(&root, &root.join(&relative))?;
    if !path.is_file() {
        return Err("找不到 EPUB 电子书文件。".to_string());
    }
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|error| format!("无法授权读取 EPUB 文件：{error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn delete_epub_book(app: AppHandle, relative_path: String) -> Result<(), String> {
    let root = require_root(&app)?;
    let relative = validate_epub_path(&relative_path)?;
    if !relative.starts_with("books") {
        return Err("只能删除书架中的 EPUB 文件。".to_string());
    }
    let path = ensure_existing_inside_root(&root, &root.join(&relative))?;
    if !path.is_file() {
        return Err("找不到要删除的 EPUB 文件。".to_string());
    }
    fs::remove_file(&path).map_err(|error| format!("无法删除 EPUB 文件：{error}"))?;
    Ok(())
}

#[tauri::command]
pub fn import_epub_book(app: AppHandle, source_path: String) -> Result<EpubBookDocument, String> {
    let root = require_root(&app)?;
    let source = PathBuf::from(source_path);
    if !source.is_file()
        || !source
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("epub"))
    {
        return Err("请选择有效的 EPUB 电子书文件。".to_string());
    }

    let source_name = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("未命名电子书");
    let title = safe_file_stem(source_name)?;
    let books_directory = root.join("books");
    fs::create_dir_all(&books_directory)
        .map_err(|error| format!("无法创建电子书书架目录：{error}"))?;

    let mut destination = books_directory.join(format!("{title}.epub"));
    if destination.exists() {
        let mut available = None;
        for number in 2..=9_999 {
            let candidate = books_directory.join(format!("{title} ({number}).epub"));
            if !candidate.exists() {
                available = Some(candidate);
                break;
            }
        }
        destination = available.ok_or_else(|| "同名电子书过多，无法导入。".to_string())?;
    }

    let temporary = books_directory.join(format!(".import-{}.tmp", Uuid::new_v4().simple()));
    if let Err(error) = fs::copy(&source, &temporary) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法复制 EPUB 到书架：{error}"));
    }
    if let Err(error) = fs::rename(&temporary, &destination) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法完成 EPUB 导入：{error}"));
    }
    let relative = destination
        .strip_prefix(&root)
        .map_err(|_| "电子书保存位置超出了文件库。".to_string())?;
    let relative_path = path_to_relative_string(relative);
    let metadata = fs::metadata(&destination)
        .map_err(|error| format!("无法读取已导入电子书的信息：{error}"))?;

    Ok(EpubBookDocument {
        relative_path,
        title,
        category: category_from_relative(relative),
        file_size: metadata.len(),
        updated_at: modified_timestamp(&destination),
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
    let history_source = match input.history_source.as_deref() {
        Some("manual") => "manual",
        Some("restore") => "restore",
        _ => "autosave",
    };
    record_document_version(&app, &document, &markdown, history_source)
        .map_err(|error| format!("文件已保存，但版本历史写入失败：{error}"))?;
    upsert_document(&app, &document, &markdown)?;
    Ok(document)
}

#[tauri::command]
pub fn list_document_versions(
    app: AppHandle,
    document_id: String,
) -> Result<Vec<DocumentVersion>, String> {
    if document_id.trim().is_empty() {
        return Err("当前思维导图没有可用的文件 ID。".to_string());
    }
    let connection = open_history_database(&app)?;
    let mut statement = connection
        .prepare(
            "SELECT version_id, document_id, relative_path, title, category, map_type,
                    tags, source, created_at, length(CAST(markdown AS BLOB))
             FROM document_versions
             WHERE document_id = ?1
             ORDER BY created_at DESC, rowid DESC",
        )
        .map_err(history_db_error)?;
    let rows = statement
        .query_map(params![document_id], |row| {
            let tags_json: String = row.get(6)?;
            Ok(DocumentVersion {
                version_id: row.get(0)?,
                document_id: row.get(1)?,
                relative_path: row.get(2)?,
                title: row.get(3)?,
                category: row.get(4)?,
                map_type: row.get(5)?,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                source: row.get(7)?,
                created_at: row.get(8)?,
                markdown_bytes: row.get::<_, i64>(9)?.max(0) as usize,
            })
        })
        .map_err(history_db_error)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(history_db_error)
}

#[tauri::command]
pub fn load_document_version(
    app: AppHandle,
    document_id: String,
    version_id: String,
) -> Result<DocumentVersionSnapshot, String> {
    let connection = open_history_database(&app)?;
    let row = connection
        .query_row(
            "SELECT version_id, document_id, relative_path, title, category, map_type,
                    tags, source, created_at, length(CAST(markdown AS BLOB)), markdown
             FROM document_versions
             WHERE document_id = ?1 AND version_id = ?2",
            params![document_id, version_id],
            |row| {
                let tags_json: String = row.get(6)?;
                Ok(DocumentVersionSnapshot {
                    version: DocumentVersion {
                        version_id: row.get(0)?,
                        document_id: row.get(1)?,
                        relative_path: row.get(2)?,
                        title: row.get(3)?,
                        category: row.get(4)?,
                        map_type: row.get(5)?,
                        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                        source: row.get(7)?,
                        created_at: row.get(8)?,
                        markdown_bytes: row.get::<_, i64>(9)?.max(0) as usize,
                    },
                    markdown: row.get(10)?,
                })
            },
        )
        .optional()
        .map_err(history_db_error)?
        .ok_or_else(|| "找不到所选的历史版本。".to_string())?;
    Ok(row)
}

#[tauri::command]
pub fn restore_document_version(
    app: AppHandle,
    document_id: String,
    relative_path: String,
    version_id: String,
) -> Result<OpenedDocument, String> {
    let snapshot = load_document_version(app.clone(), document_id.clone(), version_id)?;
    if snapshot.version.document_id != document_id {
        return Err("所选版本不属于当前思维导图。".to_string());
    }
    let root = require_root(&app)?;
    let current_relative = validate_markdown_path(&relative_path)?;
    let current_path = root.join(&current_relative);
    if current_path.exists() {
        let current_path = ensure_existing_inside_root(&root, &current_path)?;
        let current_content = fs::read_to_string(&current_path)
            .map_err(|error| format!("无法校验当前思维导图：{error}"))?;
        let current_id = metadata_from_markdown(&current_content)
            .map(|metadata| metadata.id)
            .unwrap_or_else(|| legacy_id(&path_to_relative_string(&current_relative)));
        if current_id != document_id {
            return Err("当前文件已变化，请重新打开思维导图后再恢复。".to_string());
        }
        let current = open_document(app.clone(), path_to_relative_string(&current_relative))?;
        record_document_version(&app, &current.document, &current.markdown, "manual")
            .map_err(|error| format!("无法保留当前版本，未执行恢复：{error}"))?;
    }
    let restored = save_document(
        app.clone(),
        SaveDocumentInput {
            id: Some(document_id),
            relative_path: Some(path_to_relative_string(&current_relative)),
            title: snapshot.version.title,
            category: snapshot.version.category,
            map_type: snapshot.version.map_type,
            tags: snapshot.version.tags,
            markdown: snapshot.markdown,
            history_source: Some("restore".to_string()),
        },
    )?;
    open_document(app, restored.relative_path)
}

#[tauri::command]
pub fn import_html_asset(
    app: AppHandle,
    document_relative_path: String,
    source_path: String,
) -> Result<ImportedHtmlAsset, String> {
    let root = require_root(&app)?;
    let document_relative = validate_markdown_path(&document_relative_path)?;
    let document_path = ensure_existing_inside_root(&root, &root.join(&document_relative))?;
    let document_markdown = fs::read_to_string(&document_path)
        .map_err(|error| format!("无法读取当前思维导图：{error}"))?;
    let document_id = metadata_from_markdown(&document_markdown)
        .map(|metadata| metadata.id)
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| legacy_id(&path_to_relative_string(&document_relative)));

    let selected_path = PathBuf::from(source_path.trim());
    let selected_metadata = fs::symlink_metadata(&selected_path)
        .map_err(|error| format!("无法读取所选 HTML 文件：{error}"))?;
    if selected_metadata.file_type().is_symlink() || !selected_metadata.is_file() {
        return Err("请选择普通 HTML 文件，不能选择符号链接。".to_string());
    }
    let selected_path = selected_path
        .canonicalize()
        .map_err(|error| format!("无法解析所选 HTML 文件：{error}"))?;
    let extension = selected_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !extension.eq_ignore_ascii_case("html") && !extension.eq_ignore_ascii_case("htm") {
        return Err("请选择 .html 或 .htm 文件。".to_string());
    }
    let source_root = selected_path
        .parent()
        .ok_or_else(|| "无法确定 HTML 文件所在目录。".to_string())?
        .to_path_buf();
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("无法读取文件库目录：{error}"))?;
    if source_root.starts_with(&canonical_root) || canonical_root.starts_with(&source_root) {
        return Err("请从文件库目录之外选择 HTML 文件，避免重复导入文件库内容。".to_string());
    }
    let entry_path = PathBuf::from(
        selected_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "HTML 文件名包含无效字符。".to_string())?,
    );
    validate_html_entry_path(&path_to_relative_string(&entry_path))?;

    let asset_id = Uuid::new_v4();
    let bundle_relative = Path::new("assets")
        .join(asset_owner_directory_name(&document_id))
        .join(asset_id.to_string());
    let bundle_directory = create_directory_inside_root(&root, &bundle_relative)?;
    let mut copy_state = HtmlBundleCopyState::default();
    if let Err(error) = copy_html_bundle_directory(
        &source_root,
        &source_root,
        &bundle_relative,
        &root,
        &entry_path,
        &mut copy_state,
    ) {
        let _ = fs::remove_dir_all(&bundle_directory);
        return Err(error);
    }
    if !copy_state.entry_copied {
        let _ = fs::remove_dir_all(&bundle_directory);
        return Err("没有成功复制 HTML 入口文件。".to_string());
    }

    let file_stem = entry_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("HTML 组件");
    let title = if file_stem.eq_ignore_ascii_case("index") {
        source_root
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(file_stem)
            .to_string()
    } else {
        file_stem.to_string()
    };

    Ok(ImportedHtmlAsset {
        asset_id: asset_id.to_string(),
        entry_path: path_to_relative_string(&entry_path),
        title,
    })
}

#[tauri::command]
pub fn save_generated_html_assets(
    app: AppHandle,
    document_relative_path: String,
    assets: Vec<GeneratedHtmlAssetInput>,
) -> Result<Vec<ImportedHtmlAsset>, String> {
    if assets.len() > MAX_GENERATED_HTML_ASSETS {
        return Err("一次生成的 HTML 资源数量超过上限。".to_string());
    }
    if assets.is_empty() {
        return Ok(Vec::new());
    }
    let root = require_root(&app)?;
    let document_relative = validate_markdown_path(&document_relative_path)?;
    let document_path = ensure_existing_inside_root(&root, &root.join(&document_relative))?;
    let document_markdown = fs::read_to_string(&document_path)
        .map_err(|error| format!("无法读取当前思维导图：{error}"))?;
    let document_id = metadata_from_markdown(&document_markdown)
        .map(|metadata| metadata.id)
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| legacy_id(&path_to_relative_string(&document_relative)));
    let owner = asset_owner_directory_name(&document_id);
    let mut seen = HashSet::new();
    let mut created_directories = Vec::<PathBuf>::new();
    let mut saved = Vec::with_capacity(assets.len());

    let result = (|| {
        for asset in assets {
            let asset_id = Uuid::parse_str(asset.asset_id.trim())
                .map_err(|_| "生成的 HTML 资源编号无效。".to_string())?;
            if !seen.insert(asset_id) {
                return Err("生成的 HTML 资源编号重复。".to_string());
            }
            if asset.html.trim().is_empty()
                || asset.html.as_bytes().len() > MAX_GENERATED_HTML_ASSET_BYTES
            {
                return Err(format!(
                    "HTML「{}」内容为空或超过 {} KB。",
                    asset.title,
                    MAX_GENERATED_HTML_ASSET_BYTES / 1024
                ));
            }
            if asset.title.trim().is_empty() || asset.title.chars().count() > 120 {
                return Err("生成的 HTML 标题必须为 1 到 120 个字符。".to_string());
            }
            let entry_relative = validate_html_entry_path(&asset.entry_path)?;
            if entry_relative.components().count() != 1
                || !asset.entry_path.eq_ignore_ascii_case("index.html")
            {
                return Err("生成的 HTML 入口只能使用 index.html。".to_string());
            }
            let bundle_relative = Path::new("assets").join(&owner).join(asset_id.to_string());
            if fs::symlink_metadata(root.join(&bundle_relative)).is_ok() {
                return Err("生成的 HTML 资源编号已存在。".to_string());
            }
            let bundle_directory = create_directory_inside_root(&root, &bundle_relative)?;
            created_directories.push(bundle_directory.clone());
            write_atomically(
                &bundle_directory.join(".seamind-generated"),
                asset_id.to_string().as_bytes(),
            )?;
            write_atomically(
                &bundle_directory.join(&entry_relative),
                asset.html.as_bytes(),
            )?;
            saved.push(ImportedHtmlAsset {
                asset_id: asset_id.to_string(),
                entry_path: path_to_relative_string(&entry_relative),
                title: asset.title.trim().to_string(),
            });
        }
        Ok(saved)
    })();

    if result.is_err() {
        for directory in created_directories.into_iter().rev() {
            let _ = fs::remove_dir_all(directory);
        }
    }
    result
}

#[tauri::command]
pub fn discard_generated_html_assets(
    app: AppHandle,
    document_relative_path: String,
    asset_ids: Vec<String>,
) -> Result<(), String> {
    if asset_ids.len() > MAX_GENERATED_HTML_ASSETS {
        return Err("HTML 资源清理数量超过上限。".to_string());
    }
    if asset_ids.is_empty() {
        return Ok(());
    }
    let root = require_root(&app)?;
    let document_relative = validate_markdown_path(&document_relative_path)?;
    let document_path = ensure_existing_inside_root(&root, &root.join(&document_relative))?;
    let document_markdown = fs::read_to_string(&document_path)
        .map_err(|error| format!("无法读取当前思维导图：{error}"))?;
    let document_id = metadata_from_markdown(&document_markdown)
        .map(|metadata| metadata.id)
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| legacy_id(&path_to_relative_string(&document_relative)));
    let owner = asset_owner_directory_name(&document_id);
    let mut seen = HashSet::new();
    for value in asset_ids {
        let asset_id =
            Uuid::parse_str(value.trim()).map_err(|_| "HTML 资源编号无效。".to_string())?;
        if !seen.insert(asset_id) {
            continue;
        }
        let relative = Path::new("assets").join(&owner).join(asset_id.to_string());
        let path = root.join(relative);
        let Ok(path) = ensure_existing_inside_root(&root, &path) else {
            continue;
        };
        let marker = path.join(".seamind-generated");
        let Ok(metadata) = fs::symlink_metadata(&marker) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        fs::remove_dir_all(path).map_err(|error| format!("无法清理未应用的 HTML 资源：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn resolve_html_asset(
    app: AppHandle,
    document_relative_path: String,
    asset_id: String,
    entry_path: String,
) -> Result<String, String> {
    let root = require_root(&app)?;
    let document_relative = validate_markdown_path(&document_relative_path)?;
    let document_path = ensure_existing_inside_root(&root, &root.join(&document_relative))?;
    let document_markdown = fs::read_to_string(&document_path)
        .map_err(|error| format!("无法读取当前思维导图：{error}"))?;
    let document_id = metadata_from_markdown(&document_markdown)
        .map(|metadata| metadata.id)
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| legacy_id(&path_to_relative_string(&document_relative)));
    let asset_id = Uuid::parse_str(asset_id.trim())
        .map_err(|_| "HTML 卡片引用的资源编号无效。".to_string())?;
    let entry_relative = validate_html_entry_path(&entry_path)?;
    let bundle_relative = Path::new("assets")
        .join(asset_owner_directory_name(&document_id))
        .join(asset_id.to_string());
    let bundle_directory = ensure_existing_inside_root(&root, &root.join(bundle_relative))?;
    if !bundle_directory.is_dir() {
        return Err("找不到该 HTML 卡片的资源文件夹。".to_string());
    }
    let entry_file = ensure_existing_inside_root(&root, &bundle_directory.join(entry_relative))?;
    if !entry_file.starts_with(&bundle_directory) || !entry_file.is_file() {
        return Err("HTML 卡片入口文件不在资源文件夹内。".to_string());
    }

    app.asset_protocol_scope()
        .allow_directory(&bundle_directory, true)
        .map_err(|error| format!("无法授权读取 HTML 资源：{error}"))?;
    Ok(entry_file.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn delete_document(app: AppHandle, relative_path: String) -> Result<(), String> {
    let root = require_root(&app)?;
    let relative = validate_markdown_path(&relative_path)?;
    let path = ensure_existing_inside_root(&root, &root.join(&relative))?;
    let relative_string = path_to_relative_string(&relative);
    let connection = open_database(&app)?;
    let indexed_document_id: Option<String> = connection
        .query_row(
            "SELECT id FROM maps WHERE relative_path = ?1",
            params![relative_string],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    fs::remove_file(&path).map_err(|error| format!("无法删除思维导图：{error}"))?;
    connection
        .execute(
            "DELETE FROM maps WHERE relative_path = ?1",
            params![relative_string],
        )
        .map_err(db_error)?;
    if let Some(document_id) = indexed_document_id {
        let asset_owner = Path::new("assets").join(asset_owner_directory_name(&document_id));
        let asset_owner_path = root.join(&asset_owner);
        if asset_owner_path.exists() {
            let asset_owner_path = ensure_existing_inside_root(&root, &asset_owner_path)?;
            if asset_owner_path.is_dir() {
                fs::remove_dir_all(&asset_owner_path)
                    .map_err(|error| format!("思维导图已删除，但无法清理 HTML 资源：{error}"))?;
            }
        }
    }
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
            books: Vec::new(),
            categories: Vec::new(),
        });
    };
    fs::create_dir_all(&root).map_err(|error| format!("无法访问文件库目录：{error}"))?;
    let (documents, books, categories) = scan_library(&root)?;
    replace_index(app, &documents, &root)?;
    Ok(LibrarySnapshot {
        root_path: Some(root.to_string_lossy().into_owned()),
        documents,
        books,
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

fn history_database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法定位历史版本数据库目录：{error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建历史版本数据库目录：{error}"))?;
    Ok(directory.join(HISTORY_DATABASE_FILE))
}

fn open_history_database(app: &AppHandle) -> Result<Connection, String> {
    let connection = Connection::open(history_database_path(app)?).map_err(history_db_error)?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA busy_timeout = 3000;
             CREATE TABLE IF NOT EXISTS document_versions (
                 version_id TEXT PRIMARY KEY NOT NULL,
                 document_id TEXT NOT NULL,
                 relative_path TEXT NOT NULL,
                 title TEXT NOT NULL,
                 category TEXT NOT NULL,
                 map_type TEXT NOT NULL,
                 tags TEXT NOT NULL,
                 source TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 markdown TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_document_versions_recent
                 ON document_versions(document_id, created_at DESC);",
        )
        .map_err(history_db_error)?;
    Ok(connection)
}

fn record_document_version(
    app: &AppHandle,
    document: &MapDocument,
    markdown: &str,
    source: &str,
) -> Result<(), String> {
    let connection = open_history_database(app)?;
    let tags = serde_json::to_string(&document.tags).map_err(|error| error.to_string())?;
    let now = timestamp_now();
    let latest = connection
        .query_row(
            "SELECT version_id, source, created_at, relative_path, title, category,
                    map_type, tags, markdown
             FROM document_versions
             WHERE document_id = ?1
             ORDER BY created_at DESC, rowid DESC
             LIMIT 1",
            params![document.id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .optional()
        .map_err(history_db_error)?;

    if let Some((
        version_id,
        latest_source,
        created_at,
        relative_path,
        title,
        category,
        map_type,
        latest_tags,
        latest_markdown,
    )) = latest
    {
        let unchanged = relative_path == document.relative_path
            && title == document.title
            && category == document.category
            && map_type == document.map_type
            && latest_tags == tags
            && latest_markdown == markdown;
        if source != "restore" && unchanged {
            return Ok(());
        }
        if source == "autosave"
            && latest_source == "autosave"
            && now.saturating_sub(created_at) <= 45
        {
            connection
                .execute(
                    "UPDATE document_versions
                     SET relative_path = ?2, title = ?3, category = ?4, map_type = ?5,
                         tags = ?6, source = ?7, markdown = ?8
                     WHERE version_id = ?1",
                    params![
                        version_id,
                        document.relative_path,
                        document.title,
                        document.category,
                        document.map_type,
                        tags,
                        source,
                        markdown,
                    ],
                )
                .map_err(history_db_error)?;
            return Ok(());
        }
    }

    let version_id = Uuid::new_v4().to_string();
    connection
        .execute(
            "INSERT INTO document_versions
             (version_id, document_id, relative_path, title, category, map_type,
              tags, source, created_at, markdown)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                version_id,
                document.id,
                document.relative_path,
                document.title,
                document.category,
                document.map_type,
                tags,
                source,
                now,
                markdown,
            ],
        )
        .map_err(history_db_error)?;
    connection
        .execute(
            "DELETE FROM document_versions
             WHERE document_id = ?1 AND version_id NOT IN (
                 SELECT version_id FROM document_versions
                 WHERE document_id = ?1
                 ORDER BY created_at DESC, rowid DESC LIMIT 100
             )",
            params![document.id],
        )
        .map_err(history_db_error)?;
    Ok(())
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

fn scan_library(
    root: &Path,
) -> Result<(Vec<MapDocument>, Vec<EpubBookDocument>, Vec<String>), String> {
    let mut documents = Vec::new();
    let mut books = Vec::new();
    let mut categories = Vec::new();
    scan_directory(root, root, &mut documents, &mut books, &mut categories)?;
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
    books.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    categories.sort_by_key(|category| category.to_lowercase());
    categories.dedup();
    Ok((documents, books, categories))
}

fn scan_directory(
    root: &Path,
    directory: &Path,
    documents: &mut Vec<MapDocument>,
    books: &mut Vec<EpubBookDocument>,
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
            scan_directory(root, &path, documents, books, categories)?;
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
        } else if file_type.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("epub"))
        {
            if books.len() >= MAX_EPUB_BOOKS {
                return Err(format!(
                    "文件库超过 {} 本 EPUB 电子书，已停止索引。",
                    MAX_EPUB_BOOKS
                ));
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "EPUB 文件超出了文件库位置。".to_string())?;
            let relative_path = path_to_relative_string(relative);
            let title = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("未命名电子书")
                .to_string();
            let file_size = entry
                .metadata()
                .map_err(|error| format!("无法读取 EPUB 文件属性：{error}"))?
                .len();
            books.push(EpubBookDocument {
                relative_path,
                title,
                category: category_from_relative(relative),
                file_size,
                updated_at: modified_timestamp(&path),
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

#[derive(Default)]
struct HtmlBundleCopyState {
    files: usize,
    total_bytes: u64,
    entry_copied: bool,
}

fn asset_owner_directory_name(document_id: &str) -> String {
    Uuid::new_v5(&Uuid::NAMESPACE_OID, document_id.as_bytes()).to_string()
}

fn validate_html_entry_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err("HTML 入口文件路径无效。".to_string());
    }
    for component in path.components() {
        match component {
            Component::Normal(name) => {
                let name = name
                    .to_str()
                    .ok_or_else(|| "HTML 入口文件路径包含无效字符。".to_string())?;
                validate_name(name)?;
            }
            _ => return Err("HTML 入口文件不能离开资源文件夹。".to_string()),
        }
    }
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
        })
    {
        return Err("HTML 入口文件必须是 .html 或 .htm。".to_string());
    }
    Ok(path.to_path_buf())
}

fn copy_html_bundle_directory(
    source_root: &Path,
    source_directory: &Path,
    destination_relative: &Path,
    root: &Path,
    entry_relative: &Path,
    state: &mut HtmlBundleCopyState,
) -> Result<(), String> {
    let entries = fs::read_dir(source_directory)
        .map_err(|error| format!("无法读取 HTML 资源目录：{error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("无法读取 HTML 资源目录：{error}"))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "HTML 资源目录包含无效文件名。".to_string())?;
        let extension = Path::new(&name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if name.eq_ignore_ascii_case(".git")
            || name.eq_ignore_ascii_case("node_modules")
            || name.eq_ignore_ascii_case(".env")
            || name.to_ascii_lowercase().starts_with(".env.")
            || ["pem", "key", "p12", "pfx", "jks"]
                .iter()
                .any(|sensitive_extension| extension.eq_ignore_ascii_case(sensitive_extension))
        {
            continue;
        }
        validate_name(&name)?;
        let source_path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("无法读取 HTML 资源类型：{error}"))?;
        if file_type.is_symlink() {
            return Err("HTML 资源包不能包含符号链接。".to_string());
        }
        let relative_path = source_path
            .strip_prefix(source_root)
            .map_err(|_| "HTML 资源路径超出所选文件夹。".to_string())?;
        let destination_path = destination_relative.join(relative_path);

        if file_type.is_dir() {
            create_directory_inside_root(root, &destination_path)?;
            copy_html_bundle_directory(
                source_root,
                &source_path,
                destination_relative,
                root,
                entry_relative,
                state,
            )?;
            continue;
        }
        if !file_type.is_file() {
            return Err("HTML 资源包只能包含普通文件和文件夹。".to_string());
        }

        let metadata = entry
            .metadata()
            .map_err(|error| format!("无法读取 HTML 资源信息：{error}"))?;
        let file_bytes = metadata.len();
        if file_bytes > MAX_HTML_ASSET_FILE_BYTES {
            return Err("HTML 资源包中的单个文件不能超过 20 MB。".to_string());
        }
        state.files += 1;
        state.total_bytes = state.total_bytes.saturating_add(file_bytes);
        if state.files > MAX_HTML_ASSET_FILES {
            return Err("HTML 资源包最多支持 2,000 个文件。".to_string());
        }
        if state.total_bytes > MAX_HTML_ASSET_BUNDLE_BYTES {
            return Err("HTML 资源包总大小不能超过 50 MB。".to_string());
        }

        let parent = destination_path.parent().unwrap_or_else(|| Path::new(""));
        let destination_directory = create_directory_inside_root(root, parent)?;
        let file_name = destination_path
            .file_name()
            .ok_or_else(|| "HTML 资源文件名无效。".to_string())?;
        let destination_file = destination_directory.join(file_name);
        let content =
            fs::read(&source_path).map_err(|error| format!("无法复制 HTML 资源文件：{error}"))?;
        if relative_path == entry_relative {
            let html = String::from_utf8(content)
                .map_err(|_| "HTML 入口文件必须使用 UTF-8 编码。".to_string())?;
            fs::write(&destination_file, inject_html_preview_csp(&html))
                .map_err(|error| format!("无法保存 HTML 入口文件：{error}"))?;
            state.entry_copied = true;
        } else {
            fs::write(&destination_file, content)
                .map_err(|error| format!("无法复制 HTML 资源文件：{error}"))?;
        }
    }
    Ok(())
}

fn inject_html_preview_csp(html: &str) -> String {
    const CSP_META: &str = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self' asset: http://asset.localhost data: blob:; script-src 'self' asset: http://asset.localhost 'unsafe-inline'; style-src 'self' asset: http://asset.localhost 'unsafe-inline'; img-src 'self' asset: http://asset.localhost data: blob:; font-src 'self' asset: http://asset.localhost data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'\">";
    let lower = html.to_ascii_lowercase();
    if let Some(head_start) = lower.find("<head") {
        if let Some(head_end) = html[head_start..].find('>') {
            let insert_at = head_start + head_end + 1;
            return format!("{}{CSP_META}{}", &html[..insert_at], &html[insert_at..]);
        }
    }
    if let Some(html_start) = lower.find("<html") {
        if let Some(html_end) = html[html_start..].find('>') {
            let insert_at = html_start + html_end + 1;
            return format!(
                "{}<head>{CSP_META}</head>{}",
                &html[..insert_at],
                &html[insert_at..]
            );
        }
    }
    format!("<!doctype html><html><head>{CSP_META}</head><body>{html}</body></html>")
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

fn validate_epub_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err("电子书路径无效。".to_string());
    }
    for component in path.components() {
        match component {
            Component::Normal(name) => {
                let name = name
                    .to_str()
                    .ok_or_else(|| "电子书路径包含无效字符。".to_string())?;
                validate_name(name)?;
            }
            _ => return Err("电子书路径不能离开文件库目录。".to_string()),
        }
    }
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("epub"))
    {
        return Err("文件库只支持 EPUB 电子书阅读。".to_string());
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

fn history_db_error(error: rusqlite::Error) -> String {
    format!("SQLite 历史版本错误：{error}")
}
