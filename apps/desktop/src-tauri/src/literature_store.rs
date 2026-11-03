use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::bibtex::{generate_cite_key, ParsedBibEntry};

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS papers (
    id TEXT PRIMARY KEY NOT NULL,
    cite_key TEXT NOT NULL UNIQUE,
    entry_type TEXT NOT NULL DEFAULT 'article',
    title TEXT NOT NULL,
    authors TEXT NOT NULL DEFAULT '[]',
    year INTEGER,
    venue TEXT,
    volume TEXT,
    number TEXT,
    pages TEXT,
    publisher TEXT,
    doi TEXT,
    url TEXT,
    arxiv_id TEXT,
    abstract TEXT,
    keywords TEXT NOT NULL DEFAULT '[]',
    pdf_path TEXT,
    pdf_sha256 TEXT,
    read_status TEXT NOT NULL DEFAULT 'unread',
    rating INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    bibtex TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_papers_cite_key ON papers(cite_key);
CREATE INDEX IF NOT EXISTS idx_papers_title ON papers(title);
CREATE INDEX IF NOT EXISTS idx_papers_year ON papers(year);
CREATE INDEX IF NOT EXISTS idx_papers_read_status ON papers(read_status);

CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    color TEXT,
    icon TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_collection_items (
    paper_id TEXT NOT NULL,
    collection_id TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (paper_id, collection_id),
    FOREIGN KEY(paper_id) REFERENCES papers(id) ON DELETE CASCADE,
    FOREIGN KEY(collection_id) REFERENCES collections(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS paper_annotations (
    id TEXT PRIMARY KEY NOT NULL,
    paper_id TEXT NOT NULL,
    page_number INTEGER NOT NULL,
    selected_text TEXT NOT NULL,
    comment TEXT,
    color TEXT,
    rects_json TEXT NOT NULL DEFAULT '[]',
    context_before TEXT,
    context_after TEXT,
    pdf_sha256 TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(paper_id) REFERENCES papers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS paper_reading_progress (
    paper_id TEXT PRIMARY KEY NOT NULL,
    page_number INTEGER NOT NULL DEFAULT 1,
    scale REAL NOT NULL DEFAULT 1.0,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(paper_id) REFERENCES papers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS paper_pdf_sources (
    paper_id TEXT PRIMARY KEY NOT NULL,
    source_type TEXT NOT NULL,
    source_url TEXT,
    version TEXT,
    license TEXT,
    acquired_at INTEGER NOT NULL,
    FOREIGN KEY(paper_id) REFERENCES papers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS paper_pdf_attempts (
    paper_id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    attempted_at INTEGER NOT NULL,
    FOREIGN KEY(paper_id) REFERENCES papers(id) ON DELETE CASCADE
);
";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperItem {
    pub id: String,
    pub cite_key: String,
    pub entry_type: String,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i32>,
    pub venue: Option<String>,
    pub volume: Option<String>,
    pub number: Option<String>,
    pub pages: Option<String>,
    pub publisher: Option<String>,
    pub doi: Option<String>,
    pub url: Option<String>,
    pub arxiv_id: Option<String>,
    pub abstract_text: Option<String>,
    pub keywords: Vec<String>,
    pub pdf_path: Option<String>,
    pub pdf_sha256: Option<String>,
    pub read_status: String, // "unread", "reading", "completed"
    pub rating: u8,
    pub notes: Option<String>,
    pub bibtex: Option<String>,
    pub collection_ids: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperInput {
    pub id: Option<String>,
    pub cite_key: Option<String>,
    pub entry_type: Option<String>,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i32>,
    pub venue: Option<String>,
    pub volume: Option<String>,
    pub number: Option<String>,
    pub pages: Option<String>,
    pub publisher: Option<String>,
    pub doi: Option<String>,
    pub url: Option<String>,
    pub arxiv_id: Option<String>,
    pub abstract_text: Option<String>,
    pub keywords: Option<Vec<String>>,
    pub pdf_path: Option<String>,
    pub read_status: Option<String>,
    pub rating: Option<u8>,
    pub notes: Option<String>,
    pub bibtex: Option<String>,
    pub collection_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperAnnotationRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperAnnotation {
    pub id: String,
    pub paper_id: String,
    pub page_number: i64,
    pub selected_text: String,
    pub comment: Option<String>,
    pub color: Option<String>,
    pub rects: Vec<PaperAnnotationRect>,
    pub context_before: Option<String>,
    pub context_after: Option<String>,
    pub pdf_sha256: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperAnnotationInput {
    pub id: Option<String>,
    pub paper_id: String,
    pub page_number: i64,
    pub selected_text: String,
    pub comment: Option<String>,
    pub color: Option<String>,
    pub rects: Vec<PaperAnnotationRect>,
    pub context_before: Option<String>,
    pub context_after: Option<String>,
    pub pdf_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperReadingProgress {
    pub paper_id: String,
    pub page_number: i64,
    pub scale: f64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperCollection {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub paper_count: usize,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionInput {
    pub id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PaperFilter {
    pub query: Option<String>,
    pub collection_id: Option<String>,
    pub tag: Option<String>,
    pub read_status: Option<String>,
    pub sort_by: Option<String>, // "updatedAt", "year", "title", "rating"
    pub sort_order: Option<String>, // "asc", "desc"
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureOverview {
    pub total_papers: usize,
    pub unread_count: usize,
    pub reading_count: usize,
    pub completed_count: usize,
    pub starred_count: usize,
    pub collections: Vec<PaperCollection>,
    pub all_tags: Vec<TagCount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub name: String,
    pub count: usize,
}

pub fn open(path: &std::path::Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("无法打开文献数据库：{e}"))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("启用文献数据库关联约束失败：{e}"))?;
    conn.execute_batch(SCHEMA)
        .map_err(|e| format!("初始化文献数据库结构失败：{e}"))?;
    ensure_column(&conn, "papers", "pdf_sha256", "TEXT")?;
    ensure_column(
        &conn,
        "paper_annotations",
        "rects_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    ensure_column(&conn, "paper_annotations", "context_before", "TEXT")?;
    ensure_column(&conn, "paper_annotations", "context_after", "TEXT")?;
    ensure_column(&conn, "paper_annotations", "pdf_sha256", "TEXT")?;
    ensure_column(
        &conn,
        "paper_annotations",
        "updated_at",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    Ok(conn)
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| format!("检查文献数据库字段失败：{e}"))?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("读取文献数据库字段失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取文献数据库字段失败：{e}"))?;
    if !columns.iter().any(|name| name == column) {
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))
        .map_err(|e| format!("升级文献数据库字段失败：{e}"))?;
    }
    Ok(())
}

pub fn upsert_paper(conn: &Connection, input: &PaperInput, now: i64) -> Result<PaperItem, String> {
    let id = input
        .id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let entry_type = input
        .entry_type
        .clone()
        .unwrap_or_else(|| "article".to_string());

    let cite_key = input
        .cite_key
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| generate_cite_key(&input.authors, input.year, &input.title));

    // Ensure cite_key is unique, if conflict and id is different, add suffix
    let final_cite_key = ensure_unique_cite_key(conn, &cite_key, &id)?;

    let authors_json = serde_json::to_string(&input.authors).unwrap_or_else(|_| "[]".to_string());
    let keywords_vec = input.keywords.clone().unwrap_or_default();
    let keywords_json = serde_json::to_string(&keywords_vec).unwrap_or_else(|_| "[]".to_string());
    let read_status = input
        .read_status
        .clone()
        .unwrap_or_else(|| "unread".to_string());
    let rating = input.rating.unwrap_or(0);

    // If bibtex is missing, generate one
    let bibtex = input.bibtex.clone().unwrap_or_else(|| {
        let entry = ParsedBibEntry {
            cite_key: final_cite_key.clone(),
            entry_type: entry_type.clone(),
            title: input.title.clone(),
            authors: input.authors.clone(),
            year: input.year,
            venue: input.venue.clone(),
            volume: input.volume.clone(),
            number: input.number.clone(),
            pages: input.pages.clone(),
            publisher: input.publisher.clone(),
            doi: input.doi.clone(),
            url: input.url.clone(),
            eprint: input.arxiv_id.clone(),
            abstract_text: input.abstract_text.clone(),
            keywords: keywords_vec.clone(),
            raw_fields: std::collections::HashMap::new(),
        };
        crate::bibtex::serialize_bibtex(&entry)
    });

    conn.execute(
        "INSERT INTO papers (
            id, cite_key, entry_type, title, authors, year, venue, volume, number, pages,
            publisher, doi, url, arxiv_id, abstract, keywords, pdf_path, read_status, rating,
            notes, bibtex, created_at, updated_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
            ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19,
            ?20, ?21, ?22, ?23
        ) ON CONFLICT(id) DO UPDATE SET
            cite_key = excluded.cite_key,
            entry_type = excluded.entry_type,
            title = excluded.title,
            authors = excluded.authors,
            year = excluded.year,
            venue = excluded.venue,
            volume = excluded.volume,
            number = excluded.number,
            pages = excluded.pages,
            publisher = excluded.publisher,
            doi = excluded.doi,
            url = excluded.url,
            arxiv_id = excluded.arxiv_id,
            abstract = excluded.abstract,
            keywords = excluded.keywords,
            pdf_path = COALESCE(excluded.pdf_path, papers.pdf_path),
            read_status = excluded.read_status,
            rating = excluded.rating,
            notes = excluded.notes,
            bibtex = excluded.bibtex,
            updated_at = excluded.updated_at;",
        params![
            id,
            final_cite_key,
            entry_type,
            input.title,
            authors_json,
            input.year,
            input.venue,
            input.volume,
            input.number,
            input.pages,
            input.publisher,
            input.doi,
            input.url,
            input.arxiv_id,
            input.abstract_text,
            keywords_json,
            input.pdf_path,
            read_status,
            rating,
            input.notes,
            bibtex,
            now,
            now
        ],
    )
    .map_err(|e| format!("保存文献失败：{e}"))?;

    // Update collections if provided
    if let Some(ref col_ids) = input.collection_ids {
        set_paper_collections(conn, &id, col_ids, now)?;
    }

    get_paper(conn, &id)?.ok_or_else(|| "文献保存后无法查出".to_string())
}

fn ensure_unique_cite_key(
    conn: &Connection,
    cite_key: &str,
    current_id: &str,
) -> Result<String, String> {
    let mut candidate = cite_key.to_string();
    let mut suffix = 'a';

    loop {
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM papers WHERE cite_key = ?1",
                params![candidate],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("查询引用键冲突失败：{e}"))?;

        match existing {
            Some(existing_id) if existing_id != current_id => {
                candidate = format!("{cite_key}{suffix}");
                suffix = ((suffix as u8) + 1) as char;
            }
            _ => return Ok(candidate),
        }
    }
}

pub fn get_paper(conn: &Connection, id: &str) -> Result<Option<PaperItem>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, cite_key, entry_type, title, authors, year, venue, volume, number, pages,
                    publisher, doi, url, arxiv_id, abstract, keywords, pdf_path, pdf_sha256,
                    read_status, rating, notes, bibtex, created_at, updated_at
             FROM papers WHERE id = ?1",
        )
        .map_err(|e| format!("准备查询语句失败：{e}"))?;

    let row = stmt
        .query_row(params![id], |row| {
            let authors_json: String = row.get(4)?;
            let keywords_json: String = row.get(15)?;
            let authors: Vec<String> = serde_json::from_str(&authors_json).unwrap_or_default();
            let keywords: Vec<String> = serde_json::from_str(&keywords_json).unwrap_or_default();

            Ok(PaperItem {
                id: row.get(0)?,
                cite_key: row.get(1)?,
                entry_type: row.get(2)?,
                title: row.get(3)?,
                authors,
                year: row.get(5)?,
                venue: row.get(6)?,
                volume: row.get(7)?,
                number: row.get(8)?,
                pages: row.get(9)?,
                publisher: row.get(10)?,
                doi: row.get(11)?,
                url: row.get(12)?,
                arxiv_id: row.get(13)?,
                abstract_text: row.get(14)?,
                keywords,
                pdf_path: row.get(16)?,
                pdf_sha256: row.get(17)?,
                read_status: row.get(18)?,
                rating: row.get(19)?,
                notes: row.get(20)?,
                bibtex: row.get(21)?,
                collection_ids: Vec::new(),
                created_at: row.get(22)?,
                updated_at: row.get(23)?,
            })
        })
        .optional()
        .map_err(|e| format!("查询文献失败：{e}"))?;

    let mut paper = match row {
        Some(p) => p,
        None => return Ok(None),
    };

    // Populate collection ids
    let mut col_stmt = conn
        .prepare("SELECT collection_id FROM paper_collection_items WHERE paper_id = ?1")
        .map_err(|e| format!("准备查询群组语句失败：{e}"))?;
    let col_ids: Vec<String> = col_stmt
        .query_map(params![id], |row| row.get(0))
        .map_err(|e| format!("查询文献群组失败：{e}"))?
        .filter_map(|r| r.ok())
        .collect();
    paper.collection_ids = col_ids;

    Ok(Some(paper))
}

pub fn find_existing_paper_id(
    conn: &Connection,
    doi: Option<&str>,
    arxiv_id: Option<&str>,
) -> Result<Option<String>, String> {
    let normalize_doi = |value: &str| crate::bibtex::clean_doi(value).trim().to_ascii_lowercase();
    let version_re = regex::Regex::new(r"(?i)v\d+$").unwrap();
    let normalize_arxiv = |value: &str| crate::literature_resolver::arxiv_id(value).map(|id| {
        version_re.replace(&id, "").to_ascii_lowercase()
    });
    let wanted_doi = doi.map(normalize_doi).filter(|v| !v.is_empty());
    let wanted_arxiv = arxiv_id.and_then(normalize_arxiv).or_else(|| doi.and_then(normalize_arxiv));
    if wanted_doi.is_none() && wanted_arxiv.is_none() { return Ok(None); }
    let mut statement = conn.prepare("SELECT id,doi,arxiv_id FROM papers WHERE doi IS NOT NULL OR arxiv_id IS NOT NULL")
        .map_err(|e| format!("Query paper identifiers failed: {e}"))?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?)))
        .map_err(|e| format!("Query paper identifiers failed: {e}"))?;
    for row in rows {
        let (id, old_doi, old_arxiv) = row.map_err(|e| format!("Read paper identifiers failed: {e}"))?;
        let doi_match = wanted_doi.as_ref().is_some_and(|d| old_doi.as_deref().is_some_and(|v| normalize_doi(v) == *d));
        let old_arxiv = old_arxiv.as_deref().and_then(normalize_arxiv).or_else(|| old_doi.as_deref().and_then(normalize_arxiv));
        if doi_match || (wanted_arxiv.is_some() && wanted_arxiv == old_arxiv) { return Ok(Some(id)); }
    }
    Ok(None)
}

pub fn list_papers(conn: &Connection, filter: &PaperFilter) -> Result<Vec<PaperItem>, String> {
    let mut sql = String::from(
        "SELECT p.id, p.cite_key, p.entry_type, p.title, p.authors, p.year, p.venue, p.volume,
                p.number, p.pages, p.publisher, p.doi, p.url, p.arxiv_id, p.abstract, p.keywords,
                p.pdf_path, p.pdf_sha256, p.read_status, p.rating, p.notes, p.bibtex,
                p.created_at, p.updated_at
         FROM papers p ",
    );

    let mut conditions = Vec::new();
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(ref col_id) = filter.collection_id {
        sql.push_str("JOIN paper_collection_items pci ON p.id = pci.paper_id ");
        conditions.push("pci.collection_id = ?");
        params_vec.push(Box::new(col_id.clone()));
    }

    if let Some(ref query) = filter.query {
        let trimmed = query.trim();
        if !trimmed.is_empty() {
            let pattern = format!("%{trimmed}%");
            conditions.push("(p.title LIKE ? OR p.cite_key LIKE ? OR p.authors LIKE ? OR p.venue LIKE ? OR p.keywords LIKE ? OR p.abstract LIKE ?)");
            params_vec.push(Box::new(pattern.clone()));
            params_vec.push(Box::new(pattern.clone()));
            params_vec.push(Box::new(pattern.clone()));
            params_vec.push(Box::new(pattern.clone()));
            params_vec.push(Box::new(pattern.clone()));
            params_vec.push(Box::new(pattern));
        }
    }

    if let Some(ref status) = filter.read_status {
        if status == "starred" {
            conditions.push("p.rating > 0");
        } else if !status.is_empty() && status != "all" {
            conditions.push("p.read_status = ?");
            params_vec.push(Box::new(status.clone()));
        }
    }

    if let Some(ref tag) = filter.tag {
        if !tag.is_empty() {
            let tag_pattern = format!("%\"{tag}\"%");
            conditions.push("p.keywords LIKE ?");
            params_vec.push(Box::new(tag_pattern));
        }
    }

    if !conditions.is_empty() {
        sql.push_str("WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }

    // Sort order
    let sort_col = match filter.sort_by.as_deref() {
        Some("year") => "p.year",
        Some("title") => "p.title",
        Some("rating") => "p.rating",
        Some("citeKey") => "p.cite_key",
        _ => "p.updated_at",
    };
    let sort_dir = match filter.sort_order.as_deref() {
        Some("asc") => "ASC",
        _ => "DESC",
    };
    sql.push_str(&format!(" ORDER BY {sort_col} {sort_dir}"));

    if let Some(limit) = filter.limit {
        sql.push_str(&format!(" LIMIT {limit}"));
        if let Some(offset) = filter.offset {
            sql.push_str(&format!(" OFFSET {offset}"));
        }
    }

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("准备查询语句失败：{e}"))?;

    let params_slice: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|b| b.as_ref()).collect();

    let rows = stmt
        .query_map(params_slice.as_slice(), |row| {
            let authors_json: String = row.get(4)?;
            let keywords_json: String = row.get(15)?;
            let authors: Vec<String> = serde_json::from_str(&authors_json).unwrap_or_default();
            let keywords: Vec<String> = serde_json::from_str(&keywords_json).unwrap_or_default();

            Ok(PaperItem {
                id: row.get(0)?,
                cite_key: row.get(1)?,
                entry_type: row.get(2)?,
                title: row.get(3)?,
                authors,
                year: row.get(5)?,
                venue: row.get(6)?,
                volume: row.get(7)?,
                number: row.get(8)?,
                pages: row.get(9)?,
                publisher: row.get(10)?,
                doi: row.get(11)?,
                url: row.get(12)?,
                arxiv_id: row.get(13)?,
                abstract_text: row.get(14)?,
                keywords,
                pdf_path: row.get(16)?,
                pdf_sha256: row.get(17)?,
                read_status: row.get(18)?,
                rating: row.get(19)?,
                notes: row.get(20)?,
                bibtex: row.get(21)?,
                collection_ids: Vec::new(),
                created_at: row.get(22)?,
                updated_at: row.get(23)?,
            })
        })
        .map_err(|e| format!("执行文献列表查询失败：{e}"))?;

    let mut papers = Vec::new();
    for r in rows {
        if let Ok(paper) = r {
            papers.push(paper);
        }
    }

    Ok(papers)
}

pub fn delete_paper(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM papers WHERE id = ?1", params![id])
        .map_err(|e| format!("删除文献失败：{e}"))?;
    Ok(())
}

pub fn batch_delete_papers(conn: &Connection, ids: &[String]) -> Result<(), String> {
    for id in ids {
        delete_paper(conn, id)?;
    }
    Ok(())
}

pub fn update_read_status(
    conn: &Connection,
    id: &str,
    status: &str,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE papers SET read_status = ?1, updated_at = ?2 WHERE id = ?3",
        params![status, now, id],
    )
    .map_err(|e| format!("更新阅读状态失败：{e}"))?;
    Ok(())
}

