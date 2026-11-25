import { memo, useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { cpp } from '@codemirror/lang-cpp';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import {
  Annotation,
  Compartment,
  EditorState,
  Prec,
  type Extension,
} from '@codemirror/state';
import { tags } from '@lezer/highlight';
import { basicSetup, EditorView } from 'codemirror';
import type { Theme } from '../app/app-storage';
import {
  resolveCodeLabFontFamilyCss,
  resolveCodeLabPalette,
  useCodeLabAppearance,
  type CodeLabEditorAppearance,
} from './codelab-appearance';
import type { TerminalCodeLabLanguage } from './terminal-types';

const externalSyncAnnotation = Annotation.define<boolean>();
const DEBOUNCE_COMMIT_MS = 140;
const cellLanguageCompartment = new Compartment();
const cellThemeCompartment = new Compartment();
const cellWrapCompartment = new Compartment();
const cellTabSizeCompartment = new Compartment();

const PY_KEYWORDS = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
]);

const C_KEYWORDS = new Set([
  'auto',
  'bool',
  'break',
  'case',
  'char',
  'class',
  'const',
  'constexpr',
  'continue',
  'default',
  'do',
  'double',
  'else',
  'enum',
  'extern',
  'false',
  'float',
  'for',
  'if',
  'include',
  'inline',
  'int',
  'long',
  'namespace',
  'new',
  'nullptr',
  'private',
  'public',
  'return',
  'short',
  'signed',
  'sizeof',
  'static',
  'struct',
  'switch',
  'template',
  'this',
  'true',
  'typedef',
  'typename',
  'union',
  'unsigned',
  'using',
  'virtual',
  'void',
  'while',
]);

const SQL_KEYWORDS = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP',
  'BY',
  'ORDER',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'OUTER',
  'FULL',
  'CROSS',
  'ON',
  'AS',
  'AND',
  'OR',
  'NOT',
  'IN',
  'IS',
  'NULL',
  'DISTINCT',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'UNION',
  'ALL',
  'WITH',
  'CREATE',
  'TABLE',
  'VIEW',
  'TEMP',
  'INSERT',
  'INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE',
  'DROP',
  'DESC',
  'ASC',
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'PRAGMA',
  'DESCRIBE',
  'SHOW',
]);

const R_KEYWORDS = new Set([
  'function',
  'if',
  'else',
  'for',
  'in',
  'while',
  'repeat',
  'next',
  'break',
  'return',
  'TRUE',
  'FALSE',
  'NULL',
  'NA',
  'Inf',
  'NaN',
  'library',
  'require',
  'data.frame',
  'summary',
  'head',
  'plot',
  'ggplot',
  'aes',
  'c',
  'list',
  'lm',
]);

interface StaticToken {
  kind: 'plain' | 'kw' | 'str' | 'num' | 'cmt' | 'fn';
  text: string;
}

