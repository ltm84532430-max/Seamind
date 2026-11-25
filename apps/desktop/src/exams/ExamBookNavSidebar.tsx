import { useMemo, useState } from 'react';
import type {
  EpubExam,
  EpubExamSelfReview,
  EpubExamSummary,
} from './epub-exams';
import { getDifficultyLabel } from './useExamSession';

interface Props {
  collapsed: boolean;
  onToggleCollapse: () => void;
  bookTitle: string;
  sortedBookExams: EpubExamSummary[];
  submittedCount: number;
  activeExamId: string;
  activeExam: EpubExam | null;
  selfReviews: Record<string, EpubExamSelfReview>;
  busy: boolean;
  onSwitchExam: (examId: string) => void;
}

export function ExamBookNavSidebar({
  collapsed,
  onToggleCollapse,
  bookTitle,
  sortedBookExams,
  submittedCount,
  activeExamId,
  activeExam,
  selfReviews,
  busy,
  onSwitchExam,
}: Props) {
  const [filterText, setFilterText] = useState('');

  const filteredBookExams = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return sortedBookExams;
    return sortedBookExams.filter(
      (item) =>
        (item.sourceSectionLabel || '').toLowerCase().includes(q) ||
        (item.difficulty && getDifficultyLabel(item.difficulty).includes(q)) ||
        (item.status === 'submitted' ? '已交卷' : '未交卷').includes(q),
    );
  }, [filterText, sortedBookExams]);

  return (
    <aside
      className={`epub-exam-sidebar${collapsed ? ' is-collapsed' : ''}`}
      aria-label="同书顺序试卷导航"
    >
      <div className="epub-exam-sidebar-header">
        <div className="epub-exam-sidebar-book-meta">
          <h2 title={bookTitle || '当前书籍'}>本书试卷</h2>
          <span className="epub-exam-sidebar-count">
            {submittedCount}/{sortedBookExams.length} 套
          </span>
        </div>
        <button
          type="button"
          className="epub-exam-sidebar-collapse-btn"
          onClick={onToggleCollapse}
          title={collapsed ? '展开本书试卷' : '收起本书试卷'}
          aria-label={collapsed ? '展开本书试卷' : '收起本书试卷'}
        >
          {collapsed ? '▶' : '◀'}
        </button>
      </div>

      {!collapsed && (
        <>
          <div
            className="epub-exam-sidebar-book-banner"
            title={bookTitle || '当前书籍'}
          >
            <span>《{bookTitle || '当前书籍'}》</span>
          </div>
          <div className="epub-exam-sidebar-search">
            <input
              type="text"
              placeholder="搜索章节或考点…"
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
            />
            {filterText && (
              <button
                type="button"
                className="epub-exam-filter-clear"
                onClick={() => setFilterText('')}
              >
                ×
              </button>
            )}
          </div>

          <nav className="epub-exam-sidebar-list">
            {filteredBookExams.length === 0 ? (
              <div className="epub-exam-sidebar-empty">未找到匹配的试卷</div>
            ) : (
              filteredBookExams.map((item, index) => {
                const isActive = item.id === activeExamId;
                const isSubmitted = item.status === 'submitted';
                let statusBadge = (
                  <span className="epub-exam-pill is-pending">未交卷</span>
                );
                if (isSubmitted) {
                  const mastered =
                    item.id === activeExamId && activeExam
                      ? Object.values(selfReviews).filter(
                          (r) => r === 'mastered',
                        ).length
                      : (item.masteredCount ?? 0);
                  const review =
                    item.id === activeExamId && activeExam
                      ? Object.values(selfReviews).filter((r) => r === 'review')
                          .length
                      : (item.reviewCount ?? 0);
                  if (review > 0) {
                    statusBadge = (
                      <span className="epub-exam-pill is-review">需复习</span>
                    );
                  } else if (mastered >= (item.questionCount ?? 0) * 0.7) {
                    statusBadge = (
                      <span className="epub-exam-pill is-mastered">已掌握</span>
                    );
                  } else {
                    statusBadge = (
                      <span className="epub-exam-pill is-partial">
                        部分掌握
                      </span>
                    );
                  }
                }

                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`epub-exam-sidebar-item${isActive ? ' is-active' : ''}`}
                    onClick={() => onSwitchExam(item.id)}
                    disabled={busy}
                  >
                    <div className="epub-exam-sidebar-item-top">
                      <span className="epub-exam-seq-badge">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span
                        className="epub-exam-sidebar-item-title"
                        title={item.sourceSectionLabel || ''}
                      >
                        {item.sourceSectionLabel || '未命名章节'}
                      </span>
                    </div>
                    <div className="epub-exam-sidebar-item-meta">
                      <span>
                        {item.questionCount ?? 0} 题 ·{' '}
                        {getDifficultyLabel(item.difficulty)}
                      </span>
                      {statusBadge}
                    </div>
                  </button>
                );
              })
            )}
          </nav>
        </>
      )}
    </aside>
  );
}
