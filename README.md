# 海洋之心（Seamind）

Seamind 是一个本地优先的 Windows 学习与知识工作台。它以 Markdown 思维导图为核心，把写作、阅读、视频学习、文献整理和任务跟进放在同一个桌面应用中。

导图和笔记是普通 Markdown 文件；应用索引、阅读进度、播放器记录等状态保存在本机。联网功能会按用途访问 YouTube、RSS 源、文献服务或你配置的 AI 接口，具体范围见[本地数据与隐私](#本地数据与隐私)。

当前版本为 `0.1.0`，项目仍在开发中。目前只在 Windows 10/11 上开发和检查。

## 功能

### 思考、写作与文档

- 用 Markdown 实时生成可缩放、可折叠的思维导图。双击节点编辑，按 Enter 添加同级节点，按 Tab 添加子节点；导图内容保存为 Markdown。
- 在文档工作台中编辑和预览 Markdown，也可以切换为导图方式查看文档。
- 支持 KaTeX 数学公式、ECharts、Mermaid、Pele 和 PlantUML 代码块。PlantUML 在本机通过 Java 渲染；Pele 使用 Mermaid 语法生成 SVG。

### 电子书与知识库

- 导入 EPUB 阅读，记录阅读进度、书签和批注；可以从书籍内容建立章节知识图谱和思维导图。
- 按书管理试卷、作答和掌握度自评。配置 AI 模型后，可以使用依赖模型的翻译、试题生成等功能。
- 管理本地 Markdown 笔记，按分类浏览和搜索，预览公式，并从导图或其他工作区打开笔记。

### YouTube 视频学习

- 订阅频道、查看新视频、管理观看历史、收藏、收藏分类和课程，也可以把视频整理成学习路径。
- 查看和搜索字幕，使用双语对照、逐句循环和跟读；可把带时间戳的字幕整理到知识库。
- 播放器支持内嵌播放、Seamind 内置播放，以及可选的 yt-dlp 和 mpv/ffplay 外部播放。鼠标停在音量控件上滚动滚轮可调节音量。

### 信息整理与任务

- 阅读 RSS/Atom 订阅，支持 OPML 导入、文章阅读和导图导出。
- 在文献工作区按 DOI 或 arXiv 信息查找和整理论文，导入/导出 BibTeX，并阅读 PDF；arXiv PDF 可从工作区获取。
- 用任务工作区和日历跟进计划、截止日期和学习资源；完成的任务可以归档，学习计划可导入任务列表。

### AI 与终端

- AI 功能使用可配置的 OpenAI 兼容 Chat Completions 接口，可用于导图生成及部分阅读、试题和学习计划流程。是否可用取决于所配置的模型和服务。
- 内置终端在 Windows 下运行 PowerShell。

## 系统要求

| 组件 | 要求 | 用途 |
| --- | --- | --- |
| Windows | Windows 10/11，x64 | 当前开发和支持目标 |
| WebView2 | WebView2 Runtime | Tauri 桌面界面；大多数 Windows 系统已包含，缺少时从 [Microsoft 官网](https://developer.microsoft.com/microsoft-edge/webview2/) 安装 |
| Node.js | 22 或更高 | 前端构建和开发工具 |
| pnpm | 9.15.9 | 通过 Corepack 固定版本，命令见下方 |
| Rust | stable，`x86_64-pc-windows-msvc` | 编译 Tauri 后端 |
| C++ 工具链 | Visual Studio 2022 Build Tools 的“使用 C++ 的桌面开发”工作负载和 Windows SDK | Rust MSVC 与 Tauri 构建需要 |
| Git | 支持 submodule | 获取 `packages/foliate-js` EPUB 渲染依赖 |

以下组件按需安装：

- **Java 11 或更高版本**：渲染 PlantUML。安装后重启应用。
- **Graphviz**：可选。安装后 PlantUML 可使用 Graphviz 布局；没有时使用内置的 Smetana 布局。
- **yt-dlp**：用于“本地解析”和 mpv 外部播放；内嵌播放器和内置播放器不依赖它。使用 JavaScript 挑战时还需要 Node.js。
- **mpv 或 ffplay**：用于外部播放。若视频音轨和画面分离，还需要 ffmpeg。

## 获取与启动

在 PowerShell 中克隆仓库并启动桌面开发版：

```powershell
git clone --recurse-submodules https://github.com/ltm84532430-max/Seamind.git
cd Seamind
corepack pnpm@9.15.9 install --frozen-lockfile
corepack pnpm@9.15.9 --filter @markmap/desktop tauri dev
```

`--recurse-submodules` 会初始化 `packages/foliate-js`。如果仓库已经克隆，补齐 submodule 的命令是：

```powershell
git submodule update --init --recursive
```

首次启动需要编译 Rust 后端，通常会比后续启动慢。开发服务器固定监听 `http://127.0.0.1:1420`；端口被占用时会直接报错。

打包 Windows 安装程序：

```powershell
corepack pnpm@9.15.9 --filter @markmap/desktop tauri build
```

Tauri 将打包产物写入 `apps/desktop/src-tauri/target/release/bundle/`。

## 配置

### AI 模型

1. 打开应用的**模型设置**，填写 OpenAI 兼容 Chat Completions 服务的 Base URL 和模型名称。初始值为 `https://api.openai.com/v1` 和 `gpt-4o-mini`。
2. 填入 API 密钥并保存。应用会把密钥保存在当前 Windows 用户的凭据管理器中，凭据服务名为 `com.markmap.desktop`。

服务地址必须使用 HTTPS；只有 `localhost` 或回环地址（例如本机 Ollama）可以使用 HTTP。Base URL 和模型名称保存在应用的本地 WebView 存储中。AI 服务会收到你提交的提示词和相应功能所需的文本内容；请先确认服务方的数据处理方式。

### 文件库

- 默认文件库目录为“文档\Markmap Library”。可在**文件库**面板中更改。
- 导图和笔记保存在所选目录下，属于普通 Markdown 文件，可自行备份、移动或用其他编辑器打开。
- 文件库目录被移动或删除时，应用会要求重新选择，不会自动切到空目录。索引异常时，可在文件库面板中重建索引。

### YouTube、代理与外部播放器

- 默认使用 YouTube 内嵌播放器。遇到错误或 15 秒内未连接时，应用会尝试改用内置播放器；也可以在**播放诊断与设置**中设置优先播放方式。
- 网络需要代理时，在**播放诊断与设置**里填写代理地址。支持 `http`、`https`、`socks5` 和 `socks5h`，地址不能包含用户名或密码。保存后重启应用，使内嵌播放器使用新设置。
- 可在同一面板安装/更新 yt-dlp。应用从 yt-dlp 官方发布页下载，并校验 `SHA2-256SUMS`，默认保存到 `%LOCALAPPDATA%\Seamind\tools`。也可通过 `SEAMIND_YT_DLP_PATH` 指定已有文件。
- 通过 `SEAMIND_MPV_PATH` 指定 mpv 程序路径；未指定时从 PATH 查找。没有 mpv 时外部播放会尝试使用 ffplay。
- **测试连通性**会分别检查内嵌播放器、应用后端、视频服务器和当前视频解析，帮助定位网络问题。

播放 YouTube 需要访问 YouTube 网络服务。需要登录的视频（如年龄限制、会员专享或私享视频）目前不支持。Seamind 不保存或发送 YouTube Cookie。

### 高级环境变量

普通使用不需要配置环境变量。播放器开发和排错用到的变量见[桌面端开发说明](apps/desktop/README.md#环境变量)，包括 `SEAMIND_MPV_PATH`、`SEAMIND_YT_DLP_PATH`、`SEAMIND_NEWPIPE_BRIDGE` 和仅调试构建生效的数据库覆盖选项。

## 本地数据与隐私

Markdown 文件库由你选择存放位置；应用状态和索引存放在当前 Windows 用户的应用数据目录。常见位置如下：

| 数据 | 默认位置 |
| --- | --- |
| 文件库目录 | `文档\Markmap Library` |
| 文件库目录配置 | `%APPDATA%\com.markmap.desktop\library.json` |
| 文件库搜索索引 | `%LOCALAPPDATA%\com.markmap.desktop\library-index.sqlite3` |
| 文档历史版本 | `%LOCALAPPDATA%\com.markmap.desktop\document-history.sqlite3` |
| RSS 订阅 | `%LOCALAPPDATA%\com.markmap.desktop\feed.sqlite3` |
| 文献记录 | `%LOCALAPPDATA%\com.markmap.desktop\literature.sqlite3` |
| 任务数据 | `%LOCALAPPDATA%\com.markmap.desktop\learning-tasks.sqlite3` |
| 播放器数据 | `%LOCALAPPDATA%\com.markmap.desktop\player.sqlite3` |
| EPUB 和试卷记录 | `%APPDATA%\com.markmap.desktop\` 下的应用数据文件 |
| 播放器工具、代理设置和缓存 | `%LOCALAPPDATA%\Seamind\` |
| AI API 密钥 | Windows 凭据管理器，服务名 `com.markmap.desktop` |

本地优先不代表完全离线：RSS 更新、YouTube、DOI/arXiv 查询和 PDF 下载需要网络；使用 AI 时，相关输入会发往你配置的服务。API 密钥、代理凭据、Cookie 和个人数据库不要提交到 Git。AI 密钥通过应用设置保存，不需要写入 `.env`。

## 开发与检查

在仓库根目录运行：

```powershell
corepack pnpm@9.15.9 -r build:types
corepack pnpm@9.15.9 -r build:js
corepack pnpm@9.15.9 lint
corepack pnpm@9.15.9 test
corepack pnpm@9.15.9 --filter @markmap/desktop exec tsc --noEmit -p tsconfig.json
node --test apps/desktop/tests/*.test.mjs
```

Rust 后端检查和测试：

```powershell
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
```

GitHub Actions 会在 `main` 推送和拉取请求上运行前端工作区检查，以及 Windows 上的 Rust 检查和测试。安装依赖时会配置 Husky Git 钩子；推送前钩子会运行 lint。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `apps/desktop` | Tauri 2 桌面应用；React 19 + Vite 前端和 Rust 后端 |
| `packages/markmap-common` | Markmap 共享工具 |
| `packages/markmap-html-parser` | HTML 大纲解析为导图节点 |
| `packages/markmap-lib` | Markdown 转换为导图数据 |
| `packages/markmap-view` | 导图 SVG 渲染 |
| `packages/foliate-js` | EPUB 渲染 submodule |
| `docs/` | 功能和技术说明 |
| `adr/` | 架构决策记录 |
| `demo/` | 示例 Markdown 文件 |

桌面端代码结构和环境变量见[apps/desktop/README.md](apps/desktop/README.md)。

## 进一步阅读

- [文档工作台与 Pele 图表](docs/document-workbench.md)
- [数学可视化代码块](docs/math-visualization.md)
- [PlantUML 围栏与图形编辑](docs/plantuml-gui.md)
- [Pele Mermaid 图表](docs/pele-diagrams.md)
- [YouTube 播放方式、代理与故障排查](docs/youtube-playback.md)
- [播放器页面：订阅、动态、收藏与课程](docs/youtube-player-page.md)
- [技术细节：架构、IPC 接口与数据模型](docs/技术细节.md)

## 当前边界

- 项目目前只在 Windows 10/11 上开发和检查，其他系统暂不承诺可用。
- YouTube 的接口和播放协议可能变化；可用性受网络、代理和地区影响。请遵守 YouTube 服务条款。
- PlantUML、yt-dlp、mpv/ffplay 是按功能需要安装的可选组件；基础导图和文档编辑不依赖它们。
- AI 功能需要用户自行配置可用的接口、模型和 API 密钥，相关服务可能按其政策计费。

## 许可证与致谢

- 本项目以 [MIT 许可证](LICENSE) 发布。
- `packages/markmap-*` 来自 [markmap](https://github.com/markmap/markmap)，原始版权声明保留在 [LICENSE](LICENSE) 中。
- `packages/foliate-js` 是 [readest/foliate-js](https://github.com/readest/foliate-js) 的 Git submodule，遵循其 MIT 许可证。
- `apps/desktop/src/youtube-sabr-shaka-adapter.ts` 改编自 [LuanRT/googlevideo](https://github.com/LuanRT/googlevideo)（MIT），声明见 [NOTICE](apps/desktop/src/youtube-sabr-shaka-adapter.NOTICE.md)。
- PlantUML 随应用打包，许可证见 [LICENSE.txt](apps/desktop/src-tauri/resources/plantuml/LICENSE.txt)。
