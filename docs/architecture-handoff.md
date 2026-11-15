# Seamind 架构与交接

## 模块边界

- `apps/desktop/src/App.tsx` 负责工作区路由、跨工作区状态和公共窗口布局。领域逻辑应留在 `ebook/`、`exams/`、`tasks/`、`feed/`、`literature/` 等目录；新工作区参照现有 `React.lazy` 加载方式，首次打开后需要保留状态的页面继续挂载。
- 前端通过 Tauri `invoke` 访问 Rust 命令。`apps/desktop/src-tauri/src/lib.rs` 是命令注册入口；新增命令时运行 `apps/desktop/test/tauri-command-contract.test.ts`，确保前端字面量命令名已注册。参数和返回值仍需在功能测试中验证。
- 任务库和订阅库分别由 `tasks/learning_tasks.rs`、`feed/feed_store.rs` 管理。两库使用 SQLite `PRAGMA user_version`。每次升级应在事务内按版本迁移，并在成功后更新版本号；不得在普通读写路径重复执行 DDL 或忽略迁移错误。对已有数据库做升级测试，不要只测空库。
- 订阅预置源只在未记录预置状态时自动添加；用户删除全部订阅后，重开数据库也应保持为空。手动恢复预置源通过现有 `feed_seed_default_sources` 命令执行。
- PDF 页面翻译以 Tauri 原生存储为持久来源。旧版浏览器缓存只在读取时迁移，原生写入成功后才删除旧记录。原生存储失败应传给界面，不能用浏览器缓存伪装为保存成功。划词翻译缓存仍是可丢弃缓存。

## 扩展流程

1. 确定数据所有者、领域目录和 Tauri 命令边界；避免让工作区直接改写其他领域的数据库。
2. 如果修改持久化格式，添加带版本号的事务迁移和旧数据测试，并记录失败后的恢复方式。
3. 如果新增桌面命令，验证命令注册、参数序列化、错误展示和至少一条真实业务路径。
4. 如果新增重型工作区，按需加载并检查切换后是否需要保持播放器、阅读进度或终端状态；比较构建前后的入口 JS 和新增 chunk 大小。
5. 运行 `corepack pnpm@9.15.9 lint`、`corepack pnpm@9.15.9 --filter @markmap/desktop test`、桌面构建和 `cargo test --lib`；发布前检查签名、更新地址和旧版本升级。

## 发布与隐私

仓库中的 `tauri.conf.json` 不写维护者个人仓库地址。Windows 发布工作流从 `GITHUB_REPOSITORY` 生成忽略提交的配置覆盖文件，并在签名构建时合并。签名私钥与密码只放 GitHub Actions secrets。交接仓库时保留应用标识、凭据服务名及更新公钥；已有安装包仍会访问它构建时嵌入的旧仓库地址，因此旧仓库的 `latest.json` 必须维持到用户完成升级。详见 [Windows 发布说明](windows-release.md)。

## 已知边界

`App.tsx`、`TaskWorkspace.tsx`、`PaperPdfReader.tsx` 和 Rust 命令注册入口仍较大。此次保持现有公共接口和工作区行为，只对可验证的加载、持久化和迁移路径动手。后续拆分以领域边界和实际变更频率为依据，先提取可独立测试的服务与状态，再移动视图；不要按固定行数机械拆文件。命令名测试只覆盖字面量 `invoke`，动态命令与参数契约须另行校验。Pyodide 资源供离线 Python 运行使用，不能仅为了压缩安装包而删除。
