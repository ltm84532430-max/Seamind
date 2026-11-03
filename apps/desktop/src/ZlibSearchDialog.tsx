import { useEffect, useState } from 'react';
import type { EpubBookDocument } from './library';
import { zlibApi } from './zlib-api';
import type { ZlibBook, ZlibEnvironment } from './zlib-api';
import './zlib-search.css';

export default function ZlibSearchDialog({
  open,
  onClose,
  onBookDownloaded,
  hasRoot,
}: {
  open: boolean;
  onClose(): void;
  onBookDownloaded(book: EpubBookDocument, openImmediately: boolean): void;
  hasRoot: boolean;
}) {
  const [query, setQuery] = useState('');
  const [format, setFormat] = useState('epub');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<ZlibBook[]>([]);
  const [error, setError] = useState('');
  const [env, setEnv] = useState<ZlibEnvironment | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadedBooks, setDownloadedBooks] = useState<
    Map<string, EpubBookDocument>
  >(new Map());
  const [downloadError, setDownloadError] = useState('');
  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => {
    if (!open) return;
    void zlibApi
      .checkEnvironment()
      .then((data) => setEnv(data))
      .catch(() => {});
  }, [open]);

  if (!open) return null;

  const handleSearch = async () => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setError('');
    setDownloadError('');
    try {
      const res = await zlibApi.search(q, format, 24);
      setResults(res.books);
      if (res.books.length === 0) {
        setError('未找到匹配的电子书，建议尝试更换关键词或作者名。');
      }
    } catch (caught) {
      setError(
        typeof caught === 'string'
          ? caught
          : (caught as Error)?.message || '搜索失败，请稍后重试',
      );
    } finally {
      setSearching(false);
    }
  };

  const handleDownload = async (
    book: ZlibBook,
    openImmediately: boolean = false,
  ) => {
    if (!hasRoot) {
      setDownloadError('请先在应用中选择书架保存目录（文件库位置）。');
      return;
    }

    const idHash = `${book.id}:${book.hash}`;
    setDownloadingId(idHash);
    setDownloadError('');

    try {
      const doc = await zlibApi.downloadBook(idHash, book.title);
      setDownloadedBooks((prev) => {
        const next = new Map(prev);
        next.set(idHash, doc);
        return next;
      });
      onBookDownloaded(doc, openImmediately);
    } catch (caught) {
      const msg =
        typeof caught === 'string'
          ? caught
          : (caught as Error)?.message || '下载失败';
      setDownloadError(msg);
      if (!env?.installed) {
        setShowGuide(true);
      }
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div className="zlib-modal-backdrop" onClick={onClose}>
      <div
        className="zlib-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="zlib-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="zlib-modal-header">
          <div className="zlib-header-left">
            <h2 id="zlib-modal-title">Z-Library 在线找书</h2>
            <div className="zlib-env-pill">
              {env?.installed ? (
                <span
                  className="zlib-dot is-online"
                  title="已连接 Z-Library CLI"
                >
                  ● 已连接 CLI {env.version ? `(${env.version})` : ''}
                </span>
              ) : (
                <button
                  type="button"
                  className="zlib-guide-link"
                  onClick={() => setShowGuide((prev) => !prev)}
                  title="点击查看安装指南"
                >
                  <span className="zlib-dot is-warn">
                    ● 在线检索模式 (点击配置)
                  </span>
                </button>
              )}
            </div>
          </div>
          <button
            type="button"
            className="zlib-close-btn"
            onClick={onClose}
            aria-label="关闭"
          >
            ✕
          </button>
        </header>

        {showGuide && (
          <div className="zlib-guide-banner">
            <div className="zlib-guide-text">
              <strong>💡 接入 heartleo/zlib CLI 提示：</strong>
              <p>
                当前处于免安装在线预览模式。安装 <code>heartleo/zlib</code>{' '}
                后即可享受全速多线程下载与账号免流配额。 Windows 用户可执行：
                <code>winget install --id heartleo.zlib --exact</code>
              </p>
            </div>
            <button
              type="button"
              className="zlib-guide-close"
              onClick={() => setShowGuide(false)}
            >
              我知道了
            </button>
          </div>
        )}

        <div className="zlib-search-bar">
          <input
            type="search"
            autoFocus
            className="zlib-search-input"
            placeholder="输入书名、作者或 ISBN（如：深入理解计算机系统 / 纳瓦尔宝典 / Dune）..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSearch();
            }}
          />
          <select
            className="zlib-format-select"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            aria-label="格式筛选"
          >
            <option value="epub">EPUB</option>
            <option value="">全部格式</option>
            <option value="pdf">PDF</option>
          </select>
          <button
            type="button"
            className="zlib-search-btn"
            disabled={searching || !query.trim()}
            onClick={() => void handleSearch()}
          >
            {searching ? '正在检索…' : '搜索书籍'}
          </button>
        </div>

        {downloadError && (
          <div className="zlib-alert-error" role="alert">
            <span>⚠ {downloadError}</span>
          </div>
        )}

        <main className="zlib-modal-body">
          {searching && (
            <div className="zlib-state-box">
              <div className="zlib-spinner" />
              <p>正在连接 Z-Library 检索海量书目…</p>
            </div>
          )}

          {!searching && error && (
            <div className="zlib-state-box is-error">
              <p>{error}</p>
            </div>
          )}

          {!searching && !error && results.length === 0 && (
            <div className="zlib-state-box is-empty">
              <div className="zlib-empty-icon">📖</div>
              <h3>开始发现你的下一本好书</h3>
              <p>
                支持搜索数百万册全球书籍。搜索后可一键下载并自动加入当前 Seamind
                书架，立即研读并生成导图。
              </p>
            </div>
          )}

          {!searching && results.length > 0 && (
            <div className="zlib-results-grid">
              {results.map((book) => {
                const idHash = `${book.id}:${book.hash}`;
                const isDownloading = downloadingId === idHash;
                const downloadedDoc = downloadedBooks.get(idHash);

                return (
                  <article key={idHash} className="zlib-book-card">
                    <div className="zlib-book-cover-wrap">
                      {book.cover ? (
                        <img
                          src={book.cover}
                          alt={book.title}
                          loading="lazy"
                          className="zlib-book-cover"
                        />
                      ) : (
                        <div className="zlib-cover-placeholder">
                          <span>{book.extension?.toUpperCase() || 'EPUB'}</span>
                        </div>
                      )}
                      {book.extension && (
                        <span className="zlib-ext-badge">
                          {book.extension.toUpperCase()}
                        </span>
                      )}
                    </div>

                    <div className="zlib-book-info">
                      <h4 className="zlib-book-title" title={book.title}>
                        {book.title}
                      </h4>
                      {book.author && (
                        <p className="zlib-book-author" title={book.author}>
                          {book.author}
                        </p>
                      )}

                      <div className="zlib-book-meta">
                        {book.year && <span>{book.year} 年</span>}
                        {book.language && <span>· {book.language}</span>}
                        {book.filesize && <span>· {book.filesize}</span>}
                      </div>

                      <div className="zlib-book-actions">
                        {downloadedDoc ? (
                          <div className="zlib-downloaded-group">
                            <span className="zlib-done-tag">✓ 已入库</span>
                            <button
                              type="button"
                              className="zlib-read-btn"
                              onClick={() => {
                                onBookDownloaded(downloadedDoc, true);
                                onClose();
                              }}
                            >
                              立即阅读
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="zlib-download-btn"
                            disabled={isDownloading || Boolean(downloadingId)}
                            onClick={() => void handleDownload(book, false)}
                          >
                            {isDownloading ? '正在下载…' : '下载到书架'}
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