function tokenizeStaticCodeLine(
  line: string,
  language: TerminalCodeLabLanguage,
): StaticToken[] {
  if (!line) return [{ kind: 'plain', text: ' ' }];
  const tokens: StaticToken[] = [];
  const isHashComment = language === 'python' || language === 'r';
  const isSql = language === 'sql';
  const keywords =
    language === 'python'
      ? PY_KEYWORDS
      : language === 'sql'
        ? SQL_KEYWORDS
        : language === 'r'
          ? R_KEYWORDS
          : C_KEYWORDS;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];
    // Comments
    if (
      (isHashComment && ch === '#') ||
      (isSql && ch === '-' && line[i + 1] === '-') ||
      (!isHashComment && !isSql && ch === '/' && line[i + 1] === '/')
    ) {
      tokens.push({ kind: 'cmt', text: line.slice(i) });
      break;
    }
    // Preprocessor directive in C/C++
    if (
      !isHashComment &&
      !isSql &&
      ch === '#' &&
      line.slice(0, i).trim() === ''
    ) {
      const m = /^#[a-zA-Z_]+/.exec(line.slice(i));
      if (m) {
        tokens.push({ kind: 'kw', text: m[0] });
        i += m[0].length;
        continue;
      }
    }
    // Strings
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      tokens.push({ kind: 'str', text: line.slice(i, j) });
      i = j;
      continue;
    }
    // Numbers
    if (/[0-9]/.test(ch) && (i === 0 || !/[a-zA-Z0-9_]/.test(line[i - 1]))) {
      const m =
        /^(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fFlLuU]*)/.exec(
          line.slice(i),
        );
      if (m) {
        tokens.push({ kind: 'num', text: m[0] });
        i += m[0].length;
        continue;
      }
    }
    // Identifiers / Keywords / Function calls
    if (/[a-zA-Z_]/.test(ch)) {
      const m = /^[a-zA-Z_][a-zA-Z0-9_.]*/.exec(line.slice(i));
      if (m) {
        const matchedWord = m[0];
        const isKw = isSql
          ? keywords.has(matchedWord.toUpperCase())
          : keywords.has(matchedWord);
        const nextChar = line[i + matchedWord.length];
        const kind: StaticToken['kind'] = isKw
          ? 'kw'
          : nextChar === '('
            ? 'fn'
            : 'plain';
        tokens.push({
          kind,
          text: matchedWord,
        });
        i += matchedWord.length;
        continue;
      }
    }
    // Plain char run
    let j = i + 1;
    while (j < line.length && !/[#"'0-9a-zA-Z_/-]/.test(line[j])) {
      j += 1;
    }
    tokens.push({ kind: 'plain', text: line.slice(i, j) });
    i = j;
  }

  return tokens;
}

function getLanguageExtension(
  kind: 'code' | 'markdown',
  language: TerminalCodeLabLanguage,
): Extension {
  if (kind === 'markdown') return markdown();
  if (language === 'python') return python();
  if (language === 'c' || language === 'cpp') return cpp();
  return [];
}

function buildCodeLabCmTheme(
  theme: Theme,
  appearance: CodeLabEditorAppearance,
): Extension {
  const palette = resolveCodeLabPalette(appearance.themePreset, theme);
  const fontFamily = resolveCodeLabFontFamilyCss(appearance.fontFamily);
  const lineNumberSize = `${Math.max(10, appearance.fontSize - 2.5)}px`;

  const editorTheme = EditorView.theme(
    {
      '&': {
        backgroundColor: palette.bg,
        color: palette.fg,
        fontSize: `${appearance.fontSize}px`,
        lineHeight: String(appearance.lineHeight),
        fontFamily,
      },
      '.cm-scroller': {
        fontFamily: 'inherit',
        lineHeight: 'inherit',
        overflowX: 'auto',
      },
      '.cm-content': {
        caretColor: palette.caret,
        padding: '12px 0',
      },
      '.cm-line': {
        padding: '0 18px 0 12px',
      },
      '.cm-gutters': {
        backgroundColor: palette.gutterBg,
        color: palette.gutterFg,
        borderRight: appearance.showLineNumbers
          ? `1px solid ${palette.border}`
          : 'none',
        minWidth: appearance.showLineNumbers ? '34px' : '0px',
        display: appearance.showLineNumbers ? 'flex' : 'none',
        userSelect: 'none',
      },
      '.cm-lineNumbers .cm-gutterElement': {
        padding: '0 8px 0 6px',
        fontSize: lineNumberSize,
        fontVariantNumeric: 'tabular-nums',
      },
      '.cm-foldGutter .cm-gutterElement': {
        padding: '0 3px 0 0',
        opacity: '0.55',
      },
      '.cm-activeLine': {
        backgroundColor: palette.activeLine,
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: palette.gutterActiveFg,
        fontWeight: '600',
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: palette.caret,
        borderLeftWidth: '1.5px',
      },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        {
          backgroundColor: `${palette.selection} !important`,
        },
      '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': {
        backgroundColor: palette.bracket,
        outline: `1px solid ${palette.caret}`,
      },
      '&.cm-focused': {
        outline: 'none',
      },
    },
    { dark: palette.isDark },
  );

  const highlightStyle = HighlightStyle.define([
    {
      tag: [
        tags.keyword,
        tags.controlKeyword,
        tags.definitionKeyword,
        tags.moduleKeyword,
        tags.operatorKeyword,
        tags.modifier,
      ],
      color: palette.tokKw,
      fontWeight: '500',
    },
    {
      tag: [tags.string, tags.special(tags.string), tags.regexp, tags.escape],
      color: palette.tokStr,
    },
    {
      tag: [tags.number, tags.integer, tags.float, tags.bool, tags.atom],
      color: palette.tokNum,
    },
    {
      tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
      color: palette.tokCmt,
      fontStyle: 'italic',
    },
    {
      tag: [
        tags.function(tags.variableName),
        tags.function(tags.propertyName),
        tags.definition(tags.variableName),
      ],
      color: palette.tokFn,
    },
    {
      tag: [tags.typeName, tags.className, tags.namespace, tags.macroName],
      color: palette.tokType,
    },
    {
      tag: [tags.propertyName, tags.attributeName, tags.self],
      color: palette.tokProp,
    },
    {
      tag: [tags.operator, tags.compareOperator, tags.logicOperator],
      color: palette.tokOp,
    },
    {
      tag: [tags.heading],
      color: palette.tokKw,
      fontWeight: '600',
    },
  ]);

  return [editorTheme, syntaxHighlighting(highlightStyle)];
}

