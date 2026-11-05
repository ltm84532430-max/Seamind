use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
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

CREATE TABLE IF NOT EXISTS feed_categories (
    name TEXT PRIMARY KEY COLLATE NOCASE NOT NULL,
    color TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_seed_state (
    key TEXT PRIMARY KEY NOT NULL,
    applied_at INTEGER NOT NULL
);

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
    audio_url TEXT,
    audio_type TEXT,
    audio_duration INTEGER,
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
    pub audio_url: Option<String>,
    pub audio_type: Option<String>,
    pub audio_duration: Option<i64>,
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
    pub audio_url: Option<String>,
    pub audio_type: Option<String>,
    pub audio_duration: Option<i64>,
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
    pub has_audio: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryStats {
    pub name: String,
    pub color: String,
    pub unread_count: usize,
    pub channel_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedOverview {
    pub total_unread: usize,
    pub total_articles: usize,
    pub total_starred: usize,
    pub total_audios: usize,
    pub channels: Vec<FeedChannelWithStats>,
    pub categories: Vec<CategoryStats>,
}

pub fn open(path: &std::path::Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("无法打开订阅数据库：{e}"))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("启用订阅数据库关联约束失败：{e}"))?;
    conn.execute_batch(SCHEMA)
        .map_err(|e| format!("初始化订阅数据库结构失败：{e}"))?;

    // 增量热迁移：为已有数据库扩展音频支持字段
    let _ = conn.execute("ALTER TABLE feed_articles ADD COLUMN audio_url TEXT;", []);
    let _ = conn.execute("ALTER TABLE feed_articles ADD COLUMN audio_type TEXT;", []);
    let _ = conn.execute("ALTER TABLE feed_articles ADD COLUMN audio_duration INTEGER;", []);
    // 旧库先补齐音频列，再创建依赖新列的索引，避免启动时整库打不开。
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_feed_articles_audio ON feed_articles(audio_url) WHERE audio_url IS NOT NULL;",
        [],
    );

    conn.execute(
        "UPDATE feed_channels SET category = CASE
            WHEN trim(category) = '' THEN '默认分类'
            ELSE trim(category)
         END",
        [],
    )
    .map_err(|e| format!("规范化订阅分类失败：{e}"))?;
    backfill_categories(&conn)?;
    repair_category_color_collisions(&conn)?;
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_categories_color
         ON feed_categories(color);",
    )
    .map_err(|e| format!("建立订阅分类颜色唯一约束失败：{e}"))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let channel_count: usize = conn
        .query_row("SELECT count(*) FROM feed_channels", [], |r| r.get(0))
        .unwrap_or(0);
    if channel_count == 0 {
        let _ = seed_default_sources(&conn, now, true);
    }

    Ok(conn)
}

const CATEGORY_COLORS: &[&str] = &[
    "#d6a354", "#6ba8d6", "#70b89a", "#be8ac8", "#d57966", "#8e9fca", "#b4a55f",
    "#5faeb0", "#d58faa", "#8cae72",
];

fn category_hash(name: &str) -> u32 {
    name.as_bytes()
        .iter()
        .fold(2_166_136_261_u32, |hash, byte| {
            (hash ^ u32::from(*byte)).wrapping_mul(16_777_619)
        })
}

fn category_color_candidate(name: &str, used_colors: &HashSet<String>) -> String {
    let hash = category_hash(name);
    let preferred = match name {
        "金融与量化" => Some("#d6a354"),
        "政府与公共机构" => Some("#6ba8d6"),
        "军事与防务安全" => Some("#d57966"),
        "技术博客" => Some("#70b89a"),
        "默认分类" => Some("#8993a4"),
        _ => None,
    };
    if let Some(color) = preferred {
        if !used_colors.contains(color) {
            return color.to_string();
        }
    }

    for offset in 0..CATEGORY_COLORS.len() {
        let index = (hash as usize + offset) % CATEGORY_COLORS.len();
        let color = CATEGORY_COLORS[index];
        if !used_colors.contains(color) {
            return color.to_string();
        }
    }

    // Once the curated palette is exhausted, spread custom categories around
    // the hue wheel. The unique index below enforces this invariant in SQLite.
    for attempt in 0..30_000_u64 {
        let hue_milli = (u64::from(hash) * 1_000 + attempt * 137_508) % 360_000;
        let color = format!(
            "hsl({}.{:03} 52% 58%)",
            hue_milli / 1_000,
            hue_milli % 1_000
        );
        if !used_colors.contains(&color.to_ascii_lowercase()) {
            return color;
        }
    }

    // This path is only reachable after tens of thousands of categories.
    // It remains deterministic and checks the same persisted color set.
    for offset in 0..=u32::MAX {
        let color = format!("#{:06x}", hash.wrapping_add(offset) & 0x00ff_ffff);
        if !used_colors.contains(&color) {
            return color;
        }
    }
    unreachable!("no category colors remain")
}

