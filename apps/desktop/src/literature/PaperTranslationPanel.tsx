import React from 'react';
import type { PaperParagraphBlock } from './paper-pdf-layout';
import type { PaperTranslationDisplayMode } from './PaperPdfPage';
import type {
  DualPdfResult,
  PaperPageTranslationRecord,
  Pdf2ZhStatus,
} from './paper-translation-store';

export interface PaperTranslationSidebarProps {
  allowDualPdf?: boolean;
  visiblePages: number[];
  pageNumber: number;
  displayMode: PaperTranslationDisplayMode;
  onChangeDisplayMode: (mode: PaperTranslationDisplayMode) => void;
  blocksByPage: Record<number, PaperParagraphBlock[]>;
  translationsByPage: Record<number, PaperPageTranslationRecord>;
  translatingPage: number | null;
  progress: { done: number; total: number } | null;
  translationError: string | null;
  activeBlock: { pageNumber: number; blockId: number } | null;
  onTranslatePage: (targetPage: number, force?: boolean) => void;
  onCancelTranslate: () => void;
  onClearPageCache: (targetPage: number) => void;
  onSelectBlock: (targetPage: number, blockId: number) => void;
  onSaveBlockAsAnnotation: (
    block: PaperParagraphBlock,
    translation: string,
  ) => void;
  pdf2ZhStatus: Pdf2ZhStatus | null;
  checkingPdf2Zh: boolean;
  generatingDualPdf: boolean;
  dualPdfResult: DualPdfResult | null;
  viewingDualPdf: boolean;
  dualPdfError: string | null;
  onCheckPdf2Zh: () => void;
  onGenerateDualPdf: (force?: boolean) => void;
  onToggleDualPdf: () => void;
}

const DISPLAY_MODE_OPTIONS: Array<{
  mode: PaperTranslationDisplayMode;
  label: string;
  hint: string;
}> = [
  { mode: 'sidebar', label: '侧栏对照', hint: '左页原文，右/侧栏分段双语对照' },
  {
    mode: 'overlay',
    label: '页内覆盖',
    hint: '在原段落区域直接覆写中文译文（保留图表/公式）',
  },
  {
    mode: 'bilingual',
    label: '页内浮卡',
    hint: '页内标识段落，点击弹出双语译文浮卡',
  },
];

export const PaperTranslationSidebar: React.FC<
  PaperTranslationSidebarProps
