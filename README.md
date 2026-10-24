# Seamind

Seamind 是一个本地优先的桌面应用：用 Markdown 写思维导图，并把导图、电子书、YouTube 学习视频和本地知识库放在同一个工作台里。

## 功能

- **导图**：Markdown 实时渲染成可缩放、可折叠的思维导图。支持数学公式（KaTeX）、PlantUML 图表和 Mermaid 语法的图表（由 Pele 渲染为 SVG）。双击节点即可编辑，回车添加同级节点，Tab 添加子节点。
- **文档**：Markdown 文档工作台，左边编辑、右边预览。可以以导图方式查看（文件仍是文档），也可以转为导图。
- **电子书**：EPUB 阅读（基于 foliate-js），可以为书籍生成导图；按书整理的试卷库，记录作答和掌握程度自评。
- **播放器**：YouTube 订阅、新视频动态、收藏和课程，数据保存在本机数据库。
- **知识库**：本地 Markdown 笔记的列表、搜索、新建和删除，支持公式预览，并可以在导图中打开。
- **AI 生成**：通过 OpenAI 兼容的 Chat Completions 接口，从一句话生成 Markdown 导图。API 密钥保存在 Windows 凭据管理器中，需要你在「模型设置」里自行配置。

导图、笔记和文档保存为本地 Markdown 文件，默认位于「文档\Markmap Library」，可以在应用里更改。

## 快速开始（Windows）

前提：

- Windows 10/11，并安装 [WebView2 运行时](https://developer.microsoft.com/microsoft-edge/webview2/)（大多数系统已自带）。
- Node.js 22 或更高版本，并启用 corepack：`corepack enable`。
- Rust 稳定版（MSVC 工具链）和 Visual Studio 的 C++ 生成工具，这是 Tauri 2 的要求。

```powershell
git clone --recurse-submodules https://github.com/ltm84532430-max/Seamind.git
cd Seamind
corepack pnpm@9.15.9 install
corepack pnpm@9.15.9 --filter @markmap/desktop tauri dev
```

`--recurse-submodules` 不能省略，`packages/foliate-js`（EPUB 渲染）是 submodule。已经 clone 过的仓库，运行 `git submodule update --init`。

## 开发与检查

```powershell
corepack pnpm@9.15.9 -r build:types                                    # 先构建各包的类型声明，桌面端的类型检查需要它
corepack pnpm@9.15.9 lint                                              # ESLint 与 Prettier
corepack pnpm@9.15.9 test                                              # packages/* 的测试
corepack pnpm@9.15.9 --filter @markmap/desktop exec tsc --noEmit -p tsconfig.json
```

CI（`.github/workflows/ci.yml`）会在推送到 `main` 和每个拉取请求上运行以上检查，并运行桌面端的测试。

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
| `demo/` | 示例 Markdown |

桌面端的运行细节见 [apps/desktop/README.md](apps/desktop/README.md)。

## 注意

- 播放器依赖 YouTube 的网络接口和流媒体协议，YouTube 的变化可能导致播放失败。请遵守 YouTube 的服务条款。
- AI 生成需要你自己的 API 密钥和接口地址。

## 许可证与致谢

- 本项目以 [MIT 许可证](LICENSE) 发布。
- `packages/markmap-*` 来自 [markmap](https://github.com/markmap/markmap)，原始版权声明保留在 `LICENSE` 中。感谢 Gerald 以及 [dundalek/markmap](https://github.com/dundalek/markmap) 的启发。
- `packages/foliate-js` 是 [readest/foliate-js](https://github.com/readest/foliate-js) 的 submodule，遵循其 [MIT 许可证](packages/foliate-js/LICENSE)。
- `apps/desktop/src/youtube-sabr-shaka-adapter.ts` 改编自 [LuanRT/googlevideo](https://github.com/LuanRT/googlevideo)（MIT），声明见 `apps/desktop/src/youtube-sabr-shaka-adapter.NOTICE.md`。
- PlantUML 随应用一起打包，许可证见 `apps/desktop/src-tauri/resources/plantuml/LICENSE.txt`。
