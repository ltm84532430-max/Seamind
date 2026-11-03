import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { literatureApi } from './literature-api';
import type {
  LiteratureOverview,
  PaperFilter,
  PaperInput,
  PaperItem,
} from './types';
import './literature-workspace.css';

export interface LiteratureWorkspaceProps {
  onOpenMindmap?: (markdown: string, title: string) => void;
}

export const LiteratureWorkspace: React.FC<LiteratureWorkspaceProps> = ({
  onOpenMindmap,
}) => {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const [overview, setOverview] = useState<LiteratureOverview | null>(null);
  const [papers, setPapers] = useState<PaperItem[]>([]);
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'unread' | 'reading' | 'completed' | 'starred'
  >('all');
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(
    null,
  );
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<
    'updatedAt' | 'year' | 'title' | 'rating'
  >('updatedAt');

  // Notes draft state for currently selected paper
  const [notesDraft, setNotesDraft] = useState('');

  // Modals
  const [showFetchModal, setShowFetchModal] = useState(false);
  const [showBibtexModal, setShowBibtexModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingPaper, setEditingPaper] = useState<PaperInput | null>(null);
  const [showNewCollectionModal, setShowNewCollectionModal] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');

  // Fetch modal state
  const [fetchType, setFetchType] = useState<'doi' | 'arxiv'>('doi');
  const [fetchInput, setFetchInput] = useState('');
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchedPreview, setFetchedPreview] = useState<PaperInput | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Bibtex paste modal state
  const [bibtexDraft, setBibtexDraft] = useState('');
  const [bibtexLoading, setBibtexLoading] = useState(false);

  // ---------------------------------------------------------------------------
  // Data Loading
  // ---------------------------------------------------------------------------
  const loadOverview = useCallback(async () => {
    try {
      const data = await literatureApi.overview();
      setOverview(data);
    } catch (e) {
      console.error('加载文献统计概览失败:', e);
    }
  }, []);

  const loadPapers = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const filter: PaperFilter = {
        query: searchQuery.trim() || undefined,
        collectionId: activeCollectionId || undefined,
        tag: activeTag || undefined,
        readStatus: statusFilter,
        sortBy,
        sortOrder: sortBy === 'title' ? 'asc' : 'desc',
      };
      const list = await literatureApi.list(filter);
      setPapers(list);
      // If selected paper is no longer in list, pick first
      if (list.length > 0) {
        setSelectedPaperId((prev) => {
          if (prev && list.some((p) => p.id === prev)) return prev;
          return list[0].id;
        });
      } else {
        setSelectedPaperId(null);
      }
    } catch (e: any) {
      setErrorMsg(e?.toString() || '加载文献列表失败');
    } finally {
      setLoading(false);
    }
  }, [searchQuery, activeCollectionId, activeTag, statusFilter, sortBy]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    loadPapers();
  }, [loadPapers]);

  // Selected paper instance
  const selectedPaper = useMemo(
    () => papers.find((p) => p.id === selectedPaperId) || null,
    [papers, selectedPaperId],
  );

  useEffect(() => {
    if (selectedPaper) {
      setNotesDraft(selectedPaper.notes || '');
    } else {
      setNotesDraft('');
    }
  }, [selectedPaper]);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  const handleUpdateStatus = async (id: string, status: string) => {
    try {
      await literatureApi.updateReadStatus(id, status);
      setPapers((prev) =>
        prev.map((p) =>
          p.id === id ? { ...p, readStatus: status as any } : p,
        ),
      );
      loadOverview();
    } catch (e) {
      console.error('更新阅读状态失败:', e);
    }
  };

  const handleUpdateRating = async (id: string, rating: number) => {
    try {
      await literatureApi.updateRating(id, rating);
      setPapers((prev) =>
        prev.map((p) => (p.id === id ? { ...p, rating } : p)),
      );
      loadOverview();
    } catch (e) {
      console.error('更新评分失败:', e);
    }
  };

  const handleSaveNotes = async () => {
    if (!selectedPaperId) return;
    try {
      await literatureApi.updateNotes(selectedPaperId, notesDraft);
      setPapers((prev) =>
        prev.map((p) =>
          p.id === selectedPaperId ? { ...p, notes: notesDraft } : p,
        ),
      );
    } catch (e) {
      console.error('保存笔记失败:', e);
    }
  };

  const handleDeletePaper = async (id: string) => {
    if (!window.confirm('确定要从文献库中移除该篇论文吗？')) return;
    try {
      await literatureApi.delete(id);
      loadOverview();
      loadPapers();
    } catch (e: any) {
      alert(`删除失败: ${e}`);
    }
  };

  const handleGenerateMindmap = async () => {
    if (!selectedPaperId || !onOpenMindmap) return;
    try {
      const md = await literatureApi.generateMindmap(selectedPaperId);
      const title = selectedPaper?.title || '文献结构思维导图';
      onOpenMindmap(md, title);
    } catch (e: any) {
      alert(`生成导图失败: ${e}`);
    }
  };

  const handleCopyCitation = (format: 'citekey' | 'bibtex' | 'apa') => {
    if (!selectedPaper) return;
    let textToCopy = '';
    if (format === 'citekey') {
      textToCopy = `[@${selectedPaper.citeKey}]`;
    } else if (format === 'bibtex') {
      textToCopy = selectedPaper.bibtex || '';
    } else {
      // Basic APA style fallback
      const authors =
        selectedPaper.authors.length > 0 ? selectedPaper.authors[0] : 'Anon';
      const year = selectedPaper.year ? `(${selectedPaper.year})` : '(n.d.)';
      textToCopy = `${authors} et al. ${year}. ${selectedPaper.title}. ${selectedPaper.venue || ''}.`;
    }

    navigator.clipboard.writeText(textToCopy).then(() => {
      alert('已成功复制到剪贴板！');
    });
  };

  const handleOpenLink = (url?: string | null) => {
    if (!url) return;
    window.open(url, '_blank');
  };

  // ---------------------------------------------------------------------------
  // Fetch Modal Handlers
  // ---------------------------------------------------------------------------
  const handleExecuteFetch = async () => {
    if (!fetchInput.trim()) return;
    setFetchLoading(true);
    setFetchError(null);
    setFetchedPreview(null);
    try {
      if (fetchType === 'doi') {
        const result = await literatureApi.fetchDoi(fetchInput.trim());
        setFetchedPreview(result);
      } else {
        const result = await literatureApi.fetchArxiv(fetchInput.trim());
        setFetchedPreview(result);
      }
    } catch (e: any) {
      setFetchError(e?.toString() || '未检索到该文献');
    } finally {
      setFetchLoading(false);
    }
  };

  const handleSaveFetchedPaper = async () => {
    if (!fetchedPreview) return;
    try {
      await literatureApi.save(fetchedPreview);
      setShowFetchModal(false);
      setFetchedPreview(null);
      setFetchInput('');
      loadOverview();
      loadPapers();
    } catch (e: any) {
      alert(`保存文献失败: ${e}`);
    }
  };

  // ---------------------------------------------------------------------------
  // Bibtex Import Handlers
  // ---------------------------------------------------------------------------
  const handleExecuteBibtexImport = async () => {
    if (!bibtexDraft.trim()) return;
    setBibtexLoading(true);
    try {
      const count = await literatureApi.importBibtexText(
        bibtexDraft,
        activeCollectionId || undefined,
      );
      alert(`成功导入 ${count} 篇文献！`);
      setShowBibtexModal(false);
      setBibtexDraft('');
      loadOverview();
      loadPapers();
    } catch (e: any) {
      alert(`导入失败: ${e}`);
    } finally {
      setBibtexLoading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="literature-workspace">
      {/* ==================================================================== */}
      {/* 1. Sidebar                                                          */}
      {/* ==================================================================== */}
      <aside className="literature-sidebar">
        <div className="literature-sidebar-header">
          <div className="literature-sidebar-title">
            <span>📚 文献工作台</span>
          </div>
        </div>

        {/* Status Filters */}
        <div className="literature-nav-group">
          <button
            type="button"
            className={`literature-nav-item ${
              statusFilter === 'all' && !activeCollectionId && !activeTag
                ? 'is-active'
                : ''
            }`}
            onClick={() => {
              setStatusFilter('all');
              setActiveCollectionId(null);
              setActiveTag(null);
            }}
          >
            <span className="literature-nav-label">📑 全部文献</span>
            <span className="literature-nav-badge">
              {overview?.totalPapers || 0}
            </span>
          </button>

          <button
            type="button"
            className={`literature-nav-item ${
              statusFilter === 'unread' ? 'is-active' : ''
            }`}
            onClick={() => {
              setStatusFilter('unread');
              setActiveCollectionId(null);
              setActiveTag(null);
            }}
          >
            <span className="literature-nav-label">⚪ 未读</span>
            <span className="literature-nav-badge">
              {overview?.unreadCount || 0}
            </span>
          </button>

          <button
            type="button"
            className={`literature-nav-item ${
              statusFilter === 'reading' ? 'is-active' : ''
            }`}
            onClick={() => {
              setStatusFilter('reading');
              setActiveCollectionId(null);
              setActiveTag(null);
            }}
          >
            <span className="literature-nav-label">🟡 在读</span>
            <span className="literature-nav-badge">
              {overview?.readingCount || 0}
            </span>
          </button>

          <button
            type="button"
            className={`literature-nav-item ${
              statusFilter === 'completed' ? 'is-active' : ''
            }`}
            onClick={() => {
              setStatusFilter('completed');
              setActiveCollectionId(null);
              setActiveTag(null);
            }}
          >
            <span className="literature-nav-label">🟢 已读</span>
            <span className="literature-nav-badge">
              {overview?.completedCount || 0}
            </span>
          </button>

          <button
            type="button"
            className={`literature-nav-item ${
              statusFilter === 'starred' ? 'is-active' : ''
            }`}
            onClick={() => {
              setStatusFilter('starred');
              setActiveCollectionId(null);
              setActiveTag(null);
            }}
          >
            <span className="literature-nav-label">⭐ 星标收藏</span>
            <span className="literature-nav-badge">
              {overview?.starredCount || 0}
            </span>
          </button>
        </div>

        {/* Collections */}
        <div className="literature-nav-group">
          <div className="literature-group-label">
            <span>我的文献集</span>
            <button
              type="button"
              className="lit-btn"
              style={{ padding: '2px 6px', fontSize: '11px' }}
              title="新建群组"
              onClick={() => setShowNewCollectionModal(true)}
            >
              +
            </button>
          </div>
          {overview?.collections && overview.collections.length > 0 ? (
            overview.collections.map((col) => (
              <button
                key={col.id}
                type="button"
                className={`literature-nav-item ${
                  activeCollectionId === col.id ? 'is-active' : ''
                }`}
                onClick={() => {
                  setActiveCollectionId(col.id);
                  setActiveTag(null);
                  setStatusFilter('all');
                }}
              >
                <span className="literature-nav-label">📁 {col.name}</span>
                <span className="literature-nav-badge">{col.paperCount}</span>
              </button>
            ))
          ) : (
            <div
              style={{
                padding: '4px 8px',
                fontSize: '11.5px',
                color: '#64748b',
              }}
            >
              暂无自定义群组
            </div>
          )}
        </div>

        {/* Tags */}
        {overview?.allTags && overview.allTags.length > 0 && (
          <div className="literature-nav-group">
            <div className="literature-group-label">热门标签</div>
            <div className="literature-tags-container">
              {overview.allTags.slice(0, 15).map((t) => (
                <span
                  key={t.name}
                  className={`literature-tag-pill ${
                    activeTag === t.name ? 'is-active' : ''
                  }`}
                  onClick={() => {
                    setActiveTag((prev) => (prev === t.name ? null : t.name));
                  }}
                >
                  #{t.name} ({t.count})
                </span>
              ))}
            </div>
          </div>
        )}
      </aside>

      {/* ==================================================================== */}
      {/* 2. Main Paper List                                                  */}
      {/* ==================================================================== */}
      <main className="literature-main">
        {/* Toolbar */}
        <div className="literature-toolbar">
          <div className="literature-search-box">
            <span className="literature-search-icon">🔍</span>
            <input
              type="text"
              className="literature-search-input"
              placeholder="搜索论文标题、作者、CiteKey、摘要、期刊..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="literature-toolbar-actions">
            {/* Sort Selector */}
            <select
              className="lit-form-select"
              style={{ width: 'auto', padding: '5px 8px', fontSize: '12px' }}
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
            >
              <option value="updatedAt">按更新时间</option>
              <option value="year">按发表年份</option>
              <option value="title">按论文标题</option>
              <option value="rating">按评分排序</option>
            </select>

            {/* Smart Import Button */}
            <button
              type="button"
              className="lit-btn lit-btn-primary"
              onClick={() => {
                setShowFetchModal(true);
                setFetchedPreview(null);
                setFetchError(null);
                setFetchInput('');
              }}
            >
              ⚡ DOI / arXiv 导入
            </button>

            {/* BibTeX Import */}
            <button
              type="button"
              className="lit-btn"
              onClick={() => setShowBibtexModal(true)}
            >
              📥 导入 BibTeX
            </button>

            {/* Manual New Paper */}
            <button
              type="button"
              className="lit-btn"
              onClick={() => {
                setEditingPaper({
                  title: '',
                  authors: [],
                  entryType: 'article',
                  readStatus: 'unread',
                  rating: 0,
                });
                setShowEditModal(true);
              }}
            >
              + 手动添加
            </button>
          </div>
        </div>

        {/* Paper List */}
        <div className="literature-list-container">
          {loading && (
            <div className="empty-state">
              <span>正在加载文献数据...</span>
            </div>
          )}

          {!loading && errorMsg && (
            <div className="empty-state" style={{ color: '#ef4444' }}>
              <span>{errorMsg}</span>
            </div>
          )}

          {!loading && papers.length === 0 && (
            <div className="empty-state">
              <span style={{ fontSize: '32px' }}>📖</span>
              <p>暂无符合条件的文献</p>
              <p style={{ fontSize: '12px' }}>
                点击上方的 <strong>“⚡ DOI / arXiv 导入”</strong> 或{' '}
                <strong>“📥 导入 BibTeX”</strong> 快速添加
              </p>
            </div>
          )}

          {!loading &&
            papers.map((p) => {
              const isSelected = p.id === selectedPaperId;
              const authorsText =
                p.authors.length > 0
                  ? p.authors.length > 2
                    ? `${p.authors[0]} et al.`
                    : p.authors.join(', ')
                  : '佚名';

              return (
                <div
                  key={p.id}
                  className={`paper-card ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => setSelectedPaperId(p.id)}
                >
                  <div className="paper-card-header">
                    <span className="paper-card-title">{p.title}</span>
                    <span className="paper-card-citekey">@{p.citeKey}</span>
                  </div>

                  <div className="paper-card-meta">
                    <span>✍️ {authorsText}</span>
                    {p.year && <span>📅 {p.year}</span>}
                    {p.venue && <span>🏛️ {p.venue}</span>}
                    {p.doi && (
                      <span style={{ color: '#60a5fa' }}>DOI: {p.doi}</span>
                    )}
                  </div>

                  <div className="paper-card-footer">
                    <div
                      style={{
                        display: 'flex',
                        gap: '8px',
                        alignItems: 'center',
                      }}
                    >
                      <span className={`paper-status-badge ${p.readStatus}`}>
                        {p.readStatus === 'completed'
                          ? '已读'
                          : p.readStatus === 'reading'
                            ? '在读'
                            : '未读'}
                      </span>

                      {/* Interactive Stars */}
                      <span className="star-rating">
                        {[1, 2, 3, 4, 5].map((star) => (
                          <span
                            key={star}
                            className={star <= p.rating ? '' : 'star-empty'}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleUpdateRating(
                                p.id,
                                star === p.rating ? 0 : star,
                              );
                            }}
                          >
                            ★
                          </span>
                        ))}
                      </span>
                    </div>

                    {p.keywords && p.keywords.length > 0 && (
                      <div style={{ display: 'flex', gap: '4px' }}>
                        {p.keywords.slice(0, 3).map((k) => (
                          <span
                            key={k}
                            style={{
                              fontSize: '10.5px',
                              background: 'rgba(255,255,255,0.06)',
                              padding: '2px 6px',
                              borderRadius: '4px',
                            }}
                          >
                            {k}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
        </div>
      </main>

      {/* ==================================================================== */}
      {/* 3. Right Details Inspector                                          */}
      {/* ==================================================================== */}
      {selectedPaper ? (
        <aside className="literature-inspector">
          {/* Header & Quick Action Buttons */}
          <div className="inspector-header">
            <div className="inspector-actions-bar">
              {/* Paper to Mindmap Button */}
              {onOpenMindmap && (
                <button
                  type="button"
                  className="lit-btn lit-btn-mindmap"
                  title="自动将此论文结构解构为思维导图"
                  onClick={handleGenerateMindmap}
                >
                  ✨ 转为思维导图
                </button>
              )}

              {/* Citation Copy Dropdown */}
              <div style={{ display: 'flex', gap: '4px' }}>
                <button
                  type="button"
                  className="lit-btn"
                  title="复制 [@citekey] Markdown 引用"
                  onClick={() => handleCopyCitation('citekey')}
                >
                  📋 复制引用
                </button>
                <button
                  type="button"
                  className="lit-btn"
                  title="复制 BibTeX 源码"
                  onClick={() => handleCopyCitation('bibtex')}
                >
                  BibTeX
                </button>
              </div>

              {/* Edit & Delete */}
              <div style={{ display: 'flex', gap: '4px' }}>
                <button
                  type="button"
                  className="lit-btn"
                  title="编辑文献元数据"
                  onClick={() => {
                    setEditingPaper({ ...selectedPaper });
                    setShowEditModal(true);
                  }}
                >
                  ✏️
                </button>
                <button
                  type="button"
                  className="lit-btn"
                  style={{ color: '#ef4444' }}
                  title="删除文献"
                  onClick={() => handleDeletePaper(selectedPaper.id)}
                >
                  🗑️
                </button>
              </div>
            </div>

            <div className="inspector-title">{selectedPaper.title}</div>

            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              <select
                className="lit-form-select"
                style={{ width: 'auto', padding: '4px 8px', fontSize: '12px' }}
                value={selectedPaper.readStatus}
                onChange={(e) =>
                  handleUpdateStatus(selectedPaper.id, e.target.value)
                }
              >
                <option value="unread">⚪ 标记为未读</option>
                <option value="reading">🟡 标记为在读</option>
                <option value="completed">🟢 标记为已读</option>
              </select>

              <span className="star-rating">
                {[1, 2, 3, 4, 5].map((star) => (
                  <span
                    key={star}
                    className={star <= selectedPaper.rating ? '' : 'star-empty'}
                    onClick={() =>
                      handleUpdateRating(
                        selectedPaper.id,
                        star === selectedPaper.rating ? 0 : star,
                      )
                    }
                  >
                    ★
                  </span>
                ))}
              </span>
            </div>
          </div>

          {/* Inspector Body */}
          <div className="inspector-body">
            {/* Metadata Grid */}
            <div className="inspector-section">
              <div className="inspector-section-label">文献元数据</div>
              <div className="inspector-meta-grid">
                <span className="meta-field-name">CiteKey</span>
                <span className="meta-field-value" style={{ color: '#60a5fa' }}>
                  @{selectedPaper.citeKey}
                </span>

                <span className="meta-field-name">作者</span>
                <span className="meta-field-value">
                  {selectedPaper.authors.join(', ') || '未记录'}
                </span>

                <span className="meta-field-name">发表刊物</span>
                <span className="meta-field-value">
                  {selectedPaper.venue || '—'}
                </span>

                <span className="meta-field-name">年份</span>
                <span className="meta-field-value">
                  {selectedPaper.year || '—'}
                </span>

                {selectedPaper.doi && (
                  <>
                    <span className="meta-field-name">DOI</span>
                    <span className="meta-field-value">
                      <a
                        href={`https://doi.org/${selectedPaper.doi}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: '#60a5fa', textDecoration: 'none' }}
                      >
                        {selectedPaper.doi} ↗
                      </a>
                    </span>
                  </>
                )}

                {selectedPaper.url && (
                  <>
                    <span className="meta-field-name">原文链接</span>
                    <span className="meta-field-value">
                      <button
                        type="button"
                        className="lit-btn"
                        style={{ padding: '2px 8px', fontSize: '11px' }}
                        onClick={() => handleOpenLink(selectedPaper.url)}
                      >
                        打开原文网页 ↗
                      </button>
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* Abstract */}
            {selectedPaper.abstractText && (
              <div className="inspector-section">
                <div className="inspector-section-label">摘要概览</div>
                <div className="inspector-abstract-box">
                  {selectedPaper.abstractText}
                </div>
              </div>
            )}

            {/* Notes Section */}
            <div className="inspector-section">
              <div className="inspector-section-label">
                <span>个人学术笔记 & 批判性思考</span>
                <button
                  type="button"
                  className="lit-btn"
                  style={{ padding: '2px 6px', fontSize: '11px' }}
                  onClick={handleSaveNotes}
                >
                  保存笔记
                </button>
              </div>
              <textarea
                className="inspector-notes-textarea"
                placeholder="在此记录针对本论文的研读笔记、方法论优缺点、创新点与启发..."
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                onBlur={handleSaveNotes}
              />
            </div>

            {/* BibTeX Raw View */}
            {selectedPaper.bibtex && (
              <div className="inspector-section">
                <div className="inspector-section-label">
                  <span>BibTeX 源码</span>
                  <button
                    type="button"
                    className="lit-btn"
                    style={{ padding: '2px 6px', fontSize: '11px' }}
                    onClick={() => handleCopyCitation('bibtex')}
                  >
                    复制源码
                  </button>
                </div>
                <div className="inspector-bibtex-block">
                  {selectedPaper.bibtex}
                </div>
              </div>
            )}
          </div>
        </aside>
      ) : null}

      {/* ==================================================================== */}
      {/* 4. Modals                                                           */}
      {/* ==================================================================== */}

      {/* DOI / arXiv Fetch Modal */}
      {showFetchModal && (
        <div
          className="lit-modal-backdrop"
          onClick={() => setShowFetchModal(false)}
        >
          <div
            className="lit-modal-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="lit-modal-header">
              <div className="lit-modal-title">
                ⚡ 通过 DOI / arXiv ID 智能检索导入
              </div>
              <button
                type="button"
                className="lit-btn"
                onClick={() => setShowFetchModal(false)}
              >
                ✕
              </button>
            </div>

            <div className="lit-modal-body">
              <div style={{ display: 'flex', gap: '16px' }}>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '13px',
                  }}
                >
                  <input
                    type="radio"
                    name="fetchType"
                    checked={fetchType === 'doi'}
                    onChange={() => setFetchType('doi')}
                  />
                  DOI (Crossref)
                </label>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '13px',
                  }}
                >
                  <input
                    type="radio"
                    name="fetchType"
                    checked={fetchType === 'arxiv'}
                    onChange={() => setFetchType('arxiv')}
                  />
                  arXiv ID (如 1706.03762)
                </label>
              </div>

              <div className="lit-form-group">
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    className="lit-form-input"
                    placeholder={
                      fetchType === 'doi'
                        ? '例如 10.1145/3292500.3330964 或 10.48550/arXiv.1706.03762'
                        : '例如 1706.03762 或 2302.13971'
                    }
                    value={fetchInput}
                    onChange={(e) => setFetchInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleExecuteFetch()}
                  />
                  <button
                    type="button"
                    className="lit-btn lit-btn-primary"
                    disabled={fetchLoading || !fetchInput.trim()}
                    onClick={handleExecuteFetch}
                  >
                    {fetchLoading ? '检索中...' : '检索'}
                  </button>
                </div>
              </div>

              {fetchError && (
                <div style={{ color: '#ef4444', fontSize: '12px' }}>
                  {fetchError}
                </div>
              )}

              {/* Fetched Preview */}
              {fetchedPreview && (
                <div
                  style={{
                    background: 'rgba(0,0,0,0.3)',
                    padding: '12px',
                    borderRadius: '6px',
                    border: '1px solid rgba(255,255,255,0.08)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: '14px',
                      color: '#60a5fa',
                    }}
                  >
                    {fetchedPreview.title}
                  </div>
                  <div style={{ fontSize: '12px', color: '#94a3b8' }}>
                    {fetchedPreview.authors.join(', ')} (
                    {fetchedPreview.year || '未知年份'})
                  </div>
                  {fetchedPreview.venue && (
                    <div style={{ fontSize: '12px', color: '#cbd5e1' }}>
                      🏛️ {fetchedPreview.venue}
                    </div>
                  )}
                  {fetchedPreview.abstractText && (
                    <div
                      style={{
                        fontSize: '11.5px',
                        color: '#64748b',
                        maxHeight: '100px',
                        overflowY: 'auto',
                      }}
                    >
                      {fetchedPreview.abstractText}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="lit-modal-footer">
              <button
                type="button"
                className="lit-btn"
                onClick={() => setShowFetchModal(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="lit-btn lit-btn-primary"
                disabled={!fetchedPreview}
                onClick={handleSaveFetchedPaper}
              >
                保存到文献库
              </button>
            </div>
          </div>
        </div>
      )}

      {/* BibTeX Import Modal */}
      {showBibtexModal && (
        <div
          className="lit-modal-backdrop"
          onClick={() => setShowBibtexModal(false)}
        >
          <div
            className="lit-modal-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="lit-modal-header">
              <div className="lit-modal-title">📥 粘贴 BibTeX 源码批量导入</div>
              <button
                type="button"
                className="lit-btn"
                onClick={() => setShowBibtexModal(false)}
              >
                ✕
              </button>
            </div>

            <div className="lit-modal-body">
              <textarea
                className="lit-form-textarea"
                rows={10}
                placeholder={`@article{vaswani2017attention,\n  title={Attention is all you need},\n  author={Vaswani, Ashish and ...},\n  journal={NeurIPS},\n  year={2017}\n}`}
                value={bibtexDraft}
                onChange={(e) => setBibtexDraft(e.target.value)}
              />
            </div>

            <div className="lit-modal-footer">
              <button
                type="button"
                className="lit-btn"
                onClick={() => setShowBibtexModal(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="lit-btn lit-btn-primary"
                disabled={bibtexLoading || !bibtexDraft.trim()}
                onClick={handleExecuteBibtexImport}
              >
                {bibtexLoading ? '正在导入...' : '开始导入'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manual / Edit Paper Modal */}
      {showEditModal && editingPaper && (
        <div
          className="lit-modal-backdrop"
          onClick={() => setShowEditModal(false)}
        >
          <div
            className="lit-modal-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="lit-modal-header">
              <div className="lit-modal-title">
                {editingPaper.id ? '编辑文献信息' : '手动添加文献'}
              </div>
              <button
                type="button"
                className="lit-btn"
                onClick={() => setShowEditModal(false)}
              >
                ✕
              </button>
            </div>

            <div className="lit-modal-body">
              <div className="lit-form-group">
                <label className="lit-form-label">论文标题 *</label>
                <input
                  type="text"
                  className="lit-form-input"
                  value={editingPaper.title}
                  onChange={(e) =>
                    setEditingPaper({ ...editingPaper, title: e.target.value })
                  }
                />
              </div>

              <div className="lit-form-group">
                <label className="lit-form-label">作者列表 (逗号分隔)</label>
                <input
                  type="text"
                  className="lit-form-input"
                  value={editingPaper.authors.join(', ')}
                  onChange={(e) =>
                    setEditingPaper({
                      ...editingPaper,
                      authors: e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '10px',
                }}
              >
                <div className="lit-form-group">
                  <label className="lit-form-label">引用键 (CiteKey)</label>
                  <input
                    type="text"
                    className="lit-form-input"
                    placeholder="留空自动生成"
                    value={editingPaper.citeKey || ''}
                    onChange={(e) =>
                      setEditingPaper({
                        ...editingPaper,
                        citeKey: e.target.value,
                      })
                    }
                  />
                </div>

                <div className="lit-form-group">
                  <label className="lit-form-label">发表年份</label>
                  <input
                    type="number"
                    className="lit-form-input"
                    value={editingPaper.year || ''}
                    onChange={(e) =>
                      setEditingPaper({
                        ...editingPaper,
                        year: e.target.value
                          ? parseInt(e.target.value, 10)
                          : null,
                      })
                    }
                  />
                </div>
              </div>

              <div className="lit-form-group">
                <label className="lit-form-label">
                  发表期刊 / 会议 (Venue)
                </label>
                <input
                  type="text"
                  className="lit-form-input"
                  value={editingPaper.venue || ''}
                  onChange={(e) =>
                    setEditingPaper({ ...editingPaper, venue: e.target.value })
                  }
                />
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '10px',
                }}
              >
                <div className="lit-form-group">
                  <label className="lit-form-label">DOI</label>
                  <input
                    type="text"
                    className="lit-form-input"
                    value={editingPaper.doi || ''}
                    onChange={(e) =>
                      setEditingPaper({ ...editingPaper, doi: e.target.value })
                    }
                  />
                </div>

                <div className="lit-form-group">
                  <label className="lit-form-label">原文链接</label>
                  <input
                    type="text"
                    className="lit-form-input"
                    value={editingPaper.url || ''}
                    onChange={(e) =>
                      setEditingPaper({ ...editingPaper, url: e.target.value })
                    }
                  />
                </div>
              </div>

              <div className="lit-form-group">
                <label className="lit-form-label">摘要 (Abstract)</label>
                <textarea
                  className="lit-form-textarea"
                  rows={4}
                  value={editingPaper.abstractText || ''}
                  onChange={(e) =>
                    setEditingPaper({
                      ...editingPaper,
                      abstractText: e.target.value,
                    })
                  }
                />
              </div>
            </div>

            <div className="lit-modal-footer">
              <button
                type="button"
                className="lit-btn"
                onClick={() => setShowEditModal(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="lit-btn lit-btn-primary"
                disabled={!editingPaper.title.trim()}
                onClick={async () => {
                  try {
                    await literatureApi.save(editingPaper);
                    setShowEditModal(false);
                    loadOverview();
                    loadPapers();
                  } catch (e: any) {
                    alert(`保存失败: ${e}`);
                  }
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New Collection Modal */}
      {showNewCollectionModal && (
        <div
          className="lit-modal-backdrop"
          onClick={() => setShowNewCollectionModal(false)}
        >
          <div
            className="lit-modal-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="lit-modal-header">
              <div className="lit-modal-title">新建文献集 / 群组</div>
              <button
                type="button"
                className="lit-btn"
                onClick={() => setShowNewCollectionModal(false)}
              >
                ✕
              </button>
            </div>
            <div className="lit-modal-body">
              <div className="lit-form-group">
                <label className="lit-form-label">群组名称</label>
                <input
                  type="text"
                  className="lit-form-input"
                  placeholder="例如：大语言模型长文本、强化学习、视觉生成..."
                  value={newCollectionName}
                  onChange={(e) => setNewCollectionName(e.target.value)}
                />
              </div>
            </div>
            <div className="lit-modal-footer">
              <button
                type="button"
                className="lit-btn"
                onClick={() => setShowNewCollectionModal(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="lit-btn lit-btn-primary"
                disabled={!newCollectionName.trim()}
                onClick={async () => {
                  try {
                    await literatureApi.saveCollection({
                      name: newCollectionName.trim(),
                    });
                    setShowNewCollectionModal(false);
                    setNewCollectionName('');
                    loadOverview();
                  } catch (e: any) {
                    alert(`创建群组失败: ${e}`);
                  }
                }}
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LiteratureWorkspace;
