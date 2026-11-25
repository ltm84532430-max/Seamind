import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import type {
  EpubExam,
  EpubExamAttempt,
  EpubExamAnswer,
  EpubExamSelfReview,
} from './epub-exams';
import { formatEpubExamDate } from './epub-exams';
import { choiceTexts, composeExamPaper } from './exam-paper';
import { ExamPaperSheet } from './ExamPaperSheet';
import EpubExamQuestion from './EpubExamQuestion';
import { ExamBookNavSidebar } from './ExamBookNavSidebar';
import { ExamAnalyticsSidebar } from './ExamAnalyticsSidebar';
import {
  getDifficultyLabel,
  isAnswerFilled,
  normalizeExam,
  useExamSession,
} from './useExamSession';
import './epub-exam-v2.css';

export { normalizeExam };

export interface EpubExamWorkspaceProps {
  provider?: { baseUrl: string; model: string };
  examId: string;
  bookKey: string;
  onBack: () => void;
  initialExam?: EpubExam;
}

interface ExamErrorBoundaryProps {
  onBack: () => void;
  children: ReactNode;
}

interface ExamErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ExamErrorBoundary extends Component<
  ExamErrorBoundaryProps,
  ExamErrorBoundaryState
> {
  override state: ExamErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  static getDerivedStateFromError(error: Error): ExamErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(
      '[ExamErrorBoundary] Uncaught render error in exam workspace:',
      error,
      errorInfo,
    );
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="epub-exam-workspace-shell">
          <main className="epub-exam-stage">
            <div className="epub-exam-page-error">
              <button
                type="button"
                className="epub-exam-back-btn"
                onClick={this.props.onBack}
              >
                ← 返回试卷列表
              </button>
              <h2
                style={{
                  fontSize: '1.1rem',
                  fontWeight: 600,
                  color: 'var(--exam-ink, #0f172a)',
                  margin: '16px 0 8px',
                }}
              >
                试卷加载发生异常
              </h2>
              <p
                role="alert"
                style={{
                  color: 'var(--exam-muted, #64748b)',
                  fontSize: '0.9rem',
                  marginBottom: '16px',
                }}
              >
                {this.state.error?.message || '未知渲染错误，已阻止应用白屏。'}
              </p>
              <button
                type="button"
                className="epub-exam-action-btn is-primary"
                onClick={() => {
                  this.setState({ hasError: false, error: null });
                }}
              >
                重试加载
              </button>
            </div>
          </main>
        </div>
      );
    }
    return this.props.children;
  }
}

function formatExamAnswer(answer: EpubExamAnswer | undefined): string {
  if (answer === undefined || answer === '') return '未作答';
  return Array.isArray(answer) ? answer.join('、') || '未作答' : answer;
}

