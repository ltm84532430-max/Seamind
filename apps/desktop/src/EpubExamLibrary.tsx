import { useEffect, useState } from 'react';
import type { EpubExamSummary } from './epub-exams';
import { formatEpubExamDate } from './epub-exams';
import { findStoredCoverByBookKey } from './ebook-storage';
import { zlibApi } from './zlib-api';
import type { ZlibBook } from './zlib-api';
import type { EpubBookDocument } from './library';

export type ExamBook = {
  relativePath: string;
  title: string;
  coverDataUrl?: string | null;
};

export function EpubExamLibraryPanel({
  books,
  exams,
  filteredBookKey,
  loading,
  error,
  open,
  collapsed = false,
  onToggleCollapsed,
  onClose,
  onFilterBook,
  onOpenExam,
  hasRoot = true,
  onBookDownloaded,
  onOpenZlibDialog,
}: {
  books: ExamBook[];
  exams: EpubExamSummary[];
  filteredBookKey: string;
  loading: boolean;
  error: string;
  open: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onClose: () => void;
  onFilterBook: (bookKey: string) => void;
  onOpenExam: (exam: EpubExamSummary) => void;
  hasRoot?: boolean;
  onBookDownloaded?: (book: EpubBookDocument, openImmediately: boolean) => void;
  onOpenZlibDialog?: () => void;
}) {
  const [activeTab, setActiveTab] = useState<'exams' | 'online'>('exams');
  const [onlineQuery, setOnlineQuery] = useState('');
  const [onlineFormat, setOnlineFormat] = useState('epub');
  const [onlineSearching, setOnlineSearching] = useState(false);
  const [onlineResults, setOnlineResults] = useState<ZlibBook[]>([]);
  const [onlineError, setOnlineError] = useState('');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  const [downloadError, setDownloadError] = useState('');

  useEffect(() => {
    if (filteredBookKey) {
      setActiveTab('exams');
    }
  }, [filteredBookKey]);

  const handleOnlineSearch = async () => {
    const q = onlineQuery.trim();
    if (!q || onlineSearching) return;
    setOnlineSearching(true);
    setOnlineError('');
    setDownloadError('');
    try {
      const res = await zlibApi.search(q, onlineFormat, 20);
      setOnlineResults(res.books || []);
      if (!res.books || res.books.length === 0) {
        setOnlineError('未找到匹配书籍，建议尝试更换关键词或作者。');
      }
    } catch (caught) {
      setOnlineError(
        typeof caught === 'string'
          ? caught
          : (caught as Error)?.message || '搜索失败，请检查网络或配置',
      );
    } finally {
      setOnlineSearching(false);
    }
  };

  const handleOnlineDownload = async (book: ZlibBook) => {
    if (!hasRoot) {
      setDownloadError('请先在应用中选择书架保存目录（文件库位置）。');
      return;
    }
    const idHash = `${book.id}:${book.hash}`;
    setDownloadingId(idHash);
    setDownloadError('');
    try {
      const doc = await zlibApi.downloadBook(idHash, book.title);
      setDownloadedIds((prev) => new Set(prev).add(idHash));
      onBookDownloaded?.(doc, false);
    } catch (caught) {
      setDownloadError(
        typeof caught === 'string'
          ? caught
          : (caught as Error)?.message || '下载失败',
      );
    } finally {
      setDownloadingId(null);
    }
  };

  const [query, setQuery] = useState('');
  const bookMeta = new Map(
    books.map((book) => [
      book.relativePath,
      { title: book.title, coverDataUrl: book.coverDataUrl },
    ]),
  );
  const grouped = new Map<string, EpubExamSummary[]>();
  for (const exam of exams) {
    const current = grouped.get(exam.bookKey) ?? [];
    current.push(exam);
    grouped.set(exam.bookKey, current);
  }
  const search = query.trim().toLocaleLowerCase();
  const groups = [...grouped.entries()]
    .map(([bookKey, items]) => {
      const meta = bookMeta.get(bookKey);
      const title = meta?.title || items[0]?.bookTitle || '未命名书籍';
      const coverDataUrl =
        meta?.coverDataUrl || findStoredCoverByBookKey(bookKey);
      return {
        bookKey,
        title,
        coverDataUrl,
        exams: items
          .filter((exam) =>
            `${exam.sourceSectionLabel} ${exam.bookTitle} ${title}`
              .toLocaleLowerCase()
              .includes(search),
          )
          .sort((left, right) => right.createdAt - left.createdAt),
      };
    })
    .filter(
      (group) =>
        (!filteredBookKey || group.bookKey === filteredBookKey) &&
        group.exams.length > 0,
    )
    .sort(
      (left, right) =>
        (right.exams[0]?.createdAt ?? 0) - (left.exams[0]?.createdAt ?? 0),
    );

  return (
    <>
      {open && (
        <button
          className="epub-exam-library-backdrop"
          type="button"
          aria-label="关闭试卷库"
          onClick={onClose}
        />
      )}
      <aside
        className={`epub-exam-library${open ? ' is-open' : ''}${collapsed ? ' is-collapsed' : ''}`}
        aria-label="试卷库"
      >
        <header className="epub-exam-library-heading">
          <div className="epub-side-panel-tabs">
            <button
              type="button"
              className={`epub-side-panel-tab${activeTab === 'exams' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('exams')}
            >
              试卷库{' '}
              {exams.length > 0 && (
                <span className="epub-tab-badge">{exams.length}</span>
              )}
            </button>
            <button
              type="button"
              className={`epub-side-panel-tab${activeTab === 'online' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('online')}
            >
              在线找书
            </button>
          </div>
          <div className="epub-side-panel-heading-actions">
            {onToggleCollapsed && (
              <button
                className="epub-exam-library-collapse"
                type="button"
                aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
                aria-expanded={!collapsed}
                title={collapsed ? '展开侧栏' : '收起侧栏'}
                onClick={onToggleCollapsed}
              >
                {collapsed ? '‹' : '›'}
              </button>
            )}
            <button
              className="epub-exam-library-close"
              type="button"
              aria-label="关闭侧栏"
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </header>

        {collapsed && onToggleCollapsed && (
          <button
            type="button"
            className="epub-exam-library-collapsed-rail"
            onClick={onToggleCollapsed}
            title={activeTab === 'exams' ? '展开试卷库' : '展开在线找书'}
            aria-label={activeTab === 'exams' ? '展开试卷库' : '展开在线找书'}
          >
            <span className="epub-exam-library-rail-text">
              {activeTab === 'exams' ? '试卷库' : '在线找书'}
            </span>
            {activeTab === 'exams' && exams.length > 0 && (
              <span className="epub-exam-library-rail-badge">
                {exams.length}
              </span>
            )}
          </button>
        )}

        {!collapsed && (
          <>
            {activeTab === 'online' ? (
              <div className="epub-online-search-panel">
                <p className="epub-exam-library-intro">
                  在线搜索海量书籍，下载后自动加入书架。
                </p>
                <div className="epub-online-search-bar">
                  <input
                    type="search"
                    className="epub-online-search-input"
                    placeholder="书名、作者或关键词"
                    aria-label="搜索在线书籍"
                    value={onlineQuery}
                    onChange={(e) => setOnlineQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleOnlineSearch();
                    }}
                  />
                  <select
                    className="epub-online-format-select"
                    value={onlineFormat}
                    onChange={(e) => setOnlineFormat(e.target.value)}
                    aria-label="格式筛选"
                  >
                    <option value="epub">EPUB</option>
                    <option value="">全部</option>
                    <option value="pdf">PDF</option>
                  </select>
                  <button
                    type="button"
                    className="epub-online-search-btn"
                    disabled={onlineSearching || !onlineQuery.trim()}
                    onClick={() => void handleOnlineSearch()}
                  >
                    {onlineSearching ? '检索中…' : '搜索'}
                  </button>
                </div>

                {downloadError && (
                  <div className="epub-online-alert is-error" role="alert">
                    {downloadError}
                  </div>
                )}

                {onlineError && (
                  <div className="epub-online-alert is-error" role="alert">
                    {onlineError}
                  </div>
                )}

                {onlineSearching ? (
                  <div className="epub-online-state-box">
                    <p>正在检索海量书目…</p>
                  </div>
                ) : onlineResults.length > 0 ? (
                  <div className="epub-online-results-list">
                    {onlineResults.map((book) => {
                      const idHash = `${book.id}:${book.hash}`;
                      const isDownloading = downloadingId === idHash;
                      const isDownloaded = downloadedIds.has(idHash);

                      return (
                        <article key={idHash} className="epub-online-book-item">
                          <div className="epub-online-book-thumb">
                            {book.cover ? (
                              <img
                                src={book.cover}
                                alt={book.title}
                                loading="lazy"
                              />
                            ) : (
                              <span className="epub-online-book-thumb-fallback">
                                {book.extension?.toUpperCase() || 'EPUB'}
                              </span>
                            )}
                          </div>
                          <div className="epub-online-book-info">
                            <strong
                              className="epub-online-book-title"
                              title={book.title}
                            >
                              {book.title}
                            </strong>
                            <span className="epub-online-book-meta">
                              {book.author || '未知作者'}
                              {book.year ? ` · ${book.year}` : ''}
                              {book.filesize ? ` · ${book.filesize}` : ''}
                            </span>
                          </div>
                          <div className="epub-online-book-action">
                            {isDownloaded ? (
                              <span className="epub-online-downloaded-tag">
                                已加入
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="epub-online-download-btn"
                                disabled={isDownloading}
                                onClick={() => void handleOnlineDownload(book)}
                              >
                                {isDownloading ? '下载中…' : '下载'}
                              </button>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="epub-online-state-box is-empty">
                    <strong>发现好书</strong>
                    <p>
                      输入关键词检索全球数百万书籍，一键下载并加入当前书架。
                    </p>
                    {onOpenZlibDialog && (
                      <button
                        type="button"
                        className="epub-online-expand-btn"
                        onClick={onOpenZlibDialog}
                      >
                        打开大窗口搜索
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <>
                <p className="epub-exam-library-intro">
                  阅读时按当前段落生成，试卷和作答保存在本机。
                </p>
                <label className="epub-exam-library-search">
                  <span aria-hidden="true">⌕</span>
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索书名或段落"
                    aria-label="搜索试卷"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      aria-label="清除搜索"
                    >
                      ×
                    </button>
                  )}
                </label>
                {filteredBookKey && (
                  <button
                    type="button"
                    className="epub-exam-library-clear-filter"
                    onClick={() => onFilterBook('')}
                  >
                    显示全部书籍的试卷
                  </button>
                )}
                {error && (
                  <p className="epub-exam-library-error" role="alert">
                    {error}
                  </p>
                )}
                {loading ? (
                  <p className="epub-exam-library-empty">正在读取本地试卷…</p>
                ) : groups.length ? (
                  <div className="epub-exam-library-groups">
                    {groups.map((group) => (
                      <section
                        className="epub-exam-book-group"
                        key={group.bookKey}
                      >
                        <button
                          type="button"
                          className={`epub-exam-book-heading${filteredBookKey === group.bookKey ? ' is-active' : ''}`}
                          onClick={() => onFilterBook(group.bookKey)}
                          title={`筛选《${group.title}》的试卷`}
                        >
                          <div
                            className="epub-exam-book-cover"
                            aria-hidden="true"
                          >
                            {group.coverDataUrl ? (
                              <img
                                src={group.coverDataUrl}
                                alt=""
                                loading="lazy"
                                className="epub-exam-book-cover-img"
                              />
                            ) : (
                              <span className="epub-exam-book-cover-fallback">
                                {group.title.slice(0, 1)}
                              </span>
                            )}
                          </div>
                          <div className="epub-exam-book-info">
                            <span
                              className="epub-exam-book-title"
                              title={group.title}
                            >
                              {group.title}
                            </span>
                            <small className="epub-exam-book-count">
                              {group.exams.length} 份试卷
                            </small>
                          </div>
                        </button>
                        <div className="epub-exam-book-list">
                          {group.exams.map((exam) => (
                            <button
                              type="button"
                              className="epub-exam-entry"
                              key={exam.id}
                              onClick={() => onOpenExam(exam)}
                            >
                              <span
                                className="epub-exam-entry-title"
                                title={exam.sourceSectionLabel}
                              >
                                {exam.sourceSectionLabel || '当前阅读段落'}
                              </span>
                              <span className="epub-exam-entry-meta">
                                {formatEpubExamDate(exam.createdAt)} ·{' '}
                                {exam.questionCount} 题
                              </span>
                              <span
                                className={`epub-exam-status is-${exam.status}`}
                              >
                                {exam.status === 'submitted'
                                  ? '已交卷'
                                  : '未交卷'}
                              </span>
                            </button>
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                ) : (
                  <div className="epub-exam-library-empty">
                    <span aria-hidden="true">▤</span>
                    <strong>
                      {search || filteredBookKey
                        ? '没有匹配的试卷'
                        : '还没有试卷'}
                    </strong>
                    <p>
                      {filteredBookKey
                        ? '这本书还没有试卷，阅读时可以根据当前段落生成。'
                        : '打开一本书，在阅读器中选择“根据当前内容生成试卷”。'}
                    </p>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </aside>
    </>
  );
}

export { EpubExamWorkspace, ExamErrorBoundary } from './EpubExamWorkspace';
