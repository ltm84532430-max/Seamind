import { memo, useMemo, useState } from 'react';
import { formatEstimatedRows } from './db-connection-utils';
import {
  ER_NOTE_COLORS,
  ER_SCHEMA_PALETTE,
  type ErCanvasNote,
  type ErCardinality,
  type ErDiagramState,
  type ErRelation,
  type ErSubjectArea,
  type ErTable,
} from './db-er-model';
import {
  formatFileSizeCompact,
  type DataLabMountedFile,
} from './terminal-codelab-model';

export type ErSidebarTab =
  'tables' | 'relations' | 'areas' | 'notes' | 'types' | 'issues';

export interface DbErSidebarProps {
  diagram: ErDiagramState;
  activeTab: ErSidebarTab;
  selectedTableId: string | null;
  selectedRelationId: string | null;
  mountedFiles: readonly DataLabMountedFile[];
  pinnedLocalFiles: readonly string[];
  onChangeTab: (tab: ErSidebarTab) => void;
  onFocusTable: (tableId: string) => void;
  onFocusRelation: (relationId: string) => void;
  onFocusArea: (area: ErSubjectArea) => void;
  onFocusNote: (note: ErCanvasNote) => void;
  onUpdateTableMeta: (
    tableId: string,
    patch: {
      alias?: string;
      note?: string;
      color?: string;
      collapsed?: boolean;
    },
  ) => void;
  onUpdateColumnNote: (
    tableId: string,
    columnName: string,
    note: string,
  ) => void;
  onTogglePinLocalFile: (alias: string) => void;
  onCreateLogicalRelation: (
    sourceTableId: string,
    sourceColumn: string,
    targetTableId: string,
    targetColumn: string,
    cardinality?: ErCardinality,
  ) => void;
  onAcceptInferred: (rel: ErRelation) => void;
  onDismissInferred: (relId: string) => void;
  onDeleteLogicalRelation: (relId: string) => void;
  onGenerateRelationCode: (
    rel: ErRelation,
    kind: 'sql' | 'python' | 'r' | 'duckdb',
  ) => void;
  onAddArea: () => void;
  onUpdateArea: (areaId: string, patch: Partial<ErSubjectArea>) => void;
  onDeleteArea: (areaId: string) => void;
  onAddNote: () => void;
  onUpdateNote: (noteId: string, patch: Partial<ErCanvasNote>) => void;
  onDeleteNote: (noteId: string) => void;
  onOpenProfiler: (tableId: string) => void;
}

