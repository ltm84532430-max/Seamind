import { useMemo } from 'react';
import type {
  EpubExam,
  EpubExamAnswer,
  EpubExamGrade,
  EpubExamQuestionType,
  EpubExamSelfReview,
} from './epub-exams';
import { composeExamPaper } from './exam-paper';
import { ExamRichText } from './ExamRichText';

const TYPE_LABEL: Record<EpubExamQuestionType, string> = {
  singleChoice: '单选题',
  multipleChoice: '多选题',
  trueFalse: '判断题',
  shortAnswer: '简答题',
  comprehensive: '综合题',
  engineering: '工程应用题',
  cProgramming: 'C 编程题',
};

interface Props {
  exam: EpubExam;
  focusId: string;
  submitted: boolean;
  busy: boolean;
  answer: EpubExamAnswer | undefined;
  review: EpubExamSelfReview | undefined;
  grade: EpubExamGrade | undefined;
  onReview: (value: EpubExamSelfReview) => void;
  onOverride: (earned: number) => void;
}

function answerText(answer: EpubExamAnswer | undefined): string {
  if (answer === undefined || answer === '') return '未作答';
  return Array.isArray(answer) ? answer.join('、') || '未作答' : answer;
}

export function ExamPaperReview({
  exam,
  focusId,
  submitted,
  busy,
  answer,
  review,
  grade,
  onReview,
  onOverride,
}: Props) {
  const paper = useMemo(
    () =>
      composeExamPaper(exam.questions, {
        bookTitle: exam.bookTitle,
        scopeLabel: exam.scope?.label || exam.sourceSectionLabel,
      }),
    [exam],
  );
  const located = useMemo(() => {
    for (const section of paper.sections) {
      const item = section.items.find((entry) => entry.question.id === focusId);
      if (item) return { section, item };
    }
    return null;
  }, [focusId, paper.sections]);

  return (
    <section className="epub-exam-analytics-card exam-paper-review">
      <div className="epub-exam-card-title-row">
        <h3>当前题目</h3>
      </div>
      {!located ? (
        <p className="epub-exam-card-hint">
          在卷面上点选一题，解析和评分显示在这里。
        </p>
      ) : (
        <>
          <p className="exam-paper-review-kicker">
            {located.section.ordinal}、{located.section.title} · 第{' '}
            {located.item.number} 题 · {TYPE_LABEL[located.item.question.type]}{' '}
            · {located.item.points} 分
          </p>
          <p className="exam-paper-review-prompt">
            <ExamRichText text={located.item.question.prompt} />
          </p>
          {!submitted ? (
            <p className="epub-exam-card-hint">解析在交卷后出现在这里。</p>
          ) : (
            <>
              {!!located.item.question.sourceRefs?.length && (
                <p className="exam-paper-review-sources">
                  来源：
                  {located.item.question.sourceRefs
                    .map((ref) => ref.label)
                    .join(' · ')}
                </p>
              )}
              <div className="exam-paper-review-block">
                <strong>我的答案</strong>
                {located.item.question.type === 'cProgramming' ? (
                  <pre className="exam-paper-review-code">
                    {answerText(answer)}
                  </pre>
                ) : (
                  <p>
                    <ExamRichText text={answerText(answer)} />
                  </p>
                )}
              </div>
              <div className="exam-paper-review-block">
                <strong>参考答案与解析</strong>
                {located.item.question.type === 'cProgramming' ? (
                  <pre className="exam-paper-review-code">
                    {answerText(located.item.question.answer)}
                  </pre>
                ) : (
                  <p>
                    <ExamRichText
                      text={answerText(located.item.question.answer)}
                    />
                  </p>
                )}
                <p>
                  <ExamRichText text={located.item.question.explanation} />
                </p>
              </div>
              {!!located.item.question.rubric?.length && (
                <div className="epub-exam-rubric">
                  <strong>评分细则</strong>
                  {located.item.question.rubric.map((item, index) => (
                    <div key={index}>
                      {item.criterion}
                      <span>{item.points} 分</span>
                    </div>
                  ))}
                </div>
              )}
              {grade && (
                <div className="epub-exam-grade">
                  <strong>
                    {grade.provisional ? '建议得分' : '得分'}：{grade.earned} /{' '}
                    {grade.maximum}
                  </strong>
                  <p>{grade.feedback}</p>
                  {['shortAnswer', 'comprehensive', 'engineering'].includes(
                    located.item.question.type,
                  ) && (
                    <label>
                      人工调整{' '}
                      <input
                        type="number"
                        min="0"
                        max={grade.maximum}
                        step="0.5"
                        value={grade.earned}
                        onChange={(event) =>
                          onOverride(Number(event.target.value))
                        }
                      />
                    </label>
                  )}
                </div>
              )}
              <div className="epub-exam-review-segmented">
                <span>掌握度：</span>
                {(
                  [
                    ['mastered', '✓ 掌握'],
                    ['partial', '◐ 部分'],
                    ['review', '✗ 需复习'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`epub-exam-seg-btn${review === value ? ' is-active' : ''}`}
                    onClick={() => onReview(value)}
                    disabled={busy}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