> = ({
  allowDualPdf = true,
  visiblePages,
  pageNumber,
  displayMode,
  onChangeDisplayMode,
  blocksByPage,
  translationsByPage,
  translatingPage,
  progress,
  translationError,
  activeBlock,
  onTranslatePage,
  onCancelTranslate,
  onClearPageCache,
  onSelectBlock,
  onSaveBlockAsAnnotation,
  pdf2ZhStatus,
  checkingPdf2Zh,
  generatingDualPdf,
  dualPdfResult,
  viewingDualPdf,
  dualPdfError,
  onCheckPdf2Zh,
  onGenerateDualPdf,
  onToggleDualPdf,
}) => {
  const targetPages = visiblePages.length > 0 ? visiblePages : [pageNumber];
  const primaryPage = targetPages[0] ?? pageNumber;
  const primaryRecord = translationsByPage[primaryPage];
  const isTranslating = translatingPage !== null;

  return (
    <div className="paper-translation-sidebar">
      <div className="paper-translation-controls">
        <div className="paper-translation-primary-row">
          {isTranslating ? (
            <button
              type="button"
              className="is-danger"
              onClick={onCancelTranslate}
            >
              停止翻译（第 {translatingPage} 页
              {progress ? ` ${progress.done}/${progress.total}` : ''}）
            </button>
          ) : (
            <button
              type="button"
              className="is-primary"
              onClick={() => onTranslatePage(primaryPage, false)}
            >
              {primaryRecord
                ? `已翻译第 ${primaryPage} 页`
                : `翻译第 ${primaryPage} 页`}
            </button>
          )}
          <button
            type="button"
            disabled={isTranslating}
            title="强制重新调用 AI 翻译当前页"
            onClick={() => onTranslatePage(primaryPage, true)}
          >
            重译
          </button>
          {primaryRecord && (
            <button
              type="button"
              disabled={isTranslating}
              title="清除本页本地译文缓存"
              onClick={() => onClearPageCache(primaryPage)}
            >
              清缓存
            </button>
          )}
        </div>

        <div
          className="paper-translation-mode-row"
          role="group"
          aria-label="双语显示模式"
        >
          {DISPLAY_MODE_OPTIONS.map((option) => (
            <button
              key={option.mode}
              type="button"
              className={displayMode === option.mode ? 'is-active' : ''}
              title={option.hint}
              onClick={() => onChangeDisplayMode(option.mode)}
            >
              {option.label}
            </button>
          ))}
        </div>

        {primaryRecord && (
          <div className="paper-translation-meta-line">
            <span>
              模型：{primaryRecord.model || '默认'} · 共{' '}
              {primaryRecord.paragraphs.length} 段
            </span>
          </div>
        )}
        {translationError && (
          <div className="paper-translation-error">{translationError}</div>
        )}
      </div>

      <div className="paper-translation-blocks">
        {targetPages.map((pg) => {
          const blocks = blocksByPage[pg] ?? [];
          const record = translationsByPage[pg];
          const transMap = new Map<number, string>(
            (record?.paragraphs ?? []).map((item) => [
              item.id,
              item.translation,
            ]),
          );

          if (blocks.length === 0) {
            return (
              <div key={`empty-${pg}`} className="paper-translation-empty">
                正在解析第 {pg} 页段落结构，或该页暂无可选正文段落。
              </div>
            );
          }

          return (
            <section
              key={`page-${pg}`}
              className="paper-translation-page-group"
            >
              <div className="paper-translation-page-heading">
                <span>
                  第 {pg} 页 · {blocks.length} 段
                </span>
                {!record && translatingPage !== pg && (
                  <button
                    type="button"
                    disabled={isTranslating}
                    onClick={() => onTranslatePage(pg, false)}
                  >
                    翻译此页
                  </button>
                )}
              </div>

              {blocks.map((block) => {
                const translated = transMap.get(block.id);
                const isSelected =
                  activeBlock?.pageNumber === pg &&
                  activeBlock.blockId === block.id;

                return (
                  <article
                    key={`p-${pg}-b-${block.id}`}
                    className={`paper-translation-card ${isSelected ? 'is-active' : ''} ${block.isHeading ? 'is-heading' : ''}`}
                    onClick={() => onSelectBlock(pg, block.id)}
                  >
                    <div className="paper-translation-card-head">
                      <span>
                        #{block.id + 1}
                        {block.column !== 'full'
                          ? block.column === 'left'
                            ? ' · 左栏'
                            : ' · 右栏'
                          : ''}
                        {block.isHeading ? ' · 标题' : ''}
                      </span>
                      {translated && (
                        <button
                          type="button"
                          title="将此段原文与译文保存为阅读批注"
                          onClick={(event) => {
                            event.stopPropagation();
                            onSaveBlockAsAnnotation(block, translated);
                          }}
                        >
                          存批注
                        </button>
                      )}
                    </div>
                    <p className="paper-translation-source">{block.text}</p>
                    {translated ? (
                      <p className="paper-translation-target">{translated}</p>
                    ) : (
                      <p className="paper-translation-pending">
                        {translatingPage === pg ? '排队翻译中…' : '尚未翻译'}
                      </p>
                    )}
                  </article>
                );
              })}
            </section>
          );
        })}
      </div>

      {allowDualPdf && (
        <div className="paper-translation-dualpdf-box">
          <div className="paper-translation-dualpdf-head">
            <strong>双语重排 PDF（公式保真 · Phase 3）</strong>
            <button
              type="button"
              disabled={checkingPdf2Zh || generatingDualPdf}
              onClick={onCheckPdf2Zh}
            >
              {checkingPdf2Zh ? '检测中…' : '检测环境'}
            </button>
          </div>

          {pdf2ZhStatus && (
            <p className="paper-translation-dualpdf-status">
              {pdf2ZhStatus.available
                ? `引擎就绪：${pdf2ZhStatus.engine} (${pdf2ZhStatus.version ?? 'installed'})`
                : pdf2ZhStatus.message}
            </p>
          )}

          {dualPdfError && (
            <div className="paper-translation-error">{dualPdfError}</div>
          )}

          <div className="paper-translation-dualpdf-actions">
            <button
              type="button"
              disabled={generatingDualPdf || pdf2ZhStatus?.available === false}
              onClick={() => onGenerateDualPdf(false)}
            >
              {generatingDualPdf
                ? '正在生成双语 PDF…'
                : dualPdfResult
                  ? '重新/加载双语 PDF'
                  : '生成双语重排 PDF'}
            </button>
            {dualPdfResult && (
              <button
                type="button"
                className={viewingDualPdf ? 'is-active' : ''}
                onClick={onToggleDualPdf}
              >
                {viewingDualPdf ? '切回原版 PDF' : '查看双语 PDF'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
