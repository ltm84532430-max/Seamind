import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';

type Update = Awaited<ReturnType<typeof check>>;
type UpdateState =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'installing'
  | 'error';

function describeError(error: unknown): string {
  if (typeof error === 'string') return error;
  return error instanceof Error ? error.message : '更新操作失败。';
}

function formatBytes(value: number): string {
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export default function UpdateManager() {
  const [version, setVersion] = useState('读取中…');
  const [state, setState] = useState<UpdateState>('idle');
  const [update, setUpdate] = useState<Update>(null);
  const [error, setError] = useState('');
  const [downloaded, setDownloaded] = useState(0);
  const [contentLength, setContentLength] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    void getVersion().then(
      (currentVersion) => {
        if (active) setVersion(currentVersion);
      },
      () => {
        if (active) setVersion('未知');
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const checkForUpdates = async () => {
    setState('checking');
    setError('');
    setUpdate(null);
    try {
      const available = await check();
      setUpdate(available);
      setState(available ? 'available' : 'current');
    } catch (reason) {
      setError(describeError(reason));
      setState('error');
    }
  };

  const installUpdate = async () => {
    if (!update) return;
    setState('installing');
    setError('');
    setDownloaded(0);
    setContentLength(null);
    try {
      let totalDownloaded = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          setContentLength(event.data.contentLength ?? null);
        } else if (event.event === 'Progress') {
          totalDownloaded += event.data.chunkLength;
          setDownloaded(totalDownloaded);
        }
      });
      await relaunch();
    } catch (reason) {
      setError(describeError(reason));
      setState('error');
    }
  };

  const progress = contentLength
    ? Math.min(100, Math.round((downloaded / contentLength) * 100))
    : null;

  return (
    <section
      className="settings-update-section"
      aria-labelledby="settings-update-title"
    >
      <div className="settings-update-heading">
        <div>
          <h3 id="settings-update-title">Seamind 软件更新</h3>
          <span>当前版本 {version}</span>
        </div>
        <button
          type="button"
          className="settings-update-button"
          disabled={state === 'checking' || state === 'installing'}
          onClick={() => void checkForUpdates()}
        >
          {state === 'checking' ? '正在检查…' : '检查更新'}
        </button>
      </div>
      {state === 'current' && <p role="status">当前已是最新版本。</p>}
      {state === 'available' && update && (
        <div className="settings-update-available" role="status">
          <p>
            发现新版本 {update.version}
            {update.date ? ` · ${update.date}` : ''}
          </p>
          {update.body && (
            <p className="settings-update-notes">{update.body}</p>
          )}
          <button
            type="button"
            className="settings-update-button"
            onClick={() => void installUpdate()}
          >
            下载并安装
          </button>
        </div>
      )}
      {state === 'installing' && (
        <div className="settings-update-progress" role="status">
          <span>
            正在下载更新
            {contentLength
              ? `：${formatBytes(downloaded)} / ${formatBytes(contentLength)}`
              : ''}
            {progress !== null ? `（${progress}%）` : ''}
          </span>
          {progress !== null && (
            <progress max={100} value={progress} aria-label="更新下载进度" />
          )}
        </div>
      )}
      {state === 'error' && (
        <p className="settings-update-error" role="alert">
          {error}
        </p>
      )}
      <p className="settings-update-note">
        更新包来自 Seamind GitHub Releases，并通过签名校验。
      </p>
    </section>
  );
}
