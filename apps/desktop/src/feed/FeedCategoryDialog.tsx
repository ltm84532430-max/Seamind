import React, { useEffect, useState } from 'react';

interface FeedCategoryDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}

export const FeedCategoryDialog: React.FC<FeedCategoryDialogProps> = ({
  isOpen,
  onClose,
  onCreate,
}) => {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
      setName('');
      setError('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      setError('请输入分类名称');
      return;
    }

    setSaving(true);
    setError('');
    try {
      await onCreate(cleanName);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="feed-dialog-overlay" onClick={() => !saving && onClose()}>
      <div
        className="feed-dialog-box"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="feed-dialog-header">
          <h3 className="feed-dialog-title">新建订阅分类</h3>
          <button
            type="button"
            className="feed-text-btn"
            onClick={onClose}
            disabled={saving}
          >
            关闭
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="feed-dialog-body">
            {error && <div className="feed-dialog-error">{error}</div>}
            <div className="feed-dialog-field">
              <label className="feed-dialog-label" htmlFor="feed-category-name">
                分类名称
              </label>
              <input
                id="feed-category-name"
                className="feed-dialog-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={40}
                placeholder="例如：宏观研究"
                autoFocus
              />
              <div className="feed-category-help">
                颜色会自动分配；创建后可从添加订阅窗口归入此分类。
              </div>
            </div>
          </div>
          <div className="feed-dialog-footer">
            <button
              type="button"
              className="feed-text-btn"
              onClick={onClose}
              disabled={saving}
            >
              取消
            </button>
            <button
              type="submit"
              className="feed-text-btn is-primary"
              disabled={saving}
            >
              {saving ? '保存中…' : '创建分类'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
