use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::process::Command;
use uuid::Uuid;

use crate::{request_chat_completion, strip_json_code_fence};

const STORE_DIR_NAME: &str = "paper_translations";
const DUAL_PDF_DIR_NAME: &str = "paper_dual_pdfs";
const STORE_SCHEMA_VERSION: u32 = 1;
const MAX_PARAGRAPHS_PER_CALL: usize = 24;
const MAX_PARAGRAPHS_PER_PAGE: usize = 300;
const MAX_TRANSLATION_PROMPT_CHARS: usize = 36_000;
const MAX_SELECTION_CHARS: usize = 8_000;
const MAX_TRANSLATION_CHARS: usize = 24_000;
const MAX_PAGE_NUMBER: u32 = 50_000;
const PDF2ZH_CHECK_TIMEOUT_SECS: u64 = 5;
const PDF2ZH_RUN_TIMEOUT_SECS: u64 = 600;

const PAGE_SYSTEM_PROMPT: &str = r#"你是一名精通计算机科学与工程领域的学术论文翻译专家。
请将输入的论文段落数组逐段翻译为准确、专业、自然的简体中文学术表达，并严格保持以下规则：
1. 返回严格合法的 JSON，格式为：{"translations":[{"id":0,"translation":"..."}]}，不要包含解释性前言、后记或多余文字。
2. 输出数组中的每个 id 必须与输入的段落 id 一一对应且保持原始顺序，不能合并、拆分或遗漏段落。
3. 完整保留原文中的文献引用标记（如 [1]、[1, 2]、(Author et al., 2024)）、图表编号（如 Fig. 1、Table 2、Algorithm 1）、数学符号、变量名、代码标识符、URL 及 LaTeX 公式片段。
4. 若某段本身仅为极短编号、纯粹符号或公式残留而无需翻译，请原样保留其文本作为 translation。"#;

const WORD_SELECTION_PROMPT: &str = r#"你是一名学术双语词典与术语助手。
用户正在阅读英文或外文学术论文并划选了一个词汇或短语。请结合论文标题与前后语境，返回严格合法的 JSON：
{"translation":"简明中文释义（如有多个常用学术义项用分号分隔）","phoneticOrPos":"词性及常见音标或缩写说明（可空字符串）","termNote":"结合论文语境的一句话术语解释或用法提示"}
不要输出 JSON 以外的任何文字。"#;

const PASSAGE_SELECTION_PROMPT: &str = r#"你是一名严谨的学术论文翻译助手。
用户正在阅读学术论文并划选了片段。请结合论文标题与前后上下文，将其翻译为准确、流畅、符合中文科研习惯的表述，完整保留文献引用（如 [1]）、图表编号、变量符号与公式。
请返回严格合法的 JSON：
{"translation":"完整的中文译文","termNote":"若片段中包含关键专业术语或缩写，用一句话补充简明术语说明；否则为空字符串"}
不要输出 JSON 以外的任何文字。"#;

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

