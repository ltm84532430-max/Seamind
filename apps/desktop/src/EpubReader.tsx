import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

export interface EpubReaderSelection {
  source: File | string;
  progressKey: string;
  title: string;
}

type FoliateTocItem = {
  href: string;
  label: string | Record<string, string>;
  subitems?: FoliateTocItem[];
};

type FoliateMetadata = {
  title?: string | Record<string, string>;
  creator?:
    | string
    | Record<string, string>
    | Array<string | Record<string, string>>;
};

type FoliateLocation = {
  cfi?: string;
  fraction?: number;
  location?: { current?: number; total?: number };
  tocItem?: { href?: string; label?: string | Record<string, string> };
};

type ReaderPalette = 'light' | 'sepia' | 'dark';
type ReaderFlow = 'paginated' | 'scrolled';

type ReaderSettings = {
  fontSize: number;
  lineHeight: number;
  palette: ReaderPalette;
  flow: ReaderFlow;
};

type FoliateRendererElement = HTMLElement & {
  setStyles?: (styles: string) => void;
};

type FoliateViewElement = HTMLElement & {
  open(book: File | string): Promise<void>;
  goTo(destination: string): Promise<void>;
  goToFraction(fraction: number): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  close(): void;
  renderer?: FoliateRendererElement;
  isFixedLayout?: boolean;
  book?: { metadata?: FoliateMetadata; toc?: FoliateTocItem[] };
};

