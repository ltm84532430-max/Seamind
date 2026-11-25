import { useState } from 'react';
import { parseSafeSvgElement } from '../app/svg-sanitize';
import type { AnalysisChart } from './analysis-focus-model';
import { SafeSvgOutput } from './TerminalRichContent';

interface AnalysisChartGalleryProps {
  charts: readonly AnalysisChart[];
  blockTitle: string;
  onNotify?: (message: string) => void;
}

function safeFileStem(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[<>:"/\\|?*]+/g, '_')
    .split('')
    .filter((character) => character.charCodeAt(0) >= 32)
    .join('');
  return cleaned.slice(0, 72) || 'analysis';
}

export function AnalysisChartGallery({
  charts,
  blockTitle,
  onNotify,
}: AnalysisChartGalleryProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actualSize, setActualSize] = useState(false);
  const selectedIndex = Math.max(
    0,
    charts.findIndex((chart) => chart.id === selectedId),
  );
  const selectedChart = charts[selectedIndex];

  const selectIndex = (index: number) => {
    if (!charts.length) return;
    setSelectedId(charts[(index + charts.length) % charts.length].id);
    setActualSize(false);
  };

  const downloadSelected = () => {
    if (!selectedChart) return;
    const fileName = `${safeFileStem(blockTitle)}_chart_${selectedIndex + 1}`;
    const link = document.createElement('a');
    if (selectedChart.kind === 'image/png') {
      const ext = selectedChart.data.startsWith('data:image/jpeg')
        ? 'jpg'
        : selectedChart.data.startsWith('data:image/webp')
          ? 'webp'
          : 'png';
      link.href = selectedChart.data;
      link.download = `${fileName}.${ext}`;
      link.click();
      return;
    }
    const safeSvg = parseSafeSvgElement(selectedChart.data);
    if (!safeSvg) {
      onNotify?.('SVG 未通过安全校验，无法导出');
      return;
    }
    const xml = new XMLSerializer().serializeToString(safeSvg);
    const objectUrl = URL.createObjectURL(
      new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }),
    );
    link.href = objectUrl;
    link.download = `${fileName}.svg`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  };

  return (
    <section
      className="codelab-focus-charts"
      aria-label="分析区块图表导出区域"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' && charts.length > 1) {
          event.preventDefault();
          selectIndex(selectedIndex - 1);
        } else if (event.key === 'ArrowRight' && charts.length > 1) {
          event.preventDefault();
          selectIndex(selectedIndex + 1);
        }
      }}
    >
      <header className="codelab-focus-panel-head">
        <strong>图表导出</strong>
        <div className="codelab-focus-chart-actions">
          <span className="codelab-focus-chart-count">
            {charts.length
              ? `${selectedIndex + 1} / ${charts.length}`
              : '0 / 0'}
          </span>
          <button
            type="button"
            onClick={() => selectIndex(selectedIndex - 1)}
            disabled={charts.length < 2}
            aria-label="上一张图表"
          >
            ←
          </button>
          <button
            type="button"
            onClick={() => selectIndex(selectedIndex + 1)}
            disabled={charts.length < 2}
            aria-label="下一张图表"
          >
            →
          </button>
          <button
            type="button"
            onClick={() => setActualSize((current) => !current)}
            disabled={!selectedChart}
            aria-pressed={actualSize}
          >
            {actualSize ? '适应' : '原尺寸'}
          </button>
          <button
            type="button"
            onClick={downloadSelected}
            disabled={!selectedChart}
          >
            导出
          </button>
        </div>
      </header>
      <div
        className={`codelab-focus-chart-stage${actualSize ? ' is-actual-size' : ''}`}
      >
        {selectedChart && (
          <>
            {selectedChart.kind === 'image/png' ? (
              <img
                src={selectedChart.data}
                alt={`${blockTitle} 图表 ${selectedIndex + 1}`}
              />
            ) : (
              <SafeSvgOutput svg={selectedChart.data} />
            )}
            {selectedChart.stale && (
              <span className="codelab-focus-chart-stale">
                代码已修改 · 需重新运行
              </span>
            )}
          </>
        )}
      </div>
      {selectedChart && (
        <footer className="codelab-focus-chart-source">
          代码格 {selectedChart.cellNumber} ·{' '}
          {selectedChart.kind === 'image/png' ? '位图' : 'SVG'}
        </footer>
      )}
    </section>
  );
}