fn category_colors(conn: &Connection) -> Result<HashSet<String>, String> {
    let mut stmt = conn
        .prepare("SELECT color FROM feed_categories")
        .map_err(|e| format!("读取现有订阅分类颜色失败：{e}"))?;
    let colors = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("遍历现有订阅分类颜色失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("解析现有订阅分类颜色失败：{e}"))?;
    Ok(colors
        .into_iter()
        .map(|color| color.trim().to_ascii_lowercase())
        .collect())
}

fn repair_category_color_collisions(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT name, color FROM feed_categories ORDER BY sort_order, created_at, name")
        .map_err(|e| format!("读取订阅分类颜色失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("遍历订阅分类颜色失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("解析订阅分类颜色失败：{e}"))?;
    drop(stmt);

    let mut used_colors = HashSet::new();
    for (name, color) in rows {
        let normalized = color.trim().to_ascii_lowercase();
        if used_colors.insert(normalized) {
            continue;
        }

        let replacement = category_color_candidate(&name, &used_colors);
        conn.execute(
            "UPDATE feed_categories SET color = ?1 WHERE name = ?2",
            params![replacement, name],
        )
        .map_err(|e| format!("修复重复的订阅分类颜色失败：{e}"))?;
        used_colors.insert(replacement.to_ascii_lowercase());
    }
    Ok(())
}

fn ensure_category(conn: &Connection, name: &str, now: i64) -> Result<(), String> {
    let clean = name.trim();
    if clean.is_empty() {
        return Err("分类名称不能为空".to_string());
    }
    let already_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM feed_categories WHERE name = ?1)",
            params![clean],
            |row| row.get(0),
        )
        .map_err(|e| format!("检查订阅分类是否存在失败：{e}"))?;
    if already_exists {
        return Ok(());
    }
    let used_colors = category_colors(conn)?;
    let color = category_color_candidate(clean, &used_colors);
    conn.execute(
        "INSERT INTO feed_categories (name, color, sort_order, created_at)
         VALUES (?1, ?2, COALESCE((SELECT MAX(sort_order) + 1 FROM feed_categories), 0), ?3)
         ON CONFLICT(name) DO NOTHING",
        params![clean, color, now],
    )
    .map_err(|e| format!("保存订阅分类失败：{e}"))?;
    Ok(())
}

