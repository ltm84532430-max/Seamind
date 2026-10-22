import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { EpubBookDocument } from './library';
import {
  epubProgressKey,
  loadEpubBookMetadata,
  loadEpubReadingActivity,
} from './ebook-storage';
import {
  learningPathBookProgress,
  learningPathId,
  loadLearningPaths,
  saveLearningPaths,
} from './ebook-learning-path';
import type {
  LearningPath,
  LearningPathBook,
  LearningPathStage,
} from './ebook-learning-path';

function move<T>(items: T[], index: number, direction: -1 | 1) {
  const next = [...items];
  const other = index + direction;
  if (other < 0 || other >= next.length) return next;
  [next[index], next[other]] = [next[other], next[index]];
  return next;
}

function formatWords(value: number) {
  return `${new Intl.NumberFormat('zh-CN').format(value)} 字`;
}

function BookCover({
  title,
  coverDataUrl,
}: {
  title: string;
  coverDataUrl?: string;
}) {
  return (
    <span className="ebook-paths-book-cover">
      {coverDataUrl ? (
        <img src={coverDataUrl} alt={`${title}封面`} />
      ) : (
        <span
          className="ebook-paths-book-cover-fallback"
          role="img"
          aria-label={`${title}书名封面`}
        >
          <small>EPUB</small>
          <strong>{title}</strong>
          <i>SEAMIND</i>
        </span>
      )}
    </span>
  );
}

