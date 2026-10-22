import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { EpubBookDocument, LibrarySnapshot } from './library';
import {
  clearEpubReaderData,
  deleteEpubReadingPlan,
  epubProgressKey,
  loadEpubBookMetadata,
  loadEpubReadingActivity,
  loadEpubReadingPlan,
  saveEpubReadingPlan,
} from './ebook-storage';
import type { EpubReadingPlan } from './ebook-storage';
import EbookReadingDashboard from './EbookReadingDashboard';
import type { EbookDashboardBook } from './EbookReadingDashboard';
import EbookReadingHeatmap from './EbookReadingHeatmap';

type ShelfSort = 'recent' | 'title' | 'added';

export default function EbookWorkspace({
  snapshot,
  busy,
  onImport,
  onRefresh,
  onChooseRoot,
  onOpenBook,
  onDeleteBook,
}: {
  snapshot: LibrarySnapshot | null;
  busy: boolean;
  onImport: () => void;
  onRefresh: () => void;
  onChooseRoot: () => void;
  onOpenBook: (book: EpubBookDocument) => void;
  onDeleteBook: (book: EpubBookDocument) => Promise<void>;
}) {
  const books = snapshot?.books ?? [];
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<ShelfSort>('recent');
  const [deleteTarget, setDeleteTarget] = useState<EpubBookDocument | null>(
    null,
  );
  const [deleteError, setDeleteError] = useState('');
  const [deletingPath, setDeletingPath] = useState('');
  const [openMenuPath, setOpenMenuPath] = useState('');
  const [planTarget, setPlanTarget] = useState<EpubBookDocument | null>(null);
  const [planTargetTitle, setPlanTargetTitle] = useState('');
  const [planChapters, setPlanChapters] = useState('5');
  const [planDueDate, setPlanDueDate] = useState(defaultPlanDate);
  const [planError, setPlanError] = useState('');
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [dashboardCollapsed, setDashboardCollapsed] = useState(false);
  const [dashboardRevision, setDashboardRevision] = useState(0);

  useEffect(() => {
    if (!openMenuPath) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.ebook-book-actions')) {
        return;
      }
      setOpenMenuPath('');
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenuPath('');
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenuPath]);

  const dashboardBooks = useMemo<EbookDashboardBook[]>(
    () =>
      books.map((book) => {
        const progressKey = epubProgressKey(book);
        const metadata = loadEpubBookMetadata(progressKey);
        return {
          progressKey,
          title: metadata?.title || book.title,
          metadata,
          activity: loadEpubReadingActivity(progressKey),
          plan: loadEpubReadingPlan(progressKey),
        };
      }),
    [books, dashboardRevision],
  );

  const visibleBooks = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    const rows = books
      .map((book) => ({
        book,
        metadata: loadEpubBookMetadata(epubProgressKey(book)),
      }))
      .filter(({ book, metadata }) => {
        if (!search) return true;
        return [
          book.title,
          metadata?.title,
          metadata?.author,
          book.relativePath,
          book.category,
        ]
          .filter(Boolean)
          .some((value) => value!.toLocaleLowerCase().includes(search));
      });

    if (sortBy === 'title') {
      return rows.sort((a, b) =>
        (a.metadata?.title || a.book.title).localeCompare(
          b.metadata?.title || b.book.title,
          'zh-CN',
        ),
      );
    }
    if (sortBy === 'added') {
      return rows.sort((a, b) => b.book.updatedAt - a.book.updatedAt);
    }
    return rows.sort(
      (a, b) =>
        (b.metadata?.lastReadAt ?? 0) - (a.metadata?.lastReadAt ?? 0) ||
        b.book.updatedAt - a.book.updatedAt,
    );
  }, [books, query, sortBy]);

  const confirmDelete = async () => {
    if (!deleteTarget || deletingPath) return;
    setDeletingPath(deleteTarget.relativePath);
    setDeleteError('');
    try {
      await onDeleteBook(deleteTarget);
      clearEpubReaderData(epubProgressKey(deleteTarget));
      setDeleteTarget(null);
      setDashboardRevision((value) => value + 1);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingPath('');
    }
  };

  const openReadingPlan = (book: EpubBookDocument, title: string) => {
    const progressKey = epubProgressKey(book);
    const plan = loadEpubReadingPlan(progressKey);
    setOpenMenuPath('');
    setPlanTarget(book);
    setPlanTargetTitle(title);
    setPlanChapters(String(plan?.targetChapters ?? 5));
    setPlanDueDate(plan?.dueDate ?? defaultPlanDate());
    setPlanError('');
  };

  const saveReadingPlan = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!planTarget) return;
    const targetChapters = Math.floor(Number(planChapters));
    if (
      !Number.isFinite(targetChapters) ||
      targetChapters < 1 ||
      !planDueDate
    ) {
      return;
    }
    const progressKey = epubProgressKey(planTarget);
    const existing: EpubReadingPlan | null = loadEpubReadingPlan(progressKey);
    const metadata = loadEpubBookMetadata(progressKey);
    const startPending =
      existing?.startPending ??
      (metadata?.currentChapterIndex === undefined &&
        (metadata?.progress ?? 0) > 0);
    const startChapterIndex =
      existing?.startChapterIndex ??
      (startPending ? 0 : (metadata?.currentChapterIndex ?? 0));
    const now = Date.now();
    const saved = saveEpubReadingPlan(progressKey, {
      targetChapters,
      dueDate: planDueDate,
      startPending,
      startChapterIndex,
      startChapterHref:
        existing?.startChapterHref ?? metadata?.currentChapterHref ?? '',
      startChapterLabel:
        existing?.startChapterLabel ??
        (startPending
          ? '当前章节'
          : (metadata?.currentChapterLabel ?? '第 1 章')),
      furthestChapterIndex: existing?.furthestChapterIndex ?? startChapterIndex,
      chapterCount: existing?.chapterCount ?? metadata?.chapterCount ?? 0,
      reachedBookEnd: existing?.reachedBookEnd ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    if (!saved) {
      setPlanError('本地存储不可用，计划未能保存。');
      return;
    }
    setPlanTarget(null);
    setPlanError('');
    setDashboardRevision((value) => value + 1);
  };

  const cancelReadingPlan = (progressKey: string) => {
    deleteEpubReadingPlan(progressKey);
    setDashboardRevision((value) => value + 1);
  };

  const planEditorKey = planTarget ? epubProgressKey(planTarget) : '';
  const planEditorStoredPlan = planTarget
    ? loadEpubReadingPlan(planEditorKey)
    : null;
  const planEditorMetadata = planTarget
    ? loadEpubBookMetadata(planEditorKey)
    : null;
  const planStartPending =
    planEditorStoredPlan?.startPending ??
    (planTarget &&
      planEditorMetadata?.currentChapterIndex === undefined &&
      (planEditorMetadata?.progress ?? 0) > 0);

  return (
    <main
      className={`ebook-shelf${dashboardCollapsed ? ' is-dashboard-collapsed' : ''}`}
      aria-label="电子书书架"
    >
      <EbookReadingDashboard
        books={dashboardBooks}
        open={dashboardOpen}
        collapsed={dashboardCollapsed}
        onClose={() => setDashboardOpen(false)}
        onToggleCollapsed={() =>
          setDashboardCollapsed((collapsed) => !collapsed)
        }
        onCancelPlan={cancelReadingPlan}
      />
      <div className="ebook-shelf-content">
        <header className="ebook-shelf-header">
          <div>
            <span className="ebook-shelf-kicker">
              LOCAL LIBRARY · BOOKSHELF
            </span>
            <h1>电子书</h1>
            <p>
              {books.length
                ? `书架中有 ${books.length} 本 EPUB，阅读位置和书签会自动保存。`
                : '导入 EPUB 后会保存在当前文件库，下次打开仍可继续阅读。'}
            </p>
          </div>
          <div className="ebook-shelf-actions">
            <button
              type="button"
              className="ebook-dashboard-toggle"
              aria-expanded={dashboardOpen}
              onClick={() => setDashboardOpen((open) => !open)}
            >
              {dashboardOpen ? '收起看板' : '阅读看板'}
            </button>
            <button type="button" onClick={onRefresh} disabled={busy}>
              刷新书架
            </button>
            <button
              type="button"
              className="ebook-shelf-import"
              onClick={onImport}
              disabled={busy || !snapshot?.rootPath}
              title={
                snapshot?.rootPath
                  ? '导入 EPUB 并保存到文件库'
                  : '请先选择文件库位置'
              }
            >
              {busy ? '正在导入…' : '导入 EPUB'}
            </button>
          </div>
        </header>

        {!snapshot?.rootPath ? (
          <section className="ebook-shelf-empty">
            <div className="ebook-shelf-empty-icon" aria-hidden="true">
              ▤
            </div>
            <h2>先选择书架存储位置</h2>
            <p>电子书会复制到该文件库的 books 文件夹中。</p>
            <button type="button" onClick={onChooseRoot}>
              选择文件库位置
            </button>
          </section>
        ) : books.length ? (
          <>
            <div className="ebook-shelf-toolbar">
              <label className="ebook-shelf-search">
                <span aria-hidden="true">⌕</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索书名、作者或文件夹"
                  aria-label="搜索电子书"
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
              <label className="ebook-shelf-sort">
                <span>排序</span>
                <select
                  value={sortBy}
                  onChange={(event) =>
                    setSortBy(event.target.value as ShelfSort)
                  }
                >
                  <option value="recent">最近阅读</option>
                  <option value="added">最近加入</option>
                  <option value="title">书名</option>
                </select>
              </label>
            </div>

            <EbookReadingHeatmap books={dashboardBooks} />

            {visibleBooks.length ? (
              <section className="ebook-shelf-grid" aria-label="已导入的电子书">
                {visibleBooks.map(({ book, metadata }, index) => {
                  const title = metadata?.title || book.title;
                  const progress = metadata?.progress ?? 0;
                  const progressKey = epubProgressKey(book);
                  const plan = loadEpubReadingPlan(progressKey);
                  return (
                    <article
                      className="ebook-book-card"
                      key={book.relativePath}
                    >
                      <button
                        type="button"
                        className="ebook-book-open"
                        onClick={() => onOpenBook(book)}
                        title={`继续阅读 ${title}`}
                      >
                        <span
                          className={`ebook-book-cover cover-${index % 6}`}
                          aria-hidden="true"
                        >
                          {metadata?.coverDataUrl ? (
                            <img src={metadata.coverDataUrl} alt="" />
                          ) : (
                            <>
                              <span className="ebook-book-cover-mark">S</span>
                              <span className="ebook-book-cover-rule" />
                              <strong>{title}</strong>
                              <small>EPUB · SEAMIND</small>
                            </>
                          )}
                        </span>
                        <span className="ebook-book-title">{title}</span>
                        <span className="ebook-book-meta">
                          {metadata?.author ||
                            book.category ||
                            formatBookSize(book.fileSize)}
                        </span>
                        <span
                          className="ebook-book-progress"
                          aria-label={`阅读进度 ${Math.round(progress * 100)}%`}
                        >
                          <i
                            style={{ width: `${Math.round(progress * 100)}%` }}
                          />
                        </span>
                        <span className="ebook-book-date">
                          {metadata?.lastReadAt
                            ? `读至 ${Math.round(progress * 100)}%`
                            : `${formatBookSize(book.fileSize)} · ${formatBookDate(book.updatedAt)}`}
                        </span>
                      </button>
                      <div className="ebook-book-actions">
                        <button
                          type="button"
                          className="ebook-book-menu-trigger"
                          aria-label={`${title}的更多操作`}
                          aria-haspopup="menu"
                          aria-expanded={openMenuPath === book.relativePath}
                          title="更多操作"
                          onClick={() =>
                            setOpenMenuPath((path) =>
                              path === book.relativePath
                                ? ''
                                : book.relativePath,
                            )
                          }
                        >
                          ···
                        </button>
                        {openMenuPath === book.relativePath && (
                          <div className="ebook-book-menu" role="menu">
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => openReadingPlan(book, title)}
                            >
                              {plan ? '编辑阅读计划' : '阅读计划'}
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="is-danger"
                              onClick={() => {
                                setOpenMenuPath('');
                                setDeleteError('');
                                setDeleteTarget(book);
                              }}
                            >
                              删除电子书
                            </button>
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}
              </section>
            ) : (
              <section className="ebook-shelf-empty ebook-shelf-no-results">
                <h2>没有找到匹配的电子书</h2>
                <p>试试书名、作者或文件夹名称。</p>
                <button type="button" onClick={() => setQuery('')}>
                  清除搜索
                </button>
              </section>
            )}
          </>
        ) : (
          <section className="ebook-shelf-empty">
            <div className="ebook-shelf-empty-icon" aria-hidden="true">
              ＋
            </div>
            <h2>书架还是空的</h2>
            <p>选择 EPUB 文件后会复制到当前文件库，并显示在这里。</p>
            <button type="button" onClick={onImport} disabled={busy}>
              导入第一本电子书
            </button>
          </section>
        )}

        {deleteTarget && (
          <div
            className="ebook-delete-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !deletingPath) {
                setDeleteTarget(null);
              }
            }}
          >
            <section
              className="ebook-delete-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="ebook-delete-title"
            >
              <h2 id="ebook-delete-title">删除这本电子书？</h2>
              <p>
                “{deleteTarget.title}
                ”会从当前文件库中移除，阅读位置、书签、标注、热力图记录和阅读计划也会清除。
              </p>
              {deleteError && (
                <p className="ebook-delete-error" role="alert">
                  {deleteError}
                </p>
              )}
              <div>
                <button
                  type="button"
                  onClick={() => setDeleteTarget(null)}
                  disabled={Boolean(deletingPath)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="is-danger"
                  onClick={() => void confirmDelete()}
                  disabled={Boolean(deletingPath)}
                >
                  {deletingPath ? '正在删除…' : '确认删除'}
                </button>
              </div>
            </section>
          </div>
        )}
      </div>

      {planTarget && (
        <div
          className="ebook-plan-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPlanTarget(null);
          }}
        >
          <form
            className="ebook-plan-dialog"
            aria-labelledby="ebook-plan-title"
            onSubmit={saveReadingPlan}
          >
            <header>
              <div>
                <span className="ebook-plan-kicker">READING PLAN</span>
                <h2 id="ebook-plan-title">
                  {planEditorStoredPlan ? '编辑阅读计划' : '制定阅读计划'}
                </h2>
              </div>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setPlanTarget(null)}
              >
                ×
              </button>
            </header>
            <p className="ebook-plan-book-title" title={planTargetTitle}>
              {planTargetTitle}
            </p>
            <label>
              <span>目标章节</span>
              <div className="ebook-plan-number-field">
                <input
                  type="number"
                  min="1"
                  step="1"
                  required
                  value={planChapters}
                  onChange={(event) => setPlanChapters(event.target.value)}
                />
                <small>章</small>
              </div>
            </label>
            <label>
              <span>完成日期</span>
              <input
                type="date"
                required
                min={localDateKey(new Date())}
                value={planDueDate}
                onChange={(event) => setPlanDueDate(event.target.value)}
              />
            </label>
            <p className="ebook-plan-hint">
              {planStartPending
                ? '打开这本书后会从当前阅读位置校准计划起点。'
                : `从${
                    planEditorStoredPlan?.startChapterLabel ||
                    planEditorMetadata?.currentChapterLabel ||
                    '第 1 章'
                  }开始计算，阅读进度会自动更新。`}
            </p>
            {planError && (
              <p className="ebook-plan-error" role="alert">
                {planError}
              </p>
            )}
            <footer>
              <button type="button" onClick={() => setPlanTarget(null)}>
                取消
              </button>
              <button
                type="submit"
                className="is-primary"
                disabled={
                  !planChapters || Number(planChapters) < 1 || !planDueDate
                }
              >
                保存计划
              </button>
            </footer>
          </form>
        </div>
      )}
    </main>
  );
}

function defaultPlanDate() {
  const date = new Date();
  date.setDate(date.getDate() + 14);
  return localDateKey(date);
}

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatBookSize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatBookDate(timestamp: number) {
  if (!timestamp) return '已加入书架';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp * 1000));
}
