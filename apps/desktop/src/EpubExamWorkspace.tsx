import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type {
  EpubExam,
  EpubExamAttempt,
  EpubExamAnswer,
  EpubExamSelfReview,
  EpubExamSummary,
} from './epub-exams';
import { formatEpubExamDate, listEpubExams } from './epub-exams';

export interface EpubExamWorkspaceProps {
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
                ← 返回试卷库
              </button>
              <h2
                style={{
                  fontSize: '1.1rem',
                  fontWeight: 600,
                  color: 'var(--text-main, #0f172a)',
                  margin: '16px 0 8px',
                }}
              >
                试卷加载发生异常
              </h2>
              <p
                role="alert"
                style={{
                  color: 'var(--text-muted, #64748b)',
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

export function normalizeExam(raw?: EpubExam | null): EpubExam | null {
  if (!raw) return null;
  return {
    ...raw,
    attempts: Array.isArray(raw.attempts) ? raw.attempts : [],
    questions: Array.isArray(raw.questions) ? raw.questions : [],
    answers: raw.answers && typeof raw.answers === 'object' ? raw.answers : {},
    selfReviews:
      raw.selfReviews && typeof raw.selfReviews === 'object'
        ? raw.selfReviews
        : {},
    sourceSectionLabel: raw.sourceSectionLabel || '',
    bookTitle: raw.bookTitle || '',
    questionCount:
      typeof raw.questionCount === 'number'
        ? raw.questionCount
        : (raw.questions?.length ?? 0),
    status: raw.status || 'inProgress',
  };
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

function getDifficultyLabel(difficulty?: string): string {
  if (difficulty === 'easy') return '简单';
  if (difficulty === 'hard') return '困难';
  return '中等';
}

function EpubExamWorkspaceInner({
  examId: initialExamId,
  bookKey,
  onBack,
  initialExam,
}: EpubExamWorkspaceProps) {
  const [activeExamId, setActiveExamId] = useState(initialExamId);
  const [exam, setExam] = useState<EpubExam | null>(() =>
    normalizeExam(initialExam),
  );
  const [bookExams, setBookExams] = useState<EpubExamSummary[]>([]);
  const [answers, setAnswers] = useState<Record<string, EpubExamAnswer>>(
    initialExam?.answers ?? {},
  );
  const [selfReviews, setSelfReviews] = useState<
    Record<string, EpubExamSelfReview>
  >(initialExam?.selfReviews ?? {});
  const [loading, setLoading] = useState(!initialExam);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>(
    'idle',
  );

  // Layout states
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [analyticsCollapsed, setAnalyticsCollapsed] = useState(false);
  const [sidebarFilter, setSidebarFilter] = useState('');

  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveTimerRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const revisionRef = useRef(0);

  // Fetch all exams for this book to populate sequential sidebar and analytics
  const refreshBookExams = useCallback(async () => {
    try {
      const items = await listEpubExams(bookKey);
      setBookExams(items);
    } catch {
      // ignore non-critical list error
    }
  }, [bookKey]);

  useEffect(() => {
    void refreshBookExams();
  }, [refreshBookExams]);

  // Load active exam
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void invoke<EpubExam>('get_epub_exam', { bookKey, examId: activeExamId })
      .then((loaded) => {
        if (!active) return;
        const normalized = normalizeExam(loaded);
        setExam(normalized);
        setAnswers(normalized?.answers ?? {});
        setSelfReviews(normalized?.selfReviews ?? {});
        dirtyRef.current = false;
        revisionRef.current = 0;
      })
      .catch((cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [bookKey, activeExamId]);

  // Enqueue auto save
  const enqueueSave = useCallback(
    (
      nextAnswers: Record<string, EpubExamAnswer>,
      nextReviews: Record<string, EpubExamSelfReview>,
      submitted: boolean,
    ) => {
      const operation = saveQueueRef.current
        .catch(() => undefined)
        .then(() =>
          invoke<EpubExam>('save_epub_exam_progress', {
            bookKey,
            examId: activeExamId,
            answers: nextAnswers,
            selfReviews: nextReviews,
            submitted,
          }).then(() => undefined),
        );
      saveQueueRef.current = operation;
      return operation;
    },
    [bookKey, activeExamId],
  );

  // Debounced auto-save effect
  useEffect(() => {
    if (!exam || loading || !dirtyRef.current) return;
    const revision = revisionRef.current;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      setSaveState('saving');
      void enqueueSave(answers, selfReviews, exam.status === 'submitted')
        .then(() => {
          if (revisionRef.current === revision) dirtyRef.current = false;
          setSaveState('saved');
          setError('');
          void refreshBookExams();
        })
        .catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause));
          setSaveState('idle');
        });
    }, 500);
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [answers, enqueueSave, exam, loading, refreshBookExams, selfReviews]);

