import { describe, expect, it, vi } from 'vitest';
import {
  applyReaderSettings,
  getReaderTranslationTheme,
  loadReaderSettings,
  normalizeTocLabel,
  resolveTocHierarchy,
  safeEpubDestination,
} from '../src/ebook/reader-state';

describe('reader state', () => {
  it('rejects link targets that leave the book', () => {
    expect(safeEpubDestination('chapters/01.xhtml')).toBe('chapters/01.xhtml');
    expect(safeEpubDestination('https://example.com')).toBe('');
    expect(safeEpubDestination('\\windows\\file')).toBe('');
  });

  it('strips chapter numbering before comparing headings', () => {
    expect(normalizeTocLabel('第 3 章 线性空间')).toBe('线性空间');
    expect(normalizeTocLabel('Chapter 2. Vectors')).toBe('vectors');
  });

  it('returns the heading trail for the current toc item', () => {
    const trail = resolveTocHierarchy(
      [
        {
          href: 'a.xhtml',
          label: '第一部分',
          subitems: [{ href: 'b.xhtml', label: '第 1 章 开篇', id: 4 }],
        },
      ],
      4,
    );
    expect(trail).toEqual(['第一部分', '第 1 章 开篇']);
  });

  it('keeps stored reader settings inside the supported range', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const key = `reader-state-test-${Date.now()}`;
    localStorage.setItem(
      `seamind:epub-settings:v1:${encodeURIComponent(key)}`,
      JSON.stringify({
        fontSize: 99,
        lineHeight: 1.8,
        palette: 'sepia',
        flow: 'scrolled',
      }),
    );
    expect(loadReaderSettings(key, 'light')).toEqual({
      fontSize: 30,
      lineHeight: 1.8,
      palette: 'sepia',
      flow: 'scrolled',
    });
    vi.unstubAllGlobals();
  });

  it('provides distinct high-contrast translation palettes per theme and injects CSS variables into renderer', () => {
    const lightTrans = getReaderTranslationTheme('light', 'light');
    const sepiaTrans = getReaderTranslationTheme('sepia', 'light');
    const darkTrans = getReaderTranslationTheme('dark', 'dark');
    const navyTrans = getReaderTranslationTheme('dark', 'navy');
    const purpleTrans = getReaderTranslationTheme('dark', 'purple');

    expect(lightTrans.accent).toBe('#d9573b');
    expect(sepiaTrans.accent).toBe('#b45309');
    expect(darkTrans.accent).toBe('#fb923c');
    expect(navyTrans.accent).toBe('#38bdf8');
    expect(purpleTrans.accent).toBe('#c084fc');

    let injectedCss = '';
    applyReaderSettings(
      {
        renderer: {
          setAttribute: () => {},
          setStyles: (css: string) => {
            injectedCss = css;
          },
        },
      },
      { fontSize: 18, lineHeight: 1.6, palette: 'dark', flow: 'paginated' },
      'navy',
    );
    expect(injectedCss).toContain('--seamind-trans-accent: #38bdf8;');
    expect(injectedCss).toContain('--seamind-trans-fg: #f0f9ff;');
    expect(injectedCss).toContain(
      '--seamind-trans-bg: rgba(56, 189, 248, 0.14);',
    );
  });
});