pub fn update_rating(conn: &Connection, id: &str, rating: u8, now: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE papers SET rating = ?1, updated_at = ?2 WHERE id = ?3",
        params![rating, now, id],
    )
    .map_err(|e| format!("更新评分失败：{e}"))?;
    Ok(())
}

pub fn update_notes(conn: &Connection, id: &str, notes: &str, now: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE papers SET notes = ?1, updated_at = ?2 WHERE id = ?3",
        params![notes, now, id],
    )
    .map_err(|e| format!("更新文献笔记失败：{e}"))?;
    Ok(())
}

pub fn update_paper_pdf(
    conn: &Connection,
    id: &str,
    relative_path: &str,
    sha256: &str,
    now: i64,
) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE papers SET pdf_path = ?1, pdf_sha256 = ?2, updated_at = ?3 WHERE id = ?4",
            params![relative_path, sha256, now, id],
        )
        .map_err(|e| format!("关联论文 PDF 失败：{e}"))?;
    if changed == 0 {
        return Err("找不到要关联 PDF 的文献记录。".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperPdfSource {
    pub source_type: String,
    pub source_url: Option<String>,
    pub version: Option<String>,
    pub license: Option<String>,
    pub acquired_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperPdfAttempt {
    pub status: String,
    pub message: Option<String>,
    pub attempted_at: i64,
}

pub fn pdf_attempt(conn: &Connection, id: &str) -> Result<Option<PaperPdfAttempt>, String> {
    conn.query_row("SELECT status,message,attempted_at FROM paper_pdf_attempts WHERE paper_id=?1", params![id],
        |row| Ok(PaperPdfAttempt { status: row.get(0)?, message: row.get(1)?, attempted_at: row.get(2)? }))
        .optional().map_err(|e| format!("读取原文状态失败：{e}"))
}

pub fn set_pdf_attempt(conn: &Connection, id: &str, status: &str, message: Option<&str>, now: i64) -> Result<(), String> {
    conn.execute("INSERT INTO paper_pdf_attempts(paper_id,status,message,attempted_at) VALUES (?1,?2,?3,?4) ON CONFLICT(paper_id) DO UPDATE SET status=excluded.status,message=excluded.message,attempted_at=excluded.attempted_at", params![id,status,message,now])
        .map_err(|e| format!("记录原文状态失败：{e}"))?;
    Ok(())
}

pub fn pdf_source(conn: &Connection, id: &str) -> Result<Option<PaperPdfSource>, String> {
    conn.query_row("SELECT source_type,source_url,version,license,acquired_at FROM paper_pdf_sources WHERE paper_id=?1",
        params![id], |row| Ok(PaperPdfSource { source_type: row.get(0)?, source_url: row.get(1)?, version: row.get(2)?, license: row.get(3)?, acquired_at: row.get(4)? }))
        .optional().map_err(|e| format!("读取 PDF 来源失败：{e}"))
}

pub fn set_pdf_source(conn: &Connection, id: &str, source: &PaperPdfSource) -> Result<(), String> {
    conn.execute("INSERT INTO paper_pdf_sources(paper_id,source_type,source_url,version,license,acquired_at) VALUES (?1,?2,?3,?4,?5,?6)
        ON CONFLICT(paper_id) DO UPDATE SET source_type=excluded.source_type,source_url=excluded.source_url,version=excluded.version,license=excluded.license,acquired_at=excluded.acquired_at",
        params![id, source.source_type, source.source_url, source.version, source.license, source.acquired_at])
        .map_err(|e| format!("记录 PDF 来源失败：{e}"))?;
    Ok(())
}

#[cfg(test)]
mod pdf_source_tests {
    use super::*;

    #[test]
    fn duplicate_identifiers_find_existing_paper_without_rewriting_it() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute("INSERT INTO papers(id,cite_key,title,doi,arxiv_id,notes,read_status,created_at,updated_at) VALUES ('p1','one','Paper','10.48550/arXiv.1706.03762','1706.03762v7','keep notes','reading',1,1)", []).unwrap();
        assert_eq!(find_existing_paper_id(&conn, Some("https://doi.org/10.48550/arxiv.1706.03762"), None).unwrap().as_deref(), Some("p1"));
        assert_eq!(find_existing_paper_id(&conn, None, Some("arXiv:1706.03762v2")).unwrap().as_deref(), Some("p1"));
        assert!(find_existing_paper_id(&conn, Some("10.1234/unrelated"), None).unwrap().is_none());
        assert_eq!(conn.query_row("SELECT notes FROM papers WHERE id='p1'", [], |row| row.get::<_, String>(0)).unwrap(), "keep notes");
    }

    #[test]
    fn provenance_is_updated_and_removed_with_the_paper() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute("INSERT INTO papers(id,cite_key,title,created_at,updated_at) VALUES ('p1','one','Paper',1,1)", []).unwrap();
        let source = PaperPdfSource { source_type: "arXiv".into(), source_url: Some("https://arxiv.org/pdf/1706.03762".into()), version: None, license: None, acquired_at: 2 };
        set_pdf_source(&conn,"p1",&source).unwrap();
        assert_eq!(pdf_source(&conn,"p1").unwrap().unwrap().source_type,"arXiv");
        set_pdf_attempt(&conn,"p1","failed",Some("network unavailable"),3).unwrap();
        assert_eq!(pdf_attempt(&conn,"p1").unwrap().unwrap().status,"failed");
        set_pdf_attempt(&conn,"p1","available",None,4).unwrap();
        assert_eq!(pdf_attempt(&conn,"p1").unwrap().unwrap().status,"available");
        conn.execute("DELETE FROM papers WHERE id='p1'", []).unwrap();
        assert!(pdf_source(&conn,"p1").unwrap().is_none());
        assert!(pdf_attempt(&conn,"p1").unwrap().is_none());
    }
}

pub fn list_paper_annotations(
    conn: &Connection,
    paper_id: &str,
) -> Result<Vec<PaperAnnotation>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, paper_id, page_number, selected_text, comment, color, rects_json,
                    context_before, context_after, pdf_sha256, created_at, updated_at
             FROM paper_annotations WHERE paper_id = ?1 ORDER BY page_number, created_at",
        )
        .map_err(|e| format!("准备查询论文批注失败：{e}"))?;
    let rows = stmt
        .query_map(params![paper_id], |row| {
            let rects_json: String = row.get(6)?;
            Ok(PaperAnnotation {
                id: row.get(0)?,
                paper_id: row.get(1)?,
                page_number: row.get(2)?,
                selected_text: row.get(3)?,
                comment: row.get(4)?,
                color: row.get(5)?,
                rects: serde_json::from_str(&rects_json).unwrap_or_default(),
                context_before: row.get(7)?,
                context_after: row.get(8)?,
                pdf_sha256: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })
        .map_err(|e| format!("查询论文批注失败：{e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取论文批注失败：{e}"))
}

pub fn save_paper_annotation(
    conn: &Connection,
    input: &PaperAnnotationInput,
    now: i64,
) -> Result<PaperAnnotation, String> {
    if input.page_number < 1 {
        return Err("批注页码必须从 1 开始。".to_string());
    }
    if input.selected_text.trim().is_empty() {
        return Err("请先选中 PDF 中的文字。".to_string());
    }
    if input.rects.is_empty() || input.rects.len() > 256 {
        return Err("批注位置无效，请重新选择文字。".to_string());
    }
    if input.rects.iter().any(|rect| {
        !rect.x.is_finite()
            || !rect.y.is_finite()
            || !rect.width.is_finite()
            || !rect.height.is_finite()
            || rect.x < 0.0
            || rect.y < 0.0
            || rect.width <= 0.0
            || rect.height <= 0.0
            || rect.x + rect.width > 1.02
            || rect.y + rect.height > 1.02
    }) {
        return Err("批注坐标超出页面范围，请重新选择文字。".to_string());
    }

    let id = input
        .id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let rects_json =
        serde_json::to_string(&input.rects).map_err(|e| format!("序列化批注位置失败：{e}"))?;
    conn.execute(
        "INSERT INTO paper_annotations (
            id, paper_id, page_number, selected_text, comment, color, rects_json,
            context_before, context_after, pdf_sha256, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
        ON CONFLICT(id) DO UPDATE SET
            page_number = excluded.page_number,
            selected_text = excluded.selected_text,
            comment = excluded.comment,
            color = excluded.color,
            rects_json = excluded.rects_json,
            context_before = excluded.context_before,
            context_after = excluded.context_after,
            pdf_sha256 = excluded.pdf_sha256,
            updated_at = excluded.updated_at
        WHERE paper_annotations.paper_id = excluded.paper_id",
        params![
            id,
            input.paper_id,
            input.page_number,
            input.selected_text,
            input.comment,
            input.color,
            rects_json,
            input.context_before,
            input.context_after,
            input.pdf_sha256,
            now
        ],
    )
    .map_err(|e| format!("保存论文批注失败：{e}"))?;

    list_paper_annotations(conn, &input.paper_id)?
        .into_iter()
        .find(|annotation| annotation.id == id)
        .ok_or_else(|| "论文批注保存后无法读取。".to_string())
}

pub fn delete_paper_annotation(
    conn: &Connection,
    paper_id: &str,
    annotation_id: &str,
) -> Result<(), String> {
    let changed = conn
        .execute(
            "DELETE FROM paper_annotations WHERE paper_id = ?1 AND id = ?2",
            params![paper_id, annotation_id],
        )
        .map_err(|e| format!("删除论文批注失败：{e}"))?;
    if changed == 0 {
        return Err("找不到要删除的论文批注。".to_string());
    }
    Ok(())
}

pub fn get_paper_reading_progress(
    conn: &Connection,
    paper_id: &str,
) -> Result<Option<PaperReadingProgress>, String> {
    conn.query_row(
        "SELECT paper_id, page_number, scale, updated_at
         FROM paper_reading_progress WHERE paper_id = ?1",
        params![paper_id],
        |row| {
            Ok(PaperReadingProgress {
                paper_id: row.get(0)?,
                page_number: row.get(1)?,
                scale: row.get(2)?,
                updated_at: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("查询论文阅读进度失败：{e}"))
}

pub fn save_paper_reading_progress(
    conn: &Connection,
    paper_id: &str,
    page_number: i64,
    scale: f64,
    now: i64,
) -> Result<PaperReadingProgress, String> {
    if page_number < 1 || !scale.is_finite() || !(0.35..=3.0).contains(&scale) {
        return Err("论文阅读进度参数无效。".to_string());
    }
    let changed = conn
        .execute(
            "INSERT INTO paper_reading_progress (paper_id, page_number, scale, updated_at)
             SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM papers WHERE id = ?1)
             ON CONFLICT(paper_id) DO UPDATE SET
                page_number = excluded.page_number,
                scale = excluded.scale,
                updated_at = excluded.updated_at",
            params![paper_id, page_number, scale, now],
        )
        .map_err(|e| format!("保存论文阅读进度失败：{e}"))?;
    if changed == 0 {
        return Err("找不到要保存阅读进度的文献记录。".to_string());
    }
    get_paper_reading_progress(conn, paper_id)?
        .ok_or_else(|| "论文阅读进度保存后无法读取。".to_string())
}

pub fn set_paper_collections(
    conn: &Connection,
    paper_id: &str,
    collection_ids: &[String],
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM paper_collection_items WHERE paper_id = ?1",
        params![paper_id],
    )
    .map_err(|e| format!("清空旧群组关联失败：{e}"))?;

    let mut stmt = conn
        .prepare("INSERT OR IGNORE INTO paper_collection_items (paper_id, collection_id, added_at) VALUES (?1, ?2, ?3)")
        .map_err(|e| format!("准备群组插入失败：{e}"))?;

    for cid in collection_ids {
        stmt.execute(params![paper_id, cid, now])
            .map_err(|e| format!("插入群组关联失败：{e}"))?;
    }

    Ok(())
}

pub fn list_collections(conn: &Connection) -> Result<Vec<PaperCollection>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.name, c.description, c.color, c.icon, c.created_at,
                    COUNT(pci.paper_id) as paper_count
             FROM collections c
             LEFT JOIN paper_collection_items pci ON c.id = pci.collection_id
             GROUP BY c.id
             ORDER BY c.created_at ASC",
        )
        .map_err(|e| format!("准备群组列表查询失败：{e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(PaperCollection {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                color: row.get(3)?,
                icon: row.get(4)?,
                created_at: row.get(5)?,
                paper_count: row.get::<_, i64>(6)? as usize,
            })
        })
        .map_err(|e| format!("查询群组列表失败：{e}"))?;

    let mut collections = Vec::new();
    for r in rows {
        if let Ok(c) = r {
            collections.push(c);
        }
    }
    Ok(collections)
}

