import { memo, useEffect, useMemo, useRef, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import type { Theme } from '../app/app-storage';
import { parseSafeSvgElement } from '../app/svg-sanitize';

export interface CodeBlockActionCallbacks {
  onRunInCodeLab?: (language: string, code: string) => void;
  onSendToTerminal?: (command: string, execute?: boolean) => void;
  onSaveToKnowledge?: (content: string) => void;
}

type BlockNode =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'blockquote'; lines: string[] }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'code'; language: string; code: string }
  | { type: 'math'; formula: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'hr' };

function renderKatexHtml(formula: string, displayMode: boolean): string {
  try {
    return katex.renderToString(formula.trim(), {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: false,
    });
  } catch {
    return formula;
  }
}

function renderInlineSegments(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Matches: **bold**, `code`, $math$, or [label](url)
  const tokenRe = /(\*\*[^*]+\*\*|`[^`]+`|\$[^$\n]+\$|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let keyCounter = 0;

  for (const match of text.matchAll(tokenRe)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start));
    }
    const token = match[0];
    keyCounter += 1;
    if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={`b-${keyCounter}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code key={`c-${keyCounter}`} className="tui-inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('$') && token.endsWith('$')) {
      const html = renderKatexHtml(token.slice(1, -1), false);
      nodes.push(
        <span
          key={`m-${keyCounter}`}
          className="tui-inline-math"
          dangerouslySetInnerHTML={{ __html: html }}
        />,
      );
    } else if (token.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (linkMatch) {
        const href = linkMatch[2].trim();
        const isSafeUrl =
          href.startsWith('https://') ||
          href.startsWith('http://') ||
          href.startsWith('#');
        nodes.push(
          isSafeUrl ? (
            <a
              key={`a-${keyCounter}`}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="tui-link"
            >
              {linkMatch[1]}
            </a>
          ) : (
            <span key={`a-${keyCounter}`}>{linkMatch[1]}</span>
          ),
        );
      } else {
        nodes.push(token);
      }
    }
    lastIndex = start + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function parseBookMarkdownBlocks(markdown: string): BlockNode[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: BlockNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Fenced code block
    const fenceMatch = /^```([a-zA-Z0-9_+.-]*)\s*$/.exec(trimmed);
    if (fenceMatch) {
      const language = (fenceMatch[1] || 'text').toLowerCase();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: 'code', language, code: codeLines.join('\n') });
      continue;
    }

    // Display math block $$...$$
    if (trimmed.startsWith('$$')) {
      if (trimmed.endsWith('$$') && trimmed.length > 4) {
        blocks.push({ type: 'math', formula: trimmed.slice(2, -2) });
        i += 1;
        continue;
      }
      const mathLines: string[] = [trimmed.slice(2)];
      i += 1;
      while (i < lines.length && !lines[i].trim().endsWith('$$')) {
        mathLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) {
        mathLines.push(lines[i].trim().slice(0, -2));
        i += 1;
      }
      blocks.push({ type: 'math', formula: mathLines.join('\n') });
      continue;
    }

    // Horizontal rule
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    // Heading
    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2],
      });
      i += 1;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const qLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        qLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'blockquote', lines: qLines });
      continue;
    }

    // Table (header | ... \n | --- | ... )
    if (
      trimmed.includes('|') &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1].trim())
    ) {
      const parseCells = (row: string) =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
      const headers = parseCells(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes('|')) {
        rows.push(parseCells(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    // Lists
    const ulMatch = /^[-*+]\s+(.+)$/.exec(trimmed);
    const olMatch = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (ulMatch || olMatch) {
      const ordered = Boolean(olMatch);
      const items: string[] = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        const itemMatch = ordered
          ? /^\d+\.\s+(.+)$/.exec(t)
          : /^[-*+]\s+(.+)$/.exec(t);
        if (!itemMatch) break;
        items.push(itemMatch[1]);
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Paragraph until blank line or next block token
    const paraLines: string[] = [];
    while (i < lines.length) {
      const t = lines[i].trim();
      if (
        !t ||
        t.startsWith('```') ||
        t.startsWith('$$') ||
        /^#{1,4}\s+/.test(t) ||
        t.startsWith('>') ||
        /^[-*+]\s+/.test(t) ||
        /^\d+\.\s+/.test(t) ||
        /^(?:-{3,}|\*{3,}|_{3,})$/.test(t)
      ) {
        break;
      }
      paraLines.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: 'paragraph', text: paraLines.join('\n') });
  }

  return blocks;
}

