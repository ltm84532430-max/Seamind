import type { MindmapStyle, Theme } from '../app/app-storage';

export function mapNodeColor(
  style: MindmapStyle,
  depth: number,
  path: string,
  theme: Theme,
): string {
  if (style === 'gray') {
    if (theme === 'navy') return '#7dd3fc';
    if (theme === 'purple') return '#c084fc';
    return theme === 'dark' ? '#94a3b8' : '#475569';
  }
  if (style === 'roots') {
    if (theme === 'navy') return '#38bdf8';
    if (theme === 'purple') return '#a855f7';
    return theme === 'dark' ? '#94a3b8' : '#334155';
  }
  if (depth === 0) {
    if (theme === 'navy') return '#e0f2fe';
    if (theme === 'purple') return '#f5eeff';
    return theme === 'dark' ? '#cbd5e1' : '#0f172a';
  }

  const branchId = Number(path.split('.')[1] || 1);
  const palette =
    theme === 'navy'
      ? ['#38bdf8', '#60a5fa', '#818cf8', '#2dd4bf', '#34d399', '#f472b6']
      : theme === 'purple'
        ? ['#c084fc', '#e879f9', '#a78bfa', '#818cf8', '#f472b6', '#38bdf8']
        : style === 'warm'
          ? theme === 'dark'
            ? ['#e58a62', '#d7aa58', '#84a27e', '#829cbd', '#bd8fc1', '#d17b84']
            : ['#c25e38', '#b57c26', '#5d7d4c', '#4a6f94', '#845893', '#b34d5c']
          : theme === 'dark'
            ? ['#8aa7b5', '#8ca897', '#a695bc', '#bea27e', '#7f9bbd', '#b18888']
            : [
                '#475569',
                '#3b5a6c',
                '#5a4f6e',
                '#6e5a40',
                '#3b5c77',
                '#6c4b4b',
              ];
  return palette[(branchId - 1) % palette.length];
}

export function mapNodeLinkAnchor(
  style: MindmapStyle,
  depth: number,
): 'bottom' | 'center' {
  const usesCard =
    style === 'cards' ||
    style === 'gray' ||
    style === 'roots' ||
    (style === 'warm' && depth === 0);
  return usesCard ? 'center' : 'bottom';
}

export function mapNodeLineWidth(depth: number): number {
  if (depth === 0) return 2.4;
  if (depth === 1) return 1.9;
  return 1.5;
}
