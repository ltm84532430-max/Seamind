# Seamind

Seamind 是一个本地优先的 Windows 桌面应用。用 Markdown 写思维导图，并把导图、文档、电子书、YouTube 学习视频和本地知识库放在同一个工作台里。

项目目前是早期版本（0.1.0），只在 Windows 上开发和测试。

## 功能

- **导图**：Markdown 实时渲染成可缩放、可折叠的思维导图。双击节点编辑，回车添加同级节点，Tab 添加子节点。
- **图表与公式**：数学公式（KaTeX）、ECharts、PlantUML 围栏（由本机 Java 渲染）、Mermaid 代码块（浏览器内渲染），以及 Pele 图表（`pele` 代码块和 `.mmd` 文件，使用 Mermaid 语法，由 Pele 渲染为 SVG）。
- **文档**：Markdown 文档工作台，左边编辑、右边预览。文档可以按导图查看，也可以转成导图。
- **电子书**：导入 EPUB 阅读（基于 foliate-js），可以为书籍生成导图。试卷库按书整理试卷，记录作答和自评。
- **播放器**：YouTube 订阅、新视频动态、收藏和课程，数据保存在本机数据库。
- **知识库**：本地 Markdown 笔记的列表、搜索、新建和删除，支持公式预览，并可以在导图中打开。
- **AI 生成**：通过 OpenAI 兼容的 Chat Completions 接口，从一句话生成 Markdown 导图。
- **终端**：内置终端，Windows 下运行 PowerShell。

## 系统要求

