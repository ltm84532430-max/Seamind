import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EpubBookDocument } from '../library/library';
import { findStoredCoverByBookKey } from '../ebook/ebook-storage';
import type { EpubExamSummary } from './epub-exams';
import { listEpubExams } from './epub-exams';
import { EpubExamWorkspace } from './EpubExamWorkspace';
import { ExamGraphView } from './ExamGraphView';
import { ExamScrollMinimap } from './ExamScrollMinimap';
import {
  reviewCurvePoints,
  reviewUrgencyRank,
  scheduleExamReview,
} from './review-schedule';
import type { ExamReviewSchedule } from './review-schedule';
import './exam-center.css';

type ViewFilter = 'all' | 'due' | 'upcoming' | 'inProgress';
type ViewMode = 'graph' | 'list';

interface Props {
  active: boolean;
  provider: { baseUrl: string; model: string };
  books: EpubBookDocument[];
  libraryRoot: string;
  bookFilter: string;
  onBookFilterChange: (bookKey: string) => void;
  onOpenShelf: () => void;
  onOpenBook: (book: EpubBookDocument) => void;
  onDueCountChange: (count: number) => void;
}

function formatDay(timestamp: number | null): string {
  if (!timestamp) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(timestamp);
}

function urgencyLabel(schedule: ExamReviewSchedule): string {
  switch (schedule.urgency) {
    case 'overdue':
      return `逾期 ${Math.abs(schedule.daysUntil ?? 0)} 天`;
    case 'today':
      return '今天复习';
    case 'inProgress':
      return '重做进行中';
    case 'upcoming':
      return `${schedule.daysUntil} 天后复习`;
    case 'later':
      return `${schedule.daysUntil} 天后复习`;
    case 'notStarted':
      return '尚未交卷';
  }
}

function ReviewCurve({
  schedule,
  now,
  lastCompletedAt,
}: {
  schedule: ExamReviewSchedule;
  now: number;
  lastCompletedAt?: number | null;
}) {
  if (!schedule.intervalDays || !lastCompletedAt) {
    return (
      <p className="exam-center-curve-empty">完成首轮试卷后显示复习节奏。</p>
    );
  }
  const points = reviewCurvePoints(schedule.intervalDays);
  const line = points
    .map(
      (point, index) =>
        `${index ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`,
    )
    .join(' ');
  const elapsedDays = Math.max(0, (now - lastCompletedAt) / 86_400_000);
  const markerX = Math.min(
    280,
    (elapsedDays / (schedule.intervalDays * 2)) * 280,
  );
  const markerY = Math.min(
    112,
    (112 * (1 - Math.pow(0.8, elapsedDays / schedule.intervalDays))) / 0.36,
  );
  return (
    <div className="exam-center-curve">
      <svg
        role="img"
        aria-label={`复习节奏示意：第 ${schedule.intervalDays} 天到期`}
        viewBox="0 0 300 142"
        preserveAspectRatio="none"
      >
        <line
          x1="0"
          y1="62"
          x2="280"
          y2="62"
          className="exam-center-curve-threshold"
        />
        <line
          x1="140"
          y1="0"
          x2="140"
          y2="112"
          className="exam-center-curve-due"
        />
        <path d={line} className="exam-center-curve-line" />
        <circle
          cx={markerX}
          cy={markerY}
          r="4"
          className="exam-center-curve-marker"
        />
        <text x="0" y="136">
          上次交卷
        </text>
        <text x="125" y="136">
          建议复习
        </text>
        <text x="246" y="136">
          后续
        </text>
      </svg>
      <p>排程示意，不代表实测记忆率。交卷与自评会更新下一次日期。</p>
    </div>
  );
}

