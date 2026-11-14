import { useMemo } from 'react';
import type {
  EpubExam,
  EpubExamAnswer,
  EpubExamGrade,
  EpubExamQuestionType,
  EpubExamSelfReview,
} from './epub-exams';
import { composeExamPaper, type ExamPaper } from './exam-paper';
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
  paper?: ExamPaper;
  focusId: string;
  submitted: boolean;
  busy: boolean;
  answer: EpubExamAnswer | undefined;
  review: EpubExamSelfReview | undefined;
  grade: EpubExamGrade | undefined;
  onReview: (value: EpubExamSelfReview) => void;
  onOverride: (earned: number) => void;
  onJumpNextUnanswered?: () => void;
}

function answerText(answer: EpubExamAnswer | undefined): string {
  if (answer === undefined || answer === '') return '未作答';
  return Array.isArray(answer) ? answer.join('、') || '未作答' : answer;
}

function preSubmitHint(type: EpubExamQuestionType): string {
  if (type === 'cProgramming') {
    return '支持 Tab 4 空格缩进、自动对齐，并可点击「运行公开样例」验证输出。';
  }
  if (type === 'singleChoice' || type === 'multipleChoice') {
    return '提交后将显示标准答案与解析；可用 A–D 或 1–4 快捷选择，J / K 切换上下题，F 专注做卷。';
  }
  if (type === 'trueFalse') {
    return '判断正确或错误，交卷后自动判定并显示解析。';
  }
  return '支持 $...$ 与 $$...$$ 公式实时渲染预览，交卷后给出评分细则。';
}

export function ExamPaperReview({
  exam,
  paper: providedPaper,
  focusId,
  submitted,
  busy,
  answer,
  review,
  grade,
  onReview,
  onOverride,
  onJumpNextUnanswered,
}: Props) {
  const paper = useMemo(
    () =>
      providedPaper ??
      composeExamPaper(exam.questions, {
        bookTitle: exam.bookTitle,
        scopeLabel: exam.scope?.label || exam.sourceSectionLabel,
      }),
    [exam, providedPaper],
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
        {!submitted && onJumpNextUnanswered && (
          <button
            type="button"
            className="epub-exam-next-unanswered-btn"
            onClick={onJumpNextUnanswered}
          >
            下一未答
          </button>
        )}
      </div>
      {!located ? (
        <p className="epub-exam-card-hint">
          在卷面上点选一题，作答提示与解析会显示在这里。
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
            <p className="epub-exam-card-hint">
              {preSubmitHint(located.item.question.type)}
            </p>
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
                    className={`epub-exam-seg-btn is-${value}${review === value ? ' is-active' : ''}`}
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
