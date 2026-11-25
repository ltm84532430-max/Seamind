import { describe, expect, it } from 'vitest';
import {
  buildCodeLabAppearanceCssVars,
  DEFAULT_CODELAB_APPEARANCE,
  normalizeCodeLabAppearance,
  resolveCodeLabPalette,
  VSCODE_PRESET_PALETTES,
} from '../src/terminal/codelab-appearance';

describe('codelab-appearance model & VS Code presets', () => {
  it('normalizes and clamps invalid typography values safely', () => {
    const normalized = normalizeCodeLabAppearance({
      themePreset: 'vscode-dark-plus',
      fontSize: 42,
      lineHeight: 0.5,
      tabSize: 2,
      wordWrap: true,
      showLineNumbers: false,
      cellRadius: 'sharp',
    });

    expect(normalized.themePreset).toBe('vscode-dark-plus');
    expect(normalized.fontSize).toBe(20);
    expect(normalized.lineHeight).toBe(1.3);
    expect(normalized.tabSize).toBe(2);
    expect(normalized.wordWrap).toBe(true);
    expect(normalized.showLineNumbers).toBe(false);
    expect(normalized.cellRadius).toBe('sharp');
  });

  it('falls back to defaults on unknown preset or font family', () => {
    const normalized = normalizeCodeLabAppearance({
      themePreset: 'non-existent' as never,
      fontFamily: 'comic-sans' as never,
    });

    expect(normalized.themePreset).toBe(DEFAULT_CODELAB_APPEARANCE.themePreset);
    expect(normalized.fontFamily).toBe(DEFAULT_CODELAB_APPEARANCE.fontFamily);
  });

  it('resolves all VS Code presets with full syntax token palettes', () => {
    expect(VSCODE_PRESET_PALETTES.length).toBeGreaterThanOrEqual(7);
    for (const preset of VSCODE_PRESET_PALETTES) {
      const resolved = resolveCodeLabPalette(preset.id, 'light');
      expect(resolved.bg).toBeTruthy();
      expect(resolved.tokKw).toBeTruthy();
      expect(resolved.tokStr).toBeTruthy();
      expect(resolved.tokFn).toBeTruthy();
    }
  });

  it('generates CSS variables for typography and non-system VS Code surfaces', () => {
    const vars = buildCodeLabAppearanceCssVars(
      {
        ...DEFAULT_CODELAB_APPEARANCE,
        themePreset: 'one-dark-pro',
        fontSize: 15,
        lineHeight: 1.75,
      },
      'light',
    ) as Record<string, string>;

    expect(vars['--cl-editor-font-size']).toBe('15px');
    expect(vars['--cl-editor-line-height']).toBe('1.75');
    expect(vars['--cl-editor-surface-bg']).toBe('#282c34');
    expect(vars['--cl-tok-kw']).toBe('#c678dd');
  });
});
