use crate::request_chat_completion;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const STORE_DIRECTORY: &str = "epub_translations";
const STORE_SCHEMA_VERSION: u32 = 1;
const MAX_TRANSLATION_PROMPT_CHARS: usize = 30_000;

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
pub struct EpubChapterTranslationRecord {
    pub schema_version: u32,
    pub book_key: String,
    pub section_index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_href: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chapter_title: Option<String>,
    pub translated_at: i64,
    pub model: String,
    pub paragraphs: Vec<TranslatedParagraph>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EpubChapterTranslationSummary {
    pub section_index: usize,
    pub section_href: Option<String>,
    pub chapter_title: Option<String>,
    pub translated_at: i64,
    pub model: String,
    pub paragraph_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookTranslationStore {
    pub schema_version: u32,
    pub book_key: String,
    pub chapters: Vec<EpubChapterTranslationRecord>,
}

fn store_path(app: &AppHandle, book_key: &str) -> Result<PathBuf, String> {
    let trimmed = book_key.trim();
    if trimmed.is_empty() {
        return Err("书籍标识无效。".to_string());
    }
    let root = app
        .path()
        .app_data_dir()
        .or_else(|_| app.path().app_local_data_dir())
        .map_err(|error| format!("无法找到译文本地存储目录：{error}"))?;
    let store_id = Uuid::new_v5(&Uuid::NAMESPACE_URL, trimmed.as_bytes());
    Ok(root.join(STORE_DIRECTORY).join(format!("{store_id}.json")))
}

fn read_book_store(app: &AppHandle, book_key: &str) -> Result<BookTranslationStore, String> {
    let path = store_path(app, book_key)?;
    match fs::read(&path) {
        Ok(bytes) => {
            let store: BookTranslationStore = serde_json::from_slice(&bytes)
                .map_err(|_| "本地译文文件损坏，未覆盖现有数据。".to_string())?;
            if store.schema_version != STORE_SCHEMA_VERSION || store.book_key != book_key {
                return Err("本地译文文件版本或书籍标识不匹配。".to_string());
            }
            Ok(store)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BookTranslationStore {
            schema_version: STORE_SCHEMA_VERSION,
            book_key: book_key.to_string(),
            chapters: Vec::new(),
        }),
        Err(error) => Err(format!("无法读取本地译文：{error}")),
    }
}

fn write_book_store(app: &AppHandle, store: &BookTranslationStore) -> Result<(), String> {
    let target = store_path(app, &store.book_key)?;
    let parent = target
        .parent()
        .ok_or_else(|| "无法获取本地译文存储目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建本地译文目录：{error}"))?;

    let payload = serde_json::to_vec_pretty(store)
        .map_err(|error| format!("无法序列化译文数据：{error}"))?;

    let temp_name = format!(
        "{}.{}.tmp",
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("translation"),
        Uuid::new_v4().simple()
    );
    let temp_path = parent.join(temp_name);

    fs::write(&temp_path, payload).map_err(|error| format!("无法写入临时译文文件：{error}"))?;
    fs::rename(&temp_path, &target).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        format!("无法原子替换译文文件：{error}")
    })?;
    Ok(())
}

const SYSTEM_PROMPT: &str = r#"You are an expert technical and literary book translator.
Translate the provided list of paragraphs from the book into clear, fluent, natural, and accurate Simplified Chinese (zh-CN).

CRITICAL INSTRUCTIONS:
1. Preserve technical terminology, programming identifiers, command-line syntax, and file paths accurately. Do NOT mistranslate technical jargon (e.g. Linux commands, network terms, code identifiers).
2. Maintain natural reading flow and tone suited for a professional technical book.
3. You will receive a JSON array of paragraphs, each with an integer "id" and "text":
   [{"id": 0, "text": "Hello world"}, {"id": 1, "text": "Second paragraph"}]
4. You MUST respond ONLY with a valid JSON array of objects with the exact keys "id" and "translation":
   [{"id": 0, "translation": "你好世界"}, {"id": 1, "translation": "第二段"}]
5. Do NOT omit any paragraphs. Keep the exact same "id" for each paragraph.
6. Do NOT include markdown code fences, comments, or explanations outside the JSON array. Output raw JSON only."#;

