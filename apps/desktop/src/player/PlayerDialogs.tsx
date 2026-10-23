import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { dateStamp, downloadTextFile } from './download';
import { usePlayerHost } from './host';
import { CloseIcon } from './icons';
import {
  parseSubscriptionFile,
  subscriptionsToNewPipeJson,
} from './import-subscriptions';
import type {
  ParsedSubscriptions,
  SubscriptionFormat,
} from './import-subscriptions';
import { playerApi, errorText } from './player-api';
import type { ImportSummary, PlayerSettings } from './types';

/** A modal box: Escape and a click outside close it, and focus returns to where it came from. */
function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    boxRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      opener?.focus();
    };
  }, []);
  return (
    <div
      className="player-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={boxRef}
        className="player-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="player-dialog-header">
          <h2>{title}</h2>
          <button
            type="button"
            className="player-icon-button"
            aria-label="关闭"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </header>
        <div className="player-dialog-body">{children}</div>
      </div>
    </div>
  );
}

const FORMAT_LABELS: Record<SubscriptionFormat, string> = {
  newpipe: 'NewPipe 订阅导出',
  'takeout-csv': 'Google Takeout（subscriptions.csv）',
  'takeout-json': 'Google Takeout（JSON）',
  opml: 'OPML 订阅列表',
};

