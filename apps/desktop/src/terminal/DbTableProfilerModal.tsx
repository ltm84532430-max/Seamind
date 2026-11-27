import { useEffect, useState } from 'react';
import {
  terminalApi,
  type DataDbTableProfile,
  type DataDbTableSchema,
} from './terminal-api';
import {
  formatFileSizeCompact,
  type DataLabDbConnection,
} from './terminal-codelab-model';
import {
  buildConnectionInput,
  buildFederatedJoinSql,
  buildTablePythonSnippet,
  buildTableRSnippet,
  buildTableSelectSql,
  formatEstimatedRows,
} from './db-connection-utils';
import type { TerminalCodeLabLanguage } from './terminal-types';

export interface DbTableProfilerModalProps {
  connection: DataLabDbConnection | null;
  table: DataDbTableSchema | null;
  preferredPythonPath?: string | null;
  firstMountedAlias?: string;
  onClose: () => void;
  onInsertCell: (
    language: TerminalCodeLabLanguage,
    source: string,
    autoRun: boolean,
    sqlConnectionId?: string,
    sqlAttachDbIds?: string[],
  ) => void;
}

function formatNullFrac(val: number | null | undefined): string {
  if (val == null || !Number.isFinite(val)) return '—';
  return `${(val * 100).toFixed(1)}%`;
}

function formatDistinct(val: number | null | undefined): string {
  if (val == null || !Number.isFinite(val)) return '—';
  if (val < 0) {
    return `${Math.min(100, Math.round(-val * 100))}% 唯一`;
  }
  return `~${Math.round(val).toLocaleString()}`;
}

