import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  preparePastedSvg,
  updateMarkdownCodeFence,
  updateMarkdownCodeFenceAtRange,
} from './code-blocks';
import type { CodeBlockHandlers } from './code-blocks';
import MarkdownEditor from './MarkdownEditor';
import type { MarkdownEditorHandle } from './MarkdownEditor';
import MarkdownPreview from './MarkdownPreview';
import type { PreviewFootnoteJumpRequest } from './MarkdownPreview';
import type { ActiveDocument } from './active-document';
import {
  extractFootnoteAnchorContext,
  formatTextForFootnotePaste,
  nextAvailableFootnoteId,
  parseMarkdownFootnotes,
  removeFootnoteFromMarkdown,
  upsertFootnoteInMarkdown,
  type MarkdownFootnote,
} from './markdown-footnotes';
import { extractMarkdownHeadings } from './markdown-outline';
import type { MarkdownHeading } from './markdown-outline';
import { useDebouncedValue } from './use-debounced-value';
import WorkbenchShell from './WorkbenchShell';
import type { MapDocument } from '../library/library';
import { createKnowledgeEditorExtensions } from '../knowledge/knowledge-completions';
import { enhanceKnowledgePreviewHtml } from '../knowledge/knowledge-markdown';
import {
  analyzeKnowledgePaste,
  needsKnowledgePasteReview,
  pasteTextWithMedia,
} from '../knowledge/knowledge-paste';
import type {
  ImportedPasteVisual,
  KnowledgePasteDraft,
} from '../knowledge/knowledge-paste';
import { importDocumentMedia } from '../knowledge/document-media';
import { UNFILED_FOLDER } from '../knowledge/knowledge-notes';
import type { Theme } from '../app/app-storage';

export type DocViewMode = 'edit' | 'split' | 'read';

const VIEW_MODE_STORAGE_KEY = 'seamind.docWorkbench.viewMode';

