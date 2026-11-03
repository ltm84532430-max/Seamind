import React, { useState } from 'react';

interface FeedOpmlDialogProps {
  isOpen: boolean;
  mode: 'import' | 'export';
  exportData?: string;
  onClose: () => void;
  onImport: (opmlXml: string) => Promise<number>;
}

export const FeedOpmlDialog: React.FC<FeedOpmlDialogProps> = ({
  isOpen,
  mode,
  exportData = '',
  onClose,
  onImport,
}) => {
  const [opmlText, setOpmlText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [copyFeedback, setCopyFeedback] = useState(false);

  if (!isOpen) return null;

  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!opmlText.trim()) {
      setMessage('请粘贴 OPML XML 文本内容');
      return;
    }
    setSubmitting(true);
    setMessage('');
    try {
      const count = await onImport(opmlText.trim());
      setMessage(`成功导入 ${count} 个订阅源！`);
      setTimeout(() => {
        onClose();
      }, 1200);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyExport = async () => {
    try {
      await navigator.clipboard.writeText(exportData);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    } catch {
      setMessage('复制到剪贴板失败，请手动全选复制');
    }
  };

  return (
    <div className="feed-dialog-overlay" onClick={onClose}>
      <div className="feed-dialog-box" onClick={(e) => e.stopPropagation()}>
        <div className="feed-dialog-header">
          <h3 className="feed-dialog-title">
            {mode === 'import' ? '导入 OPML 订阅列表' : '导出 OPML 订阅列表'}
          </h3>
          <button type="button" className="feed-text-btn" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="feed-dialog-body">
          {message && (
            <div style={{ color: 'var(--accent)', fontSize: '13px' }}>
              {message}
            </div>
          )}

          {mode === 'import' ? (
            <form
              onSubmit={handleImportSubmit}
              style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}
            >
              <div className="feed-dialog-field">
                <label className="feed-dialog-label">粘贴 OPML XML 内容</label>
                <textarea
                  className="feed-dialog-textarea"
                  placeholder="<opml version='2.0'>...</opml>"
                  value={opmlText}
                  onChange={(e) => setOpmlText(e.target.value)}
                  rows={8}
                  required
                />
              </div>
              <div
                className="feed-dialog-footer"
                style={{ padding: '0', background: 'transparent' }}
              >
                <button
                  type="button"
                  className="feed-text-btn"
                  onClick={onClose}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="feed-text-btn is-primary"
                  disabled={submitting}
                >
                  {submitting ? '导入解析中...' : '开始导入'}
                </button>
              </div>
            </form>
          ) : (
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}
            >
              <div className="feed-dialog-field">
                <label className="feed-dialog-label">
                  导出的 OPML 订阅内容
                </label>
                <textarea
                  className="feed-dialog-textarea"
                  value={exportData}
                  readOnly
                  rows={10}
                />
              </div>
              <div
                className="feed-dialog-footer"
                style={{ padding: '0', background: 'transparent' }}
              >
                <button
                  type="button"
                  className="feed-text-btn is-primary"
                  onClick={handleCopyExport}
                >
                  {copyFeedback ? '已复制到剪贴板！' : '复制到剪贴板'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
