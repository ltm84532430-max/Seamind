use axum::{
    extract::{DefaultBodyLimit, Json, State as AxumState},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
    Router,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write,
    net::TcpListener as StdTcpListener,
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;
use uuid::Uuid;

const MAX_MCP_BODY_BYTES: usize = 512 * 1024;
const MAX_MCP_TOOLS: usize = 16;
const MCP_CALL_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Default, Clone)]
pub struct AgentBridgeState(Arc<Mutex<BridgeInner>>);

#[derive(Default)]
struct BridgeInner {
    endpoint: Option<String>,
    token: Option<String>,
    tools: Vec<Value>,
    pending: HashMap<String, oneshot::Sender<BridgeResolution>>,
}

#[derive(Clone)]
struct HttpContext {
    app: AppHandle,
    bridge: AgentBridgeState,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliToolRequest {
    request_id: String,
    name: String,
    arguments: Value,
}

pub struct BridgeResolution {
    pub result: Value,
    pub error: Option<String>,
}

impl AgentBridgeState {
    pub fn start(&self, app: AppHandle) -> Result<(), String> {
        let listener = StdTcpListener::bind(("127.0.0.1", 0))
            .map_err(|_| "无法启动 Seamind 本地 MCP 服务。".to_string())?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "无法配置 Seamind 本地 MCP 服务。".to_string())?;
        let address = listener
            .local_addr()
            .map_err(|_| "无法读取 Seamind 本地 MCP 服务地址。".to_string())?;
        let endpoint = format!("http://{address}/mcp");
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        {
            let mut inner = self
                .0
                .lock()
                .map_err(|_| "Seamind MCP 状态不可用。".to_string())?;
            inner.endpoint = Some(endpoint);
            inner.token = Some(token);
        }

        let context = HttpContext {
            app,
            bridge: self.clone(),
        };
        thread::Builder::new()
            .name("seamind-mcp-http".to_string())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        eprintln!("Seamind MCP runtime could not start: {error}");
                        return;
                    }
                };
                runtime.block_on(async move {
                    let listener = match tokio::net::TcpListener::from_std(listener) {
                        Ok(listener) => listener,
                        Err(error) => {
                            eprintln!("Seamind MCP listener could not start: {error}");
                            return;
                        }
                    };
                    let router = Router::new()
                        .route("/mcp", post(handle_mcp))
                        .layer(DefaultBodyLimit::max(MAX_MCP_BODY_BYTES))
                        .with_state(context);
                    if let Err(error) = axum::serve(listener, router).await {
                        eprintln!("Seamind MCP server stopped: {error}");
                    }
                });
            })
            .map_err(|_| "无法启动 Seamind MCP 服务线程。".to_string())?;
        Ok(())
    }

    pub fn set_tools(&self, tools: Vec<Value>) -> Result<(), String> {
        if tools.len() > MAX_MCP_TOOLS {
            return Err("MCP 工具数量超过上限。".to_string());
        }
        let encoded = serde_json::to_vec(&tools).map_err(|_| "MCP 工具定义无效。".to_string())?;
        if encoded.len() > MAX_MCP_BODY_BYTES {
            return Err("MCP 工具定义超过大小上限。".to_string());
        }
        self.0
            .lock()
            .map_err(|_| "Seamind MCP 状态不可用。".to_string())?
            .tools = tools;
        Ok(())
    }

    fn tools(&self) -> Result<Vec<Value>, String> {
        Ok(self
            .0
            .lock()
            .map_err(|_| "Seamind MCP 状态不可用。".to_string())?
            .tools
            .clone())
    }

    fn credentials(&self) -> Result<(String, String), String> {
        let inner = self
            .0
            .lock()
            .map_err(|_| "Seamind MCP 状态不可用。".to_string())?;
        Ok((
            inner
                .endpoint
                .clone()
                .ok_or_else(|| "Seamind MCP 服务尚未就绪。".to_string())?,
            inner
                .token
                .clone()
                .ok_or_else(|| "Seamind MCP 服务尚未就绪。".to_string())?,
        ))
    }

    fn insert_pending(
        &self,
        id: String,
        sender: oneshot::Sender<BridgeResolution>,
    ) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "Seamind MCP 状态不可用。".to_string())?
            .pending
            .insert(id, sender);
        Ok(())
    }

    fn remove_pending(&self, id: &str) {
        if let Ok(mut inner) = self.0.lock() {
            inner.pending.remove(id);
        }
    }

    pub fn create_cli_config(&self) -> Result<PathBuf, String> {
        let (endpoint, token) = self.credentials()?;
        let path = std::env::temp_dir().join(format!("seamind-mcp-{}.json", Uuid::new_v4()));
        let config = json!({
            "mcpServers": {
                "seamind": {
                    "type": "http",
                    "url": endpoint,
                    "headers": { "Authorization": format!("Bearer {token}") }
                }
            }
        });
        let bytes =
            serde_json::to_vec(&config).map_err(|_| "无法生成 Claude MCP 配置。".to_string())?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| "无法创建 Claude MCP 临时配置。".to_string())?;
        if file.write_all(&bytes).is_err() {
            let _ = std::fs::remove_file(&path);
            return Err("无法写入 Claude MCP 临时配置。".to_string());
        }
        Ok(path)
    }

    async fn request_tool(
        &self,
        app: &AppHandle,
        name: String,
        arguments: Value,
    ) -> BridgeResolution {
        let request_id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        if let Err(error) = self.insert_pending(request_id.clone(), sender) {
            return BridgeResolution {
                result: json!({}),
                error: Some(error),
            };
        }
        if app
            .emit(
                "seamind-cli-tool-request",
                CliToolRequest {
                    request_id: request_id.clone(),
                    name,
                    arguments,
                },
            )
            .is_err()
        {
            self.remove_pending(&request_id);
            return BridgeResolution {
                result: json!({}),
                error: Some("Seamind 界面暂时无法接收 CLI 工具请求。".to_string()),
            };
        }
        match tokio::time::timeout(MCP_CALL_TIMEOUT, receiver).await {
            Ok(Ok(resolution)) => resolution,
            Ok(Err(_)) => {
                self.remove_pending(&request_id);
                BridgeResolution {
                    result: json!({}),
                    error: Some("Seamind 界面已关闭，工具请求没有完成。".to_string()),
                }
            }
            Err(_) => {
                self.remove_pending(&request_id);
                BridgeResolution {
                    result: json!({}),
                    error: Some("等待 Seamind 处理 CLI 工具请求超时。".to_string()),
                }
            }
        }
    }
}

