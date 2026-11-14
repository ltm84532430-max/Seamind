import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { EpubBookDocument } from '../library/library';
import { zlibApi } from './zlib-api';
import type { ZlibBook, ZlibEnvironment, ZlibProfile } from './zlib-api';
import {
  buildZlibBookKey,
  classifyZlibError,
  explainZlibError,
  formatDomainLabel,
  formatZlibQuota,
  normalizeBookIdHash,
} from './zlib-helpers';
import type { ZlibConnectionState } from './zlib-helpers';
import './zlib-search.css';

const LAST_EMAIL_STORAGE_KEY = 'seamind.zlib.lastEmail';

type PendingZlibAction =
  | { kind: 'search' }
  | { kind: 'download'; book: ZlibBook }
  | null;

function readRememberedEmail(): string {
  try {
    return window.localStorage.getItem(LAST_EMAIL_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function saveRememberedEmail(email: string) {
  try {
    const trimmed = email.trim();
    if (trimmed) {
      window.localStorage.setItem(LAST_EMAIL_STORAGE_KEY, trimmed);
    }
  } catch {
    // 忽略受限环境下的本地存储异常。
  }
}

function errorMessage(caught: unknown, fallback: string): string {
  return typeof caught === 'string'
    ? caught
    : (caught as Error)?.message || fallback;
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
  const [profile, setProfile] = useState<ZlibProfile | null>(null);
  const [connectionState, setConnectionState] =
    useState<ZlibConnectionState>('checking');
  const [environmentError, setEnvironmentError] = useState('');
  const [healthyDomains, setHealthyDomains] = useState<string[]>([]);
  const [switchingNode, setSwitchingNode] = useState(false);

  const [loginOpen, setLoginOpen] = useState(false);
  const [email, setEmail] = useState(() => readRememberedEmail());
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
  const [failedCovers, setFailedCovers] = useState<Set<string>>(new Set());
  const [downloadedBooks, setDownloadedBooks] = useState<
    Map<string, EpubBookDocument>
  >(new Map());

  const pendingActionRef = useRef<PendingZlibAction>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshConnection = useCallback(async () => {
    setEnvironmentError('');
    setConnectionState('checking');
    try {
      const nextEnv = await zlibApi.checkEnvironment();
      if (!mountedRef.current) return nextEnv;
      setEnv(nextEnv);

      if (!nextEnv.installed) {
        setProfile(null);
        setConnectionState('missing');
        return nextEnv;
      }
      if (!nextEnv.hasLogin) {
        setProfile(null);
        setConnectionState('unauthenticated');
        return nextEnv;
      }

      try {
        const nextProfile = await zlibApi.getProfile();
        if (!mountedRef.current) return nextEnv;
        setProfile(nextProfile);
        if (nextProfile.isLoggedIn) {
          setConnectionState('connected');
          if (nextProfile.email) {
            saveRememberedEmail(nextProfile.email);
            setEmail((current) => current || nextProfile.email || '');
          }
          if (nextProfile.activeDomain) {
            setEnv((current) =>
              current
                ? { ...current, activeDomain: nextProfile.activeDomain }
                : current,
            );
          }
        } else {
          setConnectionState('expired');
        }
      } catch (caught) {
        if (!mountedRef.current) return nextEnv;
        const raw = errorMessage(caught, '无法验证登录状态。');
        const kind = classifyZlibError(raw);
        setProfile(null);
        setConnectionState(kind === 'auth_expired' ? 'expired' : 'offline');
        if (kind === 'network') {
          setEnvironmentError(explainZlibError(raw));
        }
      }
      return nextEnv;
    } catch {
      if (!mountedRef.current) return null;
      setEnvironmentError('无法检测本机找书组件。');
      setConnectionState('offline');
      return null;
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refreshConnection();
  }, [active, refreshConnection]);

  const openLoginModal = useCallback((reason?: string) => {
    setEmail((current) => current || readRememberedEmail());
    setPassword('');
    setLoginError(reason || '');
    setLoginOpen(true);
  }, []);

  const closeLogin = () => {
    setLoginOpen(false);
    setPassword('');
    setLoginError('');
  };

  const searchBooks = async (authenticated = false) => {
    const term = query.trim();
    if (!term || searching) return;
    if (!authenticated && (!env?.hasLogin || connectionState === 'expired')) {
      pendingActionRef.current = { kind: 'search' };
      openLoginModal(
        connectionState === 'expired'
          ? '登录会话已失效，请重新登录。'
          : undefined,
      );
      return;
    }

    setSearching(true);
    setSearched(true);
    setSearchError('');
    setDownloadError('');
    try {
      const response = await zlibApi.search(term, format, 24);
      setResults(response.books);
      setFailedCovers(new Set());
      if (env?.hasLogin && connectionState !== 'connected') {
        setConnectionState('connected');
      }
    } catch (caught) {
      const raw = errorMessage(caught, '搜索失败，请稍后重试。');
      const kind = classifyZlibError(raw);
      if (kind === 'auth_expired') {
        setProfile(null);
        setConnectionState('expired');
        pendingActionRef.current = { kind: 'search' };
        openLoginModal('登录会话已失效，请重新登录。');
      } else {
        if (kind === 'network') setConnectionState('offline');
        setSearchError(explainZlibError(raw));
      }
    } finally {
      setSearching(false);
    }
  };

  const downloadBook = async (book: ZlibBook, authenticated = false) => {
    if (!hasRoot) {
      setDownloadError('请先选择文件库位置，再下载到书架。');
      return;
    }
    if (!authenticated && (!env?.hasLogin || connectionState === 'expired')) {
      pendingActionRef.current = { kind: 'download', book };
      openLoginModal(
        connectionState === 'expired'
          ? '登录会话已失效，请重新登录。'
          : undefined,
      );
      return;
    }

    const idHash = normalizeBookIdHash(book.id, book.hash);
    if (!idHash.includes(':')) {
      setDownloadError('书籍下载编号不完整，请重新搜索后再试。');
      return;
    }

    setDownloadingId(idHash);
    setDownloadError('');
    try {
      const document = await zlibApi.downloadBook(idHash, book.title);
      setDownloadedBooks((current) => new Map(current).set(idHash, document));
      onBookDownloaded(document, false);
      void zlibApi
        .getProfile()
        .then((nextProfile) => {
          if (mountedRef.current && nextProfile.isLoggedIn) {
            setProfile(nextProfile);
            setConnectionState('connected');
          }
        })
        .catch(() => {});
    } catch (caught) {
      const raw = errorMessage(caught, '下载失败。');
      const kind = classifyZlibError(raw);
      if (kind === 'auth_expired') {
        setProfile(null);
        setConnectionState('expired');
        pendingActionRef.current = { kind: 'download', book };
        openLoginModal('登录会话已失效，请重新登录。');
      } else {
        if (kind === 'network') setConnectionState('offline');
        setDownloadError(explainZlibError(raw));
      }
    } finally {
      setDownloadingId(null);
    }
  };

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (loggingIn || !trimmedEmail || !password) return;
    setLoggingIn(true);
    setLoginError('');
    try {
      const nextProfile = await zlibApi.login(trimmedEmail, password);
      saveRememberedEmail(trimmedEmail);
      setProfile(nextProfile);
      setEnv((current) =>
        current
          ? {
              ...current,
              hasLogin: true,
              activeDomain:
                nextProfile.activeDomain ?? current.activeDomain ?? null,
            }
          : current,
      );
      setConnectionState('connected');
      setEnvironmentError('');
      setSearchError('');
      setDownloadError('');
      closeLogin();

      const pending = pendingActionRef.current;
      pendingActionRef.current = null;
      if (pending?.kind === 'download') {
        void downloadBook(pending.book, true);
      } else if (pending?.kind === 'search' || query.trim()) {
        void searchBooks(true);
      }
    } catch (caught) {
      setLoginError(
        explainZlibError(errorMessage(caught, '登录失败，请稍后重试。')),
      );
    } finally {
      setPassword('');
      setLoggingIn(false);
    }
  };

  const handleSwitchNode = async (targetDomain?: string) => {
    if (switchingNode || !env?.installed) return;
    setSwitchingNode(true);
    setEnvironmentError('');
    setSearchError('');
    setDownloadError('');
    try {
      const result = await zlibApi.switchDomain(targetDomain);
      setHealthyDomains(result.healthyDomains);
      setEnv((current) =>
        current ? { ...current, activeDomain: result.activeDomain } : current,
      );
      if (result.profile && result.profile.isLoggedIn) {
        setProfile(result.profile);
        setConnectionState('connected');
      } else if (result.warning) {
        const kind = classifyZlibError(result.warning);
        setProfile(null);
        setConnectionState(
          kind === 'auth_expired'
            ? 'expired'
            : env.hasLogin
              ? 'offline'
              : 'unauthenticated',
        );
        setEnvironmentError(explainZlibError(result.warning));
      }
    } catch (caught) {
      setEnvironmentError(
        explainZlibError(
          errorMessage(caught, '切换可用节点失败，请稍后重试。'),
        ),
      );
    } finally {
      setSwitchingNode(false);
    }
  };

  const quotaLabel = formatZlibQuota(profile);
  const domainLabel = formatDomainLabel(
    profile?.activeDomain ?? env?.activeDomain,
  );
  const statusLabel = (() => {
    switch (connectionState) {
      case 'checking':
        return '校验中';
      case 'missing':
        return '未安装';
      case 'unauthenticated':
        return '未登录';
      case 'connected':
        return quotaLabel ? `已连接 · ${quotaLabel}` : '已连接';
      case 'expired':
        return '登录已失效';
      case 'offline':
        return '节点不可达';
    }
  })();

  const statusClassName = [
    'zlib-side-status',
    connectionState === 'connected' ? 'is-connected' : '',
    connectionState === 'expired' || connectionState === 'offline'
      ? 'is-warning'
      : '',
    connectionState === 'checking' ? 'is-checking' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <aside className="zlib-side-panel" aria-label="在线找书">
        <header className="zlib-side-header">
          <div>
            <span className="zlib-side-kicker">ONLINE CATALOG</span>
            <h2>在线找书</h2>
          </div>
          <span className={statusClassName} title={domainLabel || undefined}>
            {statusLabel}
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

          {env?.installed && (
            <div className="zlib-side-account-bar">
              {healthyDomains.length > 1 ? (
                <select
                  className="zlib-node-select"
                  aria-label="切换书库节点"
                  value={env.activeDomain || healthyDomains[0]}
                  disabled={switchingNode}
                  onChange={(event) =>
                    void handleSwitchNode(event.target.value)
                  }
                >
                  {healthyDomains.map((domain) => (
                    <option key={domain} value={domain}>
                      {formatDomainLabel(domain)}
                    </option>
                  ))}
                </select>
              ) : (
                <span
                  className="zlib-node-label"
                  title={env.activeDomain || undefined}
                >
                  {domainLabel || '未选择节点'}
                  {profile?.name ? ` · ${profile.name}` : ''}
                </span>
              )}
              <div className="zlib-side-account-actions">
                <button
                  type="button"
                  className="zlib-side-mini-btn"
                  disabled={switchingNode}
                  onClick={() => void handleSwitchNode()}
                >
                  {switchingNode ? '检测中…' : '切换节点'}
                </button>
                <button
                  type="button"
                  className="zlib-side-mini-btn"
                  onClick={() => openLoginModal()}
                >
                  {env.hasLogin ? '重登/切号' : '登录'}
                </button>
              </div>
            </div>
          )}

          {env?.installed &&
            (!env.hasLogin || connectionState === 'expired') && (
              <button
                type="button"
                className={`zlib-side-login${connectionState === 'expired' ? ' is-urgent' : ''}`}
                onClick={() =>
                  openLoginModal(
                    connectionState === 'expired'
                      ? '登录会话已失效，请重新登录以恢复检索和下载。'
                      : undefined,
                  )
                }
              >
                {connectionState === 'expired'
                  ? '登录状态已失效，点击重新登录'
                  : '登录账号以检索和下载'}
              </button>
            )}

          {connectionState === 'offline' && env?.hasLogin && (
            <div className="zlib-side-offline-hint">
              <span>本机会话已保留，当前节点暂时不可达。</span>
              <button
                type="button"
                className="zlib-side-mini-btn"
                disabled={switchingNode}
                onClick={() => void refreshConnection()}
              >
                重连验证
              </button>
            </div>
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
            <p className="zlib-side-error zlib-side-results-error" role="alert">
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
              {results.map((book, index) => {
                const idHash = normalizeBookIdHash(book.id, book.hash);
                const cardKey = buildZlibBookKey(book, index);
                const document = downloadedBooks.get(idHash);
                const coverVisible =
                  Boolean(book.cover) && !failedCovers.has(cardKey);
                const isEpub =
                  !book.extension || book.extension.toLowerCase() === 'epub';
                return (
                  <article className="zlib-book-card" key={cardKey}>
                    <div className="zlib-book-cover-wrap">
                      {coverVisible && book.cover ? (
                        <img
                          className="zlib-book-cover"
                          src={book.cover}
                          alt=""
                          loading="lazy"
                          onError={() =>
                            setFailedCovers((current) => {
                              const next = new Set(current);
                              next.add(cardKey);
                              return next;
                            })
                          }
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
                        {[
                          book.year,
                          book.extension?.toUpperCase(),
                          book.language,
                          book.filesize,
                        ]
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
                              : isEpub
                                ? '下载到书架'
                                : '下载到目录'}
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
                后仍可使用；密码不会写入文件或命令行。登录时将自动优先选用健康节点。
              </p>
              <label>
                邮箱
                <input
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoFocus={!email}
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
                  autoFocus={Boolean(email)}
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
                  {loggingIn ? '正在登录并校验…' : '登录并校验'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLoginError('');
                    void refreshConnection().then((next) => {
                      if (!next?.hasLogin) {
                        setLoginError('本机尚未检测到有效登录会话。');
                        return;
                      }
                      void zlibApi
                        .getProfile()
                        .then((verified) => {
                          if (verified.isLoggedIn) {
                            closeLogin();
                          } else {
                            setLoginError(
                              '本机会话已失效，请重新输入密码登录。',
                            );
                          }
                        })
                        .catch((caught) =>
                          setLoginError(
                            explainZlibError(
                              errorMessage(caught, '校验本机会话失败。'),
                            ),
                          ),
                        );
                    });
                  }}
                >
                  已在终端登录？校验会话
                </button>
                {env?.hasLogin && (
                  <button
                    type="button"
                    onClick={() => {
                      setLoginError('');
                      void zlibApi
                        .logout()
                        .then(() => {
                          setProfile(null);
                          setConnectionState('unauthenticated');
                          setEnv((current) =>
                            current ? { ...current, hasLogin: false } : current,
                          );
                        })
                        .catch(() => setLoginError('清除本机会话失败。'));
                    }}
                  >
                    清除旧会话
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
