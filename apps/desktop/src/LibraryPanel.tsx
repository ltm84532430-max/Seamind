import type { LibrarySnapshot, MapDocument } from './library';

interface LibraryPanelProps {
  snapshot: LibrarySnapshot | null;
  documents: MapDocument[];
  selectedPath: string | null;
  collapsed: boolean;
  categoryFilter: string;
  query: string;
  busy: boolean;
  summarizeEpubOnImport: boolean;
  onSearch: (value: string) => void;
  onChooseRoot: () => void;
  onRefresh: () => void;
  onCreateDocument: () => void;
  onCreateWithAi: () => void;
  onImportEpub: () => void;
  onToggleEpubSummary: (enabled: boolean) => void;
  onCreateCategory: () => void;
  onSelectCategory: (category: string) => void;
  onOpenDocument: (document: MapDocument) => void;
  onDeleteDocument: (document: MapDocument) => void;
  onToggleCollapse: () => void;
}

function formatUpdatedAt(timestamp: number): string {
  if (!timestamp) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp * 1000));
}

export default function LibraryPanel({
  snapshot,
  documents,
  selectedPath,
  collapsed,
  categoryFilter,
  query,
  busy,
  summarizeEpubOnImport,
  onSearch,
  onChooseRoot,
  onRefresh,
  onCreateDocument,
  onCreateWithAi,
  onImportEpub,
  onToggleEpubSummary,
  onCreateCategory,
  onSelectCategory,
  onOpenDocument,
  onDeleteDocument,
  onToggleCollapse,
}: LibraryPanelProps) {
  const rootName =
    snapshot?.rootPath?.split(/[\\/]/).filter(Boolean).at(-1) ?? '尚未设置';

  return (
    <aside
      className={`library-sidebar${collapsed ? ' is-collapsed' : ''}`}
      aria-label="思维导图目录"
    >
      <div className="library-heading">
        <div className="library-heading-copy">
          <span className="pane-kicker">DIRECTORY</span>
          <h1>目录</h1>
        </div>
        {!collapsed && (
          <span className="library-count">
            {snapshot?.documents.length ?? 0}
          </span>
        )}
        <button
          type="button"
          className="pane-collapse-button library-collapse-button"
          title={collapsed ? '展开目录' : '收起目录'}
          aria-label={collapsed ? '展开目录' : '收起目录'}
          aria-expanded={!collapsed}
          aria-controls="library-sidebar-content"
          onClick={onToggleCollapse}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d={collapsed ? 'M6 3l5 5-5 5' : 'M10 3 5 8l5 5'} />
          </svg>
        </button>
      </div>

      <div className="library-content" id="library-sidebar-content">
        <div className="library-location">
          <div className="library-location-copy">
            <span className="library-location-label">存储位置</span>
            <strong title={snapshot?.rootPath ?? ''}>{rootName}</strong>
          </div>
          <button type="button" className="quiet-button" onClick={onChooseRoot}>
            更改
          </button>
        </div>

        <div className="library-actions">
          <button
            type="button"
            className="library-primary-action"
            onClick={onCreateDocument}
          >
            ＋ 新建思维导图
          </button>
          <button
            type="button"
            className="quiet-button"
            onClick={onCreateCategory}
          >
            ＋ 分类
          </button>
          <button
            type="button"
            className="quiet-button library-ai-create-button"
            onClick={onCreateWithAi}
            title="用 AI 新建思维导图"
          >
            AI 新建
          </button>
        </div>
        <button
          type="button"
          className="library-import-action"
          onClick={onImportEpub}
          disabled={busy}
          title="选择 EPUB 文件，也可将 EPUB 拖入应用窗口"
        >
          {busy ? '正在处理…' : '导入 EPUB 目录'}
        </button>
        <label className="library-epub-ai-option">
          <input
            type="checkbox"
            checked={summarizeEpubOnImport}
            onChange={(event) => onToggleEpubSummary(event.target.checked)}
            disabled={busy}
          />
          <span>
            <strong>生成 AI 章节摘要</strong>
            <small>
              勾选后会将章节正文发送到当前配置的 AI 模型；默认关闭。
            </small>
          </span>
        </label>

        <label className="library-search">
          <span aria-hidden="true">⌕</span>
          <input
            value={query}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="搜索标题、内容、标签"
          />
          {query && (
            <button
              type="button"
              aria-label="清除搜索"
              onClick={() => onSearch('')}
            >
              ×
            </button>
          )}
        </label>

        <div className="library-section-label">
          <span>分类</span>
        </div>
        <nav className="category-list" aria-label="按分类筛选">
          <button
            type="button"
            className={`category-item${categoryFilter === '' ? ' is-active' : ''}`}
            onClick={() => onSelectCategory('')}
          >
            <span className="category-glyph">▦</span>
            <span>全部思维导图</span>
          </button>
          {snapshot?.categories.map((category) => (
            <button
              type="button"
              key={category}
              className={`category-item${categoryFilter === category ? ' is-active' : ''}`}
              style={{
                paddingLeft: `${11 + Math.max(0, category.split('/').length - 1) * 12}px`,
              }}
              onClick={() => onSelectCategory(category)}
              title={category}
            >
              <span className="category-glyph">▱</span>
              <span>{category.split('/').at(-1)}</span>
            </button>
          ))}
        </nav>

        <div className="library-section-label document-list-heading">
          <span>{categoryFilter || '最近更新'}</span>
          <button
            type="button"
            className="icon-text-button"
            onClick={onRefresh}
            disabled={busy}
            title="扫描文件并重建索引"
          >
            {busy ? '扫描中…' : '重建索引'}
          </button>
        </div>

        <div className="document-list" aria-live="polite">
          {documents.map((document) => (
            <div
              className={`document-row${selectedPath === document.relativePath ? ' is-selected' : ''}`}
              key={document.relativePath}
            >
              <button
                type="button"
                className="document-open-button"
                onClick={() => onOpenDocument(document)}
              >
                <span className="document-row-title">{document.title}</span>
                <span className="document-row-meta">
                  <span>{document.category || '未分类'}</span>
                  <span>{formatUpdatedAt(document.updatedAt)}</span>
                </span>
                {(document.mapType !== '通用' || document.tags.length > 0) && (
                  <span className="document-tags">
                    {document.mapType !== '通用' && <i>{document.mapType}</i>}
                    {document.tags.slice(0, 2).map((tag) => (
                      <i key={tag}>{tag}</i>
                    ))}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="document-delete-button"
                aria-label={`删除${document.title}`}
                title="删除"
                onClick={() => onDeleteDocument(document)}
              >
                ×
              </button>
            </div>
          ))}
          {!busy && documents.length === 0 && (
            <div className="library-empty">
              <span>
                {query || categoryFilter
                  ? '没有匹配的思维导图'
                  : '这里还没有思维导图'}
              </span>
              {!query && (
                <button type="button" onClick={onCreateDocument}>
                  新建一张
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
