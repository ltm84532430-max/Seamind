import { useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import type { Theme } from '../app/app-storage';

export type CodeLabThemePresetId =
  | 'system'
  | 'vscode-dark-plus'
  | 'one-dark-pro'
  | 'github-light'
  | 'solarized-light'
  | 'dracula'
  | 'monokai'
  | 'nord';

export type CodeLabFontFamilyId =
  'default' | 'jetbrains' | 'cascadia' | 'fira' | 'consolas';

export type CodeLabCellRadius = 'soft' | 'sharp';

export interface CodeLabEditorAppearance {
  themePreset: CodeLabThemePresetId;
  fontSize: number;
  lineHeight: number;
  fontFamily: CodeLabFontFamilyId;
  tabSize: 2 | 4;
  wordWrap: boolean;
  showLineNumbers: boolean;
  cellRadius: CodeLabCellRadius;
  customCss: string;
}

export interface CodeLabPalette {
  id: CodeLabThemePresetId;
  label: string;
  shortLabel: string;
  isDark: boolean;
  bg: string;
  surfaceBg: string;
  fg: string;
  gutterBg: string;
  gutterFg: string;
  gutterActiveFg: string;
  activeLine: string;
  selection: string;
  caret: string;
  bracket: string;
  border: string;
  tokKw: string;
  tokStr: string;
  tokNum: string;
  tokCmt: string;
  tokFn: string;
  tokType: string;
  tokOp: string;
  tokProp: string;
}

export const CODELAB_APPEARANCE_STORAGE_KEY = 'seamind.codelab.appearance.v1';
export const CODELAB_APPEARANCE_EVENT = 'seamind:codelab-appearance-changed';

export const DEFAULT_CODELAB_APPEARANCE: CodeLabEditorAppearance = {
  themePreset: 'system',
  fontSize: 13.5,
  lineHeight: 1.6,
  fontFamily: 'default',
  tabSize: 4,
  wordWrap: false,
  showLineNumbers: true,
  cellRadius: 'soft',
  customCss: '',
};

export const CODELAB_FONT_OPTIONS: ReadonlyArray<{
  id: CodeLabFontFamilyId;
  label: string;
  cssValue: string;
}> = [
  {
    id: 'default',
    label: '默认等宽',
    cssValue:
      'var(--mono, "JetBrains Mono", "Cascadia Mono", Consolas, monospace)',
  },
  {
    id: 'jetbrains',
    label: 'JetBrains Mono',
    cssValue: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
  },
  {
    id: 'cascadia',
    label: 'Cascadia Code',
    cssValue: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
  },
  {
    id: 'fira',
    label: 'Fira Code',
    cssValue: '"Fira Code", "JetBrains Mono", Consolas, monospace',
  },
  {
    id: 'consolas',
    label: 'Consolas',
    cssValue: 'Consolas, "Courier New", monospace',
  },
];

export const VSCODE_PRESET_PALETTES: ReadonlyArray<CodeLabPalette> = [
  {
    id: 'vscode-dark-plus',
    label: 'VS Code Dark+',
    shortLabel: 'Dark+',
    isDark: true,
    bg: '#1e1e1e',
    surfaceBg: '#1e1e1e',
    fg: '#d4d4d4',
    gutterBg: '#1e1e1e',
    gutterFg: '#858585',
    gutterActiveFg: '#c6c6c6',
    activeLine: 'rgba(255, 255, 255, 0.045)',
    selection: 'rgba(38, 79, 120, 0.65)',
    caret: '#aeafad',
    bracket: 'rgba(0, 122, 204, 0.3)',
    border: '#333333',
    tokKw: '#569cd6',
    tokStr: '#ce9178',
    tokNum: '#b5cea8',
    tokCmt: '#6a9955',
    tokFn: '#dcdcaa',
    tokType: '#4ec9b0',
    tokOp: '#d4d4d4',
    tokProp: '#9cdcfe',
  },
  {
    id: 'one-dark-pro',
    label: 'One Dark Pro',
    shortLabel: 'One Dark',
    isDark: true,
    bg: '#282c34',
    surfaceBg: '#282c34',
    fg: '#abb2bf',
    gutterBg: '#282c34',
    gutterFg: '#5c6370',
    gutterActiveFg: '#abb2bf',
    activeLine: 'rgba(255, 255, 255, 0.04)',
    selection: 'rgba(62, 68, 81, 0.78)',
    caret: '#528bff',
    bracket: 'rgba(97, 175, 239, 0.25)',
    border: '#3a404c',
    tokKw: '#c678dd',
    tokStr: '#98c379',
    tokNum: '#d19a66',
    tokCmt: '#5c6370',
    tokFn: '#61afef',
    tokType: '#e5c07b',
    tokOp: '#56b6c2',
    tokProp: '#e06c75',
  },
  {
    id: 'github-light',
    label: 'GitHub Light',
    shortLabel: 'GH Light',
    isDark: false,
    bg: '#ffffff',
    surfaceBg: '#ffffff',
    fg: '#24292f',
    gutterBg: '#f6f8fa',
    gutterFg: '#8c959f',
    gutterActiveFg: '#24292f',
    activeLine: 'rgba(208, 215, 222, 0.28)',
    selection: 'rgba(9, 105, 218, 0.16)',
    caret: '#0969da',
    bracket: 'rgba(9, 105, 218, 0.18)',
    border: '#d0d7de',
    tokKw: '#cf222e',
    tokStr: '#0a3069',
    tokNum: '#0550ae',
    tokCmt: '#6e7781',
    tokFn: '#8250df',
    tokType: '#953800',
    tokOp: '#24292f',
    tokProp: '#0550ae',
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    shortLabel: 'Solarized',
    isDark: false,
    bg: '#fdf6e3',
    surfaceBg: '#fdf6e3',
    fg: '#586e75',
    gutterBg: '#eee8d5',
    gutterFg: '#93a1a1',
    gutterActiveFg: '#586e75',
    activeLine: 'rgba(238, 232, 213, 0.65)',
    selection: 'rgba(38, 139, 210, 0.18)',
    caret: '#268bd2',
    bracket: 'rgba(38, 139, 210, 0.2)',
    border: '#e0d7bd',
    tokKw: '#859900',
    tokStr: '#2aa198',
    tokNum: '#d33682',
    tokCmt: '#93a1a1',
    tokFn: '#268bd2',
    tokType: '#b58900',
    tokOp: '#657b83',
    tokProp: '#cb4b16',
  },
  {
    id: 'dracula',
    label: 'Dracula',
    shortLabel: 'Dracula',
    isDark: true,
    bg: '#282a36',
    surfaceBg: '#282a36',
    fg: '#f8f8f2',
    gutterBg: '#282a36',
    gutterFg: '#6272a4',
    gutterActiveFg: '#f8f8f2',
    activeLine: 'rgba(68, 71, 90, 0.55)',
    selection: 'rgba(68, 71, 90, 0.85)',
    caret: '#f8f8f2',
    bracket: 'rgba(189, 147, 249, 0.28)',
    border: '#44475a',
    tokKw: '#ff79c6',
    tokStr: '#f1fa8c',
    tokNum: '#bd93f9',
    tokCmt: '#6272a4',
    tokFn: '#50fa7b',
    tokType: '#8be9fd',
    tokOp: '#ff79c6',
    tokProp: '#ffb86c',
  },
  {
    id: 'monokai',
    label: 'Monokai Pro',
    shortLabel: 'Monokai',
    isDark: true,
    bg: '#272822',
    surfaceBg: '#272822',
    fg: '#f8f8f2',
    gutterBg: '#272822',
    gutterFg: '#75715e',
    gutterActiveFg: '#cfcfc2',
    activeLine: 'rgba(255, 255, 255, 0.045)',
    selection: 'rgba(73, 72, 62, 0.88)',
    caret: '#f8f8f0',
    bracket: 'rgba(166, 226, 46, 0.25)',
    border: '#3e3d32',
    tokKw: '#f92672',
    tokStr: '#e6db74',
    tokNum: '#ae81ff',
    tokCmt: '#75715e',
    tokFn: '#a6e22e',
    tokType: '#66d9ef',
    tokOp: '#f92672',
    tokProp: '#fd971f',
  },
  {
    id: 'nord',
    label: 'Nord Polar',
    shortLabel: 'Nord',
    isDark: true,
    bg: '#2e3440',
    surfaceBg: '#2e3440',
    fg: '#d8dee9',
    gutterBg: '#2e3440',
    gutterFg: '#616e88',
    gutterActiveFg: '#e5e9f0',
    activeLine: 'rgba(59, 66, 82, 0.6)',
    selection: 'rgba(76, 86, 106, 0.72)',
    caret: '#88c0d0',
    bracket: 'rgba(136, 192, 208, 0.26)',
    border: '#434c5e',
    tokKw: '#81a1c1',
    tokStr: '#a3be8c',
    tokNum: '#b48ead',
    tokCmt: '#616e88',
    tokFn: '#88c0d0',
    tokType: '#8fbcbb',
    tokOp: '#81a1c1',
    tokProp: '#d8dee9',
  },
];

const PRESET_MAP = new Map<CodeLabThemePresetId, CodeLabPalette>(
  VSCODE_PRESET_PALETTES.map((p) => [p.id, p]),
);

const VALID_PRESETS = new Set<CodeLabThemePresetId>([
  'system',
  ...VSCODE_PRESET_PALETTES.map((p) => p.id),
]);

const VALID_FONTS = new Set<CodeLabFontFamilyId>(
  CODELAB_FONT_OPTIONS.map((f) => f.id),
);

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

export function normalizeCodeLabAppearance(
  raw: Partial<CodeLabEditorAppearance> | null | undefined,
): CodeLabEditorAppearance {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_CODELAB_APPEARANCE };
  }
  const themePreset =
    raw.themePreset && VALID_PRESETS.has(raw.themePreset)
      ? raw.themePreset
      : DEFAULT_CODELAB_APPEARANCE.themePreset;
  const fontSize =
    typeof raw.fontSize === 'number' && Number.isFinite(raw.fontSize)
      ? Math.round(clamp(raw.fontSize, 11, 20) * 2) / 2
      : DEFAULT_CODELAB_APPEARANCE.fontSize;
  const lineHeight =
    typeof raw.lineHeight === 'number' && Number.isFinite(raw.lineHeight)
      ? Math.round(clamp(raw.lineHeight, 1.3, 2.0) * 20) / 20
      : DEFAULT_CODELAB_APPEARANCE.lineHeight;
  const fontFamily =
    raw.fontFamily && VALID_FONTS.has(raw.fontFamily)
      ? raw.fontFamily
      : DEFAULT_CODELAB_APPEARANCE.fontFamily;
  const tabSize: 2 | 4 = raw.tabSize === 2 ? 2 : 4;
  const wordWrap = Boolean(raw.wordWrap);
  const showLineNumbers =
    typeof raw.showLineNumbers === 'boolean'
      ? raw.showLineNumbers
      : DEFAULT_CODELAB_APPEARANCE.showLineNumbers;
  const cellRadius: CodeLabCellRadius =
    raw.cellRadius === 'sharp' ? 'sharp' : 'soft';
  const customCss =
    typeof raw.customCss === 'string' ? raw.customCss.slice(0, 8000) : '';

  return {
    themePreset,
    fontSize,
    lineHeight,
    fontFamily,
    tabSize,
    wordWrap,
    showLineNumbers,
    cellRadius,
    customCss,
  };
}

