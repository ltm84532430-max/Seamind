import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EpubBookDocument } from '../library/library';
import { findStoredCoverByBookKey } from '../ebook/ebook-storage';
import type { EpubExamSummary } from './epub-exams';
import { listEpubExams } from './epub-exams';
import { EpubExamWorkspace } from './EpubExamWorkspace';
import { ExamGraphView } from './ExamGraphView';
import { ExamScrollMinimap } from './ExamScrollMinimap';
import { reviewUrgencyRank, scheduleExamReview } from './review-schedule';
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

function memoryTier(schedule: ExamReviewSchedule): {
  tier: string;
  label: string;
  colorClass: string;
} {
  if (schedule.completedRounds === 0) {
    return { tier: 'D', label: '初学期', colorClass: 'tier-d' };
  }
  if (schedule.urgency === 'overdue') {
    return { tier: '!', label: '待救援', colorClass: 'tier-risk' };
  }
  const interval = schedule.intervalDays ?? 1;
  if (interval >= 30) {
    return { tier: 'S', label: '永久强化', colorClass: 'tier-s' };
  }
  if (interval >= 14) {
    return { tier: 'A', label: '稳固体', colorClass: 'tier-a' };
  }
  if (interval >= 7) {
    return { tier: 'B', label: '深化期', colorClass: 'tier-b' };
  }
  if (interval >= 3) {
    return { tier: 'C', label: '成型期', colorClass: 'tier-c' };
  }
  return { tier: 'D', label: '初建期', colorClass: 'tier-d' };
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
      <div className="exam-center-curve-empty">
        <p>尚未记录有效交卷成绩，首轮交卷后将在此激活艾宾浩斯动态留存模型。</p>
      </div>
    );
  }

  const interval = schedule.intervalDays;
  const elapsedDays = Math.max(0, (now - lastCompletedAt) / 86_400_000);
  const totalDaysSpan = Math.max(interval * 2.2, elapsedDays * 1.15, 4);

  const svgWidth = 320;
  const svgHeight = 150;
  const plotLeft = 24;
  const plotRight = 310;
  const plotTop = 18;
  const plotBottom = 120;
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;

  // Ebbinghaus exponential decay: R(t) = exp(-0.22314 * (t / interval))
  const decayRate = 0.22314 / interval;
  const currentRetention = Math.max(
    0.1,
    Math.min(1.0, Math.exp(-decayRate * elapsedDays)),
  );
  const currentPct = Math.round(currentRetention * 100);

  const numSteps = 40;
  const curvePoints: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= numSteps; i += 1) {
    const day = (totalDaysSpan * i) / numSteps;
    const r = Math.exp(-decayRate * day);
    const x = plotLeft + (day / totalDaysSpan) * plotW;
    const y = plotBottom - r * plotH;
    curvePoints.push({ x, y });
  }

  const linePath = curvePoints
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');
  const areaPath = `${linePath} L${plotRight} ${plotBottom} L${plotLeft} ${plotBottom} Z`;

  const markerX = Math.min(
    plotRight,
    plotLeft + (elapsedDays / totalDaysSpan) * plotW,
  );
  const markerY = Math.max(plotTop, plotBottom - currentRetention * plotH);

  const y60 = plotBottom - 0.6 * plotH;
  const y80 = plotBottom - 0.8 * plotH;
  const xDue = Math.min(
    plotRight,
    plotLeft + (interval / totalDaysSpan) * plotW,
  );

  const isOverdue = elapsedDays > interval;

  return (
    <div className="exam-center-curve">
      <svg
        role="img"
        aria-label={`艾宾浩斯复习节奏：当前记忆留存预估 ${currentPct}%`}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="examCurveAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.01" />
          </linearGradient>
        </defs>

        <line
          x1={plotLeft}
          y1={y80}
          x2={plotRight}
          y2={y80}
          className="curve-line-80"
        />
        <text x={plotLeft + 4} y={y80 - 4} className="curve-label-secondary">
          80% 稳固基准
        </text>

        <line
          x1={plotLeft}
          y1={y60}
          x2={plotRight}
          y2={y60}
          className="curve-line-threshold"
        />
        <text x={plotRight - 72} y={y60 - 4} className="curve-label-threshold">
          60% 遗忘临界
        </text>

        <line
          x1={xDue}
          y1={plotTop}
          x2={xDue}
          y2={plotBottom}
          className="curve-due-line"
        />

        <path d={areaPath} fill="url(#examCurveAreaGrad)" />
        <path d={linePath} className="exam-center-curve-line" />

        <circle cx={markerX} cy={markerY} r="7" className="curve-marker-halo" />
        <circle
          cx={markerX}
          cy={markerY}
          r="4"
          className={`exam-center-curve-marker ${isOverdue ? 'is-overdue' : ''}`}
        />

        <text x={plotLeft} y={svgHeight - 8} className="curve-axis-text">
          上次交卷
        </text>
        <text
          x={xDue - 18}
          y={svgHeight - 8}
          className="curve-axis-text curve-axis-due"
        >
          建议复习
        </text>
        <text x={plotRight - 36} y={svgHeight - 8} className="curve-axis-text">
          衰退期
        </text>
      </svg>

      <div className="curve-footer-status">
        <span
          className={`curve-retention-pill ${isOverdue ? 'is-danger' : 'is-good'}`}
        >
          <i className="status-dot" />
          当前留存预估: <strong>{currentPct}%</strong>
          {isOverdue ? ' · 已跌破临界阈值' : ' · 记忆稳固良好'}
        </span>
      </div>
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
          <div className="exam-center-title-badge">COGNITIVE HUB</div>
          <h1>试卷与复习</h1>
          <span>艾宾浩斯记忆与认知巩固中枢</span>
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
              <span className="exam-sprint-icon">⚡</span>
              <span>开启今日冲刺 ({dueCount})</span>
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

      {/* 机构级 5 列 KPI 遥测仪表栏 */}
      <section className="exam-center-summary" aria-label="记忆资产与复习概况">
        <button
          type="button"
          className={`exam-summary-card ${filter === 'all' ? 'is-active' : ''}`}
          onClick={() => setFilter('all')}
        >
          <div className="exam-summary-header">
            <span>记忆资产总量</span>
            <span className="exam-summary-tag">全集</span>
          </div>
          <strong className="exam-summary-num">{exams.length}</strong>
          <small className="exam-summary-sub">共 {totalQuestions} 道题目</small>
        </button>

        <button
          type="button"
          className={`exam-summary-card is-danger ${filter === 'due' ? 'is-active' : ''}`}
          onClick={() => setFilter('due')}
        >
          <div className="exam-summary-header">
            <span>紧急遗忘告警</span>
            <span className="exam-summary-tag is-danger">临界</span>
          </div>
          <strong className="exam-summary-num text-danger">
            {overdueCount}
          </strong>
          <small className="exam-summary-sub">跌破 60% 遗忘阈值</small>
        </button>

        <button
          type="button"
          className={`exam-summary-card is-warning ${filter === 'due' ? 'is-active' : ''}`}
          onClick={() => setFilter('due')}
        >
          <div className="exam-summary-header">
            <span>今日到期负荷</span>
            <span className="exam-summary-tag is-warning">今日</span>
          </div>
          <strong className="exam-summary-num text-warning">
            {todayCount}
          </strong>
          <small className="exam-summary-sub">
            {estimatedWorkloadMinutes
              ? `预计耗时 ~${estimatedWorkloadMinutes} 分钟`
              : '今日无排程'}
          </small>
        </button>

        <div className="exam-summary-card">
          <div className="exam-summary-header">
            <span>记忆留存健康度</span>
            <span className={`exam-summary-tag is-${retentionStats.status}`}>
              {retentionStats.label}
            </span>
          </div>
          <strong className="exam-summary-num">{retentionStats.rate}%</strong>
          <div className="exam-summary-meter">
            <div
              className="exam-summary-meter-fill"
              style={{ width: `${retentionStats.rate}%` }}
            />
          </div>
        </div>

        <button
          type="button"
          className={`exam-summary-card ${filter === 'upcoming' ? 'is-active' : ''}`}
          onClick={() => setFilter('upcoming')}
        >
          <div className="exam-summary-header">
            <span>近期巩固排程</span>
            <span className="exam-summary-tag">3日内</span>
          </div>
          <strong className="exam-summary-num">{upcomingCount}</strong>
          <small className="exam-summary-sub">稳步进入强化期</small>
        </button>
      </section>

      <div className="exam-center-body">
        {/* 左侧智能视图与书籍知识库 */}
        <aside className="exam-center-filters" aria-label="试卷筛选">
          <div className="exam-filter-section-title">智能视图</div>
          {(
            [
              ['all', '全部试卷', exams.length, 'normal'],
              [
                'due',
                '紧急待复习',
                overdueCount + todayCount,
                overdueCount > 0 ? 'danger' : 'warning',
              ],
              ['upcoming', '近期到期 (3日内)', upcomingCount, 'normal'],
              ['inProgress', '重做 / 作答中', inProgressCount, 'primary'],
            ] as const
          ).map(([value, label, count, badgeType]) => (
            <button
              key={value}
              type="button"
              className={`exam-filter-btn ${filter === value ? 'is-active' : ''}`}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              <span>{label}</span>
              <span className={`exam-badge is-${badgeType}`}>{count}</span>
            </button>
          ))}

          <div className="exam-filter-section-title">书籍知识库</div>
          <div className="exam-center-book-list" aria-label="按书籍筛选试卷">
            <button
              type="button"
              className={`exam-center-book-row ${!bookFilter ? 'is-active' : ''}`}
              aria-pressed={!bookFilter}
              onClick={() => onBookFilterChange('')}
            >
              <span>全部书籍合集</span>
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
            <p className="exam-center-empty">正在加载认知强化档案…</p>
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
              <h2>{exams.length ? '没有匹配的试卷' : '尚无试卷档案'}</h2>
              <p>
                在电子书阅读器中选定章节后一键生成试卷，交卷后此处将自动生成艾宾浩斯复习排程。
              </p>
              <button type="button" onClick={onOpenShelf}>
                前往电子书阅读器
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
                    onDoubleClick={() => setOpenedExam(exam)}
                    aria-pressed={selected?.exam.id === exam.id}
                  >
                    <div className="exam-center-row-top">
                      <span className="exam-row-section-pill">
                        {exam.sourceSectionLabel ? '章节试卷' : '整书测试'}
                      </span>
                      <strong className="exam-row-title">
                        {exam.sourceSectionLabel || exam.bookTitle}
                      </strong>
                      <span
                        className={`exam-center-urgency-badge is-${schedule.urgency}`}
                      >
                        <i className="urgency-dot" />
                        {urgencyLabel(schedule)}
                      </span>
                    </div>

                    <div className="exam-center-row-mid">
                      <span className="exam-row-book-name">
                        《{exam.bookTitle}》
                      </span>
                      <span className="exam-row-stat-pill">
                        {exam.difficulty
                          ? `${exam.difficulty.toUpperCase()} 难度`
                          : '标准难度'}
                      </span>
                    </div>

                    <div className="exam-center-row-meta">
                      <span>{exam.questionCount} 道题</span>
                      <span className="meta-sep">/</span>
                      <span>已交卷 {schedule.completedRounds} 轮</span>
                      <span className="meta-sep">/</span>
                      <span>
                        建议复习:{' '}
                        {schedule.dueAt ? formatDay(schedule.dueAt) : '待交卷'}
                      </span>
                      <span
                        className="exam-row-action-link"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenedExam(exam);
                        }}
                      >
                        {exam.status === 'inProgress'
                          ? '继续作答 →'
                          : '进入复习 →'}
                      </span>
                    </div>
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

        {/* 右侧：试卷全景透视与记忆衰减引擎 */}
        <aside className="exam-center-detail" aria-label="试卷详情">
          {selected ? (
            <>
              <div className="exam-center-detail-heading">
                <span className="exam-detail-kicker">EXAM INSPECTOR</span>
                <span
                  className={`exam-center-urgency-badge is-${selected.schedule.urgency}`}
                >
                  <i className="urgency-dot" />
                  {urgencyLabel(selected.schedule)}
                </span>
              </div>
              <h2 className="exam-detail-title">
                {selected.exam.sourceSectionLabel || '整章全真模拟'}
              </h2>
              <p className="exam-center-detail-book">
                所属书籍：<strong>《{selected.exam.bookTitle}》</strong>
              </p>

              {/* 核心指标四宫格 */}
              <div className="exam-stat-grid">
                <div className="exam-stat-cell">
                  <span>试题总量</span>
                  <strong>
                    {selected.exam.questionCount} <small>题</small>
                  </strong>
                </div>
                <div className="exam-stat-cell">
                  <span>交卷轮次</span>
                  <strong>
                    第 {selected.schedule.completedRounds} <small>轮</small>
                  </strong>
                </div>
                <div className="exam-stat-cell">
                  <span>建议间隔</span>
                  <strong>
                    {selected.schedule.intervalDays
                      ? `${selected.schedule.intervalDays}`
                      : '—'}{' '}
                    <small>天</small>
                  </strong>
                </div>
                <div className="exam-stat-cell">
                  <span>记忆层级</span>
                  <strong className={memoryTier(selected.schedule).colorClass}>
                    {memoryTier(selected.schedule).tier}{' '}
                    <small>{memoryTier(selected.schedule).label}</small>
                  </strong>
                </div>
              </div>

              <div className="exam-center-detail-actions">
                <button
                  type="button"
                  className="is-primary exam-btn-primary"
                  onClick={() => setOpenedExam(selected.exam)}
                >
                  <span>⚡</span>
                  <span>
                    {selected.exam.status === 'inProgress'
                      ? '继续作答试卷'
                      : '立即开始复习'}
                  </span>
                </button>
                <button
                  type="button"
                  className="exam-btn-secondary"
                  disabled={!selectedBook}
                  onClick={() => selectedBook && onOpenBook(selectedBook)}
                >
                  <span>📖 打开原书对应章节</span>
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
                    <dt>试卷难度定级</dt>
                    <dd>{selected.exam.difficulty.toUpperCase()}</dd>
                  </div>
                )}
              </dl>

              <section className="exam-center-curve-panel">
                <div className="exam-curve-header">
                  <h3>艾宾浩斯记忆留存曲线</h3>
                  <span className="exam-curve-tag">EXPONENTIAL DECAY</span>
                </div>
                <ReviewCurve
                  schedule={selected.schedule}
                  now={now}
                  lastCompletedAt={selected.exam.lastCompletedAt}
                />
              </section>

              <div className="exam-center-method-card">
                <h4>记忆强化跃迁机制</h4>
                <p>
                  按时完成复习并自评掌握后，下一次记忆间隔将逐级跃升至{' '}
                  <strong>1 → 3 → 7 → 14 → 30 → 60 天</strong>
                  ；若未达掌握标准，系统将自动回退至 1 天进行强化。
                </p>
              </div>
            </>
          ) : (
            <div className="exam-center-empty">
              <p>请在左侧列表中选择一份试卷查看认知全景与复习排程。</p>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
