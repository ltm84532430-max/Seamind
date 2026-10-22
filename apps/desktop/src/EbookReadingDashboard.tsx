import { useMemo, useState } from 'react';
import type { EpubBookDocument } from './library';
import EbookLearningPaths from './EbookLearningPaths';
import type {
  EpubBookMetadata,
  EpubReadingActivity,
  EpubReadingPlan,
} from './ebook-storage';
import { getEpubReadingPlanCompleted } from './ebook-storage';

export interface EbookDashboardBook {
  progressKey: string;
  title: string;
  metadata: EpubBookMetadata | null;
  activity: EpubReadingActivity | null;
  plan: EpubReadingPlan | null;
}

export default function EbookReadingDashboard({
  books,
  open,
  collapsed,
  onClose,
  onToggleCollapsed,
  onCancelPlan,
  rootPath,
  libraryBooks,
  onOpenBook,
}: {
  books: EbookDashboardBook[];
  open: boolean;
  collapsed: boolean;
  onClose: () => void;
  onToggleCollapsed: () => void;
  onCancelPlan: (progressKey: string) => void;
  rootPath: string;
  libraryBooks: EpubBookDocument[];
  onOpenBook: (book: EpubBookDocument) => void;
}) {
  const [page, setPage] = useState<'books' | 'paths'>(() => {
    try {
      return sessionStorage.getItem('seamind:reading-dashboard-page:v1') ===
        'paths'
        ? 'paths'
        : 'books';
    } catch {
      return 'books';
    }
  });
  const selectPage = (next: 'books' | 'paths') => {
    setPage(next);
    try {
      sessionStorage.setItem('seamind:reading-dashboard-page:v1', next);
    } catch {
      // Switching pages still works when session storage is unavailable.
    }
  };
  const activePage = rootPath ? page : 'books';
  const todayKey = localDateKey(new Date());
  const plans = useMemo(
    () =>
      books
        .filter((book) => book.plan)
        .map((book) => ({ ...book, plan: book.plan! }))
        .sort((a, b) => a.plan.dueDate.localeCompare(b.plan.dueDate)),
    [books],
  );

  return (
    <>
      {open && (
        <button
          className="ebook-dashboard-backdrop"
          aria-label="关闭阅读看板"
          onClick={onClose}
        />
      )}
      <aside
        className={`ebook-reading-dashboard${open ? ' is-open' : ''}${collapsed ? ' is-collapsed' : ''}`}
        aria-label="阅读计划看板"
      >
        <header className="ebook-dashboard-header">
          <div>
            <span className="ebook-dashboard-kicker">READING · DASHBOARD</span>
            <h2>阅读计划</h2>
          </div>
          <button
            type="button"
            className="ebook-dashboard-close"
            onClick={onClose}
            aria-label="关闭阅读看板"
          >
            ×
          </button>
          <button
            type="button"
            className="ebook-dashboard-collapse"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? '展开阅读看板' : '收起阅读看板'}
            aria-expanded={!collapsed}
            title={collapsed ? '展开阅读看板' : '收起阅读看板'}
          >
            {collapsed ? '›' : '‹'}
          </button>
        </header>

        <div
          className="ebook-dashboard-pages"
          role="tablist"
          aria-label="阅读计划视图"
          onKeyDown={(event) => {
            if (
              !rootPath ||
              (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
            )
              return;
            event.preventDefault();
            const next = activePage === 'books' ? 'paths' : 'books';
            selectPage(next);
            document.getElementById(`ebook-dashboard-${next}-tab`)?.focus();
          }}
        >
          <button
            id="ebook-dashboard-books-tab"
            type="button"
            role="tab"
            aria-controls="ebook-dashboard-books-page"
            aria-selected={activePage === 'books'}
            className={activePage === 'books' ? 'is-active' : ''}
            onClick={() => selectPage('books')}
          >
            单书计划
          </button>
          <button
            id="ebook-dashboard-paths-tab"
            type="button"
            role="tab"
            aria-controls="ebook-dashboard-paths-page"
            aria-selected={activePage === 'paths'}
            className={activePage === 'paths' ? 'is-active' : ''}
            onClick={() => selectPage('paths')}
            disabled={!rootPath}
          >
            技能路径
          </button>
        </div>

        <section
          className="ebook-dashboard-plans"
          id="ebook-dashboard-books-page"
          role="tabpanel"
          aria-labelledby="ebook-dashboard-books-tab"
          hidden={activePage !== 'books'}
        >
          <div className="ebook-dashboard-section-heading">
            <div>
              <h3 id="ebook-plans-title">我的计划</h3>
              <p>
                {plans.length
                  ? `${plans.length} 本书`
                  : '从书籍卡片菜单添加计划'}
              </p>
            </div>
          </div>
          {plans.length ? (
            <div className="ebook-dashboard-plan-list">
              {plans.map(({ progressKey, title, metadata, plan }) => {
                const completed = getEpubReadingPlanCompleted(plan);
                const ratio = Math.min(1, completed / plan.targetChapters);
                const status =
                  completed >= plan.targetChapters
                    ? '已完成'
                    : plan.dueDate < todayKey
                      ? '已逾期'
                      : '进行中';
                return (
                  <article className="ebook-dashboard-plan" key={progressKey}>
                    <div className="ebook-dashboard-plan-cover">
                      {metadata?.coverDataUrl ? (
                        <img src={metadata.coverDataUrl} alt={`${title}封面`} />
                      ) : (
                        <div
                          className="ebook-dashboard-plan-cover-fallback"
                          aria-label={`${title}封面尚未提取`}
                        >
                          <span>S</span>
                          <strong>{title}</strong>
                        </div>
                      )}
                    </div>
                    <div className="ebook-dashboard-plan-content">
                      <div className="ebook-dashboard-plan-topline">
                        <strong title={title}>{title}</strong>
                        <span
                          className={`ebook-dashboard-plan-status ${status === '已完成' ? 'is-complete' : status === '已逾期' ? 'is-overdue' : ''}`}
                        >
                          {status}
                        </span>
                      </div>
                      <p>
                        {completed} / {plan.targetChapters} 章
                        {plan.startPending
                          ? ' · 打开时校准起点'
                          : plan.startChapterLabel
                            ? ` · 从「${plan.startChapterLabel}」起`
                            : ''}
                      </p>
                      <div
                        className="ebook-dashboard-plan-progress"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={plan.targetChapters}
                        aria-valuenow={completed}
                        aria-label={`${title}阅读计划进度`}
                      >
                        <i style={{ width: `${Math.round(ratio * 100)}%` }} />
                      </div>
                      <div className="ebook-dashboard-plan-footer">
                        <span>截止 {formatDate(plan.dueDate)}</span>
                        <button
                          type="button"
                          onClick={() => onCancelPlan(progressKey)}
                        >
                          取消计划
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="ebook-dashboard-empty">
              <span aria-hidden="true">＋</span>
              <p>还没有阅读计划</p>
            </div>
          )}
        </section>
        {rootPath && (
          <div
            id="ebook-dashboard-paths-page"
            className="ebook-dashboard-path-page"
            role="tabpanel"
            aria-labelledby="ebook-dashboard-paths-tab"
            hidden={activePage !== 'paths'}
          >
            <EbookLearningPaths
              rootPath={rootPath}
              books={libraryBooks}
              onOpenBook={onOpenBook}
            />
          </div>
        )}
      </aside>
    </>
  );
}

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDate(date: string) {
  const [year, month, day] = date.split('-');
  return `${year}.${month}.${day}`;
}