/** Reads a subscription file of NewPipe, Google Takeout or an OPML list and follows its channels. */
export function ImportDialog({
  onClose,
  onImported,
}: {
  onClose(): void;
  onImported(summary: ImportSummary): void;
}) {
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedSubscriptions | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const choose = async (file: File | undefined) => {
    setError('');
    setParsed(null);
    if (!file) return;
    setFileName(file.name);
    try {
      const result = parseSubscriptionFile(await file.text());
      if (!result || result.channels.length === 0)
        setError(
          '这个文件里没有找到 YouTube 频道。支持 NewPipe 导出的 JSON、Google Takeout 的 subscriptions.csv 或 JSON，以及 OPML。',
        );
      else setParsed(result);
    } catch (reason) {
      setError(errorText(reason, '无法读取这个文件'));
    }
  };

  const confirm = async () => {
    if (!parsed || busy) return;
    setBusy(true);
    try {
      onImported(await playerApi.importChannels(parsed.channels));
    } catch (reason) {
      setError(errorText(reason, '导入失败'));
      setBusy(false);
    }
  };

  return (
    <Dialog title="导入订阅" onClose={onClose}>
      <p className="player-dialog-text">
        选择 NewPipe 导出的订阅文件、Google Takeout 的 subscriptions.csv（或
        JSON），或 OPML 列表。导入只会添加频道，不会删除已有的订阅。
      </p>
      <label className="player-file">
        <input
          type="file"
          accept=".json,.csv,.opml,.xml,.txt,application/json,text/csv,text/xml"
          onChange={(event) => {
            void choose(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <span className="player-button">选择文件…</span>
        <span className="player-file-name">{fileName || '尚未选择'}</span>
      </label>
      {parsed && (
        <p className="player-dialog-result" role="status">
          识别为 <strong>{FORMAT_LABELS[parsed.format]}</strong>：
          <strong>{parsed.channels.length}</strong> 个频道
          {parsed.skipped > 0 && `，另有 ${parsed.skipped} 项无法使用，已跳过`}
          。
        </p>
      )}
      {error && (
        <p className="player-dialog-error" role="alert">
          {error}
        </p>
      )}
      <footer className="player-dialog-footer">
        <button type="button" className="player-button" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="player-button is-primary"
          disabled={!parsed || busy}
          onClick={() => void confirm()}
        >
          {busy ? '正在导入…' : '导入'}
        </button>
      </footer>
    </Dialog>
  );
}

const INTERVALS: { seconds: number; label: string }[] = [
  { seconds: 30 * 60, label: '30 分钟' },
  { seconds: 60 * 60, label: '1 小时' },
  { seconds: 3 * 60 * 60, label: '3 小时' },
  { seconds: 6 * 60 * 60, label: '6 小时' },
  { seconds: 12 * 60 * 60, label: '12 小时' },
  { seconds: 24 * 60 * 60, label: '24 小时' },
];

/** The player's settings, which take effect as they are changed, and the user's data. */
export function SettingsDialog({
  onClose,
  onChange,
  onRestored,
}: {
  onClose(): void;
  onChange(settings: PlayerSettings): void;
  /** A backup was restored, so everything shown is out of date. */
  onRestored(): void;
}) {
  const host = usePlayerHost();
  const { settings } = host;
  const restoreRef = useRef<HTMLInputElement | null>(null);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const known = INTERVALS.some(
    (interval) => interval.seconds === settings.feedUpdateThresholdSeconds,
  );

  const report = (text: string, isError = false) => {
    setMessage(text);
    setFailed(isError);
  };

  const exportSubscriptions = () => {
    downloadTextFile(
      `seamind-subscriptions-${dateStamp()}.json`,
      subscriptionsToNewPipeJson(host.channels),
    );
    report(
      `已导出 ${host.channels.length} 个订阅，NewPipe 也可以导入这个文件。`,
    );
  };

  const exportBackup = async () => {
    try {
      downloadTextFile(
        `seamind-player-backup-${dateStamp()}.json`,
        await playerApi.exportBackup(),
      );
      report('已导出全部数据：订阅、收藏、课程、历史和观看进度。');
    } catch (reason) {
      report(errorText(reason, '导出失败'), true);
    }
  };

  const restore = async (file: File | undefined) => {
    if (!file) return;
    try {
      const summary = await playerApi.importBackup(await file.text());
      report(
        `已恢复：新增 ${summary.channelsAdded} 个订阅、${summary.playlistsAdded} 个列表，涉及 ${summary.videos} 个视频。`,
      );
      onRestored();
    } catch (reason) {
      report(errorText(reason, '无法恢复这个备份'), true);
    }
  };

  const clearHistory = async () => {
    if (!window.confirm('清空全部观看历史？观看进度会保留。')) return;
    try {
      await playerApi.clearHistory();
      report('观看历史已清空。');
    } catch (reason) {
      report(errorText(reason, '无法清空历史'), true);
    }
  };

  return (
    <Dialog title="播放器设置" onClose={onClose}>
      <div className="player-settings">
        <label className="player-field">
          <span>检查新视频的间隔</span>
          <select
            value={settings.feedUpdateThresholdSeconds}
            onChange={(event) =>
              onChange({
                ...settings,
                feedUpdateThresholdSeconds: Number(event.target.value),
              })
            }
          >
            {!known && (
              <option value={settings.feedUpdateThresholdSeconds}>
                {Math.round(settings.feedUpdateThresholdSeconds / 60)} 分钟
              </option>
            )}
            {INTERVALS.map((interval) => (
              <option key={interval.seconds} value={interval.seconds}>
                {interval.label}
              </option>
            ))}
          </select>
        </label>
        <p className="player-field-hint">
          打开动态时，只检查距上次检查超过这段时间的频道。
        </p>
        <label className="player-check">
          <input
            type="checkbox"
            checked={settings.autoplayNext}
            onChange={(event) =>
              onChange({ ...settings, autoplayNext: event.target.checked })
            }
          />
          播放结束后自动播放列表里的下一个视频
        </label>
        <label className="player-check">
          <input
            type="checkbox"
            checked={settings.pauseWhenHidden}
            onChange={(event) =>
              onChange({ ...settings, pauseWhenHidden: event.target.checked })
            }
          />
          切换到导图或电子书时暂停播放
        </label>
        <p className="player-field-hint">
          关闭后，视频会在后台继续播放，适合边听边整理导图。
        </p>
        <label className="player-check">
          <input
            type="checkbox"
            checked={settings.hideFinishedInFeed}
            onChange={(event) =>
              onChange({
                ...settings,
                hideFinishedInFeed: event.target.checked,
              })
            }
          />
          动态里隐藏已看完的视频
        </label>
      </div>

      <h3 className="player-dialog-subtitle">我的数据</h3>
      <p className="player-dialog-text">
        订阅、收藏、课程、历史和观看进度都保存在本机的应用数据目录里，不会上传。
      </p>
      <div className="player-dialog-buttons">
        <button
          type="button"
          className="player-button"
          disabled={host.channels.length === 0}
          onClick={exportSubscriptions}
        >
          导出订阅（NewPipe 格式）
        </button>
        <button
          type="button"
          className="player-button"
          onClick={() => void exportBackup()}
        >
          导出全部数据
        </button>
        <button
          type="button"
          className="player-button"
          onClick={() => restoreRef.current?.click()}
        >
          从备份恢复…
        </button>
        <button
          type="button"
          className="player-button is-danger"
          onClick={() => void clearHistory()}
        >
          清空观看历史
        </button>
        <input
          ref={restoreRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            void restore(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </div>
      {message && (
        <p
          className={failed ? 'player-dialog-error' : 'player-dialog-result'}
          role={failed ? 'alert' : 'status'}
        >
          {message}
        </p>
      )}
    </Dialog>
  );
}
