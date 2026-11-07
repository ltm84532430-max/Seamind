import { describe, expect, it, beforeEach } from 'vitest';
import { readTheme, themeStorageKey } from '../src/app/app-storage';
import { mapNodeColor } from '../src/app/app-style-utils';

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  configurable: true,
  writable: true,
});

describe('SeaMind 4-Theme System', () => {
  beforeEach(() => {
    localStorageMock.clear();
  });

  it('reads stored themes correctly including navy and purple', () => {
    localStorage.setItem(themeStorageKey, 'navy');
    expect(readTheme()).toBe('navy');

    localStorage.setItem(themeStorageKey, 'purple');
    expect(readTheme()).toBe('purple');

    localStorage.setItem(themeStorageKey, 'dark');
    expect(readTheme()).toBe('dark');

    localStorage.setItem(themeStorageKey, 'light');
    expect(readTheme()).toBe('light');

    localStorage.setItem(themeStorageKey, 'invalid');
    expect(readTheme()).toBe('dark');
  });

  it('computes tailored mindmap node colors for navy theme', () => {
    const navyColor1 = mapNodeColor('gray', 1, '1.1', 'navy');
    const navyColorRoots = mapNodeColor('roots', 1, '1.1', 'navy');
    const navyRoot = mapNodeColor('warm', 0, '1', 'navy');

    expect(navyColor1).toBe('#7dd3fc');
    expect(navyColorRoots).toBe('#38bdf8');
    expect(navyRoot).toBe('#e0f2fe');

    const navyBranch1 = mapNodeColor('warm', 1, '1.1', 'navy');
    const navyBranch2 = mapNodeColor('warm', 1, '1.2', 'navy');
    expect(navyBranch1).toBe('#38bdf8');
    expect(navyBranch2).toBe('#60a5fa');
  });

  it('computes tailored mindmap node colors for purple theme', () => {
    const purpleColor1 = mapNodeColor('gray', 1, '1.1', 'purple');
    const purpleColorRoots = mapNodeColor('roots', 1, '1.1', 'purple');
    const purpleRoot = mapNodeColor('warm', 0, '1', 'purple');

    expect(purpleColor1).toBe('#c084fc');
    expect(purpleColorRoots).toBe('#a855f7');
    expect(purpleRoot).toBe('#f5eeff');

    const purpleBranch1 = mapNodeColor('warm', 1, '1.1', 'purple');
    const purpleBranch2 = mapNodeColor('warm', 1, '1.2', 'purple');
    expect(purpleBranch1).toBe('#c084fc');
    expect(purpleBranch2).toBe('#e879f9');
  });

  it('ensures themes-extended.css defines full contrasts for badges, toolbars and workspace', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const cssPath = path.resolve(__dirname, '../src/themes-extended.css');
    const cssContent = fs.readFileSync(cssPath, 'utf-8');

    // Document badges in file list
    expect(cssContent).toContain(".app-shell[data-theme='navy'] .doc-badge");
    expect(cssContent).toContain(".app-shell[data-theme='purple'] .doc-badge");

    // Toolbar controls (History, SVG/HTML, Fullscreen, Format Badge)
    expect(cssContent).toContain(
      ".app-shell[data-theme='navy'] .source-history-button",
    );
    expect(cssContent).toContain(
      ".app-shell[data-theme='purple'] .source-history-button",
    );
    expect(cssContent).toContain(
      ".app-shell[data-theme='navy'] .source-insert-tools button",
    );
    expect(cssContent).toContain(
      ".app-shell[data-theme='purple'] .source-insert-tools button",
    );
    expect(cssContent).toContain(
      ".app-shell[data-theme='navy'] .markdown-fullscreen-button",
    );
    expect(cssContent).toContain(
      ".app-shell[data-theme='purple'] .markdown-fullscreen-button",
    );

    // Library search & footer
    expect(cssContent).toContain(
      ".app-shell[data-theme='navy'] .library-search-input-wrap",
    );
    expect(cssContent).toContain(
      ".app-shell[data-theme='purple'] .library-search-input-wrap",
    );
    expect(cssContent).toContain(
      ".app-shell[data-theme='navy'] .library-footer",
    );
    expect(cssContent).toContain(
      ".app-shell[data-theme='purple'] .library-footer",
    );

    // Workspace switcher & Markmap nodes
    expect(cssContent).toContain(
      ".app-shell[data-theme='navy'] .workspace-switcher",
    );
    expect(cssContent).toContain(
      ".app-shell[data-theme='purple'] .workspace-switcher",
    );
    expect(cssContent).toMatch(
      /\.app-shell\[data-theme='navy'\][\s\S]*?\.markmap-node\[data-depth='0'\]/,
    );
    expect(cssContent).toMatch(
      /\.app-shell\[data-theme='purple'\][\s\S]*?\.markmap-node\[data-depth='0'\]/,
    );
  });
});
