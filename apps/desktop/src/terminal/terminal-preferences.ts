import type {
  TerminalCursorStyle,
  TerminalPreferences,
} from './terminal-types';

const PREFERENCES_STORAGE_KEY = 'seamind:terminal-preferences:v1';
const PREFERENCES_EVENT = 'seamind:terminal-preferences-changed';

export const DEFAULT_TERMINAL_PREFERENCES: TerminalPreferences = {
  fontSize: 13,
  lineHeight: 1.28,
  fontFamily:
    '"JetBrains Mono", "Cascadia Mono", "Cascadia Code", Consolas, monospace',
  cursorStyle: 'block',
  cursorBlink: true,
  saveOnSelect: false,
  smartCopyPaste: true,
  webglEnabled: true,
  scrollback: 10000,
  semanticEscapeChars: `,│\`|:"' ()[]{}<>\\t`,
};

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function parseCursorStyle(value: unknown): TerminalCursorStyle {
  if (value === 'block' || value === 'underline' || value === 'bar') {
    return value;
  }
  return DEFAULT_TERMINAL_PREFERENCES.cursorStyle;
}

export function normalizeTerminalPreferences(
  raw: Partial<TerminalPreferences> | null | undefined,
): TerminalPreferences {
  const input = raw ?? {};
  return {
    fontSize: clampNumber(
      input.fontSize,
      10,
      22,
      DEFAULT_TERMINAL_PREFERENCES.fontSize,
    ),
    lineHeight: Number(
      clampNumber(
        input.lineHeight,
        1.0,
        1.6,
        DEFAULT_TERMINAL_PREFERENCES.lineHeight,
      ).toFixed(2),
    ),
    fontFamily:
      typeof input.fontFamily === 'string' && input.fontFamily.trim()
        ? input.fontFamily.trim()
        : DEFAULT_TERMINAL_PREFERENCES.fontFamily,
    cursorStyle: parseCursorStyle(input.cursorStyle),
    cursorBlink:
      typeof input.cursorBlink === 'boolean'
        ? input.cursorBlink
        : DEFAULT_TERMINAL_PREFERENCES.cursorBlink,
    saveOnSelect:
      typeof input.saveOnSelect === 'boolean'
        ? input.saveOnSelect
        : DEFAULT_TERMINAL_PREFERENCES.saveOnSelect,
    smartCopyPaste:
      typeof input.smartCopyPaste === 'boolean'
        ? input.smartCopyPaste
        : DEFAULT_TERMINAL_PREFERENCES.smartCopyPaste,
    webglEnabled:
      typeof input.webglEnabled === 'boolean'
        ? input.webglEnabled
        : DEFAULT_TERMINAL_PREFERENCES.webglEnabled,
    scrollback: Math.round(
      clampNumber(
        input.scrollback,
        1000,
        25000,
        DEFAULT_TERMINAL_PREFERENCES.scrollback,
      ),
    ),
    semanticEscapeChars:
      typeof input.semanticEscapeChars === 'string' &&
      input.semanticEscapeChars.length > 0
        ? input.semanticEscapeChars
        : DEFAULT_TERMINAL_PREFERENCES.semanticEscapeChars,
  };
}

export function loadTerminalPreferences(): TerminalPreferences {
  if (typeof localStorage === 'undefined') return DEFAULT_TERMINAL_PREFERENCES;
  try {
    const raw = localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (!raw) return DEFAULT_TERMINAL_PREFERENCES;
    return normalizeTerminalPreferences(
      JSON.parse(raw) as Partial<TerminalPreferences>,
    );
  } catch {
    return DEFAULT_TERMINAL_PREFERENCES;
  }
}

export function saveTerminalPreferences(
  next: Partial<TerminalPreferences>,
): TerminalPreferences {
  const current = loadTerminalPreferences();
  const merged = normalizeTerminalPreferences({ ...current, ...next });
  try {
    localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // 持久化失败不影响内存即时应用
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<TerminalPreferences>(PREFERENCES_EVENT, {
        detail: merged,
      }),
    );
  }
  return merged;
}

export function onTerminalPreferencesChanged(
  listener: (prefs: TerminalPreferences) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => {
    const custom = event as CustomEvent<TerminalPreferences>;
    listener(custom.detail ?? loadTerminalPreferences());
  };
  window.addEventListener(PREFERENCES_EVENT, handler);
  return () => window.removeEventListener(PREFERENCES_EVENT, handler);
}
