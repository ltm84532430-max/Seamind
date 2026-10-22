import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { undo, redo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { Annotation, Transaction } from '@codemirror/state';
import { basicSetup, EditorView } from 'codemirror';
import { createMarkdownMinimap } from './markdown-minimap';
import type { MarkdownMinimapController } from './markdown-minimap';

export interface MarkdownSelection {
  from: number;
  to: number;
  lineIndex: number;
}

export interface MarkdownEditorHandle {
  applyDocument(
    markdown: string,
    options?: { lineIndex?: number; endLineIndex?: number; focus?: boolean },
  ): void;
  selectLine(lineIndex: number, focus?: boolean): void;
  selectLines(lineIndex: number, endLineIndex: number, focus?: boolean): void;
  getSelection(): MarkdownSelection | null;
  undo(): boolean;
  redo(): boolean;
  focus(): void;
}

const externalDocumentUpdate = Annotation.define<boolean>();

interface MarkdownEditorProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onSelectionChange: (selection: MarkdownSelection) => void;
  /** "plain" edits text that is not Markdown, such as a diagram's source, without highlighting. */
  language?: 'markdown' | 'plain';
  ariaLabel?: string;
}

function findChange(
  previous: string,
  next: string,
): { from: number; to: number; insert: string } {
  let from = 0;
  const sharedLength = Math.min(previous.length, next.length);
  while (from < sharedLength && previous[from] === next[from]) from += 1;
  if (from > 0 && /[\uD800-\uDBFF]/.test(previous[from - 1])) from -= 1;

  let suffix = 0;
  while (
    suffix < previous.length - from &&
    suffix < next.length - from &&
    previous[previous.length - suffix - 1] === next[next.length - suffix - 1]
  ) {
    suffix += 1;
  }
  const previousEnd = previous.length - suffix;
  if (suffix > 0 && /[\uDC00-\uDFFF]/.test(previous[previousEnd])) suffix -= 1;

  return {
    from,
    to: previous.length - suffix,
    insert: next.slice(from, next.length - suffix),
  };
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function linePosition(value: string, lineIndex: number): number {
  const lines = value.split(/\r?\n/);
  const target = Math.max(0, Math.min(lineIndex, lines.length - 1));
  let position = 0;
  for (let index = 0; index < target; index += 1)
    position += lines[index].length + 1;
  return position;
}

const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor(
    {
      id,
      value,
      onChange,
      onSelectionChange,
      language = 'markdown',
      ariaLabel = 'Markdown 源文本',
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const valueRef = useRef(value);
    const onChangeRef = useRef(onChange);
    const onSelectionChangeRef = useRef(onSelectionChange);
    valueRef.current = value;
    onChangeRef.current = onChange;
    onSelectionChangeRef.current = onSelectionChange;

    useEffect(() => {
      if (!hostRef.current) return;
      let minimap: MarkdownMinimapController | null = null;
      const view = new EditorView({
        doc: normalizeLineEndings(valueRef.current),
        extensions: [
          basicSetup,
          ...(language === 'markdown' ? [markdown()] : []),
          EditorView.lineWrapping,
          EditorView.editorAttributes.of({
            id,
            'aria-label': ariaLabel,
            spellcheck: 'false',
            class: 'markdown-editor-codemirror',
          }),
          EditorView.updateListener.of((update) => {
            minimap?.update();
            const isExternalDocumentUpdate = update.transactions.some(
              (transaction) => transaction.annotation(externalDocumentUpdate),
            );
            if (update.docChanged && !isExternalDocumentUpdate)
              onChangeRef.current(update.state.doc.toString());
            if (update.selectionSet || update.docChanged) {
              const selection = update.state.selection.main;
              const line = update.state.doc.lineAt(selection.from);
              onSelectionChangeRef.current({
                from: selection.from,
                to: selection.to,
                lineIndex: line.number - 1,
              });
            }
          }),
        ],
        parent: hostRef.current,
      });
      viewRef.current = view;
      minimap = createMarkdownMinimap(view, hostRef.current);
      return () => {
        minimap?.destroy();
        view.destroy();
        viewRef.current = null;
      };
    }, [id, language, ariaLabel]);

    useEffect(() => {
      const view = viewRef.current;
      const nextValue = normalizeLineEndings(value);
      if (!view || view.state.doc.toString() === nextValue) return;
      const change = findChange(view.state.doc.toString(), nextValue);
      view.dispatch({
        changes: change,
        annotations: [
          Transaction.addToHistory.of(false),
          externalDocumentUpdate.of(true),
        ],
      });
    }, [value]);

    useImperativeHandle(
      ref,
      () => ({
        applyDocument(markdownText, options = {}) {
          const view = viewRef.current;
          if (!view) return;
          markdownText = normalizeLineEndings(markdownText);
          const previous = view.state.doc.toString();
          const change = findChange(previous, markdownText);
          const selection =
            options.lineIndex === undefined
              ? undefined
              : (() => {
                  const lineCount = markdownText.split('\n').length;
                  const firstLineIndex = Math.max(
                    0,
                    Math.min(options.lineIndex!, lineCount - 1),
                  );
                  const lastLineIndex = Math.max(
                    firstLineIndex,
                    Math.min(
                      (options.endLineIndex ?? firstLineIndex + 1) - 1,
                      lineCount - 1,
                    ),
                  );
                  const from = linePosition(markdownText, firstLineIndex);
                  const lastLineStart = linePosition(
                    markdownText,
                    lastLineIndex,
                  );
                  const endOfLine = markdownText.indexOf('\n', lastLineStart);
                  const to = endOfLine < 0 ? markdownText.length : endOfLine;
                  return { anchor: from, head: to };
                })();
          view.dispatch({
            changes: change,
            ...(selection ? { selection, scrollIntoView: true } : {}),
            annotations: Transaction.userEvent.of('input'),
          });
          if (options.focus) view.focus();
        },
        selectLine(lineIndex, focus = false) {
          const view = viewRef.current;
          if (!view) return;
          const line = view.state.doc.line(
            Math.max(1, Math.min(lineIndex + 1, view.state.doc.lines)),
          );
          view.dispatch({
            selection: { anchor: line.from, head: line.to },
            scrollIntoView: true,
          });
          if (focus) view.focus();
        },
        selectLines(lineIndex, endLineIndex, focus = false) {
          const view = viewRef.current;
          if (!view) return;
          const firstLineNumber = Math.max(
            1,
            Math.min(lineIndex + 1, view.state.doc.lines),
          );
          const lastLineNumber = Math.max(
            firstLineNumber,
            Math.min(endLineIndex, view.state.doc.lines),
          );
          const firstLine = view.state.doc.line(firstLineNumber);
          const lastLine = view.state.doc.line(lastLineNumber);
          view.dispatch({
            selection: { anchor: firstLine.from, head: lastLine.to },
            scrollIntoView: true,
          });
          if (focus) view.focus();
        },
        getSelection() {
          const view = viewRef.current;
          if (!view) return null;
          const selection = view.state.selection.main;
          return {
            from: selection.from,
            to: selection.to,
            lineIndex: view.state.doc.lineAt(selection.from).number - 1,
          };
        },
        undo() {
          const view = viewRef.current;
          return view ? undo(view) : false;
        },
        redo() {
          const view = viewRef.current;
          return view ? redo(view) : false;
        },
        focus() {
          viewRef.current?.focus();
        },
      }),
      [],
    );

    return <div ref={hostRef} className="markdown-editor" />;
  },
);

export default MarkdownEditor;