pub fn save_collection(
    conn: &Connection,
    input: &CollectionInput,
    now: i64,
) -> Result<PaperCollection, String> {
    let id = input
        .id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    conn.execute(
        "INSERT INTO collections (id, name, description, color, icon, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            color = excluded.color,
            icon = excluded.icon;",
        params![
            id,
            input.name,
            input.description,
            input.color,
            input.icon,
            now
        ],
    )
    .map_err(|e| format!("保存群组失败：{e}"))?;

    let cols = list_collections(conn)?;
    cols.into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| "群组保存后无法查出".to_string())
}

pub fn delete_collection(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM collections WHERE id = ?1", params![id])
        .map_err(|e| format!("删除群组失败：{e}"))?;
    Ok(())
}

pub fn overview(conn: &Connection) -> Result<LiteratureOverview, String> {
    let total_papers: i64 = conn
        .query_row("SELECT COUNT(*) FROM papers", [], |row| row.get(0))
        .unwrap_or(0);

    let unread_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM papers WHERE read_status = 'unread'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let reading_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM papers WHERE read_status = 'reading'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let completed_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM papers WHERE read_status = 'completed'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let starred_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM papers WHERE rating > 0", [], |row| {
            row.get(0)
        })
        .unwrap_or(0);

    let collections = list_collections(conn)?;

    // Aggregate tags
    let mut tag_stmt = conn
        .prepare("SELECT keywords FROM papers WHERE keywords != '[]'")
        .map_err(|e| format!("查询标签失败：{e}"))?;
    let mut tag_map: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let rows = tag_stmt
        .query_map([], |row| {
            let json_str: String = row.get(0)?;
            Ok(json_str)
        })
        .map_err(|e| format!("读取标签失败：{e}"))?;

    for r in rows {
        if let Ok(json_str) = r {
            if let Ok(tags) = serde_json::from_str::<Vec<String>>(&json_str) {
                for t in tags {
                    let cleaned = t.trim().to_string();
                    if !cleaned.is_empty() {
                        *tag_map.entry(cleaned).or_insert(0) += 1;
                    }
                }
            }
        }
    }

    let mut all_tags: Vec<TagCount> = tag_map
        .into_iter()
        .map(|(name, count)| TagCount { name, count })
        .collect();
    all_tags.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));

    Ok(LiteratureOverview {
        total_papers: total_papers as usize,
        unread_count: unread_count as usize,
        reading_count: reading_count as usize,
        completed_count: completed_count as usize,
        starred_count: starred_count as usize,
        collections,
        all_tags,
    })
}