export function DbTableProfilerModal({
  connection,
  table,
  preferredPythonPath,
  firstMountedAlias,
  onClose,
  onInsertCell,
}: DbTableProfilerModalProps) {
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState<DataDbTableProfile | null>(null);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'columns' | 'sample' | 'indexes'>(
    'columns',
  );

  useEffect(() => {
    if (!connection || !table) return;
    let active = true;
    setLoading(true);
    setError('');
    setProfile(null);
    setActiveTab('columns');

    terminalApi
      .profileTable({
        connection: buildConnectionInput(connection, preferredPythonPath),
        schema: table.schema ?? null,
        tableName: table.name,
        sampleRows: 5,
      })
      .then((res) => {
        if (!active) return;
        if (!res.ok) {
          setError(res.error || '表结构剖析失败');
        } else {
          setProfile(res);
        }
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [connection, table, preferredPythonPath]);

  useEffect(() => {
    if (!connection || !table) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [connection, table, onClose]);

  if (!connection || !table) return null;

  const fullName =
    table.schema && table.schema !== 'main'
      ? `${table.schema}.${table.name}`
      : table.name;

  return (
    <div
      className="datalab-modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="datalab-modal-card is-wide"
        role="dialog"
        aria-modal="true"
        aria-label={`数据表剖析 · ${fullName}`}
      >
        <div className="datalab-modal-header">
          <div>
            <h3>
              {fullName}
              <span className="datalab-profiler-badge">
                {profile?.tableType || table.tableType}
              </span>
            </h3>
            <p className="datalab-modal-subtitle">
              {connection.name}
              {profile?.estimatedRows != null
                ? ` · ${formatEstimatedRows(profile.estimatedRows)}`
                : ''}
              {profile?.totalBytes != null
                ? ` · ${formatFileSizeCompact(profile.totalBytes)}`
                : ''}
              {profile?.columns.length ? ` · ${profile.columns.length} 列` : ''}
              {profile?.durationMs != null
                ? ` · 剖析耗时 ${profile.durationMs}ms（零全表扫描 pg_stats）`
                : ''}
            </p>
          </div>
          <button
            type="button"
            className="datalab-modal-close"
            onClick={onClose}
            aria-label="关闭窗口"
          >
            ×
          </button>
        </div>

        <div className="datalab-profiler-toolbar">
          <div className="datalab-profiler-tabs">
            <button
              type="button"
              className={`datalab-profiler-tab${activeTab === 'columns' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('columns')}
            >
              字段与分布 ({profile?.columns.length ?? table.columns.length})
            </button>
            <button
              type="button"
              className={`datalab-profiler-tab${activeTab === 'sample' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('sample')}
            >
              样本行 ({profile?.sampleRows.length ?? 0})
            </button>
            <button
              type="button"
              className={`datalab-profiler-tab${activeTab === 'indexes' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('indexes')}
            >
              索引与外键 (
              {(profile?.indexes.length ?? 0) +
                (profile?.foreignKeys.length ?? 0)}
              )
            </button>
          </div>

          <div className="datalab-profiler-actions">
            <button
              type="button"
              className="terminal-rail-mini-btn is-accent"
              onClick={() => {
                onInsertCell(
                  'sql',
                  buildTableSelectSql(
                    table.name,
                    table.schema,
                    connection.dbType,
                    100,
                  ),
                  true,
                  connection.id,
                );
                onClose();
              }}
            >
              SQL 预览
            </button>
            <button
              type="button"
              className="terminal-rail-mini-btn"
              onClick={() => {
                onInsertCell(
                  'python',
                  buildTablePythonSnippet(connection, table.name, table.schema),
                  false,
                );
                onClose();
              }}
            >
              PY 安全直连
            </button>
            <button
              type="button"
              className="terminal-rail-mini-btn"
              onClick={() => {
                onInsertCell(
                  'r',
                  buildTableRSnippet(connection, table.name, table.schema),
                  false,
                );
                onClose();
              }}
            >
              R 安全直连
            </button>
            {connection.dbType === 'postgres' && (
              <button
                type="button"
                className="terminal-rail-mini-btn"
                onClick={() => {
                  onInsertCell(
                    'sql',
                    buildFederatedJoinSql(
                      connection,
                      table.name,
                      table.schema,
                      firstMountedAlias,
                    ),
                    false,
                    '',
                    [connection.id],
                  );
                  onClose();
                }}
                title="以 DuckDB 只读 ATTACH 挂载该库，可与本地 Parquet 联合 JOIN"
              >
                DuckDB 联邦
              </button>
            )}
          </div>
        </div>

        <div className="datalab-modal-body">
          {profile?.comment && (
            <div className="datalab-profiler-comment">
              表注释：{profile.comment}
            </div>
          )}

          {loading && (
            <div className="datalab-profiler-state">
              正在读取系统统计视图与样本行…
            </div>
          )}

          {error && (
            <div className="datalab-inline-error" role="alert">
              {error}
            </div>
          )}

          {!loading && profile && activeTab === 'columns' && (
            <div className="datalab-profiler-table-wrap">
              <table className="datalab-profiler-table">
                <thead>
                  <tr>
                    <th>字段名</th>
                    <th>精确类型</th>
                    <th>可空</th>
                    <th>空值率</th>
                    <th>基数估计</th>
                    <th>范围 / 高频值</th>
                    <th>注释</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.columns.map((col) => (
                    <tr key={col.name}>
                      <td className="is-mono">
                        {col.isPrimaryKey && (
                          <span className="datalab-pk-tag">PK</span>
                        )}
                        {col.name}
                      </td>
                      <td className="is-mono is-muted">{col.dataType}</td>
                      <td>{col.nullable === false ? 'NOT NULL' : 'NULL'}</td>
                      <td className="is-mono">
                        {formatNullFrac(col.nullFraction)}
                      </td>
                      <td className="is-mono">
                        {formatDistinct(col.nDistinct)}
                      </td>
                      <td className="is-mono is-wrap">
                        {col.minValue || col.maxValue ? (
                          <div>
                            [{col.minValue ?? '…'} ~ {col.maxValue ?? '…'}]
                          </div>
                        ) : null}
                        {col.mostCommonVals.length > 0 ? (
                          <div className="datalab-mcv-text">
                            Top: {col.mostCommonVals.slice(0, 4).join(', ')}
                          </div>
                        ) : !col.minValue && !col.maxValue ? (
                          '—'
                        ) : null}
                      </td>
                      <td>{col.comment || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!loading && profile && activeTab === 'sample' && (
            <div className="datalab-profiler-table-wrap">
              {profile.sampleColumns.length === 0 ? (
                <div className="datalab-profiler-state">无样本行返回。</div>
              ) : (
                <table className="datalab-profiler-table">
                  <thead>
                    <tr>
                      {profile.sampleColumns.map((col) => (
                        <th key={col.name}>
                          <div>{col.name}</div>
                          <small>{col.dataType}</small>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {profile.sampleRows.map((row, idx) => (
                      <tr key={idx}>
                        {profile.sampleColumns.map((_, cIdx) => {
                          const v = row[cIdx];
                          return (
                            <td key={cIdx} className="is-mono">
                              {v === null || v === undefined
                                ? 'NULL'
                                : String(v)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {!loading && profile && activeTab === 'indexes' && (
            <div className="datalab-profiler-relations">
              <div className="datalab-profiler-subhead">
                主键 ({profile.primaryKeys.length})
              </div>
              <div className="datalab-profiler-kv">
                {profile.primaryKeys.length > 0
                  ? profile.primaryKeys.join(', ')
                  : '无显式主键'}
              </div>

              <div className="datalab-profiler-subhead">
                外键关联 ({profile.foreignKeys.length})
              </div>
              {profile.foreignKeys.length === 0 ? (
                <div className="datalab-profiler-kv">无外键约束</div>
              ) : (
                <div className="datalab-profiler-list">
                  {profile.foreignKeys.map((fk, idx) => (
                    <div key={idx} className="datalab-profiler-kv is-mono">
                      {fk.column} → {fk.refSchema ? `${fk.refSchema}.` : ''}
                      {fk.refTable}.{fk.refColumn}
                    </div>
                  ))}
                </div>
              )}

              <div className="datalab-profiler-subhead">
                索引 ({profile.indexes.length})
              </div>
              {profile.indexes.length === 0 ? (
                <div className="datalab-profiler-kv">无索引记录</div>
              ) : (
                <div className="datalab-profiler-list">
                  {profile.indexes.map((ix) => (
                    <div key={ix.name} className="datalab-profiler-index-item">
                      <div>
                        <strong>{ix.name}</strong>
                        {ix.primary && (
                          <span className="datalab-pk-tag">PRIMARY</span>
                        )}
                        {ix.unique && !ix.primary && (
                          <span className="datalab-pk-tag">UNIQUE</span>
                        )}
                      </div>
                      {ix.definition && (
                        <code className="datalab-profiler-index-def">
                          {ix.definition}
                        </code>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