export const DbErSidebar = memo(function DbErSidebar({
  diagram,
  activeTab,
  selectedTableId,
  selectedRelationId,
  mountedFiles,
  pinnedLocalFiles,
  onChangeTab,
  onFocusTable,
  onFocusRelation,
  onFocusArea,
  onFocusNote,
  onUpdateTableMeta,
  onUpdateColumnNote,
  onTogglePinLocalFile,
  onCreateLogicalRelation,
  onAcceptInferred,
  onDismissInferred,
  onDeleteLogicalRelation,
  onGenerateRelationCode,
  onAddArea,
  onUpdateArea,
  onDeleteArea,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  onOpenProfiler,
}: DbErSidebarProps) {
  const [tableQuery, setTableQuery] = useState('');
  const [relFilter, setRelFilter] = useState<
    'all' | 'physical' | 'logical' | 'inferred'
  >('all');
  const [issueFilter, setIssueFilter] = useState<
    'all' | 'modeling' | 'data-quality'
  >('all');
  const [newRelOpen, setNewRelOpen] = useState(false);
  const [newSrcTbl, setNewSrcTbl] = useState('');
  const [newSrcCol, setNewSrcCol] = useState('');
  const [newTgtTbl, setNewTgtTbl] = useState('');
  const [newTgtCol, setNewTgtCol] = useState('');
  const [newCard, setNewCard] = useState<ErCardinality>('N:1');

  const selectedTable = useMemo(
    () => diagram.tables.find((t) => t.id === selectedTableId) ?? null,
    [diagram.tables, selectedTableId],
  );

  const groupedTables = useMemo(() => {
    const q = tableQuery.trim().toLowerCase();
    const list = q
      ? diagram.tables.filter(
          (t) =>
            t.id.toLowerCase().includes(q) ||
            (t.alias && t.alias.toLowerCase().includes(q)) ||
            t.columns.some((c) => c.name.toLowerCase().includes(q)),
        )
      : diagram.tables;
    const bySchema = new Map<string, ErTable[]>();
    for (const t of list) {
      const key =
        t.sourceKind === 'local-file' ? '本地联邦文件' : t.schema || 'default';
      const arr = bySchema.get(key);
      if (arr) arr.push(t);
      else bySchema.set(key, [t]);
    }
    return Array.from(bySchema.entries());
  }, [diagram.tables, tableQuery]);

  const filteredRelations = useMemo(
    () =>
      relFilter === 'all'
        ? diagram.relations
        : diagram.relations.filter((r) => r.kind === relFilter),
    [diagram.relations, relFilter],
  );

  const filteredIssues = useMemo(
    () =>
      issueFilter === 'all'
        ? diagram.issues
        : diagram.issues.filter((i) => i.category === issueFilter),
    [diagram.issues, issueFilter],
  );

  const warnIssueCount = useMemo(
    () =>
      diagram.issues.filter(
        (i) => i.severity === 'error' || i.severity === 'warning',
      ).length,
    [diagram.issues],
  );

  const srcTableObj = diagram.tables.find((t) => t.id === newSrcTbl);
  const tgtTableObj = diagram.tables.find((t) => t.id === newTgtTbl);

  const pinnedSet = useMemo(
    () => new Set(pinnedLocalFiles),
    [pinnedLocalFiles],
  );

  return (
    <aside className="er-sidebar" aria-label="ER 图谱建模与体检侧栏">
      <div className="er-sidebar-tabs" role="tablist">
        {(
          [
            ['tables', '表', diagram.tables.length, false],
            ['relations', '关系', diagram.relations.length, false],
            ['areas', '分区', diagram.subjectAreas.length, false],
            ['notes', '便签', diagram.notes.length, false],
            ['types', '类型', diagram.customTypes.length, false],
            ['issues', '体检', diagram.issues.length, warnIssueCount > 0],
          ] as const
        ).map(([id, label, count, warn]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            className={`er-sidebar-tab${activeTab === id ? ' is-active' : ''}`}
            onClick={() => onChangeTab(id)}
          >
            <span>{label}</span>
            <span className={`er-sidebar-tab-count${warn ? ' is-warn' : ''}`}>
              {count}
            </span>
          </button>
        ))}
      </div>

      <div className="er-sidebar-body">
        {/* TAB 1: TABLES */}
        {activeTab === 'tables' && (
          <>
            <input
              type="search"
              className="er-side-search"
              value={tableQuery}
              onChange={(e) => setTableQuery(e.target.value)}
              placeholder="搜索表名、业务别名或字段…"
              aria-label="搜索表或字段"
            />

            {selectedTable && (
              <div className="er-side-editor">
                <div className="er-side-section-head">
                  <span>编辑本地研究批注 · {selectedTable.name}</span>
                  {selectedTable.sourceKind === 'live' &&
                    !selectedTable.missingInLive && (
                      <button
                        type="button"
                        className="er-pop-btn is-accent"
                        onClick={() => onOpenProfiler(selectedTable.id)}
                      >
                        实库剖析
                      </button>
                    )}
                </div>

                <label className="er-side-field">
                  <span>中文业务别名（不修改只读原库）</span>
                  <input
                    type="text"
                    value={selectedTable.alias ?? ''}
                    onChange={(e) =>
                      onUpdateTableMeta(selectedTable.id, {
                        alias: e.target.value,
                      })
                    }
                    placeholder="例如：FRED 宏观观测值主表"
                  />
                </label>

                <label className="er-side-field">
                  <span>表研究说明 / 口径备注</span>
                  <textarea
                    value={selectedTable.note ?? ''}
                    onChange={(e) =>
                      onUpdateTableMeta(selectedTable.id, {
                        note: e.target.value,
                      })
                    }
                    placeholder="记录粒度、更新频率、去重口径…"
                  />
                </label>

                <div className="er-side-field">
                  <span>卡片主题色</span>
                  <div className="er-swatch-row">
                    {ER_SCHEMA_PALETTE.map((hex) => (
                      <button
                        key={hex}
                        type="button"
                        className={`er-swatch-btn${selectedTable.color === hex ? ' is-active' : ''}`}
                        style={{ backgroundColor: hex }}
                        onClick={() =>
                          onUpdateTableMeta(selectedTable.id, { color: hex })
                        }
                        aria-label={`配色 ${hex}`}
                      />
                    ))}
                  </div>
                </div>

                {selectedTable.columns.length > 0 && (
                  <div className="er-side-field">
                    <span>字段研究注释（悬停画布可见）</span>
                    {selectedTable.columns.slice(0, 14).map((col) => (
                      <div key={col.name} className="er-side-col-note-row">
                        <span
                          className="er-side-col-note-name"
                          title={col.name}
                        >
                          {col.name}
                        </span>
                        <input
                          type="text"
                          className="er-side-col-note-input"
                          value={col.note ?? ''}
                          onChange={(e) =>
                            onUpdateColumnNote(
                              selectedTable.id,
                              col.name,
                              e.target.value,
                            )
                          }
                          placeholder={col.comment || '中文释义…'}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {groupedTables.map(([schema, list]) => (
              <div key={schema}>
                <div className="er-side-group-title">
                  <span
                    className="er-side-color-dot"
                    style={{ backgroundColor: list[0]?.color || '#467b5e' }}
                  />
                  <span>
                    {schema} ({list.length})
                  </span>
                </div>
                <div className="er-side-list">
                  {list.map((tbl) => (
                    <div
                      key={tbl.id}
                      className={`er-side-card${selectedTableId === tbl.id ? ' is-selected' : ''}`}
                      onClick={() => onFocusTable(tbl.id)}
                    >
                      <div className="er-side-card-top">
                        <span className="er-side-card-name" title={tbl.id}>
                          {tbl.name}
                        </span>
                        <span className="er-side-card-meta">
                          {tbl.columns.length} 列
                        </span>
                      </div>
                      <div className="er-side-card-meta">
                        {tbl.alias && <span>{tbl.alias}</span>}
                        {tbl.estimatedRows != null && (
                          <span>{formatEstimatedRows(tbl.estimatedRows)}</span>
                        )}
                        {tbl.totalBytes != null && tbl.totalBytes > 0 && (
                          <span>{formatFileSizeCompact(tbl.totalBytes)}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {mountedFiles.length > 0 && !diagram.isOffline && (
              <div className="er-side-editor">
                <div className="er-side-section-head">
                  <span>本地 Parquet/CSV 跨源挂载</span>
                </div>
                <div className="er-side-list">
                  {mountedFiles.map((f) => {
                    const pinned = pinnedSet.has(f.alias);
                    return (
                      <div key={f.id} className="er-side-card">
                        <div className="er-side-card-top">
                          <span className="er-side-card-name">{f.alias}</span>
                          <button
                            type="button"
                            className={`er-pop-btn${pinned ? ' is-accent' : ''}`}
                            onClick={() => onTogglePinLocalFile(f.alias)}
                          >
                            {pinned ? '已入画布' : '+ 放入画布'}
                          </button>
                        </div>
                        <div className="er-side-card-meta">
                          <span>{f.format.toUpperCase()}</span>
                          {f.rowCount != null && (
                            <span>{f.rowCount.toLocaleString()} 行</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}

        {/* TAB 2: RELATIONSHIPS */}
        {activeTab === 'relations' && (
          <>
            <div className="er-side-section-head">
              <span>关系拓扑 ({filteredRelations.length})</span>
              <button
                type="button"
                className="er-pop-btn is-accent"
                onClick={() => setNewRelOpen((v) => !v)}
              >
                {newRelOpen ? '收起' : '+ 新建逻辑关联'}
              </button>
            </div>

            {newRelOpen && (
              <div className="er-side-editor">
                <label className="er-side-field">
                  <span>源表（外键侧）</span>
                  <select
                    value={newSrcTbl}
                    onChange={(e) => {
                      setNewSrcTbl(e.target.value);
                      setNewSrcCol('');
                    }}
                  >
                    <option value="">选择源表…</option>
                    {diagram.tables.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="er-side-field">
                  <span>源字段</span>
                  <select
                    value={newSrcCol}
                    onChange={(e) => setNewSrcCol(e.target.value)}
                    disabled={!srcTableObj}
                  >
                    <option value="">选择源字段…</option>
                    {(srcTableObj?.columns ?? []).map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name} ({c.dataType})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="er-side-field">
                  <span>目标表（主表侧）</span>
                  <select
                    value={newTgtTbl}
                    onChange={(e) => {
                      setNewTgtTbl(e.target.value);
                      setNewTgtCol('');
                    }}
                  >
                    <option value="">选择目标表…</option>
                    {diagram.tables.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="er-side-field">
                  <span>目标字段</span>
                  <select
                    value={newTgtCol}
                    onChange={(e) => setNewTgtCol(e.target.value)}
                    disabled={!tgtTableObj}
                  >
                    <option value="">选择目标字段…</option>
                    {(tgtTableObj?.columns ?? []).map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name} ({c.dataType})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="er-side-field">
                  <span>基数</span>
                  <select
                    value={newCard}
                    onChange={(e) =>
                      setNewCard(e.target.value as ErCardinality)
                    }
                  >
                    {(['N:1', '1:N', '1:1', 'N:M', '0:1', '0:N'] as const).map(
                      (c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <button
                  type="button"
                  className="er-pop-btn is-primary"
                  disabled={
                    !newSrcTbl || !newSrcCol || !newTgtTbl || !newTgtCol
                  }
                  onClick={() => {
                    onCreateLogicalRelation(
                      newSrcTbl,
                      newSrcCol,
                      newTgtTbl,
                      newTgtCol,
                      newCard,
                    );
                    setNewRelOpen(false);
                  }}
                >
                  添加逻辑关联
                </button>
              </div>
            )}

            <div className="er-side-filter-pills">
              {(
                [
                  ['all', '全部'],
                  ['physical', '物理 FK'],
                  ['logical', '逻辑关联'],
                  ['inferred', '智能推断'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`er-filter-pill${relFilter === id ? ' is-active' : ''}`}
                  onClick={() => setRelFilter(id)}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="er-side-list">
              {filteredRelations.length === 0 ? (
                <div className="er-side-card-meta">
                  暂无匹配关系。可直接在画布上从任意字段两侧小圆点拖拽连线。
                </div>
              ) : (
                filteredRelations.map((rel) => (
                  <div
                    key={rel.id}
                    className={`er-side-card${selectedRelationId === rel.id ? ' is-selected' : ''}`}
                    onClick={() => onFocusRelation(rel.id)}
                  >
                    <div className="er-side-card-top">
                      <span className={`er-rel-kind-badge is-${rel.kind}`}>
                        {rel.kind === 'physical'
                          ? '物理'
                          : rel.kind === 'logical'
                            ? '逻辑'
                            : '推断'}
                      </span>
                      <span className="er-side-card-meta">
                        {rel.cardinality}
                      </span>
                    </div>
                    <div className="er-side-card-name">
                      {rel.sourceTableId}.{rel.sourceColumn} →{' '}
                      {rel.targetTableId}.{rel.targetColumn}
                    </div>
                    {rel.reason && (
                      <div className="er-side-card-meta">{rel.reason}</div>
                    )}
                    <div
                      className="er-side-row-actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {rel.kind === 'inferred' && (
                        <>
                          <button
                            type="button"
                            className="er-pop-btn is-primary"
                            onClick={() => onAcceptInferred(rel)}
                          >
                            采纳
                          </button>
                          <button
                            type="button"
                            className="er-pop-btn"
                            onClick={() => onDismissInferred(rel.id)}
                          >
                            忽略
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="er-pop-btn is-accent"
                        onClick={() => onGenerateRelationCode(rel, 'sql')}
                      >
                        JOIN SQL
                      </button>
                      {rel.kind === 'logical' && (
                        <button
                          type="button"
                          className="er-pop-btn is-danger"
                          onClick={() => onDeleteLogicalRelation(rel.id)}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {/* TAB 3: SUBJECT AREAS */}
        {activeTab === 'areas' && (
          <>
            <div className="er-side-section-head">
              <span>领域分区 ({diagram.subjectAreas.length})</span>
              <button
                type="button"
                className="er-pop-btn is-accent"
                onClick={onAddArea}
              >
                + 新建分区
              </button>
            </div>
            <div className="er-side-list">
              {diagram.subjectAreas.map((area) => (
                <div
                  key={area.id}
                  className="er-side-card"
                  onClick={() => onFocusArea(area)}
                >
                  <div
                    className="er-side-card-top"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="text"
                      className="er-side-col-note-input"
                      value={area.name}
                      onChange={(e) =>
                        onUpdateArea(area.id, { name: e.target.value })
                      }
                      aria-label="分区名称"
                    />
                    <button
                      type="button"
                      className="er-pop-btn is-danger"
                      onClick={() => onDeleteArea(area.id)}
                    >
                      删除
                    </button>
                  </div>
                  <div
                    className="er-swatch-row"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {ER_SCHEMA_PALETTE.map((hex) => (
                      <button
                        key={hex}
                        type="button"
                        className={`er-swatch-btn${area.color === hex ? ' is-active' : ''}`}
                        style={{ backgroundColor: hex }}
                        onClick={() => onUpdateArea(area.id, { color: hex })}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* TAB 4: CANVAS NOTES */}
        {activeTab === 'notes' && (
          <>
            <div className="er-side-section-head">
              <span>画布研究便签 ({diagram.notes.length})</span>
              <button
                type="button"
                className="er-pop-btn is-accent"
                onClick={onAddNote}
              >
                + 新建便签
              </button>
            </div>
            <div className="er-side-list">
              {diagram.notes.length === 0 ? (
                <div className="er-side-card-meta">
                  点击「+ 新建便签」在画布记录业务口径或让右侧 Agent 自动写入。
                </div>
              ) : (
                diagram.notes.map((n) => (
                  <div
                    key={n.id}
                    className="er-side-card"
                    onClick={() => onFocusNote(n)}
                  >
                    <div className="er-side-card-top">
                      <span className="er-side-card-name">
                        {n.title || '未命名便签'}
                      </span>
                      <button
                        type="button"
                        className="er-pop-btn is-danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteNote(n.id);
                        }}
                      >
                        删除
                      </button>
                    </div>
                    <div className="er-side-card-meta">
                      {(n.content || '（空）').slice(0, 72)}
                    </div>
                    <div
                      className="er-swatch-row"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {ER_NOTE_COLORS.map((hex) => (
                        <button
                          key={hex}
                          type="button"
                          className={`er-swatch-btn${n.color === hex ? ' is-active' : ''}`}
                          style={{ backgroundColor: hex }}
                          onClick={() => onUpdateNote(n.id, { color: hex })}
                        />
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {/* TAB 5: CUSTOM TYPES / ENUMS */}
        {activeTab === 'types' && (
          <>
            <div className="er-side-section-head">
              <span>自定义类型 / Enum ({diagram.customTypes.length})</span>
            </div>
            <div className="er-side-list">
              {diagram.customTypes.length === 0 ? (
                <div className="er-side-card-meta">
                  当前数据库未发现 PostgreSQL Enum 或 Composite 自定义类型。
                </div>
              ) : (
                diagram.customTypes.map((ct) => (
                  <div key={ct.id} className="er-side-card">
                    <div className="er-side-card-top">
                      <span className="er-side-card-name">{ct.id}</span>
                      <span className="er-issue-tag">
                        {ct.kind.toUpperCase()}
                      </span>
                    </div>
                    {ct.values.length > 0 && (
                      <div className="er-side-card-meta">
                        值域: {ct.values.join(', ')}
                      </div>
                    )}
                    {ct.fields.length > 0 && (
                      <div className="er-side-card-meta">
                        成员:{' '}
                        {ct.fields
                          .map((f) => `${f.name}: ${f.dataType}`)
                          .join(', ')}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {/* TAB 6: DUAL-DIMENSION ISSUES LINTER */}
        {activeTab === 'issues' && (
          <>
            <div className="er-side-section-head">
              <span>双维体检 ({filteredIssues.length})</span>
            </div>
            <div className="er-side-filter-pills">
              {(
                [
                  ['all', '全部'],
                  ['modeling', '建模规范'],
                  ['data-quality', '实库质量'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`er-filter-pill${issueFilter === id ? ' is-active' : ''}`}
                  onClick={() => setIssueFilter(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="er-side-list">
              {filteredIssues.length === 0 ? (
                <div className="er-side-card-meta">
                  太棒了！当前维度未检测到异常问题。
                </div>
              ) : (
                filteredIssues.map((iss) => (
                  <div
                    key={iss.id}
                    className={`er-issue-card is-${iss.severity}`}
                    onClick={() => {
                      if (iss.relationId) onFocusRelation(iss.relationId);
                      else if (iss.tableId) onFocusTable(iss.tableId);
                    }}
                  >
                    <div className="er-issue-tags">
                      <span className="er-issue-tag">
                        {iss.category === 'data-quality'
                          ? '实库质量'
                          : '建模规范'}
                      </span>
                      <span className="er-issue-tag">{iss.code}</span>
                    </div>
                    <div className="er-issue-title">{iss.title}</div>
                    <div className="er-issue-detail">{iss.detail}</div>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
});
