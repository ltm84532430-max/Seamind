import React, { useState } from 'react';
import type { FeedArticle } from './types';

interface FeedReaderViewProps {
  article: FeedArticle | null;
  hasChannels?: boolean;
  onToggleRead: (articleId: string, currentStatus: 'read' | 'unread') => void;
  onToggleStar: (articleId: string, currentStarred: boolean) => void;
  onGenerateMindmap: (articleId: string, title: string) => void;
  onAddPreset?: (url: string, category: string, title: string) => void;
}

function formatFullDate(timestamp: number): string {
  if (!timestamp) return '未知时间';
  const d = new Date(timestamp * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

export const FeedReaderView: React.FC<FeedReaderViewProps> = ({
  article,
  hasChannels = false,
  onToggleRead,
  onToggleStar,
  onGenerateMindmap,
  onAddPreset,
}) => {
  const [generatingMap, setGeneratingMap] = useState(false);

  if (!article) {
    return (
      <main className="feed-reader-pane">
        <div className="feed-reader-empty">
          <div className="feed-welcome-box">
            <h2 className="feed-welcome-title">博客与 RSS 沉浸阅读</h2>
            <p className="feed-welcome-desc">
              支持 RSS 2.0、Atom 1.0 与 JSON
              Feed。可自动清洗排版正文，并一键提炼解构为 Markmap 思维导图。
            </p>

            <div
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: 'var(--ink)',
                marginTop: '8px',
              }}
            >
              推荐优质源快捷订阅：
            </div>

            <div className="feed-welcome-presets">
              <div className="feed-welcome-preset-item">
                <div>
                  <div style={{ fontWeight: 600 }}>Rust 官方技术博客</div>
                  <div style={{ fontSize: '11.5px', color: 'var(--muted)' }}>
                    https://blog.rust-lang.org/feed.xml
                  </div>
                </div>
                {onAddPreset && (
                  <button
                    type="button"
                    className="feed-text-btn is-primary"
                    onClick={() =>
                      onAddPreset(
                        'https://blog.rust-lang.org/feed.xml',
                        '技术博客',
                        'Rust 官方博客',
                      )
                    }
                  >
                    一键订阅
                  </button>
                )}
              </div>

              <div className="feed-welcome-preset-item">
                <div>
                  <div style={{ fontWeight: 600 }}>阮一峰的网络日志</div>
                  <div style={{ fontSize: '11.5px', color: 'var(--muted)' }}>
                    https://www.ruanyifeng.com/blog/atom.xml
                  </div>
                </div>
                {onAddPreset && (
                  <button
                    type="button"
                    className="feed-text-btn is-primary"
                    onClick={() =>
                      onAddPreset(
                        'https://www.ruanyifeng.com/blog/atom.xml',
                        '技术周刊',
                        '阮一峰的网络日志',
                      )
                    }
                  >
                    一键订阅
                  </button>
                )}
              </div>

              <div className="feed-welcome-preset-item">
                <div>
                  <div style={{ fontWeight: 600 }}>GitHub 官方博客</div>
                  <div style={{ fontSize: '11.5px', color: 'var(--muted)' }}>
                    https://github.blog/feed/
                  </div>
                </div>
                {onAddPreset && (
                  <button
                    type="button"
                    className="feed-text-btn is-primary"
                    onClick={() =>
                      onAddPreset(
                        'https://github.blog/feed/',
                        '技术博客',
                        'GitHub Blog',
                      )
                    }
                  >
                    一键订阅
                  </button>
                )}
              </div>
            </div>

            {hasChannels && (
              <div
                style={{
                  fontSize: '12.5px',
                  color: 'var(--muted)',
                  marginTop: '12px',
                }}
              >
                已订阅源文章可在左侧列表中点击选择阅读，支持 J/K 上下快捷翻阅。
              </div>
            )}
          </div>
        </div>
      </main>
    );
  }

  const handleMindmapClick = async () => {
    setGeneratingMap(true);
    try {
      await onGenerateMindmap(article.id, article.title);
    } finally {
      setGeneratingMap(false);
    }
  };

  const handleOpenOriginal = () => {
    if (article.url) {
      window.open(article.url, '_blank');
    }
  };

  return (
    <main className="feed-reader-pane">
      <div className="feed-reader-toolbar">
        <div className="feed-reader-toolbar-left">
          <button
            type="button"
            className="feed-text-btn is-primary"
            onClick={handleMindmapClick}
            disabled={generatingMap}
            title="将当前文章一键转化为 Markmap 导图"
          >
            {generatingMap ? '导图生成中...' : '转思维导图'}
          </button>
        </div>

        <div className="feed-reader-toolbar-right">
          <button
            type="button"
            className={`feed-text-btn ${article.starred ? 'is-primary' : ''}`}
            onClick={() => onToggleStar(article.id, article.starred)}
          >
            {article.starred ? '已收藏' : '收藏'}
          </button>

          <button
            type="button"
            className="feed-text-btn"
            onClick={() => onToggleRead(article.id, article.readStatus)}
          >
            {article.readStatus === 'read' ? '标记未读' : '标记已读'}
          </button>

          {article.url && (
            <button
              type="button"
              className="feed-text-btn"
              onClick={handleOpenOriginal}
            >
              浏览器打开
            </button>
          )}
        </div>
      </div>

      <div className="feed-reader-scroll">
        <article className="feed-reader-content-wrap">
          <h1 className="feed-article-headline">{article.title}</h1>

          <div className="feed-article-byline">
            <span className="feed-byline-item">
              来源：<b>{article.channelTitle}</b>
            </span>
            {article.author && (
              <span className="feed-byline-item">作者：{article.author}</span>
            )}
            <span className="feed-byline-item">
              发布于：{formatFullDate(article.publishedAt)}
            </span>
            <span className="feed-byline-item">
              预计阅读：{article.readingTimeMin} 分钟
            </span>
          </div>

          {article.content ? (
            <div
              className="feed-article-body"
              dangerouslySetInnerHTML={{ __html: article.content }}
            />
          ) : article.summary ? (
            <div className="feed-article-body">
              <p>{article.summary}</p>
              <p style={{ marginTop: '24px' }}>
                <button
                  type="button"
                  className="feed-text-btn is-primary"
                  onClick={handleOpenOriginal}
                >
                  本文章仅提供摘要，点击前往原文阅读全文
                </button>
              </p>
            </div>
          ) : (
            <div className="feed-article-body">
              <p style={{ color: 'var(--muted)' }}>暂无正文内容</p>
              <button
                type="button"
                className="feed-text-btn is-primary"
                onClick={handleOpenOriginal}
              >
                前往原文查看
              </button>
            </div>
          )}
        </article>
      </div>
    </main>
  );
};
