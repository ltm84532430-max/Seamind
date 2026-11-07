# Seamind 桌面端

这里是 Seamind 桌面端（Tauri 2 + React 19 + Vite）的开发说明，覆盖播放器、文档、导图、电子书、RSS、文献和任务工作区。安装、功能配置与数据位置见仓库根目录的 [README](../../README.md)。

## 开发环境

- Windows 10/11、Node.js 22 或更高版本、Corepack 和 pnpm 9.15.9。
- Rust 稳定版 `x86_64-pc-windows-msvc` 工具链，以及 Visual Studio 2022 Build Tools 的 C++ 桌面开发组件和 Windows SDK。
- WebView2 Runtime。
- `packages/foliate-js` submodule。首次克隆使用 `git clone --recurse-submodules`；已克隆的仓库使用 `git submodule update --init`。

## 运行

在仓库根目录执行：

```powershell
corepack pnpm@9.15.9 install
corepack pnpm@9.15.9 --filter @markmap/desktop tauri dev
```

- 前端开发服务器固定在 `http://127.0.0.1:1420`（`--strictPort`）。端口被占用时会直接失败，不会自动换端口。
- 开发窗口默认 1440 × 900，最小 960 × 640。
- 前端直接使用 `packages/markmap-*` 的源码，运行应用不需要先构建这些包。

## 类型检查与测试

类型检查读取各包构建出的类型声明，所以先构建声明，再运行 `tsc`：

```powershell
corepack pnpm@9.15.9 -r build:types
corepack pnpm@9.15.9 --filter @markmap/desktop exec tsc --noEmit -p tsconfig.json
corepack pnpm@9.15.9 --filter @markmap/desktop exec vitest run test/
node --test apps/desktop/tests/*.test.mjs
```

Rust 后端的测试在 `src-tauri` 目录下运行：

```powershell
cd apps/desktop/src-tauri
cargo test --lib
```

联网测试默认忽略。`cargo test --lib live_ -- --ignored` 会向 YouTube 请求一个公开视频，经本地代理取一段媒体数据。

## 代码结构

- `src/App.tsx`、`src/main.tsx`：前端入口、页面切换和导图编辑。
- `src/app/`：应用级存储与样式工具；`src/library/`：文件库索引和侧栏。
- `src/workbench/`：Markdown 编辑、预览、代码围栏与文档工作台。
- `src/knowledge/`：知识库、笔记来源、粘贴和文档媒体。
- `src/ebook/`：电子书、阅读统计、翻译和在线找书；`src/exams/`：试卷、作答和间隔复习页面。
- `src/player/`：播放器、YouTube 接入、字幕和学习路径。
- `src/feed/`、`src/literature/`、`src/tasks/`：订阅、论文和任务视图。
- `src/mindmap/`、`src/agent/`、`src/system/`：导图辅助、AI 面板、终端与安装更新。
- `src-tauri/src/lib.rs`：Rust 命令注册；后端实现按 `agent/`、`ebook/`、`exams/`、`feed/`、`library/`、`literature/`、`mindmap/`、`player/`、`tasks/`、`system/` 分类。模块名和 Tauri 命令保持原有接口。
- `src-tauri/resources/plantuml/`：随应用打包的 PlantUML。

## 环境变量

以下变量供高级用法和开发调试使用，普通使用不需要设置。

| 变量 | 作用 |
| --- | --- |
| `SEAMIND_MPV_PATH` | mpv 可执行文件的路径 |
| `SEAMIND_YT_DLP_PATH` | yt-dlp 可执行文件的路径 |
| `SEAMIND_NEWPIPE_BRIDGE` | 可选的 NewPipe 辅助程序。未设置时不使用，详见 [docs/youtube-playback.md](../../docs/youtube-playback.md) |
| `SEAMIND_PLAYER_DB` | 仅调试构建生效。把播放器数据库指向另一个文件，检查时不会碰真实数据 |
| `SEAMIND_YT_PROXY_ALLOW_LOOPBACK` | 仅调试构建生效，值为 `1` 时允许播放代理转发到回环地址，用于端到端测试 |