export function resolveCodeLabFontFamilyCss(id: CodeLabFontFamilyId): string {
  return (
    CODELAB_FONT_OPTIONS.find((item) => item.id === id)?.cssValue ??
    CODELAB_FONT_OPTIONS[0].cssValue
  );
}

export function resolveCodeLabPalette(
  preset: CodeLabThemePresetId,
  appTheme: Theme,
): CodeLabPalette {
  const matched = PRESET_MAP.get(preset);
  if (matched) return matched;

  if (appTheme === 'navy') {
    return {
      id: 'system',
      label: '跟随系统',
      shortLabel: '系统',
      isDark: true,
      bg: 'transparent',
      surfaceBg: 'var(--term-surface)',
      fg: '#dce8f5',
      gutterBg: 'transparent',
      gutterFg: '#547194',
      gutterActiveFg: '#9dc5ec',
      activeLine: 'rgba(100, 181, 246, 0.055)',
      selection: 'rgba(100, 181, 246, 0.22)',
      caret: '#64b5f6',
      bracket: 'rgba(100, 181, 246, 0.24)',
      border: '#172b47',
      tokKw: '#7cc4fa',
      tokStr: '#7bd8be',
      tokNum: '#e5b878',
      tokCmt: '#5b799b',
      tokFn: '#a5d6ff',
      tokType: '#7bd8be',
      tokOp: '#9dc5ec',
      tokProp: '#dce8f5',
    };
  }
  if (appTheme === 'purple') {
    return {
      id: 'system',
      label: '跟随系统',
      shortLabel: '系统',
      isDark: true,
      bg: 'transparent',
      surfaceBg: 'var(--term-surface)',
      fg: '#efe6fb',
      gutterBg: 'transparent',
      gutterFg: '#775e96',
      gutterActiveFg: '#cfb9ee',
      activeLine: 'rgba(179, 152, 216, 0.06)',
      selection: 'rgba(179, 152, 216, 0.24)',
      caret: '#b398d8',
      bracket: 'rgba(179, 152, 216, 0.26)',
      border: '#2b1b42',
      tokKw: '#c9a7f5',
      tokStr: '#8fd4be',
      tokNum: '#e5ba82',
      tokCmt: '#7e679b',
      tokFn: '#d7beff',
      tokType: '#8fd4be',
      tokOp: '#cfb9ee',
      tokProp: '#efe6fb',
    };
  }
  if (appTheme === 'dark') {
    return {
      id: 'system',
      label: '跟随系统',
      shortLabel: '系统',
      isDark: true,
      bg: 'transparent',
      surfaceBg: 'var(--term-surface)',
      fg: '#d8dfe4',
      gutterBg: 'transparent',
      gutterFg: '#55606a',
      gutterActiveFg: '#9aa8b3',
      activeLine: 'rgba(255, 255, 255, 0.032)',
      selection: 'rgba(127, 182, 158, 0.22)',
      caret: '#7fb69e',
      bracket: 'rgba(127, 182, 158, 0.24)',
      border: '#222930',
      tokKw: '#8ab4d8',
      tokStr: '#8cc2a6',
      tokNum: '#d9a973',
      tokCmt: '#66727c',
      tokFn: '#c6d8ec',
      tokType: '#7fb69e',
      tokOp: '#9aa8b3',
      tokProp: '#d8dfe4',
    };
  }
  return {
    id: 'system',
    label: '跟随系统',
    shortLabel: '系统',
    isDark: false,
    bg: 'transparent',
    surfaceBg: 'var(--term-surface)',
    fg: '#1b2228',
    gutterBg: 'transparent',
    gutterFg: '#98a2ac',
    gutterActiveFg: '#4c5761',
    activeLine: 'rgba(15, 23, 42, 0.026)',
    selection: 'rgba(44, 110, 88, 0.16)',
    caret: '#2c6e58',
    bracket: 'rgba(44, 110, 88, 0.16)',
    border: '#e5e9ee',
    tokKw: '#1f4f8a',
    tokStr: '#2c6e58',
    tokNum: '#7c4d25',
    tokCmt: '#8a949e',
    tokFn: '#4c3a8a',
    tokType: '#1c6b64',
    tokOp: '#4c5761',
    tokProp: '#1b2228',
  };
}