#[derive(Debug, Deserialize)]
struct ParagraphTranslationResponse {
    translations: Vec<TranslatedParagraph>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectionTranslationPayload {
    translation: String,
    #[serde(default)]
    phonetic_or_pos: Option<String>,
    #[serde(default)]
    term_note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PaperSelectionTranslation {
    pub mode: String,
    pub original: String,
    pub translation: String,
    pub phonetic_or_pos: Option<String>,
    pub term_note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PaperPageTranslationRecord {
    pub schema_version: u32,
    pub pdf_sha256: String,
    pub page_number: u32,
    pub page_content_hash: String,
    pub translated_at: i64,
    pub model: String,
    pub paragraphs: Vec<TranslatedParagraph>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PaperPageTranslationSummary {
    pub page_number: u32,
    pub page_content_hash: String,
    pub translated_at: i64,
    pub model: String,
    pub paragraph_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Pdf2ZhStatus {
    pub available: bool,
    pub engine: Option<String>,
    pub version: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DualPdfResult {
    pub dual_pdf_path: String,
    pub dual_pdf_sha256: String,
    pub cached: bool,
    pub engine: String,
}

fn take_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn non_empty_trimmed(value: Option<String>, max_chars: usize) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(take_chars(trimmed, max_chars))
        }
    })
}

fn valid_sha256(hash: &str) -> bool {
    let trimmed = hash.trim();
    trimmed.len() == 64 && trimmed.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn normalize_sha256(hash: &str) -> Result<String, String> {
    let trimmed = hash.trim();
    if !valid_sha256(trimmed) {
        return Err("PDF 文件指纹无效。".to_string());
    }
    Ok(trimmed.to_ascii_lowercase())
}

fn validate_page_number(page_number: u32) -> Result<u32, String> {
    if page_number == 0 || page_number > MAX_PAGE_NUMBER {
        return Err("论文页码超出有效范围。".to_string());
    }
    Ok(page_number)
}

fn store_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("无法获取应用数据目录：{e}"))?;
    Ok(base.join(STORE_DIR_NAME))
}

fn paper_dir(root: &Path, pdf_sha256: &str) -> Result<PathBuf, String> {
    let hash = normalize_sha256(pdf_sha256)?;
    Ok(root.join(hash))
}

fn page_file_path(root: &Path, pdf_sha256: &str, page_number: u32) -> Result<PathBuf, String> {
    let valid_page = validate_page_number(page_number)?;
    Ok(paper_dir(root, pdf_sha256)?.join(format!("page-{valid_page}.json")))
}

fn dual_pdf_dir(app: &AppHandle, pdf_sha256: &str) -> Result<PathBuf, String> {
    let hash = normalize_sha256(pdf_sha256)?;
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("无法获取应用数据目录：{e}"))?;
    Ok(base.join(DUAL_PDF_DIR_NAME).join(hash))
}

fn read_page_record(path: &Path) -> Result<Option<PaperPageTranslationRecord>, String> {
    match fs::read(path) {
        Ok(bytes) => {
            let record: PaperPageTranslationRecord = serde_json::from_slice(&bytes)
                .map_err(|_| "本地论文译文缓存损坏。".to_string())?;
            if record.schema_version != STORE_SCHEMA_VERSION {
                return Err("本地论文译文缓存版本不匹配。".to_string());
            }
            Ok(Some(record))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取论文译文缓存：{error}")),
    }
}

fn write_page_record(path: &Path, record: &PaperPageTranslationRecord) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "无法获取论文译文存储目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("无法创建论文译文缓存目录：{e}"))?;
    let payload = serde_json::to_vec_pretty(record)
        .map_err(|e| format!("无法序列化论文译文数据：{e}"))?;
    let temp_name = format!(
        "{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("page"),
        Uuid::new_v4().simple()
    );
    let temp_path = parent.join(temp_name);
    fs::write(&temp_path, payload).map_err(|e| format!("无法写入临时译文文件：{e}"))?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| {
            let _ = fs::remove_file(&temp_path);
            format!("无法更新已有译文缓存：{e}")
        })?;
    }
    fs::rename(&temp_path, path).map_err(|e| {
        let _ = fs::remove_file(&temp_path);
        format!("无法保存译文缓存：{e}")
    })?;
    Ok(())
}

fn parse_translated_paragraphs(content: &str) -> Result<Vec<TranslatedParagraph>, String> {
    let cleaned = strip_json_code_fence(content);
    if let Ok(parsed) = serde_json::from_str::<ParagraphTranslationResponse>(cleaned) {
        return Ok(parsed.translations);
    }
    if let Ok(array) = serde_json::from_str::<Vec<TranslatedParagraph>>(cleaned) {
        return Ok(array);
    }
    if let (Some(start), Some(end)) = (cleaned.find('{'), cleaned.rfind('}')) {
        if start < end {
            if let Ok(parsed) = serde_json::from_str::<ParagraphTranslationResponse>(&cleaned[start..=end]) {
                return Ok(parsed.translations);
            }
        }
    }
    Err("AI 返回的译文不是预期的 JSON 格式，请重试。".to_string())
}

