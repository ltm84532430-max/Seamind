import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { literatureApi } from './literature-api';
import type {
  LiteratureOverview,
  PaperFilter,
  PaperInput,
  PaperItem,
  LiteratureSearchResult,
} from './types';
import './literature-workspace.css';

const PaperPdfReader = React.lazy(() => import('./PaperPdfReader'));

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
  const [compactPane, setCompactPane] = useState<'list' | 'detail'>('list');
  const [readerPaper, setReaderPaper] = useState<PaperItem | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
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
  const [fetchMode, setFetchMode] = useState<'identifier' | 'discovery'>(
    'identifier',
  );
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
  const [discoveryQuery, setDiscoveryQuery] = useState('');
  const [discoverySource, setDiscoverySource] = useState<'crossref' | 'arxiv'>(
    'arxiv',
  );
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discoveryResults, setDiscoveryResults] = useState<
    LiteratureSearchResult[]
  >([]);

  // Bibtex paste modal state
  const [bibtexDraft, setBibtexDraft] = useState('');
  const [bibtexLoading, setBibtexLoading] = useState(false);

  // Copy notice toast
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

  const showToast = (text: string) => {
    setCopyNotice(text);
    setTimeout(() => setCopyNotice(null), 2000);
  };

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
  // Handlers
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
      showToast('笔记已保存');
    } catch (e) {
      console.error('保存笔记失败:', e);
    }
  };

  const handleDeletePaper = async (id: string) => {
    if (!window.confirm('确认删除该文献记录？')) return;
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
      const title = selectedPaper?.title || '文献解构导图';
      onOpenMindmap(md, title);
    } catch (e: any) {
      alert(`生成导图失败: ${e}`);
    }
  };

  const handleCopyCitation = (
    format: 'citekey' | 'bibtex' | 'apa' | 'ieee',
  ) => {
    if (!selectedPaper) return;
    let textToCopy = '';
    if (format === 'citekey') {
      textToCopy = `[@${selectedPaper.citeKey}]`;
    } else if (format === 'bibtex') {
      textToCopy = selectedPaper.bibtex || '';
    } else if (format === 'ieee') {
      const author =
        selectedPaper.authors.length > 0 ? selectedPaper.authors[0] : 'Anon';
      textToCopy = `${author} et al., "${selectedPaper.title}," ${selectedPaper.venue || ''}, ${selectedPaper.year || ''}.`;
    } else {
      const author =
        selectedPaper.authors.length > 0 ? selectedPaper.authors[0] : 'Anon';
      const year = selectedPaper.year ? `(${selectedPaper.year})` : '(n.d.)';
      textToCopy = `${author} et al. ${year}. ${selectedPaper.title}. ${selectedPaper.venue || ''}.`;
    }

    navigator.clipboard.writeText(textToCopy).then(() => {
      showToast('已复制到剪贴板');
    });
  };

  const handleOpenLink = (url?: string | null) => {
    if (!url) return;
    window.open(url, '_blank');
  };

  const handleAttachPdf = async (replaceExisting = false) => {
    if (!selectedPaper || pdfBusy) return;
    setPdfBusy(true);
    try {
      const updatedPaper = await literatureApi.attachPdf(selectedPaper.id);
      if (!updatedPaper) return;
      setPapers((current) =>
        current.map((paper) =>
          paper.id === updatedPaper.id ? updatedPaper : paper,
        ),
      );
      setReaderPaper(updatedPaper);
      showToast(replaceExisting ? 'PDF 原文已更换' : 'PDF 已加入文献库');
    } catch (attachError) {
      alert(`添加 PDF 失败：${attachError}`);
    } finally {
      setPdfBusy(false);
    }
  };

  const handleOpenPdfReader = () => {
    if (!selectedPaper) return;
    if (!selectedPaper.pdfPath) {
      void handleAttachPdf();
      return;
    }
    setReaderPaper(selectedPaper);
  };

  const handleReaderStarted = useCallback(
    (paperId: string) => {
      setPapers((current) =>
        current.map((paper) =>
          paper.id === paperId ? { ...paper, readStatus: 'reading' } : paper,
        ),
      );
      void loadOverview();
    },
    [loadOverview],
  );

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
      setFetchError(e?.toString() || '未检索到对应元数据');
    } finally {
      setFetchLoading(false);
    }
  };

  const handleSearchOnline = async () => {
    const query = discoveryQuery.trim();
    if (query.length < 2) return;
    setDiscoveryLoading(true);
    setDiscoveryError(null);
    setDiscoveryResults([]);
    try {
      const results = await literatureApi.searchOnline(query, discoverySource);
      setDiscoveryResults(results);
      if (results.length === 0) setDiscoveryError('没有找到匹配的论文。');
    } catch (e: any) {
      setDiscoveryError(e?.toString() || '在线检索失败，请稍后重试。');
    } finally {
      setDiscoveryLoading(false);
    }
  };

  const handleOpenDiscoveredPaper = async (result: LiteratureSearchResult) => {
    if (!result.existingPaperId) return;
    try {
      const paper = await literatureApi.get(result.existingPaperId);
      if (!paper) return;
      setPapers((current) => [
        paper,
        ...current.filter((p) => p.id !== paper.id),
      ]);
      setSelectedPaperId(paper.id);
      setCompactPane('detail');
      setShowFetchModal(false);
    } catch (e: any) {
      setDiscoveryError(e?.toString() || '打开文献失败。');
    }
  };

  const handleImportDiscoveredPaper = async (
    result: LiteratureSearchResult,
    downloadPdf = false,
  ) => {
    if (result.existingPaperId) {
      await handleOpenDiscoveredPaper(result);
      return;
    }

    try {
      let paper = await literatureApi.save({
        ...result.paper,
        collectionIds: activeCollectionId ? [activeCollectionId] : undefined,
      });
      let pdfError: string | null = null;
      if (downloadPdf && paper.arxivId) {
        try {
          paper = await literatureApi.downloadArxivPdf(paper.id);
        } catch (e: any) {
          pdfError = e?.toString() || 'PDF 下载失败';
        }
      }

      setPapers((current) => [
        paper,
        ...current.filter((p) => p.id !== paper.id),
      ]);
      setSelectedPaperId(paper.id);
      setCompactPane('detail');
      setDiscoveryResults((current) =>
        current.map((item) =>
          item === result ? { ...item, existingPaperId: paper.id } : item,
        ),
      );
      setShowFetchModal(false);
      setStatusFilter('all');
      setActiveTag(null);
      setSearchQuery('');
      void loadOverview();

      if (downloadPdf && paper.pdfPath) {
        setReaderPaper(paper);
        showToast('论文已添加，开放 PDF 已下载。');
      } else if (pdfError) {
        showToast(`论文已添加，但 PDF 下载失败：${pdfError}`);
      } else {
        showToast('论文已添加到文献库。');
      }
    } catch (e: any) {
      setDiscoveryError(e?.toString() || '添加论文失败。');
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

  const handleExecuteBibtexImport = async () => {
    if (!bibtexDraft.trim()) return;
    setBibtexLoading(true);
    try {
      const count = await literatureApi.importBibtexText(
        bibtexDraft,
        activeCollectionId || undefined,
      );
      showToast(`已导入 ${count} 篇文献`);
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
    <div className="literature-workspace" data-compact-pane={compactPane}>
      {/* -------------------------------------------------------------------- */}
      {/* Left Sidebar                                                         */}
      {/* -------------------------------------------------------------------- */}
      <aside className="lit-sidebar">
        <div className="lit-sidebar-head">
          <span className="lit-sidebar-title">文献管理</span>
        </div>

        <div className="lit-sidebar-scroll">
          {/* Main categories */}
          <div className="lit-nav-section">
            <div className="lit-section-label">分类</div>
            <button
              type="button"
              className={`lit-nav-item ${
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
              <span className="lit-nav-name">全部文献</span>
              <span className="lit-nav-count">
                {overview?.totalPapers || 0}
              </span>
            </button>

            <button
              type="button"
              className={`lit-nav-item ${statusFilter === 'unread' ? 'is-active' : ''}`}
              onClick={() => {
                setStatusFilter('unread');
                setActiveCollectionId(null);
                setActiveTag(null);
              }}
            >
              <span className="lit-nav-name">未读</span>
              <span className="lit-nav-count">
                {overview?.unreadCount || 0}
              </span>
            </button>

            <button
              type="button"
              className={`lit-nav-item ${statusFilter === 'reading' ? 'is-active' : ''}`}
              onClick={() => {
                setStatusFilter('reading');
                setActiveCollectionId(null);
                setActiveTag(null);
              }}
            >
              <span className="lit-nav-name">在读</span>
              <span className="lit-nav-count">
                {overview?.readingCount || 0}
              </span>
            </button>

            <button
              type="button"
              className={`lit-nav-item ${statusFilter === 'completed' ? 'is-active' : ''}`}
              onClick={() => {
                setStatusFilter('completed');
                setActiveCollectionId(null);
                setActiveTag(null);
              }}
            >
              <span className="lit-nav-name">已读</span>
              <span className="lit-nav-count">
                {overview?.completedCount || 0}
              </span>
            </button>

            <button
              type="button"
              className={`lit-nav-item ${statusFilter === 'starred' ? 'is-active' : ''}`}
              onClick={() => {
                setStatusFilter('starred');
                setActiveCollectionId(null);
                setActiveTag(null);
              }}
            >
              <span className="lit-nav-name">星标文献</span>
              <span className="lit-nav-count">
                {overview?.starredCount || 0}
              </span>
            </button>
          </div>

          {/* Collections */}
          <div className="lit-nav-section">
            <div className="lit-section-label">
              <span>文献集</span>
              <button
                type="button"
                className="lit-section-btn"
                title="新建文献集"
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
                  className={`lit-nav-item ${
                    activeCollectionId === col.id ? 'is-active' : ''
                  }`}
                  onClick={() => {
                    setActiveCollectionId(col.id);
                    setActiveTag(null);
                    setStatusFilter('all');
                  }}
                >
                  <span className="lit-nav-name">{col.name}</span>
                  <span className="lit-nav-count">{col.paperCount}</span>
                </button>
              ))
            ) : (
              <div className="lit-empty-hint">无自定义分组</div>
            )}
          </div>

          {/* Tags */}
          {overview?.allTags && overview.allTags.length > 0 && (
            <div className="lit-nav-section">
              <div className="lit-section-label">标签</div>
              <div className="lit-tag-list">
                {overview.allTags.slice(0, 16).map((t) => (
                  <span
                    key={t.name}
                    className={`lit-tag-pill ${activeTag === t.name ? 'is-active' : ''}`}
                    onClick={() => {
                      setActiveTag((prev) => (prev === t.name ? null : t.name));
                    }}
                  >
                    {t.name} ({t.count})
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* -------------------------------------------------------------------- */}
      {/* Center Main List                                                     */}
      {/* -------------------------------------------------------------------- */}
      <main className="lit-main">
        {/* Toolbar */}
        <div className="lit-toolbar">
          <div className="lit-search-wrap">
            <input
              type="text"
              className="lit-search-input"
              placeholder="搜索标题、作者、CiteKey、摘要、期刊..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="lit-toolbar-actions">
            <select
              className="lit-select"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
            >
              <option value="updatedAt">按更新时间</option>
              <option value="year">按发表年份</option>
              <option value="title">按标题排序</option>
              <option value="rating">按评分排序</option>
            </select>

            <button
              type="button"
              className="lit-btn lit-btn-primary"
              onClick={() => {
                setFetchMode('identifier');
                setShowFetchModal(true);
                setFetchedPreview(null);
                setFetchError(null);
                setFetchInput('');
              }}
            >
              DOI / arXiv 检索
            </button>

            <button
              type="button"
              className="lit-btn"
              onClick={() => setShowBibtexModal(true)}
            >
              导入 BibTeX
            </button>

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
              新建条目
            </button>
          </div>
        </div>

        {/* List Content */}
        <div className="lit-list">
          {loading && (
            <div className="lit-empty-state">
              <span className="lit-empty-desc">正在加载文献数据...</span>
            </div>
          )}

          {!loading && errorMsg && (
            <div className="lit-empty-state">
              <span
                className="lit-empty-desc"
                style={{ color: 'var(--accent)' }}
              >
                {errorMsg}
              </span>
            </div>
          )}

          {!loading && papers.length === 0 && (
            <div className="lit-empty-state">
              <span className="lit-empty-title">暂无文献记录</span>
              <span className="lit-empty-desc">
                通过上方工具栏导入 BibTeX，或使用 DOI / arXiv
                标识符在线检索添加条目。
              </span>
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

              const statusText =
                p.readStatus === 'completed'
                  ? '已读'
                  : p.readStatus === 'reading'
                    ? '在读'
                    : '未读';

              return (
                <div
                  key={p.id}
                  className={`lit-card ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => {
                    setSelectedPaperId(p.id);
                    setCompactPane('detail');
                  }}
                >
                  <div className="lit-card-row-1">
                    <span className="lit-card-title">{p.title}</span>
                    <span className="lit-citekey-badge">@{p.citeKey}</span>
                  </div>

                  <div className="lit-card-meta">
                    <span>{authorsText}</span>
                    {p.year && <span>{p.year}</span>}
                    {p.venue && <span>{p.venue}</span>}
                    {p.doi && (
                      <span style={{ color: 'var(--muted)' }}>
                        DOI: {p.doi}
                      </span>
                    )}
                  </div>

                  <div className="lit-card-footer">
                    <div
                      style={{
                        display: 'flex',
                        gap: '8px',
                        alignItems: 'center',
                      }}
                    >
                      <span className={`lit-status-tag ${p.readStatus}`}>
                        {statusText}
                      </span>

                      {/* Discrete Star Indicators */}
                      <span className="lit-stars">
                        {[1, 2, 3, 4, 5].map((star) => (
                          <span
                            key={star}
                            className={`lit-star ${star <= p.rating ? 'is-filled' : ''}`}
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
                          <span key={k} className="lit-tag-pill">
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

      {/* -------------------------------------------------------------------- */}
      {/* Right Inspector                                                      */}
      {/* -------------------------------------------------------------------- */}
      {selectedPaper && (
        <aside className="lit-inspector">
          <div className="lit-inspector-head">
            <button
              type="button"
              className="lit-btn lit-compact-back"
              onClick={() => setCompactPane('list')}
            >
              ‹ 文献列表
            </button>
            <span className="lit-inspector-head-title">条目检视</span>
            <div
              className="lit-inspector-actions"
              style={{ display: 'flex', gap: '6px', alignItems: 'center' }}
            >
              {onOpenMindmap && (
                <button
                  type="button"
                  className="lit-btn lit-btn-primary"
                  title="自动解构文献并转为思维导图"
                  onClick={handleGenerateMindmap}
                >
                  生成思维导图
                </button>
              )}

              <select
                className="lit-select"
                style={{ height: '28px', padding: '0 6px', fontSize: '11.5px' }}
                onChange={(e) => {
                  if (e.target.value) {
                    handleCopyCitation(e.target.value as any);
                    e.target.value = '';
                  }
                }}
                defaultValue=""
              >
                <option value="" disabled>
                  复制引用
                </option>
                <option value="citekey">Markdown [@citekey]</option>
                <option value="bibtex">BibTeX 条目</option>
                <option value="apa">APA 格式</option>
                <option value="ieee">IEEE 格式</option>
              </select>

              <button
                type="button"
                className="lit-btn"
                title="编辑元数据"
                onClick={() => {
                  setEditingPaper({ ...selectedPaper });
                  setShowEditModal(true);
                }}
              >
                编辑
              </button>

              <button
                type="button"
                className="lit-btn"
                style={{ color: 'var(--accent)' }}
                title="删除文献"
                onClick={() => handleDeletePaper(selectedPaper.id)}
              >
                删除
              </button>
            </div>
          </div>

          <div className="lit-inspector-body">
            {copyNotice && (
              <div
                style={{
                  padding: '6px 12px',
                  borderRadius: '4px',
                  background:
                    'color-mix(in srgb, var(--accent) 15%, transparent)',
                  color: 'var(--accent)',
                  fontSize: '11.5px',
                  textAlign: 'center',
                }}
              >
                {copyNotice}
              </div>
            )}

            <div className="lit-doc-title">{selectedPaper.title}</div>

            <div className="lit-pdf-source-actions">
              {selectedPaper.pdfPath ? (
                <>
                  <button
                    type="button"
                    className="lit-btn lit-btn-primary"
                    onClick={handleOpenPdfReader}
                  >
                    阅读 PDF 原文
                  </button>
                  <button
                    type="button"
                    className="lit-btn"
                    disabled={pdfBusy}
                    onClick={() => void handleAttachPdf(true)}
                  >
                    {pdfBusy ? '正在导入…' : '更换 PDF'}
                  </button>
                  <span>PDF 已保存在本机文献库</span>
                </>
              ) : (
                <button
                  type="button"
                  className="lit-btn lit-btn-primary"
                  disabled={pdfBusy}
                  onClick={handleOpenPdfReader}
                >
                  {pdfBusy ? '正在导入…' : '添加 PDF 原文'}
                </button>
              )}
            </div>

            {/* Metadata Grid */}
            <div className="lit-kv-grid">
              <span className="lit-kv-key">引用键</span>
              <span
                className="lit-kv-val"
                style={{ fontFamily: 'var(--mono)' }}
              >
                @{selectedPaper.citeKey}
              </span>

              <span className="lit-kv-key">作者</span>
              <span className="lit-kv-val">
                {selectedPaper.authors.join(', ') || '未记录'}
              </span>

              <span className="lit-kv-key">发表刊物</span>
              <span className="lit-kv-val">{selectedPaper.venue || '—'}</span>

              <span className="lit-kv-key">发表年份</span>
              <span className="lit-kv-val">{selectedPaper.year || '—'}</span>

              <span className="lit-kv-key">阅读状态</span>
              <span className="lit-kv-val">
                <select
                  className="lit-select"
                  style={{
                    height: '24px',
                    fontSize: '11.5px',
                    padding: '0 6px',
                  }}
                  value={selectedPaper.readStatus}
                  onChange={(e) =>
                    handleUpdateStatus(selectedPaper.id, e.target.value)
                  }
                >
                  <option value="unread">未读</option>
                  <option value="reading">在读</option>
                  <option value="completed">已读</option>
                </select>
              </span>

              <span className="lit-kv-key">重要度评分</span>
              <span className="lit-kv-val">
                <span className="lit-stars">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <span
                      key={star}
                      className={`lit-star ${
                        star <= selectedPaper.rating ? 'is-filled' : ''
                      }`}
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
              </span>

              {selectedPaper.doi && (
                <>
                  <span className="lit-kv-key">DOI</span>
                  <span className="lit-kv-val">
                    <a
                      href={`https://doi.org/${selectedPaper.doi}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        color: 'var(--ink)',
                        textDecoration: 'underline',
                      }}
                    >
                      {selectedPaper.doi}
                    </a>
                  </span>
                </>
              )}

              {selectedPaper.url && (
                <>
                  <span className="lit-kv-key">原文链接</span>
                  <span className="lit-kv-val">
                    <button
                      type="button"
                      className="lit-btn"
                      style={{
                        height: '22px',
                        fontSize: '11px',
                        padding: '0 6px',
                      }}
                      onClick={() => handleOpenLink(selectedPaper.url)}
                    >
                      打开原文链接
                    </button>
                  </span>
                </>
              )}
            </div>

            {/* Abstract */}
            {selectedPaper.abstractText && (
              <div className="lit-block-section">
                <div className="lit-block-label">摘要概览</div>
                <div className="lit-abstract-content">
                  {selectedPaper.abstractText}
                </div>
              </div>
            )}

            {/* Notes Section */}
            <div className="lit-block-section">
              <div className="lit-block-label">
                <span>研读笔记</span>
                <button
                  type="button"
                  className="lit-section-btn"
                  onClick={handleSaveNotes}
                >
                  保存
                </button>
              </div>
              <textarea
                className="lit-notes-input"
                placeholder="记录论文方法论要点、批判性评价或启发思考..."
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                onBlur={handleSaveNotes}
              />
            </div>

            {/* BibTeX Source Block */}
            {selectedPaper.bibtex && (
              <div className="lit-block-section">
                <div className="lit-block-label">
                  <span>BibTeX 源码</span>
                  <button
                    type="button"
                    className="lit-section-btn"
                    onClick={() => handleCopyCitation('bibtex')}
                  >
                    复制源码
                  </button>
                </div>
                <pre className="lit-bibtex-pre">{selectedPaper.bibtex}</pre>
              </div>
            )}
          </div>
        </aside>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* Modals                                                               */}
      {/* -------------------------------------------------------------------- */}

      {/* DOI / arXiv Search Modal */}
      {showFetchModal && (
        <div
          className="lit-dialog-backdrop"
          onClick={() => setShowFetchModal(false)}
        >
          <div className="lit-dialog-box" onClick={(e) => e.stopPropagation()}>
            <div className="lit-dialog-head">
              <span className="lit-dialog-title">在线文献检索</span>
              <button
                type="button"
                className="lit-btn"
                style={{ height: '24px', padding: '0 6px' }}
                onClick={() => setShowFetchModal(false)}
              >
                关闭
              </button>
            </div>

            <div className="lit-dialog-body">
              <div className="lit-search-mode-tabs">
                <button
                  type="button"
                  className={`lit-btn ${fetchMode === 'identifier' ? 'is-active' : ''}`}
                  onClick={() => setFetchMode('identifier')}
                >
                  DOI / arXiv ID
                </button>
                <button
                  type="button"
                  className={`lit-btn ${fetchMode === 'discovery' ? 'is-active' : ''}`}
                  onClick={() => {
                    setFetchMode('discovery');
                    setDiscoveryError(null);
                  }}
                >
                  关键词发现
                </button>
              </div>

              {fetchMode === 'identifier' ? (
                <>
                  <div style={{ display: 'flex', gap: '20px' }}>
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        fontSize: '12px',
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
                        fontSize: '12px',
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

                  <div className="lit-field-group">
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input
                        type="text"
                        className="lit-text-input"
                        placeholder={
                          fetchType === 'doi'
                            ? '输入 DOI，例如 10.48550/arXiv.1706.03762'
                            : '输入 arXiv ID，例如 1706.03762'
                        }
                        value={fetchInput}
                        onChange={(e) => setFetchInput(e.target.value)}
                        onKeyDown={(e) =>
                          e.key === 'Enter' && handleExecuteFetch()
                        }
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
                    <div style={{ color: 'var(--accent)', fontSize: '11.5px' }}>
                      {fetchError}
                    </div>
                  )}

                  {fetchedPreview && (
                    <div
                      style={{
                        background:
                          'color-mix(in srgb, var(--panel) 94%, #000)',
                        padding: '12px',
                        borderRadius: '4px',
                        border: '1px solid var(--line)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                      }}
                    >
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: '13px',
                          color: 'var(--ink)',
                        }}
                      >
                        {fetchedPreview.title}
                      </div>
                      <div
                        style={{ fontSize: '11.5px', color: 'var(--muted)' }}
                      >
                        {fetchedPreview.authors.join(', ')} (
                        {fetchedPreview.year || '年份未标注'})
                      </div>
                      {fetchedPreview.venue && (
                        <div
                          style={{ fontSize: '11.5px', color: 'var(--muted)' }}
                        >
                          刊物/会议: {fetchedPreview.venue}
                        </div>
                      )}
                      {fetchedPreview.abstractText && (
                        <div
                          style={{
                            fontSize: '11px',
                            color: 'var(--muted)',
                            maxHeight: '100px',
                            overflowY: 'auto',
                            lineHeight: 1.5,
                          }}
                        >
                          {fetchedPreview.abstractText}
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="lit-field-group">
                    <div className="lit-dialog-search-row">
                      <input
                        type="text"
                        className="lit-text-input"
                        placeholder="按论文主题、标题或作者搜索"
                        value={discoveryQuery}
                        onChange={(e) => setDiscoveryQuery(e.target.value)}
                        onKeyDown={(e) =>
                          e.key === 'Enter' && handleSearchOnline()
                        }
                      />
                      <select
                        className="lit-dialog-select"
                        style={{ width: '108px', flex: '0 0 108px' }}
                        value={discoverySource}
                        onChange={(e) =>
                          setDiscoverySource(
                            e.target.value as 'crossref' | 'arxiv',
                          )
                        }
                      >
                        <option value="arxiv">arXiv</option>
                        <option value="crossref">Crossref</option>
                      </select>
                      <button
                        type="button"
                        className="lit-btn lit-btn-primary"
                        disabled={
                          discoveryLoading || discoveryQuery.trim().length < 2
                        }
                        onClick={handleSearchOnline}
                      >
                        {discoveryLoading ? '搜索中…' : '搜索'}
                      </button>
                    </div>
                  </div>

                  <div className="lit-search-result-meta">
                    arXiv 提供论文摘要及开放 PDF；Crossref
                    提供书目元数据。结果只在你选择后写入本地文献库。
                  </div>

                  {discoveryError && (
                    <div style={{ color: 'var(--accent)', fontSize: '11.5px' }}>
                      {discoveryError}
                    </div>
                  )}

                  {discoveryResults.length > 0 && (
                    <div className="lit-search-results">
                      {discoveryResults.map((result, index) => (
                        <article
                          className="lit-search-result"
                          key={
                            result.paper.doi ||
                            result.paper.arxivId ||
                            `${result.paper.title}-${index}`
                          }
                        >
                          <div className="lit-search-result-title">
                            {result.paper.title}
                          </div>
                          <div className="lit-search-result-meta">
                            {result.source} ·{' '}
                            {result.paper.authors.slice(0, 4).join(', ')}
                            {result.paper.authors.length > 4 ? ' et al.' : ''}
                            {result.paper.year ? ` · ${result.paper.year}` : ''}
                            {result.paper.venue
                              ? ` · ${result.paper.venue}`
                              : ''}
                          </div>
                          {result.paper.abstractText && (
                            <div className="lit-search-result-abstract">
                              {result.paper.abstractText}
                            </div>
                          )}
                          <div className="lit-search-result-actions">
                            {result.existingPaperId ? (
                              <button
                                type="button"
                                className="lit-btn"
                                onClick={() =>
                                  void handleOpenDiscoveredPaper(result)
                                }
                              >
                                已在文献库 · 打开
                              </button>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="lit-btn lit-btn-primary"
                                  onClick={() =>
                                    void handleImportDiscoveredPaper(result)
                                  }
                                >
                                  加入文献库
                                </button>
                                {result.pdfUrl && result.paper.arxivId && (
                                  <button
                                    type="button"
                                    className="lit-btn"
                                    onClick={() =>
                                      void handleImportDiscoveredPaper(
                                        result,
                                        true,
                                      )
                                    }
                                  >
                                    加入并阅读开放 PDF
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="lit-dialog-foot">
              <button
                type="button"
                className="lit-btn"
                onClick={() => setShowFetchModal(false)}
              >
                取消
              </button>
              {fetchMode === 'identifier' && (
                <button
                  type="button"
                  className="lit-btn lit-btn-primary"
                  disabled={!fetchedPreview}
                  onClick={handleSaveFetchedPaper}
                >
                  保存到文献库
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* BibTeX Import Modal */}
      {showBibtexModal && (
        <div
          className="lit-dialog-backdrop"
          onClick={() => setShowBibtexModal(false)}
        >
          <div className="lit-dialog-box" onClick={(e) => e.stopPropagation()}>
            <div className="lit-dialog-head">
              <span className="lit-dialog-title">导入 BibTeX 源码</span>
              <button
                type="button"
                className="lit-btn"
                style={{ height: '24px', padding: '0 6px' }}
                onClick={() => setShowBibtexModal(false)}
              >
                关闭
              </button>
            </div>

            <div className="lit-dialog-body">
              <textarea
                className="lit-textarea"
                rows={10}
                style={{ fontFamily: 'var(--mono)', fontSize: '11px' }}
                placeholder={`@article{vaswani2017attention,\n  title = {Attention is all you need},\n  author = {Vaswani, Ashish and ...},\n  journal = {NeurIPS},\n  year = {2017}\n}`}
                value={bibtexDraft}
                onChange={(e) => setBibtexDraft(e.target.value)}
              />
            </div>

            <div className="lit-dialog-foot">
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
                {bibtexLoading ? '正在解析导入...' : '开始导入'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manual / Edit Paper Modal */}
      {showEditModal && editingPaper && (
        <div
          className="lit-dialog-backdrop"
          onClick={() => setShowEditModal(false)}
        >
          <div className="lit-dialog-box" onClick={(e) => e.stopPropagation()}>
            <div className="lit-dialog-head">
              <span className="lit-dialog-title">
                {editingPaper.id ? '编辑文献信息' : '新建文献记录'}
              </span>
              <button
                type="button"
                className="lit-btn"
                style={{ height: '24px', padding: '0 6px' }}
                onClick={() => setShowEditModal(false)}
              >
                关闭
              </button>
            </div>

            <div className="lit-dialog-body">
              <div className="lit-field-group">
                <label className="lit-field-label">标题 *</label>
                <input
                  type="text"
                  className="lit-text-input"
                  value={editingPaper.title}
                  onChange={(e) =>
                    setEditingPaper({ ...editingPaper, title: e.target.value })
                  }
                />
              </div>

              <div className="lit-field-group">
                <label className="lit-field-label">
                  作者 (英文或中文，逗号分隔)
                </label>
                <input
                  type="text"
                  className="lit-text-input"
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
                <div className="lit-field-group">
                  <label className="lit-field-label">引用键 (CiteKey)</label>
                  <input
                    type="text"
                    className="lit-text-input"
                    placeholder="留空根据作者+年份自动生成"
                    value={editingPaper.citeKey || ''}
                    onChange={(e) =>
                      setEditingPaper({
                        ...editingPaper,
                        citeKey: e.target.value,
                      })
                    }
                  />
                </div>

                <div className="lit-field-group">
                  <label className="lit-field-label">发表年份</label>
                  <input
                    type="number"
                    className="lit-text-input"
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

              <div className="lit-field-group">
                <label className="lit-field-label">发表期刊 / 会议</label>
                <input
                  type="text"
                  className="lit-text-input"
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
                <div className="lit-field-group">
                  <label className="lit-field-label">DOI</label>
                  <input
                    type="text"
                    className="lit-text-input"
                    value={editingPaper.doi || ''}
                    onChange={(e) =>
                      setEditingPaper({ ...editingPaper, doi: e.target.value })
                    }
                  />
                </div>

                <div className="lit-field-group">
                  <label className="lit-field-label">原文链接</label>
                  <input
                    type="text"
                    className="lit-text-input"
                    value={editingPaper.url || ''}
                    onChange={(e) =>
                      setEditingPaper({ ...editingPaper, url: e.target.value })
                    }
                  />
                </div>
              </div>

              <div className="lit-field-group">
                <label className="lit-field-label">摘要</label>
                <textarea
                  className="lit-textarea"
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

            <div className="lit-dialog-foot">
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
          className="lit-dialog-backdrop"
          onClick={() => setShowNewCollectionModal(false)}
        >
          <div className="lit-dialog-box" onClick={(e) => e.stopPropagation()}>
            <div className="lit-dialog-head">
              <span className="lit-dialog-title">新建文献集</span>
              <button
                type="button"
                className="lit-btn"
                style={{ height: '24px', padding: '0 6px' }}
                onClick={() => setShowNewCollectionModal(false)}
              >
                关闭
              </button>
            </div>
            <div className="lit-dialog-body">
              <div className="lit-field-group">
                <label className="lit-field-label">文献集名称</label>
                <input
                  type="text"
                  className="lit-text-input"
                  placeholder="例如：大语言模型长文本、强化学习、视觉生成"
                  value={newCollectionName}
                  onChange={(e) => setNewCollectionName(e.target.value)}
                />
              </div>
            </div>
            <div className="lit-dialog-foot">
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
                    alert(`创建文献集失败: ${e}`);
                  }
                }}
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {readerPaper && (
        <React.Suspense
          fallback={
            <div className="paper-reader-overlay">
              <div className="paper-reader-message">正在加载 PDF 阅读器…</div>
            </div>
          }
        >
          <PaperPdfReader
            paper={readerPaper}
            onClose={() => setReaderPaper(null)}
            onReadStarted={handleReaderStarted}
          />
        </React.Suspense>
      )}
    </div>
  );
};

export default LiteratureWorkspace;