export function buildCodeLabAppearanceCssVars(
  appearance: CodeLabEditorAppearance,
  appTheme: Theme,
): CSSProperties {
  const palette = resolveCodeLabPalette(appearance.themePreset, appTheme);
  const vars: Record<string, string> = {
    '--cl-editor-font-size': `${appearance.fontSize}px`,
    '--cl-editor-line-height': String(appearance.lineHeight),
    '--cl-editor-font-family': resolveCodeLabFontFamilyCss(
      appearance.fontFamily,
    ),
    '--cl-cell-radius': appearance.cellRadius === 'soft' ? '6px' : '0px',
    '--cl-tok-kw': palette.tokKw,
    '--cl-tok-str': palette.tokStr,
    '--cl-tok-num': palette.tokNum,
    '--cl-tok-cmt': palette.tokCmt,
    '--cl-tok-fn': palette.tokFn,
  };

  if (appearance.themePreset !== 'system') {
    vars['--cl-editor-surface-bg'] = palette.surfaceBg;
    vars['--cl-editor-surface-fg'] = palette.fg;
    vars['--cl-editor-gutter-bg'] = palette.gutterBg;
    vars['--cl-editor-gutter-fg'] = palette.gutterFg;
    vars['--cl-editor-border'] = palette.border;
  }

  return vars as CSSProperties;
}

