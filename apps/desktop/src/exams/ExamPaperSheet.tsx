import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  EpubExam,
  EpubExamAnswer,
  EpubExamGrade,
  EpubExamQuestionType,
  EpubExamSelfReview,
} from './epub-exams';
import {
  choiceTexts,
  composeExamPaper,
  type ExamPaper,
  type ExamPaperItem,
} from './exam-paper';
import EpubExamQuestion, {
  type ExamCodeResult,
  isOptionExpected,
} from './EpubExamQuestion';
import { isAnswerFilled } from './useExamSession';

type PaperFilterMode = 'all' | 'unanswered' | 'flagged';

const SHORT_SECTION_LABEL: Record<EpubExamQuestionType, string> = {
  singleChoice: '单选',
  multipleChoice: '多选',
  trueFalse: '判断',
  shortAnswer: '简答',
  comprehensive: '综合',
  engineering: '工程',
  cProgramming: '编程',
};

function isObjectiveWrong(
  item: ExamPaperItem,
  answer: EpubExamAnswer | undefined,
): boolean {
  const { question, choiceKeys } = item;
  if (
    question.type !== 'singleChoice' &&
    question.type !== 'multipleChoice' &&
    question.type !== 'trueFalse'
  ) {
    return false;
  }
  const options = choiceTexts(question);
  if (options.length === 0) return false;
  const expectedSet = new Set(
    options.filter((opt, idx) =>
      isOptionExpected(opt, choiceKeys[idx] ?? null, question.answer),
    ),
  );
  if (expectedSet.size === 0) return false;
  if (question.type === 'multipleChoice') {
    const selected = Array.isArray(answer) ? answer : [];
    return (
      selected.length !== expectedSet.size ||
      selected.some((val) => !expectedSet.has(val))
    );
  }
  return typeof answer !== 'string' || !expectedSet.has(answer);
}

function isQuestionFlagged(
  item: ExamPaperItem,
  answer: EpubExamAnswer | undefined,
  review: EpubExamSelfReview | undefined,
  grade: EpubExamGrade | undefined,
): boolean {
  if (review === 'review' || review === 'partial') return true;
  if (grade && grade.maximum > 0 && grade.earned < grade.maximum) return true;
  if (review !== 'mastered' && isObjectiveWrong(item, answer)) return true;
  return false;
}

interface Props {
  exam: EpubExam;
  paper?: ExamPaper;
  answers: Record<string, EpubExamAnswer>;
  submitted: boolean;
  busy: boolean;
  reviews: Record<string, EpubExamSelfReview>;
  grades: Record<string, EpubExamGrade>;
  codeResults: Record<string, ExamCodeResult>;
  codeBusyId: string;
  onAnswer: (id: string, value: EpubExamAnswer) => void;
  onReview: (id: string, value: EpubExamSelfReview) => void;
  onRunCode: (id: string) => void;
  onOverride: (id: string, earned: number) => void;
  focusId?: string;
  onFocus?: (id: string) => void;
  wideWidth?: boolean;
  whiteSurface?: boolean;
  scrollLockNonce?: number;
}

