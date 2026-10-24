# Seamind 桌面端

这里是桌面端（Tauri 2 + React 19 + Vite）的开发说明。安装、配置和使用方法见仓库根目录的 [README](../../README.md)。

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

- `src/App.tsx`：主界面和导图编辑。
- `src/LibraryPanel.tsx`：文件库面板。
- `src/workbench/`：文档工作台。
- `src/player/`、`src/YouTubePlayerPanel.tsx`：播放器页面和播放窗口。
- `src/EbookWorkspace.tsx`、`src/EpubExamLibrary.tsx`：电子书和试卷库。
- `src/KnowledgeWorkspace.tsx`：知识库。
- `src/code-blocks.ts`：代码围栏渲染，包括 Mermaid、Pele 和 PlantUML。
- `src-tauri/src/`：Rust 后端。`library.rs` 管理文件库和索引，`youtube*.rs` 负责播放、代理和 yt-dlp，`plantuml.rs` 调用 Java 渲染，`player*.rs` 管理播放器数据，`epub_exam.rs` 管理试卷，`terminal.rs` 管理终端。
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