// ---------------------------------------------------------------------------
// Reactive External Store (syncs all split panes & popout windows live)
// ---------------------------------------------------------------------------

let cachedSnapshot: CodeLabEditorAppearance | null = null;
const listeners = new Set<() => void>();

export function loadCodeLabAppearance(): CodeLabEditorAppearance {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_CODELAB_APPEARANCE };
  }
  try {
    const raw = window.localStorage.getItem(CODELAB_APPEARANCE_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CODELAB_APPEARANCE };
    return normalizeCodeLabAppearance(
      JSON.parse(raw) as Partial<CodeLabEditorAppearance>,
    );
  } catch {
    return { ...DEFAULT_CODELAB_APPEARANCE };
  }
}

function getSnapshot(): CodeLabEditorAppearance {
  if (!cachedSnapshot) {
    cachedSnapshot = loadCodeLabAppearance();
  }
  return cachedSnapshot;
}

function notifyListeners(): void {
  listeners.forEach((fn) => fn());
}

export function saveCodeLabAppearance(
  next: CodeLabEditorAppearance,
): CodeLabEditorAppearance {
  const normalized = normalizeCodeLabAppearance(next);
  cachedSnapshot = normalized;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(
        CODELAB_APPEARANCE_STORAGE_KEY,
        JSON.stringify(normalized),
      );
      window.dispatchEvent(
        new CustomEvent(CODELAB_APPEARANCE_EVENT, { detail: normalized }),
      );
    } catch {
      // ignore storage quota errors
    }
  }
  notifyListeners();
  return normalized;
}

