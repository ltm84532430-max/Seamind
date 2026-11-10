import { useRef } from 'react';
import type { FeedArticleTranslationPhase } from './use-feed-article-translation';

export function FeedTranslationControls({
  phase,
  translating,
  progress,
  bilingual,
  channelSelected,
  channelBusy,
  channelDone,
  channelTotal,
  onTranslate,
  onRetranslate,
  onToggle,
  onCopy,
  onClear,
  onCancelArticle,
  onTranslateChannel,
  onCancelChannel,
}: {
  phase: FeedArticleTranslationPhase;
  translating: boolean;
  progress: { done: number; total: number };
  bilingual: boolean;
  channelSelected: boolean;
  channelBusy: boolean;
  channelDone: number;
  channelTotal: number;
  onTranslate: () => void;
  onRetranslate: () => void;
  onToggle: () => void;
  onCopy: () => void;
  onClear: () => void;
  onCancelArticle: () => void;
  onTranslateChannel: () => void;
  onCancelChannel: () => void;
}) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const closeMenu = () => menuRef.current?.removeAttribute('open');
  const articleLabel =
    phase === 'stale' || phase === 'unplaced' ? '重新翻译' : '翻译本文';

  return (
    <>
      {translating ? (
        <button
          type="button"
          className="feed-action-btn is-bilingual-active"
          disabled
          title={`正在逐段翻译（${progress.done}/${progress.total}）`}
        >
          翻译中 {progress.done}/{progress.total}
        </button>
      ) : phase === 'ready' ? (
        <div className="feed-translation-group">
          <button
            type="button"
            className={`feed-action-btn ${bilingual ? 'is-bilingual-active' : ''}`}
            onClick={onToggle}
            disabled={channelBusy}
            title={bilingual ? '隐藏段落下的译文' : '显示段落下的译文'}
          >
            双语 · {bilingual ? '开' : '关'}
          </button>
          <details className="feed-translation-menu" ref={menuRef}>
            <summary
              className="feed-action-btn feed-translation-menu-trigger"
              title="译文管理"
              aria-label="译文管理"
            >
              ▾
            </summary>
            <div className="feed-translation-dropdown">
              <button
                type="button"
                onClick={() => {
                  closeMenu();
                  onRetranslate();
                }}
              >
                重新翻译
              </button>
              <button
                type="button"
                onClick={() => {
                  closeMenu();
                  onCopy();
                }}
              >
                复制译文
              </button>
              <button
                type="button"
                className="is-danger"
                onClick={() => {
                  closeMenu();
                  onClear();
                }}
              >
                清除译文
              </button>
            </div>
          </details>
        </div>
      ) : (
        <button
          type="button"
          className="feed-action-btn"
          onClick={
            phase === 'stale' || phase === 'unplaced'
              ? onRetranslate
              : onTranslate
          }
          disabled={channelBusy}
          title="翻译当前文章，译文显示在每段下面"
        >
          {articleLabel}
        </button>
      )}

      {translating && (
        <button
          type="button"
          className="feed-action-btn"
          onClick={onCancelArticle}
          title="停在当前这一小批结束后"
        >
          取消
        </button>
      )}

      {channelBusy ? (
        <>
          <button
            type="button"
            className="feed-action-btn is-bilingual-active"
            disabled
            title="正在翻译这个订阅源里的文章"
          >
            此源 {channelDone}/{channelTotal || '…'}
          </button>
          <button
            type="button"
            className="feed-action-btn"
            onClick={onCancelChannel}
          >
            取消
          </button>
        </>
      ) : (
        <button
          type="button"
          className="feed-action-btn"
          onClick={onTranslateChannel}
          disabled={!channelSelected || translating}
          title={
            channelSelected
              ? '翻译这个订阅源的未读文章，一轮最多 20 篇'
              : '请先选中一个订阅源'
          }
        >
          译此源
        </button>
      )}
    </>
  );
}
