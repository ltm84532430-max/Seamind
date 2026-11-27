import { useMemo, useState } from 'react';
import type { DataDbTableSchema } from './terminal-api';
import {
  formatFileSizeCompact,
  type DataLabDbConnection,
} from './terminal-codelab-model';
import {
  buildFederatedJoinSql,
  buildTablePythonSnippet,
  buildTableRSnippet,
  buildTableSelectSql,
  formatEstimatedRows,
  groupTablesBySchema,
  quoteQualifiedTable,
} from './db-connection-utils';
import type { TerminalCodeLabLanguage } from './terminal-types';

export interface DbSchemaTreeProps {
  connection: DataLabDbConnection;
  firstMountedAlias?: string;
  onInsertCell: (
    language: TerminalCodeLabLanguage,
    source: string,
    autoRun: boolean,
    sqlConnectionId?: string,
    sqlAttachDbIds?: string[],
  ) => void;
  onProfileTable: (
    connection: DataLabDbConnection,
    table: DataDbTableSchema,
  ) => void;
  onNotify?: (message: string) => void;
}

export function DbSchemaTree({
  connection,
  firstMountedAlias,
  onInsertCell,
  onProfileTable,
  onNotify,
}: DbSchemaTreeProps) {
  const [filter, setFilter] = useState('');
  const [collapsedSchemas, setCollapsedSchemas] = useState<
    Record<string, boolean>
  >({});
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>(
    {},
  );

  const tables = useMemo(() => connection.tables ?? [], [connection.tables]);
  const groups = useMemo(
    () => groupTablesBySchema(tables, filter),
    [tables, filter],
  );

  const copyText = (text: string, label: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      onNotify?.(`已复制 ${label}`);
    });
  };

  if (tables.length === 0) {
    return (
      <div className="terminal-rail-empty-hint">
        暂无数据表，点击「刷新表」读取多 Schema 元数据。
      </div>
    );
  }

  return (
    <div className="datalab-schema-tree">
      {tables.length > 5 && (
        <input
          type="text"
          className="terminal-rail-search datalab-schema-search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜索 Schema / 表名 / 字段名…"
          aria-label={`过滤 ${connection.name} 中的数据表`}
        />
      )}

      {groups.length === 0 ? (
        <div className="terminal-rail-empty-hint">未匹配到相关表或字段。</div>
      ) : (
        <div className="datalab-schema-groups">
          {groups.map((group) => {
            const isSchemaCollapsed = Boolean(collapsedSchemas[group.schema]);
            const showSchemaHeader =
              groups.length > 1 ||
              (group.schema !== 'main' && group.schema !== 'default');

            return (
              <div key={group.schema} className="datalab-schema-group">
                {showSchemaHeader && (
                  <button
                    type="button"
                    className="datalab-schema-group-head"
                    onClick={() =>
                      setCollapsedSchemas((prev) => ({
                        ...prev,
                        [group.schema]: !prev[group.schema],
                      }))
                    }
                  >
                    <span className="datalab-schema-caret">
                      {isSchemaCollapsed ? '▸' : '▾'}
                    </span>
                    <span className="datalab-schema-name">{group.schema}</span>
                    <span className="datalab-col-type">
                      {group.tables.length} 表
                    </span>
                  </button>
                )}

                {!isSchemaCollapsed && (
                  <div className="datalab-table-list is-grouped">
                    {group.tables.map((tbl) => {
                      const tKey = `${tbl.schema ?? ''}.${tbl.name}`;
                      const isOpen = Boolean(expandedTables[tKey]);
                      const rowsText = formatEstimatedRows(
                        tbl.estimatedRows ?? tbl.rowCount,
                      );
                      const sizeText =
                        tbl.totalBytes != null
                          ? formatFileSizeCompact(tbl.totalBytes)
                          : '';
                      const isView =
                        tbl.tableType.includes('view') ||
                        tbl.tableType.includes('foreign');

                      return (
                        <div key={tKey} className="datalab-table-node">
                          <div className="datalab-table-row">
                            <button
                              type="button"
                              className="datalab-table-btn"
                              onClick={() =>
                                setExpandedTables((prev) => ({
                                  ...prev,
                                  [tKey]: !prev[tKey],
                                }))
                              }
                              title={`${tKey}${tbl.comment ? ` — ${tbl.comment}` : ''}\n点击展开字段与快捷分析动作`}
                            >
                              <span className="datalab-table-title">
                                <span className="datalab-schema-caret">
                                  {isOpen ? '▾' : '▸'}
                                </span>
                                <span className="datalab-table-name-txt">
                                  {tbl.name}
                                </span>
                                {isView && (
                                  <span className="datalab-view-tag">VIEW</span>
                                )}
                              </span>
                              <span className="datalab-col-type">
                                {rowsText || `${tbl.columns.length}列`}
                              </span>
                            </button>
                          </div>

                          {isOpen && (
                            <div className="datalab-table-detail">
                              <div className="datalab-table-submeta">
                                <span>{tbl.columns.length} 列</span>
                                {rowsText && <span>· {rowsText}</span>}
                                {sizeText && <span>· {sizeText}</span>}
                                {(tbl.primaryKeys?.length ?? 0) > 0 && (
                                  <span>· PK({tbl.primaryKeys?.length})</span>
                                )}
                              </div>

                              <div className="datalab-table-quick-actions">
                                <button
                                  type="button"
                                  className="terminal-rail-mini-btn is-accent"
                                  onClick={() =>
                                    onInsertCell(
                                      'sql',
                                      buildTableSelectSql(
                                        tbl.name,
                                        tbl.schema,
                                        connection.dbType,
                                        100,
                                      ),
                                      true,
                                      connection.id,
                                    )
                                  }
                                  title="插入前 100 行只读 SQL 预览格"
                                >
                                  预览
                                </button>
                                <button
                                  type="button"
                                  className="terminal-rail-mini-btn"
                                  onClick={() =>
                                    onProfileTable(connection, tbl)
                                  }
                                  title="查看 pg_stats 空值率/基数/索引/外键/样本行"
                                >
                                  剖析
                                </button>
                                <button
                                  type="button"
                                  className="terminal-rail-mini-btn"
                                  onClick={() =>
                                    onInsertCell(
                                      'python',
                                      buildTablePythonSnippet(
                                        connection,
                                        tbl.name,
                                        tbl.schema,
                                      ),
                                      false,
                                    )
                                  }
                                  title="插入无明文密码的 Python sm_db_query 格"
                                >
                                  PY
                                </button>
                                <button
                                  type="button"
                                  className="terminal-rail-mini-btn"
                                  onClick={() =>
                                    onInsertCell(
                                      'r',
                                      buildTableRSnippet(
                                        connection,
                                        tbl.name,
                                        tbl.schema,
                                      ),
                                      false,
                                    )
                                  }
                                  title="插入无明文密码的 R sm_db_query 格"
                                >
                                  R
                                </button>
                                {connection.dbType === 'postgres' && (
                                  <button
                                    type="button"
                                    className="terminal-rail-mini-btn"
                                    onClick={() =>
                                      onInsertCell(
                                        'sql',
                                        buildFederatedJoinSql(
                                          connection,
                                          tbl.name,
                                          tbl.schema,
                                          firstMountedAlias,
                                        ),
                                        false,
                                        '',
                                        [connection.id],
                                      )
                                    }
                                    title="DuckDB 联邦只读查询（可 JOIN 本地 Parquet）"
                                  >
                                    联邦
                                  </button>
                                )}
                              </div>

                              <div className="datalab-col-list is-db-cols">
                                {tbl.columns.map((col) => {
                                  const qual = `${quoteQualifiedTable(tbl.name, tbl.schema, connection.dbType)}."${col.name}"`;
                                  return (
                                    <button
                                      key={col.name}
                                      type="button"
                                      className="datalab-col-row is-clickable"
                                      onClick={() =>
                                        copyText(
                                          qual,
                                          `${tbl.name}.${col.name}`,
                                        )
                                      }
                                      title={`点击复制 ${qual}${col.comment ? `\n${col.comment}` : ''}`}
                                    >
                                      <span className="datalab-col-name-wrap">
                                        {col.isPrimaryKey && (
                                          <span className="datalab-pk-tag">
                                            PK
                                          </span>
                                        )}
                                        <span>{col.name}</span>
                                      </span>
                                      <span className="datalab-col-type">
                                        {col.dataType}
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
