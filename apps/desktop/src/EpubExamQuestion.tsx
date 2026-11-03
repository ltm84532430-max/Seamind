import type {
  EpubExamAnswer,
  EpubExamGrade,
  EpubExamQuestion,
  EpubExamSelfReview,
} from './epub-exams';

export interface ExamCodeResult {
  evaluation: {
    stage: string;
    error: string;
    passed: number;
    total: number;
    cases: Array<{
      visible: boolean;
      passed: boolean;
      stdout: string;
      stderr: string;
      expectedStdout: string | null;
    }>;
  };
  grade: EpubExamGrade;
}

interface Props {
  question: EpubExamQuestion;
  index: number;
  answer: EpubExamAnswer | undefined;
  submitted: boolean;
  busy: boolean;
  review: EpubExamSelfReview | undefined;
  grade: EpubExamGrade | undefined;
  codeResult?: ExamCodeResult;
  codeBusy?: boolean;
  showPrompt: boolean;
  showAnswer: boolean;
  onAnswer: (value: EpubExamAnswer) => void;
  onReview: (value: EpubExamSelfReview) => void;
  onRunCode: () => void;
  onOverride: (earned: number) => void;
}

function typeLabel(type: EpubExamQuestion['type']) {
  return {
    singleChoice: '单选题',
    multipleChoice: '多选题',
    trueFalse: '判断题',
    shortAnswer: '简答题',
    comprehensive: '综合题',
    engineering: '工程应用题',
    cProgramming: 'C 编程题',
  }[type];
}

export default function EpubExamQuestion(props: Props) {
  const { question, answer, submitted, busy, grade } = props;
  const choices =
    question.type === 'trueFalse'
      ? (question.options ?? ['正确', '错误'])
      : (question.options ?? []);
  const isSubjective = [
    'shortAnswer',
    'comprehensive',
    'engineering',
    'cProgramming',
  ].includes(question.type);
  return (
    <article className="epub-exam-leaf" id={`exam-question-${question.id}`}>
      {props.showPrompt && (
        <>
          <header className="epub-exam-leaf-header">
            <span>第 {props.index + 1} 题</span>
            <span>{typeLabel(question.type)}</span>
            <span>{question.points || 2} 分</span>
          </header>
          <h2 className="epub-exam-leaf-prompt">{question.prompt}</h2>
          {!!question.sourceRefs?.length && (
            <div className="epub-exam-leaf-sources">
              来源：{question.sourceRefs.map((ref) => ref.label).join(' · ')}
            </div>
          )}
          {question.codeSpec && (
            <div className="epub-exam-code-samples">
              <strong>公开样例</strong>
              {question.codeSpec.cases
                .filter((item) => !item.hidden)
                .map((item, index) => (
                  <div key={index}>
                    <span>样例 {index + 1}</span>
                    <pre>
                      输入：{item.stdin || '（空）'}
                      {'\n'}输出：{item.expectedStdout || '（空）'}
                    </pre>
                  </div>
                ))}
            </div>
          )}
        </>
      )}
      {props.showAnswer && (
        <div className="epub-exam-leaf-answer">
          {!props.showPrompt && (
            <header className="epub-exam-leaf-header">
              <span>第 {props.index + 1} 题 · 作答</span>
              <span>{typeLabel(question.type)}</span>
            </header>
          )}
          {isSubjective ? (
            <>
              <label
                className="epub-exam-answer-label"
                htmlFor={`exam-answer-${question.id}`}
              >
                {question.type === 'cProgramming' ? 'C11 源代码' : '你的作答'}
              </label>
              <textarea
                id={`exam-answer-${question.id}`}
                className={
                  question.type === 'cProgramming'
                    ? 'epub-exam-code-editor'
                    : 'epub-exam-answer-editor'
                }
                spellCheck={question.type !== 'cProgramming'}
                value={
                  typeof answer === 'string'
                    ? answer
                    : question.type === 'cProgramming'
                      ? (question.codeSpec?.starterCode ?? '')
                      : ''
                }
                onChange={(event) => props.onAnswer(event.target.value)}
                disabled={submitted || busy}
                rows={question.type === 'cProgramming' ? 15 : 8}
              />
              {question.type === 'cProgramming' && (
                <>
                  <button
                    type="button"
                    className="epub-exam-code-run"
                    onClick={props.onRunCode}
                    disabled={
                      props.codeBusy ||
                      busy ||
                      !String(
                        answer ?? question.codeSpec?.starterCode ?? '',
                      ).trim()
                    }
                  >
                    {props.codeBusy
                      ? '正在编译与测试…'
                      : submitted
                        ? '查看全部测试'
                        : '运行公开样例'}
                  </button>
                  {props.codeResult && (
                    <div className="epub-exam-code-results" role="status">
                      <strong>
                        {props.codeResult.evaluation.error ||
                          `通过 ${props.codeResult.evaluation.passed} / ${props.codeResult.evaluation.total} 个测试`}
                      </strong>
                      {props.codeResult.evaluation.cases.map((item, index) => (
                        <div
                          key={index}
                          className={item.passed ? 'is-passed' : 'is-failed'}
                        >
                          {item.visible ? '公开' : '隐藏'}用例 {index + 1}：
                          {item.passed ? '通过' : '未通过'}
                          {item.visible && !item.passed && (
                            <pre>
                              实际输出：{item.stdout || '（空）'}
                              {'\n'}预期输出：{item.expectedStdout || '（空）'}
                              {'\n'}
                              {item.stderr}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <div className="epub-exam-options-grid">
              {choices.map((option) => {
                const selected =
                  question.type === 'multipleChoice'
                    ? Array.isArray(answer) && answer.includes(option)
                    : answer === option;
                return (
                  <label
                    key={option}
                    className={`epub-exam-option-item${selected ? ' is-selected' : ''}`}
                  >
                    <input
                      type={
                        question.type === 'multipleChoice'
                          ? 'checkbox'
                          : 'radio'
                      }
                      name={`exam-${question.id}`}
                      checked={selected}
                      disabled={submitted || busy}
                      onChange={() => {
                        if (question.type === 'multipleChoice')
                          props.onAnswer(
                            selected
                              ? (answer as string[]).filter(
                                  (value) => value !== option,
                                )
                              : [
                                  ...(Array.isArray(answer) ? answer : []),
                                  option,
                                ],
                          );
                        else props.onAnswer(option);
                      }}
                    />
                    <span className="epub-exam-option-text">{option}</span>
                  </label>
                );
              })}
            </div>
          )}
          {submitted && (
            <>
              <div className="epub-exam-ai-solution">
                <strong>参考答案与解析</strong>
                <pre>
                  {Array.isArray(question.answer)
                    ? question.answer.join('、')
                    : question.answer}
                </pre>
                <p>{question.explanation}</p>
              </div>
              {!!question.rubric?.length && (
                <div className="epub-exam-rubric">
                  <strong>评分细则</strong>
                  {question.rubric.map((item, index) => (
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
                    question.type,
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
                          props.onOverride(Number(event.target.value))
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
                    className={`epub-exam-seg-btn${props.review === value ? ' is-active' : ''}`}
                    onClick={() => props.onReview(value)}
                    disabled={busy}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </article>
  );
}