function InteractiveCodeBlock({
  language,
  code,
  actions,
}: {
  language: string;
  code: string;
  actions?: CodeBlockActionCallbacks;
}) {
  const [copied, setCopied] = useState(false);
  const normalized = language.toLowerCase();
  const isLabLang =
    normalized === 'py' ||
    normalized === 'python' ||
    normalized === 'c' ||
    normalized === 'cpp' ||
    normalized === 'c++' ||
    normalized === 'cxx';
  const isShellLang =
    normalized === 'sh' ||
    normalized === 'bash' ||
    normalized === 'pwsh' ||
    normalized === 'powershell' ||
    normalized === 'ps1' ||
    normalized === 'cmd' ||
    normalized === 'zsh';

  const handleCopy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className="tui-code-block">
      <div className="tui-code-header">
        <span className="tui-code-lang">{language || 'text'}</span>
        <div className="tui-code-actions">
          {isLabLang && actions?.onRunInCodeLab && (
            <button
              type="button"
              className="tui-code-btn is-accent"
              onClick={() => actions.onRunInCodeLab?.(normalized, code)}
              title="将此代码推入 Euporie Code Lab 单元格并运行"
            >
              ▶ 在 Code Lab 运行
            </button>
          )}
          {isShellLang && actions?.onSendToTerminal && (
            <button
              type="button"
              className="tui-code-btn is-accent"
              onClick={() => actions.onSendToTerminal?.(code, false)}
              title="填入右侧 Shell 窗格（不自动回车）"
            >
              ↗ 填入右侧终端
            </button>
          )}
          <button type="button" className="tui-code-btn" onClick={handleCopy}>
            {copied ? '✓ 已复制' : '复制'}
          </button>
        </div>
      </div>
      <pre className="tui-code-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export const BookProseView = memo(function BookProseView({
  content,
  actions,
}: {
  content: string;
  actions?: CodeBlockActionCallbacks;
}) {
  const blocks = useMemo(() => parseBookMarkdownBlocks(content), [content]);

  return (
    <div className="tui-book-prose">
      {blocks.map((block, index) => {
        if (block.type === 'hr') {
          return <hr key={index} className="tui-book-hr" />;
        }
        if (block.type === 'heading') {
          const HeadingTag =
            block.level === 1
              ? 'h2'
              : block.level === 2
                ? 'h3'
                : block.level === 3
                  ? 'h4'
                  : 'h5';
          return (
            <HeadingTag key={index} className={`tui-h tui-h${block.level}`}>
              {renderInlineSegments(block.text)}
            </HeadingTag>
          );
        }
        if (block.type === 'blockquote') {
          return (
            <blockquote key={index} className="tui-blockquote">
              {block.lines.map((l, idx) => (
                <div key={idx}>{renderInlineSegments(l)}</div>
              ))}
            </blockquote>
          );
        }
        if (block.type === 'math') {
          const html = renderKatexHtml(block.formula, true);
          return (
            <div
              key={index}
              className="tui-block-math"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          );
        }
        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag key={index} className="tui-list">
              {block.items.map((item, idx) => (
                <li key={idx}>{renderInlineSegments(item)}</li>
              ))}
            </ListTag>
          );
        }
        if (block.type === 'table') {
          return (
            <div key={index} className="tui-table-wrap">
              <table className="tui-table">
                <thead>
                  <tr>
                    {block.headers.map((h, idx) => (
                      <th key={idx}>{renderInlineSegments(h)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rIdx) => (
                    <tr key={rIdx}>
                      {row.map((cell, cIdx) => (
                        <td key={cIdx}>{renderInlineSegments(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.type === 'code') {
          return (
            <InteractiveCodeBlock
              key={index}
              language={block.language}
              code={block.code}
              actions={actions}
            />
          );
        }
        return (
          <p key={index} className="tui-paragraph">
            {block.text.split('\n').map((line, lIdx, arr) => (
              <span key={lIdx}>
                {renderInlineSegments(line)}
                {lIdx < arr.length - 1 && <br />}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
});

export const SafeSvgOutput = memo(function SafeSvgOutput({
  svg,
}: {
  svg: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    el.innerHTML = '';
    const safeSvg = parseSafeSvgElement(svg);
    if (safeSvg) {
      el.appendChild(safeSvg);
    } else {
      const pre = document.createElement('pre');
      pre.textContent = '[SVG 内容未能通过安全清洗校验]';
      el.appendChild(pre);
    }
  }, [svg]);

  return <div ref={hostRef} className="codelab-svg-output" />;
});

export const KatexOutputBlock = memo(function KatexOutputBlock({
  latex,
}: {
  latex: string;
}) {
  const html = useMemo(() => {
    const stripped = latex
      .trim()
      .replace(/^\$\$|\$\$$/g, '')
      .replace(/^\$|\$$/g, '');
    return renderKatexHtml(stripped, true);
  }, [latex]);

  return (
    <div
      className="codelab-latex-output"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

export const SandboxedHtmlTableFrame = memo(function SandboxedHtmlTableFrame({
  html,
  theme = 'light',
}: {
  html: string;
  theme?: Theme;
}) {
  const srcDoc = useMemo(() => {
    const palette =
      theme === 'navy'
        ? {
            bg: '#08111f',
            fg: '#dce9f8',
            muted: '#7f9fc2',
            headBg: '#0d1a2e',
            zebraBg: 'rgba(100, 181, 246, 0.04)',
            border: '#193050',
          }
        : theme === 'purple'
          ? {
              bg: '#100a1d',
              fg: '#f0e6ff',
              muted: '#a48fbe',
              headBg: '#170f28',
              zebraBg: 'rgba(179, 152, 216, 0.05)',
              border: '#2d1c47',
            }
          : theme === 'dark'
            ? {
                bg: '#12161a',
                fg: '#d8dfe4',
                muted: '#86929b',
                headBg: '#171c21',
                zebraBg: 'rgba(255, 255, 255, 0.025)',
                border: '#242b33',
              }
            : {
                bg: '#ffffff',
                fg: '#1a2026',
                muted: '#616b74',
                headBg: '#f4f6f8',
                zebraBg: '#fafbfc',
                border: '#e2e6eb',
              };
    return `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin: 0; padding: 8px 10px; font-family: 'Inter', 'Segoe UI', system-ui, sans-serif; font-size: 12px; color: ${palette.fg}; background: ${palette.bg}; font-variant-numeric: tabular-nums; }
table { border-collapse: collapse; width: 100%; border: 1px solid ${palette.border}; }
th, td { border-bottom: 1px solid ${palette.border}; border-right: 1px solid ${palette.border}; padding: 5px 9px; text-align: left; }
th:last-child, td:last-child { border-right: 0; }
thead th { background: ${palette.headBg}; color: ${palette.muted}; font-size: 11px; font-weight: 600; letter-spacing: 0.02em; text-transform: none; }
tbody tr:nth-child(even) { background: ${palette.zebraBg}; }
tbody th { color: ${palette.muted}; font-weight: 500; font-family: 'JetBrains Mono', Consolas, monospace; font-size: 11px; }
</style></head><body>${html}</body></html>`;
  }, [html, theme]);

  return (
    <iframe
      title="DataFrame / HTML 输出"
      sandbox=""
      srcDoc={srcDoc}
      className="codelab-html-frame"
    />
  );
});