export function patchCodeLabAppearance(
  patch: Partial<CodeLabEditorAppearance>,
): CodeLabEditorAppearance {
  return saveCodeLabAppearance({ ...getSnapshot(), ...patch });
}

export function resetCodeLabAppearance(): CodeLabEditorAppearance {
  return saveCodeLabAppearance({ ...DEFAULT_CODELAB_APPEARANCE });
}

function subscribeCodeLabAppearance(callback: () => void): () => void {
  listeners.add(callback);
  if (typeof window === 'undefined') {
    return () => {
      listeners.delete(callback);
    };
  }
  const handleStorage = (event: StorageEvent) => {
    if (event.key && event.key !== CODELAB_APPEARANCE_STORAGE_KEY) return;
    cachedSnapshot = loadCodeLabAppearance();
    notifyListeners();
  };
  const handleCustom = () => {
    cachedSnapshot = loadCodeLabAppearance();
    callback();
  };
  window.addEventListener('storage', handleStorage);
  window.addEventListener(CODELAB_APPEARANCE_EVENT, handleCustom);
  return () => {
    listeners.delete(callback);
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(CODELAB_APPEARANCE_EVENT, handleCustom);
  };
}

export function useCodeLabAppearance(): CodeLabEditorAppearance {
  return useSyncExternalStore(
    subscribeCodeLabAppearance,
    getSnapshot,
    () => DEFAULT_CODELAB_APPEARANCE,
  );
}