export default function ExamCenterWorkspace({
  active,
  provider,
  books,
  libraryRoot,
  bookFilter,
  onBookFilterChange,
  onOpenShelf,
  onOpenBook,
  onDueCountChange,
}: Props) {
  const [exams, setExams] = useState<EpubExamSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<ViewFilter>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('graph');
  const listScrollRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openedExam, setOpenedExam] = useState<EpubExamSummary | null>(null);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setExams(await listEpubExams());
    } catch (cause) {
      setExams([]);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, active, libraryRoot]);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 60_000);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  const entries = useMemo(
    () =>
      exams.map((exam) => ({
        exam,
        schedule: scheduleExamReview(exam, now),
      })),
    [exams, now],
  );
  const dueCount = entries.filter(
    ({ schedule }) =>
      schedule.urgency === 'overdue' || schedule.urgency === 'today',
  ).length;
  useEffect(() => onDueCountChange(dueCount), [dueCount, onDueCountChange]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return entries
      .filter(({ exam, schedule }) => {
        if (bookFilter && exam.bookKey !== bookFilter) return false;
        if (
          needle &&
          !`${exam.bookTitle} ${exam.sourceSectionLabel}`
            .toLocaleLowerCase()
            .includes(needle)
        )
          return false;
        if (
          filter === 'due' &&
          !['overdue', 'today'].includes(schedule.urgency)
        )
          return false;
        if (filter === 'upcoming' && schedule.urgency !== 'upcoming')
          return false;
        if (filter === 'inProgress' && exam.status !== 'inProgress')
          return false;
        return true;
      })
      .sort(
        (left, right) =>
          reviewUrgencyRank(left.schedule.urgency) -
            reviewUrgencyRank(right.schedule.urgency) ||
          (left.schedule.dueAt ?? Number.MAX_SAFE_INTEGER) -
            (right.schedule.dueAt ?? Number.MAX_SAFE_INTEGER) ||
          right.exam.createdAt - left.exam.createdAt,
      );
  }, [entries, bookFilter, filter, query]);
  const bookGroups = useMemo(() => {
    const groups = new Map<
      string,
      { key: string; title: string; count: number; due: number }
    >();
    for (const { exam, schedule } of entries) {
      const group = groups.get(exam.bookKey) ?? {
        key: exam.bookKey,
        title: exam.bookTitle,
        count: 0,
        due: 0,
      };
      group.count += 1;
      if (schedule.urgency === 'overdue' || schedule.urgency === 'today')
        group.due += 1;
      groups.set(exam.bookKey, group);
    }
    return [...groups.values()].sort(
      (left, right) =>
        right.due - left.due || left.title.localeCompare(right.title, 'zh-CN'),
    );
  }, [entries]);
  const selected =
    visible.find(({ exam }) => exam.id === selectedId) ?? visible[0] ?? null;
  const graphBookKey =
    bookFilter || selected?.exam.bookKey || bookGroups[0]?.key || '';
  const graphBook = books.find((book) => book.relativePath === graphBookKey);
  const graphBookTitle =
    bookGroups.find((group) => group.key === graphBookKey)?.title ||
    graphBook?.title ||
    '未选择书籍';
  const graphItems = visible.filter(
    ({ exam }) => exam.bookKey === graphBookKey,
  );
  const graphCover = useMemo(
    () => findStoredCoverByBookKey(graphBookKey),
    [graphBookKey],
  );
  const selectedBook =
    selected &&
    books.find((book) => book.relativePath === selected.exam.bookKey);

  if (openedExam) {
    return (
      <EpubExamWorkspace
        key={openedExam.id}
        provider={provider}
        examId={openedExam.id}
        bookKey={openedExam.bookKey}
        onBack={() => {
          setOpenedExam(null);
          void refresh();
        }}
      />
    );
  }

  return (
    <main className="exam-center" aria-label="试卷与复习工作区">
      <header className="exam-center-header">
        <div className="exam-center-title">
          <h1>试卷与复习</h1>
          <span>阅读试卷 · 间隔复习</span>
        </div>
        <div className="exam-center-header-actions">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
          >
            刷新
          </button>
          <button type="button" onClick={onOpenShelf}>
            前往电子书
          </button>
        </div>
      </header>
      <section className="exam-center-summary" aria-label="复习概况">
        <div>
          <span>全部试卷</span>
          <strong>{exams.length}</strong>
        </div>
        <div>
          <span>逾期</span>
          <strong>
            {
              entries.filter((item) => item.schedule.urgency === 'overdue')
                .length
            }
          </strong>
        </div>
        <div>
          <span>今日到期</span>
          <strong>
            {entries.filter((item) => item.schedule.urgency === 'today').length}
          </strong>
        </div>
        <div>
          <span>三日内</span>
          <strong>
            {
              entries.filter((item) => item.schedule.urgency === 'upcoming')
                .length
            }
          </strong>
        </div>
      </section>
      <div className="exam-center-body">
        <aside className="exam-center-filters" aria-label="试卷筛选">
          <h2>视图</h2>
          {(
            [
              ['all', '全部试卷'],
              ['due', '现在复习'],
              ['upcoming', '近期到期'],
              ['inProgress', '作答中'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={filter === value ? 'is-active' : ''}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              <span>{label}</span>
              <small>
                {value === 'all'
                  ? exams.length
                  : entries.filter(({ exam, schedule }) =>
                      value === 'due'
                        ? ['overdue', 'today'].includes(schedule.urgency)
                        : value === 'upcoming'
                          ? schedule.urgency === 'upcoming'
                          : exam.status === 'inProgress',
                    ).length}
              </small>
            </button>
          ))}
          <h2>书籍</h2>
          <div className="exam-center-book-list" aria-label="按书籍筛选试卷">
            <button
              type="button"
              className={`exam-center-book-row${!bookFilter ? ' is-active' : ''}`}
              aria-pressed={!bookFilter}
              onClick={() => onBookFilterChange('')}
            >
              <span>全部书籍</span>
              <small>{exams.length}</small>
            </button>
            {bookGroups.map((group) => (
              <button
                key={group.key}
                type="button"
                className={`exam-center-book-row${graphBookKey === group.key ? ' is-focused' : ''}${bookFilter === group.key ? ' is-active' : ''}`}
                aria-pressed={bookFilter === group.key}
                title={group.title}
                onClick={() => onBookFilterChange(group.key)}
              >
                <span>{group.title}</span>
                <small>
                  {group.due ? `${group.due} / ${group.count}` : group.count}
                </small>
              </button>
            ))}
          </div>
        </aside>
        <section className="exam-center-list" aria-label="试卷列表">
          <div className="exam-center-list-toolbar">
            <label>
              <span className="sr-only">搜索试卷</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索书名或章节"
              />
            </label>
            <div className="exam-center-view-switch" aria-label="试卷视图">
              <button
                type="button"
                className={viewMode === 'graph' ? 'is-active' : ''}
                aria-pressed={viewMode === 'graph'}
                onClick={() => setViewMode('graph')}
              >
                关系图
              </button>
              <button
                type="button"
                className={viewMode === 'list' ? 'is-active' : ''}
                aria-pressed={viewMode === 'list'}
                onClick={() => setViewMode('list')}
              >
                列表
              </button>
            </div>
            <span>{visible.length} 份</span>
          </div>
          {error && (
            <p className="exam-center-error" role="alert">
              读取试卷失败：{error}{' '}
              <button type="button" onClick={() => void refresh()}>
                重试
              </button>
            </p>
          )}
          {loading && !exams.length ? (
            <p className="exam-center-empty">正在读取本地试卷…</p>
          ) : viewMode === 'graph' && bookGroups.length ? (
            <ExamGraphView
              bookKey={graphBookKey}
              bookTitle={graphBookTitle}
              coverDataUrl={graphCover}
              items={graphItems}
              selectedId={selected?.exam.id ?? null}
              onSelectExam={setSelectedId}
              onOpenExam={setOpenedExam}
              onOpenBook={graphBook ? () => onOpenBook(graphBook) : undefined}
            />
          ) : !visible.length ? (
            <div className="exam-center-empty">
              <h2>{exams.length ? '没有符合条件的试卷' : '尚无试卷'}</h2>
              <p>
                在电子书阅读器中选定章节后生成试卷，交卷后这里会安排复习日期。
              </p>
              <button type="button" onClick={onOpenShelf}>
                前往电子书
              </button>
            </div>
          ) : (
            <div className="exam-center-list-surface">
              <div ref={listScrollRef} className="exam-center-list-scroll">
                {visible.map(({ exam, schedule }) => (
                  <button
                    type="button"
                    key={exam.id}
                    className={`exam-center-row ${selected?.exam.id === exam.id ? 'is-selected' : ''}`}
                    onClick={() => setSelectedId(exam.id)}
                    aria-pressed={selected?.exam.id === exam.id}
                  >
                    <span className="exam-center-row-heading">
                      <strong>
                        {exam.sourceSectionLabel || exam.bookTitle}
                      </strong>
                      <em
                        className={`exam-center-urgency is-${schedule.urgency}`}
                      >
                        {urgencyLabel(schedule)}
                      </em>
                    </span>
                    <span className="exam-center-row-book">
                      {exam.bookTitle}
                    </span>
                    <span className="exam-center-row-meta">
                      {exam.questionCount} 题 · {schedule.completedRounds}{' '}
                      次交卷 ·{' '}
                      {schedule.dueAt
                        ? `建议 ${formatDay(schedule.dueAt)}`
                        : '待首次交卷'}
                    </span>
                  </button>
                ))}
              </div>
              <ExamScrollMinimap
                scrollRef={listScrollRef}
                label="试卷列表缩略导航"
              />
            </div>
          )}
        </section>
        <aside className="exam-center-detail" aria-label="试卷详情">
          {selected ? (
            <>
              <div className="exam-center-detail-heading">
                <span>当前试卷</span>
                <em
                  className={`exam-center-urgency is-${selected.schedule.urgency}`}
                >
                  {urgencyLabel(selected.schedule)}
                </em>
              </div>
              <h2>{selected.exam.sourceSectionLabel || '整章试卷'}</h2>
              <p className="exam-center-detail-book">
                {selected.exam.bookTitle}
              </p>
              <dl>
                <div>
                  <dt>题目</dt>
                  <dd>{selected.exam.questionCount} 题</dd>
                </div>
                <div>
                  <dt>交卷轮次</dt>
                  <dd>{selected.schedule.completedRounds}</dd>
                </div>
                <div>
                  <dt>上次交卷</dt>
                  <dd>{formatDay(selected.exam.lastCompletedAt ?? null)}</dd>
                </div>
                <div>
                  <dt>下次复习</dt>
                  <dd>{formatDay(selected.schedule.dueAt)}</dd>
                </div>
                <div>
                  <dt>建议间隔</dt>
                  <dd>
                    {selected.schedule.intervalDays
                      ? `${selected.schedule.intervalDays} 天`
                      : '—'}
                  </dd>
                </div>
              </dl>
              <div className="exam-center-detail-actions">
                <button
                  type="button"
                  className="is-primary"
                  onClick={() => setOpenedExam(selected.exam)}
                >
                  {selected.exam.status === 'inProgress'
                    ? '继续作答'
                    : '打开试卷'}
                </button>
                <button
                  type="button"
                  disabled={!selectedBook}
                  onClick={() => selectedBook && onOpenBook(selectedBook)}
                >
                  打开原书
                </button>
              </div>
              <section className="exam-center-curve-panel">
                <h3>复习节奏</h3>
                <ReviewCurve
                  schedule={selected.schedule}
                  now={now}
                  lastCompletedAt={selected.exam.lastCompletedAt}
                />
              </section>
              <p className="exam-center-method">
                连续掌握良好时建议间隔为 1、3、7、14、30、60
                天；未达到掌握标准时回到 1 天。日期按本机日历计算。
              </p>
            </>
          ) : (
            <p className="exam-center-empty">选择一份试卷查看详情。</p>
          )}
        </aside>
      </div>
    </main>
  );
}
