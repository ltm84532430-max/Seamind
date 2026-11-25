import { memo, useEffect, useState } from 'react';
import {
  CODELAB_FONT_OPTIONS,
  patchCodeLabAppearance,
  resetCodeLabAppearance,
  useCodeLabAppearance,
  VSCODE_PRESET_PALETTES,
  type CodeLabFontFamilyId,
  type CodeLabThemePresetId,
} from './codelab-appearance';

export interface CodeLabAppearancePanelProps {
  onNotify?: (message: string) => void;
}

const THEME_SWATCH_CARDS: ReadonlyArray<{
  id: CodeLabThemePresetId;
  label: string;
  bg: string;
  border: string;
  dots: [string, string, string];
  isDark: boolean;
}> = [
  {
    id: 'system',
    label: '跟随系统',
    bg: 'linear-gradient(135deg, #f8fafc 50%, #1e242b 50%)',
    border: 'var(--term-border-strong)',
    dots: ['#2c6e58', '#1f4f8a', '#7c4d25'],
    isDark: false,
  },
  ...VSCODE_PRESET_PALETTES.map((p) => ({
    id: p.id,
    label: p.shortLabel,
    bg: p.bg,
    border: p.border,
    dots: [p.tokKw, p.tokStr, p.tokFn] as [string, string, string],
    isDark: p.isDark,
  })),
];

