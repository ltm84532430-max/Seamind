import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import type {
  EpubExamAnswer,
  EpubExamGrade,
  EpubExamQuestion,
  EpubExamSelfReview,
} from './epub-exams';
import {
  choiceKeysFor,
  choiceTexts,
  type ExamChoiceLayout,
} from './exam-paper';
import { ExamRichText } from './ExamRichText';
import { ExamScrollMinimap } from './ExamScrollMinimap';

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
  variant?: 'leaf' | 'paper';
  sectionNumber?: number;
  showItemPoints?: boolean;
  choiceLayout?: ExamChoiceLayout;
  choiceKeys?: Array<string | null>;
  answerLines?: number;
  focused?: boolean;
  onFocus?: (id: string) => void;
  reviewExpandSignal?: { open: boolean; version: number };
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

export function isOptionExpected(
  option: string,
  choiceKey: string | null,
  expected: EpubExamAnswer | undefined,
): boolean {
  if (expected === undefined) return false;
  const targets = (Array.isArray(expected) ? expected : [expected])
    .map((item) => String(item).trim())
    .filter(Boolean);
  const optNorm = option.trim();
  const keyUpper = choiceKey?.toUpperCase() ?? '';
  return targets.some((target) => {
    if (target === optNorm) return true;
    if (keyUpper && target.toUpperCase() === keyUpper) return true;
    return false;
  });
}

function applyCodeEditorKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  currentValue: string,
  onChange: (nextValue: string) => void,
) {
  const el = event.currentTarget;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? start;

  if (event.key === 'Tab') {
    event.preventDefault();
    const indent = '    ';
    if (start === end && !event.shiftKey) {
      const next =
        currentValue.slice(0, start) + indent + currentValue.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + indent.length;
      });
      return;
    }

    const lineStart = currentValue.lastIndexOf('\n', start - 1) + 1;
    const rawLineEnd = currentValue.indexOf('\n', end);
    const lineEnd = rawLineEnd === -1 ? currentValue.length : rawLineEnd;
    const block = currentValue.slice(lineStart, lineEnd);
    const lines = block.split('\n');
    let firstDelta = 0;
    let totalDelta = 0;

    const updated = lines.map((line, idx) => {
      if (event.shiftKey) {
        const match = line.match(/^( {1,4}|\t)/);
        if (!match) return line;
        const removed = match[1].length;
        if (idx === 0) firstDelta = -removed;
        totalDelta -= removed;
        return line.slice(removed);
      }
      if (idx === 0) firstDelta = indent.length;
      totalDelta += indent.length;
      return indent + line;
    });

    const next =
      currentValue.slice(0, lineStart) +
      updated.join('\n') +
      currentValue.slice(lineEnd);
    onChange(next);
    requestAnimationFrame(() => {
      el.selectionStart = Math.max(lineStart, start + firstDelta);
      el.selectionEnd = Math.max(lineStart, end + totalDelta);
    });
    return;
  }

  if (event.key === 'Enter') {
    const lineStart = currentValue.lastIndexOf('\n', start - 1) + 1;
    const beforeCursor = currentValue.slice(lineStart, start);
    const indentMatch = beforeCursor.match(/^[ \t]+/);
    if (!indentMatch) return;
    event.preventDefault();
    const indent = indentMatch[0];
    const next =
      currentValue.slice(0, start) + '\n' + indent + currentValue.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      const caret = start + 1 + indent.length;
      el.selectionStart = el.selectionEnd = caret;
    });
  }
}