export interface CodeLabEditorProps {
  cellId: string;
  value: string;
  language: TerminalCodeLabLanguage;
  kind: 'code' | 'markdown';
  theme: Theme;
  hydrated: boolean;
  shouldFocus: boolean;
  liveSourceMapRef: MutableRefObject<Map<string, string>>;
  onRequestHydrate: (cellId: string) => void;
  onCommitChange: (cellId: string, next: string) => void;
  onFocus: (cellId: string) => void;
  onBlur: (cellId: string) => void;
  onRunAndAdvance: (cellId: string) => void;
  onRunInPlace: (cellId: string) => void;
  onEscapeToCommandMode: (cellId: string) => void;
}

export const CodeLabEditor = memo(function CodeLabEditor({
  cellId,
  value,
  language,
  kind,
  theme,
  hydrated,
  shouldFocus,
  liveSourceMapRef,
  onRequestHydrate,
  onCommitChange,
  onFocus,
  onBlur,
  onRunAndAdvance,
  onRunInPlace,
  onEscapeToCommandMode,
}: CodeLabEditorProps) {
  const appearance = useCodeLabAppearance();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const cachedStateRef = useRef<EditorState | null>(null);
  const debounceTimerRef = useRef<number | null>(null);
  const pendingClickCoordsRef = useRef<{ x: number; y: number } | null>(null);
  const lastCommittedValueRef = useRef<string>(value);

  const callbacksRef = useRef({
    cellId,
    onCommitChange,
    onFocus,
    onBlur,
    onRunAndAdvance,
    onRunInPlace,
    onEscapeToCommandMode,
  });
  callbacksRef.current = {
    cellId,
    onCommitChange,
    onFocus,
    onBlur,
    onRunAndAdvance,
    onRunInPlace,
    onEscapeToCommandMode,
  };

  const flushPendingCommit = () => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const view = viewRef.current;
    if (!view) return;
    const docText = view.state.doc.toString();
    liveSourceMapRef.current.set(callbacksRef.current.cellId, docText);
    if (docText !== lastCommittedValueRef.current) {
      lastCommittedValueRef.current = docText;
      callbacksRef.current.onCommitChange(callbacksRef.current.cellId, docText);
    }
  };

  // Mount live CodeMirror 6 instance ONLY when hydrated; preserve EditorState in local ref on dehydrate.
  useEffect(() => {
    if (!hydrated) return;
    const host = hostRef.current;
    if (!host) return;

    const latestValue = liveSourceMapRef.current.get(cellId) ?? value;
    const cachedState = cachedStateRef.current;

    const buildFreshState = () =>
      EditorState.create({
        doc: latestValue,
        extensions: [
          basicSetup,
          cellLanguageCompartment.of(getLanguageExtension(kind, language)),
          cellThemeCompartment.of(buildCodeLabCmTheme(theme, appearance)),
          cellWrapCompartment.of(
            appearance.wordWrap ? EditorView.lineWrapping : [],
          ),
          cellTabSizeCompartment.of(EditorState.tabSize.of(appearance.tabSize)),
          Prec.highest(
            EditorView.domEventHandlers({
              keydown(event) {
                if (event.key === 'Enter' && event.shiftKey) {
                  event.preventDefault();
                  flushPendingCommit();
                  callbacksRef.current.onRunAndAdvance(
                    callbacksRef.current.cellId,
                  );
                  return true;
                }
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  flushPendingCommit();
                  callbacksRef.current.onRunInPlace(
                    callbacksRef.current.cellId,
                  );
                  return true;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  flushPendingCommit();
                  viewRef.current?.contentDOM.blur();
                  callbacksRef.current.onEscapeToCommandMode(
                    callbacksRef.current.cellId,
                  );
                  return true;
                }
                return false;
              },
              focus() {
                callbacksRef.current.onFocus(callbacksRef.current.cellId);
                return false;
              },
              blur() {
                flushPendingCommit();
                callbacksRef.current.onBlur(callbacksRef.current.cellId);
                return false;
              },
            }),
          ),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const isExternal = update.transactions.some((tr) =>
              tr.annotation(externalSyncAnnotation),
            );
            const nextDoc = update.state.doc.toString();
            liveSourceMapRef.current.set(callbacksRef.current.cellId, nextDoc);
            if (isExternal) return;

            if (debounceTimerRef.current !== null) {
              window.clearTimeout(debounceTimerRef.current);
            }
            debounceTimerRef.current = window.setTimeout(() => {
              debounceTimerRef.current = null;
              lastCommittedValueRef.current = nextDoc;
              callbacksRef.current.onCommitChange(
                callbacksRef.current.cellId,
                nextDoc,
              );
            }, DEBOUNCE_COMMIT_MS);
          }),
          EditorState.allowMultipleSelections.of(false),
        ],
      });

    // Reuse cached EditorState if doc still matches (preserves undo/redo history & scroll/selection).
    const initialState =
      cachedState && cachedState.doc.toString() === latestValue
        ? cachedState
        : buildFreshState();

    const view = new EditorView({ state: initialState, parent: host });
    viewRef.current = view;

    if (initialState === cachedState) {
      view.dispatch({
        effects: [
          cellLanguageCompartment.reconfigure(
            getLanguageExtension(kind, language),
          ),
          cellThemeCompartment.reconfigure(
            buildCodeLabCmTheme(theme, appearance),
          ),
          cellWrapCompartment.reconfigure(
            appearance.wordWrap ? EditorView.lineWrapping : [],
          ),
          cellTabSizeCompartment.reconfigure(
            EditorState.tabSize.of(appearance.tabSize),
          ),
        ],
      });
    }

    if (pendingClickCoordsRef.current) {
      const coords = pendingClickCoordsRef.current;
      pendingClickCoordsRef.current = null;
      requestAnimationFrame(() => {
        if (viewRef.current !== view) return;
        const pos = view.posAtCoords(coords);
        if (pos !== null) {
          view.dispatch({ selection: { anchor: pos } });
        }
        view.focus();
      });
    }

    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
        const finalDoc = view.state.doc.toString();
        liveSourceMapRef.current.set(callbacksRef.current.cellId, finalDoc);
        if (finalDoc !== lastCommittedValueRef.current) {
          lastCommittedValueRef.current = finalDoc;
          callbacksRef.current.onCommitChange(
            callbacksRef.current.cellId,
            finalDoc,
          );
        }
      }
      cachedStateRef.current = view.state;
      view.destroy();
      viewRef.current = null;
    };
    // Mount/unmount ONLY on hydration toggle or cell identity change.
    // Language, kind, and theme are hot-reconfigured via Compartment below.
  }, [hydrated, cellId]);

  // Zero-rebuild language / kind reconfiguration via Compartment
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: cellLanguageCompartment.reconfigure(
        getLanguageExtension(kind, language),
      ),
    });
  }, [kind, language]);

  // Zero-rebuild theme, typography, wrap & tabSize reconfiguration via Compartments
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        cellThemeCompartment.reconfigure(
          buildCodeLabCmTheme(theme, appearance),
        ),
        cellWrapCompartment.reconfigure(
          appearance.wordWrap ? EditorView.lineWrapping : [],
        ),
        cellTabSizeCompartment.reconfigure(
          EditorState.tabSize.of(appearance.tabSize),
        ),
      ],
    });
  }, [theme, appearance]);

  // Sync external value changes (file switch / format / snippet insert) without clobbering fast local typing
  useEffect(() => {
    if (value === lastCommittedValueRef.current) return;
    lastCommittedValueRef.current = value;
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      liveSourceMapRef.current.set(cellId, value);
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
        annotations: externalSyncAnnotation.of(true),
      });
    }
  }, [cellId, liveSourceMapRef, value]);

  // Focus editor when explicitly activated
  useEffect(() => {
    if (!hydrated || !shouldFocus) return;
    const raf = requestAnimationFrame(() => {
      viewRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [hydrated, shouldFocus]);

  const staticLines = useMemo(() => {
    if (hydrated) return null;
    const text = liveSourceMapRef.current.get(cellId) ?? value ?? '';
    return text.split('\n').map((line) => ({
      tokens:
        kind === 'markdown'
          ? [{ kind: 'plain' as const, text: line || ' ' }]
          : tokenizeStaticCodeLine(line, language),
    }));
  }, [cellId, hydrated, kind, language, liveSourceMapRef, value]);

  if (!hydrated && staticLines) {
    return (
      <div
        className={`codelab-static-code${appearance.showLineNumbers ? '' : ' is-no-line-numbers'}${appearance.wordWrap ? ' is-word-wrap' : ''}`}
        role="textbox"
        aria-multiline="true"
        aria-label={`${kind === 'markdown' ? 'Markdown' : language} 代码格（点击进入编辑）`}
        tabIndex={0}
        onMouseDown={(event) => {
          pendingClickCoordsRef.current = {
            x: event.clientX,
            y: event.clientY,
          };
          onRequestHydrate(cellId);
        }}
        onFocus={() => {
          onRequestHydrate(cellId);
        }}
      >
        {appearance.showLineNumbers && (
          <div className="codelab-static-gutter" aria-hidden="true">
            {staticLines.map((_, idx) => (
              <span key={idx}>{idx + 1}</span>
            ))}
          </div>
        )}
        <pre className="codelab-static-pre">
          {staticLines.map((line, idx) => (
            <div key={idx} className="codelab-static-line">
              {line.tokens.map((tok, tIdx) =>
                tok.kind === 'plain' ? (
                  <span key={tIdx}>{tok.text}</span>
                ) : (
                  <span key={tIdx} className={`cl-tok-${tok.kind}`}>
                    {tok.text}
                  </span>
                ),
              )}
            </div>
          ))}
        </pre>
      </div>
    );
  }

  return <div ref={hostRef} className="codelab-cm-host" />;
});
