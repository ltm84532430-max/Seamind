import { useCallback, useMemo, useRef, useState } from 'react';
import {
  updateMarkdownCodeFence,
  updateMarkdownCodeFenceAtRange,
} from '../code-blocks';
import type { CodeBlockHandlers } from '../code-blocks';
import MarkdownEditor from '../MarkdownEditor';
import type { MarkdownEditorHandle } from '../MarkdownEditor';
import MarkdownPreview from '../MarkdownPreview';
import type { ActiveDocument } from './active-document';
import { extractMarkdownHeadings } from './markdown-outline';
import type { MarkdownHeading } from './markdown-outline';
import { useDebouncedValue } from './use-debounced-value';
import WorkbenchShell from './WorkbenchShell';
import type { MapDocument } from '../library';
import { createKnowledgeEditorExtensions } from '../knowledge-completions';
import { enhanceKnowledgePreviewHtml } from '../knowledge-markdown';
import { UNFILED_FOLDER } from '../knowledge-notes';

export type DocViewMode = 'edit' | 'split' | 'read';

const VIEW_MODE_STORAGE_KEY = 'seamind.docWorkbench.viewMode';

function readStoredViewMode(): DocViewMode {
  try {
    const raw = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    if (raw === 'edit' || raw === 'split' || raw === 'read') return raw;
    return 'edit';
  } catch {
    return 'edit';
  }
}

function writeStoredViewMode(mode: DocViewMode): void {
  try {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore storage quota errors
  }
}

export interface MarkdownDocWorkbenchProps {
  document: ActiveDocument;
  dirty: boolean;
  statusText: string;
  theme: 'light' | 'dark';
  documents?: readonly MapDocument[];
  categories?: readonly string[];
  /** Turns Markdown into the sanitized HTML the preview shows. */
  renderPreview(markdown: string): { html: string; source: string };
  onSourceChange(source: string): void;
  onSave(): void;
  onRename(title: string): Promise<boolean>;
  onChangeCategory?(category: string): Promise<boolean>;
  onChangeTags?(tags: string[]): Promise<boolean>;
  onOpenWikilink?(target: string): void;
  /** Opens the file on the mind map canvas without changing what kind of file it is. */
  onOpenAsMindmap(): void;
  /** Turns the file into a mind map for good. */
  onConvertToMindmap(): void;
}

const ignoreSelection = () => {};
const headingSelector = 'h1, h2, h3, h4, h5, h6';

/**
 * Clean, distraction-free Markdown document workbench supporting single-pane Edit (default),
 * side-by-side Split, and focused Read modes, with ref-stabilized CodeMirror completions.
 */
