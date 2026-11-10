use crate::request_chat_completion;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const STORE_DIRECTORY: &str = "feed_translations";
const STORE_SCHEMA_VERSION: u32 = 1;
const MAX_TRANSLATION_PROMPT_CHARS: usize = 30_000;
const MAX_PARAGRAPHS_PER_CALL: usize = 60;
const MAX_PARAGRAPHS_PER_ARTICLE: usize = 500;
const MAX_TRANSLATION_CHARS: usize = 20_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InputParagraph {
    pub id: usize,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TranslatedParagraph {
    pub id: usize,
    pub translation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FeedArticleTranslationRecord {
    pub schema_version: u32,
    pub article_id: String,
    pub channel_id: String,
    pub title: String,
    pub content_hash: String,
    pub translated_at: i64,
    pub model: String,
    pub paragraphs: Vec<TranslatedParagraph>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FeedTranslationIndexEntry {
    pub article_id: String,
    pub channel_id: String,
    pub content_hash: String,
    pub translated_at: i64,
    pub paragraph_count: usize,
}

const SYSTEM_PROMPT: &str = r#"You are an expert translator for articles, newsletters, and podcast show notes.
Translate each paragraph into clear, fluent, natural Simplified Chinese (zh-CN).

CRITICAL INSTRUCTIONS:
1. Preserve technical terminology, programming identifiers, command-line syntax, URLs, and file paths. Do NOT mistranslate code, product names, or proper nouns that should stay in the original language.
2. Keep the author's tone. Do not summarize, omit facts, or add commentary.
3. You will receive a JSON object with "source", "article", and "paragraphs". Each paragraph has an integer "id" and "text".
4. Respond ONLY with a JSON array of objects with the exact keys "id" and "translation":
   [{"id": 0, "translation": "..."}]
5. Do NOT omit any paragraph. Keep the exact same "id" for each paragraph.
6. Do NOT include markdown code fences, comments, or explanations. Output raw JSON only."#;

pub(crate) fn parse_translated_paragraphs(raw: &str) -> Result<Vec<TranslatedParagraph>, String> {
    let stripped = crate::strip_json_code_fence(raw).trim();
    serde_json::from_str(stripped).map_err(|err| {
        format!(
            "AI 返回的译文格式无效：{err}。原始内容前 200 字：{}",
            stripped.chars().take(200).collect::<String>()
        )
    })
}

fn valid_id(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && trimmed.len() <= 200 && !trimmed.contains(['/', '\\', '\0'])
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn take_chars(value: &str, limit: usize) -> String {
    value.trim().chars().take(limit).collect()
}

fn store_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .or_else(|_| app.path().app_local_data_dir())
        .map_err(|error| format!("无法找到译文本地存储目录：{error}"))?;
    Ok(root.join(STORE_DIRECTORY))
}

fn article_store_path(dir: &Path, article_id: &str) -> Result<PathBuf, String> {
    let trimmed = article_id.trim();
    if !valid_id(trimmed) {
        return Err("文章标识无效。".to_string());
    }
    let key = format!("seamind-feed-article:{trimmed}");
    let store_id = Uuid::new_v5(&Uuid::NAMESPACE_URL, key.as_bytes());
    Ok(dir.join(format!("{store_id}.json")))
}

fn read_record(path: &Path) -> Result<Option<FeedArticleTranslationRecord>, String> {
    match fs::read(path) {
        Ok(bytes) => {
            let record: FeedArticleTranslationRecord = serde_json::from_slice(&bytes)
                .map_err(|_| "本地译文文件损坏，未覆盖现有数据。".to_string())?;
            if record.schema_version != STORE_SCHEMA_VERSION {
                return Err("本地译文文件版本不匹配。".to_string());
            }
            Ok(Some(record))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取本地译文：{error}")),
    }
}

fn write_record(path: &Path, record: &FeedArticleTranslationRecord) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "无法获取本地译文存储目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建本地译文目录：{error}"))?;
    let payload = serde_json::to_vec_pretty(record)
        .map_err(|error| format!("无法序列化译文数据：{error}"))?;
    let temp_name = format!(
        "{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("translation"),
        Uuid::new_v4().simple()
    );
    let temp_path = parent.join(temp_name);
    fs::write(&temp_path, payload).map_err(|error| format!("无法写入临时译文文件：{error}"))?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| {
            let _ = fs::remove_file(&temp_path);
            format!("无法替换已有译文：{error}")
        })?;
    }
    fs::rename(&temp_path, path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        format!("无法保存译文文件：{error}")
    })?;
    Ok(())
}

