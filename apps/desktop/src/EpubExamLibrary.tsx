import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type {
  EpubExam,
  EpubExamAttempt,
  EpubExamAnswer,
  EpubExamSelfReview,
  EpubExamSummary,
} from './epub-exams';
import { formatEpubExamDate } from './epub-exams';

type ExamBook = { relativePath: string; title: string };

function formatExamAnswer(answer: EpubExamAnswer | undefined): string {
  if (answer === undefined || answer === '') return '未作答';
  return Array.isArray(answer) ? answer.join('、') || '未作答' : answer;
}

function formatSelfReview(review: EpubExamSelfReview | undefined): string {
  if (review === 'mastered') return '掌握';
  if (review === 'partial') return '部分掌握';
  if (review === 'review') return '需复习';
  return '未自评';
}

export function EpubExamLibraryPanel({
  books,
  exams,
  filteredBookKey,
  loading,
  error,
  open,
  onClose,
  onFilterBook,
  onOpenExam,
}: {
  books: ExamBook[];
  exams: EpubExamSummary[];
  filteredBookKey: string;
  loading: boolean;
  error: string;
  open: boolean;
  onClose: () => void;
  onFilterBook: (bookKey: string) => void;
  onOpenExam: (exam: EpubExamSummary) => void;
}) {
  const [query, setQuery] = useState('');
  const bookTitles = new Map(
    books.map((book) => [book.relativePath, book.title]),
  );
  const grouped = new Map<string, EpubExamSummary[]>();
  for (const exam of exams) {
    const current = grouped.get(exam.bookKey) ?? [];
    current.push(exam);
    grouped.set(exam.bookKey, current);
  }
  const search = query.trim().toLocaleLowerCase();
  const groups = [...grouped.entries()]
    .map(([bookKey, items]) => ({
      bookKey,
      title: bookTitles.get(bookKey) || items[0]?.bookTitle || '未命名书籍',
      exams: items
        .filter((exam) =>
          `${exam.sourceSectionLabel} ${exam.bookTitle} ${bookTitles.get(exam.bookKey) ?? ''}`
            .toLocaleLowerCase()
            .includes(search),
        )
        .sort((left, right) => right.createdAt - left.createdAt),
    }))
    .filter(
      (group) =>
        (!filteredBookKey || group.bookKey === filteredBookKey) &&
        group.exams.length > 0,
    )
    .sort(
      (left, right) =>
        (right.exams[0]?.createdAt ?? 0) - (left.exams[0]?.createdAt ?? 0),
    );

  return (
    <>
      {open && (
        <button
          className="epub-exam-library-backdrop"
          type="button"
          aria-label="关闭试卷库"
          onClick={onClose}
        />
      )}
      <aside
        className={`epub-exam-library${open ? ' is-open' : ''}`}
        aria-label="试卷库"
      >
        <header className="epub-exam-library-heading">
          <div>
            <span className="ebook-shelf-kicker">LOCAL EXAM LIBRARY</span>
            <h2>试卷库</h2>
          </div>
          <button
            className="epub-exam-library-close"
            type="button"
            aria-label="收起试卷库"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <p className="epub-exam-library-intro">
          阅读时按当前段落生成，试卷和作答保存在本机。
        </p>
        <label className="epub-exam-library-search">
          <span aria-hidden="true">⌕</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索书名或段落"
            aria-label="搜索试卷"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="清除搜索"
            >
              ×
            </button>
          )}
        </label>
        {filteredBookKey && (
          <button
            type="button"
            className="epub-exam-library-clear-filter"
            onClick={() => onFilterBook('')}
          >
            显示全部书籍的试卷
          </button>
        )}
        {error && (
          <p className="epub-exam-library-error" role="alert">
            {error}
          </p>
        )}
        {loading ? (
          <p className="epub-exam-library-empty">正在读取本地试卷…</p>
        ) : groups.length ? (
          <div className="epub-exam-library-groups">
            {groups.map((group) => (
              <section className="epub-exam-book-group" key={group.bookKey}>
                <button
                  type="button"
                  className={`epub-exam-book-heading${filteredBookKey === group.bookKey ? ' is-active' : ''}`}
                  onClick={() => onFilterBook(group.bookKey)}
                  title={`筛选《${group.title}》的试卷`}
                >
                  <span title={group.title}>{group.title}</span>
                  <small>{group.exams.length}</small>
                </button>
                <div className="epub-exam-book-list">
                  {group.exams.map((exam) => (
                    <button
                      type="button"
                      className="epub-exam-entry"
                      key={exam.id}
                      onClick={() => onOpenExam(exam)}
                    >
                      <span
                        className="epub-exam-entry-title"
                        title={exam.sourceSectionLabel}
                      >
                        {exam.sourceSectionLabel || '当前阅读段落'}
                      </span>
                      <span className="epub-exam-entry-meta">
                        {formatEpubExamDate(exam.createdAt)} ·{' '}
                        {exam.questionCount} 题
                      </span>
                      <span className={`epub-exam-status is-${exam.status}`}>
                        {exam.status === 'submitted' ? '已交卷' : '未交卷'}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="epub-exam-library-empty">
            <span aria-hidden="true">▤</span>
            <strong>
              {search || filteredBookKey ? '没有匹配的试卷' : '还没有试卷'}
            </strong>
            <p>
              {filteredBookKey
                ? '这本书还没有试卷，阅读时可以根据当前段落生成。'
                : '打开一本书，在阅读器中选择“根据当前内容生成试卷”。'}
            </p>
          </div>
        )}
      </aside>
    </>
  );
}

export function EpubExamWorkspace({
  examId,
  bookKey,
  onBack,
}: {
  examId: string;
  bookKey: string;
  onBack: () => void;
}) {
  const [exam, setExam] = useState<EpubExam | null>(null);
  const [answers, setAnswers] = useState<Record<string, EpubExamAnswer>>({});
  const [selfReviews, setSelfReviews] = useState<
    Record<string, EpubExamSelfReview>
  >({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>(
    'idle',
  );
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveTimerRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const revisionRef = useRef(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void invoke<EpubExam>('get_epub_exam', { bookKey, examId })
      .then((loaded) => {
        if (!active) return;
        setExam({ ...loaded, attempts: loaded.attempts ?? [] });
        setAnswers(loaded.answers ?? {});
        setSelfReviews(loaded.selfReviews ?? {});
        dirtyRef.current = false;
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      if (saveTimerRef.current !== null)
        window.clearTimeout(saveTimerRef.current);
    };
  }, [bookKey, examId]);

  const enqueueSave = (
    nextAnswers: Record<string, EpubExamAnswer>,
    nextReviews: Record<string, EpubExamSelfReview>,
    submitted: boolean,
  ) => {
    const operation = saveQueueRef.current
      .catch(() => undefined)
      .then(() =>
        invoke<EpubExam>('save_epub_exam_progress', {
          bookKey,
          examId,
          answers: nextAnswers,
          selfReviews: nextReviews,
          submitted,
        }).then(() => undefined),
      );
    saveQueueRef.current = operation;
    return operation;
  };

  useEffect(() => {
    if (!exam || loading || !dirtyRef.current) return;
    const revision = revisionRef.current;
    if (saveTimerRef.current !== null)
      window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      setSaveState('saving');
      void enqueueSave(answers, selfReviews, exam.status === 'submitted')
        .then(() => {
          if (revisionRef.current === revision) dirtyRef.current = false;
          setSaveState('saved');
          setError('');
        })
        .catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause));
          setSaveState('idle');
        });
    }, 500);
    return () => {
      if (saveTimerRef.current !== null)
        window.clearTimeout(saveTimerRef.current);
    };
  }, [answers, exam, loading, selfReviews]);

  const editAnswer = (questionId: string, value: EpubExamAnswer) => {
    if (exam?.status === 'submitted' || busy) return;
    dirtyRef.current = true;
    revisionRef.current += 1;
    setSaveState('idle');
    setAnswers((current) => ({ ...current, [questionId]: value }));
  };

  const editReview = (questionId: string, value: EpubExamSelfReview) => {
    if (busy) return;
    dirtyRef.current = true;
    revisionRef.current += 1;
    setSaveState('idle');
    setSelfReviews((current) => ({ ...current, [questionId]: value }));
  };

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
      setExam({ ...exam, status: 'submitted', submittedAt: Date.now() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const restartExam = async () => {
    if (!exam || exam.status !== 'submitted' || busy) return;
    const nextAttempt = exam.attempts.length + 1;
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
        examId,
      });
      revisionRef.current += 1;
      dirtyRef.current = false;
      setExam({ ...restarted, attempts: restarted.attempts ?? [] });
      setAnswers(restarted.answers ?? {});
      setSelfReviews(restarted.selfReviews ?? {});
      setSaveState('saved');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaveState('idle');
    } finally {
      setBusy(false);
    }
  };

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
      await invoke('delete_epub_exam', { bookKey, examId });
      onBack();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <main className="epub-exam-page">
        <p role="status">正在打开试卷…</p>
      </main>
    );
  }
  if (!exam) {
    return (
      <main className="epub-exam-page">
        <button type="button" className="epub-exam-back" onClick={onBack}>
          返回试卷库
        </button>
        <p className="epub-exam-error" role="alert">
          {error || '找不到这份试卷。'}
        </p>
      </main>
    );
  }

  return (
    <main
      className="epub-exam-page"
      aria-label={`试卷：${exam.sourceSectionLabel}`}
    >
      <header className="epub-exam-page-header">
        <button
          type="button"
          className="epub-exam-back"
          onClick={() => void goBack()}
          disabled={busy}
        >
          ← 返回试卷库
        </button>
        <div>
          <span className="ebook-shelf-kicker">
            LOCAL EXAM · {exam.questionCount} QUESTIONS
          </span>
          <h1>{exam.sourceSectionLabel || '当前阅读段落'}</h1>
          <p>
            {exam.bookTitle} · {formatEpubExamDate(exam.createdAt)} ·{' '}
            {exam.difficulty === 'easy'
              ? '简单'
              : exam.difficulty === 'hard'
                ? '困难'
                : '中等'}{' '}
            · 第 {exam.attempts.length + 1} 次
          </p>
        </div>
        <div className="epub-exam-page-actions">
          <span className={`epub-exam-status is-${exam.status}`}>
            {exam.status === 'submitted' ? '已交卷' : '未交卷'}
          </span>
          {exam.status === 'submitted' && (
            <button
              type="button"
              className="is-primary"
              onClick={() => void restartExam()}
              disabled={busy}
            >
              重新作答
            </button>
          )}
          <button
            type="button"
            className="is-danger"
            onClick={() => void deleteExam()}
            disabled={busy}
          >
            删除试卷
          </button>
        </div>
      </header>
      {error && (
        <p className="epub-exam-error" role="alert">
          {error}
        </p>
      )}
      <p className="epub-exam-answer-note">
        {exam.status === 'submitted'
          ? 'AI 答案和解析已显示；请逐题自评，应用不会自动评分。'
          : exam.attempts.length > 0
            ? `第 ${exam.attempts.length + 1} 次作答中；提交前 AI 答案保持隐藏，上次作答保存在历史记录中。`
            : '提交前 AI 答案会保持隐藏；作答会自动保存在本机。'}
      </p>
      {exam.attempts.length > 0 && (
        <details className="epub-exam-attempt-history">
          <summary>查看历史作答（{exam.attempts.length} 次）</summary>
          <div className="epub-exam-attempt-list">
            {exam.attempts.map((attempt: EpubExamAttempt, attemptIndex) => (
              <section
                className="epub-exam-attempt"
                key={`${attempt.completedAt}-${attemptIndex}`}
              >
                <h2>
                  第 {attemptIndex + 1} 次 ·{' '}
                  {formatEpubExamDate(attempt.completedAt)}
                </h2>
                <ol>
                  {exam.questions.map((question, questionIndex) => (
                    <li key={question.id}>
                      <strong>
                        {questionIndex + 1}. {question.prompt}
                      </strong>
                      <p>
                        我的答案：
                        {formatExamAnswer(attempt.answers[question.id])}
                      </p>
                      <p>
                        自评：
                        {formatSelfReview(attempt.selfReviews[question.id])}
                      </p>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        </details>
      )}
      <div className="epub-exam-questions">
        {exam.questions.map((question, index) => {
          const answer = answers[question.id];
          const selected = Array.isArray(answer) ? answer : [];
          const options =
            question.type === 'trueFalse'
              ? (question.options ?? ['正确', '错误'])
              : (question.options ?? []);
          const submitted = exam.status === 'submitted';
          return (
            <article className="epub-exam-question" key={question.id}>
              <header>
                <span>
                  第 {index + 1} 题 ·{' '}
                  {question.type === 'shortAnswer'
                    ? '简答题'
                    : question.type === 'multipleChoice'
                      ? '多选题'
                      : question.type === 'trueFalse'
                        ? '判断题'
                        : '单选题'}
                </span>
                {submitted && (
                  <label className="epub-exam-review">
                    <span>自评</span>
                    <select
                      value={selfReviews[question.id] ?? ''}
                      disabled={busy}
                      onChange={(event) => {
                        const value = event.target.value as
                          | EpubExamSelfReview
                          | '';
                        if (value) editReview(question.id, value);
                      }}
                      aria-label={`第 ${index + 1} 题自评`}
                    >
                      <option value="">待自评</option>
                      <option value="mastered">掌握</option>
                      <option value="partial">部分掌握</option>
                      <option value="review">需复习</option>
                    </select>
                  </label>
                )}
              </header>
              <h2>{question.prompt}</h2>
              {question.type === 'shortAnswer' ? (
                <textarea
                  value={typeof answer === 'string' ? answer : ''}
                  onChange={(event) =>
                    editAnswer(question.id, event.target.value)
                  }
                  placeholder="写下你的答案…"
                  disabled={submitted || busy}
                  rows={4}
                />
              ) : (
                <div className="epub-exam-options">
                  {options.map((option) => {
                    const checked =
                      question.type === 'multipleChoice'
                        ? selected.includes(option)
                        : answer === option;
                    return (
                      <label
                        className={checked ? 'is-selected' : ''}
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
                                ? selected.filter((value) => value !== option)
                                : [...selected, option];
                              editAnswer(question.id, next);
                            } else {
                              editAnswer(question.id, option);
                            }
                          }}
                        />
                        <span>{option}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              {submitted && (
                <div className="epub-exam-ai-answer">
                  <strong>AI 参考答案</strong>
                  <p>
                    {Array.isArray(question.answer)
                      ? question.answer.join('、')
                      : question.answer}
                  </p>
                  <strong>解析</strong>
                  <p>{question.explanation}</p>
                </div>
              )}
            </article>
          );
        })}
      </div>
      <footer className="epub-exam-page-footer">
        <span role="status">
          {saveState === 'saving'
            ? '正在保存…'
            : saveState === 'saved'
              ? '已保存到本机'
              : ' '}
        </span>
        {exam.status === 'inProgress' && (
          <button
            type="button"
            className="is-primary"
            onClick={() => void submitExam()}
            disabled={busy}
          >
            {busy
              ? '正在提交…'
              : exam.attempts.length > 0
                ? `提交第 ${exam.attempts.length + 1} 次并查看 AI 答案`
                : '提交并查看 AI 答案'}
          </button>
        )}
      </footer>
    </main>
  );
}
