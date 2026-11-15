import type { Theme } from '../app/app-storage';
import type { EpubAnnotationStyle } from './ebook-storage';

export type FoliateTocItem = {
  href: string;
  label: string | Record<string, string>;
  subitems?: FoliateTocItem[];
  id?: number;
};

export type ReaderPalette = 'light' | 'sepia' | 'dark';
export type ReaderFlow = 'paginated' | 'scrolled';

export type ReaderSettings = {
  fontSize: number;
  lineHeight: number;
  palette: ReaderPalette;
  flow: ReaderFlow;
};

export interface ReaderStyleTarget {
  renderer?: {
    setAttribute(qualifiedName: string, value: string): void;
    setStyles?: (styles: string) => void;
  };
  isFixedLayout?: boolean;
}

export const DEFAULT_ANNOTATION_COLOR = '#8d969b';
export const ANNOTATION_COLORS = [
  { value: DEFAULT_ANNOTATION_COLOR, label: '石墨灰' },
  { value: '#c4a27d', label: '浅赭色' },
  { value: '#87a799', label: '鼠尾草绿' },
  { value: '#8aa9bc', label: '灰蓝色' },
  { value: '#a49bb7', label: '灰紫色' },
] as const;

const LEGACY_ANNOTATION_COLORS: Record<string, string> = {
  '#ed7771': '#ba9b96',
  '#f2d675': '#c4a27d',
  '#55c68a': '#87a799',
  '#55a9e8': '#8aa9bc',
  '#a78bfa': '#a49bb7',
};

export function annotationDisplayColor(color: string) {
  return LEGACY_ANNOTATION_COLORS[color.toLowerCase()] ?? color;
}

export const ANNOTATION_STYLES: {
  value: EpubAnnotationStyle;
  label: string;
  symbol: string;
}[] = [
  { value: 'highlight', label: '高亮', symbol: '▰' },
  { value: 'underline', label: '下划线', symbol: 'A̲' },
  { value: 'squiggly', label: '波浪线', symbol: '〰' },
];

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  fontSize: 18,
  lineHeight: 1.6,
  palette: 'light',
  flow: 'paginated',
};

const READER_PALETTES: Record<
  ReaderPalette,
  { background: string; foreground: string; link: string }
> = {
  light: { background: '#ffffff', foreground: '#263238', link: '#a9472f' },
  sepia: { background: '#f3ead8', foreground: '#43382a', link: '#9d4f32' },
  dark: { background: '#1e2529', foreground: '#d8e0e3', link: '#e9a18b' },
};

export function displayLabel(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value.map(displayLabel).filter(Boolean).join('、');
  if (value && typeof value === 'object') {
    const labels = Object.values(value).filter(
      (label): label is string => typeof label === 'string',
    );
    return labels[0] ?? '';
  }
  return '';
}

export function flattenTocItems(items: FoliateTocItem[]): FoliateTocItem[] {
  return items.flatMap((item) => [
    item,
    ...flattenTocItems(item.subitems ?? []),
  ]);
}

export function tocPathForId(
  items: FoliateTocItem[],
  targetId: number,
  parentKey = '',
): string[] | null {
  for (const [index, item] of items.entries()) {
    const key = parentKey ? `${parentKey}.${index}` : String(index);
    if (item.id === targetId) return [key];
    const childPath = tocPathForId(item.subitems ?? [], targetId, key);
    if (childPath) return [key, ...childPath];
  }
  return null;
}

export function normalizeNavHref(href: string) {
  try {
    return decodeURIComponent(href).replaceAll('\\', '/');
  } catch {
    return href.replaceAll('\\', '/');
  }
}

export function countReadableWords(source: string) {
  const cjk =
    source.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
    )?.length ?? 0;
  const nonCjk =
    source
      .replace(
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
        ' ',
      )
      .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  return cjk + nonCjk;
}

