import React, { useMemo, useRef, useState } from 'react';
import { feedApi } from './feed-api';
import type { OpmlOutlineItem } from './types';

interface FeedOpmlDialogProps {
  isOpen: boolean;
  mode: 'import' | 'export';
  exportData?: string;
  existingUrls: string[];
  onClose: () => void;
  onFeedAdded: () => Promise<void>;
}

export const FeedOpmlDialog: React.FC<FeedOpmlDialogProps> = ({
  isOpen,
  mode,
  exportData = '',
  existingUrls = [],
  onClose,
  onFeedAdded,
}) => {
  const [opmlText, setOpmlText] = useState('');
  const [parsedItems, setParsedItems] = useState<OpmlOutlineItem[] | null>(
    null,
  );
  const [parsing, setParsing] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [addingUrls, setAddingUrls] = useState<Record<string, boolean>>({});
  const [addedUrls, setAddedUrls] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState('');
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [batchAdding, setBatchAdding] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const subscribedSet = useMemo(() => {
    const set = new Set<string>();
    if (Array.isArray(existingUrls)) {
      for (const u of existingUrls) {
        if (typeof u === 'string' && u.trim()) {
          set.add(u.toLowerCase().trim());
        }
      }
    }
    if (addedUrls) {
      for (const url of Object.keys(addedUrls)) {
        if (typeof url === 'string' && url.trim()) {
          set.add(url.toLowerCase().trim());
        }
      }
    }
    return set;
  }, [existingUrls, addedUrls]);

  if (!isOpen) return null;

  const handleParseContent = async (xmlString: string) => {
    const cleanXml = xmlString.trim();
    if (!cleanXml) {
      setMessage('OPML 内容为空，请选择文件或粘贴内容');
      return;
    }
    setParsing(true);
    setMessage('');
    try {
      const items = await feedApi.parseOpml(cleanXml);
      if (items.length === 0) {
        setMessage('未在文件中找到有效的 RSS/Atom 订阅源条目');
      } else {
        setParsedItems(items);
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setParsing(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        setOpmlText(content);
        handleParseContent(content);
      }
    };
    reader.onerror = () => {
      setMessage('读取本地文件失败');
    };
    reader.readAsText(file);
  };

  const handleAddSingle = async (item: OpmlOutlineItem) => {
    const urlKey = item.xmlUrl.toLowerCase().trim();
    setAddingUrls((prev) => ({ ...prev, [urlKey]: true }));
    setMessage('');
    try {
      await feedApi.addChannel(item.xmlUrl, item.category, item.title);
      setAddedUrls((prev) => ({ ...prev, [urlKey]: true }));
      await onFeedAdded();
    } catch (err) {
      setMessage(
        `添加「${item.title}」失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setAddingUrls((prev) => ({ ...prev, [urlKey]: false }));
    }
  };

  const handleAddAllRemaining = async () => {
    if (!parsedItems) return;
    const remaining = parsedItems.filter(
      (item) => !subscribedSet.has(item.xmlUrl.toLowerCase().trim()),
    );
    if (remaining.length === 0) return;

    setBatchAdding(true);
    setMessage(`正在批量添加 ${remaining.length} 个订阅源...`);
    let count = 0;

    for (const item of remaining) {
      const urlKey = item.xmlUrl.toLowerCase().trim();
      setAddingUrls((prev) => ({ ...prev, [urlKey]: true }));
      try {
        await feedApi.addChannel(item.xmlUrl, item.category, item.title);
        setAddedUrls((prev) => ({ ...prev, [urlKey]: true }));
        count += 1;
      } catch (err) {
        console.warn(`添加 ${item.title} 失败：`, err);
      } finally {
        setAddingUrls((prev) => ({ ...prev, [urlKey]: false }));
      }
    }

    setBatchAdding(false);
    await onFeedAdded();
    setMessage(`批量添加完成！成功订阅 ${count} 个新源。`);
  };

  const filteredItems = useMemo(() => {
    if (!parsedItems || !Array.isArray(parsedItems)) return [];
    if (!filterQuery.trim()) return parsedItems;
    const q = filterQuery.toLowerCase().trim();
    return parsedItems.filter(
      (item) =>
        (item?.title && String(item.title).toLowerCase().includes(q)) ||
        (item?.xmlUrl && String(item.xmlUrl).toLowerCase().includes(q)) ||
        (item?.category && String(item.category).toLowerCase().includes(q)),
    );
  }, [parsedItems, filterQuery]);

  const remainingCount = useMemo(() => {
    if (!parsedItems || !Array.isArray(parsedItems)) return 0;
    return parsedItems.filter((item) => {
      const urlKey = item?.xmlUrl
        ? String(item.xmlUrl).toLowerCase().trim()
        : '';
      return urlKey && !subscribedSet.has(urlKey);
    }).length;
  }, [parsedItems, subscribedSet]);

  const handleCopyExport = async () => {
    try {
      await navigator.clipboard.writeText(exportData);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    } catch {
      setMessage('复制到剪贴板失败，请手动全选复制');
    }
  };

  const handleReset = () => {
    setParsedItems(null);
    setOpmlText('');
    setMessage('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="feed-dialog-overlay" onClick={onClose}>
      <div
        className={`feed-dialog-box ${parsedItems ? 'is-opml-wide' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="feed-dialog-header">
          <h3 className="feed-dialog-title">
            {mode === 'import'
              ? parsedItems
                ? `OPML 订阅列表 (解析到 ${parsedItems.length} 个源)`
                : '导入 OPML 订阅文件'
              : '导出 OPML 订阅列表'}
          </h3>
          <button type="button" className="feed-text-btn" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="feed-dialog-body">
          {message && (
            <div
              style={{
                color: message.includes('成功')
                  ? 'var(--ink)'
                  : 'var(--accent)',
                fontSize: '13px',
                padding: '6px 10px',
                borderRadius: '4px',
                background: 'rgba(0, 0, 0, 0.04)',
              }}
            >
              {message}
            </div>
          )}

          {mode === 'import' ? (
            !parsedItems ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '16px',
                }}
              >
                <input
                  type="file"
                  accept=".opml,.xml"
                  ref={fileInputRef}
                  style={{ display: 'none' }}
                  onChange={handleFileChange}
                />

                <div className="feed-opml-upload-card">
                  <div
                    style={{
                      fontSize: '14px',
                      fontWeight: 600,
                      color: 'var(--ink)',
                    }}
                  >
                    从其他阅读器导入 OPML 文件
                  </div>
                  <div style={{ fontSize: '12.5px', color: 'var(--muted)' }}>
                    支持 Feedly、Inoreader、NetNewsWire 等阅读器导出的 .opml /
                    .xml 文件
                  </div>
                  <button
                    type="button"
                    className="feed-text-btn is-primary"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={parsing}
                  >
                    {parsing ? '正在解析文件...' : '选择本地 OPML 文件'}
                  </button>
                </div>

                <div
                  style={{ display: 'flex', alignItems: 'center', gap: '10px' }}
                >
                  <div
                    style={{
                      flex: 1,
                      height: '1px',
                      background: 'var(--line)',
                    }}
                  />
                  <span style={{ fontSize: '11.5px', color: 'var(--muted)' }}>
                    或者直接粘贴 XML 内容
                  </span>
                  <div
                    style={{
                      flex: 1,
                      height: '1px',
                      background: 'var(--line)',
                    }}
                  />
                </div>

                <div className="feed-dialog-field">
                  <textarea
                    className="feed-dialog-textarea"
                    placeholder="<opml version='2.0'>..."
                    value={opmlText}
                    onChange={(e) => setOpmlText(e.target.value)}
                    rows={6}
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
                    type="button"
                    className="feed-text-btn is-primary"
                    onClick={() => handleParseContent(opmlText)}
                    disabled={parsing || !opmlText.trim()}
                  >
                    {parsing ? '解析中...' : '解析内容并选择订阅'}
                  </button>
                </div>
              </div>
            ) : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '10px',
                  }}
                >
                  <input
                    type="text"
                    className="feed-search-input"
                    placeholder="过滤源名称、分类或链接..."
                    value={filterQuery}
                    onChange={(e) => setFilterQuery(e.target.value)}
                    style={{ flex: 1 }}
                  />

                  {remainingCount > 0 && (
                    <button
                      type="button"
                      className="feed-text-btn is-primary"
                      onClick={handleAddAllRemaining}
                      disabled={batchAdding}
                    >
                      {batchAdding
                        ? '正在添加...'
                        : `一键添加全部未订阅 (${remainingCount})`}
                    </button>
                  )}

                  <button
                    type="button"
                    className="feed-text-btn"
                    onClick={handleReset}
                    disabled={batchAdding}
                  >
                    重新选择文件
                  </button>
                </div>

                <div className="feed-opml-list">
                  {filteredItems.map((item, idx) => {
                    const urlKey = item.xmlUrl.toLowerCase().trim();
                    const isSubscribed = subscribedSet.has(urlKey);
                    const isAdding = !!addingUrls[urlKey];

                    return (
                      <div
                        key={`${item.xmlUrl}-${idx}`}
                        className="feed-opml-item"
                      >
                        <div className="feed-opml-item-info">
                          <div className="feed-opml-item-title-row">
                            <span className="feed-opml-item-title">
                              {item.title || '未命名订阅源'}
                            </span>
                            {item.category && (
                              <span className="feed-tag-pill">
                                {item.category}
                              </span>
                            )}
                          </div>
                          <span
                            className="feed-opml-item-url"
                            title={item.xmlUrl}
                          >
                            {item.xmlUrl}
                          </span>
                        </div>

                        <div>
                          {isSubscribed ? (
                            <span
                              className="feed-tag-pill"
                              style={{
                                color: 'var(--muted)',
                                background: 'rgba(0, 0, 0, 0.04)',
                              }}
                            >
                              已订阅
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="feed-text-btn is-primary"
                              disabled={isAdding || batchAdding}
                              onClick={() => handleAddSingle(item)}
                            >
                              {isAdding ? '添加中...' : '+ 订阅'}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )
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
