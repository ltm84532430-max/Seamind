import { memo, type PointerEvent as ReactPointerEvent } from 'react';
import { formatEstimatedRows } from './db-connection-utils';
import {
  getVisibleErColumns,
  hasTableSubmeta,
  type ErTable,
} from './db-er-model';
import { formatFileSizeCompact } from './terminal-codelab-model';

export interface DbErTableCardProps {
  table: ErTable;
  selected: boolean;
  connectedHighlight: boolean;
  dimmed: boolean;
  lodCompact: boolean;
  fkColumnNames: ReadonlySet<string>;
  issueCount: number;
  isLinkingTarget: boolean;
  onStartDrag: (
    tableId: string,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => void;
  onSelect: (tableId: string) => void;
  onToggleCollapse: (tableId: string) => void;
  onOpenProfiler: (tableId: string) => void;
  onQuickSql: (tableId: string) => void;
  onStartColumnLink: (
    tableId: string,
    columnName: string,
    side: 'left' | 'right',
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  onCompleteColumnLink: (tableId: string, columnName: string) => void;
}

export const DbErTableCard = memo(function DbErTableCard({
  table,
  selected,
  connectedHighlight,
  dimmed,
  lodCompact,
  fkColumnNames,
  issueCount,
  isLinkingTarget,
  onStartDrag,
  onSelect,
  onToggleCollapse,
  onOpenProfiler,
  onQuickSql,
  onStartColumnLink,
  onCompleteColumnLink,
}: DbErTableCardProps) {
  const showSubmeta = hasTableSubmeta(table);
  const visibleColumns = getVisibleErColumns(table, lodCompact);
  const hiddenCount = Math.max(0, table.columns.length - visibleColumns.length);
  const isLocal = table.sourceKind === 'local-file';
  const isView = table.tableType.toLowerCase().includes('view');

  return (
    <div
      className={`er-table-card${selected ? ' is-selected' : ''}${connectedHighlight ? ' is-connected' : ''}${dimmed ? ' is-dimmed' : ''}${isLocal ? ' is-local-file' : ''}${table.missingInLive ? ' is-missing' : ''}${isLinkingTarget ? ' is-link-target' : ''}`}
      data-er-table-id={table.id}
      style={{
        transform: `translate3d(${table.x}px, ${table.y}px, 0)`,
        width: `${table.width}px`,
      }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(table.id);
      }}
    >
      <div
        className="er-table-accent-bar"
        style={{ backgroundColor: table.color }}
      />

      <div
        className="er-table-header"
        onPointerDown={(e) => onStartDrag(table.id, e)}
        title={[
          table.id,
          table.alias ? `别名: ${table.alias}` : '',
          table.note || table.comment || '',
        ]
          .filter(Boolean)
          .join('\n')}
      >
        <div className="er-table-title-wrap">
          <button
            type="button"
            className="er-table-collapse-btn"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse(table.id);
            }}
            aria-label={table.collapsed ? '展开字段' : '折叠字段'}
            title={table.collapsed ? '展开字段' : '折叠字段'}
          >
            {table.collapsed ? '▸' : '▾'}
          </button>
          <span className="er-table-name">
            {table.schema &&
              table.schema !== 'main' &&
              table.schema !== 'default' &&
              table.schema !== 'local' && (
                <span className="er-table-schema">{table.schema}.</span>
              )}
            {table.name}
          </span>
          {table.alias && (
            <span className="er-table-alias" title={table.alias}>
              {table.alias}
            </span>
          )}
        </div>

        <div
          className="er-table-head-actions"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {issueCount > 0 && (
            <span
              className="er-table-issue-pill"
              title={`该表有 ${issueCount} 条体检提醒`}
            >
              !{issueCount}
            </span>
          )}
          {table.sourceKind === 'live' && !table.missingInLive && (
            <button
              type="button"
              className="er-table-mini-btn"
              onClick={(e) => {
                e.stopPropagation();
                onOpenProfiler(table.id);
              }}
              title="查看 pg_stats 实时剖析"
            >
              剖析
            </button>
          )}
          {!table.missingInLive && (
            <button
              type="button"
              className="er-table-mini-btn"
              onClick={(e) => {
                e.stopPropagation();
                onQuickSql(table.id);
              }}
              title="插入 SELECT 预览 SQL 格"
            >
              SQL
            </button>
          )}
        </div>
      </div>

      {showSubmeta && (
        <div className="er-table-submeta">
          {isLocal ? (
            <span className="er-submeta-tag is-local">
              {table.mountedFileFormat?.toUpperCase() || 'FILE'} · 本地联邦
            </span>
          ) : table.missingInLive ? (
            <span className="er-submeta-tag is-missing">实库已下线</span>
          ) : isView ? (
            <span className="er-submeta-tag is-view">{table.tableType}</span>
          ) : null}
          {table.estimatedRows != null && (
            <span>{formatEstimatedRows(table.estimatedRows)}</span>
          )}
          {table.totalBytes != null && table.totalBytes > 0 && (
            <span>{formatFileSizeCompact(table.totalBytes)}</span>
          )}
          <span>{table.columns.length} 列</span>
        </div>
      )}

      {!table.collapsed && (
        <div className="er-table-columns">
          {visibleColumns.length === 0 ? (
            <div className="er-col-empty">暂无字段定义</div>
          ) : (
            visibleColumns.map((col) => {
              const isFk = fkColumnNames.has(col.name.toLowerCase());
              const highNull =
                col.nullFraction != null && col.nullFraction >= 0.5;
              const tooltip = [
                `${table.id}.${col.name} : ${col.dataType}`,
                col.isPrimaryKey ? '主键 (PK)' : '',
                isFk ? '外键/关联列 (FK)' : '',
                !col.nullable ? 'NOT NULL' : 'NULL',
                col.defaultValue ? `DEFAULT ${col.defaultValue}` : '',
                col.nullFraction != null
                  ? `空值率: ${(col.nullFraction * 100).toFixed(1)}%`
                  : '',
                col.note ? `研究备注: ${col.note}` : '',
                col.comment ? `数据库注释: ${col.comment}` : '',
              ]
                .filter(Boolean)
                .join('\n');

              return (
                <div
                  key={col.name}
                  className={`er-col-row${col.isPrimaryKey ? ' is-pk' : ''}${isFk ? ' is-fk' : ''}`}
                  data-er-col-name={col.name}
                  title={tooltip}
                  onPointerUp={(e) => {
                    if (isLinkingTarget) {
                      e.stopPropagation();
                      onCompleteColumnLink(table.id, col.name);
                    }
                  }}
                >
                  <button
                    type="button"
                    className="er-col-port is-left"
                    aria-label={`从 ${table.name}.${col.name} 左侧拖出逻辑关联`}
                    title="拖拽到其他表字段建立逻辑关联"
                    onPointerDown={(e) =>
                      onStartColumnLink(table.id, col.name, 'left', e)
                    }
                    onPointerUp={(e) => {
                      if (isLinkingTarget) {
                        e.stopPropagation();
                        onCompleteColumnLink(table.id, col.name);
                      }
                    }}
                  />

                  <span className="er-col-badges">
                    {col.isPrimaryKey && (
                      <span className="er-key-pill is-pk">PK</span>
                    )}
                    {isFk && <span className="er-key-pill is-fk">FK</span>}
                    {col.isUnique && !col.isPrimaryKey && (
                      <span className="er-key-pill is-uk">UK</span>
                    )}
                    {!col.isPrimaryKey && !isFk && !col.isUnique && (
                      <span
                        className={`er-null-dot${col.nullable ? '' : ' is-nn'}`}
                      />
                    )}
                  </span>

                  <span className="er-col-name">
                    {col.name}
                    {col.note && (
                      <span className="er-col-note-dot" title={col.note}>
                        ·
                      </span>
                    )}
                    {highNull && (
                      <span
                        className="er-col-warn-dot"
                        title={`高缺失率 ${(col.nullFraction! * 100).toFixed(0)}%`}
                      />
                    )}
                  </span>

                  <span className="er-col-type">{col.dataType}</span>

                  <button
                    type="button"
                    className="er-col-port is-right"
                    aria-label={`从 ${table.name}.${col.name} 右侧拖出逻辑关联`}
                    title="拖拽到其他表字段建立逻辑关联"
                    onPointerDown={(e) =>
                      onStartColumnLink(table.id, col.name, 'right', e)
                    }
                    onPointerUp={(e) => {
                      if (isLinkingTarget) {
                        e.stopPropagation();
                        onCompleteColumnLink(table.id, col.name);
                      }
                    }}
                  />
                </div>
              );
            })
          )}
          {hiddenCount > 0 && (
            <div className="er-col-more-lod">
              缩略视图 · 还有 {hiddenCount} 列（放大查看）
            </div>
          )}
        </div>
      )}
    </div>
  );
});
