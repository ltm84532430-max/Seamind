# 文档工作台：Markdown 文档与 Pele 图表

思维导图之外的文件不再借用导图界面。文件库里的每个文件有自己的类型，打开时由类型决定界面：导图走原有的导图画布，Markdown 文档和 Pele 图表走“文档工作台”。

## 文件类型与语法

| 类型 | 扩展名 | 怎么认出来 | 打开方式 |
| --- | --- | --- | --- |
| 思维导图 | `.md` | 首行 `<!-- markmap-desktop: {…} -->`，没有 `kind` 字段 | 导图画布 |
| Markdown 文档 | `.md` | 同样的首行，且含 `"kind":"doc"`；没有文件头的 `.md` 也算文档 | 文档工作台 |
| Pele 图表 | `.mmd`（也认 `.mermaid`） | 首行 `%% seamind: {"id","title","tags","createdAt","updatedAt"}`，其余是原生 Mermaid | 文档工作台 |
| PlantUML | `.puml` | 无元数据，标题取文件名 | PlantUML 画布（未变） |
| EPUB | `.epub` | — | 阅读器（未变） |

`.mmd` 的元数据行是 Mermaid 注释，别的 Mermaid 工具读这个文件不受影响。没有元数据行的 `.mmd` 同样能打开，第一次保存时补上。

没有文件头的 `.md` 以前一律按导图打开，现在按文档打开。工作台里的“以导图打开”只是换个界面看，文件仍是文档；“转为导图”会把文件头改成导图，之后在文件库里按导图打开。

## 文件库

“新建”菜单增加三项：Markdown 文档、Pele 图表 (.mmd)、PlantUML 图表 (.puml)。新文件建在当前选中的文件夹里，名字取模板标题，重名时自动加序号。列表里 `.mmd` 带流程图图标和 `MMD` 标记，文档带 `DOC` 标记；搜索、文件夹计数、删除确认和“当前打开文件高亮”与其他类型一致。

## 工作台

外壳由所有类型共用：标题栏（类型标记、可改名的标题、路径、该类型的按钮）、窗格区、折叠的 AI 栏和状态行。窗格区按布局预设摆放：

- `source-canvas`（Pele 图表）：源码｜画布。画布支持拖动平移、滚轮缩放、双击或按 `0` 适配、全屏、复制 SVG 和导出 SVG（导出时把当前主题的 `--pele-*` 变量写进文件，颜色与屏幕一致）。语法有误时画布保留上一次成功的图，并在下方显示 Pele 的报错和“跳到第 N 行”。Pele 计行时不算 `%%` 注释行，所以行号用它引用的出错行回查源码，注释再多也不会错位。
- `source-preview-outline`（Markdown 文档）：源码｜渲染预览｜目录。预览与导图编辑器里的预览是同一套渲染（数学公式、`pele`/`mermaid`/`plantuml`/`echarts` 围栏），在预览里改代码块会写回源码。目录点击后定位到源码行并滚动预览，窄窗口默认收起。

保存规则：改动 1.2 秒后自动保存，也可按 Ctrl+S 或点顶栏“保存”；切换到别的文件前先保存，保存失败（例如文档被清空）会询问是否放弃这些修改。改标题就是改文件名，同名会被拒绝并还原标题。

AI 栏目前只是折叠占位，展开后说明这类文件暂未接入 AI。

## 代码位置

- `apps/desktop/src/workbench/`
  - `active-document.ts`：打开、编辑、保存、改名、转导图的规则（不依赖界面，有单元测试）。
  - `use-active-document.ts`：把它接到 React，并负责自动保存。
  - `WorkbenchShell.tsx`、`MermaidWorkbench.tsx`、`MarkdownDocWorkbench.tsx`、`DocumentWorkbench.tsx`：外壳与两种类型的窗格。
  - `DiagramCanvas.tsx`、`diagram-viewport.ts`：画布与平移缩放的计算。
  - `pele-render.ts`：用 Pele 渲染并过 SVG 安全清理，整理报错。
  - `markdown-outline.ts`、`templates.ts`、`workbench.css`。
- 后端 `src-tauri/src/library.rs`：`create_text_document`、`open_text_document`、`save_text_document`（带 `title` 时改名）、`delete_text_document`、`create_plantuml_document`；`save_document` 接受 `kind`。索引表 `maps` 新增 `kind` 列，旧库启动时自动补上。
- 测试：`apps/desktop/test/` 下的 `active-document`、`markdown-outline`、`pele-render`、`diagram-viewport`，以及 `library.rs` 里的 Rust 单元测试。

增加一种新文件类型的步骤：后端认出它并给出 `TextDocument` 一类的列表项，在 `workbench/` 里加一个窗格组件并在 `DocumentWorkbench.tsx` 里按类型分派，在 `LibraryPanel.tsx` 加一种列表行。

## 还没做

- 这两种类型的 AI 分析、历史版本。
- PlantUML、EPUB 和导图迁到同一个外壳（现在各自保持原样）。
- PlantUML 文件改名；后端把各类型的处理合并成统一接口。
