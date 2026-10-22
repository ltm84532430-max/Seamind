import { useEffect, useMemo, useRef, useState } from 'react';
import MarkdownEditor from '../MarkdownEditor';
import type { MarkdownEditorHandle } from '../MarkdownEditor';
import type { ActiveDocument } from './active-document';
import DiagramCanvas from './DiagramCanvas';
import { locatePeleErrorLine, renderPeleDiagram } from './pele-render';
import type { PeleDiagram, PeleFailure, PeleFailureCode } from './pele-render';
import { useDebouncedValue } from './use-debounced-value';
import WorkbenchShell from './WorkbenchShell';

export interface MermaidWorkbenchProps {
  document: ActiveDocument;
  dirty: boolean;
  statusText: string;
  onSourceChange(source: string): void;
  onSave(): void;
  onRename(title: string): Promise<boolean>;
}

const failureTitles: Record<PeleFailureCode, string> = {
  empty: '源码为空',
  'too-large': '源码过大',
  syntax: '语法错误',
  semantic: '语义错误',
  limit: '超出渲染限制',
  'unsupported-diagram': '无法识别图表类型',
  'unsafe-output': '输出未通过安全检查',
  unknown: '渲染失败',
};

const ignoreSelection = () => {};

/** A Mermaid diagram: its source on the left, the Pele rendering to pan and zoom on the right. */
export default function MermaidWorkbench({
  document,
  dirty,
  statusText,
  onSourceChange,
  onSave,
  onRename,
}: MermaidWorkbenchProps) {
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const [diagram, setDiagram] = useState<PeleDiagram | null>(null);
  const [failed, setFailed] = useState<{
    failure: PeleFailure;
    source: string;
  } | null>(null);
  const [rendering, setRendering] = useState(true);
  const source = useDebouncedValue(document.source, 250);

  useEffect(() => {
    let cancelled = false;
    setRendering(true);
    void renderPeleDiagram(source).then((outcome) => {
      if (cancelled) return;
      setRendering(false);
      if (outcome.ok) {
        setDiagram(outcome.diagram);
        setFailed(null);
      } else {
        // The last good rendering stays on screen next to the error, except when there is
        // nothing left to draw.
        if (outcome.failure.code === 'empty') setDiagram(null);
        setFailed({ failure: outcome.failure, source });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [source]);

  const errorLine = useMemo(
    () => (failed ? locatePeleErrorLine(failed.source, failed.failure) : null),
    [failed],
  );

  const showError = failed !== null && failed.failure.code !== 'empty';
  const lineCount = document.source.split('\n').length;

  return (
    <WorkbenchShell
      badge="MMD"
      label="Pele 图表工作台"
      title={document.title}
      path={document.relativePath}
      dirty={dirty}
      statusText={statusText}
      summary={`${lineCount} 行 · ${document.source.length} 字符`}
      layout="source-canvas"
      onSave={onSave}
      onRename={onRename}
    >
      <div className="workbench-split">
        <section
          className="workbench-pane workbench-source-pane"
          aria-label="图表源码"
        >
          <div className="workbench-pane-heading">
            <span className="pane-kicker">SOURCE</span>
            <strong>Mermaid</strong>
            <span className="workbench-format">.mmd</span>
          </div>
          <div className="markdown-editor-frame">
            <MarkdownEditor
              ref={editorRef}
              id={`pele-source-${document.session}`}
              value={document.source}
              language="plain"
              ariaLabel="Pele 图表源码"
              onChange={onSourceChange}
              onSelectionChange={ignoreSelection}
            />
          </div>
        </section>
        <section
          className="workbench-pane workbench-canvas-pane"
          aria-label="图表预览"
        >
          <div className="workbench-pane-heading">
            <span className="pane-kicker">PREVIEW</span>
            <strong>Pele 渲染</strong>
          </div>
          <DiagramCanvas
            svg={diagram?.svg ?? null}
            width={diagram?.width ?? 0}
            height={diagram?.height ?? 0}
            fitKey={String(document.session)}
            fileName={document.title}
            busy={rendering}
            emptyMessage={
              showError
                ? '源码有误，修好后图表会在这里渲染'
                : '输入 Mermaid 语法，图表会在这里渲染'
            }
            overlay={
              showError && (
                <div className="workbench-error" role="alert">
                  <div className="workbench-error-title">
                    {failureTitles[failed.failure.code]}
                    {errorLine !== null && `（第 ${errorLine} 行）`}
                  </div>
                  <pre className="workbench-error-detail">
                    {failed.failure.message}
                  </pre>
                  <div className="workbench-error-actions">
                    {errorLine !== null && (
                      <button
                        type="button"
                        onClick={() =>
                          editorRef.current?.selectLine(errorLine - 1, true)
                        }
                      >
                        跳到第 {errorLine} 行
                      </button>
                    )}
                    {diagram && <small>画布仍显示上一次成功的渲染</small>}
                  </div>
                </div>
              )
            }
          />
        </section>
      </div>
    </WorkbenchShell>
  );
}