export async function estimateBookWordCount(
  sections: Array<{ loadText?: () => Promise<string | null | undefined> }>,
) {
  let total = 0;
  for (const [index, section] of sections.entries()) {
    if (!section.loadText) continue;
    try {
      const source = await section.loadText();
      if (source) {
        const document = new DOMParser().parseFromString(source, 'text/html');
        document
          .querySelectorAll('script,style,noscript')
          .forEach((node) => node.remove());
        total += countReadableWords(
          document.body?.textContent ||
            document.documentElement?.textContent ||
            '',
        );
      }
    } catch {
      // A malformed or image-only section does not prevent the rest of the book from being counted.
    }
    if (index > 0 && index % 8 === 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }
  return total;
}

export function normalizeTocHref(href: string) {
  try {
    return decodeURIComponent(href.split('#')[0]).replaceAll('\\', '/');
  } catch {
    return href.split('#')[0].replaceAll('\\', '/');
  }
}

export function resolveTocHierarchy(
  items: FoliateTocItem[],
  targetId?: number | null,
  targetHref?: string,
): string[] {
  const normTargetHref = targetHref ? normalizeTocHref(targetHref) : '';
  function search(list: FoliateTocItem[], trail: string[]): string[] | null {
    for (const item of list) {
      const currentTrail = [...trail, displayLabel(item.label)];
      const matchId = typeof targetId === 'number' && item.id === targetId;
      const matchHref =
        Boolean(normTargetHref) &&
        normalizeTocHref(item.href) === normTargetHref;
      if (matchId || matchHref) {
        return currentTrail;
      }
      if (item.subitems && item.subitems.length > 0) {
        const found = search(item.subitems, currentTrail);
        if (found) return found;
      }
    }
    return null;
  }
  return search(items, []) ?? [];
}

export function normalizeTocLabel(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(
      /^\s*(?:(?:第\s*[0-9一二三四五六七八九十百零]+\s*(?:章|节|篇|部分))|(?:(?:chapter|chap\.?|part|section)\s+\d+(?:\.\d+)*))\s*[.、:：-]?\s*/iu,
      '',
    )
    .replace(/^\s*\d+(?:\.\d+)*\s*[.、:：-]?\s*/u, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function safeEpubDestination(value: string): string {
  const href = value.trim();
  if (
    !href ||
    /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(href) ||
    // Backslashes and control characters never belong in an EPUB link target.
    // eslint-disable-next-line no-control-regex
    /[\\\u0000-\u001f]/u.test(href)
  )
    return '';
  return href;
}

export function savedLocationKey(progressKey: string): string {
  return `seamind:epub-progress:v1:${encodeURIComponent(progressKey)}`;
}

export function savedSettingsKey(progressKey: string): string {
  return `seamind:epub-settings:v1:${encodeURIComponent(progressKey)}`;
}

export async function createCoverThumbnail(blob: Blob): Promise<string> {
  if (!blob.type.startsWith('image/')) return '';
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 240 / bitmap.width, 340 / bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      return '';
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const thumbnail = canvas.toDataURL('image/jpeg', 0.78);
    return thumbnail.length <= 220_000 ? thumbnail : '';
  } catch {
    return '';
  }
}

export function loadReaderSettings(
  progressKey: string,
  appTheme: Theme,
): ReaderSettings {
  const defaults = {
    ...DEFAULT_READER_SETTINGS,
    palette: appTheme === 'light' ? ('light' as const) : ('dark' as const),
  };
  try {
    const value = JSON.parse(
      localStorage.getItem(savedSettingsKey(progressKey)) ?? 'null',
    );
    if (!value || typeof value !== 'object') return defaults;
    const fontSize = Number(value.fontSize);
    const lineHeight = Number(value.lineHeight);
    const rawPalette = value.palette;
    let resolvedPalette: ReaderPalette = defaults.palette;
    if (rawPalette === 'sepia') {
      resolvedPalette = 'sepia';
    } else if (appTheme === 'light') {
      resolvedPalette = rawPalette === 'dark' ? 'dark' : 'light';
    } else {
      resolvedPalette = rawPalette === 'light' ? 'dark' : rawPalette || 'dark';
    }
    return {
      fontSize: Number.isFinite(fontSize)
        ? Math.min(30, Math.max(14, Math.round(fontSize)))
        : defaults.fontSize,
      lineHeight: [1.4, 1.6, 1.8, 2].includes(lineHeight)
        ? lineHeight
        : defaults.lineHeight,
      palette: resolvedPalette,
      flow: value.flow === 'scrolled' ? 'scrolled' : 'paginated',
    };
  } catch {
    return defaults;
  }
}

export function getReaderPalette(paletteKey: ReaderPalette, appTheme?: Theme) {
  if (paletteKey === 'sepia') {
    return READER_PALETTES.sepia;
  }
  if (paletteKey === 'light') {
    return READER_PALETTES.light;
  }
  if (appTheme === 'navy') {
    return { background: '#070f1e', foreground: '#cde0f5', link: '#38bdf8' };
  }
  if (appTheme === 'purple') {
    return { background: '#0e081a', foreground: '#e5d7f7', link: '#c084fc' };
  }
  return READER_PALETTES.dark;
}

export function applyReaderSettings(
  view: ReaderStyleTarget | null,
  settings: ReaderSettings,
  appTheme?: Theme,
) {
  const renderer = view?.renderer;
  if (!renderer) return;
  renderer.setAttribute('flow', settings.flow);
  if (!renderer.setStyles || view?.isFixedLayout) return;

  const palette = getReaderPalette(settings.palette, appTheme);
  renderer.setStyles(`
    html {
      color-scheme: ${settings.palette === 'dark' ? 'dark' : 'light'} !important;
      --theme-bg-color: ${palette.background};
      font-size: ${settings.fontSize}px !important;
      background-color: ${palette.background} !important;
    }
    body {
      color: ${palette.foreground} !important;
      background-color: ${palette.background} !important;
      line-height: ${settings.lineHeight} !important;
    }
    a, a:visited { color: ${palette.link} !important; }
    ::selection { background: rgb(141 150 155 / 35%) !important; color: inherit !important; }
  `);
}
