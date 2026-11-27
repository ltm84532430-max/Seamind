import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  EpubBookDocument,
  LibrarySnapshot,
  PdfBookDocument,
} from '../library/library';
import { getPdfBookSummary } from './pdf-book-store';
import PdfBookCover from './PdfBookCover';
import type { EpubExamSummary } from '../exams/epub-exams';
import { listEpubExams } from '../exams/epub-exams';
import {
  clearEpubReaderData,
  deleteEpubReadingPlan,
  EBOOK_READING_ACTIVITY_EVENT,
  epubProgressKey,
  loadEpubBookMetadata,
  loadEpubReadingActivity,
  loadEpubReadingPlan,
  saveEpubBookMetadata,
  saveEpubReadingPlan,
} from './ebook-storage';
import type { EpubReadingPlan } from './ebook-storage';
import { formatReadingDurationCompact } from './ebook-reading-analytics';
import {
  buildShelfGridCssVars,
  loadShelfColumns,
  MAX_SHELF_COLUMNS,
  MIN_SHELF_COLUMNS,
  saveShelfColumns,
} from './ebook-shelf-density';
import EbookReadingDashboard from './EbookReadingDashboard';
import type { EbookDashboardBook } from './EbookReadingDashboard';
import EbookReadingHeatmap from './EbookReadingHeatmap';
import ZlibSearchDialog from './ZlibSearchDialog';

type ShelfSort = 'recent' | 'title' | 'added';
type EbookPage = 'shelf' | 'online' | 'heatmap';

const NEW_BOOK_CATEGORY = '__new_book_category__';

