import type { ExamReviewSchedule } from './review-schedule';

interface Props {
  schedule: ExamReviewSchedule;
  now: number;
  lastCompletedAt?: number | null;
}

export function ExamReviewCurve({ schedule, now, lastCompletedAt }: Props) {
  if (!schedule.intervalDays || !lastCompletedAt) {
    return (
      <div className="exam-center-curve-empty">
        <p>交卷一次后，这里显示复习间隔。</p>
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
        aria-label={`复习间隔：距上次交卷已过 ${Math.round(elapsedDays)} 天，当前约 ${currentPct}%`}
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
