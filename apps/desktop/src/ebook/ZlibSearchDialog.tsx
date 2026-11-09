import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { EpubBookDocument } from '../library/library';
import { zlibApi } from './zlib-api';
import type { ZlibBook, ZlibEnvironment } from './zlib-api';
import './zlib-search.css';

function errorMessage(caught: unknown, fallback: string): string {
  return typeof caught === 'string'
    ? caught
    : (caught as Error)?.message || fallback;
}

function isExpiredSession(message: string): boolean {
  return /not logged in|session expired|请先登录/i.test(message);
}

function explainSearchError(message: string): string {
  if (/network request failed|连接.*失败|无法连接|节点不可达/i.test(message)) {
    return '本机会话仍已保存，但当前书库节点无法连接。请检查网络，或在终端运行 zlib doctor 查看可用节点。';
  }
  return message;
}

export default function ZlibSearchDialog({
  active,
  hasRoot,
  onBookDownloaded,
}: {
  active: boolean;
  hasRoot: boolean;
  onBookDownloaded(book: EpubBookDocument, openImmediately: boolean): void;
}) {
  const [env, setEnv] = useState<ZlibEnvironment | null>(null);
  const [environmentError, setEnvironmentError] = useState('');
  const [loginOpen, setLoginOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [query, setQuery] = useState('');
  const [format, setFormat] = useState('epub');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<ZlibBook[]>([]);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadedBooks, setDownloadedBooks] = useState<
    Map<string, EpubBookDocument>
  >(new Map());

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setEnvironmentError('');
    void zlibApi
      .checkEnvironment()
      .then((next) => {
        if (!cancelled) setEnv(next);
      })
      .catch(() => {
        if (!cancelled) setEnvironmentError('无法检测本机找书组件。');
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  const closeLogin = () => {
    setLoginOpen(false);
    setPassword('');
    setLoginError('');
  };

  const searchBooks = async (authenticated = false) => {
    const term = query.trim();
    if (!term || searching) return;
    if (!authenticated && !env?.hasLogin) {
      setLoginOpen(true);
      return;
    }
    setSearching(true);
    setSearched(true);
    setSearchError('');
    setDownloadError('');
    try {
      const response = await zlibApi.search(term, format, 24);
      setResults(response.books);
    } catch (caught) {
      const message = errorMessage(caught, '搜索失败，请稍后重试。');
      if (isExpiredSession(message)) {
        setEnv((current) =>
          current ? { ...current, hasLogin: false } : current,
        );
        setLoginError('登录会话已失效，请重新登录。');
        setLoginOpen(true);
      } else {
        setSearchError(explainSearchError(message));
      }
    } finally {
      setSearching(false);
    }
  };

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loggingIn || !email.trim() || !password) return;
    setLoggingIn(true);
    setLoginError('');
    try {
      await zlibApi.login(email.trim(), password);
      setEnv((current) => (current ? { ...current, hasLogin: true } : current));
      closeLogin();
      // 用户先输入关键词再登录时，认证完成后直接继续该次检索。
      if (query.trim()) void searchBooks(true);
    } catch (caught) {
      setLoginError(errorMessage(caught, '登录失败，请稍后重试。'));
    } finally {
      setPassword('');
      setLoggingIn(false);
    }
  };

  const downloadBook = async (book: ZlibBook) => {
    if (!hasRoot) {
      setDownloadError('请先选择文件库位置，再下载到书架。');
      return;
    }
    const idHash = `${book.id}:${book.hash}`;
    setDownloadingId(idHash);
    setDownloadError('');
    try {
      const document = await zlibApi.downloadBook(idHash, book.title);
      setDownloadedBooks((current) => new Map(current).set(idHash, document));
      onBookDownloaded(document, false);
    } catch (caught) {
      const message = errorMessage(caught, '下载失败。');
      if (isExpiredSession(message)) {
        setEnv((current) =>
          current ? { ...current, hasLogin: false } : current,
        );
        setLoginError('登录会话已失效，请重新登录。');
        setLoginOpen(true);
      } else {
        setDownloadError(explainSearchError(message));
      }
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <>
      <aside className="zlib-side-panel" aria-label="在线找书">
        <header className="zlib-side-header">
          <div>
            <span className="zlib-side-kicker">ONLINE CATALOG</span>
            <h2>在线找书</h2>
          </div>
          <span
            className={`zlib-side-status${env?.hasLogin ? ' is-connected' : ''}`}
          >
            {!env
              ? '检测中'
              : env.hasLogin
                ? '会话已保存'
                : env.installed
                  ? '未登录'
                  : '未安装'}
          </span>
        </header>

        <div className="zlib-side-controls">
          <form
            className="zlib-side-search"
            onSubmit={(event) => {
              event.preventDefault();
              void searchBooks();
            }}
          >
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="书名、作者或 ISBN"
              aria-label="在线搜索书籍"
            />
            <div className="zlib-side-search-actions">
              <select
                value={format}
                onChange={(event) => setFormat(event.target.value)}
                aria-label="书籍格式"
              >
                <option value="epub">EPUB</option>
                <option value="">全部格式</option>
                <option value="pdf">PDF</option>
              </select>
              <button
                type="submit"
                disabled={!query.trim() || searching || !env?.installed}
              >
                {searching ? '检索中…' : '查找'}
              </button>
            </div>
          </form>
          {env?.installed && !env.hasLogin && (
            <button
              type="button"
              className="zlib-side-login"
              onClick={() => setLoginOpen(true)}
            >
              登录账号以检索和下载
            </button>
          )}
          {!env && !environmentError && (
            <p className="zlib-side-hint">正在检查找书组件…</p>
          )}
          {environmentError && (
            <p className="zlib-side-error" role="alert">
              {environmentError}
            </p>
          )}
          {env && !env.installed && (
            <p className="zlib-side-hint">
              在终端运行 <code>winget install --id heartleo.zlib --exact</code>
              ，安装后重新进入电子书页。
            </p>
          )}
          {downloadError && (
            <p className="zlib-side-error" role="alert">
              {downloadError}
            </p>
          )}
        </div>

        <div className="zlib-side-results">
          {searching ? (
            <p className="zlib-side-empty" role="status">
              正在检索书目…
            </p>
          ) : searchError ? (
            <p className="zlib-side-error" role="alert">
              {searchError}
            </p>
          ) : !searched ? (
            <p className="zlib-side-empty">
              输入书名、作者或 ISBN，结果将在这里展示。
            </p>
          ) : results.length === 0 ? (
            <p className="zlib-side-empty">
              没有找到匹配的书籍。请换一个关键词再试。
            </p>
          ) : (
            <div className="zlib-results-grid">
              {results.map((book) => {
                const idHash = `${book.id}:${book.hash}`;
                const document = downloadedBooks.get(idHash);
                return (
                  <article className="zlib-book-card" key={idHash}>
                    <div className="zlib-book-cover-wrap">
                      {book.cover ? (
                        <img
                          className="zlib-book-cover"
                          src={book.cover}
                          alt=""
                          loading="lazy"
                        />
                      ) : (
                        <div className="zlib-cover-placeholder">
                          {book.extension?.toUpperCase() || 'BOOK'}
                        </div>
                      )}
                    </div>
                    <div className="zlib-book-info">
                      <h3 className="zlib-book-title" title={book.title}>
                        {book.title}
                      </h3>
                      {book.author && (
                        <p className="zlib-book-author" title={book.author}>
                          {book.author}
                        </p>
                      )}
                      <div className="zlib-book-meta">
                        {[book.year, book.language, book.filesize]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                      <div className="zlib-book-actions">
                        {document ? (
                          <button
                            type="button"
                            className="zlib-read-btn"
                            onClick={() => onBookDownloaded(document, true)}
                          >
                            打开阅读
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="zlib-download-btn"
                            disabled={Boolean(downloadingId)}
                            onClick={() => void downloadBook(book)}
                          >
                            {downloadingId === idHash
                              ? '下载中…'
                              : '下载到书架'}
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      {loginOpen && (
        <div
          className="zlib-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeLogin();
          }}
        >
          <div
            className="zlib-modal zlib-modal-auth"
            role="dialog"
            aria-modal="true"
            aria-labelledby="zlib-login-title"
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeLogin();
            }}
          >
            <header className="zlib-modal-header">
              <div className="zlib-header-left">
                <span className="zlib-login-kicker">ACCOUNT / 本机登录</span>
                <h2 id="zlib-login-title">登录找书账号</h2>
              </div>
              <button
                type="button"
                className="zlib-close-btn"
                onClick={closeLogin}
                aria-label="关闭登录窗口"
              >
                ×
              </button>
            </header>
            <form
              className="zlib-login-panel"
              onSubmit={(event) => void handleLogin(event)}
            >
              <p>
                登录会话保存在本机 zlib 配置目录，关闭 Seamind
                后仍可使用；密码不会写入文件或命令行。
              </p>
              <label>
                邮箱
                <input
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoFocus
                  required
                />
              </label>
              <label>
                密码
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>
              {loginError && (
                <p className="zlib-login-error" role="alert">
                  {loginError}
                </p>
              )}
              <div className="zlib-login-actions">
                <button type="submit" disabled={loggingIn}>
                  {loggingIn ? '正在登录…' : '登录'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLoginError('');
                    void zlibApi
                      .checkEnvironment()
                      .then((next) => {
                        setEnv(next);
                        if (next.hasLogin) closeLogin();
                      })
                      .catch(() => setLoginError('重新检测登录状态失败。'));
                  }}
                >
                  已在终端登录？刷新状态
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