  // Edit answer
  const editAnswer = (questionId: string, value: EpubExamAnswer) => {
    if (exam?.status === 'submitted' || busy) return;
    dirtyRef.current = true;
    revisionRef.current += 1;
    setSaveState('idle');
    setAnswers((current) => ({ ...current, [questionId]: value }));
  };

  // Edit review with immediate auto-save
  const editReview = (questionId: string, value: EpubExamSelfReview) => {
    if (busy) return;
    dirtyRef.current = true;
    revisionRef.current += 1;
    setSaveState('idle');
    setSelfReviews((current) => ({ ...current, [questionId]: value }));
  };

  // Submit exam
  const submitExam = async () => {
    if (!exam || exam.status === 'submitted' || busy) return;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setBusy(true);
    setError('');
    revisionRef.current += 1;
    dirtyRef.current = true;
    try {
      await enqueueSave(answers, selfReviews, true);
      dirtyRef.current = false;
      setSaveState('saved');
      setExam((prev) =>
        prev
          ? normalizeExam({
              ...prev,
              status: 'submitted',
              submittedAt: Date.now(),
            })
          : null,
      );
      void refreshBookExams();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  // Restart exam
  const restartExam = async () => {
    if (!exam || exam.status !== 'submitted' || busy) return;
    const nextAttempt = (exam.attempts?.length ?? 0) + 1;
    const accepted = window.confirm(
      `开始第 ${nextAttempt} 次作答？本轮答案会清空，上次答案和自评会保存在历史记录中。`,
    );
    if (!accepted) return;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setBusy(true);
    setError('');
    try {
      await saveQueueRef.current.catch(() => undefined);
      if (dirtyRef.current) {
        await enqueueSave(answers, selfReviews, true);
        dirtyRef.current = false;
      }
      const restarted = await invoke<EpubExam>('restart_epub_exam', {
        bookKey,
        examId: activeExamId,
      });
      const normalized = normalizeExam(restarted);
      revisionRef.current += 1;
      dirtyRef.current = false;
      setExam(normalized);
      setAnswers(normalized?.answers ?? {});
      setSelfReviews(normalized?.selfReviews ?? {});
      setSaveState('saved');
      void refreshBookExams();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaveState('idle');
    } finally {
      setBusy(false);
    }
  };

  // Delete exam
  const deleteExam = async () => {
    if (!exam || busy) return;
    const accepted = window.confirm(
      '删除这份试卷及其作答和自评？此操作无法撤销。',
    );
    if (!accepted) return;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setBusy(true);
    setError('');
    try {
      await saveQueueRef.current.catch(() => undefined);
      await invoke('delete_epub_exam', { bookKey, examId: activeExamId });
      // If there are other exams in the same book, switch to the first available, otherwise go back
      const remaining = bookExams.filter((item) => item.id !== activeExamId);
      if (remaining.length > 0) {
        setBookExams(remaining);
        setActiveExamId(remaining[0].id);
      } else {
        onBack();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  // Safe exam switching with draft flush
  const handleSwitchExam = async (targetExamId: string) => {
    if (targetExamId === activeExamId || busy) return;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (exam && dirtyRef.current) {
      setSaveState('saving');
      try {
        await enqueueSave(answers, selfReviews, exam.status === 'submitted');
        dirtyRef.current = false;
        setSaveState('saved');
      } catch {
        // preserve flow
      }
    }
    setActiveExamId(targetExamId);
  };

  // Return to exam library with draft flush
  const goBack = async () => {
    if (busy) return;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setBusy(true);
    setError('');
    try {
      await saveQueueRef.current.catch(() => undefined);
      if (exam && dirtyRef.current) {
        await enqueueSave(answers, selfReviews, exam.status === 'submitted');
        dirtyRef.current = false;
      }
      onBack();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  // Scroll to question helper
  const scrollToQuestion = (questionId: string) => {
    const el = document.getElementById(`exam-question-${questionId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('is-target-highlight');
      window.setTimeout(() => {
        el.classList.remove('is-target-highlight');
      }, 1400);
    }
  };

  // Sort exams by chapter sequential order
  const sortedBookExams = useMemo(() => {
    return [...bookExams].sort((a, b) => {
      const idxA = a.sourceSectionIndex ?? 999999;
      const idxB = b.sourceSectionIndex ?? 999999;
      if (idxA !== idxB) return idxA - idxB;
      return a.createdAt - b.createdAt;
    });
  }, [bookExams]);

  // Filtered sidebar exams
  const filteredBookExams = useMemo(() => {
    const q = sidebarFilter.trim().toLowerCase();
    if (!q) return sortedBookExams;
    return sortedBookExams.filter(
      (item) =>
        (item.sourceSectionLabel || '').toLowerCase().includes(q) ||
        (item.difficulty && getDifficultyLabel(item.difficulty).includes(q)) ||
        (item.status === 'submitted' ? '已交卷' : '未交卷').includes(q),
    );
  }, [sidebarFilter, sortedBookExams]);

  // Overall book stats
  const bookStats = useMemo(() => {
    let totalQuestions = 0;
    let answeredQuestions = 0;
    let totalMastered = 0;
    let totalPartial = 0;
    let totalReview = 0;
    let submittedExams = 0;

    for (const item of sortedBookExams) {
      const itemQCount = item.questionCount ?? 0;
      totalQuestions += itemQCount;
      if (item.status === 'submitted') {
        submittedExams += 1;
        // If it's the currently active loaded exam, use current state for real-time reactivity
        if (item.id === activeExamId && exam) {
          const revs = Object.values(selfReviews);
          const mastered = revs.filter((r) => r === 'mastered').length;
          const partial = revs.filter((r) => r === 'partial').length;
          const review = revs.filter((r) => r === 'review').length;
          totalMastered += mastered;
          totalPartial += partial;
          totalReview += review;
          answeredQuestions += itemQCount;
        } else {
          totalMastered += item.masteredCount ?? 0;
          totalPartial += item.partialCount ?? 0;
          totalReview += item.reviewCount ?? 0;
          answeredQuestions += itemQCount;
        }
      } else if (item.id === activeExamId && exam) {
        // Count in-progress answers for current exam
        const ansCount = Object.values(answers).filter(
          (a) =>
            a !== undefined && a !== '' && (!Array.isArray(a) || a.length > 0),
        ).length;
        answeredQuestions += ansCount;
      }
    }

    const reviewedQuestions = totalMastered + totalPartial + totalReview;
    const masteryRate =
      reviewedQuestions > 0
        ? Math.round((totalMastered / reviewedQuestions) * 100)
        : 0;

    return {
      totalExams: sortedBookExams.length,
      submittedExams,
      totalQuestions,
      answeredQuestions,
      totalMastered,
      totalPartial,
      totalReview,
      reviewedQuestions,
      masteryRate,
    };
  }, [activeExamId, answers, exam, selfReviews, sortedBookExams]);

  // Current exam weak points (marked for review)
  const weakQuestions = useMemo(() => {
    if (!exam || exam.status !== 'submitted') return [];
    const questions = exam.questions ?? [];
    return questions.filter((q) => selfReviews[q.id] === 'review');
  }, [exam, selfReviews]);

  const attemptsList = exam?.attempts ?? [];
  const attemptsCount = attemptsList.length;
  const questionsList = exam?.questions ?? [];

  return (
    <div
      className={`epub-exam-workspace-shell${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}${analyticsCollapsed ? ' is-analytics-collapsed' : ''}`}
    >
      {/* LEFT SIDEBAR: Sequential Book Exams */}
      <aside
        className={`epub-exam-sidebar${sidebarCollapsed ? ' is-collapsed' : ''}`}
        aria-label="同书顺序试卷导航"
      >
        <div className="epub-exam-sidebar-header">
          <div className="epub-exam-sidebar-book-meta">
            <span className="epub-exam-sidebar-kicker">BOOK EXAMS</span>
            <h2 title={exam?.bookTitle || '当前书籍'}>
              {exam?.bookTitle || '书籍试卷流'}
            </h2>
            <div className="epub-exam-sidebar-stats">
              <span>共 {sortedBookExams.length} 套试卷</span>
              <span>·</span>
              <span>已交 {bookStats.submittedExams} 套</span>
            </div>
          </div>
          <button
            type="button"
            className="epub-exam-sidebar-collapse-btn"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? '展开试卷侧栏' : '收起试卷侧栏'}
            aria-label={sidebarCollapsed ? '展开试卷侧栏' : '收起试卷侧栏'}
          >
            {sidebarCollapsed ? '▶' : '◀'}
          </button>
        </div>

        {!sidebarCollapsed && (
          <>
            <div className="epub-exam-sidebar-search">
              <input
                type="text"
                placeholder="搜索章节或考点…"
                value={sidebarFilter}
                onChange={(e) => setSidebarFilter(e.target.value)}
              />
              {sidebarFilter && (
                <button
                  type="button"
                  className="epub-exam-filter-clear"
                  onClick={() => setSidebarFilter('')}
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
                  // Calculate badge
                  let statusBadge = (
                    <span className="epub-exam-pill is-pending">未交卷</span>
                  );
                  if (isSubmitted) {
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
                    if (review > 0) {
                      statusBadge = (
                        <span className="epub-exam-pill is-review">需复习</span>
                      );
                    } else if (mastered >= (item.questionCount ?? 0) * 0.7) {
                      statusBadge = (
                        <span className="epub-exam-pill is-mastered">
                          已掌握
                        </span>
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
                      onClick={() => void handleSwitchExam(item.id)}
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

      {/* CENTER STAGE: Exam Questions & Answering */}
      <main className="epub-exam-stage">
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
              ← 返回试卷库
            </button>
            <p role="alert">{error || '找不到这份试卷。'}</p>
          </div>
        ) : (
          <div className="epub-exam-stage-inner">
            <header className="epub-exam-page-header">
              <button
                type="button"
                className="epub-exam-back-btn"
                onClick={() => void goBack()}
                disabled={busy}
                title="保存并返回试卷库"
              >
                ← 返回试卷库
              </button>

              <div className="epub-exam-header-main">
                <div className="epub-exam-header-kicker-row">
                  <span className="epub-exam-kicker">
                    LOCAL EXAM · {exam.questionCount ?? questionsList.length}{' '}
                    QUESTIONS
                  </span>
                  <span className={`epub-exam-status-tag is-${exam.status}`}>
                    {exam.status === 'submitted' ? '已交卷' : '未交卷'}
                  </span>
                </div>
                <h1>{exam.sourceSectionLabel || '当前章节试卷'}</h1>
                <p className="epub-exam-header-meta">
                  {exam.bookTitle || '试卷'} ·{' '}
                  {formatEpubExamDate(exam.createdAt)} ·{' '}
                  {getDifficultyLabel(exam.difficulty)}难度 · 第{' '}
                  {attemptsCount + 1} 次作答
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

            <div className="epub-exam-note-banner">
              <span className="epub-exam-note-icon">ℹ</span>
              <span>
                {exam.status === 'submitted'
                  ? 'AI 答案和深度解析已显示；请针对各题自评掌握度，系统将实时更新右侧热力看板。'
                  : attemptsCount > 0
                    ? `第 ${attemptsCount + 1} 次作答中；提交前 AI 答案隐藏，作答将实时自动保存到本机。`
                    : '提交前 AI 答案保持隐藏；作答过程自动静默保存在本机。'}
              </span>
            </div>

            {/* Attempt history accordion */}
            {attemptsCount > 0 && (
              <details className="epub-exam-attempt-accordion">
                <summary>
                  <span>查看历史作答记录 ({attemptsCount} 次)</span>
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

            {/* Questions list */}
            <div className="epub-exam-questions-list">
              {questionsList.map((question, index) => {
                const answer = answers[question.id];
                const selected = Array.isArray(answer) ? answer : [];
                const options =
                  question.type === 'trueFalse'
                    ? (question.options ?? ['正确', '错误'])
                    : (question.options ?? []);
                const submitted = exam.status === 'submitted';
                const currentReview = selfReviews[question.id];

                return (
                  <article
                    className="epub-exam-question-card"
                    id={`exam-question-${question.id}`}
                    key={question.id}
                  >
                    <header className="epub-exam-question-card-header">
                      <div className="epub-exam-question-num-row">
                        <span className="epub-exam-question-num">
                          第 {index + 1} 题
                        </span>
                        <span className="epub-exam-question-type">
                          {question.type === 'shortAnswer'
                            ? '简答题'
                            : question.type === 'multipleChoice'
                              ? '多选题'
                              : question.type === 'trueFalse'
                                ? '判断题'
                                : '单选题'}
                        </span>
                      </div>

                      {submitted && (
                        <div className="epub-exam-review-segmented">
                          <span className="epub-exam-review-label">自评:</span>
                          <button
                            type="button"
                            className={`epub-exam-seg-btn is-mastered${currentReview === 'mastered' ? ' is-active' : ''}`}
                            onClick={() => editReview(question.id, 'mastered')}
                            disabled={busy}
                            title="掌握：理解透彻且能举一反三"
                          >
                            ✓ 掌握
                          </button>
                          <button
                            type="button"
                            className={`epub-exam-seg-btn is-partial${currentReview === 'partial' ? ' is-active' : ''}`}
                            onClick={() => editReview(question.id, 'partial')}
                            disabled={busy}
                            title="部分掌握：概念大致了解但细节易错"
                          >
                            ◐ 部分
                          </button>
                          <button
                            type="button"
                            className={`epub-exam-seg-btn is-review${currentReview === 'review' ? ' is-active' : ''}`}
                            onClick={() => editReview(question.id, 'review')}
                            disabled={busy}
                            title="需复习：存在遗漏或理解有误"
                          >
                            ✗ 需复习
                          </button>
                        </div>
                      )}
                    </header>

                    <h2 className="epub-exam-question-prompt">
                      {question.prompt}
                    </h2>

                    {question.type === 'shortAnswer' ? (
                      <div className="epub-exam-textarea-wrap">
                        <textarea
                          value={typeof answer === 'string' ? answer : ''}
                          onChange={(e) =>
                            editAnswer(question.id, e.target.value)
                          }
                          placeholder="在此写下你的作答思路或核心代码…"
                          disabled={submitted || busy}
                          rows={4}
                        />
                      </div>
                    ) : (
                      <div className="epub-exam-options-grid">
                        {options.map((option) => {
                          const checked =
                            question.type === 'multipleChoice'
                              ? selected.includes(option)
                              : answer === option;

                          return (
                            <label
                              className={`epub-exam-option-item${checked ? ' is-selected' : ''}`}
                              key={option}
                            >
                              <input
                                type={
                                  question.type === 'multipleChoice'
                                    ? 'checkbox'
                                    : 'radio'
                                }
                                name={`exam-${exam.id}-${question.id}`}
                                value={option}
                                checked={checked}
                                disabled={submitted || busy}
                                onChange={() => {
                                  if (question.type === 'multipleChoice') {
                                    const next = checked
                                      ? selected.filter((v) => v !== option)
                                      : [...selected, option];
                                    editAnswer(question.id, next);
                                  } else {
                                    editAnswer(question.id, option);
                                  }
                                }}
                              />
                              <span className="epub-exam-option-text">
                                {option}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}

                    {submitted && (
                      <div className="epub-exam-ai-solution">
                        <div className="epub-exam-ai-ref-header">
                          <span className="epub-exam-ai-badge">
                            AI 参考答案
                          </span>
                          <span className="epub-exam-ai-answer-val">
                            {Array.isArray(question.answer)
                              ? question.answer.join('、')
                              : question.answer}
                          </span>
                        </div>
                        <div className="epub-exam-ai-explanation">
                          <strong>深度解析</strong>
                          <p>{question.explanation}</p>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>

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

      {/* RIGHT SIDEBAR: Analytics & Heatmap Dashboard */}
      <aside
        className={`epub-exam-analytics${analyticsCollapsed ? ' is-collapsed' : ''}`}
        aria-label="学情热力图与总结看板"
      >
        <div className="epub-exam-analytics-header">
          <div className="epub-exam-analytics-title">
            <span className="epub-exam-sidebar-kicker">ANALYTICS</span>
            <h2>学情分析看板</h2>
          </div>
          <button
            type="button"
            className="epub-exam-sidebar-collapse-btn"
            onClick={() => setAnalyticsCollapsed(!analyticsCollapsed)}
            title={analyticsCollapsed ? '展开学情看板' : '收起学情看板'}
            aria-label={analyticsCollapsed ? '展开学情看板' : '收起学情看板'}
          >
            {analyticsCollapsed ? '◀' : '▶'}
          </button>
        </div>

        {!analyticsCollapsed && (
          <div className="epub-exam-analytics-body">
            {/* MODULE 1: Current Exam Question Matrix Heatmap */}
            <section className="epub-exam-analytics-card">
              <div className="epub-exam-card-title-row">
                <h3>答题卡热力矩阵</h3>
                <span className="epub-exam-card-badge">
                  {questionsList.length} 题
                </span>
              </div>
              <p className="epub-exam-card-hint">点击题号快速跳转到对应题目</p>

              <div className="epub-exam-heatmap-grid">
                {questionsList.map((q, idx) => {
                  const submitted = exam?.status === 'submitted';
                  const hasAns =
                    answers[q.id] !== undefined &&
                    answers[q.id] !== '' &&
                    (!Array.isArray(answers[q.id]) ||
                      (answers[q.id] as string[]).length > 0);
                  const rev = selfReviews[q.id];

                  let stateClass = 'is-unanswered';
                  let icon = `${idx + 1}`;
                  let statusTitle = `第 ${idx + 1} 题: 待作答`;

                  if (submitted) {
                    if (rev === 'mastered') {
                      stateClass = 'is-mastered';
                      icon = '✓';
                      statusTitle = `第 ${idx + 1} 题: 已掌握`;
                    } else if (rev === 'partial') {
                      stateClass = 'is-partial';
                      icon = '◐';
                      statusTitle = `第 ${idx + 1} 题: 部分掌握`;
                    } else if (rev === 'review') {
                      stateClass = 'is-review';
                      icon = '✗';
                      statusTitle = `第 ${idx + 1} 题: 需复习`;
                    } else {
                      stateClass = 'is-pending-review';
                      icon = '?';
                      statusTitle = `第 ${idx + 1} 题: 已交卷待自评`;
                    }
                  } else if (hasAns) {
                    stateClass = 'is-answered';
                    statusTitle = `第 ${idx + 1} 题: 已作答`;
                  }

                  return (
                    <button
                      key={q.id}
                      type="button"
                      className={`epub-exam-heatmap-cell ${stateClass}`}
                      onClick={() => scrollToQuestion(q.id)}
                      title={statusTitle}
                    >
                      <span className="epub-exam-cell-index">{idx + 1}</span>
                      {submitted && (
                        <span className="epub-exam-cell-icon">{icon}</span>
                      )}
                    </button>
                  );
                })}
              </div>

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

            {/* MODULE 2: Sequential Chapter Mastery Heatmap */}
            <section className="epub-exam-analytics-card">
              <div className="epub-exam-card-title-row">
                <h3>全书章节考点掌握度</h3>
                <span className="epub-exam-card-badge">
                  {sortedBookExams.length} 套
                </span>
              </div>
              <p className="epub-exam-card-hint">
                色块反映各章节掌握度，点击可即时切换
              </p>

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
                      ? Object.values(selfReviews).filter((r) => r === 'review')
                          .length
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
                      onClick={() => void handleSwitchExam(item.id)}
                      title={`[第${idx + 1}套] ${item.sourceSectionLabel || ''}\n${isSubmitted ? `已掌握: ${mastered}/${itemQCount}` : '未交卷'}`}
                    >
                      <span>{idx + 1}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* MODULE 3: KPI Metrics & Breakdown Bar */}
            <section className="epub-exam-analytics-card">
              <div className="epub-exam-card-title-row">
                <h3>学情指标</h3>
              </div>

              <div className="epub-exam-kpi-grid">
                <div className="epub-exam-kpi-box">
                  <span className="epub-exam-kpi-val">
                    {bookStats.masteryRate}%
                  </span>
                  <span className="epub-exam-kpi-label">综合掌握率</span>
                </div>
                <div className="epub-exam-kpi-box">
                  <span className="epub-exam-kpi-val">
                    {bookStats.answeredQuestions}
                    <small>/{bookStats.totalQuestions}</small>
                  </span>
                  <span className="epub-exam-kpi-label">已练题目</span>
                </div>
                <div className="epub-exam-kpi-box">
                  <span className="epub-exam-kpi-val is-danger">
                    {bookStats.totalReview}
                  </span>
                  <span className="epub-exam-kpi-label">待强化错题</span>
                </div>
              </div>

              {/* Segmented bar */}
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

            {/* MODULE 4: Focus Weak Points */}
            <section className="epub-exam-analytics-card">
              <div className="epub-exam-card-title-row">
                <h3>薄弱考点聚焦</h3>
                {weakQuestions.length > 0 && (
                  <span className="epub-exam-card-badge is-alert">
                    {weakQuestions.length} 项
                  </span>
                )}
              </div>

              {weakQuestions.length === 0 ? (
                <div className="epub-exam-empty-focus">
                  <span className="epub-exam-check-icon">✓</span>
                  <p>
                    {exam?.status === 'submitted'
                      ? '当前试卷未标记任何薄弱题，知识点掌握扎实！'
                      : '提交并自评后，标记为“需复习”的考点将自动汇集在此。'}
                  </p>
                </div>
              ) : (
                <div className="epub-exam-focus-list">
                  {weakQuestions.map((q) => {
                    const qIndex = questionsList.findIndex(
                      (item) => item.id === q.id,
                    );
                    const displayNum = qIndex >= 0 ? qIndex + 1 : 1;
                    return (
                      <button
                        key={q.id}
                        type="button"
                        className="epub-exam-focus-item"
                        onClick={() => scrollToQuestion(q.id)}
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
          </div>
        )}
      </aside>
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