export default function EbookLearningPaths({
  rootPath,
  books,
  onOpenBook,
}: {
  rootPath: string;
  books: EpubBookDocument[];
  onOpenBook: (book: EpubBookDocument) => void;
}) {
  const [paths, setPaths] = useState(() => loadLearningPaths(rootPath));
  const [selectedId, setSelectedId] = useState('');
  const [newPathTitle, setNewPathTitle] = useState('');
  const [newStageTitle, setNewStageTitle] = useState('');
  const [addingBookStageId, setAddingBookStageId] = useState('');
  const [bookKey, setBookKey] = useState('');
  const [targetWords, setTargetWords] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [editingBookId, setEditingBookId] = useState('');
  const [manualWords, setManualWords] = useState('');
  const [renamingId, setRenamingId] = useState('');
  const [renameTitle, setRenameTitle] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setPaths(loadLearningPaths(rootPath));
    setSelectedId('');
    setAddingBookStageId('');
    setEditingBookId('');
  }, [rootPath]);

  const bookChoices = useMemo(
    () =>
      books.map((book) => {
        const key = epubProgressKey(book);
        const metadata = loadEpubBookMetadata(key);
        const activity = loadEpubReadingActivity(key);
        return {
          book,
          key,
          title: metadata?.title || book.title,
          metadata,
          activity,
        };
      }),
    [books],
  );
  const byKey = useMemo(
    () => new Map(bookChoices.map((choice) => [choice.key, choice])),
    [bookChoices],
  );
  const selected = paths.find((path) => path.id === selectedId) ?? paths[0];

  const commit = (next: LearningPath[]) => {
    if (!saveLearningPaths(rootPath, next)) {
      setError('本地存储不可用，修改未保存。');
      return false;
    }
    setPaths(next);
    setError('');
    return true;
  };
  const updateSelected = (update: (path: LearningPath) => LearningPath) => {
    if (!selected) return false;
    return commit(
      paths.map((path) => (path.id === selected.id ? update(path) : path)),
    );
  };
  const updateStage = (
    stageId: string,
    update: (stage: LearningPathStage) => LearningPathStage,
  ) =>
    updateSelected((path) => ({
      ...path,
      stages: path.stages.map((stage) =>
        stage.id === stageId ? update(stage) : stage,
      ),
    }));

  const createPath = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = newPathTitle.trim();
    if (!title) return;
    const path: LearningPath = {
      id: learningPathId(),
      title: title.slice(0, 120),
      stages: [],
      createdAt: Date.now(),
    };
    if (commit([...paths, path])) {
      setSelectedId(path.id);
      setNewPathTitle('');
    }
  };

  const createStage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = newStageTitle.trim();
    if (!title) return;
    if (
      updateSelected((path) => ({
        ...path,
        stages: [
          ...path.stages,
          { id: learningPathId(), title: title.slice(0, 120), books: [] },
        ],
      }))
    )
      setNewStageTitle('');
  };

  const openBookEditor = (stageId: string) => {
    setAddingBookStageId(stageId);
    setEditingBookId('');
    setBookKey('');
    setTargetWords('');
    setDueDate('');
  };

  const selectBook = (key: string) => {
    setBookKey(key);
    const choice = byKey.get(key);
    const remaining = choice?.activity?.estimatedTotalWords
      ? Math.round(
          choice.activity.estimatedTotalWords *
            (1 -
              Math.max(
                choice.activity.furthestProgress,
                choice.metadata?.progress ?? 0,
              )),
        )
      : 0;
    setTargetWords(remaining > 0 ? String(remaining) : '');
  };

  const addBook = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const choice = byKey.get(bookKey);
    const target = Number(targetWords);
    if (
      !choice ||
      !Number.isSafeInteger(target) ||
      target < 1 ||
      target > 100_000_000
    )
      return;
    if (
      selected.stages.some((stage) =>
        stage.books.some((book) => book.progressKey === bookKey),
      )
    ) {
      setError('这本书已经在当前阅读路径中。');
      return;
    }
    const entry: LearningPathBook = {
      id: learningPathId(),
      progressKey: bookKey,
      title: choice.title,
      targetWords: target,
      baselineProgress: Math.max(
        choice.metadata?.progress ?? 0,
        choice.activity?.furthestProgress ?? 0,
      ),
      manualWords: 0,
      dueDate,
    };
    if (
      updateStage(addingBookStageId, (stage) => ({
        ...stage,
        books: [...stage.books, entry],
      }))
    )
      setAddingBookStageId('');
  };

  const saveBookEdit = (
    event: FormEvent<HTMLFormElement>,
    stageId: string,
    entry: LearningPathBook,
  ) => {
    event.preventDefault();
    const target = Number(targetWords);
    const completed = Number(manualWords);
    if (
      !Number.isSafeInteger(target) ||
      target < 1 ||
      target > 100_000_000 ||
      !Number.isSafeInteger(completed) ||
      completed < 0 ||
      completed > 100_000_000
    )
      return;
    if (
      updateStage(stageId, (stage) => ({
        ...stage,
        books: stage.books.map((book) =>
          book.id === entry.id
            ? { ...book, targetWords: target, manualWords: completed, dueDate }
            : book,
        ),
      }))
    )
      setEditingBookId('');
  };

  const rename = (event: FormEvent<HTMLFormElement>, stageId?: string) => {
    event.preventDefault();
    const title = renameTitle.trim().slice(0, 120);
    if (!title) return;
    const saved = stageId
      ? updateStage(stageId, (stage) => ({ ...stage, title }))
      : updateSelected((path) => ({ ...path, title }));
    if (saved) setRenamingId('');
  };

  const moveBookToStage = (
    stageIndex: number,
    entry: LearningPathBook,
    direction: -1 | 1,
  ) => {
    const destinationIndex = stageIndex + direction;
    updateSelected((path) => ({
      ...path,
      stages: path.stages.map((stage, index) => {
        if (index === stageIndex)
          return {
            ...stage,
            books: stage.books.filter((book) => book.id !== entry.id),
          };
        if (index === destinationIndex)
          return {
            ...stage,
            books:
              direction < 0 ? [...stage.books, entry] : [entry, ...stage.books],
          };
        return stage;
      }),
    }));
  };

  const allEntries = selected?.stages.flatMap((stage) => stage.books) ?? [];
  const totalWords = allEntries.reduce(
    (sum, book) => sum + book.targetWords,
    0,
  );
  const completedWords = allEntries.reduce((sum, book) => {
    const choice = byKey.get(book.progressKey);
    return (
      sum +
      learningPathBookProgress(
        book,
        choice?.metadata ?? null,
        choice?.activity ?? null,
      ).completedWords
    );
  }, 0);
  const nextBookId = allEntries.find((book) => {
    const choice = byKey.get(book.progressKey);
    return (
      learningPathBookProgress(
        book,
        choice?.metadata ?? null,
        choice?.activity ?? null,
      ).completedWords < book.targetWords
    );
  })?.id;
  let sequence = 0;

  return (
    <section className="ebook-paths" aria-label="技能阅读路径">
      <div className="ebook-paths-sidebar">
        <div className="ebook-paths-heading">
          <span>READING · PATHS</span>
          <h2>技能阅读路径</h2>
          <p>把多本书编成阶段，按顺序推进。</p>
        </div>
        <form className="ebook-paths-create" onSubmit={createPath}>
          <label htmlFor="ebook-path-new-title">新建技能目标</label>
          <div>
            <input
              id="ebook-path-new-title"
              value={newPathTitle}
              onChange={(event) => setNewPathTitle(event.target.value)}
              maxLength={120}
              placeholder="例如：系统学习机器学习"
              required
            />
            <button type="submit">创建</button>
          </div>
        </form>
        <nav className="ebook-paths-list" aria-label="技能目标列表">
          {paths.map((path) => {
            const count = path.stages.reduce(
              (sum, stage) => sum + stage.books.length,
              0,
            );
            const firstBook = path.stages.flatMap((stage) => stage.books)[0];
            const firstCover = firstBook
              ? byKey.get(firstBook.progressKey)?.metadata?.coverDataUrl
              : undefined;
            return (
              <button
                key={path.id}
                type="button"
                className={path.id === selected?.id ? 'is-active' : ''}
                aria-current={path.id === selected?.id ? 'page' : undefined}
                onClick={() => {
                  setSelectedId(path.id);
                  setAddingBookStageId('');
                  setEditingBookId('');
                }}
              >
                <BookCover
                  title={firstBook?.title || path.title}
                  coverDataUrl={firstCover}
                />
                <span className="ebook-paths-list-label">
                  <strong>{path.title}</strong>
                  <small>
                    {path.stages.length} 阶段 · {count} 本书
                  </small>
                </span>
              </button>
            );
          })}
        </nav>
      </div>

      <div className="ebook-paths-main">
        {error && (
          <p className="ebook-paths-error" role="alert">
            {error}
          </p>
        )}
        {selected ? (
          <>
            <header className="ebook-paths-summary">
              <div>
                <span>SKILL MAP · {selected.stages.length} STAGES</span>
                {renamingId === `path:${selected.id}` ? (
                  <form
                    className="ebook-paths-rename"
                    onSubmit={(event) => rename(event)}
                  >
                    <input
                      autoFocus
                      value={renameTitle}
                      maxLength={120}
                      required
                      onChange={(event) => setRenameTitle(event.target.value)}
                      aria-label="技能目标名称"
                    />
                    <button type="submit">保存</button>
                    <button type="button" onClick={() => setRenamingId('')}>
                      取消
                    </button>
                  </form>
                ) : (
                  <h2>{selected.title}</h2>
                )}
                <p>
                  {allEntries.length} 本书 · 已规划 {formatWords(totalWords)}
                </p>
              </div>
              <details className="ebook-paths-options">
                <summary>路径管理</summary>
                <div className="ebook-paths-row-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setRenamingId(`path:${selected.id}`);
                      setRenameTitle(selected.title);
                    }}
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    className="ebook-paths-delete"
                    onClick={() => {
                      if (
                        !window.confirm(
                          `删除「${selected.title}」及其中的阅读阶段？`,
                        )
                      )
                        return;
                      if (
                        commit(paths.filter((path) => path.id !== selected.id))
                      )
                        setSelectedId('');
                    }}
                  >
                    删除路径
                  </button>
                </div>
              </details>
            </header>
            <div className="ebook-paths-total">
              <span>路径进度</span>
              <strong>
                {formatWords(completedWords)} / {formatWords(totalWords)}
              </strong>
              <div
                className="ebook-paths-meter"
                role="progressbar"
                aria-label="路径阅读进度"
                aria-valuemin={0}
                aria-valuemax={totalWords || 1}
                aria-valuenow={completedWords}
              >
                <i
                  style={{
                    width: `${totalWords ? Math.round((completedWords / totalWords) * 100) : 0}%`,
                  }}
                />
              </div>
              <small>EPUB 字数为估算；每本书也可手动填写已读字数。</small>
            </div>
            <ol className="ebook-paths-tree">
              {selected.stages.map((stage, stageIndex) => (
                <li className="ebook-paths-stage" key={stage.id}>
                  <div className="ebook-paths-stage-head">
                    <span className="ebook-paths-node">
                      {String(stageIndex + 1).padStart(2, '0')}
                    </span>
                    <div>
                      {renamingId === `stage:${stage.id}` ? (
                        <form
                          className="ebook-paths-rename"
                          onSubmit={(event) => rename(event, stage.id)}
                        >
                          <input
                            autoFocus
                            value={renameTitle}
                            maxLength={120}
                            required
                            onChange={(event) =>
                              setRenameTitle(event.target.value)
                            }
                            aria-label="阶段名称"
                          />
                          <button type="submit">保存</button>
                          <button
                            type="button"
                            onClick={() => setRenamingId('')}
                          >
                            取消
                          </button>
                        </form>
                      ) : (
                        <h3>{stage.title}</h3>
                      )}
                      <small>{stage.books.length} 本书</small>
                    </div>
                    <details className="ebook-paths-options">
                      <summary>阶段管理</summary>
                      <div className="ebook-paths-row-actions">
                        <button
                          type="button"
                          aria-label={`重命名阶段 ${stage.title}`}
                          onClick={() => {
                            setRenamingId(`stage:${stage.id}`);
                            setRenameTitle(stage.title);
                          }}
                        >
                          改名
                        </button>
                        <button
                          type="button"
                          disabled={stageIndex === 0}
                          aria-label={`上移阶段 ${stage.title}`}
                          onClick={() =>
                            updateSelected((path) => ({
                              ...path,
                              stages: move(path.stages, stageIndex, -1),
                            }))
                          }
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={stageIndex === selected.stages.length - 1}
                          aria-label={`下移阶段 ${stage.title}`}
                          onClick={() =>
                            updateSelected((path) => ({
                              ...path,
                              stages: move(path.stages, stageIndex, 1),
                            }))
                          }
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          aria-label={`删除阶段 ${stage.title}`}
                          onClick={() => {
                            if (
                              stage.books.length &&
                              !window.confirm(
                                `删除「${stage.title}」及其中 ${stage.books.length} 本书？`,
                              )
                            )
                              return;
                            updateSelected((path) => ({
                              ...path,
                              stages: path.stages.filter(
                                (item) => item.id !== stage.id,
                              ),
                            }));
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </details>
                  </div>
                  <ol className="ebook-paths-books">
                    {stage.books.map((entry, bookIndex) => {
                      sequence += 1;
                      const choice = byKey.get(entry.progressKey);
                      const progress = learningPathBookProgress(
                        entry,
                        choice?.metadata ?? null,
                        choice?.activity ?? null,
                      );
                      const done = progress.completedWords >= entry.targetWords;
                      return (
                        <li
                          className={`ebook-paths-book${done ? ' is-done' : ''}${entry.id === nextBookId ? ' is-next' : ''}`}
                          key={entry.id}
                        >
                          <span className="ebook-paths-book-order">
                            {String(sequence).padStart(2, '0')}
                          </span>
                          <BookCover
                            title={choice?.title || entry.title}
                            coverDataUrl={choice?.metadata?.coverDataUrl}
                          />
                          <div className="ebook-paths-book-body">
                            <div className="ebook-paths-book-title">
                              <strong>{choice?.title || entry.title}</strong>
                              <span>
                                {done
                                  ? '已完成'
                                  : entry.id === nextBookId
                                    ? '下一本'
                                    : '待阅读'}
                              </span>
                            </div>
                            <p>
                              {formatWords(progress.completedWords)} /{' '}
                              {formatWords(entry.targetWords)}
                              {entry.dueDate ? ` · 目标 ${entry.dueDate}` : ''}
                              {!choice ? ' · 书籍已移出书架' : ''}
                            </p>
                            {choice && !progress.estimatedWords && (
                              <p>
                                打开书籍后将尝试估算字数；也可以手动填写已读字数。
                              </p>
                            )}
                            <div
                              className="ebook-paths-meter"
                              role="progressbar"
                              aria-label={`${entry.title}计划字数进度`}
                              aria-valuemin={0}
                              aria-valuemax={entry.targetWords}
                              aria-valuenow={progress.completedWords}
                            >
                              <i
                                style={{
                                  width: `${Math.round((progress.completedWords / entry.targetWords) * 100)}%`,
                                }}
                              />
                            </div>
                            {editingBookId === entry.id && (
                              <form
                                className="ebook-paths-book-editor"
                                onSubmit={(event) =>
                                  saveBookEdit(event, stage.id, entry)
                                }
                              >
                                <label>
                                  计划字数
                                  <input
                                    type="number"
                                    min="1"
                                    max="100000000"
                                    step="1"
                                    required
                                    value={targetWords}
                                    onChange={(event) =>
                                      setTargetWords(event.target.value)
                                    }
                                  />
                                </label>
                                <label>
                                  手动已读
                                  <input
                                    type="number"
                                    min="0"
                                    max="100000000"
                                    step="1"
                                    required
                                    value={manualWords}
                                    onChange={(event) =>
                                      setManualWords(event.target.value)
                                    }
                                  />
                                </label>
                                <label>
                                  目标日期
                                  <input
                                    type="date"
                                    value={dueDate}
                                    onChange={(event) =>
                                      setDueDate(event.target.value)
                                    }
                                  />
                                </label>
                                <button type="submit">保存</button>
                                <button
                                  type="button"
                                  onClick={() => setEditingBookId('')}
                                >
                                  取消
                                </button>
                                <small>
                                  实际完成数取手动值与 EPUB 阅读估算中的较大值。
                                </small>
                              </form>
                            )}
                          </div>
                          <div className="ebook-paths-row-actions">
                            {choice && (
                              <button
                                type="button"
                                onClick={() => onOpenBook(choice.book)}
                              >
                                阅读
                              </button>
                            )}
                            <details className="ebook-paths-options">
                              <summary>管理</summary>
                              <div className="ebook-paths-row-actions">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingBookId(entry.id);
                                    setAddingBookStageId('');
                                    setTargetWords(String(entry.targetWords));
                                    setManualWords(String(entry.manualWords));
                                    setDueDate(entry.dueDate);
                                  }}
                                >
                                  编辑
                                </button>
                                <button
                                  type="button"
                                  disabled={bookIndex === 0}
                                  aria-label={`上移书籍 ${entry.title}`}
                                  onClick={() =>
                                    updateStage(stage.id, (value) => ({
                                      ...value,
                                      books: move(value.books, bookIndex, -1),
                                    }))
                                  }
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    bookIndex === stage.books.length - 1
                                  }
                                  aria-label={`下移书籍 ${entry.title}`}
                                  onClick={() =>
                                    updateStage(stage.id, (value) => ({
                                      ...value,
                                      books: move(value.books, bookIndex, 1),
                                    }))
                                  }
                                >
                                  ↓
                                </button>
                                <button
                                  type="button"
                                  disabled={stageIndex === 0}
                                  aria-label={`将 ${entry.title} 移至上一阶段`}
                                  onClick={() =>
                                    moveBookToStage(stageIndex, entry, -1)
                                  }
                                >
                                  移至上阶段
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    stageIndex === selected.stages.length - 1
                                  }
                                  aria-label={`将 ${entry.title} 移至下一阶段`}
                                  onClick={() =>
                                    moveBookToStage(stageIndex, entry, 1)
                                  }
                                >
                                  移至下阶段
                                </button>
                                <button
                                  type="button"
                                  aria-label={`从路径移除 ${entry.title}`}
                                  onClick={() =>
                                    updateStage(stage.id, (value) => ({
                                      ...value,
                                      books: value.books.filter(
                                        (book) => book.id !== entry.id,
                                      ),
                                    }))
                                  }
                                >
                                  移除
                                </button>
                              </div>
                            </details>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                  {addingBookStageId === stage.id ? (
                    <form className="ebook-paths-add-book" onSubmit={addBook}>
                      <label>
                        选择书籍
                        <select
                          required
                          value={bookKey}
                          onChange={(event) => selectBook(event.target.value)}
                        >
                          <option value="">选择书架中的 EPUB</option>
                          {bookChoices
                            .filter(
                              (choice) =>
                                !allEntries.some(
                                  (entry) => entry.progressKey === choice.key,
                                ),
                            )
                            .map((choice) => (
                              <option key={choice.key} value={choice.key}>
                                {choice.title}
                              </option>
                            ))}
                        </select>
                      </label>
                      {byKey.get(bookKey) && (
                        <div className="ebook-paths-book-preview">
                          <BookCover
                            title={byKey.get(bookKey)!.title}
                            coverDataUrl={
                              byKey.get(bookKey)!.metadata?.coverDataUrl
                            }
                          />
                          <span>{byKey.get(bookKey)!.title}</span>
                        </div>
                      )}
                      <label>
                        计划字数
                        <input
                          type="number"
                          min="1"
                          max="100000000"
                          step="1"
                          required
                          value={targetWords}
                          onChange={(event) =>
                            setTargetWords(event.target.value)
                          }
                          placeholder="输入本阶段计划阅读字数"
                        />
                      </label>
                      <label>
                        目标日期
                        <input
                          type="date"
                          value={dueDate}
                          onChange={(event) => setDueDate(event.target.value)}
                        />
                      </label>
                      <button type="submit">加入路径</button>
                      <button
                        type="button"
                        onClick={() => setAddingBookStageId('')}
                      >
                        取消
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="ebook-paths-add"
                      onClick={() => openBookEditor(stage.id)}
                      disabled={!books.length}
                    >
                      ＋ 添加书籍
                    </button>
                  )}
                </li>
              ))}
            </ol>
            <form className="ebook-paths-add-stage" onSubmit={createStage}>
              <label htmlFor="ebook-path-stage-title">添加阅读阶段</label>
              <input
                id="ebook-path-stage-title"
                value={newStageTitle}
                onChange={(event) => setNewStageTitle(event.target.value)}
                maxLength={120}
                placeholder="例如：基础概念 → 实战应用"
                required
              />
              <button type="submit">添加阶段</button>
            </form>
          </>
        ) : (
          <div className="ebook-paths-empty">
            <h2>从一个技能目标开始</h2>
            <p>
              创建路径后，添加阶段，再从书架选择书籍并设定计划字数和阅读顺序。
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