const DEFAULT_READER_SETTINGS: ReaderSettings = {
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

function displayLabel(value: unknown): string {
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

function savedLocationKey(progressKey: string): string {
  return `seamind:epub-progress:v1:${encodeURIComponent(progressKey)}`;
}

function savedSettingsKey(progressKey: string): string {
  return `seamind:epub-settings:v1:${encodeURIComponent(progressKey)}`;
}

function loadReaderSettings(
  progressKey: string,
  appTheme: 'light' | 'dark',
): ReaderSettings {
  const defaults = {
    ...DEFAULT_READER_SETTINGS,
    palette: appTheme === 'dark' ? ('dark' as const) : ('light' as const),
  };
  try {
    const value = JSON.parse(
      localStorage.getItem(savedSettingsKey(progressKey)) ?? 'null',
    );
    if (!value || typeof value !== 'object') return defaults;
    const fontSize = Number(value.fontSize);
    const lineHeight = Number(value.lineHeight);
    return {
      fontSize: Number.isFinite(fontSize)
        ? Math.min(30, Math.max(14, Math.round(fontSize)))
        : defaults.fontSize,
      lineHeight: [1.4, 1.6, 1.8, 2].includes(lineHeight)
        ? lineHeight
        : defaults.lineHeight,
      palette: ['light', 'sepia', 'dark'].includes(value.palette)
        ? value.palette
        : defaults.palette,
      flow: value.flow === 'scrolled' ? 'scrolled' : 'paginated',
    };
  } catch {
    return defaults;
  }
}

function applyReaderSettings(
  view: FoliateViewElement | null,
  settings: ReaderSettings,
) {
  const renderer = view?.renderer;
  if (!renderer) return;
  renderer.setAttribute('flow', settings.flow);
  if (!renderer.setStyles || view?.isFixedLayout) return;

  const palette = READER_PALETTES[settings.palette];
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
  `);
}

export default function EpubReader({
  selection,
  theme,
  embedded = false,
  onClose,
}: {
  selection: EpubReaderSelection;
  theme: 'light' | 'dark';
  embedded?: boolean;
  onClose: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateViewElement | null>(null);
  const [title, setTitle] = useState(selection.title);
  const [author, setAuthor] = useState('');
  const [toc, setToc] = useState<FoliateTocItem[]>([]);
  const [tocOpen, setTocOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fraction, setFraction] = useState(0);
  const [locationText, setLocationText] = useState('正在载入…');
  const [chapterTitle, setChapterTitle] = useState('');
  const [readerSettings, setReaderSettings] = useState(() =>
    loadReaderSettings(selection.progressKey, theme),
  );
  const readerSettingsRef = useRef(readerSettings);
  const [isFixedLayout, setIsFixedLayout] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(
        savedSettingsKey(selection.progressKey),
        JSON.stringify(readerSettings),
      );
    } catch {
      // The reader remains usable when browser storage is unavailable.
    }
    applyReaderSettings(viewRef.current, readerSettings);
  }, [readerSettings]);

  useEffect(() => {
    let cancelled = false;
    let view: FoliateViewElement | null = null;
    const progressKey = savedLocationKey(selection.progressKey);

    const onRelocate = (event: Event) => {
      const detail = (event as CustomEvent<FoliateLocation>).detail;
      if (typeof detail.fraction === 'number') {
        setFraction(Math.min(1, Math.max(0, detail.fraction)));
      }
      if (detail.cfi) {
        try {
          localStorage.setItem(progressKey, detail.cfi);
        } catch {
          // The current page still works when browser storage is unavailable.
        }
      }
      const current = detail.location?.current;
      const total = detail.location?.total;
      if (
        typeof current === 'number' &&
        typeof total === 'number' &&
        total > 0
      ) {
        setLocationText(`位置 ${current} / ${total}`);
      } else if (typeof detail.fraction === 'number') {
        setLocationText(`${Math.round(detail.fraction * 100)}%`);
      }
      const label = displayLabel(detail.tocItem?.label);
      if (label) setChapterTitle(label);
    };
    const blockExternalLink = (event: Event) => event.preventDefault();

    const openBook = async () => {
      setLoading(true);
      setError('');
      const initialSettings = loadReaderSettings(selection.progressKey, theme);
      readerSettingsRef.current = initialSettings;
      setReaderSettings(initialSettings);
      setIsFixedLayout(false);
      try {
        // @ts-expect-error Foliate ships as an untyped JavaScript submodule.
        await import('../../../packages/foliate-js/view.js');
        if (cancelled || !stageRef.current) return;

        view = document.createElement('foliate-view') as FoliateViewElement;
        view.setAttribute('gap', '8%');
        view.setAttribute('max-inline-size', '760px');
        view.addEventListener('relocate', onRelocate);
        view.addEventListener('external-link', blockExternalLink);
        stageRef.current.replaceChildren(view);
        viewRef.current = view;

        await view.open(selection.source);
        setIsFixedLayout(Boolean(view.isFixedLayout));
        applyReaderSettings(view, readerSettingsRef.current);
        if (cancelled) {
          view.close();
          view.remove();
          return;
        }

        const metadata = view.book?.metadata;
        setTitle(displayLabel(metadata?.title) || selection.title);
        setAuthor(displayLabel(metadata?.creator));
        setToc(view.book?.toc ?? []);

        let savedCfi = '';
        try {
          savedCfi = localStorage.getItem(progressKey) ?? '';
        } catch {
          savedCfi = '';
        }
        if (savedCfi) {
          try {
            await view.goTo(savedCfi);
          } catch {
            try {
              localStorage.removeItem(progressKey);
            } catch {
              // Ignore unavailable storage.
            }
          }
        }
        if (!cancelled) setLoading(false);
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? `无法打开这本 EPUB：${cause.message}`
              : '无法打开这本 EPUB，请检查文件是否完整。',
          );
          setLoading(false);
        }
      }
    };

    void openBook();
    return () => {
      cancelled = true;
      if (view) {
        view.removeEventListener('relocate', onRelocate);
        view.removeEventListener('external-link', blockExternalLink);
        view.close();
        view.remove();
      }
      if (viewRef.current === view) viewRef.current = null;
    };
  }, [selection]);

  const updateReaderSettings = (next: Partial<ReaderSettings>) => {
    const updated = { ...readerSettingsRef.current, ...next };
    readerSettingsRef.current = updated;
    setReaderSettings(updated);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (
      target.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'BUTTON'].includes(target.tagName)
    ) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      void viewRef.current?.prev();
    } else if (event.key === 'ArrowRight' || event.key === 'PageDown') {
      event.preventDefault();
      void viewRef.current?.next();
    }
  };

  const navigateTo = (href: string) => {
    void viewRef.current?.goTo(href).catch((cause) => {
      setError(
        cause instanceof Error
          ? `无法跳转到该章节：${cause.message}`
          : '章节跳转失败。',
      );
    });
  };

  return (
    <div
      className={`epub-reader${embedded ? ' is-workspace' : ''}`}
      data-theme={theme}
      role={embedded ? 'region' : 'dialog'}
      aria-modal={embedded ? undefined : 'true'}
      aria-label={`EPUB 阅读器：${title}`}
      onKeyDown={handleKeyDown}
    >
      <header className="epub-reader-header">
        <div className="epub-reader-book-heading">
          <span className="epub-reader-kicker">LOCAL EPUB · READER</span>
          <strong title={title}>{title}</strong>
          {author && <span className="epub-reader-author">{author}</span>}
        </div>
        <div className="epub-reader-header-actions">
          <details className="epub-reader-settings">
            <summary className="epub-reader-tool">阅读设置</summary>
            <div className="epub-reader-settings-panel">
              <div className="epub-reader-setting-row">
                <span>字号</span>
                <div className="epub-reader-stepper">
                  <button
                    type="button"
                    aria-label="缩小字号"
                    disabled={isFixedLayout || readerSettings.fontSize <= 14}
                    onClick={() =>
                      updateReaderSettings({
                        fontSize: Math.max(14, readerSettings.fontSize - 1),
                      })
                    }
                  >
                    −
                  </button>
                  <output>{readerSettings.fontSize}px</output>
                  <button
                    type="button"
                    aria-label="增大字号"
                    disabled={isFixedLayout || readerSettings.fontSize >= 30}
                    onClick={() =>
                      updateReaderSettings({
                        fontSize: Math.min(30, readerSettings.fontSize + 1),
                      })
                    }
                  >
                    +
                  </button>
                </div>
              </div>
              <label className="epub-reader-setting-row">
                <span>行距</span>
                <select
                  value={readerSettings.lineHeight}
                  disabled={isFixedLayout}
                  onChange={(event) =>
                    updateReaderSettings({
                      lineHeight: Number(event.target.value),
                    })
                  }
                >
                  <option value="1.4">紧凑</option>
                  <option value="1.6">标准</option>
                  <option value="1.8">宽松</option>
                  <option value="2">加宽</option>
                </select>
              </label>
              <label className="epub-reader-setting-row">
                <span>页面底色</span>
                <select
                  value={readerSettings.palette}
                  disabled={isFixedLayout}
                  onChange={(event) =>
                    updateReaderSettings({
                      palette: event.target.value as ReaderPalette,
                    })
                  }
                >
                  <option value="light">纸白</option>
                  <option value="sepia">羊皮纸</option>
                  <option value="dark">深色</option>
                </select>
              </label>
              <label className="epub-reader-setting-row">
                <span>翻页方式</span>
                <select
                  value={readerSettings.flow}
                  onChange={(event) =>
                    updateReaderSettings({
                      flow: event.target.value as ReaderFlow,
                    })
                  }
                >
                  <option value="paginated">分页</option>
                  <option value="scrolled">连续滚动</option>
                </select>
              </label>
              {isFixedLayout && (
                <p className="epub-reader-settings-hint">
                  这本书使用固定版式，字号、行距和底色由书籍页面决定。
                </p>
              )}
              <button
                type="button"
                className="epub-reader-settings-reset"
                onClick={() =>
                  updateReaderSettings({
                    ...DEFAULT_READER_SETTINGS,
                    palette: theme,
                  })
                }
              >
                恢复默认
              </button>
            </div>
          </details>
          <button
            type="button"
            className={`epub-reader-tool${tocOpen ? ' is-active' : ''}`}
            onClick={() => setTocOpen((open) => !open)}
            aria-pressed={tocOpen}
            title="显示或隐藏目录"
          >
            目录
          </button>
          <button
            type="button"
            className="epub-reader-close"
            onClick={onClose}
            aria-label="关闭阅读器"
            title="关闭阅读器（Esc）"
          >
            ×
          </button>
        </div>
      </header>

      <div className={`epub-reader-layout${tocOpen ? '' : ' is-toc-closed'}`}>
        {tocOpen && (
          <aside className="epub-reader-toc" aria-label="电子书目录">
            <div className="epub-reader-toc-heading">目录</div>
            {toc.length ? (
              <nav>{renderToc(toc, navigateTo)}</nav>
            ) : (
              <p className="epub-reader-toc-empty">这本书没有可用目录</p>
            )}
          </aside>
        )}

        <section className="epub-reader-main" aria-label="书籍内容">
          <div className="epub-reader-stage" ref={stageRef} />
          {loading && (
            <div className="epub-reader-loading" role="status">
              {error ? '书籍未能载入' : '正在载入 EPUB…'}
            </div>
          )}
          {error && (
            <div className="epub-reader-error" role="alert">
              {error}
            </div>
          )}
          {chapterTitle && (
            <div className="epub-reader-chapter">{chapterTitle}</div>
          )}
        </section>
      </div>

      <footer className="epub-reader-footer">
        <button
          type="button"
          className="epub-reader-page-button"
          onClick={() => void viewRef.current?.prev()}
          disabled={fraction <= 0}
          title="上一页（←）"
        >
          上一页
        </button>
        <span className="epub-reader-location">{locationText}</span>
        <input
          className="epub-reader-progress"
          type="range"
          min="0"
          max="1"
          step="0.001"
          value={fraction}
          aria-label="阅读进度"
          onChange={(event) =>
            void viewRef.current?.goToFraction(Number(event.target.value))
          }
        />
        <button
          type="button"
          className="epub-reader-page-button"
          onClick={() => void viewRef.current?.next()}
          disabled={fraction >= 1}
          title="下一页（→）"
        >
          下一页
        </button>
      </footer>
    </div>
  );
}

function renderToc(
  items: FoliateTocItem[],
  onNavigate: (href: string) => void,
  depth = 0,
) {
  return (
    <ul className="epub-reader-toc-list">
      {items.map((item, index) => {
        const label = displayLabel(item.label) || '未命名章节';
        return (
          <li key={`${item.href}-${index}`}>
            <button
              type="button"
              className="epub-reader-toc-item"
              style={{ paddingInlineStart: `${10 + depth * 12}px` }}
              onClick={() => onNavigate(item.href)}
              title={label}
            >
              {label}
            </button>
            {!!item.subitems?.length &&
              renderToc(item.subitems, onNavigate, depth + 1)}
          </li>
        );
      })}
    </ul>
  );
}