fn backfill_categories(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT DISTINCT category FROM feed_channels ORDER BY category ASC")
        .map_err(|e| format!("读取已有订阅分类失败：{e}"))?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("遍历已有订阅分类失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("解析已有订阅分类失败：{e}"))?;
    drop(stmt);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    ensure_category(conn, "默认分类", now)?;
    for name in names {
        ensure_category(conn, &name, now)?;
    }
    Ok(())
}

pub fn create_category(conn: &Connection, name: &str, now: i64) -> Result<(), String> {
    let clean = name.trim();
    if clean.chars().count() > 40 {
        return Err("分类名称不能超过 40 个字符".to_string());
    }
    if clean.chars().any(char::is_control) {
        return Err("分类名称不能包含控制字符".to_string());
    }
    ensure_category(conn, clean, now)
}

const STARTER_FEEDS: &[(&str, &str, &str, &str)] = &[
    // Finance and quantitative research.
    ("金融与量化", "Federal Reserve · Press Releases", "https://www.federalreserve.gov/feeds/press_all.xml", "https://www.federalreserve.gov/"),
    ("金融与量化", "Federal Reserve · Speeches & Testimony", "https://www.federalreserve.gov/feeds/speeches_and_testimony.xml", "https://www.federalreserve.gov/"),
    ("金融与量化", "Federal Reserve · Working Papers", "https://www.federalreserve.gov/feeds/working_papers.xml", "https://www.federalreserve.gov/"),
    ("金融与量化", "Federal Reserve · Finance & Economics Discussion Series", "https://www.federalreserve.gov/feeds/feds.xml", "https://www.federalreserve.gov/"),
    ("金融与量化", "Federal Reserve · FEDS Notes", "https://www.federalreserve.gov/feeds/feds_notes.xml", "https://www.federalreserve.gov/"),
    ("金融与量化", "Federal Reserve · Selected Interest Rates (H.15)", "https://www.federalreserve.gov/feeds/h15.xml", "https://www.federalreserve.gov/"),
    ("金融与量化", "TreasuryDirect · Offering Announcements", "https://www.treasurydirect.gov/TA_WS/securities/announced/rss", "https://www.treasurydirect.gov/"),
    ("金融与量化", "TreasuryDirect · Auction Results", "https://www.treasurydirect.gov/TA_WS/securities/auctioned/rss", "https://www.treasurydirect.gov/"),
    ("金融与量化", "TreasuryDirect · Debt to the Penny", "https://www.treasurydirect.gov/NP_WS/debt/feeds/recent", "https://www.treasurydirect.gov/"),
    ("金融与量化", "Financial Stability Board · Press Releases", "https://www.fsb.org/wordpress/content_type/press-releases/feed/", "https://www.fsb.org/"),
    ("金融与量化", "New York Fed · Liberty Street Economics", "https://libertystreeteconomics.newyorkfed.org/feed/", "https://libertystreeteconomics.newyorkfed.org/"),
    ("金融与量化", "Quantpedia · Quantitative Trading Research", "https://quantpedia.com/feed/", "https://quantpedia.com/"),
    ("金融与量化", "Alpha Architect · Quantitative Investing Research", "https://alphaarchitect.com/feed/", "https://alphaarchitect.com/"),
    ("金融与量化", "European Central Bank · The ECB Podcast", "https://www.ecb.europa.eu/rss/podcast.html", "https://www.ecb.europa.eu/press/podcasts/"),
    ("金融与量化", "International Monetary Fund · IMF Podcasts", "https://feeds.simplecast.com/7xXq1w_K", "https://www.imf.org/en/News/Podcasts"),
    ("金融与量化", "Goldman Sachs · Exchanges", "https://feeds.megaphone.fm/GLD4133496924", "https://www.goldmansachs.com/insights/series/exchanges-at-goldman-sachs"),
    ("金融与量化", "Morgan Stanley · Thoughts on the Market", "https://feeds.megaphone.fm/thoughtsonmarket", "https://www.morganstanley.com/ideas/thoughts-on-the-market"),
    ("金融与量化", "Bloomberg · Odd Lots", "https://feeds.megaphone.fm/BLM2451951590", "https://www.bloomberg.com/oddlots"),

    // 军事与防务安全：全球顶尖防务播客、战略智库与军事前沿研究
    ("军事与防务安全", "西点军校现代战争研究所 · MWI Podcast", "https://mwi.westpoint.edu/feed/podcast/", "https://mwi.westpoint.edu/category/podcasts/"),
    ("军事与防务安全", "War on the Rocks · 战略与防务播客", "https://warontherocks.libsyn.com/rss", "https://warontherocks.com/"),
    ("军事与防务安全", "美国海军学会 · USNI Proceedings Podcast", "https://feeds.buzzsprout.com/269098.rss", "https://www.usni.org/magazines/proceedings/proceedings-podcast"),
    ("军事与防务安全", "战略与国际研究中心 · CSIS Defense360", "https://feeds.simplecast.com/4S9i1V4_", "https://defense360.csis.org/"),
    ("军事与防务安全", "美国国防部 · U.S. Department of Defense News", "https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945", "https://www.defense.gov/News/"),
    ("军事与防务安全", "兰德公司 · RAND National Security Research", "https://www.rand.org/topics/national-security-and-terrorism.xml", "https://www.rand.org/"),
    ("军事与防务安全", "英国皇家联合军种防务所 · RUSI Defense Podcast", "https://feeds.acast.com/public/shows/the-western-way-of-war", "https://rusi.org/"),

    // Public institutions across the United States, China, Japan and the EU.
    ("政府与公共机构", "U.S. Census Bureau · Economic Indicators", "https://www.census.gov/economic-indicators/indicator.xml", "https://www.census.gov/economic-indicators/"),
    ("政府与公共机构", "U.S. Census Bureau · Press Releases", "https://www.census.gov/content/census/en/newsroom/press-releases.xml", "https://www.census.gov/newsroom.html"),
    ("政府与公共机构", "U.S. Bureau of Labor Statistics · Latest Releases", "https://www.bls.gov/feed/bls_latest.rss", "https://www.bls.gov/"),
    ("政府与公共机构", "U.S. Bureau of Economic Analysis · Current Releases", "https://apps.bea.gov/rss/rss.xml", "https://www.bea.gov/news/current-releases"),
    ("政府与公共机构", "国家统计局 · 最新发布", "https://www.stats.gov.cn/sj/zxfb/rss.xml", "https://www.stats.gov.cn/"),
    ("政府与公共机构", "国家统计局 · 数据解读", "https://www.stats.gov.cn/sj/sjjd/rss.xml", "https://www.stats.gov.cn/"),
    ("政府与公共机构", "Japan Ministry of Finance · What's New", "https://www.mof.go.jp/english/news.rss", "https://www.mof.go.jp/english/"),
    ("政府与公共机构", "Bank of Japan · What's New", "https://www.boj.or.jp/en/rss/whatsnew.xml", "https://www.boj.or.jp/en/"),
    ("政府与公共机构", "Bank of Japan · Statistics", "https://www.boj.or.jp/en/rss/statistics.xml", "https://www.boj.or.jp/en/statistics/"),
    ("政府与公共机构", "European Central Bank · Press Releases", "https://www.ecb.europa.eu/rss/press.html", "https://www.ecb.europa.eu/press/"),
    ("政府与公共机构", "European Central Bank · Statistical Press Releases", "https://www.ecb.europa.eu/rss/statpress.html", "https://www.ecb.europa.eu/stats/"),
    ("政府与公共机构", "European Central Bank · Blog", "https://www.ecb.europa.eu/rss/blog.html", "https://www.ecb.europa.eu/press/blog/"),
    ("政府与公共机构", "European Central Bank · Publications", "https://www.ecb.europa.eu/rss/pub.html", "https://www.ecb.europa.eu/pub/"),

    // Technology publishers and engineering blogs. Rust is included for clean installs;
    // existing subscriptions are deduplicated by URL.
    ("技术博客", "Rust 官方博客", "https://blog.rust-lang.org/feed.xml", "https://blog.rust-lang.org/"),
    ("技术博客", "GitHub Blog", "https://github.blog/feed/", "https://github.blog/"),
    ("技术博客", "GitHub Changelog", "https://github.blog/changelog/feed/", "https://github.blog/changelog/"),
    ("技术博客", "Cloudflare Blog", "https://blog.cloudflare.com/rss/", "https://blog.cloudflare.com/"),
    ("技术博客", "Kubernetes Blog", "https://kubernetes.io/feed.xml", "https://kubernetes.io/blog/"),
    ("技术博客", "Mozilla Hacks", "https://hacks.mozilla.org/feed/", "https://hacks.mozilla.org/"),
    ("技术博客", "AWS News Blog", "https://aws.amazon.com/blogs/aws/feed/", "https://aws.amazon.com/blogs/aws/"),
    ("技术博客", "Go Blog", "https://go.dev/blog/feed.atom", "https://go.dev/blog/"),
    ("技术博客", "Python Insider", "https://blog.python.org/feeds/posts/default", "https://blog.python.org/"),
    ("技术博客", "TypeScript Blog", "https://devblogs.microsoft.com/typescript/feed/", "https://devblogs.microsoft.com/typescript/"),
];

pub fn seed_default_sources(
    conn: &Connection,
    now: i64,
    force: bool,
) -> Result<Vec<String>, String> {
    const SEED_KEY: &str = "starter-feeds-v3-podcast-military";
    let channel_count: usize = conn
        .query_row("SELECT count(*) FROM feed_channels", [], |r| r.get(0))
        .unwrap_or(0);

    let already_seeded: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM feed_seed_state WHERE key = ?1)",
            params![SEED_KEY],
            |row| row.get(0),
        )
        .map_err(|e| format!("检查默认订阅源状态失败：{e}"))?;

    if already_seeded && channel_count > 0 && !force {
        return Ok(Vec::new());
    }

    let mut added_ids = Vec::new();
    const LEGACY_CFA_URL: &str = "https://blogs.cfainstitute.org/investor/feed/";
    conn.execute(
        "DELETE FROM feed_channels
         WHERE url = ?1
           AND title = ?2
           AND NOT EXISTS (
               SELECT 1 FROM feed_articles WHERE feed_articles.channel_id = feed_channels.id
           )",
        params![LEGACY_CFA_URL, "CFA Institute · Enterprising Investor"],
    )
    .map_err(|e| format!("清理无文章的旧 CFA RSS 地址失败：{e}"))?;

    const LEGACY_BEA_URL: &str = "https://www.bea.gov/news/current-releases/rss.xml";
    const CURRENT_BEA_URL: &str = "https://apps.bea.gov/rss/rss.xml";
    let legacy_bea_id: Option<String> = conn
        .query_row(
            "SELECT id FROM feed_channels
             WHERE url = ?1
               AND NOT EXISTS (SELECT 1 FROM feed_channels WHERE url = ?2)",
            params![LEGACY_BEA_URL, CURRENT_BEA_URL],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("查找旧 BEA 订阅地址失败：{e}"))?;
    if let Some(id) = legacy_bea_id {
        conn.execute(
            "UPDATE feed_channels SET
                url = ?1,
                sync_status = 'idle',
                error_message = NULL,
                last_sync_at = 0,
                updated_at = ?2
             WHERE id = ?3",
            params![CURRENT_BEA_URL, now, id],
        )
        .map_err(|e| format!("迁移 BEA 订阅地址失败：{e}"))?;
        added_ids.push(id);
    }

    for (category, title, url, site_url) in STARTER_FEEDS {
        ensure_category(conn, category, now)?;
        let id = Uuid::new_v4().to_string();
        let inserted = conn
            .execute(
                "INSERT OR IGNORE INTO feed_channels (
                    id, url, title, description, site_url, category, icon,
                    sync_status, error_message, last_sync_at, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, NULL, ?4, ?5, NULL, 'idle', NULL, 0, ?6, ?6)",
                params![id, url, title, site_url, category, now],
            )
            .map_err(|e| format!("预置订阅源失败（{title}）：{e}"))?;
        if inserted > 0 {
            added_ids.push(id);
        }
    }

    conn.execute(
        "INSERT INTO feed_seed_state (key, applied_at) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET applied_at = ?2",
        params![SEED_KEY, now],
    )
    .map_err(|e| format!("保存默认订阅源状态失败：{e}"))?;
    Ok(added_ids)
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
    ensure_category(conn, category, now)?;

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
                    reading_time_min = ?7,
                    audio_url = COALESCE(?8, audio_url),
                    audio_type = COALESCE(?9, audio_type),
                    audio_duration = COALESCE(?10, audio_duration)
                WHERE id = ?11",
                params![
                    a.title,
                    a.author.as_deref(),
                    a.url,
                    a.content,
                    a.summary,
                    a.published_at,
                    a.reading_time_min,
                    a.audio_url.as_deref(),
                    a.audio_type.as_deref(),
                    a.audio_duration,
                    existing_id
                ],
            )
            .map_err(|e| format!("更新文章内容失败：{e}"))?;
        } else {
            let id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO feed_articles (
                    id, channel_id, guid, title, author, url, content, summary,
                    published_at, read_status, starred, reading_time_min, created_at,
                    audio_url, audio_type, audio_duration
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'unread', 0, ?10, ?11, ?12, ?13, ?14)",
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
                    now,
                    a.audio_url.as_deref(),
                    a.audio_type.as_deref(),
                    a.audio_duration,
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
                a.content, a.summary, a.published_at, a.read_status, a.starred, a.reading_time_min, a.created_at,
                a.audio_url, a.audio_type, a.audio_duration
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

    if let Some(true) = filter.has_audio {
        sql.push_str(" AND a.audio_url IS NOT NULL AND trim(a.audio_url) != ''");
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
                a.content, a.summary, a.published_at, a.read_status, a.starred, a.reading_time_min, a.created_at,
                a.audio_url, a.audio_type, a.audio_duration
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

    let total_audios: usize = conn
        .query_row(
            "SELECT count(*) FROM feed_articles WHERE audio_url IS NOT NULL AND trim(audio_url) != ''",
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

    // Include empty categories so users can keep and organize them before subscribing.
    let mut cat_stmt = conn
        .prepare(
            "SELECT categories.name,
                    categories.color,
                    COUNT(DISTINCT channels.id) as channel_cnt,
                    COUNT(CASE WHEN articles.read_status = 'unread' THEN 1 END) as unread_cnt
             FROM feed_categories categories
             LEFT JOIN feed_channels channels ON channels.category = categories.name
             LEFT JOIN feed_articles articles ON channels.id = articles.channel_id
             GROUP BY categories.name, categories.color, categories.sort_order
             ORDER BY categories.sort_order ASC, categories.name COLLATE NOCASE ASC",
        )
        .map_err(|e| format!("统计分类数据失败：{e}"))?;

    let cat_iter = cat_stmt
        .query_map([], |r| {
            Ok(CategoryStats {
                name: r.get(0)?,
                color: r.get(1)?,
                channel_count: r.get(2)?,
                unread_count: r.get(3)?,
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
        total_audios,
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
        audio_url: row.get(14)?,
        audio_type: row.get(15)?,
        audio_duration: row.get(16)?,
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
                    audio_url: None,
                    audio_type: None,
                    audio_duration: None,
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
                    audio_url: Some("https://example.com/art-2.mp3".to_string()),
                    audio_type: Some("audio/mpeg".to_string()),
                    audio_duration: Some(180),
                },
            ],
            110,
        )
        .unwrap();

        assert_eq!(inserted, 2);

        let overview = get_feed_overview(&conn).unwrap();
        assert_eq!(overview.total_articles, 2);
        assert_eq!(overview.total_unread, 2);
        assert_eq!(overview.total_audios, 1);
        assert_eq!(overview.categories.len(), 1);
        assert_eq!(overview.categories[0].name, "Tech");

        let list = list_articles(&conn, &ArticleFilter::default()).unwrap();
        assert_eq!(list.len(), 2);
        set_article_read_status(&conn, &list[0].id, "read").unwrap();

        let audio_list = list_articles(&conn, &ArticleFilter { has_audio: Some(true), ..Default::default() }).unwrap();
        assert_eq!(audio_list.len(), 1);
        assert_eq!(audio_list[0].audio_url.as_deref(), Some("https://example.com/art-2.mp3"));

        let overview2 = get_feed_overview(&conn).unwrap();
        assert_eq!(overview2.total_unread, 1);

        mark_all_read(&conn, None, None).unwrap();
        let overview3 = get_feed_overview(&conn).unwrap();
        assert_eq!(overview3.total_unread, 0);
    }

    #[test]
    fn test_open_and_seed_on_disk() {
        let db_path = std::env::temp_dir().join(format!("test_feed_{}.sqlite3", Uuid::new_v4()));
        let conn = open(&db_path).unwrap();
        let overview = get_feed_overview(&conn).unwrap();
        assert!(!overview.channels.is_empty(), "channels should be auto-seeded");
        assert!(!overview.categories.is_empty(), "categories should be auto-seeded");

        // Reopening should succeed
        drop(conn);
        let conn2 = open(&db_path).unwrap();
        let overview2 = get_feed_overview(&conn2).unwrap();
        assert_eq!(overview2.channels.len(), overview.channels.len());
        let _ = std::fs::remove_file(&db_path);
    }
}