export default function EbookWorkspace({
  active,
  snapshot,
  busy,
  onImport,
  bookImportResetPending,
  onBookImportShown,
  onRefresh,
  onChooseRoot,
  onOpenBook,
  onOpenPdfBook,
  onCreateTask,
  onDeleteBook,
  onDeletePdfBook,
  onOpenExams,
}: {
  active: boolean;
  snapshot: LibrarySnapshot | null;
  busy: boolean;
  onImport: () => void;
  bookImportResetPending: boolean;
  onBookImportShown: () => void;
  onRefresh: () => void;
  onChooseRoot: () => void;
  onOpenBook: (book: EpubBookDocument) => void;
  onOpenPdfBook: (book: PdfBookDocument) => void;
  onCreateTask: (book: EpubBookDocument) => void;
  onDeleteBook: (book: EpubBookDocument) => Promise<void>;
  onDeletePdfBook: (book: PdfBookDocument) => Promise<void>;
  onOpenExams: (bookKey: string) => void;
}) {
  const books = snapshot?.books ?? [];
  const pdfBooks = snapshot?.pdfBooks ?? [];
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<EbookPage>('shelf');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [categoryError, setCategoryError] = useState('');
  const [categoryTarget, setCategoryTarget] = useState<EpubBookDocument | null>(
    null,
  );
  const [newCategoryName, setNewCategoryName] = useState('');
  const [sortBy, setSortBy] = useState<ShelfSort>('recent');
  const [shelfColumns, setShelfColumns] = useState<number>(() =>
    loadShelfColumns(),
  );
  const updateShelfColumns = (cols: number) => {
    const saved = saveShelfColumns(cols);
    setShelfColumns(saved);
  };
  const shelfGridStyle = useMemo(
    () => buildShelfGridCssVars(shelfColumns),
    [shelfColumns],
  );
  const [deleteTarget, setDeleteTarget] = useState<EpubBookDocument | null>(
    null,
  );
  const [pdfDeleteTarget, setPdfDeleteTarget] =
    useState<PdfBookDocument | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [deletingPath, setDeletingPath] = useState('');
  const [openMenuPath, setOpenMenuPath] = useState('');
  const [planTarget, setPlanTarget] = useState<EpubBookDocument | null>(null);
  const [planTargetTitle, setPlanTargetTitle] = useState('');
  const [planChapters, setPlanChapters] = useState('5');
  const [planDueDate, setPlanDueDate] = useState(defaultPlanDate);
  const [planError, setPlanError] = useState('');
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [dashboardCollapsed, setDashboardCollapsed] = useState(() => {
    try {
      return (
        localStorage.getItem('seamind_ebook_dashboard_collapsed') === 'true'
      );
    } catch {
      return false;
    }
  });
  const [dashboardRevision, setDashboardRevision] = useState(0);
  const [exams, setExams] = useState<EpubExamSummary[]>([]);

  useEffect(() => {
    if (!bookImportResetPending) return;
    setQuery('');
    setCategoryFilter('all');
    setSortBy('added');
    onBookImportShown();
  }, [bookImportResetPending, onBookImportShown]);

  useEffect(() => {
    let active = true;
    void listEpubExams()
      .then((items) => {
        if (active) setExams(items);
      })
      .catch(() => {
        if (active) setExams([]);
      });
    return () => {
      active = false;
    };
  }, [snapshot?.books, active]);

  useEffect(() => {
    const syncActivity = () => {
      setDashboardRevision((value) => value + 1);
    };
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key.includes('epub-reading-activity')) {
        syncActivity();
      }
    };
    window.addEventListener(EBOOK_READING_ACTIVITY_EVENT, syncActivity);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EBOOK_READING_ACTIVITY_EVENT, syncActivity);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

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

  const bookCategories = useMemo(() => {
    const assigned = books
      .map(
        (book) => loadEpubBookMetadata(epubProgressKey(book))?.manualCategory,
      )
      .filter((category): category is string => Boolean(category));
    return [...new Set(assigned)];
  }, [books, dashboardRevision]);

  const visibleBooks = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    const rows = books
      .map((book) => {
        const metadata = loadEpubBookMetadata(epubProgressKey(book));
        return {
          book,
          metadata,
          manualCategory: metadata?.manualCategory ?? '',
        };
      })
      .filter(({ book, metadata, manualCategory }) => {
        if (categoryFilter === '__uncategorized__' && manualCategory) {
          return false;
        }
        if (
          categoryFilter.startsWith('category:') &&
          manualCategory !== categoryFilter.slice('category:'.length)
        ) {
          return false;
        }
        if (!search) return true;
        return [
          book.title,
          metadata?.title,
          metadata?.author,
          book.relativePath,
          book.category,
          manualCategory,
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
  }, [books, categoryFilter, dashboardRevision, query, sortBy]);

  const visiblePdfBooks = useMemo(() => {
    if (categoryFilter !== 'all' && categoryFilter !== '__uncategorized__')
      return [];
    const search = query.trim().toLocaleLowerCase();
    const rows = pdfBooks.filter(
      (book) =>
        !search ||
        [book.title, book.relativePath, book.category].some((value) =>
          value.toLocaleLowerCase().includes(search),
        ),
    );
    if (sortBy === 'title')
      return rows.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    if (sortBy === 'recent') {
      return rows.sort(
        (a, b) =>
          (getPdfBookSummary(snapshot?.rootPath ?? '', b.relativePath)
            ?.updatedAt ?? b.updatedAt) -
          (getPdfBookSummary(snapshot?.rootPath ?? '', a.relativePath)
            ?.updatedAt ?? a.updatedAt),
      );
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [
    pdfBooks,
    snapshot?.rootPath,
    categoryFilter,
    query,
    sortBy,
    dashboardRevision,
  ]);

  const categoryGroups = useMemo(() => {
    const groups = new Map<string, typeof visibleBooks>();
    for (const row of visibleBooks) {
      if (!row.manualCategory) continue;
      const group = groups.get(row.manualCategory) ?? [];
      group.push(row);
      groups.set(row.manualCategory, group);
    }
    return [...groups].map(([category, groupedBooks]) => ({
      category,
      books: groupedBooks,
    }));
  }, [visibleBooks]);

  const ungroupedBooks =
    categoryFilter === 'all'
      ? visibleBooks.filter((row) => !row.manualCategory)
      : visibleBooks;

  const persistBookCategory = (book: EpubBookDocument, category: string) => {
    setCategoryError('');
    const progressKey = epubProgressKey(book);
    saveEpubBookMetadata(progressKey, { manualCategory: category });
    const savedCategory =
      loadEpubBookMetadata(progressKey)?.manualCategory ?? '';
    if (savedCategory !== category) {
      setCategoryError('分类没有保存成功，请检查本地存储空间后重试。');
      return false;
    }
    setDashboardRevision((revision) => revision + 1);
    return true;
  };

  const assignBookCategory = (book: EpubBookDocument, value: string) => {
    if (value === NEW_BOOK_CATEGORY) {
      setCategoryError('');
      setCategoryTarget(book);
      setNewCategoryName('');
      return;
    }
    persistBookCategory(book, value);
  };

  const saveNewBookCategory = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!categoryTarget) return;
    const category = newCategoryName.trim();
    if (!category || category.length > 24) {
      setCategoryError('分类名称不能为空，且最多 24 个字符。');
      return;
    }
    if (persistBookCategory(categoryTarget, category)) {
      setCategoryTarget(null);
      setNewCategoryName('');
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deletingPath) return;
    setDeletingPath(deleteTarget.relativePath);
    setDeleteError('');
    try {
      await onDeleteBook(deleteTarget);
      clearEpubReaderData(epubProgressKey(deleteTarget));
      setExams((current) =>
        current.filter((exam) => exam.bookKey !== deleteTarget.relativePath),
      );
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

  const examCounts = new Map<string, number>();
  for (const exam of exams) {
    examCounts.set(exam.bookKey, (examCounts.get(exam.bookKey) ?? 0) + 1);
  }
  const linkedExamCount = deleteTarget
    ? (examCounts.get(deleteTarget.relativePath) ?? 0)
    : 0;

  return (
    <main
      className={`ebook-shelf${dashboardCollapsed ? ' is-dashboard-collapsed' : ''}`}
      data-ebook-page={page}
      aria-label="电子书书架"
    >
      <nav className="ebook-page-tabs" aria-label="电子书页面" role="tablist">
        {(
          [
            ['shelf', '我的书架'],
            ['online', '在线找书'],
            ['heatmap', '阅读热力'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`ebook-tab-${value}`}
            aria-controls={`ebook-panel-${value}`}
            aria-selected={page === value}
            tabIndex={page === value ? 0 : -1}
            className={page === value ? 'is-active' : ''}
            onClick={() => setPage(value)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
                return;
              event.preventDefault();
              const pages: EbookPage[] = ['shelf', 'online', 'heatmap'];
              const offset = event.key === 'ArrowRight' ? 1 : -1;
              const next =
                pages[
                  (pages.indexOf(value) + offset + pages.length) % pages.length
                ];
              setPage(next);
              document.getElementById(`ebook-tab-${next}`)?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="ebook-dashboard-pane" hidden={page !== 'shelf'}>
        <EbookReadingDashboard
          books={dashboardBooks}
          open={dashboardOpen}
          collapsed={dashboardCollapsed}
          onClose={() => setDashboardOpen(false)}
          onToggleCollapsed={() =>
            setDashboardCollapsed((collapsed) => {
              const next = !collapsed;
              try {
                localStorage.setItem(
                  'seamind_ebook_dashboard_collapsed',
                  String(next),
                );
              } catch {
                // ignore
              }
              return next;
            })
          }
          onCancelPlan={cancelReadingPlan}
          rootPath={snapshot?.rootPath ?? ''}
          libraryBooks={books}
          onOpenBook={onOpenBook}
        />
      </div>
      <div
        className="ebook-shelf-content"
        id="ebook-panel-shelf"
        role="tabpanel"
        aria-labelledby="ebook-tab-shelf"
        hidden={page !== 'shelf'}
      >
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
        ) : books.length || pdfBooks.length ? (
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
              <div className="ebook-shelf-toolbar-controls">
                <button
                  type="button"
                  className="ebook-shelf-refresh-button"
                  onClick={onImport}
                  disabled={busy}
                >
                  添加电子书
                </button>
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
                <label className="ebook-shelf-category-filter">
                  <span>分类</span>
                  <select
                    value={categoryFilter}
                    onChange={(event) => setCategoryFilter(event.target.value)}
                    aria-label="按书籍分类筛选"
                  >
                    <option value="all">全部分类</option>
                    <option value="__uncategorized__">未分类</option>
                    {bookCategories.map((category) => (
                      <option key={category} value={`category:${category}`}>
                        {category}
                      </option>
                    ))}
                  </select>
                </label>
                <label
                  className="ebook-shelf-density-slider"
                  title={`调节每行显示电子书数量（当前每行 ${shelfColumns} 格，可滑至 ${MIN_SHELF_COLUMNS}–${MAX_SHELF_COLUMNS} 格）`}
                >
                  <span className="ebook-shelf-density-label">排版</span>
                  <input
                    type="range"
                    className="ebook-shelf-density-range"
                    min={MIN_SHELF_COLUMNS}
                    max={MAX_SHELF_COLUMNS}
                    step={1}
                    value={shelfColumns}
                    aria-label="书架每行电子书数量"
                    onChange={(event) =>
                      updateShelfColumns(Number(event.target.value))
                    }
                  />
                  <span className="ebook-shelf-density-readout">
                    {shelfColumns}格
                  </span>
                </label>
                <button
                  type="button"
                  className="ebook-shelf-refresh-button"
                  onClick={onRefresh}
                  disabled={busy}
                  title="刷新书架"
                >
                  刷新书架
                </button>
              </div>
            </div>

            {categoryError && !categoryTarget && (
              <p className="ebook-category-error" role="alert">
                {categoryError}
              </p>
            )}

            {categoryFilter.startsWith('category:') && (
              <header className="ebook-category-content-heading">
                <button type="button" onClick={() => setCategoryFilter('all')}>
                  ← 返回书架
                </button>
                <div>
                  <h2>{categoryFilter.slice('category:'.length)}</h2>
                  <span>{visibleBooks.length} 本书</span>
                </div>
              </header>
            )}

            {visibleBooks.length || visiblePdfBooks.length ? (
              <section
                className="ebook-shelf-grid"
                data-shelf-columns={shelfColumns}
                style={shelfGridStyle}
                aria-label="已导入的电子书"
              >
                {categoryFilter === 'all' &&
                  categoryGroups.map(({ category, books: groupedBooks }) => {
                    const previewBooks = groupedBooks.slice(0, 4);
                    const isSingleBook = previewBooks.length === 1;
                    const emptySlotsCount = isSingleBook
                      ? 0
                      : Math.max(0, 4 - previewBooks.length);
                    let categorySeconds = 0;
                    for (const row of groupedBooks) {
                      const act = loadEpubReadingActivity(
                        epubProgressKey(row.book),
                      );
                      for (const sec of Object.values(
                        act?.dailySeconds ?? {},
                      )) {
                        categorySeconds += sec;
                      }
                    }
                    return (
                      <button
                        type="button"
                        className="ebook-category-folder"
                        key={`category:${category}`}
                        aria-label={`打开分类 ${category}，共 ${groupedBooks.length} 本书`}
                        title={`打开分类 ${category}`}
                        onClick={() =>
                          setCategoryFilter(`category:${category}`)
                        }
                      >
                        <span
                          className={`ebook-category-folder-preview ${isSingleBook ? 'has-1' : 'has-grid'}`}
                          aria-hidden="true"
                        >
                          {previewBooks.map(
                            ({ book, metadata }, previewIndex) => (
                              <span
                                className="ebook-category-folder-cover"
                                key={`${book.relativePath}:${previewIndex}`}
                              >
                                {metadata?.coverDataUrl ? (
                                  <img src={metadata.coverDataUrl} alt="" />
                                ) : (
                                  <span className={`cover-${previewIndex % 6}`}>
                                    {(metadata?.title || book.title).slice(
                                      0,
                                      1,
                                    )}
                                  </span>
                                )}
                                {previewIndex === 3 &&
                                  groupedBooks.length > 4 && (
                                    <em>+{groupedBooks.length - 3}</em>
                                  )}
                              </span>
                            ),
                          )}
                          {Array.from(
                            { length: emptySlotsCount },
                            (_, slotIdx) => (
                              <span
                                key={`slot-${slotIdx}`}
                                className="ebook-category-folder-slot is-empty"
                              />
                            ),
                          )}
                        </span>
                        <strong>{category}</strong>
                        <span className="ebook-category-folder-count">
                          {groupedBooks.length} 本书
                          {categorySeconds > 0
                            ? ` · ${formatReadingDurationCompact(categorySeconds)}`
                            : ''}
                        </span>
                        <span className="ebook-category-folder-action">
                          打开分类 <span aria-hidden="true">→</span>
                        </span>
                      </button>
                    );
                  })}
                {ungroupedBooks.map(({ book, metadata }, index) => {
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
                              <span className="ebook-book-cover-rule" />
                              <strong>{title}</strong>
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
                      <div className="ebook-book-card-footer">
                        <button
                          type="button"
                          className={`ebook-book-exam-count${examCounts.has(book.relativePath) ? ' has-exams' : ''}`}
                          onClick={() => onOpenExams(book.relativePath)}
                          aria-label={`查看《${title}》的 ${examCounts.get(book.relativePath) ?? 0} 份试卷`}
                        >
                          试卷 {examCounts.get(book.relativePath) ?? 0}
                        </button>
                        <div className="ebook-book-category-control">
                          <select
                            value={metadata?.manualCategory ?? ''}
                            aria-label={`为《${title}》设置分类`}
                            title={metadata?.manualCategory || '设置书籍分类'}
                            onChange={(event) =>
                              assignBookCategory(book, event.target.value)
                            }
                          >
                            <option value="">设置分类</option>
                            {bookCategories.map((category) => (
                              <option key={category} value={category}>
                                {category}
                              </option>
                            ))}
                            <option value={NEW_BOOK_CATEGORY}>
                              ＋ 新建分类
                            </option>
                          </select>
                        </div>
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
                                onClick={() => {
                                  setOpenMenuPath('');
                                  onCreateTask(book);
                                }}
                              >
                                添加到任务
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
                      </div>
                    </article>
                  );
                })}
                {visiblePdfBooks.map((book, index) => {
                  const progress = getPdfBookSummary(
                    snapshot.rootPath!,
                    book.relativePath,
                  );
                  return (
                    <article
                      className="ebook-book-card ebook-pdf-book-card"
                      key={`pdf:${book.relativePath}`}
                    >
                      <button
                        type="button"
                        className="ebook-book-open"
                        onClick={() => onOpenPdfBook(book)}
                        title={`阅读 PDF：${book.title}`}
                      >
                        <PdfBookCover
                          rootPath={snapshot.rootPath!}
                          book={book}
                          colorIndex={index}
                        />
                        <span className="ebook-book-title">{book.title}</span>
                        <span className="ebook-book-meta">
                          PDF · {book.category || formatBookSize(book.fileSize)}
                        </span>
                        <span
                          className="ebook-book-progress is-empty"
                          aria-hidden="true"
                        />
                        <span className="ebook-book-date">
                          {progress
                            ? `读至第 ${progress.pageNumber} 页`
                            : `${formatBookSize(book.fileSize)} · ${formatBookDate(book.updatedAt)}`}
                        </span>
                      </button>
                      <div className="ebook-book-card-footer ebook-pdf-book-footer">
                        <span>PDF 阅读</span>
                        <button
                          type="button"
                          className="ebook-pdf-delete"
                          onClick={() => {
                            setPdfDeleteTarget(book);
                            setDeleteError('');
                          }}
                          aria-label={`删除 PDF《${book.title}》`}
                        >
                          删除
                        </button>
                      </div>
                    </article>
                  );
                })}
                <button
                  type="button"
                  className="ebook-book-card ebook-book-add-card"
                  onClick={onImport}
                  disabled={busy || !snapshot?.rootPath}
                  title={
                    snapshot?.rootPath
                      ? '选择或拖入 EPUB、PDF 文件到书架'
                      : '请先选择文件库位置'
                  }
                  aria-label="添加电子书到书架，支持 EPUB 和 PDF"
                >
                  <div className="ebook-book-add-cover" aria-hidden="true">
                    <span className="ebook-book-add-plus">＋</span>
                    <span className="ebook-book-add-label">添加电子书</span>
                    <span className="ebook-book-add-hint">
                      EPUB · PDF · 可拖入
                    </span>
                    {busy && (
                      <span className="ebook-book-add-busy-text">导入中…</span>
                    )}
                  </div>
                </button>
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
            <p>选择或拖入 EPUB、PDF 文件后会复制到当前文件库。</p>
            <div className="ebook-shelf-empty-actions">
              <button type="button" onClick={onImport} disabled={busy}>
                添加电子书（EPUB / PDF）
              </button>
            </div>
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
                ”会从当前文件库中移除，阅读位置、书签、标注、热力图记录和单书阅读计划也会清除。
                {linkedExamCount > 0
                  ? `关联的 ${linkedExamCount} 份试卷、答案和自评也会一起删除。`
                  : '关联的试卷和作答也会一起删除。'}
                技能阅读路径中会保留这本书的位置并标记为已移出书架。
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
        {pdfDeleteTarget && (
          <div
            className="ebook-delete-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !deletingPath)
                setPdfDeleteTarget(null);
            }}
          >
            <section
              className="ebook-delete-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="ebook-pdf-delete-title"
            >
              <h2 id="ebook-pdf-delete-title">删除这本 PDF？</h2>
              <p>
                “{pdfDeleteTarget.title}”会从书架移除，同时清除这本 PDF
                在书架里的阅读位置、书签和批注。
              </p>
              {deleteError && (
                <p className="ebook-delete-error" role="alert">
                  {deleteError}
                </p>
              )}
              <div>
                <button
                  type="button"
                  disabled={Boolean(deletingPath)}
                  onClick={() => setPdfDeleteTarget(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="is-danger"
                  disabled={Boolean(deletingPath)}
                  onClick={() => {
                    const target = pdfDeleteTarget;
                    setDeletingPath(target.relativePath);
                    void onDeletePdfBook(target)
                      .then(() => {
                        setPdfDeleteTarget(null);
                        setDashboardRevision((value) => value + 1);
                      })
                      .catch((error) =>
                        setDeleteError(
                          error instanceof Error
                            ? error.message
                            : String(error),
                        ),
                      )
                      .finally(() => setDeletingPath(''));
                  }}
                >
                  {deletingPath ? '正在删除…' : '确认删除'}
                </button>
              </div>
            </section>
          </div>
        )}

        {categoryTarget && (
          <div
            className="ebook-category-backdrop"
            role="presentation"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setCategoryTarget(null);
                setCategoryError('');
              }
            }}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setCategoryTarget(null);
                setCategoryError('');
              }
            }}
          >
            <form
              className="ebook-category-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="ebook-category-title"
              onSubmit={saveNewBookCategory}
            >
              <h2 id="ebook-category-title">新建书籍分类</h2>
              <p>为《{categoryTarget.title}》创建并应用一个分类。</p>
              <label>
                <span>分类名称</span>
                <input
                  value={newCategoryName}
                  onChange={(event) => setNewCategoryName(event.target.value)}
                  maxLength={24}
                  autoFocus
                  required
                />
              </label>
              {categoryError && (
                <p className="ebook-category-error" role="alert">
                  {categoryError}
                </p>
              )}
              <div className="ebook-category-dialog-actions">
                <button
                  type="button"
                  onClick={() => {
                    setCategoryTarget(null);
                    setCategoryError('');
                  }}
                >
                  取消
                </button>
                <button type="submit" className="is-primary">
                  保存分类
                </button>
              </div>
            </form>
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

      <div
        className="ebook-online-page"
        id="ebook-panel-online"
        role="tabpanel"
        aria-labelledby="ebook-tab-online"
        hidden={page !== 'online'}
      >
        <ZlibSearchDialog
          active={active && page === 'online'}
          hasRoot={Boolean(snapshot?.rootPath)}
          onBookDownloaded={(doc, openImmediately) => {
            onRefresh();
            if (openImmediately) onOpenBook(doc);
          }}
        />
      </div>
      <div
        className="ebook-heatmap-page"
        id="ebook-panel-heatmap"
        role="tabpanel"
        aria-labelledby="ebook-tab-heatmap"
        hidden={page !== 'heatmap'}
      >
        <EbookReadingHeatmap
          books={dashboardBooks}
          onActivityChanged={() => setDashboardRevision((value) => value + 1)}
        />
      </div>
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
