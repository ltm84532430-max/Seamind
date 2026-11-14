import { useMemo } from 'react';
import type {
  EpubExam,
  EpubExamAnswer,
  EpubExamGrade,
  EpubExamSelfReview,
  EpubExamSummary,
} from './epub-exams';
import type { ExamPaper } from './exam-paper';
import { ExamPaperReview } from './ExamPaperReview';
import { type BookExamStats, isAnswerFilled } from './useExamSession';

interface Props {
  collapsed: boolean;
  onToggleCollapse: () => void;
  displayMode: 'spread' | 'workspace' | 'paper';
  pageIndex: number;
  pageStep: number;
  paperFocusId: string;
  exam: EpubExam | null;
  paper: ExamPaper | null;
  activeExamId: string;
  sortedBookExams: EpubExamSummary[];
  bookStats: BookExamStats;
  answers: Record<string, EpubExamAnswer>;
  selfReviews: Record<string, EpubExamSelfReview>;
  grades: Record<string, EpubExamGrade>;
  busy: boolean;
  onScrollToQuestion: (questionId: string) => void;
  onJumpNextUnanswered: () => void;
  onSwitchExam: (examId: string) => void;
  onEditReview: (questionId: string, value: EpubExamSelfReview) => void;
  onOverrideGrade: (questionId: string, earned: number) => void;
}

