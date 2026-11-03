use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS feed_channels (
    id TEXT PRIMARY KEY NOT NULL,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    site_url TEXT,
    category TEXT NOT NULL DEFAULT '默认分类',
    icon TEXT,
    sync_status TEXT NOT NULL DEFAULT 'idle',
    error_message TEXT,
    last_sync_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feed_channels_url ON feed_channels(url);
CREATE INDEX IF NOT EXISTS idx_feed_channels_category ON feed_channels(category);

CREATE TABLE IF NOT EXISTS feed_articles (
    id TEXT PRIMARY KEY NOT NULL,
    channel_id TEXT NOT NULL,
    guid TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT,
    url TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    published_at INTEGER NOT NULL DEFAULT 0,
    read_status TEXT NOT NULL DEFAULT 'unread',
    starred INTEGER NOT NULL DEFAULT 0,
    reading_time_min INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(channel_id) REFERENCES feed_channels(id) ON DELETE CASCADE,
    UNIQUE(channel_id, guid)
);

CREATE INDEX IF NOT EXISTS idx_feed_articles_channel_id ON feed_articles(channel_id);
CREATE INDEX IF NOT EXISTS idx_feed_articles_published_at ON feed_articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_articles_read_status ON feed_articles(read_status);
CREATE INDEX IF NOT EXISTS idx_feed_articles_starred ON feed_articles(starred);
";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedChannel {
    pub id: String,
    pub url: String,
    pub title: String,
    pub description: Option<String>,
    pub site_url: Option<String>,
    pub category: String,
    pub icon: Option<String>,
    pub sync_status: String, // "idle", "syncing", "error"
    pub error_message: Option<String>,
    pub last_sync_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedChannelWithStats {
    #[serde(flatten)]
    pub channel: FeedChannel,
    pub unread_count: usize,
    pub total_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelInput {
    pub id: Option<String>,
    pub url: String,
    pub title: String,
    pub description: Option<String>,
    pub site_url: Option<String>,
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedArticle {
    pub id: String,
    pub channel_id: String,
    pub channel_title: String,
    pub guid: String,
    pub title: String,
    pub author: Option<String>,
    pub url: String,
    pub content: String,
    pub summary: String,
    pub published_at: i64,
    pub read_status: String, // "unread", "read"
    pub starred: bool,
    pub reading_time_min: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleInput {
    pub guid: String,
    pub title: String,
    pub author: Option<String>,
    pub url: String,
    pub content: String,
    pub summary: String,
    pub published_at: i64,
    pub reading_time_min: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArticleFilter {
    pub channel_id: Option<String>,
    pub category: Option<String>,
    pub read_status: Option<String>, // "all", "unread", "read"
    pub starred: Option<bool>,
    pub search: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryStats {
    pub name: String,
    pub unread_count: usize,
    pub channel_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedOverview {
    pub total_unread: usize,
    pub total_articles: usize,
    pub total_starred: usize,
    pub channels: Vec<FeedChannelWithStats>,
    pub categories: Vec<CategoryStats>,
}

pub fn open(path: &std::path::Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("无法打开订阅数据库：{e}"))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("启用订阅数据库关联约束失败：{e}"))?;
    conn.execute_batch(SCHEMA)
        .map_err(|e| format!("初始化订阅数据库结构失败：{e}"))?;
    Ok(conn)
}

pub fn upsert_channel(
    conn: &Connection,
    input: &ChannelInput,
    now: i64,
) -> Result<FeedChannel, String> {
    let category = input
        .category
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("默认分类");

    if let Some(existing_id) = &input.id {
        conn.execute(
            "UPDATE feed_channels SET
                title = ?1,
                description = ?2,
                site_url = ?3,
                category = ?4,
                updated_at = ?5
            WHERE id = ?6",
            params![
                input.title.trim(),
                input.description.as_deref(),
                input.site_url.as_deref(),
                category,
                now,
                existing_id
            ],
        )
        .map_err(|e| format!("更新订阅源失败：{e}"))?;

        get_channel(conn, existing_id)?.ok_or_else(|| "订阅源不存在".to_string())
    } else {
        let existing: Option<FeedChannel> = conn
            .query_row(
                "SELECT id, url, title, description, site_url, category, icon, sync_status, error_message, last_sync_at, created_at, updated_at
                 FROM feed_channels WHERE url = ?1",
                params![input.url.trim()],
                map_row_to_channel,
            )
            .optional()
            .map_err(|e| format!("查询订阅源失败：{e}"))?;

        if let Some(mut ch) = existing {
            ch.title = input.title.trim().to_string();
            ch.category = category.to_string();
            ch.updated_at = now;
            conn.execute(
                "UPDATE feed_channels SET title = ?1, category = ?2, updated_at = ?3 WHERE id = ?4",
                params![ch.title, ch.category, now, ch.id],
            )
            .map_err(|e| format!("更新已有订阅源失败：{e}"))?;
            Ok(ch)
        } else {
            let id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO feed_channels (
                    id, url, title, description, site_url, category, icon,
                    sync_status, error_message, last_sync_at, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 'idle', NULL, 0, ?7, ?7)",
                params![
                    id,
                    input.url.trim(),
                    input.title.trim(),
                    input.description.as_deref(),
                    input.site_url.as_deref(),
                    category,
                    now
                ],
            )
            .map_err(|e| format!("添加订阅源失败：{e}"))?;

            get_channel(conn, &id)?.ok_or_else(|| "添加订阅源后未找到记录".to_string())
        }
    }
}

pub fn get_channel(conn: &Connection, id: &str) -> Result<Option<FeedChannel>, String> {
    conn.query_row(
        "SELECT id, url, title, description, site_url, category, icon, sync_status, error_message, last_sync_at, created_at, updated_at
         FROM feed_channels WHERE id = ?1",
        params![id],
        map_row_to_channel,
    )
    .optional()
    .map_err(|e| format!("获取订阅源失败：{e}"))
}

pub fn delete_channel(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM feed_channels WHERE id = ?1", params![id])
        .map_err(|e| format!("删除订阅源失败：{e}"))?;
    Ok(())
}

pub fn update_channel_sync_status(
    conn: &Connection,
    id: &str,
    status: &str,
    error: Option<&str>,
    last_sync_at: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE feed_channels SET sync_status = ?1, error_message = ?2, last_sync_at = ?3, updated_at = ?3 WHERE id = ?4",
        params![status, error, last_sync_at, id],
    )
    .map_err(|e| format!("更新同步状态失败：{e}"))?;
    Ok(())
}

pub fn update_channel_metadata(
    conn: &Connection,
    id: &str,
    title: Option<&str>,
    description: Option<&str>,
    site_url: Option<&str>,
    now: i64,
) -> Result<(), String> {
    if let Some(t) = title {
        conn.execute(
            "UPDATE feed_channels SET title = ?1, updated_at = ?2 WHERE id = ?3 AND (title = '' OR title = url)",
            params![t, now, id],
        )
        .ok();
    }
    if let Some(desc) = description {
        conn.execute(
            "UPDATE feed_channels SET description = ?1, updated_at = ?2 WHERE id = ?3 AND description IS NULL",
            params![desc, now, id],
        )
        .ok();
    }
    if let Some(site) = site_url {
        conn.execute(
            "UPDATE feed_channels SET site_url = ?1, updated_at = ?2 WHERE id = ?3 AND site_url IS NULL",
            params![site, now, id],
        )
        .ok();
    }
    Ok(())
}

pub fn list_channels(conn: &Connection) -> Result<Vec<FeedChannel>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, url, title, description, site_url, category, icon, sync_status, error_message, last_sync_at, created_at, updated_at
             FROM feed_channels ORDER BY category ASC, title COLLATE NOCASE ASC",
        )
        .map_err(|e| format!("查询订阅列表失败：{e}"))?;

    let iter = stmt
        .query_map([], map_row_to_channel)
        .map_err(|e| format!("遍历订阅列表失败：{e}"))?;

    let mut channels = Vec::new();
    for item in iter {
        channels.push(item.map_err(|e| format!("解析订阅源数据失败：{e}"))?);
    }
    Ok(channels)
}

pub fn upsert_articles(
    conn: &Connection,
    channel_id: &str,
    articles: &[ArticleInput],
    now: i64,
) -> Result<usize, String> {
    let mut inserted_count = 0;
    for a in articles {
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM feed_articles WHERE channel_id = ?1 AND guid = ?2",
                params![channel_id, a.guid],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("检测文章是否存在失败：{e}"))?;

        if let Some(existing_id) = existing {
            // Update article content/summary/published_at without overwriting read_status or starred
            conn.execute(
                "UPDATE feed_articles SET
                    title = ?1,
                    author = ?2,
                    url = ?3,
                    content = CASE WHEN ?4 != '' THEN ?4 ELSE content END,
                    summary = CASE WHEN ?5 != '' THEN ?5 ELSE summary END,
                    published_at = CASE WHEN ?6 > 0 THEN ?6 ELSE published_at END,
                    reading_time_min = ?7
                WHERE id = ?8",
                params![
                    a.title,
                    a.author.as_deref(),
                    a.url,
                    a.content,
                    a.summary,
                    a.published_at,
                    a.reading_time_min,
                    existing_id
                ],
            )
            .map_err(|e| format!("更新文章内容失败：{e}"))?;
        } else {
            let id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO feed_articles (
                    id, channel_id, guid, title, author, url, content, summary,
                    published_at, read_status, starred, reading_time_min, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'unread', 0, ?10, ?11)",
                params![
                    id,
                    channel_id,
                    a.guid,
                    a.title,
                    a.author.as_deref(),
                    a.url,
                    a.content,
                    a.summary,
                    a.published_at,
                    a.reading_time_min,
                    now
                ],
            )
            .map_err(|e| format!("插入文章失败：{e}"))?;
            inserted_count += 1;
        }
    }
    Ok(inserted_count)
}

