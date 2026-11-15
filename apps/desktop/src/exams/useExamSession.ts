import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { epubApi } from '../ebook/epub-api';
import type {
  EpubExam,
  EpubExamAnswer,
  EpubExamGrade,
  EpubExamSelfReview,
  EpubExamSummary,
} from './epub-exams';
import { listEpubExams } from './epub-exams';
import type { ExamCodeResult } from './EpubExamQuestion';

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
    grades: raw.grades && typeof raw.grades === 'object' ? raw.grades : {},
    sourceSectionLabel: raw.sourceSectionLabel || '',
    bookTitle: raw.bookTitle || '',
    questionCount:
      typeof raw.questionCount === 'number'
        ? raw.questionCount
        : (raw.questions?.length ?? 0),
    status: raw.status || 'inProgress',
  };
}

export function isAnswerFilled(value: EpubExamAnswer | undefined): boolean {
  return (
    value !== undefined &&
    value !== '' &&
    (!Array.isArray(value) || value.length > 0)
  );
}

export function getDifficultyLabel(difficulty?: string): string {
  if (difficulty === 'easy') return '简单';
  if (difficulty === 'hard') return '困难';
  return '中等';
}

export interface BookExamStats {
  totalExams: number;
  submittedExams: number;
  totalQuestions: number;
  answeredQuestions: number;
  totalMastered: number;
  totalPartial: number;
  totalReview: number;
  reviewedQuestions: number;
  masteryRate: number;
}

interface UseExamSessionOptions {
  provider?: { baseUrl: string; model: string };
  examId: string;
  bookKey: string;
  initialExam?: EpubExam;
  onBack: () => void;
  onExamReset?: (nextExam: EpubExam | null) => void;
}