fn parse_selection_translation(
    content: &str,
    mode: &str,
    original: &str,
) -> Result<PaperSelectionTranslation, String> {
    let cleaned = strip_json_code_fence(content);
    let parsed = match serde_json::from_str::<SelectionTranslationPayload>(cleaned) {
        Ok(payload) => Some(payload),
        Err(_) => match (cleaned.find('{'), cleaned.rfind('}')) {
            (Some(start), Some(end)) if start < end => {
                serde_json::from_str::<SelectionTranslationPayload>(&cleaned[start..=end]).ok()
            }
            _ => None,
        },
    };

    if let Some(payload) = parsed {
        let translation = payload.translation.trim();
        if !translation.is_empty() {
            return Ok(PaperSelectionTranslation {
                mode: mode.to_string(),
                original: original.to_string(),
                translation: take_chars(translation, MAX_TRANSLATION_CHARS),
                phonetic_or_pos: non_empty_trimmed(payload.phonetic_or_pos, 160),
                term_note: non_empty_trimmed(payload.term_note, 600),
            });
        }
    }

    let plain = cleaned.trim();
    if plain.is_empty() {
        return Err("AI 未返回有效译文，请重试。".to_string());
    }
    Ok(PaperSelectionTranslation {
        mode: mode.to_string(),
        original: original.to_string(),
        translation: take_chars(plain, MAX_TRANSLATION_CHARS),
        phonetic_or_pos: None,
        term_note: None,
    })
}

fn current_epoch_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn translate_paper_selection(
    base_url: String,
    model: String,
    paper_title: String,
    text: String,
    mode: String,
    context_before: Option<String>,
    context_after: Option<String>,
) -> Result<PaperSelectionTranslation, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("请先划选要翻译的论文文本。".to_string());
    }
    if trimmed.chars().count() > MAX_SELECTION_CHARS {
        return Err("划选文本过长，请分段翻译或使用整页双语对照。".to_string());
    }
    let resolved_mode = if mode.trim().eq_ignore_ascii_case("word") {
        "word"
    } else {
        "passage"
    };
    let system_prompt = if resolved_mode == "word" {
        WORD_SELECTION_PROMPT
    } else {
        PASSAGE_SELECTION_PROMPT
    };

    let user_content = serde_json::json!({
        "paperTitle": take_chars(paper_title.trim(), 240),
        "text": trimmed,
        "contextBefore": context_before.as_deref().map(|s| take_chars(s.trim(), 280)),
        "contextAfter": context_after.as_deref().map(|s| take_chars(s.trim(), 280)),
    });
    let user_content_str =
        serde_json::to_string(&user_content).map_err(|_| "翻译请求序列化失败。".to_string())?;

    let response = request_chat_completion(
        &base_url,
        &model,
        system_prompt,
        &user_content_str,
        MAX_TRANSLATION_PROMPT_CHARS,
    )
    .await?;

    parse_selection_translation(&response, resolved_mode, trimmed)
}

#[tauri::command]
pub async fn translate_paper_paragraphs(
    base_url: String,
    model: String,
    paper_title: String,
    page_number: u32,
    paragraphs: Vec<InputParagraph>,
) -> Result<Vec<TranslatedParagraph>, String> {
    let valid_page = validate_page_number(page_number)?;
    if paragraphs.is_empty() {
        return Ok(Vec::new());
    }
    if paragraphs.len() > MAX_PARAGRAPHS_PER_CALL {
        return Err("单次翻译段落过多，请按批发送。".to_string());
    }

    let user_content = serde_json::json!({
        "paperTitle": take_chars(paper_title.trim(), 240),
        "pageNumber": valid_page,
        "paragraphs": paragraphs,
    });
    let user_content_str =
        serde_json::to_string(&user_content).map_err(|_| "翻译请求序列化失败。".to_string())?;

    let response = request_chat_completion(
        &base_url,
        &model,
        PAGE_SYSTEM_PROMPT,
        &user_content_str,
        MAX_TRANSLATION_PROMPT_CHARS,
    )
    .await?;

    parse_translated_paragraphs(&response)
}