pub fn list_articles(
    conn: &Connection,
    filter: &ArticleFilter,
) -> Result<Vec<FeedArticle>, String> {
    let mut sql = String::from(
        "SELECT a.id, a.channel_id, c.title as channel_title, a.guid, a.title, a.author, a.url,
                a.content, a.summary, a.published_at, a.read_status, a.starred, a.reading_time_min, a.created_at
         FROM feed_articles a
         JOIN feed_channels c ON a.channel_id = c.id
         WHERE 1=1",
    );

    let mut param_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(ch_id) = &filter.channel_id {
        if !ch_id.is_empty() {
            sql.push_str(" AND a.channel_id = ?");
            param_values.push(Box::new(ch_id.clone()));
        }
    }

    if let Some(category) = &filter.category {
        if !category.is_empty() {
            sql.push_str(" AND c.category = ?");
            param_values.push(Box::new(category.clone()));
        }
    }

    if let Some(status) = &filter.read_status {
        if status == "unread" {
            sql.push_str(" AND a.read_status = 'unread'");
        } else if status == "read" {
            sql.push_str(" AND a.read_status = 'read'");
        }
    }

    if let Some(is_starred) = filter.starred {
        sql.push_str(" AND a.starred = ?");
        param_values.push(Box::new(if is_starred { 1 } else { 0 }));
    }

    if let Some(search) = &filter.search {
        let q = search.trim();
        if !q.is_empty() {
            sql.push_str(" AND (a.title LIKE ? OR a.summary LIKE ? OR a.content LIKE ?)");
            let pattern = format!("%{q}%");
            param_values.push(Box::new(pattern.clone()));
            param_values.push(Box::new(pattern.clone()));
            param_values.push(Box::new(pattern));
        }
    }

    sql.push_str(" ORDER BY a.published_at DESC, a.created_at DESC");

    let limit = filter.limit.unwrap_or(80);
    sql.push_str(&format!(" LIMIT {limit}"));

    if let Some(offset) = filter.offset {
        sql.push_str(&format!(" OFFSET {offset}"));
    }

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("准备文章查询失败：{e}"))?;

    let params_slice: Vec<&dyn rusqlite::ToSql> =
        param_values.iter().map(|p| p.as_ref()).collect();

    let iter = stmt
        .query_map(params_slice.as_slice(), map_row_to_article)
        .map_err(|e| format!("执行文章查询失败：{e}"))?;

    let mut articles = Vec::new();
    for item in iter {
        articles.push(item.map_err(|e| format!("解析文章行失败：{e}"))?);
    }
    Ok(articles)
}

