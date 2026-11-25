import React from 'react';
import { isShortTermSelection } from './paper-pdf-layout';
import type { PaperSelectionTranslation } from './paper-translation-store';

export interface SelectionPopoverAnchor {
  centerX: number;
  top: number;
  bottom: number;
  stageWidth: number;
  stageHeight: number;
}

interface PaperSelectionPopoverProps {
  selectedText: string;
  anchor: SelectionPopoverAnchor;
  translating: boolean;
  translation: PaperSelectionTranslation | null;
  error: string | null;
  savingHighlight: boolean;
  copiedNotice: boolean;
  onTranslate: (mode?: 'word' | 'passage') => void;
  onQuickHighlight: (withTranslation?: boolean) => void;
  onOpenAnnotationNote: (withTranslation?: boolean) => void;
  onCopyTranslation: () => void;
  onSendToCodeLab?: (language: 'python' | 'c' | 'cpp') => void;
  onClose: () => void;
}

export const PaperSelectionPopover: React.FC<PaperSelectionPopoverProps> = ({
  selectedText,
  anchor,
  translating,
  translation,
  error,
  savingHighlight,
  copiedNotice,
  onTranslate,
  onQuickHighlight,
  onOpenAnnotationNote,
  onCopyTranslation,
  onSendToCodeLab,
  onClose,
}) => {
  const autoIsWord = isShortTermSelection(selectedText);
  const currentMode =
    translation?.mode === 'word' || translation?.mode === 'passage'
      ? translation.mode
      : autoIsWord
        ? 'word'
        : 'passage';

  const cardWidth =
    translation || translating || error ? 360 : onSendToCodeLab ? 340 : 284;
  const clampedLeft = Math.min(
    Math.max(12, anchor.centerX - cardWidth / 2),
    Math.max(12, anchor.stageWidth - cardWidth - 12),
  );
  const placeAbove =
    anchor.top > 190 && anchor.bottom > anchor.stageHeight * 0.55;
  const topPx = placeAbove
    ? Math.max(12, anchor.top - (translation || error ? 185 : 46))
    : Math.min(
        Math.max(12, anchor.bottom + 8),
        Math.max(12, anchor.stageHeight - 72),
      );

  return (
    <div
      className="paper-selection-popover"
      style={{
        left: `${clampedLeft}px`,
        top: `${topPx}px`,
        width: `${cardWidth}px`,
      }}
      role="dialog"
      aria-label="划词操作与学术翻译"
      onMouseDown={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
    >
      <div className="paper-selection-popover-bar">
        <button
          type="button"
          className="is-primary"
          disabled={translating}
          onClick={() => onTranslate(currentMode)}
        >
          {translating
            ? '翻译中…'
            : translation
              ? '重新翻译'
              : currentMode === 'word'
                ? '词义 / 术语'
                : 'AI 翻译'}
        </button>
        {autoIsWord && (
          <button
            type="button"
            disabled={translating}
            title="按完整语义短语/语境翻译"
            onClick={() =>
              onTranslate(currentMode === 'word' ? 'passage' : 'word')
            }
          >
            {currentMode === 'word' ? '语境译' : '查词'}
          </button>
        )}
        <button
          type="button"
          disabled={savingHighlight}
          onClick={() => onQuickHighlight(false)}
        >
          高亮
        </button>
        <button type="button" onClick={() => onOpenAnnotationNote(false)}>
          批注
        </button>
        {onSendToCodeLab && (
          <details className="paper-selection-code-menu">
            <summary>实验本</summary>
            <div>
              {(['python', 'c', 'cpp'] as const).map((language) => (
                <button
                  key={language}
                  type="button"
                  onClick={() => onSendToCodeLab(language)}
                >
                  {language === 'python'
                    ? '送入 Python'
                    : language === 'cpp'
                      ? '送入 C++'
                      : '送入 C'}
                </button>
              ))}
            </div>
          </details>
        )}
        <button
          type="button"
          className="is-close"
          title="关闭"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      {(translating || translation || error) && (
        <div className="paper-selection-popover-body">
          <div className="paper-selection-popover-source">
            <span>{selectedText}</span>
            {translation?.phoneticOrPos && (
              <small>{translation.phoneticOrPos}</small>
            )}
          </div>

          {translating && (
            <div className="paper-selection-popover-status">
              正在结合论文语境生成学术译文…
            </div>
          )}

          {error && (
            <div className="paper-selection-popover-error">{error}</div>
          )}

          {!translating && translation && (
            <>
              <div className="paper-selection-popover-result">
                {translation.translation}
              </div>
              {translation.termNote && (
                <div className="paper-selection-popover-note">
                  {translation.termNote}
                </div>
              )}
              <div className="paper-selection-popover-actions">
                <button
                  type="button"
                  disabled={savingHighlight}
                  onClick={() => onQuickHighlight(true)}
                >
                  高亮+存译文
                </button>
                <button
                  type="button"
                  onClick={() => onOpenAnnotationNote(true)}
                >
                  填入批注
                </button>
                <button type="button" onClick={onCopyTranslation}>
                  {copiedNotice ? '已复制' : '复制译文'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
