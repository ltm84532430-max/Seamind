use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT, ACCEPT};

use crate::bibtex::{
    clean_doi, generate_cite_key, parse_bibtex, serialize_bibtex, ParsedBibEntry,
};
use crate::literature_store as store;

const DATABASE_FILE: &str = "literature.sqlite3";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("无法定位文献数据目录：{e}"))?;
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
        HeaderValue::from_static("Seamind-Desktop/0.1.0 (mailto:seamind@markmap.org)"),
    );
    headers.insert(ACCEPT, HeaderValue::from_static("application/json, text/xml, */*"));

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
    store::upsert_paper(&open_db(&app)?, &paper, now())
}

#[tauri::command(async)]
pub fn literature_delete(app: AppHandle, id: String) -> Result<(), String> {
    store::delete_paper(&open_db(&app)?, &id)
}

#[tauri::command(async)]
pub fn literature_batch_delete(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    store::batch_delete_papers(&open_db(&app)?, &ids)
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
    let cleaned = arxiv_id
        .trim()
        .trim_start_matches("arxiv:")
        .trim_start_matches("arXiv:")
        .trim();
    if cleaned.is_empty() {
        return Err("请输入有效的 arXiv ID".to_string());
    }

    let encoded = url::form_urlencoded::byte_serialize(cleaned.as_bytes()).collect::<String>();
    let url = format!(
        "http://export.arxiv.org/api/query?id_list={encoded}&max_results=1"
    );
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

    let doc = roxmltree::Document::parse(&xml)
        .map_err(|e| format!("解析 arXiv XML 失败：{e}"))?;

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
    let col_ids = collection_id.map(|cid| vec![cid]);
    let current_time = now();
    let mut count = 0;

    for entry in entries {
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
    let paper = store::get_paper(&conn, &id)?
        .ok_or_else(|| "未找到指定文献".to_string())?;

    let year_str = paper
        .year
        .map(|y| format!(" ({y})"))
        .unwrap_or_default();
    let authors_str = if paper.authors.is_empty() {
        "佚名".to_string()
    } else {
        paper.authors.join(", ")
    };
    let venue_str = paper.venue.as_deref().unwrap_or("未标注刊物/会议");
    let cite_key = paper.cite_key;

    let mut md = String::new();
    md.push_str(&format!("# {} {}\n\n", paper.title, year_str));

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
    md.push_str("- **理论/算法创新**: 提出了新的模型架构或算法机制\n");
    md.push_str("- **工程与效率优化**: 降低了复杂度或加速了训练/推理\n");
    md.push_str("- **实验突破**: 在核心评测集上取得的新 SOTA\n\n");

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