function formatSelfReview(review: EpubExamSelfReview | undefined): string {
  if (review === 'mastered') return '已掌握';
  if (review === 'partial') return '部分掌握';
  if (review === 'review') return '需复习';
  return '未自评';
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function EpubExamWorkspaceInner({
  provider,
  examId,
  bookKey,
  onBack,
  initialExam,
}: EpubExamWorkspaceProps) {
  const [displayMode, setDisplayMode] = useState<
    'spread' | 'workspace' | 'paper'
  >('spread');
  const [paperFocusId, setPaperFocusId] = useState(
    () => initialExam?.questions?.[0]?.id ?? '',
  );
  const [pageIndex, setPageIndex] = useState(0);
  const [compactPages, setCompactPages] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [analyticsCollapsed, setAnalyticsCollapsed] = useState(false);
  const [paperWideWidth, setPaperWideWidth] = useState(false);
  const [paperWhiteSurface, setPaperWhiteSurface] = useState(false);
  const [scrollLockNonce, setScrollLockNonce] = useState(0);

  const stageRef = useRef<HTMLElement>(null);
  const preZenStateRef = useRef<{
    sidebar: boolean;
    analytics: boolean;
  } | null>(null);
  const isZenMode = sidebarCollapsed && analyticsCollapsed;

  const toggleZenMode = useCallback(() => {
    if (sidebarCollapsed && analyticsCollapsed) {
      const prev = preZenStateRef.current;
      if (prev && (!prev.sidebar || !prev.analytics)) {
        setSidebarCollapsed(prev.sidebar);
        setAnalyticsCollapsed(prev.analytics);
      } else {
        setSidebarCollapsed(false);
        setAnalyticsCollapsed(false);
      }
      preZenStateRef.current = null;
      return;
    }
    preZenStateRef.current = {
      sidebar: sidebarCollapsed,
      analytics: analyticsCollapsed,
    };
    setSidebarCollapsed(true);
    setAnalyticsCollapsed(true);
  }, [analyticsCollapsed, sidebarCollapsed]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const width = el.clientWidth;
      if (width > 0) setCompactPages(width < 980);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleExamReset = useCallback((nextExam: EpubExam | null) => {
    setPageIndex(0);
    setPaperFocusId(nextExam?.questions?.[0]?.id ?? '');
  }, []);

  const session = useExamSession({
    provider,
    examId,
    bookKey,
    initialExam,
    onBack,
    onExamReset: handleExamReset,
  });

  const {
    activeExamId,
    exam,
    sortedBookExams,
    bookStats,
    answers,
    selfReviews,
    grades,
    codeResults,
    codeBusyId,
    gradingBusy,
    loading,
    busy,
    error,
    saveState,
    editAnswer,
    editReview,
    runCode,
    gradeSubjective,
    overrideGrade,
    submitExam,
    restartExam,
    deleteExam,
    switchExam,
    goBack,
  } = session;

  const pageStep = displayMode === 'spread' && !compactPages ? 2 : 1;

  const handleSetDisplayMode = useCallback(
    (nextMode: 'spread' | 'workspace' | 'paper') => {
      setDisplayMode(nextMode);
      if (
        nextMode === 'paper' &&
        typeof window !== 'undefined' &&
        window.innerWidth < 1380
      ) {
        setSidebarCollapsed(true);
      }
      if (nextMode === 'spread' && !compactPages) {
        setPageIndex((prev) => Math.floor(prev / 2) * 2);
      }
    },
    [compactPages],
  );

  const displayModeRef = useRef(displayMode);
  displayModeRef.current = displayMode;
  useEffect(() => {
    const markExamPrint = () => {
      if (displayModeRef.current === 'paper') {
        document.documentElement.dataset.printExam = 'paper';
      }
    };
    const clearExamPrint = () => {
      delete document.documentElement.dataset.printExam;
    };
    window.addEventListener('beforeprint', markExamPrint);
    window.addEventListener('afterprint', clearExamPrint);
    return () => {
      window.removeEventListener('beforeprint', markExamPrint);
      window.removeEventListener('afterprint', clearExamPrint);
      delete document.documentElement.dataset.printExam;
    };
  }, []);

  const printPaper = () => {
    document.documentElement.dataset.printExam = 'paper';
    try {
      window.print();
    } catch {
      delete document.documentElement.dataset.printExam;
    }
  };

  const paper = useMemo(
    () =>
      exam
        ? composeExamPaper(exam.questions, {
            bookTitle: exam.bookTitle,
            scopeLabel: exam.scope?.label || exam.sourceSectionLabel,
          })
        : null,
    [exam],
  );

  const resetLeafScrolls = useCallback(() => {
    const reset = () => {
      stageRef.current
        ?.querySelectorAll<HTMLElement>('.epub-exam-leaf')
        .forEach((leaf) => {
          leaf.scrollTop = 0;
        });
    };
    reset();
    requestAnimationFrame(reset);
  }, []);

  const focusPaperQuestion = useCallback(
    (questionId: string) => {
      const index =
        exam?.questions.findIndex((item) => item.id === questionId) ?? -1;
      if (index < 0) return;
      setPaperFocusId(questionId);
      setPageIndex(pageStep === 2 ? Math.floor(index / 2) * 2 : index);
    },
    [exam?.questions, pageStep],
  );

  const orderedPaperIds = useMemo(
    () =>
      paper
        ? paper.sections.flatMap((sec) =>
            sec.items.map((item) => item.question.id),
          )
        : (exam?.questions.map((item) => item.id) ?? []),
    [exam?.questions, paper],
  );

  const scrollToQuestion = useCallback(
    (questionId: string) => {
      const index =
        exam?.questions.findIndex((item) => item.id === questionId) ?? -1;
      if (index < 0) return;
      focusPaperQuestion(questionId);
      if (displayMode === 'paper') {
        setScrollLockNonce((n) => n + 1);
        document.getElementById(`exam-question-${questionId}`)?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
        return;
      }
      resetLeafScrolls();
    },
    [displayMode, exam?.questions, focusPaperQuestion, resetLeafScrolls],
  );

  const jumpNextUnanswered = useCallback(() => {
    if (!exam) return;
    const orderedQuestions =
      displayMode === 'paper' && paper
        ? paper.sections.flatMap((sec) =>
            sec.items.map((item) => item.question),
          )
        : exam.questions;
    if (orderedQuestions.length === 0) return;
    const currentId =
      displayMode === 'paper'
        ? paperFocusId
        : (exam.questions[pageIndex]?.id ?? '');
    const startIdx = Math.max(
      0,
      orderedQuestions.findIndex((q) => q.id === currentId),
    );
    for (let offset = 1; offset <= orderedQuestions.length; offset += 1) {
      const candidate =
        orderedQuestions[(startIdx + offset) % orderedQuestions.length];
      if (!isAnswerFilled(answers[candidate.id])) {
        scrollToQuestion(candidate.id);
        return;
      }
    }
  }, [
    answers,
    displayMode,
    exam,
    pageIndex,
    paper,
    paperFocusId,
    scrollToQuestion,
  ]);

  // Keyboard shortcuts outside inputs: ArrowLeft / ArrowRight & 1-4 / A-D
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!exam || loading || busy) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;

      const questions = exam.questions;
      if (questions.length === 0) return;

      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        toggleZenMode();
        return;
      }

      if (
        displayMode === 'paper' &&
        (event.key === 'j' ||
          event.key === 'J' ||
          event.key === 'k' ||
          event.key === 'K')
      ) {
        if (orderedPaperIds.length === 0) return;
        event.preventDefault();
        const delta = event.key === 'j' || event.key === 'J' ? 1 : -1;
        const currentIdx = orderedPaperIds.indexOf(paperFocusId);
        const baseIdx = currentIdx === -1 ? 0 : currentIdx;
        const nextIdx = Math.max(
          0,
          Math.min(orderedPaperIds.length - 1, baseIdx + delta),
        );
        const nextId = orderedPaperIds[nextIdx];
        if (nextId) {
          focusPaperQuestion(nextId);
          setScrollLockNonce((n) => n + 1);
          document.getElementById(`exam-question-${nextId}`)?.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
          });
        }
        return;
      }

      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (displayMode === 'paper') return;
        event.preventDefault();
        const delta = event.key === 'ArrowRight' ? pageStep : -pageStep;
        setPageIndex((prev) =>
          Math.max(0, Math.min(questions.length - 1, prev + delta)),
        );
        resetLeafScrolls();
        return;
      }

      if (exam.status === 'submitted') return;

      let optionIdx = -1;
      if (['1', '2', '3', '4'].includes(event.key)) {
        optionIdx = Number(event.key) - 1;
      } else {
        const upper = event.key.toUpperCase();
        if (['A', 'B', 'C', 'D'].includes(upper)) {
          optionIdx = upper.charCodeAt(0) - 65;
        }
      }
      if (optionIdx < 0) return;

      const targetQuestion =
        displayMode === 'paper'
          ? questions.find((q) => q.id === paperFocusId)
          : questions[pageIndex];
      if (!targetQuestion) return;
      if (
        !['singleChoice', 'multipleChoice', 'trueFalse'].includes(
          targetQuestion.type,
        )
      ) {
        return;
      }
      const choices = choiceTexts(targetQuestion);
      const option = choices[optionIdx];
      if (!option) return;

      event.preventDefault();
      if (targetQuestion.type === 'multipleChoice') {
        const current = Array.isArray(answers[targetQuestion.id])
          ? (answers[targetQuestion.id] as string[])
          : [];
        editAnswer(
          targetQuestion.id,
          current.includes(option)
            ? current.filter((v) => v !== option)
            : [...current, option],
        );
      } else {
        editAnswer(targetQuestion.id, option);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    answers,
    busy,
    displayMode,
    editAnswer,
    exam,
    focusPaperQuestion,
    loading,
    orderedPaperIds,
    pageIndex,
    pageStep,
    paperFocusId,
    resetLeafScrolls,
    toggleZenMode,
  ]);

  const attemptsList = exam?.attempts ?? [];
  const attemptsCount = attemptsList.length;
  const questionsList = exam?.questions ?? [];
  const answeredCount = questionsList.filter((q) =>
    isAnswerFilled(answers[q.id]),
  ).length;
  const examSubmitted = exam?.status === 'submitted';

  return (
    <div
      className={`epub-exam-workspace-shell${displayMode === 'paper' ? ' is-paper-mode' : ''}${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}${analyticsCollapsed ? ' is-analytics-collapsed' : ''}`}
    >
      <ExamBookNavSidebar
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
        bookTitle={exam?.bookTitle || '当前书籍'}
        sortedBookExams={sortedBookExams}
        submittedCount={bookStats.submittedExams}
        activeExamId={activeExamId}
        activeExam={exam}
        selfReviews={selfReviews}
        busy={busy}
        onSwitchExam={(id) => void switchExam(id)}
      />

      <main className="epub-exam-stage" ref={stageRef}>
        {loading ? (
          <div className="epub-exam-page-loading">
            <div className="epub-exam-spinner" />
            <p role="status">正在加载试卷与自评数据…</p>
          </div>
        ) : !exam ? (
          <div className="epub-exam-page-error">
            <button
              type="button"
              className="epub-exam-back-btn"
              onClick={onBack}
            >
              ← 返回试卷列表
            </button>
            <p role="alert">{error || '找不到这份试卷。'}</p>
          </div>
        ) : (
          <div className="epub-exam-stage-inner">
            <header className="epub-exam-page-header is-office">
              <button
                type="button"
                className="epub-exam-back-btn"
                onClick={() => void goBack()}
                disabled={busy}
                title="保存并返回试卷列表"
              >
                ← 返回
              </button>

              <div className="epub-exam-header-main">
                <h1>{exam.sourceSectionLabel || '当前试卷'}</h1>
                <p className="epub-exam-office-line">
                  {examSubmitted ? '已交卷' : '未交卷'} · {questionsList.length}{' '}
                  题 · 已答 {answeredCount} · 第 {attemptsCount + 1} 次 ·{' '}
                  {getDifficultyLabel(exam.difficulty)}
                </p>
              </div>

              <div className="epub-exam-header-actions">
                {exam.status === 'submitted' && (
                  <button
                    type="button"
                    className="epub-exam-action-btn is-primary"
                    onClick={() => void restartExam()}
                    disabled={busy}
                  >
                    重新作答
                  </button>
                )}
                <button
                  type="button"
                  className="epub-exam-action-btn is-danger"
                  onClick={() => void deleteExam()}
                  disabled={busy}
                  title="删除本试卷"
                >
                  删除试卷
                </button>
              </div>
            </header>

            {error && (
              <p className="epub-exam-error-banner" role="alert">
                {error}
              </p>
            )}

            <div className="epub-exam-view-toolbar">
              <div
                className="epub-exam-view-modes"
                role="group"
                aria-label="试卷布局"
              >
                <button
                  type="button"
                  className={displayMode === 'paper' ? 'is-active' : ''}
                  onClick={() => handleSetDisplayMode('paper')}
                >
                  整卷
                </button>
                <button
                  type="button"
                  className={displayMode === 'spread' ? 'is-active' : ''}
                  onClick={() => handleSetDisplayMode('spread')}
                >
                  左右翻页
                </button>
                <button
                  type="button"
                  className={displayMode === 'workspace' ? 'is-active' : ''}
                  onClick={() => handleSetDisplayMode('workspace')}
                >
                  分栏
                </button>
              </div>
              {displayMode === 'paper' ? (
                <div className="epub-exam-paper-tools">
                  <button
                    type="button"
                    className={paperWideWidth ? 'is-active' : ''}
                    onClick={() => setPaperWideWidth((v) => !v)}
                    title="切换标准 (800px) / 宽幅 (1020px) 试卷宽度"
                  >
                    {paperWideWidth ? '宽幅纸面' : '标准纸宽'}
                  </button>
                  <button
                    type="button"
                    className={paperWhiteSurface ? 'is-active' : ''}
                    onClick={() => setPaperWhiteSurface((v) => !v)}
                    title="在深色主题下切换真实白纸底色"
                  >
                    仿真白纸
                  </button>
                  <button
                    type="button"
                    className={isZenMode ? 'is-active' : ''}
                    onClick={toggleZenMode}
                    title="专注做卷（快捷键 F，一键收起/恢复两侧栏）"
                  >
                    {isZenMode ? '退出专注' : '专注做卷'}
                  </button>
                  <button
                    type="button"
                    className="epub-exam-action-btn"
                    onClick={printPaper}
                  >
                    打印 / 导出 PDF
                  </button>
                </div>
              ) : (
                <div className="epub-exam-paper-tools">
                  <button
                    type="button"
                    className={isZenMode ? 'is-active' : ''}
                    onClick={toggleZenMode}
                    title="专注做卷（快捷键 F，一键收起/恢复两侧栏）"
                  >
                    {isZenMode ? '退出专注' : '专注做卷'}
                  </button>
                  <nav className="epub-exam-page-nav" aria-label="试卷翻页">
                    <button
                      type="button"
                      onClick={() => {
                        setPageIndex((index) => Math.max(0, index - pageStep));
                        resetLeafScrolls();
                      }}
                      disabled={pageIndex === 0}
                    >
                      上一页
                    </button>
                    <span>
                      {Math.min(pageIndex + 1, questionsList.length)}
                      {pageStep === 2 && pageIndex + 1 < questionsList.length
                        ? `–${pageIndex + 2}`
                        : ''}{' '}
                      / {questionsList.length}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setPageIndex((index) =>
                          Math.min(questionsList.length - 1, index + pageStep),
                        );
                        resetLeafScrolls();
                      }}
                      disabled={pageIndex + pageStep >= questionsList.length}
                    >
                      下一页
                    </button>
                  </nav>
                </div>
              )}
            </div>

            {examSubmitted && attemptsCount > 0 && (
              <details className="epub-exam-attempt-accordion">
                <summary>
                  <span>历史作答 ({attemptsCount} 次)</span>
                  <span className="epub-exam-accordion-arrow">▼</span>
                </summary>
                <div className="epub-exam-attempt-list">
                  {attemptsList.map((attempt: EpubExamAttempt, attIdx) => (
                    <section
                      className="epub-exam-attempt-card"
                      key={`${attempt.completedAt}-${attIdx}`}
                    >
                      <h3>
                        第 {attIdx + 1} 次 ·{' '}
                        {formatEpubExamDate(attempt.completedAt)}
                      </h3>
                      <ol>
                        {questionsList.map((question, qIdx) => (
                          <li key={question.id}>
                            <strong>
                              {qIdx + 1}. {question.prompt}
                            </strong>
                            <p>
                              我的答案：
                              {formatExamAnswer(
                                attempt?.answers?.[question.id],
                              )}
                            </p>
                            <p>
                              自评：
                              {formatSelfReview(
                                attempt?.selfReviews?.[question.id],
                              )}
                            </p>
                          </li>
                        ))}
                      </ol>
                    </section>
                  ))}
                </div>
              </details>
            )}

            {displayMode === 'paper' ? (
              <ExamPaperSheet
                exam={exam}
                paper={paper ?? undefined}
                answers={answers}
                submitted={examSubmitted}
                busy={busy}
                reviews={selfReviews}
                grades={grades}
                codeResults={codeResults}
                codeBusyId={codeBusyId}
                onAnswer={editAnswer}
                onReview={editReview}
                onRunCode={(id) => void runCode(id)}
                onOverride={(id, earned) => void overrideGrade(id, earned)}
                focusId={paperFocusId}
                onFocus={focusPaperQuestion}
                wideWidth={paperWideWidth}
                whiteSurface={paperWhiteSurface}
                scrollLockNonce={scrollLockNonce}
              />
            ) : (
              <div
                className={`epub-exam-book-spread is-${displayMode}${
                  displayMode === 'spread' &&
                  (pageStep === 2
                    ? [pageIndex, pageIndex + 1]
                    : [pageIndex]
                  ).filter((idx) => Boolean(questionsList[idx])).length === 1
                    ? ' is-single-leaf'
                    : ''
                }`}
              >
                {(pageStep === 2 ? [pageIndex, pageIndex + 1] : [pageIndex])
                  .filter((index) => Boolean(questionsList[index]))
                  .map((index) => {
                    const question = questionsList[index];
                    if (!question) return null;
                    return (
                      <EpubExamQuestion
                        key={question.id}
                        question={question}
                        index={index}
                        answer={answers[question.id]}
                        submitted={examSubmitted}
                        busy={busy}
                        review={selfReviews[question.id]}
                        grade={grades[question.id]}
                        codeResult={codeResults[question.id]}
                        codeBusy={codeBusyId === question.id}
                        showPrompt
                        showAnswer={displayMode === 'spread'}
                        onAnswer={(value) => editAnswer(question.id, value)}
                        onReview={(value) => editReview(question.id, value)}
                        onRunCode={() => void runCode(question.id)}
                        onOverride={(earned) =>
                          void overrideGrade(question.id, earned)
                        }
                      />
                    );
                  })}
                {displayMode === 'workspace' && questionsList[pageIndex] && (
                  <EpubExamQuestion
                    key={`work-${questionsList[pageIndex].id}`}
                    question={questionsList[pageIndex]}
                    index={pageIndex}
                    answer={answers[questionsList[pageIndex].id]}
                    submitted={examSubmitted}
                    busy={busy}
                    review={selfReviews[questionsList[pageIndex].id]}
                    grade={grades[questionsList[pageIndex].id]}
                    codeResult={codeResults[questionsList[pageIndex].id]}
                    codeBusy={codeBusyId === questionsList[pageIndex].id}
                    showPrompt={false}
                    showAnswer
                    onAnswer={(value) =>
                      editAnswer(questionsList[pageIndex].id, value)
                    }
                    onReview={(value) =>
                      editReview(questionsList[pageIndex].id, value)
                    }
                    onRunCode={() => void runCode(questionsList[pageIndex].id)}
                    onOverride={(earned) =>
                      void overrideGrade(questionsList[pageIndex].id, earned)
                    }
                  />
                )}
              </div>
            )}

            {examSubmitted &&
              questionsList.some(
                (question) =>
                  ['comprehensive', 'engineering', 'shortAnswer'].includes(
                    question.type,
                  ) && !grades[question.id],
              ) && (
                <button
                  type="button"
                  className="epub-exam-grade-retry"
                  onClick={() => void gradeSubjective()}
                  disabled={gradingBusy}
                >
                  {gradingBusy ? '正在 AI 评阅…' : '评阅待完成的主观题'}
                </button>
              )}

            <footer className="epub-exam-page-footer">
              <div className="epub-exam-save-status">
                <span className={`epub-exam-save-indicator is-${saveState}`} />
                <span>
                  {saveState === 'saving'
                    ? '正在自动保存草稿…'
                    : saveState === 'saved'
                      ? '已自动保存到本机'
                      : '本地自动同步'}
                </span>
              </div>

              {exam.status === 'inProgress' && (
                <button
                  type="button"
                  className="epub-exam-submit-btn is-primary"
                  onClick={() => void submitExam()}
                  disabled={busy}
                >
                  {busy
                    ? '正在提交…'
                    : attemptsCount > 0
                      ? `提交第 ${attemptsCount + 1} 次并查看 AI 答案`
                      : '提交并查看 AI 答案与解析'}
                </button>
              )}
            </footer>
          </div>
        )}
      </main>

      <ExamAnalyticsSidebar
        collapsed={analyticsCollapsed}
        onToggleCollapse={() => setAnalyticsCollapsed((v) => !v)}
        displayMode={displayMode}
        pageIndex={pageIndex}
        pageStep={pageStep}
        paperFocusId={paperFocusId}
        exam={exam}
        paper={paper}
        activeExamId={activeExamId}
        sortedBookExams={sortedBookExams}
        bookStats={bookStats}
        answers={answers}
        selfReviews={selfReviews}
        grades={grades}
        busy={busy}
        onScrollToQuestion={scrollToQuestion}
        onJumpNextUnanswered={jumpNextUnanswered}
        onSwitchExam={(id) => void switchExam(id)}
        onEditReview={editReview}
        onOverrideGrade={(id, earned) => void overrideGrade(id, earned)}
      />
    </div>
  );
}

export function EpubExamWorkspace(props: EpubExamWorkspaceProps) {
  return (
    <ExamErrorBoundary onBack={props.onBack}>
      <EpubExamWorkspaceInner {...props} />
    </ExamErrorBoundary>
  );
}