pub fn get_article(conn: &Connection, id: &str) -> Result<Option<FeedArticle>, String> {
    conn.query_row(
        "SELECT a.id, a.channel_id, c.title as channel_title, a.guid, a.title, a.author, a.url,
                a.content, a.summary, a.published_at, a.read_status, a.starred, a.reading_time_min, a.created_at
         FROM feed_articles a
         JOIN feed_channels c ON a.channel_id = c.id
         WHERE a.id = ?1",
        params![id],
        map_row_to_article,
    )
    .optional()
    .map_err(|e| format!("获取单篇文章失败：{e}"))
}

pub fn set_article_read_status(
    conn: &Connection,
    id: &str,
    read_status: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE feed_articles SET read_status = ?1 WHERE id = ?2",
        params![read_status, id],
    )
    .map_err(|e| format!("更新文章已读状态失败：{e}"))?;
    Ok(())
}

pub fn set_article_starred(conn: &Connection, id: &str, starred: bool) -> Result<(), String> {
    conn.execute(
        "UPDATE feed_articles SET starred = ?1 WHERE id = ?2",
        params![if starred { 1 } else { 0 }, id],
    )
    .map_err(|e| format!("更新文章收藏状态失败：{e}"))?;
    Ok(())
}

pub fn mark_all_read(
    conn: &Connection,
    channel_id: Option<&str>,
    category: Option<&str>,
) -> Result<(), String> {
    if let Some(ch_id) = channel_id {
        conn.execute(
            "UPDATE feed_articles SET read_status = 'read' WHERE channel_id = ?1",
            params![ch_id],
        )
        .map_err(|e| format!("标记订阅源全部已读失败：{e}"))?;
    } else if let Some(cat) = category {
        conn.execute(
            "UPDATE feed_articles SET read_status = 'read'
             WHERE channel_id IN (SELECT id FROM feed_channels WHERE category = ?1)",
            params![cat],
        )
        .map_err(|e| format!("标记分类全部已读失败：{e}"))?;
    } else {
        conn.execute(
            "UPDATE feed_articles SET read_status = 'read'",
            [],
        )
        .map_err(|e| format!("标记所有文章已读失败：{e}"))?;
    }
    Ok(())
}

