import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createMarkdownPreviewMinimap } from '../workbench/markdown-minimap';
import type { FeedArticle } from './types';

interface FeedReaderViewProps {
  article: FeedArticle | null;
  hasChannels?: boolean;
  onToggleRead: (articleId: string, currentStatus: 'read' | 'unread') => void;
  onToggleStar: (articleId: string, currentStarred: boolean) => void;
  onGenerateMindmap: (articleId: string, title: string) => void;
  onAnalyzeArticle?: (articleId: string) => void;
  onAddPreset?: (url: string, category: string, title: string) => void;
  onPlayAudio?: (article: FeedArticle) => void;
  onRestoreDefaultFeeds?: () => void;
  isRestoring?: boolean;
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

/**
 * 按照类似 VS Code 缩略图的行宽，将长文本自然折叠为适度长度的视觉行（~36 视觉宽度）
 * 这样缩略图中的段落将呈现为与正文比例相符的自然文本块，避免单行横向过度拉伸或字符挤压。
 */
function wrapParagraph(text: string, maxLen = 36): string {
  if (!text) return '';
  if (/^#{1,6}\s/.test(text) || /^```/.test(text)) return text;

  const lines: string[] = [];
  let current = '';
  let currentVisualWidth = 0;

  for (const char of text) {
    if (char === '\n') {
      if (current.trim()) lines.push(current.trimEnd());
      current = '';
      currentVisualWidth = 0;
      continue;
    }

    const charWidth = char.charCodeAt(0) > 255 ? 2 : 1;
    if (currentVisualWidth + charWidth > maxLen && current.trim()) {
      lines.push(current.trimEnd());
      current = char;
      currentVisualWidth = charWidth;
    } else {
      current += char;
      currentVisualWidth += charWidth;
    }
  }

  if (current.trim()) {
    lines.push(current.trimEnd());
  }

  return lines.join('\n');
}

/**
 * 将 HTML 或摘要快速提炼为适于 Minimap 渲染的 Markdown 文本结构（保留标题、段落与代码块色彩区分）
 */
function extractArticleText(article: FeedArticle): string {
  const parts: string[] = [`# ${article.title}`];
  if (article.channelTitle) {
    parts.push(`*来源：${article.channelTitle}*`);
  }
  if (article.content) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(article.content, 'text/html');
      const walk = (el: Node): string => {
        let text = '';
        for (const child of Array.from(el.childNodes)) {
          if (child.nodeType === Node.TEXT_NODE) {
            text += child.textContent;
          } else if (child.nodeType === Node.ELEMENT_NODE) {
            const tag = (child as Element).tagName.toLowerCase();
            const inner = walk(child).trim();
            if (!inner) continue;
            if (tag === 'h1') text += `\n# ${inner}\n`;
            else if (tag === 'h2') text += `\n## ${inner}\n`;
            else if (tag === 'h3' || tag === 'h4') text += `\n### ${inner}\n`;
            else if (tag === 'pre' || tag === 'code')
              text += `\n\`\`\`\n${inner}\n\`\`\`\n`;
            else if (tag === 'p') text += `\n${wrapParagraph(inner)}\n`;
            else if (tag === 'li') text += `\n- ${wrapParagraph(inner)}\n`;
            else text += ` ${inner} `;
          }
        }
        return text;
      };
      const bodyText = walk(doc.body).trim();
      if (bodyText) {
        parts.push(bodyText);
      }
    } catch {
      parts.push(wrapParagraph(article.content.replace(/<[^>]+>/g, ' ')));
    }
  } else if (article.summary) {
    parts.push(wrapParagraph(article.summary));
  }
  return parts.join('\n\n');
}