#[tauri::command]
pub async fn translate_epub_paragraphs(
    base_url: String,
    model: String,
    book_title: String,
    chapter_title: String,
    paragraphs: Vec<InputParagraph>,
) -> Result<Vec<TranslatedParagraph>, String> {
    if paragraphs.is_empty() {
        return Ok(Vec::new());
    }
    if paragraphs.len() > 60 {
        return Err("单次翻译段落数量过多，请按 10-30 段分批发送。".to_string());
    }

    let user_content = serde_json::json!({
        "book": book_title.chars().take(200).collect::<String>(),
        "chapter": chapter_title.chars().take(200).collect::<String>(),
        "paragraphs": paragraphs,
    });
    let user_content_str = serde_json::to_string(&user_content)
        .map_err(|_| "翻译请求内容序列化失败。".to_string())?;

    let response = request_chat_completion(
        &base_url,
        &model,
        SYSTEM_PROMPT,
        &user_content_str,
        MAX_TRANSLATION_PROMPT_CHARS,
    )
    .await?;

    let stripped = crate::strip_json_code_fence(&response).trim();
    let parsed: Vec<TranslatedParagraph> = serde_json::from_str(stripped).map_err(|err| {
        format!(
            "AI 返回的译文格式无效：{err}。原始内容前 200 字：{}",
            stripped.chars().take(200).collect::<String>()
        )
    })?;

    Ok(parsed)
}

#[tauri::command]
pub async fn save_epub_chapter_translation(
    app: AppHandle,
    book_key: String,
    section_index: usize,
    section_href: Option<String>,
    chapter_title: Option<String>,
    model: String,
    paragraphs: Vec<TranslatedParagraph>,
) -> Result<EpubChapterTranslationRecord, String> {
    let mut store = read_book_store(&app, &book_key)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let record = EpubChapterTranslationRecord {
        schema_version: STORE_SCHEMA_VERSION,
        book_key: book_key.clone(),
        section_index,
        section_href,
        chapter_title,
        translated_at: now,
        model,
        paragraphs,
    };

    if let Some(pos) = store
        .chapters
        .iter()
        .position(|c| c.section_index == section_index)
    {
        store.chapters[pos] = record.clone();
    } else {
        store.chapters.push(record.clone());
    }

    write_book_store(&app, &store)?;
    Ok(record)
}

#[tauri::command]
pub async fn get_epub_chapter_translation(
    app: AppHandle,
    book_key: String,
    section_index: usize,
) -> Result<Option<EpubChapterTranslationRecord>, String> {
    let store = read_book_store(&app, &book_key)?;
    Ok(store
        .chapters
        .into_iter()
        .find(|c| c.section_index == section_index))
}

#[tauri::command]
pub async fn delete_epub_chapter_translation(
    app: AppHandle,
    book_key: String,
    section_index: usize,
) -> Result<bool, String> {
    let mut store = read_book_store(&app, &book_key)?;
    let before_len = store.chapters.len();
    store.chapters.retain(|c| c.section_index != section_index);
    if store.chapters.len() != before_len {
        write_book_store(&app, &store)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn list_epub_book_translations(
    app: AppHandle,
    book_key: String,
) -> Result<Vec<EpubChapterTranslationSummary>, String> {
    let store = read_book_store(&app, &book_key)?;
    let mut summaries: Vec<_> = store
        .chapters
        .into_iter()
        .map(|c| EpubChapterTranslationSummary {
            section_index: c.section_index,
            section_href: c.section_href,
            chapter_title: c.chapter_title,
            translated_at: c.translated_at,
            model: c.model,
            paragraph_count: c.paragraphs.len(),
        })
        .collect();
    summaries.sort_by_key(|s| s.section_index);
    Ok(summaries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ai_translation_json() {
        let raw = r#"[
            {"id": 0, "translation": "关于作者"},
            {"id": 1, "translation": "OccupyTheWeb 是主要作者。"}
        ]"#;
        let parsed: Vec<TranslatedParagraph> = serde_json::from_str(raw).expect("should parse");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].id, 0);
        assert_eq!(parsed[0].translation, "关于作者");
        assert_eq!(parsed[1].id, 1);
    }

    #[test]
    fn serialization_round_trip() {
        let record = EpubChapterTranslationRecord {
            schema_version: 1,
            book_key: "book_test_123".to_string(),
            section_index: 4,
            section_href: Some("chapter4.xhtml".to_string()),
            chapter_title: Some("Chapter 4".to_string()),
            translated_at: 1700000000,
            model: "deepseek-chat".to_string(),
            paragraphs: vec![
                TranslatedParagraph {
                    id: 0,
                    translation: "你好".to_string(),
                },
                TranslatedParagraph {
                    id: 1,
                    translation: "世界".to_string(),
                },
            ],
        };
        let store = BookTranslationStore {
            schema_version: 1,
            book_key: "book_test_123".to_string(),
            chapters: vec![record],
        };
        let serialized = serde_json::to_string(&store).expect("must serialize");
        let deserialized: BookTranslationStore =
            serde_json::from_str(&serialized).expect("must deserialize");
        assert_eq!(deserialized, store);
    }
}