export default function EpubExamQuestion(props: Props) {
  const leafRef = useRef<HTMLElement>(null);
  const { question, answer, submitted, busy, grade } = props;
  const isPaper = props.variant === 'paper';
  const [paperReviewOpen, setPaperReviewOpen] = useState(false);
  const lastExpandVersionRef = useRef(-1);

  useEffect(() => {
    if (
      props.reviewExpandSignal &&
      props.reviewExpandSignal.version !== lastExpandVersionRef.current
    ) {
      lastExpandVersionRef.current = props.reviewExpandSignal.version;
      setPaperReviewOpen(props.reviewExpandSignal.open);
    }
  }, [props.reviewExpandSignal]);
  const choices = choiceTexts(question);
  const choiceKeys =
    props.choiceKeys ?? choiceKeysFor(question.type, choices.length);
  const isSubjective = [
    'shortAnswer',
    'comprehensive',
    'engineering',
    'cProgramming',
  ].includes(question.type);
  const isUntouchedStarter =
    question.type === 'cProgramming' &&
    typeof answer !== 'string' &&
    Boolean(question.codeSpec?.starterCode);
  const codeValue =
    typeof answer === 'string'
      ? answer
      : question.type === 'cProgramming'
        ? (question.codeSpec?.starterCode ?? '')
        : '';

  const renderReviewContent = () => (
    <>
      <div className="epub-exam-ai-solution">
        <strong>参考答案与解析</strong>
        {question.type === 'cProgramming' ? (
          <pre>
            {Array.isArray(question.answer)
              ? question.answer.join('、')
              : question.answer}
          </pre>
        ) : (
          <p>
            <ExamRichText
              text={
                Array.isArray(question.answer)
                  ? question.answer.join('、')
                  : question.answer
              }
            />
          </p>
        )}
        <p>
          <ExamRichText text={question.explanation} />
        </p>
      </div>
      {!!question.rubric?.length && (
        <div className="epub-exam-rubric">
          <strong>评分细则</strong>
          {question.rubric.map((item, idx) => (
            <div key={idx}>
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
        <span className="epub-exam-review-label">掌握度：</span>
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
            className={`epub-exam-seg-btn is-${value}${props.review === value ? ' is-active' : ''}`}
            onClick={() => props.onReview(value)}
            disabled={busy}
          >
            {label}
          </button>
        ))}
      </div>
    </>
  );

  const paper = (
    <article
      ref={leafRef}
      className={`${isPaper ? 'exam-paper-item' : 'epub-exam-leaf'}${isPaper && props.focused ? ' is-focused' : ''}`}
      id={`exam-question-${question.id}`}
      data-question-id={question.id}
      onClick={
        isPaper && props.onFocus
          ? () => props.onFocus?.(question.id)
          : undefined
      }
      onFocusCapture={
        isPaper && props.onFocus
          ? () => props.onFocus?.(question.id)
          : undefined
      }
    >
      {props.showPrompt && (
        <>
          {isPaper ? (
            <h3 className="exam-paper-prompt">
              <span className="exam-paper-number">
                {props.sectionNumber ?? props.index + 1}.
              </span>
              {props.showItemPoints && (
                <span className="exam-paper-points">
                  （{question.points || 2}分）
                </span>
              )}
              <ExamRichText text={question.prompt} />
            </h3>
          ) : (
            <>
              <header className="epub-exam-leaf-header">
                <span>第 {props.index + 1} 题</span>
                <span>{typeLabel(question.type)}</span>
                <span>{question.points || 2} 分</span>
              </header>
              <h2 className="epub-exam-leaf-prompt">
                <ExamRichText text={question.prompt} />
              </h2>
            </>
          )}
          {!!question.sourceRefs?.length && !isPaper && (
            <div className="epub-exam-leaf-sources">
              来源：{question.sourceRefs.map((ref) => ref.label).join(' · ')}
            </div>
          )}
          {question.codeSpec && (
            <div className="epub-exam-code-samples">
              <strong>公开样例</strong>
              {(question.codeSpec.cases ?? [])
                .filter((item) => !item.hidden)
                .map((item, idx) => (
                  <div key={idx}>
                    <span>样例 {idx + 1}</span>
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
                <span>
                  {question.type === 'cProgramming' ? 'C11 源代码' : '你的作答'}
                </span>
                {isUntouchedStarter && (
                  <span className="epub-exam-code-untouched-hint">
                    当前为起始模板（修改后计为已作答）
                  </span>
                )}
              </label>
              <textarea
                id={`exam-answer-${question.id}`}
                className={
                  question.type === 'cProgramming'
                    ? 'epub-exam-code-editor'
                    : isPaper
                      ? 'exam-paper-answer-editor'
                      : 'epub-exam-answer-editor'
                }
                style={
                  isPaper && question.type !== 'cProgramming'
                    ? { minHeight: (props.answerLines || 4) * 28 }
                    : undefined
                }
                spellCheck={question.type !== 'cProgramming'}
                value={codeValue}
                onChange={(event) => props.onAnswer(event.target.value)}
                onKeyDown={
                  question.type === 'cProgramming'
                    ? (event) =>
                        applyCodeEditorKeyDown(event, codeValue, (next) =>
                          props.onAnswer(next),
                        )
                    : undefined
                }
                disabled={submitted || busy}
                rows={question.type === 'cProgramming' ? 15 : 8}
              />
              {question.type !== 'cProgramming' &&
                typeof answer === 'string' &&
                answer.includes('$') && (
                  <div className="epub-exam-math-preview">
                    <span className="epub-exam-math-preview-label">
                      公式渲染预览
                    </span>
                    <ExamRichText text={answer} />
                  </div>
                )}
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
                        {props.codeResult.evaluation?.error ||
                          `通过 ${props.codeResult.evaluation?.passed ?? 0} / ${props.codeResult.evaluation?.total ?? 0} 个测试`}
                      </strong>
                      {(props.codeResult.evaluation?.cases ?? []).map(
                        (item, idx) => (
                          <div
                            key={idx}
                            className={item.passed ? 'is-passed' : 'is-failed'}
                          >
                            {item.visible ? '公开' : '隐藏'}用例 {idx + 1}：
                            {item.passed ? '通过' : '未通过'}
                            {item.visible && !item.passed && (
                              <pre>
                                实际输出：{item.stdout || '（空）'}
                                {'\n'}预期输出：
                                {item.expectedStdout || '（空）'}
                                {'\n'}
                                {item.stderr}
                              </pre>
                            )}
                          </div>
                        ),
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <div
              className={
                isPaper
                  ? `exam-paper-options is-${props.choiceLayout ?? 'stack'}`
                  : 'epub-exam-options-grid'
              }
            >
              {choices.map((option, optionIndex) => {
                const choiceKey = choiceKeys[optionIndex] ?? null;
                const selected =
                  question.type === 'multipleChoice'
                    ? Array.isArray(answer) && answer.includes(option)
                    : answer === option;
                const expectedOpt =
                  submitted &&
                  isOptionExpected(option, choiceKey, question.answer);
                const statusClass = submitted
                  ? expectedOpt
                    ? ' is-correct'
                    : selected
                      ? ' is-wrong'
                      : ''
                  : '';
                return (
                  <label
                    key={`${question.id}-${optionIndex}`}
                    className={`${isPaper ? 'exam-paper-option' : 'epub-exam-option-item'}${selected ? ' is-selected' : ''}${statusClass}`}
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
                    <span
                      className={
                        isPaper
                          ? 'exam-paper-option-text'
                          : 'epub-exam-option-text'
                      }
                    >
                      {choiceKey ? `${choiceKey}. ` : ''}
                      <ExamRichText text={option} />
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          {submitted && !isPaper && renderReviewContent()}
          {submitted && isPaper && (
            <details
              className="exam-paper-inline-review"
              open={paperReviewOpen}
            >
              <summary
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setPaperReviewOpen((prev) => !prev);
                }}
              >
                {paperReviewOpen ? '收起参考答案与解析' : '查看参考答案与解析'}
              </summary>
              {renderReviewContent()}
            </details>
          )}
        </div>
      )}
    </article>
  );
  if (isPaper) return paper;
  return (
    <div className="epub-exam-leaf-shell">
      {paper}
      <ExamScrollMinimap scrollRef={leafRef} label="试卷作答缩略导航" />
    </div>
  );
}
