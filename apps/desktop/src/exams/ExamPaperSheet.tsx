import { useMemo } from 'react';
import type {
  EpubExam,
  EpubExamAnswer,
  EpubExamGrade,
  EpubExamSelfReview,
} from './epub-exams';
import { composeExamPaper } from './exam-paper';
import EpubExamQuestion, { type ExamCodeResult } from './EpubExamQuestion';

interface Props {
  exam: EpubExam;
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
}

export function ExamPaperSheet({
  exam,
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
}: Props) {
  const paper = useMemo(
    () =>
      composeExamPaper(exam.questions, {
        bookTitle: exam.bookTitle,
        scopeLabel: exam.scope?.label || exam.sourceSectionLabel,
      }),
    [exam],
  );
  const indexById = useMemo(
    () =>
      new Map(exam.questions.map((question, index) => [question.id, index])),
    [exam.questions],
  );

  return (
    <div className="exam-paper-scroll">
      <article className="exam-paper-sheet" aria-label="整卷">
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
                  <p>试卷</p>
                  <h1>《{paper.bookTitle}》</h1>
                  <p>{paper.scopeLabel || '未命名范围'}</p>
                  <p className="exam-paper-masthead-meta">
                    <span>满分 {paper.totalPoints} 分</span>
                    <span>共 {paper.questionCount} 题</span>
                  </p>
                </header>
                {paper.sections.map((section) => (
                  <section key={section.type} className="exam-paper-section">
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
                              indexById.get(item.question.id) ?? item.number - 1
                            }
                            sectionNumber={item.number}
                            showItemPoints={item.showPoints}
                            choiceLayout={item.choiceLayout}
                            choiceKeys={item.choiceKeys}
                            answerLines={item.answerLines}
                            focused={focusId === item.question.id}
                            onFocus={onFocus}
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
                ))}
              </td>
            </tr>
          </tbody>
        </table>
      </article>
    </div>
  );
}