pub fn get_feed_overview(conn: &Connection) -> Result<FeedOverview, String> {
    let total_unread: usize = conn
        .query_row(
            "SELECT count(*) FROM feed_articles WHERE read_status = 'unread'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let total_articles: usize = conn
        .query_row("SELECT count(*) FROM feed_articles", [], |r| r.get(0))
        .unwrap_or(0);

    let total_starred: usize = conn
        .query_row(
            "SELECT count(*) FROM feed_articles WHERE starred = 1",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let channels_raw = list_channels(conn)?;
    let mut channels = Vec::with_capacity(channels_raw.len());

    for ch in channels_raw {
        let unread: usize = conn
            .query_row(
                "SELECT count(*) FROM feed_articles WHERE channel_id = ?1 AND read_status = 'unread'",
                params![ch.id],
                |r| r.get(0),
            )
            .unwrap_or(0);

        let total: usize = conn
            .query_row(
                "SELECT count(*) FROM feed_articles WHERE channel_id = ?1",
                params![ch.id],
                |r| r.get(0),
            )
            .unwrap_or(0);

        channels.push(FeedChannelWithStats {
            channel: ch,
            unread_count: unread,
            total_count: total,
        });
    }

    // Categories aggregation
    let mut cat_stmt = conn
        .prepare(
            "SELECT c.category,
                    COUNT(DISTINCT c.id) as channel_cnt,
                    COUNT(CASE WHEN a.read_status = 'unread' THEN 1 END) as unread_cnt
             FROM feed_channels c
             LEFT JOIN feed_articles a ON c.id = a.channel_id
             GROUP BY c.category
             ORDER BY c.category ASC",
        )
        .map_err(|e| format!("统计分类数据失败：{e}"))?;

    let cat_iter = cat_stmt
        .query_map([], |r| {
            Ok(CategoryStats {
                name: r.get(0)?,
                channel_count: r.get(1)?,
                unread_count: r.get(2)?,
            })
        })
        .map_err(|e| format!("遍历分类数据失败：{e}"))?;

    let mut categories = Vec::new();
    for c in cat_iter {
        categories.push(c.map_err(|e| format!("解析分类行失败：{e}"))?);
    }

    Ok(FeedOverview {
        total_unread,
        total_articles,
        total_starred,
        channels,
        categories,
    })
}

fn map_row_to_channel(row: &rusqlite::Row) -> rusqlite::Result<FeedChannel> {
    Ok(FeedChannel {
        id: row.get(0)?,
        url: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        site_url: row.get(4)?,
        category: row.get(5)?,
        icon: row.get(6)?,
        sync_status: row.get(7)?,
        error_message: row.get(8)?,
        last_sync_at: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn map_row_to_article(row: &rusqlite::Row) -> rusqlite::Result<FeedArticle> {
    let starred_int: i64 = row.get(11)?;
    Ok(FeedArticle {
        id: row.get(0)?,
        channel_id: row.get(1)?,
        channel_title: row.get(2)?,
        guid: row.get(3)?,
        title: row.get(4)?,
        author: row.get(5)?,
        url: row.get(6)?,
        content: row.get(7)?,
        summary: row.get(8)?,
        published_at: row.get(9)?,
        read_status: row.get(10)?,
        starred: starred_int != 0,
        reading_time_min: row.get(12)?,
        created_at: row.get(13)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_in_memory_store_lifecycle() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(SCHEMA).unwrap();

        let ch = upsert_channel(
            &conn,
            &ChannelInput {
                id: None,
                url: "https://example.com/rss.xml".to_string(),
                title: "Example Feed".to_string(),
                description: Some("Description".to_string()),
                site_url: Some("https://example.com".to_string()),
                category: Some("Tech".to_string()),
            },
            100,
        )
        .unwrap();

        assert_eq!(ch.title, "Example Feed");
        assert_eq!(ch.category, "Tech");

        let inserted = upsert_articles(
            &conn,
            &ch.id,
            &[
                ArticleInput {
                    guid: "guid-1".to_string(),
                    title: "First Article".to_string(),
                    author: Some("Author A".to_string()),
                    url: "https://example.com/art-1".to_string(),
                    content: "<p>Content 1</p>".to_string(),
                    summary: "Summary 1".to_string(),
                    published_at: 100,
                    reading_time_min: 2,
                },
                ArticleInput {
                    guid: "guid-2".to_string(),
                    title: "Second Article".to_string(),
                    author: None,
                    url: "https://example.com/art-2".to_string(),
                    content: "<p>Content 2</p>".to_string(),
                    summary: "Summary 2".to_string(),
                    published_at: 105,
                    reading_time_min: 3,
                },
            ],
            110,
        )
        .unwrap();

        assert_eq!(inserted, 2);

        let overview = get_feed_overview(&conn).unwrap();
        assert_eq!(overview.total_articles, 2);
        assert_eq!(overview.total_unread, 2);
        assert_eq!(overview.categories.len(), 1);
        assert_eq!(overview.categories[0].name, "Tech");

        let list = list_articles(&conn, &ArticleFilter::default()).unwrap();
        assert_eq!(list.len(), 2);
        set_article_read_status(&conn, &list[0].id, "read").unwrap();

        let overview2 = get_feed_overview(&conn).unwrap();
        assert_eq!(overview2.total_unread, 1);

        mark_all_read(&conn, None, None).unwrap();
        let overview3 = get_feed_overview(&conn).unwrap();
        assert_eq!(overview3.total_unread, 0);
    }
}

