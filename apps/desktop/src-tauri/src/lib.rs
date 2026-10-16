mod library;
mod epub;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(library::WatcherState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            has_api_key,
            save_api_key,
            delete_api_key,
            generate_mindmap,
            epub::import_epub_toc,
            library::library_status,
            library::set_library_root,
            library::search_library,
            library::open_document,
            library::save_document,
            library::delete_document,
            library::create_category,
            library::rebuild_library_index,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Markmap Desktop");
}

const KEYRING_SERVICE: &str = "com.markmap.desktop";
const KEYRING_USER: &str = "openai-compatible-api-key";
const MAX_PROMPT_CHARS: usize = 4_000;
const MAX_MARKDOWN_BYTES: usize = 100_000;
const MAX_RESPONSE_BYTES: usize = 1_048_576;

#[cfg(windows)]
fn api_key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|_| "无法访问 Windows 凭据管理器。".to_string())
}

#[tauri::command]
fn has_api_key() -> Result<bool, String> {
    #[cfg(windows)]
    {
        return match api_key_entry()?.get_password() {
            Ok(_) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(_) => Err("读取 Windows 凭据失败。".to_string()),
        };
    }

    #[cfg(not(windows))]
    Err("API 密钥安全存储目前仅支持 Windows。".to_string())
}

#[tauri::command]
fn save_api_key(api_key: String) -> Result<(), String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("API 密钥不能为空。".to_string());
    }
    if api_key.len() > 4_096 {
        return Err("API 密钥长度超出限制。".to_string());
    }

    #[cfg(windows)]
    {
        return api_key_entry()?
            .set_password(api_key)
            .map_err(|_| "无法将 API 密钥保存到 Windows 凭据管理器。".to_string());
    }

    #[cfg(not(windows))]
    Err("API 密钥安全存储目前仅支持 Windows。".to_string())
}

#[tauri::command]
fn delete_api_key() -> Result<(), String> {
    #[cfg(windows)]
    {
        let entry = api_key_entry()?;
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("无法从 Windows 凭据管理器删除 API 密钥。".to_string()),
        };
    }

    #[cfg(not(windows))]
    Err("API 密钥安全存储目前仅支持 Windows。".to_string())
}

#[tauri::command]
async fn generate_mindmap(
    base_url: String,
    model: String,
    prompt: String,
) -> Result<String, String> {
    let prompt = prompt.trim();
    let model = model.trim();
    if prompt.is_empty() {
        return Err("先写下你想整理的主题或内容。".to_string());
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!("提示词最多 {} 个字符。", MAX_PROMPT_CHARS));
    }
    if model.is_empty() || model.len() > 200 {
        return Err("请填写有效的模型名称。".to_string());
    }

    let api_key = {
        #[cfg(windows)]
        {
            match api_key_entry()?.get_password() {
                Ok(key) => key,
                Err(keyring::Error::NoEntry) => {
                    return Err("请先在模型设置中保存 API 密钥。".to_string());
                }
                Err(_) => return Err("读取 Windows 凭据失败。".to_string()),
            }
        }
        #[cfg(not(windows))]
        {
            return Err("API 密钥安全存储目前仅支持 Windows。".to_string());
        }
    };

    let url = completion_url(&base_url)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化 AI 网络连接。".to_string())?;

    let request_body = serde_json::json!({
        "model": model,
        "stream": false,
        "messages": [
            {
                "role": "system",
                "content": "你是思维导图编辑助手。根据用户内容输出结构清楚的 Markdown 思维导图。只输出 Markdown，不要代码围栏、说明文字或 HTML。第一行必须是唯一的一级标题（#），下面用二级/三级标题和列表组织层级；保留关键事实，避免重复，内容具体、简洁。"
            },
            { "role": "user", "content": prompt }
        ]
    });

    let response = client
        .post(url)
        .bearer_auth(api_key)
        .json(&request_body)
        .send()
        .await
        .map_err(|_| "连接 AI 服务失败，请检查网络和 API 地址。".to_string())?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "AI 服务返回 HTTP {}，请检查 API 地址、密钥和模型名称。",
            status.as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("AI 服务返回内容过大，请重试或缩小主题范围。".to_string());
    }

    let mut response = response;
    let mut response_bytes = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or(0)
            .min(MAX_RESPONSE_BYTES as u64) as usize,
    );
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "读取 AI 服务响应失败。".to_string())?
    {
        if response_bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("AI 服务返回内容过大，请重试或缩小主题范围。".to_string());
        }
        response_bytes.extend_from_slice(&chunk);
    }
    let body: serde_json::Value = serde_json::from_slice(&response_bytes)
        .map_err(|_| "AI 服务返回的内容不是有效 JSON。".to_string())?;
    let content = body
        .pointer("/choices/0/message/content")
        .and_then(|value| {
            value.as_str().map(str::to_string).or_else(|| {
                value.as_array().map(|parts| {
                    parts
                        .iter()
                        .filter_map(|part| part.get("text").and_then(serde_json::Value::as_str))
                        .collect::<Vec<_>>()
                        .join("")
                })
            })
        })
        .filter(|content| !content.is_empty())
        .ok_or_else(|| "AI 服务没有返回可用的 Markdown 内容。".to_string())?;

    normalize_generated_markdown(&content)
}

fn completion_url(base_url: &str) -> Result<url::Url, String> {
    let mut endpoint =
        url::Url::parse(base_url.trim()).map_err(|_| "API 地址格式不正确。".to_string())?;
    let host = endpoint
        .host_str()
        .ok_or_else(|| "API 地址必须包含主机名。".to_string())?;
    let is_loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false);

    if endpoint.scheme() != "https" && !(endpoint.scheme() == "http" && is_loopback) {
        return Err("API 地址必须使用 HTTPS；仅 localhost 可使用 HTTP。".to_string());
    }
    if !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        return Err("API 地址不能包含账号、密钥、查询参数或片段。".to_string());
    }

    let path = endpoint.path().trim_end_matches('/').to_string();
    if !path.ends_with("/chat/completions") {
        endpoint.set_path(&format!("{path}/chat/completions"));
    } else if endpoint.path() != path {
        endpoint.set_path(&path);
    }
    Ok(endpoint)
}

fn normalize_generated_markdown(content: &str) -> Result<String, String> {
    let mut markdown = content.trim().replace("\r\n", "\n");
    if markdown.starts_with("```") && markdown.ends_with("```") {
        if let Some(line_end) = markdown.find('\n') {
            markdown = markdown[line_end + 1..markdown.len() - 3]
                .trim()
                .to_string();
        }
    }
    if markdown.is_empty() {
        return Err("AI 返回了空内容，请调整提示词后重试。".to_string());
    }
    if markdown.len() > MAX_MARKDOWN_BYTES {
        return Err("AI 返回内容过长，请缩小主题范围后重试。".to_string());
    }
    let has_title = markdown.lines().any(|line| {
        let line = line.trim_start();
        line.starts_with("# ") || line.starts_with("## ")
    });
    if !has_title {
        return Err("AI 返回内容缺少 Markdown 标题，请重试。".to_string());
    }
    Ok(markdown)
}
