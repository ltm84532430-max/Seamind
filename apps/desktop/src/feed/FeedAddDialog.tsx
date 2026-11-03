import React, { useState } from 'react';

interface FeedAddDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (
    url: string,
    category?: string,
    customTitle?: string,
  ) => Promise<void>;
}

const PRESET_FEEDS = [
  {
    name: '阮一峰的网络日志',
    url: 'https://www.ruanyifeng.com/blog/atom.xml',
    category: '技术博客',
  },
  {
    name: 'Rust 官方博客',
    url: 'https://blog.rust-lang.org/feed.xml',
    category: '技术博客',
  },
  {
    name: 'GitHub 官方博客',
    url: 'https://github.blog/feed/',
    category: '技术博客',
  },
  {
    name: 'Hacker News Top',
    url: 'https://news.ycombinator.com/rss',
    category: '资讯聚合',
  },
  {
    name: 'Solidot 奇客',
    url: 'https://www.solidot.org/index.rss',
    category: '资讯聚合',
  },
];

export const FeedAddDialog: React.FC<FeedAddDialogProps> = ({
  isOpen,
  onClose,
  onAdd,
}) => {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('技术博客');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanUrl = url.trim();
    if (!cleanUrl) {
      setError('请输入订阅源或博客地址');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      await onAdd(
        cleanUrl,
        category.trim() || undefined,
        title.trim() || undefined,
      );
      setUrl('');
      setTitle('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSelectPreset = (preset: (typeof PRESET_FEEDS)[0]) => {
    setUrl(preset.url);
    setTitle(preset.name);
    setCategory(preset.category);
  };

  return (
    <div className="feed-dialog-overlay" onClick={onClose}>
      <div className="feed-dialog-box" onClick={(e) => e.stopPropagation()}>
        <div className="feed-dialog-header">
          <h3 className="feed-dialog-title">添加博客 / RSS 订阅</h3>
          <button type="button" className="feed-text-btn" onClick={onClose}>
            关闭
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="feed-dialog-body">
            {error && (
              <div style={{ color: 'var(--accent)', fontSize: '13px' }}>
                {error}
              </div>
            )}

            <div className="feed-dialog-field">
              <label className="feed-dialog-label">
                订阅源或博客链接 (RSS / Atom / JSON Feed)
              </label>
              <input
                type="text"
                className="feed-dialog-input"
                placeholder="https://example.com/feed.xml"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                autoFocus
                required
              />
            </div>

            <div className="feed-dialog-field">
              <label className="feed-dialog-label">快捷预设源推荐</label>
              <div className="feed-presets">
                {PRESET_FEEDS.map((p) => (
                  <button
                    type="button"
                    key={p.url}
                    className="feed-preset-chip"
                    onClick={() => handleSelectPreset(p)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="feed-dialog-field">
              <label className="feed-dialog-label">
                自定义名称 (可选，留空将自动抓取)
              </label>
              <input
                type="text"
                className="feed-dialog-input"
                placeholder="我的博客"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="feed-dialog-field">
              <label className="feed-dialog-label">归类分组</label>
              <input
                type="text"
                className="feed-dialog-input"
                placeholder="技术博客 / 业界资讯 / 学术前沿"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
            </div>
          </div>

          <div className="feed-dialog-footer">
            <button
              type="button"
              className="feed-text-btn"
              onClick={onClose}
              disabled={submitting}
            >
              取消
            </button>
            <button
              type="submit"
              className="feed-text-btn is-primary"
              disabled={submitting}
            >
              {submitting ? '抓取中...' : '确认添加'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