export const FeedReaderView: React.FC<FeedReaderViewProps> = ({
  article,
  hasChannels = false,
  onToggleRead,
  onToggleStar,
  onGenerateMindmap,
  onAnalyzeArticle,
  onAddPreset,
  onPlayAudio,
  onRestoreDefaultFeeds,
  isRestoring = false,
}) => {
  const [generatingMap, setGeneratingMap] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const minimapHostRef = useRef<HTMLDivElement>(null);

  const articleMarkdown = useMemo(() => {
    return article ? extractArticleText(article) : '';
  }, [article]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [article?.id]);

  useEffect(() => {
    const scrollEl = scrollRef.current;
    const hostEl = minimapHostRef.current;
    if (!scrollEl || !hostEl || !articleMarkdown) return;

    hostEl.innerHTML = '';
    const minimap = createMarkdownPreviewMinimap(
      articleMarkdown,
      scrollEl,
      hostEl,
    );

    return () => {
      minimap.destroy();
    };
  }, [articleMarkdown]);

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

            {onRestoreDefaultFeeds && (
              <div style={{ margin: '14px 0' }}>
                <button
                  type="button"
                  className="feed-action-btn is-primary"
                  style={{
                    padding: '8px 20px',
                    fontSize: '13px',
                    fontWeight: 600,
                  }}
                  disabled={isRestoring}
                  onClick={onRestoreDefaultFeeds}
                >
                  {isRestoring
                    ? '正在注入订阅源并拉取内容...'
                    : '一键恢复全部分类订阅源（含金融与军事播客）'}
                </button>
              </div>
            )}

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
      {/* 栏目 Header：与侧边栏、文章列表栏保持 48px 完全一致的水平线高度 */}
      <div className="feed-reader-toolbar">
        <div className="feed-reader-toolbar-left">
          {onAnalyzeArticle && (
            <button
              type="button"
              className="feed-action-btn"
              onClick={() => onAnalyzeArticle(article.id)}
              title="在右侧终端分析当前文章"
            >
              终端分析
            </button>
          )}
          <button
            type="button"
            className="feed-primary-btn"
            onClick={handleMindmapClick}
            disabled={generatingMap}
            title="将当前文章一键转化为 Markmap 导图"
          >
            <svg
              viewBox="0 0 16 16"
              width="13"
              height="13"
              aria-hidden="true"
              className="feed-btn-icon"
            >
              <circle cx="4" cy="8" r="2.2" fill="currentColor" />
              <circle cx="12" cy="4.5" r="1.8" fill="currentColor" />
              <circle cx="12" cy="11.5" r="1.8" fill="currentColor" />
              <path
                d="M4 8h3.5c1.5 0 2.5-.8 3-2M7.5 8c1 0 2 .8 2.5 2l1 1.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            <span>{generatingMap ? '导图生成中...' : '转思维导图'}</span>
          </button>
        </div>

        <div className="feed-reader-toolbar-right">
          <button
            type="button"
            className={`feed-action-btn ${article.starred ? 'is-starred-active' : ''}`}
            onClick={() => onToggleStar(article.id, article.starred)}
            title={article.starred ? '取消星标收藏' : '添加星标收藏'}
          >
            <svg
              viewBox="0 0 16 16"
              width="12"
              height="12"
              aria-hidden="true"
              className="feed-btn-icon"
            >
              <path
                d="M8 1.5l1.9 4.3 4.6.4-3.4 3.1 1 4.6L8 11.5l-4.1 2.4 1-4.6-3.4-3.1 4.6-.4L8 1.5z"
                fill={article.starred ? 'currentColor' : 'none'}
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
            <span>{article.starred ? '已收藏' : '收藏'}</span>
          </button>

          <button
            type="button"
            className={`feed-action-btn ${article.readStatus === 'read' ? 'is-read-active' : ''}`}
            onClick={() => onToggleRead(article.id, article.readStatus)}
            title={article.readStatus === 'read' ? '标记为未读' : '标记为已读'}
          >
            <svg
              viewBox="0 0 16 16"
              width="12"
              height="12"
              aria-hidden="true"
              className="feed-btn-icon"
            >
              {article.readStatus === 'read' ? (
                <circle cx="8" cy="8" r="3.2" fill="currentColor" />
              ) : (
                <path
                  d="M3 8.5l3.5 3.5 7-7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </svg>
            <span>
              {article.readStatus === 'read' ? '标记未读' : '标记已读'}
            </span>
          </button>

          {article.url && (
            <button
              type="button"
              className="feed-action-btn"
              onClick={handleOpenOriginal}
              title="在浏览器中打开原文"
            >
              <svg
                viewBox="0 0 16 16"
                width="12"
                height="12"
                aria-hidden="true"
                className="feed-btn-icon"
              >
                <path
                  d="M6 3.5H3.5a1 1 0 00-1 1v8a1 1 0 001 1h8a1 1 0 001-1V10M9 3.5h3.5v3.5M7 9l5.5-5.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>原文</span>
            </button>
          )}
        </div>
      </div>

      <div className="feed-reader-body-container">
        <div ref={scrollRef} className="feed-reader-scroll">
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

            {article.audioUrl && (
              <div className="feed-article-audio-hero">
                <div className="feed-audio-hero-visual" aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    width="26"
                    height="26"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  >
                    <path d="M3 10v4M7 6v12M11 3v18M15 7v10M19 10v4M22 12v0" />
                  </svg>
                </div>
                <div className="feed-audio-hero-info">
                  <div className="feed-audio-hero-tag">播客节目</div>
                  <div className="feed-audio-hero-meta">
                    {article.audioDuration
                      ? `时长约 ${Math.ceil(article.audioDuration / 60)} 分钟`
                      : '可在线播放'}
                  </div>
                </div>
                <button
                  type="button"
                  className="feed-audio-hero-play-btn"
                  onClick={() => onPlayAudio?.(article)}
                  title="在底部播放器中收听"
                >
                  <svg
                    viewBox="0 0 16 16"
                    width="14"
                    height="14"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M4 3.5l9 4.5-9 4.5V3.5z" />
                  </svg>
                  <span>播放</span>
                </button>
              </div>
            )}

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
                    className="feed-header-btn is-primary"
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
                  className="feed-header-btn is-primary"
                  onClick={handleOpenOriginal}
                >
                  前往原文查看
                </button>
              </div>
            )}
          </article>
        </div>
        <div
          ref={minimapHostRef}
          className="feed-reader-minimap-host"
          aria-hidden="true"
        />
      </div>
    </main>
  );
};