export function useExamSession({
  provider,
  examId: initialExamId,
  bookKey,
  initialExam,
  onBack,
  onExamReset,
}: UseExamSessionOptions) {
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
  const [grades, setGrades] = useState<Record<string, EpubExamGrade>>(
    initialExam?.grades ?? {},
  );
  const [codeResults, setCodeResults] = useState<
    Record<string, ExamCodeResult>
  >({});
  const [codeBusyId, setCodeBusyId] = useState('');
  const [gradingBusy, setGradingBusy] = useState(false);
  const [loading, setLoading] = useState(!initialExam);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>(
    'idle',
  );

  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveTimerRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const revisionRef = useRef(0);
  const onExamResetRef = useRef(onExamReset);
  onExamResetRef.current = onExamReset;

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

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void epubApi
      .getExam({ bookKey, examId: activeExamId })
      .then((loaded) => {
        if (!active) return;
        const normalized = normalizeExam(loaded);
        setExam(normalized);
        setAnswers(normalized?.answers ?? {});
        setSelfReviews(normalized?.selfReviews ?? {});
        setGrades(normalized?.grades ?? {});
        setCodeResults({});
        dirtyRef.current = false;
        revisionRef.current = 0;
        onExamResetRef.current?.(normalized);
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

  const enqueueSave = useCallback(
    (
      nextAnswers: Record<string, EpubExamAnswer>,
      nextReviews: Record<string, EpubExamSelfReview>,
      submitted: boolean,
    ) => {
      const operation = saveQueueRef.current
        .catch(() => undefined)
        .then(() =>
          epubApi.saveExamProgress({
            bookKey,
            examId: activeExamId,
            answers: nextAnswers,
            selfReviews: nextReviews,
            submitted,
          }),
        );
      saveQueueRef.current = operation.then(() => undefined);
      return operation;
    },
    [bookKey, activeExamId],
  );

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

  const editAnswer = useCallback(
    (questionId: string, value: EpubExamAnswer) => {
      if (exam?.status === 'submitted' || busy) return;
      dirtyRef.current = true;
      revisionRef.current += 1;
      setSaveState('idle');
      setAnswers((current) => ({ ...current, [questionId]: value }));
    },
    [busy, exam?.status],
  );

  const editReview = useCallback(
    (questionId: string, value: EpubExamSelfReview) => {
      if (busy) return;
      dirtyRef.current = true;
      revisionRef.current += 1;
      setSaveState('idle');
      setSelfReviews((current) => ({ ...current, [questionId]: value }));
    },
    [busy],
  );

  const runCode = useCallback(
    async (questionId: string, submittedOverride?: boolean) => {
      if (!exam || codeBusyId) return;
      const question = exam.questions.find((item) => item.id === questionId);
      if (!question || question.type !== 'cProgramming') return;
      const source =
        typeof answers[questionId] === 'string'
          ? (answers[questionId] as string)
          : submittedOverride
            ? ''
            : (question.codeSpec?.starterCode ?? '');
      setCodeBusyId(questionId);
      try {
        const result = await epubApi.runExamCode({
          bookKey,
          examId: activeExamId,
          questionId,
          source,
        });
        setCodeResults((current) => ({ ...current, [questionId]: result }));
        if (submittedOverride || exam.status === 'submitted') {
          setGrades((current) => ({ ...current, [questionId]: result.grade }));
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setCodeBusyId('');
      }
    },
    [activeExamId, answers, bookKey, codeBusyId, exam],
  );

  const gradeSubjective = useCallback(async () => {
    if (!exam || !provider?.model || !provider.baseUrl) {
      setError('请先在模型设置中配置 AI 服务，再评阅主观题。');
      return;
    }
    setGradingBusy(true);
    try {
      const result = await epubApi.gradeSubjective({
        bookKey,
        examId: activeExamId,
        baseUrl: provider.baseUrl,
        model: provider.model,
      });
      setGrades((current) => ({ ...current, ...result }));
      setError('');
    } catch (cause) {
      setError(
        `AI 评阅暂未完成：${cause instanceof Error ? cause.message : String(cause)}。已交卷答案保存在本机，可重试。`,
      );
    } finally {
      setGradingBusy(false);
    }
  }, [activeExamId, bookKey, exam, provider]);

  const overrideGrade = useCallback(
    async (questionId: string, earned: number) => {
      if (!Number.isFinite(earned)) return;
      try {
        const grade = await epubApi.overrideGrade({
          bookKey,
          examId: activeExamId,
          questionId,
          earned,
        });
        setGrades((current) => ({ ...current, [questionId]: grade }));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [activeExamId, bookKey],
  );

  const submitExam = useCallback(async () => {
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
      const submittedExam = await enqueueSave(answers, selfReviews, true);
      dirtyRef.current = false;
      setSaveState('saved');
      setExam(normalizeExam(submittedExam));
      setGrades(submittedExam.grades ?? {});
      void refreshBookExams();
      for (const question of exam.questions) {
        if (
          question.type === 'cProgramming' &&
          typeof answers[question.id] === 'string'
        ) {
          await runCode(question.id, true);
        }
      }
      await gradeSubjective();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [
    answers,
    busy,
    enqueueSave,
    exam,
    gradeSubjective,
    refreshBookExams,
    runCode,
    selfReviews,
  ]);

  const restartExam = useCallback(async () => {
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
      const restarted = await epubApi.restartExam({
        bookKey,
        examId: activeExamId,
      });
      const normalized = normalizeExam(restarted);
      revisionRef.current += 1;
      dirtyRef.current = false;
      setExam(normalized);
      setAnswers(normalized?.answers ?? {});
      setSelfReviews(normalized?.selfReviews ?? {});
      setGrades(normalized?.grades ?? {});
      setCodeResults({});
      setSaveState('saved');
      onExamResetRef.current?.(normalized);
      void refreshBookExams();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaveState('idle');
    } finally {
      setBusy(false);
    }
  }, [
    activeExamId,
    answers,
    bookKey,
    busy,
    enqueueSave,
    exam,
    refreshBookExams,
    selfReviews,
  ]);

  const deleteExam = useCallback(async () => {
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
      await epubApi.deleteExam({ bookKey, examId: activeExamId });
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
  }, [activeExamId, bookExams, bookKey, busy, exam, onBack]);

  const switchExam = useCallback(
    async (targetExamId: string) => {
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
    },
    [activeExamId, answers, busy, enqueueSave, exam, selfReviews],
  );

  const goBack = useCallback(async () => {
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
  }, [answers, busy, enqueueSave, exam, onBack, selfReviews]);

  const sortedBookExams = useMemo(() => {
    return [...bookExams].sort((a, b) => {
      const idxA = a.sourceSectionIndex ?? 999999;
      const idxB = b.sourceSectionIndex ?? 999999;
      if (idxA !== idxB) return idxA - idxB;
      return a.createdAt - b.createdAt;
    });
  }, [bookExams]);

  const bookStats = useMemo<BookExamStats>(() => {
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
        if (item.id === activeExamId && exam) {
          const revs = Object.values(selfReviews);
          totalMastered += revs.filter((r) => r === 'mastered').length;
          totalPartial += revs.filter((r) => r === 'partial').length;
          totalReview += revs.filter((r) => r === 'review').length;
          answeredQuestions += itemQCount;
        } else {
          totalMastered += item.masteredCount ?? 0;
          totalPartial += item.partialCount ?? 0;
          totalReview += item.reviewCount ?? 0;
          answeredQuestions += itemQCount;
        }
      } else if (item.id === activeExamId && exam) {
        answeredQuestions += Object.values(answers).filter((a) =>
          isAnswerFilled(a),
        ).length;
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

  return {
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
  };
}