#[tauri::command]
pub async fn save_paper_page_translation(
    app: AppHandle,
    pdf_sha256: String,
    page_number: u32,
    page_content_hash: String,
    model: String,
    paragraphs: Vec<TranslatedParagraph>,
) -> Result<PaperPageTranslationRecord, String> {
    let normalized_pdf_hash = normalize_sha256(&pdf_sha256)?;
    let valid_page = validate_page_number(page_number)?;
    let normalized_page_hash = normalize_sha256(&page_content_hash)?;
    if paragraphs.is_empty() {
        return Err("没有可保存的页面译文。".to_string());
    }
    if paragraphs.len() > MAX_PARAGRAPHS_PER_PAGE {
        return Err("当前页可翻译段落数量超出限制。".to_string());
    }
    if paragraphs
        .iter()
        .any(|item| item.translation.chars().count() > MAX_TRANSLATION_CHARS)
    {
        return Err("单段译文长度超出限制。".to_string());
    }

    let root = store_root(&app)?;
    let path = page_file_path(&root, &normalized_pdf_hash, valid_page)?;
    let record = PaperPageTranslationRecord {
        schema_version: STORE_SCHEMA_VERSION,
        pdf_sha256: normalized_pdf_hash,
        page_number: valid_page,
        page_content_hash: normalized_page_hash,
        translated_at: current_epoch_millis(),
        model: take_chars(model.trim(), 200),
        paragraphs,
    };
    write_page_record(&path, &record)?;
    Ok(record)
}

#[tauri::command]
pub async fn get_paper_page_translation(
    app: AppHandle,
    pdf_sha256: String,
    page_number: u32,
) -> Result<Option<PaperPageTranslationRecord>, String> {
    let root = store_root(&app)?;
    let path = page_file_path(&root, &pdf_sha256, page_number)?;
    read_page_record(&path)
}

#[tauri::command]
pub async fn delete_paper_page_translation(
    app: AppHandle,
    pdf_sha256: String,
    page_number: u32,
) -> Result<bool, String> {
    let root = store_root(&app)?;
    let path = page_file_path(&root, &pdf_sha256, page_number)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("无法清除该页译文缓存：{error}")),
    }
}

#[tauri::command]
pub async fn clear_paper_translations(
    app: AppHandle,
    pdf_sha256: String,
) -> Result<bool, String> {
    let root = store_root(&app)?;
    let dir = paper_dir(&root, &pdf_sha256)?;
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("无法清除论文全部译文缓存：{error}")),
    }
}

#[tauri::command]
pub async fn list_paper_translated_pages(
    app: AppHandle,
    pdf_sha256: String,
) -> Result<Vec<PaperPageTranslationSummary>, String> {
    let root = store_root(&app)?;
    let dir = paper_dir(&root, &pdf_sha256)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(&dir).map_err(|e| format!("无法读取论文译文目录：{e}"))?;
    let mut list = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("无法读取论文译文条目：{e}"))?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        if let Ok(Some(record)) = read_page_record(&path) {
            list.push(PaperPageTranslationSummary {
                page_number: record.page_number,
                page_content_hash: record.page_content_hash,
                translated_at: record.translated_at,
                model: record.model,
                paragraph_count: record.paragraphs.len(),
            });
        }
    }
    list.sort_by_key(|item| item.page_number);
    Ok(list)
}

fn hidden_tokio_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

async fn probe_tool_version(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = hidden_tokio_command(program);
    cmd.args(args);
    let output = tokio::time::timeout(Duration::from_secs(PDF2ZH_CHECK_TIMEOUT_SECS), cmd.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let text = if !stdout.is_empty() { stdout } else { stderr };
    Some(
        text.lines()
            .next()
            .unwrap_or("installed")
            .trim()
            .to_string(),
    )
}

#[tauri::command]
pub async fn check_pdf2zh_status() -> Result<Pdf2ZhStatus, String> {
    if let Some(version) = probe_tool_version("pdf2zh", &["--version"]).await {
        return Ok(Pdf2ZhStatus {
            available: true,
            engine: Some("pdf2zh".to_string()),
            version: Some(version),
            message: "已检测到本地 pdf2zh 引擎，可生成保留公式与排版的双语对照 PDF。".to_string(),
        });
    }
    if let Some(version) = probe_tool_version("pdf2zh_next", &["--version"]).await {
        return Ok(Pdf2ZhStatus {
            available: true,
            engine: Some("pdf2zh_next".to_string()),
            version: Some(version),
            message: "已检测到本地 pdf2zh_next (BabelDOC) 引擎，可生成双语对照 PDF。".to_string(),
        });
    }
    for py in ["python", "py"] {
        if let Some(version) = probe_tool_version(py, &["-m", "pdf2zh", "--version"]).await {
            return Ok(Pdf2ZhStatus {
                available: true,
                engine: Some(format!("{py} -m pdf2zh")),
                version: Some(version),
                message: "已通过 Python 环境检测到 pdf2zh 引擎，可生成双语对照 PDF。".to_string(),
            });
        }
    }
    Ok(Pdf2ZhStatus {
        available: false,
        engine: None,
        version: None,
        message: "未检测到本地 pdf2zh / BabelDOC。可执行 `pip install pdf2zh` 或 `uv tool install pdf2zh` 后重试；未安装时也可继续使用内置划词与段落双语翻译。".to_string(),
    })
}

fn find_dual_pdf_in_dir(dir: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    let mut candidates: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        let lower = name.to_ascii_lowercase();
                        lower.ends_with("-dual.pdf") || lower.ends_with(".dual.pdf")
                    })
        })
        .collect();
    candidates.sort();
    candidates.into_iter().next()
}