export function ExamAnalyticsSidebar({
  collapsed,
  onToggleCollapse,
  displayMode,
  pageIndex,
  pageStep,
  paperFocusId,
  exam,
  paper,
  activeExamId,
  sortedBookExams,
  bookStats,
  answers,
  selfReviews,
  grades,
  busy,
  onScrollToQuestion,
  onJumpNextUnanswered,
  onSwitchExam,
  onEditReview,
  onOverrideGrade,
}: Props) {
  const questionsList = exam?.questions ?? [];
  const examSubmitted = exam?.status === 'submitted';

  const answeredCount = useMemo(
    () =>
      questionsList.filter((question) => isAnswerFilled(answers[question.id]))
        .length,
    [answers, questionsList],
  );

  const weakQuestions = useMemo(() => {
    if (!exam || !examSubmitted) return [];
    return questionsList.filter((q) => selfReviews[q.id] === 'review');
  }, [exam, examSubmitted, questionsList, selfReviews]);

  const activeQuestionIds = useMemo(() => {
    const ids = new Set<string>();
    if (displayMode === 'paper') {
      if (paperFocusId) ids.add(paperFocusId);
      return ids;
    }
    const first = questionsList[pageIndex];
    if (first) ids.add(first.id);
    if (displayMode === 'spread' && pageStep === 2) {
      const second = questionsList[pageIndex + 1];
      if (second) ids.add(second.id);
    }
    return ids;
  }, [displayMode, pageIndex, pageStep, paperFocusId, questionsList]);

  const paperNumberById = useMemo(() => {
    const map = new Map<string, number>();
    if (!paper) return map;
    for (const sec of paper.sections) {
      for (const item of sec.items) {
        map.set(item.question.id, item.number);
      }
    }
    return map;
  }, [paper]);

  const renderHeatmapCell = (questionId: string, displayNum: number) => {
    const hasAns = isAnswerFilled(answers[questionId]);
    const rev = selfReviews[questionId];

    let stateClass = 'is-unanswered';
    let icon = `${displayNum}`;
    let statusTitle = `第 ${displayNum} 题: 待作答`;

    if (examSubmitted) {
      if (rev === 'mastered') {
        stateClass = 'is-mastered';
        icon = '✓';
        statusTitle = `第 ${displayNum} 题: 已掌握`;
      } else if (rev === 'partial') {
        stateClass = 'is-partial';
        icon = '◐';
        statusTitle = `第 ${displayNum} 题: 部分掌握`;
      } else if (rev === 'review') {
        stateClass = 'is-review';
        icon = '✗';
        statusTitle = `第 ${displayNum} 题: 需复习`;
      } else {
        stateClass = 'is-pending-review';
        icon = '?';
        statusTitle = `第 ${displayNum} 题: 已交卷待自评`;
      }
    } else if (hasAns) {
      stateClass = 'is-answered';
      statusTitle = `第 ${displayNum} 题: 已作答`;
    }

    return (
      <button
        key={questionId}
        type="button"
        className={`epub-exam-heatmap-cell ${stateClass}${activeQuestionIds.has(questionId) ? ' is-current' : ''}`}
        onClick={() => onScrollToQuestion(questionId)}
        title={statusTitle}
      >
        <span className="epub-exam-cell-index">{displayNum}</span>
        {examSubmitted && <span className="epub-exam-cell-icon">{icon}</span>}
      </button>
    );
  };

  return (
    <aside
      className={`epub-exam-analytics${collapsed ? ' is-collapsed' : ''}`}
      aria-label="答题卡"
    >
      <div className="epub-exam-analytics-header">
        <div className="epub-exam-analytics-title">
          <h2>答题卡</h2>
        </div>
        <button
          type="button"
          className="epub-exam-sidebar-collapse-btn"
          onClick={onToggleCollapse}
          title={collapsed ? '展开答题卡' : '收起答题卡'}
          aria-label={collapsed ? '展开答题卡' : '收起答题卡'}
        >
          {collapsed ? '◀' : '▶'}
        </button>
      </div>

      {!collapsed && (
        <div className="epub-exam-analytics-body">
          {displayMode === 'paper' && exam && (
            <ExamPaperReview
              exam={exam}
              paper={paper ?? undefined}
              focusId={paperFocusId}
              submitted={examSubmitted}
              busy={busy}
              answer={answers[paperFocusId]}
              review={selfReviews[paperFocusId]}
              grade={grades[paperFocusId]}
              onReview={(value) => onEditReview(paperFocusId, value)}
              onOverride={(earned) => onOverrideGrade(paperFocusId, earned)}
              onJumpNextUnanswered={
                !examSubmitted ? onJumpNextUnanswered : undefined
              }
            />
          )}

          <section className="epub-exam-analytics-card">
            <div className="epub-exam-card-title-row">
              <h3>题号</h3>
              {!examSubmitted && answeredCount < questionsList.length ? (
                <button
                  type="button"
                  className="epub-exam-next-unanswered-btn"
                  onClick={onJumpNextUnanswered}
                >
                  下一未答
                </button>
              ) : (
                <span className="epub-exam-card-badge">
                  {questionsList.length} 题
                </span>
              )}
            </div>
            <p className="epub-exam-card-hint">
              已答 {answeredCount} / {questionsList.length}
            </p>

            {displayMode === 'paper' && paper ? (
              <div className="epub-exam-heatmap-sections">
                {paper.sections.map((section) => (
                  <div key={section.type}>
                    <div className="epub-exam-heatmap-sec-label">
                      {section.ordinal}、{section.title}
                    </div>
                    <div className="epub-exam-heatmap-grid">
                      {section.items.map((item) =>
                        renderHeatmapCell(item.question.id, item.number),
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="epub-exam-heatmap-grid">
                {questionsList.map((q, idx) =>
                  renderHeatmapCell(q.id, idx + 1),
                )}
              </div>
            )}

            <div className="epub-exam-legend-row">
              <span className="epub-exam-legend-item">
                <i className="is-mastered" /> 掌握
              </span>
              <span className="epub-exam-legend-item">
                <i className="is-partial" /> 部分
              </span>
              <span className="epub-exam-legend-item">
                <i className="is-review" /> 需复习
              </span>
              <span className="epub-exam-legend-item">
                <i className="is-unanswered" /> 待答
              </span>
            </div>
          </section>

          <section className="epub-exam-analytics-card">
            <div className="epub-exam-card-title-row">
              <h3>本卷小结</h3>
            </div>
            <p className="epub-exam-card-hint">
              {examSubmitted ? '已交卷' : '未交卷'} · 已答 {answeredCount} /{' '}
              {questionsList.length}
              {examSubmitted
                ? ` · 掌握 ${Object.values(selfReviews).filter((item) => item === 'mastered').length}`
                : ''}
            </p>
          </section>

          {examSubmitted && (
            <>
              <section className="epub-exam-analytics-card">
                <div className="epub-exam-card-title-row">
                  <h3>本书套次</h3>
                  <span className="epub-exam-card-badge">
                    {sortedBookExams.length} 套
                  </span>
                </div>
                <p className="epub-exam-card-hint">点击套次切换试卷</p>

                <div className="epub-exam-chapter-matrix">
                  {sortedBookExams.map((item, idx) => {
                    const isActive = item.id === activeExamId;
                    const isSubmitted = item.status === 'submitted';
                    const itemQCount = item.questionCount ?? 0;
                    const mastered =
                      item.id === activeExamId && exam
                        ? Object.values(selfReviews).filter(
                            (r) => r === 'mastered',
                          ).length
                        : (item.masteredCount ?? 0);
                    const review =
                      item.id === activeExamId && exam
                        ? Object.values(selfReviews).filter(
                            (r) => r === 'review',
                          ).length
                        : (item.reviewCount ?? 0);

                    let cellClass = 'is-not-submitted';
                    if (isSubmitted) {
                      const rate = itemQCount > 0 ? mastered / itemQCount : 0;
                      if (review > 0) {
                        cellClass = 'is-level-review';
                      } else if (rate >= 0.8) {
                        cellClass = 'is-level-high';
                      } else if (rate >= 0.4) {
                        cellClass = 'is-level-med';
                      } else {
                        cellClass = 'is-level-low';
                      }
                    }

                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`epub-exam-chapter-cell ${cellClass}${isActive ? ' is-active' : ''}`}
                        onClick={() => onSwitchExam(item.id)}
                        title={`[第${idx + 1}套] ${item.sourceSectionLabel || ''}\n${isSubmitted ? `已掌握: ${mastered}/${itemQCount}` : '未交卷'}`}
                      >
                        <span>{idx + 1}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="epub-exam-analytics-card">
                <div className="epub-exam-card-title-row">
                  <h3>掌握</h3>
                </div>

                <div className="epub-exam-kpi-grid">
                  <div className="epub-exam-kpi-box">
                    <span className="epub-exam-kpi-val">
                      {bookStats.masteryRate}%
                    </span>
                    <span className="epub-exam-kpi-label">掌握率</span>
                  </div>
                  <div className="epub-exam-kpi-box">
                    <span className="epub-exam-kpi-val">
                      {bookStats.answeredQuestions}
                      <small>/{bookStats.totalQuestions}</small>
                    </span>
                    <span className="epub-exam-kpi-label">已练</span>
                  </div>
                  <div className="epub-exam-kpi-box">
                    <span className="epub-exam-kpi-val is-danger">
                      {bookStats.totalReview}
                    </span>
                    <span className="epub-exam-kpi-label">需复习</span>
                  </div>
                </div>

                <div className="epub-exam-progress-bar-wrap">
                  <div className="epub-exam-progress-bar">
                    <div
                      className="epub-exam-bar-seg is-mastered"
                      style={{
                        width: `${bookStats.totalQuestions > 0 ? (bookStats.totalMastered / bookStats.totalQuestions) * 100 : 0}%`,
                      }}
                      title={`已掌握: ${bookStats.totalMastered}`}
                    />
                    <div
                      className="epub-exam-bar-seg is-partial"
                      style={{
                        width: `${bookStats.totalQuestions > 0 ? (bookStats.totalPartial / bookStats.totalQuestions) * 100 : 0}%`,
                      }}
                      title={`部分掌握: ${bookStats.totalPartial}`}
                    />
                    <div
                      className="epub-exam-bar-seg is-review"
                      style={{
                        width: `${bookStats.totalQuestions > 0 ? (bookStats.totalReview / bookStats.totalQuestions) * 100 : 0}%`,
                      }}
                      title={`需复习: ${bookStats.totalReview}`}
                    />
                  </div>
                  <div className="epub-exam-bar-legend">
                    <span>掌握 {bookStats.totalMastered}</span>
                    <span>部分 {bookStats.totalPartial}</span>
                    <span>复习 {bookStats.totalReview}</span>
                  </div>
                </div>
              </section>

              <section className="epub-exam-analytics-card">
                <div className="epub-exam-card-title-row">
                  <h3>薄弱题</h3>
                  {weakQuestions.length > 0 && (
                    <span className="epub-exam-card-badge is-alert">
                      {weakQuestions.length} 项
                    </span>
                  )}
                </div>

                {weakQuestions.length === 0 ? (
                  <div className="epub-exam-empty-focus">
                    <span className="epub-exam-check-icon">✓</span>
                    <p>还没有标成需复习的题。</p>
                  </div>
                ) : (
                  <div className="epub-exam-focus-list">
                    {weakQuestions.map((q) => {
                      const qIndex = questionsList.findIndex(
                        (item) => item.id === q.id,
                      );
                      const displayNum =
                        displayMode === 'paper'
                          ? (paperNumberById.get(q.id) ?? qIndex + 1)
                          : qIndex >= 0
                            ? qIndex + 1
                            : 1;
                      return (
                        <button
                          key={q.id}
                          type="button"
                          className="epub-exam-focus-item"
                          onClick={() => onScrollToQuestion(q.id)}
                          title="点击定位到该题查看 AI 解析"
                        >
                          <span className="epub-exam-focus-dot">!</span>
                          <div className="epub-exam-focus-text">
                            <strong>第 {displayNum} 题</strong>
                            <p>{q.prompt}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