| 组件 | 要求 | 说明 |
| --- | --- | --- |
| 系统 | Windows 10/11 | API 密钥保存在 Windows 凭据管理器中 |
| WebView2 | 运行时 | 大多数系统已自带；没有时从 [Microsoft 官网](https://developer.microsoft.com/microsoft-edge/webview2/) 安装 |
| Node.js | 22 或更高 | 启用 corepack：`corepack enable` |
| Rust | 稳定版，MSVC 工具链 | 需要 Visual Studio 的 C++ 生成工具，这是 Tauri 2 的要求 |
| Git | 支持 submodule | 克隆时需要 `--recurse-submodules` |
| Java | 11 或更高 | 仅 PlantUML 需要，未安装时其他功能不受影响 |
| Graphviz | 可选 | 安装后 PlantUML 使用 Graphviz 布局；没有时使用内置的 smetana 布局 |
| yt-dlp | 可选 | 仅"本地解析"需要。yt-dlp 还需要系统里有 Node.js，用于 JavaScript 挑战 |
| mpv 或 ffplay | 可选 | 仅"用 mpv 外部播放"需要；没有 mpv 时回退到 ffplay。分离的音视频还需要 ffmpeg |

## 快速开始

```powershell
git clone --recurse-submodules https://github.com/ltm84532430-max/Seamind.git
cd Seamind
corepack pnpm@9.15.9 install
corepack pnpm@9.15.9 --filter @markmap/desktop tauri dev
```

- `--recurse-submodules` 不能省略，`packages/foliate-js`（EPUB 渲染）是 submodule。已经 clone 过的仓库，运行 `git submodule update --init`。
- 第一次运行要编译 Rust 代码，耗时较长。窗口第一次加载也比较慢，可能先空白一段时间，属于正常现象。
- `pnpm install` 会安装 Git 钩子，说明见 [开发与检查](#开发与检查)。

## 配置

### AI 模型

1. 打开 **模型设置**，填入 Chat Completions 接口的地址（Base URL）和模型名称。默认值是 OpenAI 的 `https://api.openai.com/v1` 和 `gpt-4o-mini`。
2. 填入 API 密钥并保存。

- 接口地址必须使用 HTTPS。只有 `localhost` 和回环地址（例如本机的 Ollama）可以使用 HTTP。
- API 密钥保存在当前 Windows 用户的凭据管理器中，服务名为 `com.markmap.desktop`。前端只知道密钥是否已保存，看不到密钥本身。
- 接口地址和模型名称保存在应用的本地 WebView 存储中。

### 文件库

- 默认位置是 `文档\Markmap Library`。在 **文件库** 面板里点 **更改** 可以选择其他文件夹。
- 导图和笔记都是普通的 Markdown 文件，可以备份、移动，或用其他编辑器打开。
- 如果已配置的文件夹被移动或删除，应用会提示重新选择，不会悄悄切换到一个空库。
- 搜索索引出现异常时，在 **文件库** 面板里点 **重建索引**，会从 Markdown 文件重新生成。

### YouTube 播放

默认先使用 **YouTube 内嵌播放器**。内嵌播放器报错或 15 秒内没有连上时，窗口会自动改用 **内置播放器**。内置播放器由 Seamind 直接取流，不需要额外程序。

- **代理**：网络需要代理时，在 **播放诊断与设置** 里填写代理地址，例如 `http://127.0.0.1:7890` 或 `socks5://127.0.0.1:7891`。支持 `http`、`https`、`socks5` 和 `socks5h`，不能包含账号密码。保存后需要重启应用，内嵌播放器才会使用新代理。
- **yt-dlp**：只有"本地解析"和"用 mpv 外部播放"需要它。在 **播放诊断与设置** 里点 **安装 / 更新 yt-dlp**，应用会从 yt-dlp 的官方发布页下载 `yt-dlp.exe`，用发布页的 `SHA2-256SUMS` 校验后保存到 `%LOCALAPPDATA%\Seamind\tools`。也可以自己安装并放进系统 PATH，或用 `SEAMIND_YT_DLP_PATH` 指定路径。
- **mpv / ffplay**：用 `SEAMIND_MPV_PATH` 指定 mpv 的路径，否则从 PATH 中查找。
- **默认播放方式**：在 **播放诊断与设置** 里可以勾选 **打开视频时优先使用内置播放器**。
- **连通性**：**测试连通性** 会分层检查内嵌播放器的网络、应用后端到 YouTube 的连接、应用后端到视频服务器的连接，以及当前视频能否解析，帮助定位问题。

### PlantUML

PlantUML 围栏需要 Java 11 或更高版本。应用会依次查找 `JAVA_HOME`、PATH 和常见的安装目录。安装 Java 后需要重启 Seamind。

### 数据位置

| 内容 | 位置 |
| --- | --- |
| 文件库位置 | `%APPDATA%\com.markmap.desktop\library.json` |
| 文件库搜索索引 | `%LOCALAPPDATA%\com.markmap.desktop\library-index.sqlite3` |
| 文档历史版本 | `%LOCALAPPDATA%\com.markmap.desktop\document-history.sqlite3` |
| 播放器数据 | `%LOCALAPPDATA%\com.markmap.desktop\player.sqlite3` |
| 电子书和试卷记录 | `%APPDATA%\com.markmap.desktop\` 下的子目录，每本书一个 JSON 文件 |
| YouTube 代理设置、yt-dlp、播放器缓存 | `%LOCALAPPDATA%\Seamind\` |
| API 密钥 | Windows 凭据管理器，服务名 `com.markmap.desktop` |

## 使用说明

**写导图**：在 **文件库** 面板里新建 Markdown 导图。左边写 Markdown，右边实时渲染成思维导图，标题和列表会变成节点。直接双击导图上的节点编辑，回车添加同级节点，Tab 添加子节点。导图的修改会同步回 Markdown 源文本。

**整理文件**：文件夹就是分类，可以新建多级分类。修改标题会重命名文件，修改分类会把文件移到对应文件夹。搜索覆盖标题、分类、类型、标签和正文。

**AI 生成**：先配置模型（见上文），然后在 **文件库** 面板的新建菜单中选择 **AI 智能构图**，输入一句话，生成的 Markdown 会进入编辑器。

**电子书**：导入 EPUB 后可以阅读，也可以为书籍生成导图。试卷库按书整理试卷，记录每次作答，并自评掌握程度。

**YouTube**：点击导图里的 YouTube 卡片会打开播放窗口。播放器页面可以订阅频道、查看新视频、收藏视频和组织课程。

## 开发与检查

```powershell
corepack pnpm@9.15.9 -r build:types                                    # 先构建各包的类型声明
corepack pnpm@9.15.9 lint                                              # ESLint 与 Prettier
corepack pnpm@9.15.9 test                                              # packages/* 的测试
corepack pnpm@9.15.9 --filter @markmap/desktop exec tsc --noEmit -p tsconfig.json
corepack pnpm@9.15.9 --filter @markmap/desktop exec vitest run test/   # 桌面端前端测试
node --test apps/desktop/tests/*.test.mjs                              # 桌面端脚本测试
```

- CI（`.github/workflows/ci.yml`）会在推送到 `main` 和每个拉取请求上运行这些检查。
- `pnpm install` 会通过 husky 安装 Git 钩子：提交时，对暂存的 `.ts`、`.tsx` 和 `.css` 文件运行 lint-staged；推送前运行 `npm run lint`。
- 打包安装程序：`corepack pnpm@9.15.9 --filter @markmap/desktop tauri build`。Tauri 默认把产物输出到 `apps/desktop/src-tauri/target/release/bundle/`。
- Rust 后端的测试在 `apps/desktop/src-tauri` 下运行 `cargo test --lib`。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `apps/desktop` | 桌面端：React 19 + Vite 前端；`src-tauri` 是 Tauri 2（Rust）后端 |
| `packages/markmap-common` | 共享工具 |
| `packages/markmap-html-parser` | 把 HTML 大纲转换成导图节点树 |
| `packages/markmap-lib` | Markdown 转导图数据 |
| `packages/markmap-view` | 导图的 SVG 渲染 |
| `packages/foliate-js` | EPUB 渲染（git submodule） |
| `docs/` | 功能与技术文档 |
| `adr/` | 架构决策记录 |
| `demo/` | 示例 Markdown |

桌面端的开发细节见 [apps/desktop/README.md](apps/desktop/README.md)。

## 文档

- [文档工作台与 Pele 图表](docs/document-workbench.md)
- [PlantUML 围栏与图形编辑](docs/plantuml-gui.md)
- [数学可视化代码块](docs/math-visualization.md)
- [Pele Mermaid 图表](docs/pele-diagrams.md)
- [YouTube 播放方式、代理与失败排查](docs/youtube-playback.md)
- [播放器页面：订阅、动态、收藏与课程](docs/youtube-player-page.md)
- [技术细节：架构、IPC 接口与数据模型](docs/技术细节.md)

## 故障排查

- **窗口空白或加载很慢**：第一次启动较慢，等一会儿。仍然没有内容时，检查 WebView2 运行时是否已安装。
- **PlantUML 不渲染**：在终端运行 `java -version`，确认版本是 11 或更高。修改 `JAVA_HOME` 或 PATH 后重启 Seamind。
- **YouTube 无法播放**：播放窗口会给出失败原因。机器人验证或网络错误时，检查代理设置，必要时换一个代理节点。需要登录的视频（年龄限制、会员专享、私享）目前不支持。完整的分类和处理方式见 [docs/youtube-playback.md](docs/youtube-playback.md)。
- **提示找不到文件库目录**：目录被移动或删除了，在 **文件库** 面板里重新选择即可。

## 注意

- 播放器依赖 YouTube 的网络接口和流媒体协议，YouTube 的变化可能导致播放失败。请遵守 YouTube 的服务条款。
- Seamind 不保存也不发送 YouTube 的 Cookie。
- AI 生成需要你自己的 API 密钥和接口地址。
- 项目只在 Windows 上开发和测试，其他系统不保证可用。

## 许可证与致谢

- 本项目以 [MIT 许可证](LICENSE) 发布。
- `packages/markmap-*` 来自 [markmap](https://github.com/markmap/markmap)，版权归 Gerald，原始声明保留在 [LICENSE](LICENSE) 中。
- `packages/foliate-js` 是 [readest/foliate-js](https://github.com/readest/foliate-js) 的 submodule，遵循其 MIT 许可证。
- `apps/desktop/src/youtube-sabr-shaka-adapter.ts` 改编自 [LuanRT/googlevideo](https://github.com/LuanRT/googlevideo)（MIT），声明见 [NOTICE](apps/desktop/src/youtube-sabr-shaka-adapter.NOTICE.md)。
- PlantUML 随应用一起打包，许可证见 [LICENSE.txt](apps/desktop/src-tauri/resources/plantuml/LICENSE.txt)。