export const CodeLabAppearancePanel = memo(function CodeLabAppearancePanel({
  onNotify,
}: CodeLabAppearancePanelProps) {
  const appearance = useCodeLabAppearance();
  const [cssDraft, setCssDraft] = useState(appearance.customCss);
  const [cssOpen, setCssOpen] = useState(Boolean(appearance.customCss.trim()));

  useEffect(() => {
    setCssDraft(appearance.customCss);
  }, [appearance.customCss]);

  const stepFontSize = (delta: number) => {
    patchCodeLabAppearance({ fontSize: appearance.fontSize + delta });
  };

  const handleApplyCustomCss = () => {
    patchCodeLabAppearance({ customCss: cssDraft });
    onNotify?.('已应用编辑器自定义 CSS');
  };

  const handleReset = () => {
    resetCodeLabAppearance();
    setCssDraft('');
    onNotify?.('已恢复编辑器默认样式');
  };

  return (
    <div className="editor-style-panel">
      {/* 1. VS Code Theme Presets */}
      <section className="editor-style-section">
        <div className="editor-style-section-head">
          <span>代码主题</span>
          <span className="editor-style-hint">VS Code 预设</span>
        </div>
        <div
          className="editor-theme-grid"
          role="radiogroup"
          aria-label="选择代码编辑区主题"
        >
          {THEME_SWATCH_CARDS.map((card) => {
            const active = appearance.themePreset === card.id;
            return (
              <button
                key={card.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={`editor-theme-card${active ? ' is-active' : ''}`}
                onClick={() => patchCodeLabAppearance({ themePreset: card.id })}
                title={`切换到 ${card.label} 主题`}
              >
                <span
                  className="editor-theme-swatch"
                  style={{
                    background: card.bg,
                    borderColor: card.border,
                  }}
                  aria-hidden="true"
                >
                  <span
                    className="editor-theme-dot"
                    style={{ background: card.dots[0] }}
                  />
                  <span
                    className="editor-theme-dot"
                    style={{ background: card.dots[1] }}
                  />
                  <span
                    className="editor-theme-dot"
                    style={{ background: card.dots[2] }}
                  />
                </span>
                <span className="editor-theme-name">{card.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* 2. Typography Controls */}
      <section className="editor-style-section">
        <div className="editor-style-section-head">
          <span>字体与排版</span>
        </div>

        <div className="editor-style-row">
          <span className="editor-style-label">代码字号</span>
          <div className="editor-style-stepper">
            <button
              type="button"
              onClick={() => stepFontSize(-0.5)}
              disabled={appearance.fontSize <= 11}
              aria-label="减小代码字号"
            >
              −
            </button>
            <span className="editor-style-value">
              {appearance.fontSize.toFixed(1)}px
            </span>
            <button
              type="button"
              onClick={() => stepFontSize(0.5)}
              disabled={appearance.fontSize >= 20}
              aria-label="增大代码字号"
            >
              +
            </button>
          </div>
        </div>
        <input
          type="range"
          className="editor-style-slider"
          min={11}
          max={20}
          step={0.5}
          value={appearance.fontSize}
          aria-label="代码字号滑块"
          onChange={(e) =>
            patchCodeLabAppearance({ fontSize: Number(e.target.value) })
          }
        />

        <div className="editor-style-row">
          <span className="editor-style-label">代码行高</span>
          <span className="editor-style-value">
            {appearance.lineHeight.toFixed(2)}
          </span>
        </div>
        <input
          type="range"
          className="editor-style-slider"
          min={1.3}
          max={2.0}
          step={0.05}
          value={appearance.lineHeight}
          aria-label="代码行高滑块"
          onChange={(e) =>
            patchCodeLabAppearance({ lineHeight: Number(e.target.value) })
          }
        />

        <div className="editor-style-row">
          <label className="editor-style-label" htmlFor="codelab-font-select">
            等宽字体
          </label>
          <select
            id="codelab-font-select"
            className="editor-style-select"
            value={appearance.fontFamily}
            onChange={(e) =>
              patchCodeLabAppearance({
                fontFamily: e.target.value as CodeLabFontFamilyId,
              })
            }
          >
            {CODELAB_FONT_OPTIONS.map((font) => (
              <option key={font.id} value={font.id}>
                {font.label}
              </option>
            ))}
          </select>
        </div>

        <div className="editor-style-row">
          <span className="editor-style-label">Tab 缩进</span>
          <div className="editor-style-seg">
            <button
              type="button"
              className={appearance.tabSize === 2 ? 'is-active' : ''}
              onClick={() => patchCodeLabAppearance({ tabSize: 2 })}
            >
              2 空格
            </button>
            <button
              type="button"
              className={appearance.tabSize === 4 ? 'is-active' : ''}
              onClick={() => patchCodeLabAppearance({ tabSize: 4 })}
            >
              4 空格
            </button>
          </div>
        </div>
      </section>

      {/* 3. Editor Behavior & Surface Toggles */}
      <section className="editor-style-section">
        <div className="editor-style-section-head">
          <span>编辑区显示</span>
        </div>

        <label className="editor-style-toggle-row">
          <span>显示代码行号</span>
          <input
            type="checkbox"
            checked={appearance.showLineNumbers}
            onChange={(e) =>
              patchCodeLabAppearance({ showLineNumbers: e.target.checked })
            }
          />
        </label>

        <label className="editor-style-toggle-row">
          <span>长行自动换行</span>
          <input
            type="checkbox"
            checked={appearance.wordWrap}
            onChange={(e) =>
              patchCodeLabAppearance({ wordWrap: e.target.checked })
            }
          />
        </label>

        <label className="editor-style-toggle-row">
          <span>圆角代码卡片</span>
          <input
            type="checkbox"
            checked={appearance.cellRadius === 'soft'}
            onChange={(e) =>
              patchCodeLabAppearance({
                cellRadius: e.target.checked ? 'soft' : 'sharp',
              })
            }
          />
        </label>
      </section>

      {/* 4. Optional Custom CSS Override */}
      <section className="editor-style-section">
        <button
          type="button"
          className="editor-style-collapse-btn"
          aria-expanded={cssOpen}
          onClick={() => setCssOpen((v) => !v)}
        >
          <span>自定义 CSS（高级）</span>
          <span className="editor-style-hint">{cssOpen ? '收起' : '展开'}</span>
        </button>

        {cssOpen && (
          <div className="editor-style-css-box">
            <textarea
              className="editor-style-css-input"
              rows={5}
              spellCheck={false}
              value={cssDraft}
              onChange={(e) => setCssDraft(e.target.value)}
              placeholder={'.codelab-cell {\n  /* 例如自定义字距或边距 */\n}'}
              aria-label="编辑器自定义 CSS"
            />
            <div className="editor-style-css-actions">
              <button
                type="button"
                className="terminal-rail-mini-btn is-accent"
                onClick={handleApplyCustomCss}
              >
                应用 CSS
              </button>
              {cssDraft.trim() && (
                <button
                  type="button"
                  className="terminal-rail-mini-btn"
                  onClick={() => {
                    setCssDraft('');
                    patchCodeLabAppearance({ customCss: '' });
                  }}
                >
                  清空
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      <div className="editor-style-footer">
        <button
          type="button"
          className="editor-style-reset-btn"
          onClick={handleReset}
        >
          恢复默认样式
        </button>
      </div>
    </div>
  );
});