fn hash_pdf_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("无法读取生成的双语 PDF：{e}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|e| format!("读取双语 PDF 校验和失败：{e}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn allowed_pdf2zh_service(service: Option<&str>) -> &'static str {
    match service.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("google") => "google",
        Some("deepl") => "deepl",
        Some("openai") => "openai",
        Some("ollama") => "ollama",
        Some("argos") => "argos",
        Some("siliconflow") => "siliconflow",
        Some("deepseek") => "deepseek",
        Some("gemini") => "gemini",
        Some("zhipu") => "zhipu",
        Some("qwen") => "qwen",
        _ => "bing",
    }
}

#[tauri::command]
pub async fn generate_bilingual_paper_pdf(
    app: AppHandle,
    paper_id: String,
    service: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    force: Option<bool>,
) -> Result<DualPdfResult, String> {
    let opened = crate::literature::literature_open_pdf(app.clone(), paper_id)?;
    let source_pdf = PathBuf::from(&opened.path);
    let out_dir = dual_pdf_dir(&app, &opened.sha256)?;
    fs::create_dir_all(&out_dir).map_err(|e| format!("无法创建双语 PDF 输出目录：{e}"))?;

    if force != Some(true) {
        if let Some(existing_dual) = find_dual_pdf_in_dir(&out_dir) {
            app.asset_protocol_scope()
                .allow_file(&existing_dual)
                .map_err(|e| format!("无法授权读取双语 PDF：{e}"))?;
            let dual_sha256 = hash_pdf_file(&existing_dual)?;
            return Ok(DualPdfResult {
                dual_pdf_path: existing_dual.to_string_lossy().into_owned(),
                dual_pdf_sha256: dual_sha256,
                cached: true,
                engine: "cached".to_string(),
            });
        }
    }

    let status = check_pdf2zh_status().await?;
    let Some(engine) = status.engine else {
        return Err(status.message);
    };

    let selected_service = allowed_pdf2zh_service(service.as_deref());
    let mut cmd = if engine == "pdf2zh" {
        hidden_tokio_command("pdf2zh")
    } else if engine == "pdf2zh_next" {
        hidden_tokio_command("pdf2zh_next")
    } else if let Some(py) = engine.strip_suffix(" -m pdf2zh") {
        let mut c = hidden_tokio_command(py);
        c.args(["-m", "pdf2zh"]);
        c
    } else {
        hidden_tokio_command("pdf2zh")
    };

    if selected_service == "openai" {
        if let Ok(api_key) = crate::load_stored_api_key() {
            let trimmed_key = api_key.trim();
            if !trimmed_key.is_empty() {
                cmd.env("OPENAI_API_KEY", trimmed_key);
            }
        }
        if let Some(url) = base_url.as_deref().map(str::trim).filter(|s| {
            !s.is_empty() && (s.starts_with("https://") || s.starts_with("http://"))
        }) {
            cmd.env("OPENAI_BASE_URL", url);
        }
        if let Some(model_name) = model.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            cmd.env("OPENAI_MODEL", take_chars(model_name, 200));
        }
    }

    if engine == "pdf2zh_next" {
        cmd.arg("--output").arg(&out_dir).arg(&source_pdf);
    } else {
        cmd.arg(&source_pdf)
            .arg("-lo")
            .arg("zh")
            .arg("-s")
            .arg(selected_service)
            .arg("-o")
            .arg(&out_dir);
    }

    let output = tokio::time::timeout(Duration::from_secs(PDF2ZH_RUN_TIMEOUT_SECS), cmd.output())
        .await
        .map_err(|_| "双语 PDF 重排超时（超过 10 分钟），可改为分页内置翻译。".to_string())?
        .map_err(|e| format!("启动 {engine} 失败：{e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if !stderr.trim().is_empty() {
            stderr.trim()
        } else {
            stdout.trim()
        };
        return Err(format!(
            "双语 PDF 生成失败：{}",
            take_chars(detail, 400)
        ));
    }

    let dual_path = find_dual_pdf_in_dir(&out_dir)
        .ok_or_else(|| "引擎执行完成，但未在输出目录找到双语对照 PDF（*-dual.pdf）。".to_string())?;
    app.asset_protocol_scope()
        .allow_file(&dual_path)
        .map_err(|e| format!("无法授权读取生成的双语 PDF：{e}"))?;
    let dual_sha256 = hash_pdf_file(&dual_path)?;

    Ok(DualPdfResult {
        dual_pdf_path: dual_path.to_string_lossy().into_owned(),
        dual_pdf_sha256: dual_sha256,
        cached: false,
        engine,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_sha256_strictly() {
        let valid = "a".repeat(64);
        assert_eq!(normalize_sha256(&valid).unwrap(), valid);
        assert!(normalize_sha256("too-short").is_err());
        assert!(normalize_sha256(&format!("{}../", "b".repeat(61))).is_err());
        assert!(normalize_sha256(&"z".repeat(64)).is_err());
    }

    #[test]
    fn validates_page_numbers() {
        assert_eq!(validate_page_number(1).unwrap(), 1);
        assert!(validate_page_number(0).is_err());
        assert!(validate_page_number(MAX_PAGE_NUMBER + 1).is_err());
    }

    #[test]
    fn parses_fenced_and_raw_paragraph_translations() {
        let raw = r#"```json
{"translations":[{"id":0,"translation":"第一段"},{"id":1,"translation":"第二段"}]}
```"#;
        let parsed = parse_translated_paragraphs(raw).expect("should parse fenced json");
        assert_eq!(
            parsed,
            vec![
                TranslatedParagraph {
                    id: 0,
                    translation: "第一段".to_string(),
                },
                TranslatedParagraph {
                    id: 1,
                    translation: "第二段".to_string(),
                },
            ]
        );
    }

    #[test]
    fn parses_word_and_passage_selection_with_fallback() {
        let json_reply =
            r#"{"translation":"注意力机制","phoneticOrPos":"n.","termNote":"核心网络模块"}"#;
        let structured = parse_selection_translation(json_reply, "word", "attention")
            .expect("should parse structured reply");
        assert_eq!(structured.translation, "注意力机制");
        assert_eq!(structured.phonetic_or_pos.as_deref(), Some("n."));
        assert_eq!(structured.term_note.as_deref(), Some("核心网络模块"));

        let plain = parse_selection_translation("这是一个普通句子译文。", "passage", "Sentence.")
            .expect("should fallback to plain text");
        assert_eq!(plain.translation, "这是一个普通句子译文。");
        assert_eq!(plain.phonetic_or_pos, None);
    }

    #[test]
    fn atomic_page_record_round_trip() {
        let dir = std::env::temp_dir().join(format!("seamind-paper-trans-{}", Uuid::new_v4()));
        let sha = "c".repeat(64);
        let path = page_file_path(&dir, &sha, 3).expect("valid page path");
        let record = PaperPageTranslationRecord {
            schema_version: STORE_SCHEMA_VERSION,
            pdf_sha256: sha.clone(),
            page_number: 3,
            page_content_hash: "d".repeat(64),
            translated_at: 1_700_000_000_000,
            model: "gpt-4o-mini".to_string(),
            paragraphs: vec![TranslatedParagraph {
                id: 0,
                translation: "测试译文".to_string(),
            }],
        };

        write_page_record(&path, &record).expect("write record");
        let loaded = read_page_record(&path)
            .expect("read record")
            .expect("record exists");
        assert_eq!(loaded, record);

        let _ = fs::remove_dir_all(&dir);
    }
}