#[tauri::command]
pub fn agent_bridge_set_tools(
    state: State<'_, AgentBridgeState>,
    tools: Vec<Value>,
) -> Result<(), String> {
    state.set_tools(tools)
}

#[tauri::command]
pub fn agent_bridge_resolve(
    state: State<'_, AgentBridgeState>,
    request_id: String,
    result: Value,
    error: Option<String>,
) -> Result<(), String> {
    let sender = state
        .0
        .lock()
        .map_err(|_| "Seamind MCP 状态不可用。".to_string())?
        .pending
        .remove(&request_id)
        .ok_or_else(|| "MCP 工具请求已结束或超时。".to_string())?;
    let _ = sender.send(BridgeResolution { result, error });
    Ok(())
}

async fn handle_mcp(
    AxumState(context): AxumState<HttpContext>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    if body.to_string().len() > MAX_MCP_BODY_BYTES {
        return mcp_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            Value::Null,
            -32600,
            "请求超过大小上限。",
        );
    }
    let expected = match context.bridge.credentials() {
        Ok((_, token)) => format!("Bearer {token}"),
        Err(error) => {
            return mcp_error(StatusCode::SERVICE_UNAVAILABLE, Value::Null, -32603, &error)
        }
    };
    let supplied = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if supplied != expected {
        return mcp_error(
            StatusCode::UNAUTHORIZED,
            Value::Null,
            -32001,
            "MCP 授权失败。",
        );
    }
    if let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        if !origin.starts_with("http://127.0.0.1:") && !origin.starts_with("http://localhost:") {
            return mcp_error(
                StatusCode::FORBIDDEN,
                Value::Null,
                -32002,
                "拒绝非本机 MCP 请求。",
            );
        }
    }

    let id = body.get("id").cloned().unwrap_or(Value::Null);
    let method = body
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if body.get("jsonrpc").and_then(Value::as_str) != Some("2.0") || method.is_empty() {
        return mcp_error(
            StatusCode::BAD_REQUEST,
            id,
            -32600,
            "无效的 JSON-RPC 请求。",
        );
    }
    if method.starts_with("notifications/") && body.get("id").is_none() {
        return (StatusCode::ACCEPTED, axum::Json(Value::Null));
    }

    let result = match method {
        "initialize" => {
            let requested = body
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2025-03-26");
            json!({
                "protocolVersion": requested,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "seamind", "version": "0.1.0" },
                "instructions": "读取和搜索是只读操作。导图修改会回到 Seamind 应用中展示预览，并等待用户确认后才会应用。"
            })
        }
        "ping" => json!({}),
        "tools/list" => match context.bridge.tools() {
            Ok(tools) => json!({ "tools": tools }),
            Err(error) => return mcp_error(StatusCode::SERVICE_UNAVAILABLE, id, -32603, &error),
        },
        "tools/call" => {
            let params = body.get("params").cloned().unwrap_or(Value::Null);
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return mcp_error(StatusCode::BAD_REQUEST, id, -32602, "缺少工具名称。");
            };
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let resolution = context
                .bridge
                .request_tool(&context.app, name.to_string(), arguments)
                .await;
            match resolution.error {
                Some(error) => {
                    json!({ "content": [{ "type": "text", "text": error }], "isError": true })
                }
                None => resolution.result,
            }
        }
        _ => return mcp_error(StatusCode::OK, id, -32601, "不支持的 MCP 方法。"),
    };

    (
        StatusCode::OK,
        axum::Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })),
    )
}

fn mcp_error(
    status: StatusCode,
    id: Value,
    code: i64,
    message: &str,
) -> (StatusCode, axum::Json<Value>) {
    (
        status,
        axum::Json(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message }
        })),
    )
}
