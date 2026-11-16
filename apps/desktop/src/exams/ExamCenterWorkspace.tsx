import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EpubBookDocument } from '../library/library';
import { findStoredCoverByBookKey } from '../ebook/ebook-storage';
import type { EpubExamSummary } from './epub-exams';
import { listEpubExams } from './epub-exams';
import { EpubExamWorkspace } from './EpubExamWorkspace';
import { ExamGraphView } from './ExamGraphView';
import { ExamReviewCurve } from './ExamReviewCurve';
import { ExamScrollMinimap } from './ExamScrollMinimap';
import { reviewUrgencyRank, scheduleExamReview } from './review-schedule';
import type { ExamReviewSchedule } from './review-schedule';
import './exam-center.css';

type ViewFilter =
  'all' | 'overdue' | 'today' | 'mastered' | 'upcoming' | 'inProgress';
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

function difficultyLabel(value?: string): string {
  if (value === 'easy') return '易';
  if (value === 'hard') return '难';
  return '中';
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

  const dueCount = useMemo(
    () =>
      entries.filter(
        ({ schedule }) =>
          schedule.urgency === 'overdue' || schedule.urgency === 'today',
      ).length,
    [entries],
  );

  useEffect(() => onDueCountChange(dueCount), [dueCount, onDueCountChange]);

  const totalQuestions = useMemo(
    () => exams.reduce((sum, e) => sum + e.questionCount, 0),
    [exams],
  );

  const overdueCount = useMemo(
    () => entries.filter((item) => item.schedule.urgency === 'overdue').length,
    [entries],
  );

  const todayCount = useMemo(
    () => entries.filter((item) => item.schedule.urgency === 'today').length,
    [entries],
  );

  const upcomingCount = useMemo(
    () => entries.filter((item) => item.schedule.urgency === 'upcoming').length,
    [entries],
  );

  const inProgressCount = useMemo(
    () => entries.filter((item) => item.exam.status === 'inProgress').length,
    [entries],
  );

  const retentionStats = useMemo(() => {
    const submitted = entries.filter((e) => e.exam.status === 'submitted');
    if (!submitted.length) {
      return { rate: 100, label: '尚未交卷', status: 'normal' };
    }
    const healthy = submitted.filter((e) => e.schedule.urgency !== 'overdue');
    const rate = Math.round((healthy.length / submitted.length) * 100);
    return {
      rate,
      label: rate >= 85 ? '稳固留存' : rate >= 65 ? '健康良好' : '需攻坚',
      status: rate >= 85 ? 'great' : rate >= 65 ? 'good' : 'warning',
    };
  }, [entries]);

  const estimatedWorkloadMinutes = useMemo(() => {
    const dueExams = entries.filter(
      (e) => e.schedule.urgency === 'overdue' || e.schedule.urgency === 'today',
    );
    const qCount = dueExams.reduce((sum, e) => sum + e.exam.questionCount, 0);
    return Math.max(dueExams.length ? 5 : 0, Math.round(qCount * 1.5));
  }, [entries]);

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
        if (filter === 'overdue' && schedule.urgency !== 'overdue')
          return false;
        if (filter === 'today' && schedule.urgency !== 'today') return false;
        if (filter === 'mastered' && exam.status !== 'submitted') return false;
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
          <h1>试卷</h1>
          <span>按书、到期和掌握查看</span>
        </div>
        <div className="exam-center-header-actions">
          {dueCount > 0 && (
            <button
              type="button"
              className="exam-center-sprint-btn"
              onClick={() => {
                const mostUrgent = visible.find(
                  (e) =>
                    e.schedule.urgency === 'overdue' ||
                    e.schedule.urgency === 'today',
                );
                if (mostUrgent) {
                  setSelectedId(mostUrgent.exam.id);
                  setOpenedExam(mostUrgent.exam);
                }
              }}
              title="直接开始作答今天最紧迫的试卷"
            >
              <span>开始今日待交 ({dueCount})</span>
            </button>
          )}
          <button
            type="button"
            className="exam-refresh-btn"
            onClick={() => void refresh()}
            disabled={loading}
          >
            刷新
          </button>
          <button
            type="button"
            className="exam-shelf-btn"
            onClick={onOpenShelf}
          >
            前往电子书
          </button>
        </div>
      </header>

      <section className="exam-center-summary" aria-label="试卷筛选">
        <button
          type="button"
          className={`exam-summary-card ${filter === 'all' ? 'is-active' : ''}`}
          aria-pressed={filter === 'all'}
          onClick={() => setFilter('all')}
        >
          <div className="exam-summary-header">
            <span>全部</span>
          </div>
          <strong className="exam-summary-num">{exams.length}</strong>
          <small className="exam-summary-sub">共 {totalQuestions} 题</small>
        </button>

        <button
          type="button"
          className={`exam-summary-card is-danger ${filter === 'overdue' ? 'is-active' : ''}`}
          aria-pressed={filter === 'overdue'}
          onClick={() => setFilter('overdue')}
        >
          <div className="exam-summary-header">
            <span>逾期</span>
          </div>
          <strong className="exam-summary-num text-danger">
            {overdueCount}
          </strong>
          <small className="exam-summary-sub">已过复习日</small>
        </button>

        <button
          type="button"
          className={`exam-summary-card ${filter === 'today' ? 'is-active' : ''}`}
          aria-pressed={filter === 'today'}
          onClick={() => setFilter('today')}
        >
          <div className="exam-summary-header">
            <span>今日到期</span>
          </div>
          <strong className="exam-summary-num">{todayCount}</strong>
          <small className="exam-summary-sub">
            {estimatedWorkloadMinutes
              ? `约 ${estimatedWorkloadMinutes} 分钟`
              : '今日没有待交'}
          </small>
        </button>

        <button
          type="button"
          className={`exam-summary-card ${filter === 'mastered' ? 'is-active' : ''}`}
          aria-pressed={filter === 'mastered'}
          onClick={() => setFilter('mastered')}
        >
          <div className="exam-summary-header">
            <span>掌握</span>
          </div>
          <strong className="exam-summary-num">{retentionStats.rate}%</strong>
          <small className="exam-summary-sub">
            已交{' '}
            {entries.filter((item) => item.exam.status === 'submitted').length}{' '}
            套
          </small>
        </button>

        <button
          type="button"
          className={`exam-summary-card ${filter === 'upcoming' ? 'is-active' : ''}`}
          aria-pressed={filter === 'upcoming'}
          onClick={() => setFilter('upcoming')}
        >
          <div className="exam-summary-header">
            <span>三日内</span>
          </div>
          <strong className="exam-summary-num">{upcomingCount}</strong>
          <small className="exam-summary-sub">即将复习</small>
        </button>
      </section>

      <div className="exam-center-body">
        <aside className="exam-center-filters" aria-label="书籍">
          <div className="exam-filter-section-title">状态</div>
          <button
            type="button"
            className={`exam-filter-btn ${filter === 'inProgress' ? 'is-active' : ''}`}
            aria-pressed={filter === 'inProgress'}
            onClick={() =>
              setFilter((current) =>
                current === 'inProgress' ? 'all' : 'inProgress',
              )
            }
          >
            <span>作答中</span>
            <span className="exam-badge">{inProgressCount}</span>
          </button>

          <div className="exam-filter-section-title">书籍</div>
          <div className="exam-center-book-list" aria-label="按书籍筛选试卷">
            <button
              type="button"
              className={`exam-center-book-row ${!bookFilter ? 'is-active' : ''}`}
              aria-pressed={!bookFilter}
              onClick={() => onBookFilterChange('')}
            >
              <span>全部书籍</span>
              <span className="exam-badge">{exams.length}</span>
            </button>
            {bookGroups.map((group) => {
              const dueRatio = group.count
                ? (group.due / group.count) * 100
                : 0;
              return (
                <button
                  key={group.key}
                  type="button"
                  className={`exam-center-book-row ${graphBookKey === group.key ? 'is-focused' : ''} ${bookFilter === group.key ? 'is-active' : ''}`}
                  aria-pressed={bookFilter === group.key}
                  title={group.title}
                  onClick={() => onBookFilterChange(group.key)}
                >
                  <div className="exam-book-row-main">
                    <span className="exam-book-row-title">{group.title}</span>
                    <span
                      className={`exam-badge ${group.due ? 'is-danger' : ''}`}
                    >
                      {group.due
                        ? `${group.due} / ${group.count}`
                        : group.count}
                    </span>
                  </div>
                  <div className="exam-book-retention-track">
                    <div
                      className={`exam-book-retention-bar ${group.due ? 'has-due' : ''}`}
                      style={{
                        width: `${Math.min(100, Math.max(10, 100 - dueRatio))}%`,
                      }}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* 主舞台：时间雷达 / 机构级数据网格 */}
        <section className="exam-center-list" aria-label="试卷列表">
          <div className="exam-center-list-toolbar">
            <label className="exam-search-label">
              <span className="sr-only">搜索试卷</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索章节标题、书籍或关键词…"
              />
            </label>
            <div className="exam-center-view-switch" aria-label="试卷视图">
              <button
                type="button"
                className={viewMode === 'graph' ? 'is-active' : ''}
                aria-pressed={viewMode === 'graph'}
                onClick={() => setViewMode('graph')}
              >
                星系
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
            <span className="exam-count-pill">{visible.length} 份试卷</span>
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
            <p className="exam-center-empty">正在加载试卷…</p>
          ) : viewMode === 'graph' && bookGroups.length ? (
            <ExamGraphView
              mode={bookFilter ? 'book' : 'library'}
              bookKey={graphBookKey}
              bookTitle={graphBookTitle}
              coverDataUrl={graphCover}
              items={bookFilter ? graphItems : visible}
              selectedId={selected?.exam.id ?? null}
              onSelectExam={setSelectedId}
              onOpenExam={setOpenedExam}
              onOpenBook={graphBook ? () => onOpenBook(graphBook) : undefined}
              onSelectBookFilter={onBookFilterChange}
            />
          ) : !visible.length ? (
            <div className="exam-center-empty">
              <h2>{exams.length ? '没有匹配的试卷' : '还没有试卷'}</h2>
              <p>在电子书里选定章节后可以生成试卷。交卷后会排下一次复习。</p>
              <button type="button" onClick={onOpenShelf}>
                前往电子书阅读器
              </button>
            </div>
          ) : (
            <div className="exam-center-list-surface">
              <div ref={listScrollRef} className="exam-center-list-scroll">
                <div className="exam-center-table" role="table">
                  <div className="exam-center-table-head" role="row">
                    <span>范围</span>
                    <span>书</span>
                    <span>题量</span>
                    <span>轮次</span>
                    <span>到期</span>
                    <span>操作</span>
                  </div>
                  {visible.map(({ exam, schedule }) => (
                    <button
                      type="button"
                      key={exam.id}
                      role="row"
                      className={`exam-center-row ${selected?.exam.id === exam.id ? 'is-selected' : ''}`}
                      onClick={() => setSelectedId(exam.id)}
                      onDoubleClick={() => setOpenedExam(exam)}
                      aria-pressed={selected?.exam.id === exam.id}
                    >
                      <span className="exam-row-title">
                        {exam.sourceSectionLabel || exam.bookTitle}
                      </span>
                      <span>{exam.bookTitle}</span>
                      <span>{exam.questionCount}</span>
                      <span>
                        {schedule.completedRounds > 0
                          ? `${schedule.completedRounds} 轮`
                          : '未交'}
                      </span>
                      <span
                        className={
                          schedule.urgency === 'overdue' ? 'is-overdue' : ''
                        }
                      >
                        {schedule.dueAt ? urgencyLabel(schedule) : '待交卷'}
                      </span>
                      <span
                        className="exam-row-action-link"
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpenedExam(exam);
                        }}
                      >
                        {exam.status === 'inProgress' ? '继续' : '打开'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <ExamScrollMinimap
                scrollRef={listScrollRef}
                label="试卷列表缩略导航"
              />
            </div>
          )}
        </section>

        {/* 右侧：试卷全景透视与记忆衰减引擎 */}
        <aside className="exam-center-detail" aria-label="试卷详情">
          {selected ? (
            <>
              <div className="exam-center-detail-heading">
                <span className="exam-detail-kicker">本卷</span>
                <span
                  className={`exam-center-urgency-badge${selected.schedule.urgency === 'overdue' ? ' is-overdue' : ''}`}
                >
                  {urgencyLabel(selected.schedule)}
                </span>
              </div>
              <h2 className="exam-detail-title">
                {selected.exam.sourceSectionLabel || selected.exam.bookTitle}
              </h2>
              <p className="exam-center-detail-book">
                《{selected.exam.bookTitle}》
              </p>

              <div className="exam-stat-grid">
                <div className="exam-stat-cell">
                  <span>题量</span>
                  <strong>
                    {selected.exam.questionCount} <small>题</small>
                  </strong>
                </div>
                <div className="exam-stat-cell">
                  <span>掌握</span>
                  <strong>
                    {selected.exam.status === 'submitted'
                      ? `${selected.exam.masteredCount ?? 0}`
                      : '—'}{' '}
                    <small>/ {selected.exam.questionCount}</small>
                  </strong>
                </div>
                <div className="exam-stat-cell">
                  <span>间隔</span>
                  <strong>
                    {selected.schedule.intervalDays
                      ? `${selected.schedule.intervalDays}`
                      : '—'}{' '}
                    <small>天</small>
                  </strong>
                </div>
                <div className="exam-stat-cell">
                  <span>到期</span>
                  <strong>
                    {selected.schedule.dueAt
                      ? formatDay(selected.schedule.dueAt).slice(5)
                      : '—'}
                  </strong>
                </div>
              </div>

              <div className="exam-center-detail-actions">
                <button
                  type="button"
                  className="is-primary exam-btn-primary"
                  onClick={() => setOpenedExam(selected.exam)}
                >
                  <span>
                    {selected.exam.status === 'inProgress'
                      ? '继续作答'
                      : '打开试卷'}
                  </span>
                </button>
                <button
                  type="button"
                  className="exam-btn-secondary"
                  disabled={!selectedBook}
                  onClick={() => selectedBook && onOpenBook(selectedBook)}
                >
                  <span>对照原文</span>
                </button>
              </div>

              <dl className="exam-detail-props-list">
                <div>
                  <dt>上次交卷时间</dt>
                  <dd>{formatDay(selected.exam.lastCompletedAt ?? null)}</dd>
                </div>
                <div>
                  <dt>计划复习日期</dt>
                  <dd>{formatDay(selected.schedule.dueAt)}</dd>
                </div>
                <div>
                  <dt>当前距到期</dt>
                  <dd>
                    {selected.schedule.daysUntil !== null
                      ? selected.schedule.daysUntil < 0
                        ? `逾期 ${Math.abs(selected.schedule.daysUntil)} 天`
                        : selected.schedule.daysUntil === 0
                          ? '今日到期'
                          : `还剩 ${selected.schedule.daysUntil} 天`
                      : '—'}
                  </dd>
                </div>
                {selected.exam.difficulty && (
                  <div>
                    <dt>难度</dt>
                    <dd>{difficultyLabel(selected.exam.difficulty)}</dd>
                  </div>
                )}
              </dl>

              <section className="exam-center-curve-panel">
                <div className="exam-curve-header">
                  <h3>复习间隔</h3>
                </div>
                <ExamReviewCurve
                  schedule={selected.schedule}
                  now={now}
                  lastCompletedAt={selected.exam.lastCompletedAt}
                />
                <p className="exam-center-interval-note">
                  掌握后间隔按 1、3、7、14、30、60 天延长；未掌握则回到 1 天。
                </p>
              </section>
            </>
          ) : (
            <div className="exam-center-empty">
              <p>选择一份试卷，查看题量、间隔和到期。</p>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
