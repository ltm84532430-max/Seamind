use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, USER_AGENT};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::{watch, Mutex as AsyncMutex};
use uuid::Uuid;

use crate::bibtex::{clean_doi, generate_cite_key, parse_bibtex, serialize_bibtex, ParsedBibEntry};
use crate::literature_resolver as resolver;
use crate::literature_store as store;

const DATABASE_FILE: &str = "literature.sqlite3";
const PDF_DIRECTORY: &str = "paper-pdfs";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_DOWNLOADED_PDF_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedPaperPdf {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureSearchResult {
    pub paper: store::PaperInput,
    pub source: String,
    pub pdf_url: Option<String>,
    pub existing_paper_id: Option<String>,
}

fn literature_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("SEAMIND_TEST_LITERATURE_DIR") {
        return Ok(PathBuf::from(path));
    }
    app.path()
        .app_local_data_dir()
        .map_err(|e| format!("无法定位文献数据目录：{e}"))
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = literature_data_dir(app)?;
    std::fs::create_dir_all(&directory).map_err(|e| format!("无法创建文献数据目录：{e}"))?;
    Ok(directory.join(DATABASE_FILE))
}

fn open_db(app: &AppHandle) -> Result<rusqlite::Connection, String> {
    store::open(&database_path(app)?)
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn http_client() -> Result<reqwest::Client, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static("Seamind-Desktop/0.1.0"),
    );
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/json, text/xml, */*"),
    );

    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .default_headers(headers)
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败：{e}"))
}

// -------------------------------------------------------------------------------------------------
// Tauri Commands
// -------------------------------------------------------------------------------------------------

#[tauri::command(async)]
pub fn literature_overview(app: AppHandle) -> Result<store::LiteratureOverview, String> {
    store::overview(&open_db(&app)?)
}

#[tauri::command(async)]
pub fn literature_list(
    app: AppHandle,
    filter: store::PaperFilter,
) -> Result<Vec<store::PaperItem>, String> {
    store::list_papers(&open_db(&app)?, &filter)
}

#[tauri::command(async)]
pub fn literature_get(app: AppHandle, id: String) -> Result<Option<store::PaperItem>, String> {
    store::get_paper(&open_db(&app)?, &id)
}

#[tauri::command(async)]
pub fn literature_save(
    app: AppHandle,
    paper: store::PaperInput,
) -> Result<store::PaperItem, String> {
    let conn = open_db(&app)?;
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("保存文献失败：{e}"))?;
    let saved = (|| {
        if paper.id.is_none() {
            if let Some(existing) = store::find_existing_paper_id(
                &conn,
                paper.doi.as_deref(),
                paper.arxiv_id.as_deref(),
            )? {
                if let Some(collections) = &paper.collection_ids {
                    for collection in collections {
                        conn.execute("INSERT OR IGNORE INTO paper_collection_items (paper_id,collection_id,added_at) VALUES (?1,?2,?3)", rusqlite::params![existing, collection, now()])
                            .map_err(|e| format!("添加文献集失败：{e}"))?;
                    }
                }
                return store::get_paper(&conn, &existing)?
                    .ok_or_else(|| "找不到已保存的文献".to_string());
            }
        }
        store::upsert_paper(&conn, &paper, now())
    })();
    match saved {
        Ok(item) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("保存文献失败：{e}"))?;
            Ok(item)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

#[tauri::command(async)]
pub fn literature_delete(app: AppHandle, id: String) -> Result<(), String> {
    let conn = open_db(&app)?;
    let pdf_path = store::get_paper(&conn, &id)?.and_then(|paper| paper.pdf_path);
    store::delete_paper(&conn, &id)?;
    if let Some(path) = pdf_path.as_deref() {
        remove_managed_pdf(&app, path);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn literature_batch_delete(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let conn = open_db(&app)?;
    let mut pdf_paths = Vec::new();
    for id in &ids {
        if let Some(paper) = store::get_paper(&conn, id)? {
            if let Some(path) = paper.pdf_path {
                pdf_paths.push(path);
            }
        }
    }
    store::batch_delete_papers(&conn, &ids)?;
    for path in pdf_paths {
        remove_managed_pdf(&app, &path);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn literature_update_read_status(
    app: AppHandle,
    id: String,
    status: String,
) -> Result<(), String> {
    store::update_read_status(&open_db(&app)?, &id, &status, now())
}

#[tauri::command(async)]
pub fn literature_update_rating(app: AppHandle, id: String, rating: u8) -> Result<(), String> {
    store::update_rating(&open_db(&app)?, &id, rating, now())
}

#[tauri::command(async)]
pub fn literature_update_notes(app: AppHandle, id: String, notes: String) -> Result<(), String> {
    store::update_notes(&open_db(&app)?, &id, &notes, now())
}

#[tauri::command(async)]
pub fn literature_attach_pdf(
    app: AppHandle,
    id: String,
) -> Result<Option<store::PaperItem>, String> {
    let conn = open_db(&app)?;
    let existing =
        store::get_paper(&conn, &id)?.ok_or_else(|| "找不到要关联 PDF 的文献记录。".to_string())?;
    let Some(selected_path) = app
        .dialog()
        .file()
        .add_filter("PDF 文档", &["pdf"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let source_path = selected_path
        .into_path()
        .map_err(|e| format!("无法读取所选 PDF 路径：{e}"))?;
    let source = fs::canonicalize(source_path).map_err(|e| format!("无法读取所选 PDF：{e}"))?;
    if !source.is_file()
        || source
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| !extension.eq_ignore_ascii_case("pdf"))
            .unwrap_or(true)
    {
        return Err("请选择有效的 PDF 文件。".to_string());
    }

    let mut header = [0_u8; 1024];
    let header_size = fs::File::open(&source)
        .and_then(|mut file| file.read(&mut header))
        .map_err(|e| format!("读取 PDF 文件失败：{e}"))?;
    if !header[..header_size]
        .windows(5)
        .any(|window| window == b"%PDF-")
    {
        return Err("所选文件没有有效的 PDF 文件头。".to_string());
    }

    let app_data = literature_data_dir(&app)?;
    let directory = app_data.join(PDF_DIRECTORY);
    fs::create_dir_all(&directory).map_err(|e| format!("无法创建 PDF 附件目录：{e}"))?;
    let filename = format!("{}.pdf", Uuid::new_v4());
    let destination = directory.join(&filename);
    if let Err(error) = fs::copy(&source, &destination) {
        let _ = fs::remove_file(&destination);
        return Err(format!("复制 PDF 到文献库失败：{error}"));
    }
    let sha256 = match hash_file(&destination) {
        Ok(hash) => hash,
        Err(error) => {
            let _ = fs::remove_file(&destination);
            return Err(error);
        }
    };
    let relative_path = Path::new(PDF_DIRECTORY)
        .join(&filename)
        .to_string_lossy()
        .replace('\\', "/");
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("无法保存附件：{e}"))?;
    let source = store::PaperPdfSource {
        source_type: "本地文件".into(),
        source_url: None,
        version: None,
        license: None,
        acquired_at: now(),
    };
    if let Err(error) = store::update_paper_pdf(&conn, &id, &relative_path, &sha256, now())
        .and_then(|_| store::set_pdf_source(&conn, &id, &source))
        .and_then(|_| store::set_pdf_attempt(&conn, &id, "available", None, now()))
        .and_then(|_| conn.execute_batch("COMMIT").map_err(|e| e.to_string()))
    {
        let _ = conn.execute_batch("ROLLBACK");
        let _ = fs::remove_file(&destination);
        return Err(error);
    }

    if let Some(old_path) = existing.pdf_path.as_deref() {
        if old_path != relative_path {
            remove_managed_pdf(&app, old_path);
        }
    }
    store::get_paper(&conn, &id)?
        .map(Some)
        .ok_or_else(|| "关联 PDF 后无法读取文献记录。".to_string())
}

static PDF_LOCKS: OnceLock<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>> = OnceLock::new();
static PDF_CANCEL: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();
static ARXIV_API_SLOT: OnceLock<AsyncMutex<Option<tokio::time::Instant>>> = OnceLock::new();

async fn arxiv_api_slot() -> tokio::sync::MutexGuard<'static, Option<tokio::time::Instant>> {
    let mut slot = ARXIV_API_SLOT
        .get_or_init(|| AsyncMutex::new(None))
        .lock()
        .await;
    if let Some(previous) = *slot {
        tokio::time::sleep_until(previous + Duration::from_secs(3)).await;
    }
    *slot = Some(tokio::time::Instant::now());
    slot
}

struct TemporaryPdf(PathBuf);
impl Drop for TemporaryPdf {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[tauri::command(async)]
pub fn literature_cancel_pdf(id: String) {
    if let Some(sender) = PDF_CANCEL
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .get(&id)
    {
        let _ = sender.send(true);
    }
}

#[tauri::command(async)]
pub fn literature_pdf_source(
    app: AppHandle,
    id: String,
) -> Result<Option<store::PaperPdfSource>, String> {
    store::pdf_source(&open_db(&app)?, &id)
}

#[tauri::command(async)]
pub fn literature_pdf_attempt(
    app: AppHandle,
    id: String,
) -> Result<Option<store::PaperPdfAttempt>, String> {
    store::pdf_attempt(&open_db(&app)?, &id)
}

#[tauri::command(async)]
pub async fn literature_acquire_pdf(
    app: AppHandle,
    id: String,
    email: Option<String>,
) -> Result<store::PaperItem, String> {
    let lock = {
        let mut locks = PDF_LOCKS.get_or_init(Default::default).lock().unwrap();
        locks.retain(|_, lock| lock.strong_count() > 0);
        match locks.get(&id).and_then(Weak::upgrade) {
            Some(lock) => lock,
            None => {
                let lock = Arc::new(AsyncMutex::new(()));
                locks.insert(id.clone(), Arc::downgrade(&lock));
                lock
            }
        }
    };
    let _guard = lock.lock().await;
    let paper = store::get_paper(&open_db(&app)?, &id)?.ok_or("找不到这篇文献")?;
    if paper
        .pdf_path
        .as_deref()
        .is_some_and(|path| resolve_managed_pdf(&app, path).is_ok())
    {
        return Ok(paper);
    }
    store::set_pdf_attempt(&open_db(&app)?, &id, "searching", None, now())?;
    let (sender, mut receiver) = watch::channel(false);
    PDF_CANCEL
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(id.clone(), sender);
    let result = tokio::select! {
        value = acquire_pdf_inner(&app, &paper, email.as_deref()) => value,
        _ = receiver.changed() => Err("已取消获取原文".to_string()),
    };
    PDF_CANCEL
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .remove(&id);
    if let Err(error) = &result {
        let state = if error.contains("已取消") {
            "cancelled"
        } else {
            "failed"
        };
        if let Ok(conn) = open_db(&app) {
            let _ = store::set_pdf_attempt(&conn, &id, state, Some(error), now());
        }
    }
    result
}

async fn acquire_pdf_inner(
    app: &AppHandle,
    paper: &store::PaperItem,
    email: Option<&str>,
) -> Result<store::PaperItem, String> {
    let mut candidates = Vec::new();
    let arxiv = paper
        .arxiv_id
        .as_deref()
        .and_then(resolver::arxiv_id)
        .or_else(|| paper.doi.as_deref().and_then(resolver::arxiv_id))
        .or_else(|| paper.url.as_deref().and_then(resolver::arxiv_id));
    if let Some(id) = arxiv {
        if let Ok(url) = resolver::safe_url(&format!("https://arxiv.org/pdf/{id}")) {
            candidates.push(resolver::Candidate {
                url,
                source: "arXiv",
                version: Some(id),
                license: None,
            });
        }
    }
    // Try arXiv immediately so a slow DOI resolver does not delay reading.
    let mut last_error = None;
    for candidate in candidates {
        match download_candidate(app, paper, &candidate).await {
            Ok(item) => return Ok(item),
            Err(error) => last_error = Some(error),
        }
    }
    for candidate in resolver::candidates(paper.doi.as_deref(), None, None, email).await {
        if candidate.source == "arXiv" {
            continue;
        }
        match download_candidate(app, paper, &candidate).await {
            Ok(item) => return Ok(item),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error
        .unwrap_or_else(|| "没有找到可直接阅读的开放 PDF，请手动添加文件或打开出版社页面".into()))
}

async fn download_candidate(
    app: &AppHandle,
    paper: &store::PaperItem,
    candidate: &resolver::Candidate,
) -> Result<store::PaperItem, String> {
    let (mut response, final_url) = resolver::request(candidate.url.as_str()).await?;
    if !response.status().is_success() {
        return Err(format!(
            "{} 返回 HTTP {}",
            candidate.source,
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_DOWNLOADED_PDF_BYTES)
    {
        return Err("PDF 超过 100 MB".into());
    }
    let directory = literature_data_dir(app)?.join(PDF_DIRECTORY);
    fs::create_dir_all(&directory).map_err(|e| format!("无法创建附件目录：{e}"))?;
    let filename = format!("{}.pdf", Uuid::new_v4());
    let target = directory.join(&filename);
    let temp = TemporaryPdf(directory.join(format!("{filename}.part")));
    let mut file = fs::File::create(&temp.0).map_err(|e| format!("无法创建临时文件：{e}"))?;
    let mut size = 0u64;
    let mut head = Vec::new();
    let mut tail = Vec::new();
    let mut hash = Sha256::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("下载中断：{}", e.without_url()))?
    {
        size += chunk.len() as u64;
        if size > MAX_DOWNLOADED_PDF_BYTES {
            return Err("PDF 超过 100 MB".into());
        }
        if head.len() < 1024 {
            head.extend_from_slice(&chunk[..chunk.len().min(1024 - head.len())]);
        }
        tail.extend_from_slice(&chunk);
        if tail.len() > 2048 {
            tail.drain(..tail.len() - 2048);
        }
        hash.update(&chunk);
        file.write_all(&chunk)
            .map_err(|e| format!("保存 PDF 失败：{e}"))?;
    }
    if size < 100
        || !head.windows(5).any(|s| s == b"%PDF-")
        || !tail.windows(5).any(|s| s == b"%%EOF")
    {
        return Err("来源返回的内容不是完整 PDF，请尝试其他来源".into());
    }
    file.sync_all().map_err(|e| format!("保存 PDF 失败：{e}"))?;
    drop(file);
    let conn = open_db(app)?;
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("无法保存附件：{e}"))?;
    let current = store::get_paper(&conn, &paper.id)?.ok_or("文献已被删除")?;
    if current.pdf_path != paper.pdf_path {
        let _ = conn.execute_batch("ROLLBACK");
        let _ = store::set_pdf_attempt(&conn, &paper.id, "available", None, now());
        return Ok(current);
    }
    fs::rename(&temp.0, &target).map_err(|e| format!("无法完成 PDF 保存：{e}"))?;
    let path = format!("{PDF_DIRECTORY}/{filename}");
    let mut public_url = final_url;
    // Query parameters may contain expiring access tokens; keep provenance without credentials.
    public_url.set_query(None);
    let source = store::PaperPdfSource {
        source_type: candidate.source.into(),
        source_url: Some(public_url.to_string()),
        version: candidate.version.clone(),
        license: candidate.license.clone(),
        acquired_at: now(),
    };
    let save = store::update_paper_pdf(
        &conn,
        &paper.id,
        &path,
        &format!("{:x}", hash.finalize()),
        now(),
    )
    .and_then(|_| store::set_pdf_source(&conn, &paper.id, &source))
    .and_then(|_| store::set_pdf_attempt(&conn, &paper.id, "available", None, now()))
    .and_then(|_| conn.execute_batch("COMMIT").map_err(|e| e.to_string()));
    if let Err(error) = save {
        let _ = conn.execute_batch("ROLLBACK");
        let _ = fs::remove_file(&target);
        return Err(error);
    }
    store::get_paper(&conn, &paper.id)?.ok_or_else(|| "保存后找不到文献".into())
}

#[tauri::command(async)]
pub async fn literature_download_arxiv_pdf(
    app: AppHandle,
    id: String,
) -> Result<store::PaperItem, String> {
    literature_acquire_pdf(app, id, None).await
}

#[tauri::command(async)]
pub fn literature_open_pdf(app: AppHandle, id: String) -> Result<OpenedPaperPdf, String> {
    let paper =
        store::get_paper(&open_db(&app)?, &id)?.ok_or_else(|| "找不到该文献记录。".to_string())?;
    let relative_path = paper
        .pdf_path
        .as_deref()
        .ok_or_else(|| "这篇文献还没有添加 PDF 原文。".to_string())?;
    let path = resolve_managed_pdf(&app, relative_path)?;
    let sha256 = hash_file(&path)?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|e| format!("无法授权阅读该 PDF：{e}"))?;
    Ok(OpenedPaperPdf {
        path: path.to_string_lossy().into_owned(),
        sha256,
    })
}

#[tauri::command(async)]
pub fn literature_list_annotations(
    app: AppHandle,
    paper_id: String,
) -> Result<Vec<store::PaperAnnotation>, String> {
    let conn = open_db(&app)?;
    if store::get_paper(&conn, &paper_id)?.is_none() {
        return Err("找不到该文献记录。".to_string());
    }
    store::list_paper_annotations(&conn, &paper_id)
}

#[tauri::command(async)]
pub fn literature_save_annotation(
    app: AppHandle,
    mut annotation: store::PaperAnnotationInput,
) -> Result<store::PaperAnnotation, String> {
    let conn = open_db(&app)?;
    let paper = store::get_paper(&conn, &annotation.paper_id)?
        .ok_or_else(|| "找不到该文献记录。".to_string())?;
    let relative_path = paper
        .pdf_path
        .as_deref()
        .ok_or_else(|| "请先为这篇文献添加 PDF 原文。".to_string())?;
    let path = resolve_managed_pdf(&app, relative_path)?;
    annotation.pdf_sha256 = Some(hash_file(&path)?);
    store::save_paper_annotation(&conn, &annotation, now())
}

#[tauri::command(async)]
pub fn literature_delete_annotation(
    app: AppHandle,
    paper_id: String,
    annotation_id: String,
) -> Result<(), String> {
    store::delete_paper_annotation(&open_db(&app)?, &paper_id, &annotation_id)
}

#[tauri::command(async)]
pub fn literature_get_reading_progress(
    app: AppHandle,
    paper_id: String,
) -> Result<Option<store::PaperReadingProgress>, String> {
    store::get_paper_reading_progress(&open_db(&app)?, &paper_id)
}

#[tauri::command(async)]
pub fn literature_save_reading_progress(
    app: AppHandle,
    paper_id: String,
    page_number: i64,
    scale: f64,
) -> Result<store::PaperReadingProgress, String> {
    store::save_paper_reading_progress(&open_db(&app)?, &paper_id, page_number, scale, now())
}

fn resolve_managed_pdf(app: &AppHandle, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("文献 PDF 路径无效，请重新关联原文。".to_string());
    }
    let app_data = literature_data_dir(app)?;
    let root = fs::canonicalize(&app_data).map_err(|e| format!("文献附件目录不可用：{e}"))?;
    let resolved = fs::canonicalize(root.join(relative))
        .map_err(|e| format!("找不到文献 PDF，请重新关联原文：{e}"))?;
    if !resolved.starts_with(&root) || !resolved.is_file() {
        return Err("文献 PDF 路径超出应用附件目录，请重新关联原文。".to_string());
    }
    Ok(resolved)
}

fn remove_managed_pdf(app: &AppHandle, relative_path: &str) {
    if let Ok(path) = resolve_managed_pdf(app, relative_path) {
        let _ = fs::remove_file(path);
    }
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("打开 PDF 文件失败：{e}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|e| format!("读取 PDF 文件失败：{e}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[tauri::command(async)]
pub fn literature_list_collections(app: AppHandle) -> Result<Vec<store::PaperCollection>, String> {
    store::list_collections(&open_db(&app)?)
}

#[tauri::command(async)]
pub fn literature_save_collection(
    app: AppHandle,
    collection: store::CollectionInput,
) -> Result<store::PaperCollection, String> {
    store::save_collection(&open_db(&app)?, &collection, now())
}

#[tauri::command(async)]
pub fn literature_delete_collection(app: AppHandle, id: String) -> Result<(), String> {
    store::delete_collection(&open_db(&app)?, &id)
}

// -------------------------------------------------------------------------------------------------
// Online Fetchers (DOI & arXiv)
// -------------------------------------------------------------------------------------------------

#[tauri::command(async)]
pub async fn literature_fetch_doi(doi: String) -> Result<store::PaperInput, String> {
    let cleaned = clean_doi(&doi);
    if cleaned.is_empty() {
        return Err("请输入有效的 DOI".to_string());
    }
    if let Some(id) = resolver::arxiv_id(&cleaned) {
        return literature_fetch_arxiv(id).await;
    }

    let encoded = url::form_urlencoded::byte_serialize(cleaned.as_bytes()).collect::<String>();
    let url = format!("https://api.crossref.org/works/{encoded}");
    let client = http_client()?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("查询 Crossref DOI 失败：{e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Crossref 返回错误状态码：{}", resp.status()));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 Crossref 返回 JSON 失败：{e}"))?;

    let message = json
        .get("message")
        .ok_or_else(|| "Crossref 返回数据格式异常".to_string())?;

    let title = message
        .get("title")
        .and_then(|t| t.as_array())
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let mut authors = Vec::new();
    if let Some(arr) = message.get("author").and_then(|a| a.as_array()) {
        for author in arr {
            let given = author.get("given").and_then(|v| v.as_str()).unwrap_or("");
            let family = author.get("family").and_then(|v| v.as_str()).unwrap_or("");
            if !family.is_empty() {
                if !given.is_empty() {
                    authors.push(format!("{given} {family}"));
                } else {
                    authors.push(family.to_string());
                }
            } else if let Some(name) = author.get("name").and_then(|v| v.as_str()) {
                authors.push(name.to_string());
            }
        }
    }

    let venue = message
        .get("container-title")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let year = message
        .get("published")
        .or_else(|| message.get("published-print"))
        .or_else(|| message.get("published-online"))
        .and_then(|p| p.get("date-parts"))
        .and_then(|dp| dp.as_array())
        .and_then(|parts| parts.first())
        .and_then(|p0| p0.as_array())
        .and_then(|y| y.first())
        .and_then(|y| y.as_i64())
        .map(|y| y as i32);

    let volume = message
        .get("volume")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let number = message
        .get("issue")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let pages = message
        .get("page")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let publisher = message
        .get("publisher")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let abstract_text = message
        .get("abstract")
        .and_then(|v| v.as_str())
        .map(|s| crate::bibtex::strip_latex_curlies(s));
    let url_link = message
        .get("URL")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("https://doi.org/{cleaned}"));

    let cite_key = generate_cite_key(&authors, year, &title);

    Ok(store::PaperInput {
        id: None,
        cite_key: Some(cite_key),
        entry_type: Some("article".to_string()),
        title,
        authors,
        year,
        venue,
        volume,
        number,
        pages,
        publisher,
        doi: Some(cleaned),
        url: Some(url_link),
        arxiv_id: None,
        abstract_text,
        keywords: Some(Vec::new()),
        pdf_path: None,
        read_status: Some("unread".to_string()),
        rating: Some(0),
        notes: None,
        bibtex: None,
        collection_ids: None,
    })
}

#[tauri::command(async)]
pub async fn literature_fetch_arxiv(arxiv_id: String) -> Result<store::PaperInput, String> {
    let _permit = arxiv_api_slot().await;
    let cleaned = resolver::arxiv_id(&arxiv_id).ok_or("请输入有效的 arXiv ID")?;

    let encoded = url::form_urlencoded::byte_serialize(cleaned.as_bytes()).collect::<String>();
    let url = format!("https://export.arxiv.org/api/query?id_list={encoded}&max_results=1");
    let client = http_client()?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("请求 arXiv API 失败：{e}"))?;

    if !resp.status().is_success() {
        return Err(format!("arXiv API 返回状态码：{}", resp.status()));
    }

    let xml = resp
        .text()
        .await
        .map_err(|e| format!("读取 arXiv 响应内容失败：{e}"))?;

    let doc = roxmltree::Document::parse(&xml).map_err(|e| format!("解析 arXiv XML 失败：{e}"))?;

    let entry = doc
        .descendants()
        .find(|n| n.has_tag_name("entry"))
        .ok_or_else(|| "未在 arXiv 找到对应文献条目".to_string())?;

    let title = entry
        .descendants()
        .find(|n| n.has_tag_name("title"))
        .and_then(|n| n.text())
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    let summary = entry
        .descendants()
        .find(|n| n.has_tag_name("summary"))
        .and_then(|n| n.text())
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    let mut authors = Vec::new();
    for author_node in entry.descendants().filter(|n| n.has_tag_name("author")) {
        if let Some(name_node) = author_node.children().find(|n| n.has_tag_name("name")) {
            if let Some(text) = name_node.text() {
                authors.push(text.trim().to_string());
            }
        }
    }

    let year = entry
        .descendants()
        .find(|n| n.has_tag_name("published"))
        .and_then(|n| n.text())
        .and_then(|t| t.get(0..4))
        .and_then(|y| y.parse::<i32>().ok());

    let doi = entry
        .descendants()
        .find(|n| n.has_tag_name("doi"))
        .and_then(|n| n.text())
        .map(|s| s.trim().to_string());

    let mut pdf_url = None;
    for link in entry.descendants().filter(|n| n.has_tag_name("link")) {
        if link.attribute("title") == Some("pdf") {
            pdf_url = link.attribute("href").map(|s| s.to_string());
        }
    }

    let mut categories = Vec::new();
    for cat in entry.descendants().filter(|n| n.has_tag_name("category")) {
        if let Some(term) = cat.attribute("term") {
            categories.push(term.to_string());
        }
    }

    let cite_key = generate_cite_key(&authors, year, &title);
    let paper_url = format!("https://arxiv.org/abs/{cleaned}");

    Ok(store::PaperInput {
        id: None,
        cite_key: Some(cite_key),
        entry_type: Some("article".to_string()),
        title,
        authors,
        year,
        venue: Some("arXiv preprint".to_string()),
        volume: None,
        number: None,
        pages: None,
        publisher: Some("arXiv".to_string()),
        doi,
        url: pdf_url.or(Some(paper_url)),
        arxiv_id: Some(cleaned.to_string()),
        abstract_text: Some(summary),
        keywords: Some(categories),
        pdf_path: None,
        read_status: Some("unread".to_string()),
        rating: Some(0),
        notes: None,
        bibtex: None,
        collection_ids: None,
    })
}

fn validate_arxiv_id(input: &str) -> Result<String, String> {
    let cleaned = input
        .trim()
        .trim_start_matches("https://arxiv.org/abs/")
        .trim_start_matches("http://arxiv.org/abs/")
        .trim_start_matches("arXiv:")
        .trim_start_matches("arxiv:");
    let valid = !cleaned.is_empty()
        && cleaned.len() <= 128
        && !cleaned.contains("..")
        && cleaned.split('/').count() <= 2
        && cleaned.split('/').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || ".-".contains(character))
        });
    if !valid {
        return Err("无效的 arXiv ID。".to_string());
    }
    Ok(cleaned.to_string())
}

fn crossref_first_string(item: &serde_json::Value, field: &str) -> Option<String> {
    item.get(field)
        .and_then(|value| value.as_array())
        .and_then(|values| values.first())
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn crossref_search_result(item: &serde_json::Value) -> Option<LiteratureSearchResult> {
    let title = crossref_first_string(item, "title")?;
    let mut authors = Vec::new();
    if let Some(items) = item.get("author").and_then(|value| value.as_array()) {
        for author in items {
            let given = author
                .get("given")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let family = author
                .get("family")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if !family.is_empty() {
                authors.push(if given.is_empty() {
                    family.to_string()
                } else {
                    format!("{given} {family}")
                });
            } else if let Some(name) = author.get("name").and_then(|value| value.as_str()) {
                authors.push(name.to_string());
            }
        }
    }
    let year = ["published", "published-print", "published-online", "issued"]
        .iter()
        .find_map(|field| {
            item.get(*field)
                .and_then(|value| value.get("date-parts"))
                .and_then(|value| value.as_array())
                .and_then(|parts| parts.first())
                .and_then(|part| part.as_array())
                .and_then(|date| date.first())
                .and_then(|value| value.as_i64())
                .map(|year| year as i32)
        });
    let doi = item
        .get("DOI")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let arxiv_id = doi.as_ref().and_then(|value| {
        value
            .to_ascii_lowercase()
            .strip_prefix("10.48550/arxiv.")
            .map(str::to_string)
    });
    let venue = crossref_first_string(item, "container-title");
    let volume = item
        .get("volume")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let number = item
        .get("issue")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let pages = item
        .get("page")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let publisher = item
        .get("publisher")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let url = item
        .get("URL")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .or_else(|| doi.as_ref().map(|doi| format!("https://doi.org/{doi}")));
    let abstract_text = item
        .get("abstract")
        .and_then(|value| value.as_str())
        .map(crate::bibtex::strip_latex_curlies);
    let keywords = item
        .get("subject")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let cite_key = generate_cite_key(&authors, year, &title);
    let pdf_url = arxiv_id
        .as_ref()
        .map(|arxiv_id| format!("https://arxiv.org/pdf/{arxiv_id}.pdf"));

    Some(LiteratureSearchResult {
        paper: store::PaperInput {
            id: None,
            cite_key: Some(cite_key),
            entry_type: Some("article".to_string()),
            title,
            authors,
            year,
            venue,
            volume,
            number,
            pages,
            publisher,
            doi,
            url,
            arxiv_id,
            abstract_text,
            keywords: Some(keywords),
            pdf_path: None,
            read_status: Some("unread".to_string()),
            rating: Some(0),
            notes: None,
            bibtex: None,
            collection_ids: None,
        },
        source: "Crossref".to_string(),
        pdf_url,
        existing_paper_id: None,
    })
}

async fn search_crossref(query: &str) -> Result<Vec<LiteratureSearchResult>, String> {
    let client = http_client()?;
    let response = client
        .get("https://api.crossref.org/works")
        .query(&[("query.bibliographic", query), ("rows", "16")])
        .send()
        .await
        .map_err(|e| format!("请求 Crossref 搜索失败：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("Crossref 搜索返回状态码：{}", response.status()));
    }
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("解析 Crossref 搜索结果失败：{e}"))?;
    let items = json
        .get("message")
        .and_then(|value| value.get("items"))
        .and_then(|value| value.as_array())
        .ok_or_else(|| "Crossref 返回的搜索结果格式异常。".to_string())?;
    Ok(items.iter().filter_map(crossref_search_result).collect())
}

async fn search_arxiv(query: &str) -> Result<Vec<LiteratureSearchResult>, String> {
    let _permit = arxiv_api_slot().await;
    let client = http_client()?;
    let search_query = format!("all:{query}");
    let response = client
        .get("https://export.arxiv.org/api/query")
        .query(&[
            ("search_query", search_query.as_str()),
            ("start", "0"),
            ("max_results", "16"),
        ])
        .send()
        .await
        .map_err(|e| format!("请求 arXiv 搜索失败：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("arXiv 搜索返回状态码：{}", response.status()));
    }
    let xml = response
        .text()
        .await
        .map_err(|e| format!("读取 arXiv 搜索结果失败：{e}"))?;
    let doc =
        roxmltree::Document::parse(&xml).map_err(|e| format!("解析 arXiv 搜索结果失败：{e}"))?;
    let mut results = Vec::new();
    for entry in doc.descendants().filter(|node| node.has_tag_name("entry")) {
        let entry_id = entry
            .children()
            .find(|node| node.has_tag_name("id"))
            .and_then(|node| node.text())
            .unwrap_or("")
            .trim();
        let Some(raw_arxiv_id) = entry_id.rsplit("/abs/").next() else {
            continue;
        };
        let Ok(arxiv_id) = validate_arxiv_id(raw_arxiv_id) else {
            continue;
        };
        let title = entry
            .children()
            .find(|node| node.has_tag_name("title"))
            .and_then(|node| node.text())
            .unwrap_or("")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if title.is_empty() {
            continue;
        }
        let abstract_text = entry
            .children()
            .find(|node| node.has_tag_name("summary"))
            .and_then(|node| node.text())
            .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "));
        let authors = entry
            .children()
            .filter(|node| node.has_tag_name("author"))
            .filter_map(|author| {
                author
                    .children()
                    .find(|node| node.has_tag_name("name"))
                    .and_then(|node| node.text())
                    .map(|name| name.trim().to_string())
            })
            .collect::<Vec<_>>();
        let year = entry
            .children()
            .find(|node| node.has_tag_name("published"))
            .and_then(|node| node.text())
            .and_then(|text| text.get(0..4))
            .and_then(|text| text.parse::<i32>().ok());
        let doi = entry
            .children()
            .find(|node| node.has_tag_name("doi"))
            .and_then(|node| node.text())
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty());
        let keywords = entry
            .children()
            .filter(|node| node.has_tag_name("category"))
            .filter_map(|node| node.attribute("term").map(str::to_string))
            .collect::<Vec<_>>();
        let pdf_url = entry
            .children()
            .filter(|node| node.has_tag_name("link"))
            .find(|node| node.attribute("title") == Some("pdf"))
            .and_then(|node| node.attribute("href"))
            .map(str::to_string)
            .or_else(|| Some(format!("https://arxiv.org/pdf/{arxiv_id}.pdf")));
        let cite_key = generate_cite_key(&authors, year, &title);
        results.push(LiteratureSearchResult {
            paper: store::PaperInput {
                id: None,
                cite_key: Some(cite_key),
                entry_type: Some("article".to_string()),
                title,
                authors,
                year,
                venue: Some("arXiv preprint".to_string()),
                volume: None,
                number: None,
                pages: None,
                publisher: Some("arXiv".to_string()),
                doi,
                url: Some(format!("https://arxiv.org/abs/{arxiv_id}")),
                arxiv_id: Some(arxiv_id),
                abstract_text,
                keywords: Some(keywords),
                pdf_path: None,
                read_status: Some("unread".to_string()),
                rating: Some(0),
                notes: None,
                bibtex: None,
                collection_ids: None,
            },
            source: "arXiv".to_string(),
            pdf_url,
            existing_paper_id: None,
        });
    }
    Ok(results)
}

#[tauri::command(async)]
pub async fn literature_search(
    app: AppHandle,
    query: String,
    source: String,
) -> Result<Vec<LiteratureSearchResult>, String> {
    let query = query.trim();
    if query.chars().count() < 2 || query.chars().count() > 160 {
        return Err("搜索词长度需为 2 到 160 个字符。".to_string());
    }
    let mut results = match source.as_str() {
        "crossref" => search_crossref(query).await?,
        "arxiv" => search_arxiv(query).await?,
        _ => return Err("请选择 Crossref 或 arXiv 搜索源。".to_string()),
    };

    let conn = open_db(&app)?;
    for result in &mut results {
        result.existing_paper_id = store::find_existing_paper_id(
            &conn,
            result.paper.doi.as_deref(),
            result.paper.arxiv_id.as_deref(),
        )?;
    }

    let mut seen = HashSet::new();
    results.retain(|result| {
        let key = result
            .paper
            .doi
            .as_ref()
            .map(|value| format!("doi:{}", value.to_ascii_lowercase()))
            .or_else(|| {
                result
                    .paper
                    .arxiv_id
                    .as_ref()
                    .map(|value| format!("arxiv:{}", value.to_ascii_lowercase()))
            })
            .unwrap_or_else(|| {
                format!(
                    "title:{}",
                    result
                        .paper
                        .title
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .to_lowercase()
                )
            });
        seen.insert(key)
    });
    Ok(results)
}

// -------------------------------------------------------------------------------------------------
// BibTeX Import & Export
// -------------------------------------------------------------------------------------------------

#[tauri::command(async)]
pub fn literature_parse_bibtex_text(content: String) -> Result<Vec<ParsedBibEntry>, String> {
    Ok(parse_bibtex(&content))
}

#[tauri::command(async)]
pub fn literature_import_bibtex_text(
    app: AppHandle,
    content: String,
    collection_id: Option<String>,
) -> Result<usize, String> {
    let entries = parse_bibtex(&content);
    if entries.is_empty() {
        return Err("未解析到有效的 BibTeX 条目".to_string());
    }

    let conn = open_db(&app)?;
    let col_ids = collection_id.as_ref().map(|cid| vec![cid.clone()]);
    let current_time = now();
    let mut count = 0;

    for entry in entries {
        if let Some(existing) =
            store::find_existing_paper_id(&conn, entry.doi.as_deref(), entry.eprint.as_deref())?
        {
            if let Some(collection) = &collection_id {
                conn.execute("INSERT OR IGNORE INTO paper_collection_items (paper_id,collection_id,added_at) VALUES (?1,?2,?3)", rusqlite::params![existing, collection, current_time])
                    .map_err(|e| format!("添加文献集失败：{e}"))?;
            }
            continue;
        }
        let input = store::PaperInput {
            id: None,
            cite_key: Some(entry.cite_key.clone()),
            entry_type: Some(entry.entry_type.clone()),
            title: entry.title.clone(),
            authors: entry.authors.clone(),
            year: entry.year,
            venue: entry.venue.clone(),
            volume: entry.volume.clone(),
            number: entry.number.clone(),
            pages: entry.pages.clone(),
            publisher: entry.publisher.clone(),
            doi: entry.doi.clone(),
            url: entry.url.clone(),
            arxiv_id: entry.eprint.clone(),
            abstract_text: entry.abstract_text.clone(),
            keywords: Some(entry.keywords.clone()),
            pdf_path: None,
            read_status: Some("unread".to_string()),
            rating: Some(0),
            notes: None,
            bibtex: Some(serialize_bibtex(&entry)),
            collection_ids: col_ids.clone(),
        };

        if store::upsert_paper(&conn, &input, current_time).is_ok() {
            count += 1;
        }
    }

    Ok(count)
}

#[tauri::command(async)]
pub fn literature_export_bibtex_text(
    app: AppHandle,
    ids: Option<Vec<String>>,
) -> Result<String, String> {
    let conn = open_db(&app)?;
    let filter = store::PaperFilter::default();
    let papers = store::list_papers(&conn, &filter)?;

    let mut result = String::new();
    for paper in papers {
        if let Some(ref target_ids) = ids {
            if !target_ids.contains(&paper.id) {
                continue;
            }
        }

        if let Some(ref bib) = paper.bibtex {
            result.push_str(bib);
            result.push_str("\n\n");
        } else {
            let entry = ParsedBibEntry {
                cite_key: paper.cite_key.clone(),
                entry_type: paper.entry_type.clone(),
                title: paper.title.clone(),
                authors: paper.authors.clone(),
                year: paper.year,
                venue: paper.venue.clone(),
                volume: paper.volume.clone(),
                number: paper.number.clone(),
                pages: paper.pages.clone(),
                publisher: paper.publisher.clone(),
                doi: paper.doi.clone(),
                url: paper.url.clone(),
                eprint: paper.arxiv_id.clone(),
                abstract_text: paper.abstract_text.clone(),
                keywords: paper.keywords.clone(),
                raw_fields: std::collections::HashMap::new(),
            };
            result.push_str(&serialize_bibtex(&entry));
            result.push_str("\n\n");
        }
    }

    Ok(result)
}

// -------------------------------------------------------------------------------------------------
// Paper to Mindmap Generator (Seamind Killer Feature)
// -------------------------------------------------------------------------------------------------

#[tauri::command(async)]
pub fn literature_generate_mindmap(app: AppHandle, id: String) -> Result<String, String> {
    let conn = open_db(&app)?;
    let paper = store::get_paper(&conn, &id)?.ok_or_else(|| "未找到指定文献".to_string())?;

    let year_str = paper.year.map(|y| format!(" ({y})")).unwrap_or_default();
    let authors_str = if paper.authors.is_empty() {
        "佚名".to_string()
    } else {
        paper.authors.join(", ")
    };
    let venue_str = paper.venue.as_deref().unwrap_or("未标注刊物/会议");
    let cite_key = paper.cite_key;

    let mut md = String::new();
    md.push_str(&format!("# {} {}\n\n", paper.title, year_str));
    md.push_str("> 阅读模板：以下仅包含文献题录、摘要和待填写问题，未分析 PDF 正文。\n\n");

    // Basic metadata branch
    md.push_str("## 📌 基本信息\n");
    md.push_str(&format!("- **作者**: {}\n", authors_str));
    md.push_str(&format!("- **发表于**: {}\n", venue_str));
    md.push_str(&format!("- **引用键**: `@{}`\n", cite_key));
    if let Some(ref doi) = paper.doi {
        md.push_str(&format!("- **DOI**: [{doi}](https://doi.org/{doi})\n"));
    }
    if let Some(ref url) = paper.url {
        md.push_str(&format!("- **链接**: [原文链接]({url})\n"));
    }
    if !paper.keywords.is_empty() {
        md.push_str(&format!("- **关键词**: {}\n", paper.keywords.join(", ")));
    }
    md.push('\n');

    // Abstract / Summary branch
    if let Some(ref abs) = paper.abstract_text {
        md.push_str("## 📝 摘要概览\n");
        // Split abstract into digestible key points
        let sentences: Vec<&str> = abs.split(". ").collect();
        if sentences.len() > 1 {
            for sentence in sentences.iter().take(5) {
                let s = sentence.trim();
                if !s.is_empty() {
                    md.push_str(&format!("- {s}.\n"));
                }
            }
        } else {
            md.push_str(&format!("- {}\n", abs.trim()));
        }
        md.push('\n');
    }

    // Academic Structure Breakdown branches
    md.push_str("## 🎯 研究背景与问题\n");
    md.push_str("- 研究领域核心痛点\n");
    md.push_str("- 现有 baseline / SOTA 方法的局限\n");
    md.push_str("- 本文解决的核心问题假设\n\n");

    md.push_str("## 💡 核心贡献与创新点\n");
    md.push_str("- 待读正文后填写论文报告的贡献与证据\n\n");

    md.push_str("## ⚙️ 核心架构与方法论\n");
    md.push_str("- 整体架构流程图\n");
    md.push_str("- 关键算子与模块设计\n");
    md.push_str("- 损失函数与优化目标\n\n");

    md.push_str("## 📊 实验与评测结果\n");
    md.push_str("- 评测基准数据集\n");
    md.push_str("- 主要指标与消融实验 (Ablation Study)\n");
    md.push_str("- 案例分析与定性表现\n\n");

    md.push_str("## 🔍 思考与启示\n");
    if let Some(ref notes) = paper.notes {
        if !notes.trim().is_empty() {
            md.push_str(&format!("- **个人笔记**: {}\n", notes.trim()));
        } else {
            md.push_str("- 论文的局限性与潜在改进方向\n");
            md.push_str("- 对我们自身项目的参考意义\n");
        }
    } else {
        md.push_str("- 论文的局限性与潜在改进方向\n");
        md.push_str("- 对我们自身项目的参考意义\n");
    }

    Ok(md)
}