fn validate_record_fields(
    article_id: &str,
    channel_id: &str,
    content_hash: &str,
    paragraphs: &[TranslatedParagraph],
) -> Result<(), String> {
    if !valid_id(article_id) {
        return Err("文章标识无效。".to_string());
    }
    if !valid_id(channel_id) {
        return Err("订阅源标识无效。".to_string());
    }
    if !valid_hash(content_hash) {
        return Err("正文指纹无效。".to_string());
    }
    if paragraphs.is_empty() {
        return Err("没有可保存的译文。".to_string());
    }
    if paragraphs.len() > MAX_PARAGRAPHS_PER_ARTICLE {
        return Err("这篇文章的译文段落过多。".to_string());
    }
    if paragraphs
        .iter()
        .any(|item| item.translation.chars().count() > MAX_TRANSLATION_CHARS)
    {
        return Err("单段译文过长。".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn translate_feed_paragraphs(
    base_url: String,
    model: String,
    channel_title: String,
    article_title: String,
    paragraphs: Vec<InputParagraph>,
) -> Result<Vec<TranslatedParagraph>, String> {
    if paragraphs.is_empty() {
        return Ok(Vec::new());
    }
    if paragraphs.len() > MAX_PARAGRAPHS_PER_CALL {
        return Err("单次翻译段落数量过多，请按 10 段左右分批发送。".to_string());
    }

    let user_content = serde_json::json!({
        "source": take_chars(&channel_title, 200),
        "article": take_chars(&article_title, 200),
        "paragraphs": paragraphs,
    });
    let user_content_str =
        serde_json::to_string(&user_content).map_err(|_| "翻译请求内容序列化失败。".to_string())?;

    let response = request_chat_completion(
        &base_url,
        &model,
        SYSTEM_PROMPT,
        &user_content_str,
        MAX_TRANSLATION_PROMPT_CHARS,
    )
    .await?;

    parse_translated_paragraphs(&response)
}

#[tauri::command]
pub async fn save_feed_article_translation(
    app: AppHandle,
    article_id: String,
    channel_id: String,
    title: String,
    content_hash: String,
    model: String,
    paragraphs: Vec<TranslatedParagraph>,
) -> Result<FeedArticleTranslationRecord, String> {
    validate_record_fields(&article_id, &channel_id, &content_hash, &paragraphs)?;
    let dir = store_dir(&app)?;
    let path = article_store_path(&dir, &article_id)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    let record = FeedArticleTranslationRecord {
        schema_version: STORE_SCHEMA_VERSION,
        article_id: article_id.trim().to_string(),
        channel_id: channel_id.trim().to_string(),
        title: take_chars(&title, 300),
        content_hash: content_hash.to_ascii_lowercase(),
        translated_at: now,
        model: take_chars(&model, 200),
        paragraphs,
    };
    write_record(&path, &record)?;
    Ok(record)
}

#[tauri::command]
pub async fn get_feed_article_translation(
    app: AppHandle,
    article_id: String,
) -> Result<Option<FeedArticleTranslationRecord>, String> {
    let dir = store_dir(&app)?;
    let path = article_store_path(&dir, &article_id)?;
    read_record(&path)
}

#[tauri::command]
pub async fn delete_feed_article_translation(
    app: AppHandle,
    article_id: String,
) -> Result<bool, String> {
    let dir = store_dir(&app)?;
    let path = article_store_path(&dir, &article_id)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("无法清除译文：{error}")),
    }
}

#[tauri::command]
pub async fn list_feed_translation_index(
    app: AppHandle,
) -> Result<Vec<FeedTranslationIndexEntry>, String> {
    let dir = store_dir(&app)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(&dir).map_err(|error| format!("无法读取译文目录：{error}"))?;
    let mut index = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("无法读取译文目录：{error}"))?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Some(record) = read_record(&path)? else {
            continue;
        };
        index.push(FeedTranslationIndexEntry {
            article_id: record.article_id,
            channel_id: record.channel_id,
            content_hash: record.content_hash,
            translated_at: record.translated_at,
            paragraph_count: record.paragraphs.len(),
        });
    }
    index.sort_by(|left, right| right.translated_at.cmp(&left.translated_at));
    Ok(index)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_record(article_id: &str, channel_id: &str) -> FeedArticleTranslationRecord {
        FeedArticleTranslationRecord {
            schema_version: STORE_SCHEMA_VERSION,
            article_id: article_id.to_string(),
            channel_id: channel_id.to_string(),
            title: "Hello".to_string(),
            content_hash: "ab".repeat(32),
            translated_at: 10,
            model: "test-model".to_string(),
            paragraphs: vec![TranslatedParagraph {
                id: 0,
                translation: "你好".to_string(),
            }],
        }
    }

    #[test]
    fn parses_fenced_translation_json() {
        let raw = "```json\n[{\"id\":1,\"translation\":\"第二段\"}]\n```";
        let parsed = parse_translated_paragraphs(raw).expect("parse");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, 1);
        assert_eq!(parsed[0].translation, "第二段");
    }

    #[test]
    fn store_round_trip_keeps_one_file_per_article() {
        let dir = std::env::temp_dir().join(format!(
            "seamind-feed-trans-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        let first = sample_record("article-1", "channel-a");
        let second = sample_record("article-2", "channel-a");
        let first_path = article_store_path(&dir, &first.article_id).unwrap();
        let second_path = article_store_path(&dir, &second.article_id).unwrap();
        write_record(&first_path, &first).unwrap();
        write_record(&second_path, &second).unwrap();

        let updated = FeedArticleTranslationRecord {
            title: "Updated".to_string(),
            ..first.clone()
        };
        write_record(&first_path, &updated).unwrap();

        let loaded = read_record(&first_path).unwrap().expect("present");
        assert_eq!(loaded.title, "Updated");
        assert_eq!(loaded.paragraphs[0].translation, "你好");
        assert!(read_record(&second_path).unwrap().is_some());
        assert_ne!(first_path, second_path);

        fs::remove_file(&first_path).unwrap();
        assert!(read_record(&first_path).unwrap().is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_a_batch_that_is_too_large_to_store() {
        let paragraphs = vec![TranslatedParagraph {
            id: 0,
            translation: "x".repeat(MAX_TRANSLATION_CHARS + 1),
        }];
        let error = validate_record_fields("article-1", "channel-a", &"ab".repeat(32), &paragraphs)
            .expect_err("too long");
        assert!(error.contains("过长"));
    }
}
