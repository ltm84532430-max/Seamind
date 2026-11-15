# Seamind 架构与交接

## 模块边界

- `apps/desktop/src/App.tsx` 负责工作区切换、跨工作区状态和公共窗口布局。阅读设置在 `ebook/reader-state.ts`，任务列表纯逻辑在 `tasks/task-list-model.ts`，论文版式在 `literature/paper-pdf-layout.ts`，导图和学习路径提案在 `agent/proposals.ts`。组件对外入口仍是 `EpubReader`、`TaskWorkspace`、`PaperPdfReader`。新工作区参照现有 `React.lazy` 加载方式，首次打开后需要保留状态的页面继续挂载。
- 跨模块只传递资源引用和操作结果。电子书或播放器可以创建任务，任务状态只放在任务库。知识文档和思维导图是两个页面，共用工作台框架。不要把 RSS 并进播放器，也不要把论文翻译并进电子书翻译。
- 前端只有领域 API 模块调用 Tauri `invoke`。入口是 `task-api.ts`、`player-api.ts`、`feed-api.ts`、`feed-translation-api.ts`、`feed-asr-api.ts`、`agent-api.ts`、`epub-api.ts`、`library-api.ts`、`literature-api.ts`、`plantuml-api.ts`、`system-api.ts`、`terminal-api.ts`、`zlib-api.ts`。命令名和 camelCase 字段保持不变。界面可以继续用 `convertFileSrc`。Rust 注册入口仍是 `apps/desktop/src-tauri/src/lib.rs`。`apps/desktop/test/tauri-command-contract.test.ts` 核对字面量命令名、对象参数键和返回形状；具名结构体允许前端别名，原始类型、数组和 void 必须一致。
- 持久化库都使用 SQLite `PRAGMA user_version`，当前版本都是 1。下一次结构变更写成 1 到 2 的迁移，不要再往版本 0 分支里追加 DDL。

| 数据 | 所有者 | 版本 | 命令入口 |
| --- | --- | --- | --- |
| 学习任务与习惯 | `tasks/learning_tasks.rs` | 1 | `task-api.ts` |
| 订阅源与文章 | `feed/feed_store.rs` | 1 | `feed-api.ts` |
| 播放进度、频道、学习路径 | `player/player_store.rs` | 1 | `player-api.ts` |
| 文件库索引 | `library/library.rs` 的库索引 | 1 | `library-api.ts` |
| 文档历史 | `library/library.rs` 的 history 库 | 1 | `library-api.ts` |

- 版本 0 的旧文件在事务里升级并盖章。已经盖成 1 的库再次打开时不再重复补列。升级失败时不写版本号，事务回滚。用旧库副本做测试，不要直接改用户正在使用的数据库。
- 订阅预置源只在未记录预置状态时自动添加；用户删除全部订阅后，重开数据库也应保持为空。手动恢复预置源通过现有 `feed_seed_default_sources` 命令执行。
- PDF 页面翻译以 Tauri 原生存储为持久来源，命令在 `literature-api.ts`。旧版浏览器缓存只在读取时迁移，原生写入成功后才删除旧记录。原生存储失败应传给界面，不能用浏览器缓存伪装为保存成功。划词翻译缓存仍是可丢弃缓存。电子书章节翻译走 `epub-api.ts`，与论文翻译分开。

## 扩展流程

1. 确定数据所有者、领域目录和 Tauri 命令边界；避免让工作区直接改写其他领域的数据库。
2. 如果修改持久化格式，添加带版本号的事务迁移和旧数据测试，并记录失败后的恢复方式。
3. 如果新增桌面命令，验证命令注册、参数序列化、错误展示和至少一条真实业务路径。
4. 如果新增重型工作区，按需加载并检查切换后是否需要保持播放器、阅读进度或终端状态；比较构建前后的入口 JS 和新增 chunk 大小。
5. 运行 `corepack pnpm@9.15.9 lint`、`corepack pnpm@9.15.9 --filter @markmap/desktop test`、桌面构建和 `cargo test --lib`；发布前检查签名、更新地址和旧版本升级。

## 发布与隐私

仓库中的 `tauri.conf.json` 不写维护者个人仓库地址。Windows 发布工作流从 `GITHUB_REPOSITORY` 生成忽略提交的配置覆盖文件，并在签名构建时合并。签名私钥与密码只放 GitHub Actions secrets。交接仓库时保留应用标识、凭据服务名及更新公钥；已有安装包仍会访问它构建时嵌入的旧仓库地址，因此旧仓库的 `latest.json` 必须维持到用户完成升级。详见 [Windows 发布说明](windows-release.md)。

## 样式

`styles.css` 保留主题变量、应用框架、思维导图画布和常驻终端。这些规则必须先于 `themes-extended.css` 加载。宽屏书架布局在 `ebook/ebook-shelf-layout.css`，知识页框架在 `knowledge/knowledge-surface.css`；`main.tsx` 在 `styles.css` 之后、`themes-extended.css` 之前引入它们，避免主题覆盖被挪到后面。方形控件和全局圆角规则留在根样式里。

## 已知边界

`App.tsx` 仍集中文件库打开、保存和思维导图画布，因为这些状态在同一次渲染里互相调用。`EpubReader.tsx`、`TaskWorkspace.tsx`、`PaperPdfReader.tsx` 和 Rust 命令注册入口仍较大。后续拆分继续按领域边界提取可独立测试的状态，不要按固定行数机械拆文件，也不要合并上面分开的数据所有者。Pyodide 资源供离线 Python 运行使用，不能仅为了压缩安装包而删除。
