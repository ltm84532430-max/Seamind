import type { CodeLabCell } from './terminal-codelab-model';

export interface AnalysisChart {
  id: string;
  cellId: string;
  cellNumber: number;
  outputIndex: number;
  kind: 'image/png' | 'image/svg+xml';
  data: string;
  stale: boolean;
}

export function collectAnalysisCharts(
  cells: readonly CodeLabCell[],
  groupId: string,
): AnalysisChart[] {
  const charts: AnalysisChart[] = [];
  cells.forEach((cell, cellIndex) => {
    if (cell.groupId !== groupId) return;
    cell.outputs.forEach((output, outputIndex) => {
      if (output.kind !== 'image/png' && output.kind !== 'image/svg+xml') {
        return;
      }
      charts.push({
        id: `${cell.id}:${outputIndex}`,
        cellId: cell.id,
        cellNumber: cellIndex + 1,
        outputIndex,
        kind: output.kind,
        data: output.kind === 'image/png' ? output.dataUrl : output.svg,
        stale:
          cell.lastExecutedSource !== undefined &&
          cell.lastExecutedSource !== cell.source,
      });
    });
  });
  return charts;
}

export function clampFocusRatio(
  value: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