export function ExamPaperSheet({
  exam,
  paper: providedPaper,
  answers,
  submitted,
  busy,
  reviews,
  grades,
  codeResults,
  codeBusyId,
  onAnswer,
  onReview,
  onRunCode,
  onOverride,
  focusId,
  onFocus,
  wideWidth = false,
  whiteSurface = false,
  scrollLockNonce = 0,
}: Props) {
  const [filterMode, setFilterMode] = useState<PaperFilterMode>('all');
  const [reviewExpandSignal, setReviewExpandSignal] = useState({
    open: false,
    version: 0,
  });
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollLockUntilRef = useRef(0);
  const focusIdRef = useRef(focusId);
  focusIdRef.current = focusId;
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;

  useEffect(() => {
    setFilterMode('all');
    setReviewExpandSignal({ open: false, version: 0 });
  }, [exam.id]);

  useEffect(() => {
    if (!submitted && filterMode === 'flagged') {
      setFilterMode('all');
    }
  }, [filterMode, submitted]);

  useEffect(() => {
    if (scrollLockNonce > 0) {
      scrollLockUntilRef.current = Date.now() + 650;
    }
  }, [scrollLockNonce]);

  const paper = useMemo(
    () =>
      providedPaper ??
      composeExamPaper(exam.questions, {
        bookTitle: exam.bookTitle,
        scopeLabel: exam.scope?.label || exam.sourceSectionLabel,
      }),
    [exam, providedPaper],
  );

  const indexById = useMemo(
    () =>
      new Map(exam.questions.map((question, index) => [question.id, index])),
    [exam.questions],
  );

  const activeSectionType = useMemo(() => {
    if (!focusId) return paper.sections[0]?.type ?? null;
    return (
      paper.sections.find((sec) =>
        sec.items.some((item) => item.question.id === focusId),
      )?.type ?? null
    );
  }, [focusId, paper.sections]);

  const { unansweredCount, flaggedCount, sectionProgress } = useMemo(() => {
    let unanswered = 0;
    let flagged = 0;
    const progress = new Map<
      EpubExamQuestionType,
      { done: number; total: number }
    >();
    for (const section of paper.sections) {
      let done = 0;
      for (const item of section.items) {
        const qId = item.question.id;
        if (isAnswerFilled(answers[qId])) {
          done += 1;
        } else {
          unanswered += 1;
        }
        if (
          submitted &&
          isQuestionFlagged(item, answers[qId], reviews[qId], grades[qId])
        ) {
          flagged += 1;
        }
      }
      progress.set(section.type, { done, total: section.items.length });
    }
    return {
      unansweredCount: unanswered,
      flaggedCount: flagged,
      sectionProgress: progress,
    };
  }, [answers, grades, paper.sections, reviews, submitted]);

  const visibleSections = useMemo(() => {
    if (filterMode === 'all') return paper.sections;
    return paper.sections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => {
          const qId = item.question.id;
          if (filterMode === 'unanswered') {
            return !isAnswerFilled(answers[qId]);
          }
          return isQuestionFlagged(
            item,
            answers[qId],
            reviews[qId],
            grades[qId],
          );
        }),
      }))
      .filter((section) => section.items.length > 0);
  }, [answers, filterMode, grades, paper.sections, reviews]);

  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;

    const elements = Array.from(
      root.querySelectorAll<HTMLElement>('.exam-paper-item[data-question-id]'),
    );
    if (elements.length === 0) return;

    const visibleIds = new Set<string>();
    let rafId = 0;

    const updateFocusFromVisible = () => {
      rafId = 0;
      if (Date.now() < scrollLockUntilRef.current) return;
      if (visibleIds.size === 0) return;
      const rootRect = root.getBoundingClientRect();
      const anchorY = rootRect.top + 88;
      let bestId = '';
      let bestDistance = Number.POSITIVE_INFINITY;

      for (const el of elements) {
        const id = el.dataset.questionId;
        if (!id || !visibleIds.has(id)) continue;
        const rect = el.getBoundingClientRect();
        const distance = Math.abs(rect.top - anchorY);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestId = id;
        }
      }
      if (bestId && bestId !== focusIdRef.current) {
        onFocusRef.current?.(bestId);
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.questionId;
          if (!id) continue;
          if (entry.isIntersecting) {
            visibleIds.add(id);
          } else {
            visibleIds.delete(id);
          }
        }
        if (Date.now() < scrollLockUntilRef.current) return;
        if (rafId === 0 && typeof requestAnimationFrame !== 'undefined') {
          rafId = requestAnimationFrame(updateFocusFromVisible);
        }
      },
      {
        root,
        rootMargin: '-64px 0px -45% 0px',
        threshold: [0.1, 0.4, 0.75],
      },
    );

    for (const el of elements) {
      observer.observe(el);
    }

    return () => {
      observer.disconnect();
      if (rafId !== 0 && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(rafId);
      }
    };
  }, [visibleSections]);

  const jumpToSection = (sectionType: EpubExamQuestionType) => {
    scrollLockUntilRef.current = Date.now() + 650;
    const section =
      visibleSections.find((sec) => sec.type === sectionType) ??
      paper.sections.find((sec) => sec.type === sectionType);
    if (!section) return;
    if (
      filterMode !== 'all' &&
      !visibleSections.some((sec) => sec.type === sectionType)
    ) {
      setFilterMode('all');
    }
    const firstId = section.items[0]?.question.id;
    if (firstId) onFocus?.(firstId);
    requestAnimationFrame(() => {
      document
        .getElementById(`exam-section-${sectionType}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  return (
    <div
      ref={scrollContainerRef}
      className={`exam-paper-scroll${whiteSurface ? ' is-white-paper' : ''}`}
    >
      {paper.sections.length > 0 && (
        <nav className="exam-paper-sticky-bar" aria-label="试卷导览与筛选">
          <div className="exam-paper-section-nav">
            {paper.sections.map((section) => {
              const stat = sectionProgress.get(section.type);
              const done = stat?.done ?? 0;
              const total = stat?.total ?? section.questionCount;
              const isActive = activeSectionType === section.type;
              const isComplete = total > 0 && done === total;
              return (
                <button
                  key={section.type}
                  type="button"
                  className={`exam-paper-section-pill${isActive ? ' is-active' : ''}${isComplete ? ' is-complete' : ''}`}
                  onClick={() => jumpToSection(section.type)}
                  title={`${section.ordinal}、${section.title}（已答 ${done}/${total}）`}
                >
                  <span>
                    {section.ordinal}、
                    {SHORT_SECTION_LABEL[section.type] ?? section.title}
                  </span>
                  <small>
                    {done}/{total}
                  </small>
                </button>
              );
            })}
          </div>

          <div className="exam-paper-filter-group">
            <button
              type="button"
              className={`exam-paper-filter-pill${filterMode === 'all' ? ' is-active' : ''}`}
              onClick={() => setFilterMode('all')}
            >
              全部 ({paper.questionCount})
            </button>
            <button
              type="button"
              className={`exam-paper-filter-pill${filterMode === 'unanswered' ? ' is-active' : ''}`}
              onClick={() => setFilterMode('unanswered')}
            >
              未答 ({unansweredCount})
            </button>
            {submitted && (
              <button
                type="button"
                className={`exam-paper-filter-pill${filterMode === 'flagged' ? ' is-active' : ''}`}
                onClick={() => setFilterMode('flagged')}
              >
                错题·待复习 ({flaggedCount})
              </button>
            )}
            {submitted && (
              <button
                type="button"
                className="exam-paper-filter-pill exam-paper-expand-btn"
                onClick={() =>
                  setReviewExpandSignal((prev) => ({
                    open: !prev.open,
                    version: prev.version + 1,
                  }))
                }
              >
                {reviewExpandSignal.open ? '收起全部解析' : '展开全部解析'}
              </button>
            )}
          </div>
        </nav>
      )}

      <article
        className={`exam-paper-sheet${wideWidth ? ' is-wide' : ''}`}
        aria-label="整卷"
      >
        <table className="exam-paper-print-frame" role="presentation">
          <thead>
            <tr>
              <td>
                <p className="exam-paper-running-head">
                  {paper.scopeLabel || '未命名范围'}
                </p>
              </td>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <header className="exam-paper-masthead">
                  <div className="exam-paper-masthead-main">
                    <p>试卷</p>
                    <h1>《{paper.bookTitle}》</h1>
                    <p>{paper.scopeLabel || '未命名范围'}</p>
                  </div>
                  <p className="exam-paper-masthead-meta">
                    <span>满分 {paper.totalPoints} 分</span>
                    <span>共 {paper.questionCount} 题</span>
                  </p>
                </header>

                {visibleSections.length === 0 ? (
                  <div className="exam-paper-empty-filter">
                    <p>
                      {filterMode === 'unanswered'
                        ? '当前试卷所有题目均已作答。'
                        : '当前没有错题或待复习题目。'}
                    </p>
                    <button
                      type="button"
                      className="epub-exam-action-btn"
                      onClick={() => setFilterMode('all')}
                    >
                      显示全部题目
                    </button>
                  </div>
                ) : (
                  visibleSections.map((section) => (
                    <section
                      key={section.type}
                      id={`exam-section-${section.type}`}
                      className="exam-paper-section"
                    >
                      <h2>
                        {section.ordinal}、{section.title}
                        <span>（{section.totalPoints} 分）</span>
                      </h2>
                      <p className="exam-paper-instruction">
                        {section.instruction}
                      </p>
                      <ol className="exam-paper-items">
                        {section.items.map((item) => (
                          <li key={item.question.id}>
                            <EpubExamQuestion
                              variant="paper"
                              question={item.question}
                              index={
                                indexById.get(item.question.id) ??
                                item.number - 1
                              }
                              sectionNumber={item.number}
                              showItemPoints={item.showPoints}
                              choiceLayout={item.choiceLayout}
                              choiceKeys={item.choiceKeys}
                              answerLines={item.answerLines}
                              focused={focusId === item.question.id}
                              onFocus={onFocus}
                              reviewExpandSignal={reviewExpandSignal}
                              answer={answers[item.question.id]}
                              submitted={submitted}
                              busy={busy}
                              review={reviews[item.question.id]}
                              grade={grades[item.question.id]}
                              codeResult={codeResults[item.question.id]}
                              codeBusy={codeBusyId === item.question.id}
                              showPrompt
                              showAnswer
                              onAnswer={(value) =>
                                onAnswer(item.question.id, value)
                              }
                              onReview={(value) =>
                                onReview(item.question.id, value)
                              }
                              onRunCode={() => onRunCode(item.question.id)}
                              onOverride={(earned) =>
                                onOverride(item.question.id, earned)
                              }
                            />
                          </li>
                        ))}
                      </ol>
                    </section>
                  ))
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </article>
    </div>
  );
}