export default function MarkdownDocWorkbench({
  document,
  dirty,
  statusText,
  theme,
  documents,
  categories,
  renderPreview,
  onSourceChange,
  onSave,
  onRename,
  onChangeCategory,
  onChangeTags,
  onOpenWikilink,
  onOpenAsMindmap,
  onConvertToMindmap,
}: MarkdownDocWorkbenchProps) {
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const panesRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef(document.source);
  const documentsRef = useRef<readonly MapDocument[]>(documents ?? []);
  sourceRef.current = document.source;
  documentsRef.current = documents ?? [];

  // Stable extension list created once per mount so background autosave never destroys EditorView.
  const knowledgeExtensions = useMemo(
    () => createKnowledgeEditorExtensions(() => documentsRef.current),
    [],
  );

  const [viewMode, setViewMode] = useState<DocViewMode>(() =>
    readStoredViewMode(),
  );
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [addingTag, setAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState('');

  const switchViewMode = (mode: DocViewMode) => {
    setViewMode(mode);
    writeStoredViewMode(mode);
  };

  const showEditor = viewMode === 'edit' || viewMode === 'split';
  const showPreview = viewMode === 'split' || viewMode === 'read';

  const previewMarkdown = useDebouncedValue(document.source, 260);
  const preview = useMemo(() => {
    if (!showPreview) return { html: '', source: '' };
    const base = renderPreview(previewMarkdown);
    return {
      html: enhanceKnowledgePreviewHtml(base.html, documents ?? []),
      source: base.source,
    };
  }, [renderPreview, previewMarkdown, showPreview, documents]);

  const headings = useMemo(
    () => extractMarkdownHeadings(document.source),
    [document.source],
  );

  const availableCategories = useMemo(() => {
    const set = new Set<string>([UNFILED_FOLDER]);
    if (document.category) set.add(document.category);
    for (const cat of categories ?? []) {
      if (cat.trim()) set.add(cat.trim());
    }
    for (const doc of documents ?? []) {
      if (doc.category?.trim()) set.add(doc.category.trim());
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [categories, documents, document.category]);

  const handleCodeChange = useCallback<
    NonNullable<CodeBlockHandlers['onCodeChange']>
  >(
    (language, previous, next, sourceRange) => {
      const current = sourceRef.current;
      const updated = sourceRange
        ? updateMarkdownCodeFenceAtRange(
            current,
            language,
            sourceRange.lineIndex,
            sourceRange.endLineIndex,
            previous,
            next,
          )
        : updateMarkdownCodeFence(current, language, previous, next);
      if (updated === current) return false;
      onSourceChange(updated);
      return true;
    },
    [onSourceChange],
  );

  const goToHeading = (heading: MarkdownHeading, index: number) => {
    if (showEditor) {
      editorRef.current?.selectLine(heading.lineIndex, viewMode === 'edit');
    }
    if (showPreview) {
      const previewEl = panesRef.current?.querySelector<HTMLElement>(
        '.markdown-rendered-preview',
      );
      const target = previewEl?.querySelectorAll(headingSelector)[index];
      if (!previewEl || !target) return;
      previewEl.scrollTo({
        top:
          target.getBoundingClientRect().top -
          previewEl.getBoundingClientRect().top +
          previewEl.scrollTop -
          16,
        behavior: 'smooth',
      });
    }
  };

  const commitNewTag = () => {
    const clean = tagDraft.trim().replace(/^#+/, '').slice(0, 32);
    setTagDraft('');
    setAddingTag(false);
    if (!clean || !onChangeTags) return;
    if (document.tags.includes(clean)) return;
    void onChangeTags([...document.tags, clean]);
  };

  const removeTag = (tagToRemove: string) => {
    if (!onChangeTags) return;
    void onChangeTags(document.tags.filter((tag) => tag !== tagToRemove));
  };

  const lineCount = document.source.split('\n').length;

  return (
    <WorkbenchShell
      badge="DOC"
      label="Markdown 文档工作台"
      title={document.title}
      path={document.relativePath}
      dirty={dirty}
      statusText={statusText}
      summary={`${lineCount} 行 · ${document.source.length} 字`}
      layout="source-preview-outline"
      onSave={onSave}
      onRename={onRename}
      meta={
        <>
          {onChangeCategory ? (
            <label
              className="workbench-folder-chip"
              title="修改笔记所属分类目录"
            >
              <svg
                viewBox="0 0 16 16"
                width="12"
                height="12"
                aria-hidden="true"
              >
                <path
                  d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.88a1.5 1.5 0 0 1 1.06.44l1.12 1.12A1.5 1.5 0 0 0 9.62 5H12.5A1.5 1.5 0 0 1 14 6.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-8Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.35"
                />
              </svg>
              <select
                value={document.category || UNFILED_FOLDER}
                aria-label="所属分类目录"
                onChange={(e) => void onChangeCategory(e.target.value)}
              >
                {availableCategories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="workbench-folder-static">
              {document.category || UNFILED_FOLDER}
            </span>
          )}

          {onChangeTags && (
            <div className="workbench-tags-inline" aria-label="文档标签">
              {document.tags.map((tag) => (
                <span key={tag} className="workbench-tag-chip">
                  <span>#{tag}</span>
                  <button
                    type="button"
                    aria-label={`移除标签 ${tag}`}
                    title={`移除 #${tag}`}
                    onClick={() => removeTag(tag)}
                  >
                    ×
                  </button>
                </span>
              ))}
              {addingTag ? (
                <input
                  type="text"
                  className="workbench-tag-input"
                  value={tagDraft}
                  placeholder="标签名…"
                  maxLength={32}
                  autoFocus
                  onChange={(e) => setTagDraft(e.target.value)}
                  onBlur={commitNewTag}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitNewTag();
                    } else if (e.key === 'Escape') {
                      setTagDraft('');
                      setAddingTag(false);
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="workbench-tag-add"
                  title="添加文档标签"
                  onClick={() => setAddingTag(true)}
                >
                  + 标签
                </button>
              )}
            </div>
          )}
        </>
      }
      actions={
        <>
          <div
            className="workbench-view-segmented"
            role="group"
            aria-label="文档视图模式"
          >
            <button
              type="button"
              className={viewMode === 'edit' ? 'is-active' : ''}
              aria-pressed={viewMode === 'edit'}
              onClick={() => switchViewMode('edit')}
              title="清爽单栏写作视图"
            >
              编辑
            </button>
            <button
              type="button"
              className={viewMode === 'split' ? 'is-active' : ''}
              aria-pressed={viewMode === 'split'}
              onClick={() => switchViewMode('split')}
              title="源码与预览并排对照"
            >
              分栏
            </button>
            <button
              type="button"
              className={viewMode === 'read' ? 'is-active' : ''}
              aria-pressed={viewMode === 'read'}
              onClick={() => switchViewMode('read')}
              title="纯净阅读视图（支持点击双链跳转）"
            >
              阅读
            </button>
          </div>
          <button
            type="button"
            className={outlineOpen ? 'is-active' : ''}
            aria-pressed={outlineOpen}
            onClick={() => setOutlineOpen((open) => !open)}
            title="显示或隐藏章节大纲"
          >
            大纲{headings.length > 0 ? ` ${headings.length}` : ''}
          </button>
          <button
            type="button"
            onClick={onOpenAsMindmap}
            title="在思维导图画布上查看这份笔记（保持文档类型不变）"
          >
            导图预览
          </button>
          <button
            type="button"
            onClick={onConvertToMindmap}
            title="将该笔记转换为思维导图文件"
          >
            转为导图
          </button>
        </>
      }
    >
      <div
        ref={panesRef}
        data-doc-mode={viewMode}
        className={`workbench-split${outlineOpen ? ' has-outline' : ' is-outline-hidden'}`}
      >
        {showEditor && (
          <section
            className={`workbench-pane workbench-source-pane${viewMode === 'edit' ? ' is-centered-paper' : ''}`}
            aria-label="Markdown 源码"
          >
            {viewMode === 'split' && (
              <div className="workbench-pane-heading">
                <span className="pane-kicker">SOURCE</span>
                <strong>Markdown</strong>
                <span className="workbench-format">.md</span>
              </div>
            )}
            <div className="markdown-editor-frame">
              <MarkdownEditor
                ref={editorRef}
                id={`doc-source-${document.session}`}
                value={document.source}
                onChange={onSourceChange}
                onSelectionChange={ignoreSelection}
                extraExtensions={knowledgeExtensions}
                hideMinimap
              />
            </div>
          </section>
        )}

        {showPreview && (
          <section
            className={`workbench-pane workbench-preview-pane${viewMode === 'read' ? ' is-centered-paper' : ''}`}
            aria-label="渲染预览"
          >
            {viewMode === 'split' && (
              <div className="workbench-pane-heading">
                <span className="pane-kicker">PREVIEW</span>
                <strong>实时预览</strong>
              </div>
            )}
            <MarkdownPreview
              html={preview.html}
              source={preview.source}
              theme={theme}
              hideMinimap
              onCodeChange={handleCodeChange}
              onOpenWikilink={onOpenWikilink}
            />
          </section>
        )}

        {outlineOpen && (
          <nav
            className="workbench-pane workbench-outline-pane"
            aria-label="文档目录"
          >
            <div className="workbench-pane-heading">
              <span className="pane-kicker">OUTLINE</span>
              <strong>大纲</strong>
              <span className="workbench-format">{headings.length}</span>
            </div>
            <div className="workbench-outline-list">
              {headings.length === 0 ? (
                <p className="workbench-outline-empty">
                  使用 # 编写各级标题后，章节结构会自动生成在此处。
                </p>
              ) : (
                headings.map((heading, index) => (
                  <button
                    type="button"
                    key={`${heading.lineIndex}-${index}`}
                    className="workbench-outline-item"
                    style={{ paddingLeft: 12 + (heading.depth - 1) * 12 }}
                    title={`第 ${heading.lineIndex + 1} 行`}
                    onClick={() => goToHeading(heading, index)}
                  >
                    {heading.text}
                  </button>
                ))
              )}
            </div>
          </nav>
        )}
      </div>
    </WorkbenchShell>
  );
}
