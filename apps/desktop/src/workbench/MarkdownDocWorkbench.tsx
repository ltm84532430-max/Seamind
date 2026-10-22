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

export interface MarkdownDocWorkbenchProps {
  document: ActiveDocument;
  dirty: boolean;
  statusText: string;
  theme: 'light' | 'dark';
  /** Turns Markdown into the sanitized HTML the preview shows. */
  renderPreview(markdown: string): { html: string; source: string };
  onSourceChange(source: string): void;
  onSave(): void;
  onRename(title: string): Promise<boolean>;
  /** Opens the file on the mind map canvas without changing what kind of file it is. */
  onOpenAsMindmap(): void;
  /** Turns the file into a mind map for good. */
  onConvertToMindmap(): void;
}

const ignoreSelection = () => {};
const headingSelector = 'h1, h2, h3, h4, h5, h6';

/** A Markdown document: source and rendered preview side by side, with its headings listed. */
export default function MarkdownDocWorkbench({
  document,
  dirty,
  statusText,
  theme,
  renderPreview,
  onSourceChange,
  onSave,
  onRename,
  onOpenAsMindmap,
  onConvertToMindmap,
}: MarkdownDocWorkbenchProps) {
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const panesRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef(document.source);
  sourceRef.current = document.source;
  // On a narrow window the outline starts hidden, so the source and the preview get the room.
  const [outlineOpen, setOutlineOpen] = useState(
    () => window.innerWidth > 1100,
  );

  const previewMarkdown = useDebouncedValue(document.source, 300);
  const preview = useMemo(
    () => renderPreview(previewMarkdown),
    [renderPreview, previewMarkdown],
  );
  const headings = useMemo(
    () => extractMarkdownHeadings(document.source),
    [document.source],
  );

  // A change made inside the preview (running or editing a code block) is written back into the
  // source, which is then what the editor shows.
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
    editorRef.current?.selectLine(heading.lineIndex, false);
    const preview = panesRef.current?.querySelector<HTMLElement>(
      '.markdown-rendered-preview',
    );
    const target = preview?.querySelectorAll(headingSelector)[index];
    if (!preview || !target) return;
    // scrollIntoView would also scroll the page around the app, which has no scrollbar to show it.
    preview.scrollTo({
      top:
        target.getBoundingClientRect().top -
        preview.getBoundingClientRect().top +
        preview.scrollTop -
        16,
      behavior: 'smooth',
    });
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
      summary={`${lineCount} 行 · ${document.source.length} 字符`}
      layout="source-preview-outline"
      onSave={onSave}
      onRename={onRename}
      actions={
        <>
          <button
            type="button"
            className={outlineOpen ? 'is-active' : ''}
            aria-pressed={outlineOpen}
            onClick={() => setOutlineOpen((open) => !open)}
            title="显示或隐藏标题目录"
          >
            目录
          </button>
          <button
            type="button"
            onClick={onOpenAsMindmap}
            title="在思维导图画布上查看这份文档，文件仍是文档"
          >
            以导图打开
          </button>
          <button
            type="button"
            onClick={onConvertToMindmap}
            title="把这份文档改成思维导图，之后在文件库里按导图打开"
          >
            转为导图
          </button>
        </>
      }
    >
      <div
        ref={panesRef}
        className={`workbench-split${outlineOpen ? '' : ' is-outline-hidden'}`}
      >
        <section
          className="workbench-pane workbench-source-pane"
          aria-label="Markdown 源码"
        >
          <div className="workbench-pane-heading">
            <span className="pane-kicker">SOURCE</span>
            <strong>Markdown</strong>
            <span className="workbench-format">.md</span>
          </div>
          <div className="markdown-editor-frame">
            <MarkdownEditor
              ref={editorRef}
              id={`doc-source-${document.session}`}
              value={document.source}
              onChange={onSourceChange}
              onSelectionChange={ignoreSelection}
            />
          </div>
        </section>
        <section
          className="workbench-pane workbench-preview-pane"
          aria-label="渲染预览"
        >
          <div className="workbench-pane-heading">
            <span className="pane-kicker">PREVIEW</span>
            <strong>渲染预览</strong>
          </div>
          <MarkdownPreview
            html={preview.html}
            source={preview.source}
            theme={theme}
            onCodeChange={handleCodeChange}
          />
        </section>
        {outlineOpen && (
          <nav
            className="workbench-pane workbench-outline-pane"
            aria-label="文档目录"
          >
            <div className="workbench-pane-heading">
              <span className="pane-kicker">OUTLINE</span>
              <strong>目录</strong>
              <span className="workbench-format">{headings.length}</span>
            </div>
            <div className="workbench-outline-list">
              {headings.length === 0 ? (
                <p className="workbench-outline-empty">
                  用 # 写标题，目录会出现在这里
                </p>
              ) : (
                headings.map((heading, index) => (
                  <button
                    type="button"
                    key={`${heading.lineIndex}-${index}`}
                    className="workbench-outline-item"
                    style={{ paddingLeft: 10 + (heading.depth - 1) * 14 }}
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