function readStoredViewMode(): DocViewMode {
  try {
    const raw = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    if (raw === 'edit' || raw === 'split' || raw === 'read') return raw;
    return 'split';
  } catch {
    return 'split';
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
  theme: Theme;
  documents?: readonly MapDocument[];
  categories?: readonly string[];
  scrollToFootnoteRequest?: PreviewFootnoteJumpRequest | null;
  /** Turns Markdown into the sanitized HTML the preview shows. */
  renderPreview(markdown: string): { html: string; source: string };
  onSourceChange(source: string): void;
  onSave(): void;
  onRename(title: string): Promise<boolean>;
  onChangeCategory?(category: string): Promise<boolean>;
  onChangeTags?(tags: string[]): Promise<boolean>;
  onOpenWikilink?(target: string): void;
  onOpenYouTubeLink?(
    videoId: string,
    startSeconds: number,
    fallbackTitle?: string,
  ): void;
  onRunInTerminal?: CodeBlockHandlers['onRunInTerminal'];
  /** Opens the file on the mind map canvas without changing what kind of file it is. */
  onOpenAsMindmap(): void;
  /** Turns the file into a mind map for good. */
  onConvertToMindmap(): void;
}

const ignoreSelection = () => {};
const headingSelector = 'h1, h2, h3, h4, h5, h6';

interface PendingKnowledgePaste extends KnowledgePasteDraft {
  session: number;
  baseSource: string;
  from: number;
  to: number;
}

interface FootnoteComposerState {
  session: number;
  mode: 'create' | 'edit';
  footnoteId: string;
  indexLabel: string;
  selectionFrom: number;
  selectionTo: number;
  anchorContext: string;
  draft: string;
}

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
  scrollToFootnoteRequest,
  renderPreview,
  onSourceChange,
  onSave,
  onRename,
  onChangeCategory,
  onChangeTags,
  onOpenWikilink,
  onOpenYouTubeLink,
  onRunInTerminal,
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
  const [railTab, setRailTab] = useState<'outline' | 'footnotes'>('outline');
  const [localFootnoteJump, setLocalFootnoteJump] =
    useState<PreviewFootnoteJumpRequest | null>(null);
  const [addingTag, setAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [pendingPaste, setPendingPaste] =
    useState<PendingKnowledgePaste | null>(null);
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteError, setPasteError] = useState('');
  const [footnoteComposer, setFootnoteComposer] =
    useState<FootnoteComposerState | null>(null);
  const [footnoteComposerError, setFootnoteComposerError] = useState('');

  useEffect(() => {
    setFootnoteComposer(null);
    setFootnoteComposerError('');
  }, [document.session]);

  const handleKnowledgePaste = useCallback(
    (event: ClipboardEvent, editor: import('codemirror').EditorView) => {
      const clipboard = event.clipboardData;
      if (!clipboard) return false;
      const analyzed = analyzeKnowledgePaste(clipboard);
      const shouldPreview = needsKnowledgePasteReview(
        analyzed,
        !!clipboard.getData('text/plain'),
      );
      if (!shouldPreview) return false;
      event.preventDefault();
      setPasteError('');
      setPendingPaste({
        ...analyzed,
        session: document.session,
        baseSource: sourceRef.current,
        from: editor.state.selection.main.from,
        to: editor.state.selection.main.to,
      });
      return true;
    },
    [document.session],
  );

  const applyPendingPaste = useCallback(
    (paste: PendingKnowledgePaste, text: string): boolean => {
      if (
        paste.session !== document.session ||
        paste.baseSource !== sourceRef.current
      ) {
        setPasteError('文档已变化。请取消后重新粘贴，以免覆盖刚才的编辑。');
        return false;
      }
      if (!editorRef.current) {
        setPasteError('编辑器已关闭。请取消后重新进入编辑视图粘贴。');
        return false;
      }
      try {
        const formatted = formatTextForFootnotePaste(
          sourceRef.current,
          paste.from,
          paste.to,
          text,
        );
        editorRef.current.replaceRange(paste.from, paste.to, formatted.text);
      } catch {
        setPasteError('粘贴位置已失效。请取消后重新粘贴。');
        return false;
      }
      setPendingPaste(null);
      setPasteError('');
      return true;
    },
    [document.session],
  );

  const confirmKnowledgePaste = useCallback(async () => {
    const paste = pendingPaste;
    if (!paste || pasteBusy) return;
    if (
      paste.baseSource !== sourceRef.current ||
      paste.session !== document.session
    ) {
      setPasteError('文档已变化。请取消后重新粘贴。');
      return;
    }
    const selected = paste.media.filter((candidate) => candidate.selected);
    if (
      selected.some((candidate) => candidate.kind !== 'svg') &&
      !document.relativePath
    ) {
      setPasteError('请先保存笔记，再导入图片。也可以仅粘贴文本。');
      return;
    }
    setPasteBusy(true);
    setPasteError('');
    const imported: ImportedPasteVisual[] = [];
    try {
      for (const candidate of selected) {
        try {
          if (candidate.kind === 'svg') {
            imported.push({
              candidate,
              svgSource: preparePastedSvg(String(candidate.value)),
            });
            continue;
          }
          const result = await importDocumentMedia(
            document.relativePath,
            candidate,
          );
          imported.push({ candidate, mediaId: result.mediaId });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`“${candidate.label}”导入失败：${detail}`);
        }
      }
      applyPendingPaste(paste, pasteTextWithMedia(paste.text, imported));
    } catch (error) {
      setPasteError(error instanceof Error ? error.message : String(error));
    } finally {
      setPasteBusy(false);
    }
  }, [
    pendingPaste,
    pasteBusy,
    document.relativePath,
    document.session,
    applyPendingPaste,
  ]);

  const switchViewMode = useCallback((mode: DocViewMode) => {
    setViewMode(mode);
    writeStoredViewMode(mode);
  }, []);

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

  const footnotes = useMemo(
    () => parseMarkdownFootnotes(document.source).footnotes,
    [document.source],
  );

  const activeFootnoteJump = useMemo(() => {
    if (!localFootnoteJump) return scrollToFootnoteRequest ?? null;
    if (!scrollToFootnoteRequest) return localFootnoteJump;
    return localFootnoteJump.nonce >= scrollToFootnoteRequest.nonce
      ? localFootnoteJump
      : scrollToFootnoteRequest;
  }, [localFootnoteJump, scrollToFootnoteRequest]);

  useEffect(() => {
    if (!scrollToFootnoteRequest?.id) return;
    const target = footnotes.find((fn) => fn.id === scrollToFootnoteRequest.id);
    if (!target) return;
    if (showEditor) {
      editorRef.current?.selectLine(target.lineIndex, viewMode === 'edit');
    }
  }, [scrollToFootnoteRequest, footnotes, showEditor, viewMode]);

  const handleInsertFootnote = useCallback(() => {
    const current = sourceRef.current;
    const selection = showEditor ? editorRef.current?.getSelection() : null;
    const range = selection
      ? { from: selection.from, to: selection.to }
      : { from: current.length, to: current.length };
    const nextId = nextAvailableFootnoteId(current);
    setFootnoteComposerError('');
    setFootnoteComposer({
      session: document.session,
      mode: 'create',
      footnoteId: nextId,
      indexLabel: nextId,
      selectionFrom: range.from,
      selectionTo: range.to,
      anchorContext: extractFootnoteAnchorContext(current, range.to),
      draft: '',
    });
  }, [document.session, showEditor]);

  const openEditFootnoteComposer = useCallback(
    (footnoteId: string) => {
      const target = parseMarkdownFootnotes(sourceRef.current).footnotes.find(
        (fn) => fn.id === footnoteId,
      );
      if (!target) return;
      const sourceLines = sourceRef.current.split(/\r?\n/);
      const refLine = target.refLineIndices[0];
      const anchorContext =
        refLine !== undefined && sourceLines[refLine] !== undefined
          ? sourceLines[refLine].trim().slice(0, 48)
          : `第 ${target.lineIndex + 1} 行`;
      setFootnoteComposerError('');
      setFootnoteComposer({
        session: document.session,
        mode: 'edit',
        footnoteId: target.id,
        indexLabel: String(target.index),
        selectionFrom: 0,
        selectionTo: 0,
        anchorContext,
        draft: target.content,
      });
    },
    [document.session],
  );

  const submitFootnoteComposer = useCallback(() => {
    const composer = footnoteComposer;
    if (!composer) return;
    if (composer.session !== document.session) {
      setFootnoteComposer(null);
      return;
    }
    if (!composer.draft.trim()) {
      setFootnoteComposerError('请输入或粘贴脚注内容');
      return;
    }
    const result = upsertFootnoteInMarkdown(sourceRef.current, {
      mode: composer.mode,
      id: composer.footnoteId,
      selection: {
        from: composer.selectionFrom,
        to: composer.selectionTo,
      },
      content: composer.draft,
    });
    if (showEditor && editorRef.current) {
      editorRef.current.applyDocument(
        result.nextSource,
        composer.mode === 'create' && result.cursorOffsetAfterRef !== undefined
          ? { cursorOffset: result.cursorOffsetAfterRef, focus: true }
          : undefined,
      );
    } else {
      onSourceChange(result.nextSource);
    }
    if (composer.mode === 'create') {
      setRailTab('footnotes');
    }
    setFootnoteComposerError('');
    setFootnoteComposer(null);
  }, [document.session, footnoteComposer, onSourceChange, showEditor]);

  const goToFootnote = (footnote: MarkdownFootnote) => {
    if (showEditor) {
      editorRef.current?.selectLine(footnote.lineIndex, viewMode === 'edit');
    }
    if (showPreview) {
      setLocalFootnoteJump({ id: footnote.id, nonce: Date.now() });
    }
  };

  const handleDeleteFootnote = useCallback(
    (footnote: MarkdownFootnote) => {
      const result = removeFootnoteFromMarkdown(sourceRef.current, footnote.id);
      if (!result.removed) return;
      if (showEditor && editorRef.current) {
        editorRef.current.applyDocument(result.nextSource);
      } else {
        onSourceChange(result.nextSource);
      }
      setLocalFootnoteJump((prev) => (prev?.id === footnote.id ? null : prev));
    },
    [showEditor, onSourceChange],
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
            onClick={handleInsertFootnote}
            title="在光标处插入 Markdown 脚注 [^n] (Ctrl+Alt+F)"
          >
            + 脚注
          </button>
          <button
            type="button"
            className={outlineOpen && railTab === 'outline' ? 'is-active' : ''}
            aria-pressed={outlineOpen && railTab === 'outline'}
            onClick={() => {
              if (outlineOpen && railTab === 'outline') {
                setOutlineOpen(false);
              } else {
                setRailTab('outline');
                setOutlineOpen(true);
              }
            }}
            title="显示或隐藏章节大纲"
          >
            大纲{headings.length > 0 ? ` ${headings.length}` : ''}
          </button>
          <button
            type="button"
            className={
              outlineOpen && railTab === 'footnotes' ? 'is-active' : ''
            }
            aria-pressed={outlineOpen && railTab === 'footnotes'}
            onClick={() => {
              if (outlineOpen && railTab === 'footnotes') {
                setOutlineOpen(false);
              } else {
                setRailTab('footnotes');
                setOutlineOpen(true);
              }
            }}
            title="查看当前笔记的脚注索引"
          >
            脚注{footnotes.length > 0 ? ` ${footnotes.length}` : ''}
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
        onKeyDown={(event) => {
          if (
            (event.ctrlKey || event.metaKey) &&
            event.altKey &&
            event.key.toLowerCase() === 'f'
          ) {
            event.preventDefault();
            handleInsertFootnote();
          }
        }}
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
                onPaste={handleKnowledgePaste}
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
              mediaDocumentPath={document.relativePath}
              hideMinimap={viewMode !== 'read'}
              scrollToFootnoteRequest={activeFootnoteJump}
              onCodeChange={handleCodeChange}
              onOpenWikilink={onOpenWikilink}
              onOpenYouTubeLink={
                onOpenYouTubeLink
                  ? (videoId, startSeconds) =>
                      onOpenYouTubeLink(videoId, startSeconds, document.title)
                  : undefined
              }
              onRunInTerminal={onRunInTerminal}
              onEditFootnote={openEditFootnoteComposer}
            />
          </section>
        )}

        {outlineOpen && (
          <nav
            className="workbench-pane workbench-outline-pane"
            aria-label={railTab === 'footnotes' ? '脚注列表' : '文档目录'}
          >
            <div className="workbench-pane-heading workbench-rail-tabs">
              <button
                type="button"
                className={`workbench-rail-tab${railTab === 'outline' ? ' is-active' : ''}`}
                onClick={() => setRailTab('outline')}
              >
                目录 <span>{headings.length}</span>
              </button>
              <button
                type="button"
                className={`workbench-rail-tab${railTab === 'footnotes' ? ' is-active' : ''}`}
                onClick={() => setRailTab('footnotes')}
              >
                脚注 <span>{footnotes.length}</span>
              </button>
            </div>
            <div className="workbench-outline-list">
              {railTab === 'footnotes' ? (
                footnotes.length === 0 ? (
                  <p className="workbench-outline-empty">
                    点击工具栏「+ 脚注」或使用 [^1]
                    语法添加脚注后，会汇集在此处方便定位。
                  </p>
                ) : (
                  footnotes.map((footnote) => (
                    <div
                      key={footnote.id}
                      className="workbench-outline-footnote-row"
                    >
                      <button
                        type="button"
                        className="workbench-outline-footnote-item"
                        title={`第 ${footnote.lineIndex + 1} 行 · [^${footnote.id}]`}
                        onClick={() => goToFootnote(footnote)}
                      >
                        <span className="workbench-outline-fn-badge">
                          [{footnote.index}] {footnote.id}
                        </span>
                        <span className="workbench-outline-fn-text">
                          {footnote.plainText || '（空白脚注，点击补全内容）'}
                        </span>
                      </button>
                      <div className="workbench-outline-footnote-actions">
                        <button
                          type="button"
                          className="workbench-outline-footnote-edit"
                          aria-label={`编辑脚注 [^${footnote.id}]`}
                          title={`在独立编辑框中修改脚注 [^${footnote.id}]`}
                          onClick={() => openEditFootnoteComposer(footnote.id)}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="workbench-outline-footnote-delete"
                          aria-label={`删除脚注 [^${footnote.id}]`}
                          title={`删除脚注 [^${footnote.id}] 及其正文引用`}
                          onClick={() => handleDeleteFootnote(footnote)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))
                )
              ) : headings.length === 0 ? (
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
      {pendingPaste && (
        <div className="workbench-paste-overlay">
          <section
            className="workbench-paste-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="knowledge-paste-title"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !pasteBusy) setPendingPaste(null);
            }}
          >
            <div className="workbench-paste-heading">
              <div>
                <small>CLIPBOARD / 导入检查</small>
                <h2 id="knowledge-paste-title">粘贴到知识库</h2>
              </div>
              <button
                type="button"
                disabled={pasteBusy}
                onClick={() => setPendingPaste(null)}
                aria-label="关闭粘贴检查"
              >
                ×
              </button>
            </div>
            <p className="workbench-paste-summary">
              文本 {pendingPaste.text.length.toLocaleString()} 字 · 链接{' '}
              {pendingPaste.linkCount} 条 · 图片{' '}
              {
                pendingPaste.media.filter(
                  (candidate) => candidate.kind !== 'svg',
                ).length
              }{' '}
              张 · SVG{' '}
              {
                pendingPaste.media.filter(
                  (candidate) => candidate.kind === 'svg',
                ).length
              }{' '}
              个
            </p>
            {pendingPaste.possibleMissingDiagram && (
              <p className="workbench-paste-warning">
                文本提到了图示，但剪贴板没有附带图形本体；图片链接可尝试导入，缺失的图示需单独复制或截图。
              </p>
            )}
            {pendingPaste.richHtml && (
              <p className="workbench-paste-warning">
                检测到网页富文本。本次保存为可编辑
                Markdown；原网页的复杂排版、表格和代码样式可能无法完整保留。
              </p>
            )}
            {pendingPaste.svgCount > 0 && (
              <p className="workbench-paste-footnote">
                SVG
                图形将经安全检查后作为可编辑源码写入笔记，并在阅读视图中渲染。
              </p>
            )}
            {pendingPaste.canvasCount > 0 && (
              <p className="workbench-paste-warning">
                检测到 {pendingPaste.canvasCount} 个
                Canvas。网页剪贴板通常不包含其像素；如列表中没有对应图片，请单独粘贴截图。
              </p>
            )}
            {pendingPaste.unsupportedCount > 0 && (
              <p className="workbench-paste-warning">
                另有 {pendingPaste.unsupportedCount} 个图片来源不支持或超过 10
                MB，未列入导入。
              </p>
            )}
            {pendingPaste.media.length > 0 && (
              <div className="workbench-paste-media" aria-label="待导入图形">
                {pendingPaste.media.map((candidate) => (
                  <label
                    key={candidate.key}
                    className="workbench-paste-media-row"
                  >
                    <input
                      type="checkbox"
                      checked={candidate.selected}
                      disabled={pasteBusy}
                      onChange={(event) =>
                        setPendingPaste((current) =>
                          current
                            ? {
                                ...current,
                                media: current.media.map((item) =>
                                  item.key === candidate.key
                                    ? {
                                        ...item,
                                        selected: event.target.checked,
                                      }
                                    : item,
                                ),
                              }
                            : null,
                        )
                      }
                    />
                    <span title={candidate.label}>{candidate.label}</span>
                    <small>
                      {candidate.kind === 'svg'
                        ? '可编辑 SVG'
                        : candidate.kind === 'remote'
                          ? '网络图片'
                          : '剪贴板图片'}
                    </small>
                  </label>
                ))}
              </div>
            )}
            <p className="workbench-paste-footnote">
              文本中的图片链接和 SVG
              源码会原位替换；剪贴板单独附带的图形会追加在末尾。普通链接保持为链接。
            </p>
            {pasteError && (
              <p className="workbench-paste-error" role="alert">
                {pasteError}
              </p>
            )}
            <div className="workbench-paste-actions">
              <button
                type="button"
                disabled={pasteBusy}
                onClick={() => setPendingPaste(null)}
              >
                取消
              </button>
              <button
                type="button"
                disabled={pasteBusy}
                onClick={() =>
                  applyPendingPaste(pendingPaste, pendingPaste.text)
                }
              >
                仅粘贴文本
              </button>
              <button
                type="button"
                className="is-primary"
                disabled={pasteBusy}
                autoFocus
                onClick={() => void confirmKnowledgePaste()}
              >
                {pasteBusy ? '正在导入…' : '确认粘贴'}
              </button>
            </div>
          </section>
        </div>
      )}
      {footnoteComposer && (
        <div
          className="workbench-paste-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setFootnoteComposer(null);
              setFootnoteComposerError('');
            }
          }}
        >
          <section
            className="workbench-paste-dialog workbench-fn-composer-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workbench-fn-composer-title"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setFootnoteComposer(null);
                setFootnoteComposerError('');
              }
            }}
          >
            <div className="workbench-paste-heading">
              <div>
                <small>
                  {footnoteComposer.mode === 'create'
                    ? `FOOTNOTE / 插入 [^${footnoteComposer.footnoteId}]`
                    : `FOOTNOTE / 编辑 [${footnoteComposer.indexLabel}] [^${footnoteComposer.footnoteId}]`}
                </small>
                <h2 id="workbench-fn-composer-title">
                  {footnoteComposer.mode === 'create'
                    ? '新建独立脚注'
                    : '编辑脚注内容'}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => {
                  setFootnoteComposer(null);
                  setFootnoteComposerError('');
                }}
                aria-label="关闭脚注编辑"
              >
                ×
              </button>
            </div>
            {footnoteComposer.anchorContext && (
              <p className="workbench-fn-composer-context">
                <span>定位上下文：</span>
                <code>{footnoteComposer.anchorContext}</code>
              </p>
            )}
            <form
              className="workbench-fn-composer-form"
              onSubmit={(event) => {
                event.preventDefault();
                submitFootnoteComposer();
              }}
            >
              <textarea
                autoFocus
                className="workbench-fn-composer-textarea seamind-fn-hover-scroll"
                aria-label="脚注内容"
                value={footnoteComposer.draft}
                placeholder="输入或直接粘贴多段解释、原文摘录、列表或代码块；空行后续段落会自动保持在脚注区块内…"
                onChange={(event) => {
                  const value = event.target.value;
                  setFootnoteComposer((prev) =>
                    prev ? { ...prev, draft: value } : null,
                  );
                  if (footnoteComposerError && value.trim()) {
                    setFootnoteComposerError('');
                  }
                }}
                onKeyDown={(event) => {
                  if (
                    (event.ctrlKey || event.metaKey) &&
                    event.key === 'Enter'
                  ) {
                    event.preventDefault();
                    submitFootnoteComposer();
                  }
                }}
              />
              {footnoteComposerError && (
                <p className="workbench-paste-error" role="alert">
                  {footnoteComposerError}
                </p>
              )}
              <p className="workbench-fn-composer-hint">
                与正文完全隔离编辑 · 自动生成规范缩进区块（兼容星系图与导览） ·
                Ctrl+Enter 保存
              </p>
              <div className="workbench-paste-actions workbench-fn-composer-actions">
                <button
                  type="button"
                  onClick={() => {
                    setFootnoteComposer(null);
                    setFootnoteComposerError('');
                  }}
                >
                  取消
                </button>
                <button type="submit" className="is-primary">
                  保存脚注
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </WorkbenchShell>
  );
}
