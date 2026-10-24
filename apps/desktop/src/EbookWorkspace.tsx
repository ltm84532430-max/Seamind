import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { EpubBookDocument, LibrarySnapshot } from './library';
import { EpubExamLibraryPanel, EpubExamWorkspace } from './EpubExamLibrary';
import type { EpubExamSummary } from './epub-exams';
import { listEpubExams } from './epub-exams';
import {
  clearEpubReaderData,
  deleteEpubReadingPlan,
  epubProgressKey,
  loadEpubBookMetadata,
  loadEpubReadingActivity,
  loadEpubReadingPlan,
  saveEpubBookMetadata,
  saveEpubReadingPlan,
} from './ebook-storage';
import type { EpubReadingPlan } from './ebook-storage';
import EbookReadingDashboard from './EbookReadingDashboard';
import type { EbookDashboardBook } from './EbookReadingDashboard';
import EbookReadingHeatmap from './EbookReadingHeatmap';

type ShelfSort = 'recent' | 'title' | 'added';

const NEW_BOOK_CATEGORY = '__new_book_category__';

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
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [categoryError, setCategoryError] = useState('');
  const [categoryTarget, setCategoryTarget] = useState<EpubBookDocument | null>(
    null,
  );
  const [newCategoryName, setNewCategoryName] = useState('');
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
  const [exams, setExams] = useState<EpubExamSummary[]>([]);
  const [examsLoading, setExamsLoading] = useState(true);
  const [examsError, setExamsError] = useState('');
  const [examLibraryOpen, setExamLibraryOpen] = useState(false);
  const [filteredExamBookKey, setFilteredExamBookKey] = useState('');
  const [selectedExam, setSelectedExam] = useState<EpubExamSummary | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    setExamsLoading(true);
    setExamsError('');
    void listEpubExams()
      .then((items) => {
        if (active) setExams(items);
      })
      .catch((error) => {
        if (active)
          setExamsError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (active) setExamsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [snapshot?.books]);

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

  const returnToExamLibrary = () => {
    setSelectedExam(null);
    setExamsLoading(true);
    void listEpubExams()
      .then((items) => {
        setExams(items);
        setExamsError('');
      })
      .catch((error) => {
        setExamsError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setExamsLoading(false));
  };

  if (selectedExam) {
    return (
      <EpubExamWorkspace
        examId={selectedExam.id}
        bookKey={selectedExam.bookKey}
        onBack={returnToExamLibrary}
      />
    );
  }

  const examCounts = new Map<string, number>();
  for (const exam of exams) {
    examCounts.set(exam.bookKey, (examCounts.get(exam.bookKey) ?? 0) + 1);
  }
  const linkedExamCount = deleteTarget
    ? (examCounts.get(deleteTarget.relativePath) ?? 0)
    : 0;

  return (
    <main
      className={`ebook-shelf${dashboardCollapsed ? ' is-dashboard-collapsed' : ''}${examLibraryOpen ? ' is-exam-library-open' : ''}`}
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
        rootPath={snapshot?.rootPath ?? ''}
        libraryBooks={books}
        onOpenBook={onOpenBook}
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
              className="ebook-exam-library-toggle"
              aria-expanded={examLibraryOpen}
              onClick={() => setExamLibraryOpen((open) => !open)}
            >
              {examLibraryOpen
                ? '收起试卷库'
                : `试卷库${exams.length ? ` · ${exams.length}` : ''}`}
            </button>
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
            </div>

            {categoryError && !categoryTarget && (
              <p className="ebook-category-error" role="alert">
                {categoryError}
              </p>
            )}

            <EbookReadingHeatmap books={dashboardBooks} />

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

            {visibleBooks.length ? (
              <section className="ebook-shelf-grid" aria-label="已导入的电子书">
                {categoryFilter === 'all' &&
                  categoryGroups.map(({ category, books: groupedBooks }) => {
                    const previewBooks = groupedBooks.slice(0, 4);
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
                          className={`ebook-category-folder-preview has-${previewBooks.length}`}
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
                          {previewBooks.length > 1 &&
                            previewBooks.length < 4 && (
                              <span
                                className={`ebook-category-folder-empty${previewBooks.length === 2 ? ' is-wide' : ''}`}
                              >
                                已全部展示
                              </span>
                            )}
                        </span>
                        <strong>{category}</strong>
                        <span className="ebook-category-folder-count">
                          {groupedBooks.length} 本书
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
                          onClick={() => {
                            setFilteredExamBookKey(book.relativePath);
                            setExamLibraryOpen(true);
                          }}
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

      <EpubExamLibraryPanel
        books={books.map((book) => ({
          relativePath: book.relativePath,
          title:
            loadEpubBookMetadata(epubProgressKey(book))?.title || book.title,
        }))}
        exams={exams}
        filteredBookKey={filteredExamBookKey}
        loading={examsLoading}
        error={examsError}
        open={examLibraryOpen}
        onClose={() => setExamLibraryOpen(false)}
        onFilterBook={setFilteredExamBookKey}
        onOpenExam={(exam) => setSelectedExam(exam)}
      />

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
