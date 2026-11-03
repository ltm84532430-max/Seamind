use chrono::DateTime;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, USER_AGENT};
use roxmltree::Node;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tokio::sync::Semaphore;

use crate::feed_store as store;

const DATABASE_FILE: &str = "feed.sqlite3";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(25);
const USER_AGENT_STRING: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MarkmapDesktop/0.1.0 (RSS/Atom Reader)";

fn feed_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|e| format!("无法定位订阅数据目录：{e}"))
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = feed_data_dir(app)?;
    std::fs::create_dir_all(&directory).map_err(|e| format!("无法创建订阅数据目录：{e}"))?;
    Ok(directory.join(DATABASE_FILE))
}

fn open_db(app: &AppHandle) -> Result<rusqlite::Connection, String> {
    let path = database_path(app)?;
    store::open(&path)
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn build_client() -> Result<reqwest::Client, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(USER_AGENT_STRING),
    );
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, */*"),
    );

    reqwest::Client::builder()
        .default_headers(headers)
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("初始化网络请求客户端失败：{e}"))
}

// -----------------------------------------------------------------------------
// Feed Parser (RSS 2.0 / Atom / JSON Feed)
// -----------------------------------------------------------------------------

#[derive(Debug)]
struct ParsedFeed {
    title: String,
    description: Option<String>,
    site_url: Option<String>,
    articles: Vec<store::ArticleInput>,
}

fn parse_feed_content(content: &str, feed_url: &str) -> Result<ParsedFeed, String> {
    let trimmed = content.trim_start();
    if trimmed.starts_with('{') {
        parse_json_feed(trimmed)
    } else {
        parse_xml_feed(content, feed_url)
    }
}

fn parse_json_feed(json_str: &str) -> Result<ParsedFeed, String> {
    let v: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| format!("JSON Feed 解析失败：{e}"))?;

    let title = v["title"]
        .as_str()
        .unwrap_or("未命名订阅源")
        .trim()
        .to_string();
    let description = v["description"].as_str().map(|s| s.trim().to_string());
    let site_url = v["home_page_url"].as_str().map(|s| s.trim().to_string());

    let mut articles = Vec::new();
    if let Some(items) = v["items"].as_array() {
        for it in items {
            let guid = it["id"]
                .as_str()
                .or_else(|| it["url"].as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if guid.is_empty() {
                continue;
            }

            let article_title = it["title"].as_str().unwrap_or("无标题").trim().to_string();
            let url = it["url"].as_str().unwrap_or("").trim().to_string();
            let author = it["authors"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|a| a["name"].as_str())
                .or_else(|| it["author"]["name"].as_str())
                .map(|s| s.trim().to_string());

            let content_html = it["content_html"]
                .as_str()
                .or_else(|| it["content_text"].as_str())
                .unwrap_or("")
                .trim()
                .to_string();

            let summary = it["summary"]
                .as_str()
                .map(|s| s.to_string())
                .unwrap_or_else(|| extract_summary_from_html(&content_html));

            let published_at = it["date_published"]
                .as_str()
                .and_then(parse_date_string)
                .unwrap_or_else(now_secs);

            let reading_time_min = calculate_reading_time(&content_html);

            articles.push(store::ArticleInput {
                guid,
                title: article_title,
                author,
                url,
                content: clean_article_html(&content_html),
                summary,
                published_at,
                reading_time_min,
            });
        }
    }

    Ok(ParsedFeed {
        title,
        description,
        site_url,
        articles,
    })
}

fn parse_xml_feed(xml_str: &str, feed_url: &str) -> Result<ParsedFeed, String> {
    let doc = roxmltree::Document::parse(xml_str)
        .map_err(|e| format!("XML 解析失败，非标准 RSS/Atom 格式：{e}"))?;

    let root = doc.root_element();
    let root_tag = root.tag_name().name().to_lowercase();

    if root_tag == "feed" {
        parse_atom(root)
    } else if root_tag == "rss" || root_tag == "rdf" || root.children().any(|c| c.tag_name().name() == "channel") {
        parse_rss(root, feed_url)
    } else {
        // Fallback: look for channel or entry anywhere
        if root.descendants().any(|n| n.tag_name().name() == "channel") {
            parse_rss(root, feed_url)
        } else if root.descendants().any(|n| n.tag_name().name() == "entry") {
            parse_atom(root)
        } else {
            Err("未识别的 RSS 或 Atom 结构".to_string())
        }
    }
}

fn parse_rss(root: Node, _feed_url: &str) -> Result<ParsedFeed, String> {
    let channel = root
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name().eq_ignore_ascii_case("channel"))
        .ok_or_else(|| "未找到 RSS channel 根节点".to_string())?;

    let title = channel
        .children()
        .find(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case("title"))
        .and_then(|c| c.text())
        .unwrap_or("未命名订阅源")
        .trim()
        .to_string();

    let description = channel
        .children()
        .find(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case("description"))
        .and_then(|c| c.text())
        .map(|s| s.trim().to_string());

    let site_url = channel
        .children()
        .find(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case("link"))
        .and_then(|c| c.text())
        .map(|s| s.trim().to_string());

    let mut articles = Vec::new();
    for item in channel.children().filter(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case("item")) {
        let title = item
            .children()
            .find(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case("title"))
            .and_then(|c| c.text())
            .unwrap_or("无标题")
            .trim()
            .to_string();

        let link = item
            .children()
            .find(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case("link"))
            .and_then(|c| c.text())
            .unwrap_or("")
            .trim()
            .to_string();

        let guid = item
            .children()
            .find(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case("guid"))
            .and_then(|c| c.text())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                if !link.is_empty() {
                    link.clone()
                } else {
                    title.clone()
                }
            });

        let author = item
            .children()
            .find(|c| {
                let name = c.tag_name().name();
                name.eq_ignore_ascii_case("author") || name.eq_ignore_ascii_case("creator")
            })
            .and_then(|c| c.text())
            .map(|s| s.trim().to_string());

        let content_encoded = item
            .children()
            .find(|c| c.tag_name().name().eq_ignore_ascii_case("encoded") || c.tag_name().name().eq_ignore_ascii_case("content"))
            .and_then(|c| c.text());

        let desc = item
            .children()
            .find(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case("description"))
            .and_then(|c| c.text());

        let raw_content = content_encoded.or(desc).unwrap_or("").trim();
        let summary = extract_summary_from_html(desc.unwrap_or(raw_content));
        let cleaned_html = clean_article_html(raw_content);

        let pub_date_str = item
            .children()
            .find(|c| {
                let n = c.tag_name().name();
                n.eq_ignore_ascii_case("pubDate") || n.eq_ignore_ascii_case("date")
            })
            .and_then(|c| c.text());

        let published_at = pub_date_str.and_then(parse_date_string).unwrap_or_else(now_secs);
        let reading_time_min = calculate_reading_time(raw_content);

        articles.push(store::ArticleInput {
            guid,
            title,
            author,
            url: link,
            content: cleaned_html,
            summary,
            published_at,
            reading_time_min,
        });
    }

    Ok(ParsedFeed {
        title,
        description,
        site_url,
        articles,
    })
}

fn parse_atom(root: Node) -> Result<ParsedFeed, String> {
    let title = root
        .children()
        .find(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case("title"))
        .and_then(|c| c.text())
        .unwrap_or("未命名订阅源")
        .trim()
        .to_string();

    let description = root
        .children()
        .find(|c| c.is_element() && (c.tag_name().name().eq_ignore_ascii_case("subtitle") || c.tag_name().name().eq_ignore_ascii_case("description")))
        .and_then(|c| c.text())
        .map(|s| s.trim().to_string());

    let site_url = root
        .children()
        .find(|c| {
            c.is_element()
                && c.tag_name().name().eq_ignore_ascii_case("link")
                && (c.attribute("rel") == Some("alternate") || c.attribute("rel").is_none())
        })
        .and_then(|c| c.attribute("href"))
        .map(|s| s.trim().to_string());

    let mut articles = Vec::new();
    for entry in root.descendants().filter(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case("entry")) {
        let entry_title = entry
            .children()
            .find(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case("title"))
            .and_then(|c| c.text())
            .unwrap_or("无标题")
            .trim()
            .to_string();

        let link = entry
            .children()
            .find(|c| {
                c.is_element()
                    && c.tag_name().name().eq_ignore_ascii_case("link")
                    && (c.attribute("rel") == Some("alternate") || c.attribute("rel").is_none())
            })
            .and_then(|c| c.attribute("href"))
            .unwrap_or("")
            .trim()
            .to_string();

        let id = entry
            .children()
            .find(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case("id"))
            .and_then(|c| c.text())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                if !link.is_empty() {
                    link.clone()
                } else {
                    entry_title.clone()
                }
            });

        let author = entry
            .children()
            .find(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case("author"))
            .and_then(|a| {
                a.children()
                    .find(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case("name"))
                    .and_then(|c| c.text())
            })
            .map(|s| s.trim().to_string());

        let content_node = entry
            .children()
            .find(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case("content"))
            .and_then(|c| c.text());

        let summary_node = entry
            .children()
            .find(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case("summary"))
            .and_then(|c| c.text());

        let raw_content = content_node.or(summary_node).unwrap_or("").trim();
        let summary = extract_summary_from_html(summary_node.unwrap_or(raw_content));
        let cleaned_html = clean_article_html(raw_content);

        let date_str = entry
            .children()
            .find(|c| {
                let n = c.tag_name().name();
                n.eq_ignore_ascii_case("published") || n.eq_ignore_ascii_case("updated")
            })
            .and_then(|c| c.text());

        let published_at = date_str.and_then(parse_date_string).unwrap_or_else(now_secs);
        let reading_time_min = calculate_reading_time(raw_content);

        articles.push(store::ArticleInput {
            guid: id,
            title: entry_title,
            author,
            url: link,
            content: cleaned_html,
            summary,
            published_at,
            reading_time_min,
        });
    }

    Ok(ParsedFeed {
        title,
        description,
        site_url,
        articles,
    })
}

// -----------------------------------------------------------------------------
// Utilities: Dates, Text, HTML Cleaning, Mindmap Conversion
// -----------------------------------------------------------------------------

fn parse_date_string(s: &str) -> Option<i64> {
    let trimmed = s.trim();
    if let Ok(dt) = DateTime::parse_from_rfc2822(trimmed) {
        return Some(dt.timestamp());
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(dt.timestamp());
    }
    // Try YYYY-MM-DD
    if trimmed.len() >= 10 {
        let iso_candidate = format!("{}T00:00:00Z", &trimmed[0..10]);
        if let Ok(dt) = DateTime::parse_from_rfc3339(&iso_candidate) {
            return Some(dt.timestamp());
        }
    }
    None
}

fn strip_html_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut inside_tag = false;
    for ch in input.chars() {
        if ch == '<' {
            inside_tag = true;
        } else if ch == '>' {
            inside_tag = false;
        } else if !inside_tag {
            out.push(ch);
        }
    }
    out.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn extract_summary_from_html(html: &str) -> String {
    let plain = strip_html_tags(html);
    let mut normalized = String::new();
    let mut prev_whitespace = false;
    for ch in plain.chars() {
        if ch.is_whitespace() {
            if !prev_whitespace {
                normalized.push(' ');
                prev_whitespace = true;
            }
        } else {
            normalized.push(ch);
            prev_whitespace = false;
        }
    }
    let trimmed = normalized.trim();
    let max_chars = 180;
    if trimmed.chars().count() > max_chars {
        let truncated: String = trimmed.chars().take(max_chars).collect();
        format!("{truncated}...")
    } else {
        trimmed.to_string()
    }
}

fn clean_article_html(html: &str) -> String {
    if html.is_empty() {
        return String::new();
    }
    // Remove scripts, styles, iframes, form elements
    let re_script = regex::Regex::new(r"(?is)<script[^>]*>.*?</script>").unwrap();
    let re_style = regex::Regex::new(r"(?is)<style[^>]*>.*?</style>").unwrap();
    let re_iframe = regex::Regex::new(r"(?is)<iframe[^>]*>.*?</iframe>").unwrap();
    let re_form = regex::Regex::new(r"(?is)<form[^>]*>.*?</form>").unwrap();

    let step1 = re_script.replace_all(html, "");
    let step2 = re_style.replace_all(&step1, "");
    let step3 = re_iframe.replace_all(&step2, "");
    let cleaned = re_form.replace_all(&step3, "");

    cleaned.to_string()
}

fn calculate_reading_time(text: &str) -> i64 {
    let plain = strip_html_tags(text);
    let char_count = plain.chars().filter(|c| !c.is_whitespace()).count();
    let mins = (char_count as f64 / 450.0).ceil() as i64;
    mins.max(1)
}

// -----------------------------------------------------------------------------
// Mindmap Outline Generator
// -----------------------------------------------------------------------------

pub fn convert_article_to_mindmap(article: &store::FeedArticle) -> String {
    let mut md = String::new();
    md.push_str(&format!("# {}\n\n", article.title.trim()));

    // Level 1: Article Metadata
    md.push_str("## 来源信息\n");
    md.push_str(&format!("- 来源：{}\n", article.channel_title));
    if let Some(author) = &article.author {
        md.push_str(&format!("- 作者：{}\n", author.trim()));
    }
    if article.published_at > 0 {
        if let Some(dt) = DateTime::from_timestamp(article.published_at, 0) {
            md.push_str(&format!("- 发布时间：{}\n", dt.format("%Y-%m-%d %H:%M")));
        }
    }
    if !article.url.is_empty() {
        md.push_str(&format!("- 原文链接：[{}]({})\n", article.title.trim(), article.url));
    }
    md.push('\n');

    // Level 1: Summary
    if !article.summary.is_empty() {
        md.push_str("## 核心摘要\n");
        for line in article.summary.lines() {
            let t = line.trim();
            if !t.is_empty() {
                md.push_str(&format!("- {t}\n"));
            }
        }
        md.push('\n');
    }

    // Level 1: Extracted Content Structure
    md.push_str("## 正文大纲与核心要点\n");

    let clean = strip_html_tags(&article.content);
    let mut paragraphs: Vec<&str> = clean
        .lines()
        .map(str::trim)
        .filter(|line| line.len() >= 15)
        .collect();

    if paragraphs.is_empty() {
        md.push_str("- 点击原文链接查看完整博客详情\n");
    } else {
        paragraphs.truncate(8);
        for (i, p) in paragraphs.iter().enumerate() {
            let snippet: String = p.chars().take(120).collect();
            md.push_str(&format!("### 要点 {}\n- {}\n", i + 1, snippet));
        }
    }

    md
}

// -----------------------------------------------------------------------------
// OPML Import & Export
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpmlOutlineItem {
    pub title: String,
    pub xml_url: String,
    pub html_url: Option<String>,
    pub category: String,
}

pub fn parse_opml(opml_xml: &str) -> Result<Vec<OpmlOutlineItem>, String> {
    let doc = roxmltree::Document::parse(opml_xml)
        .map_err(|e| format!("解析 OPML 文件失败：{e}"))?;

    let mut items = Vec::new();
    let body = doc
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name().eq_ignore_ascii_case("body"))
        .ok_or_else(|| "OPML 缺少 <body> 节点".to_string())?;

    for node in body.children().filter(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case("outline")) {
        extract_opml_node(node, "默认分类", &mut items);
    }

    Ok(items)
}

fn extract_opml_node(node: Node, parent_category: &str, items: &mut Vec<OpmlOutlineItem>) {
    let xml_url = node
        .attribute("xmlUrl")
        .or_else(|| node.attribute("xmlurl"))
        .map(str::trim);

    let current_title = node
        .attribute("text")
        .or_else(|| node.attribute("title"))
        .unwrap_or("未命名订阅")
        .trim();

    if let Some(url) = xml_url {
        if !url.is_empty() {
            items.push(OpmlOutlineItem {
                title: current_title.to_string(),
                xml_url: url.to_string(),
                html_url: node.attribute("htmlUrl").map(|s| s.trim().to_string()),
                category: parent_category.to_string(),
            });
            return;
        }
    }

    // If it's a category folder outline
    let new_category = if !current_title.is_empty() {
        current_title
    } else {
        parent_category
    };

    for child in node.children().filter(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case("outline")) {
        extract_opml_node(child, new_category, items);
    }
}

pub fn generate_opml(channels: &[store::FeedChannel]) -> String {
    let mut xml = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<opml version=\"2.0\">\n<head>\n  <title>Markmap 博客与 RSS 订阅源导出</title>\n</head>\n<body>\n",
    );

    let mut map: HashMap<&str, Vec<&store::FeedChannel>> = HashMap::new();
    for ch in channels {
        map.entry(ch.category.as_str()).or_default().push(ch);
    }

    for (cat, chs) in map {
        xml.push_str(&format!("  <outline text=\"{}\" title=\"{}\">\n", escape_xml(cat), escape_xml(cat)));
        for ch in chs {
            let html_attr = ch
                .site_url
                .as_deref()
                .map(|u| format!(" htmlUrl=\"{}\"", escape_xml(u)))
                .unwrap_or_default();
            xml.push_str(&format!(
                "    <outline type=\"rss\" text=\"{}\" title=\"{}\" xmlUrl=\"{}\"{} />\n",
                escape_xml(&ch.title),
                escape_xml(&ch.title),
                escape_xml(&ch.url),
                html_attr
            ));
        }
        xml.push_str("  </outline>\n");
    }

    xml.push_str("</body>\n</opml>\n");
    xml
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

// -----------------------------------------------------------------------------
// Tauri Commands
// -----------------------------------------------------------------------------

#[tauri::command]
pub async fn feed_get_overview(app: AppHandle) -> Result<store::FeedOverview, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db(&app)?;
        store::get_feed_overview(&conn)
    })
    .await
    .map_err(|e| format!("执行获取概览任务失败：{e}"))?
}

#[tauri::command]
pub async fn feed_list_channels(app: AppHandle) -> Result<Vec<store::FeedChannel>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db(&app)?;
        store::list_channels(&conn)
    })
    .await
    .map_err(|e| format!("执行查询订阅源任务失败：{e}"))?
}

#[tauri::command]
pub async fn feed_add_channel(
    app: AppHandle,
    url: String,
    category: Option<String>,
    custom_title: Option<String>,
) -> Result<store::FeedChannel, String> {
    let clean_url = url.trim().to_string();
    if clean_url.is_empty() {
        return Err("订阅源地址不能为空".to_string());
    }

    let client = build_client()?;
    let resp = client
        .get(&clean_url)
        .send()
        .await
        .map_err(|e| format!("请求订阅源失败：{e}"))?;

    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取订阅源响应失败：{e}"))?;

    let parsed = parse_feed_content(&text, &clean_url)?;

    let title = custom_title
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(parsed.title);

    let input = store::ChannelInput {
        id: None,
        url: clean_url,
        title,
        description: parsed.description,
        site_url: parsed.site_url,
        category,
    };

    let app_clone = app.clone();
    let (channel, articles) = tokio::task::spawn_blocking(move || -> Result<(store::FeedChannel, Vec<store::ArticleInput>), String> {
        let conn = open_db(&app_clone)?;
        let now = now_secs();
        let ch = store::upsert_channel(&conn, &input, now)?;
        store::upsert_articles(&conn, &ch.id, &parsed.articles, now)?;
        store::update_channel_sync_status(&conn, &ch.id, "idle", None, now)?;
        Ok((ch, parsed.articles))
    })
    .await
    .map_err(|e| format!("保存订阅源任务失败：{e}"))??;

    println!("添加订阅源成功：{} (共导入 {} 篇文章)", channel.title, articles.len());
    Ok(channel)
}

#[tauri::command]
pub async fn feed_update_channel(
    app: AppHandle,
    id: String,
    title: String,
    category: Option<String>,
) -> Result<store::FeedChannel, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db(&app)?;
        let now = now_secs();
        let input = store::ChannelInput {
            id: Some(id),
            url: String::new(),
            title,
            description: None,
            site_url: None,
            category,
        };
        store::upsert_channel(&conn, &input, now)
    })
    .await
    .map_err(|e| format!("更新订阅源任务失败：{e}"))?
}

#[tauri::command]
pub async fn feed_delete_channel(app: AppHandle, id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db(&app)?;
        store::delete_channel(&conn, &id)
    })
    .await
    .map_err(|e| format!("删除订阅源任务失败：{e}"))?
}

#[tauri::command]
pub async fn feed_refresh_channel(app: AppHandle, id: String) -> Result<usize, String> {
    let app_clone = app.clone();
    let ch_opt = tokio::task::spawn_blocking(move || -> Result<Option<store::FeedChannel>, String> {
        let conn = open_db(&app_clone)?;
        store::get_channel(&conn, &id)
    })
    .await
    .map_err(|e| format!("获取订阅源失败：{e}"))??;

    let ch = ch_opt.ok_or_else(|| "订阅源不存在".to_string())?;

    let client = build_client()?;
    let resp = match client.get(&ch.url).send().await {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("网络请求失败：{e}");
            let app_clone = app.clone();
            let ch_id = ch.id.clone();
            let msg_clone = msg.clone();
            tokio::task::spawn_blocking(move || {
                if let Ok(conn) = open_db(&app_clone) {
                    let _ = store::update_channel_sync_status(&conn, &ch_id, "error", Some(&msg_clone), now_secs());
                }
            }).await.ok();
            return Err(msg);
        }
    };

    let text = match resp.text().await {
        Ok(t) => t,
        Err(e) => {
            let msg = format!("读取响应失败：{e}");
            let app_clone = app.clone();
            let ch_id = ch.id.clone();
            let msg_clone = msg.clone();
            tokio::task::spawn_blocking(move || {
                if let Ok(conn) = open_db(&app_clone) {
                    let _ = store::update_channel_sync_status(&conn, &ch_id, "error", Some(&msg_clone), now_secs());
                }
            }).await.ok();
            return Err(msg);
        }
    };

    let parsed = match parse_feed_content(&text, &ch.url) {
        Ok(p) => p,
        Err(e) => {
            let app_clone = app.clone();
            let ch_id = ch.id.clone();
            let e_clone = e.clone();
            tokio::task::spawn_blocking(move || {
                if let Ok(conn) = open_db(&app_clone) {
                    let _ = store::update_channel_sync_status(&conn, &ch_id, "error", Some(&e_clone), now_secs());
                }
            }).await.ok();
            return Err(e);
        }
    };

    let app_clone = app.clone();
    let ch_id = ch.id.clone();
    let new_count = tokio::task::spawn_blocking(move || -> Result<usize, String> {
        let conn = open_db(&app_clone)?;
        let now = now_secs();
        let count = store::upsert_articles(&conn, &ch_id, &parsed.articles, now)?;
        store::update_channel_metadata(
            &conn,
            &ch_id,
            Some(&parsed.title),
            parsed.description.as_deref(),
            parsed.site_url.as_deref(),
            now,
        )?;
        store::update_channel_sync_status(&conn, &ch_id, "idle", None, now)?;
        Ok(count)
    })
    .await
    .map_err(|e| format!("更新文章数据任务失败：{e}"))??;

    Ok(new_count)
}

#[tauri::command]
pub async fn feed_refresh_all_channels(app: AppHandle) -> Result<usize, String> {
    let channels = feed_list_channels(app.clone()).await?;
    let semaphore = Arc::new(Semaphore::new(5));
    let mut tasks = Vec::new();

    for ch in channels {
        let sem = semaphore.clone();
        let app_handle = app.clone();
        let ch_id = ch.id.clone();
        tasks.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.ok();
            feed_refresh_channel(app_handle, ch_id).await
        }));
    }

    let mut total_new = 0;
    for t in tasks {
        if let Ok(Ok(count)) = t.await {
            total_new += count;
        }
    }

    Ok(total_new)
}

#[tauri::command]
pub async fn feed_list_articles(
    app: AppHandle,
    filter: store::ArticleFilter,
) -> Result<Vec<store::FeedArticle>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db(&app)?;
        store::list_articles(&conn, &filter)
    })
    .await
    .map_err(|e| format!("获取文章列表任务失败：{e}"))?
}

#[tauri::command]
pub async fn feed_get_article(app: AppHandle, id: String) -> Result<Option<store::FeedArticle>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db(&app)?;
        store::get_article(&conn, &id)
    })
    .await
    .map_err(|e| format!("获取文章详情任务失败：{e}"))?
}

#[tauri::command]
pub async fn feed_set_article_read(
    app: AppHandle,
    id: String,
    read_status: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db(&app)?;
        store::set_article_read_status(&conn, &id, &read_status)
    })
    .await
    .map_err(|e| format!("设置文章已读状态失败：{e}"))?
}

#[tauri::command]
pub async fn feed_set_article_starred(
    app: AppHandle,
    id: String,
    starred: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db(&app)?;
        store::set_article_starred(&conn, &id, starred)
    })
    .await
    .map_err(|e| format!("设置文章收藏状态失败：{e}"))?
}

#[tauri::command]
pub async fn feed_mark_all_read(
    app: AppHandle,
    channel_id: Option<String>,
    category: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db(&app)?;
        store::mark_all_read(&conn, channel_id.as_deref(), category.as_deref())
    })
    .await
    .map_err(|e| format!("批量标记已读失败：{e}"))?
}

#[tauri::command]
pub async fn feed_article_to_mindmap(app: AppHandle, id: String) -> Result<String, String> {
    let article_opt = feed_get_article(app, id).await?;
    let article = article_opt.ok_or_else(|| "文章不存在".to_string())?;
    Ok(convert_article_to_mindmap(&article))
}

#[tauri::command]
pub async fn feed_import_opml(app: AppHandle, opml_xml: String) -> Result<usize, String> {
    let items = parse_opml(&opml_xml)?;
    if items.is_empty() {
        return Ok(0);
    }

    let mut imported = 0;
    for item in items {
        let input = store::ChannelInput {
            id: None,
            url: item.xml_url,
            title: item.title,
            description: None,
            site_url: item.html_url,
            category: Some(item.category),
        };
        let app_clone = app.clone();
        let res = tokio::task::spawn_blocking(move || {
            let conn = open_db(&app_clone)?;
            store::upsert_channel(&conn, &input, now_secs())
        })
        .await;

        if let Ok(Ok(_)) = res {
            imported += 1;
        }
    }

    Ok(imported)
}

#[tauri::command]
pub async fn feed_export_opml(app: AppHandle) -> Result<String, String> {
    let channels = feed_list_channels(app).await?;
    Ok(generate_opml(&channels))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rss_xml_parsing() {
        let sample_rss = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Rust 官方技术博客</title>
    <link>https://blog.rust-lang.org</link>
    <description>Empowering everyone to build reliable and efficient software.</description>
    <item>
      <title>Announcing Rust 1.80.0</title>
      <link>https://blog.rust-lang.org/2024/07/25/Rust-1.80.0.html</link>
      <guid>https://blog.rust-lang.org/2024/07/25/Rust-1.80.0.html</guid>
      <pubDate>Thu, 25 Jul 2024 00:00:00 +0000</pubDate>
      <description>&lt;p&gt;The Rust team is happy to announce a new version of Rust, 1.80.0.&lt;/p&gt;</description>
    </item>
  </channel>
</rss>"#;

        let parsed = parse_feed_content(sample_rss, "https://blog.rust-lang.org/feed.xml").unwrap();
        assert_eq!(parsed.title, "Rust 官方技术博客");
        assert_eq!(parsed.articles.len(), 1);
        assert_eq!(parsed.articles[0].title, "Announcing Rust 1.80.0");
        assert!(parsed.articles[0].summary.contains("Rust team"));
    }

    #[test]
    fn test_atom_xml_parsing() {
        let sample_atom = r#"<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>阮一峰的网络日志</title>
  <link href="http://www.ruanyifeng.com/blog/" rel="alternate"/>
  <subtitle>科技爱好者周刊</subtitle>
  <entry>
    <title>科技爱好者周刊（第 300 期）</title>
    <link href="http://www.ruanyifeng.com/blog/2024/05/weekly-issue-300.html"/>
    <id>tag:ruanyifeng.com,2024:/blog/weekly-issue-300</id>
    <published>2024-05-17T09:00:00Z</published>
    <summary>这里记录每周值得分享的科技内容。</summary>
    <content type="html">&lt;p&gt;本周的主题是AI智能体发展。&lt;/p&gt;</content>
  </entry>
</feed>"#;

        let parsed = parse_feed_content(sample_atom, "http://www.ruanyifeng.com/blog/atom.xml").unwrap();
        assert_eq!(parsed.title, "阮一峰的网络日志");
        assert_eq!(parsed.articles.len(), 1);
        assert_eq!(parsed.articles[0].title, "科技爱好者周刊（第 300 期）");
    }

    #[test]
    fn test_mindmap_conversion() {
        let art = store::FeedArticle {
            id: "1".to_string(),
            channel_id: "c1".to_string(),
            channel_title: "Rust 官方博客".to_string(),
            guid: "g1".to_string(),
            title: "Rust 性能优化指北".to_string(),
            author: Some("The Rust Team".to_string()),
            url: "https://example.com/perf".to_string(),
            content: "<p>第一段关于编译器优化，第二段关于内存对齐与缓存友好性。</p>".to_string(),
            summary: "系统性介绍 Rust 性能调优要点。".to_string(),
            published_at: 1716000000,
            read_status: "unread".to_string(),
            starred: true,
            reading_time_min: 3,
            created_at: 1716000000,
        };

        let md = convert_article_to_mindmap(&art);
        assert!(md.contains("# Rust 性能优化指北"));
        assert!(md.contains("## 来源信息"));
        assert!(md.contains("## 核心摘要"));
    }

    #[test]
    fn test_opml_import_export() {
        let sample_opml = r#"<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Feeds</title></head>
  <body>
    <outline text="技术开发" title="技术开发">
      <outline type="rss" text="Rust Blog" title="Rust Blog" xmlUrl="https://blog.rust-lang.org/feed.xml" htmlUrl="https://blog.rust-lang.org"/>
    </outline>
  </body>
</opml>"#;

        let items = parse_opml(sample_opml).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Rust Blog");
        assert_eq!(items[0].category, "技术开发");
        assert_eq!(items[0].xml_url, "https://blog.rust-lang.org/feed.xml");
    }
}

