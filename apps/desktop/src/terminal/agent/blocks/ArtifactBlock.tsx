import { memo, useState } from 'react';
import type { AgentToolArtifact } from '../../../agent/types';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FileTextIcon,
  TableIcon,
} from '../AgentIcons';
import { TerminalOutputBlock } from './TerminalOutputBlock';

function toMarkdownTable(
  columns: string[],
  rows: Array<Array<string | number | boolean | null>>,
): string {
  const esc = (v: unknown) =>
    String(v ?? '')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, ' ');
  const head = `| ${columns.map(esc).join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map(esc).join(' | ')} |`).join('\n');
  return [head, sep, body].filter(Boolean).join('\n');
}

const TableArtifactCard = memo(function TableArtifactCard({
  artifact,
}: {
  artifact: Extract<AgentToolArtifact, { kind: 'table' }>;
}) {
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);

  return (
    <section
      className="ag-artifact-card ag-block-wide"
      aria-label={`表格产物：${artifact.title}`}
    >
      <div className="ag-artifact-head">
        <button
          type="button"
          className="ag-log-block-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDownIcon size={13} />
          ) : (
            <ChevronRightIcon size={13} />
          )}
          <TableIcon size={13} />
          <span>{artifact.title}</span>
          <span className="ag-log-block-meta">
            {artifact.columns.length} 列 ×{' '}
            {artifact.totalRows ?? artifact.rows.length} 行
            {artifact.truncated ? '（已节选预览）' : ''}
            {artifact.engine ? ` · ${artifact.engine}` : ''}
          </span>
        </button>
        <button
          type="button"
          className="ag-step-btn"
          onClick={() => {
            const md = toMarkdownTable(artifact.columns, artifact.rows);
            void navigator.clipboard?.writeText(md).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            });
          }}
        >
          {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
          <span>{copied ? '已复制' : '复制 Markdown'}</span>
        </button>
      </div>

      {expanded && (
        <div className="ag-artifact-table-wrap">
          <table className="ag-artifact-table">
            <thead>
              <tr>
                {artifact.columns.map((col, idx) => (
                  <th key={`${col}-${idx}`}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {artifact.rows.map((row, rIdx) => (
                <tr key={rIdx}>
                  {artifact.columns.map((_, cIdx) => (
                    <td key={cIdx}>
                      {row[cIdx] === null || row[cIdx] === undefined
                        ? 'NULL'
                        : String(row[cIdx])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
});

const FileRefArtifactCard = memo(function FileRefArtifactCard({
  artifact,
}: {
  artifact: Extract<AgentToolArtifact, { kind: 'file-ref' }>;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="ag-artifact-file-card">
      <FileTextIcon size={14} />
      <div className="ag-artifact-file-info">
        <strong>{artifact.title}</strong>
        <span title={artifact.path}>{artifact.path}</span>
      </div>
      <span className="ag-readonly-badge">
        {artifact.mediaType === 'image'
          ? '图表'
          : artifact.mediaType === 'data'
            ? '数据表'
            : '文件'}
      </span>
      <button
        type="button"
        className="ag-step-btn"
        onClick={() => {
          void navigator.clipboard?.writeText(artifact.path).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          });
        }}
      >
        {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
        <span>{copied ? '已复制路径' : '复制路径'}</span>
      </button>
    </div>
  );
});

export const ArtifactBlock = memo(function ArtifactBlock({
  artifact,
}: {
  artifact: AgentToolArtifact;
}) {
  if (artifact.kind === 'table') {
    return <TableArtifactCard artifact={artifact} />;
  }
  if (artifact.kind === 'file-ref') {
    return <FileRefArtifactCard artifact={artifact} />;
  }
  if (artifact.kind === 'terminal-output') {
    return (
      <TerminalOutputBlock
        title={artifact.title}
        stdout={artifact.stdout}
        stderr={artifact.stderr}
        isError={Boolean(artifact.stderr && !artifact.stdout)}
        defaultExpanded={false}
      />
    );
  }
  return null;
});
