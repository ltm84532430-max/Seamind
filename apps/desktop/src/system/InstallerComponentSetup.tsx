import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface PendingComponents {
  plantumlJava: boolean;
  ytDlp: boolean;
}

interface DownloadProgress {
  downloaded: number;
  total: number | null;
}

type SetupState = 'idle' | 'running' | 'done';

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  return error instanceof Error ? error.message : '组件安装失败。';
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function InstallerComponentSetup() {
  const [selection, setSelection] = useState<PendingComponents | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [state, setState] = useState<SetupState>('idle');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [javaProgress, setJavaProgress] = useState<DownloadProgress | null>(
    null,
  );
  const [ytDlpProgress, setYtDlpProgress] = useState<DownloadProgress | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    void invoke<PendingComponents | null>(
      'installer_get_pending_components',
    ).then(
      (pending) => {
        if (active) setSelection(pending);
      },
      (reason: unknown) => {
        if (active) setError(errorMessage(reason));
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const closeAndClear = async () => {
    try {
      await invoke('installer_clear_pending_components');
      setSelection(null);
      setDismissed(true);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const installSelected = async () => {
    if (!selection) return;
    setState('running');
    setError('');
    setMessage('正在准备所选组件…');
    setJavaProgress(null);
    setYtDlpProgress(null);
    try {
      if (selection.plantumlJava) {
        const unlisten = await listen<DownloadProgress>(
          'seamind-java-install-progress',
          (event) => setJavaProgress(event.payload),
        );
        try {
          setMessage('正在安装 PlantUML Java 运行环境…');
          setMessage(await invoke<string>('plantuml_install_java_runtime'));
        } finally {
          unlisten();
        }
      }
      if (selection.ytDlp) {
        setJavaProgress(null);
        const unlisten = await listen<DownloadProgress>(
          'youtube-install-progress',
          (event) => setYtDlpProgress(event.payload),
        );
        try {
          setMessage('正在安装 yt-dlp…');
          const installed = await invoke<{ version: string }>(
            'youtube_install_ytdlp',
          );
          setMessage(`已安装 yt-dlp ${installed.version}。`);
        } finally {
          unlisten();
        }
      }
      await invoke('installer_clear_pending_components');
      setState('done');
      setMessage('所选组件已准备完成。');
    } catch (reason) {
      setState('idle');
      setError(errorMessage(reason));
    }
  };

  if (dismissed || (!selection && !error)) return null;

  const currentProgress = javaProgress ?? ytDlpProgress;
  const progressPercent = currentProgress?.total
    ? Math.min(
        100,
        Math.round((currentProgress.downloaded / currentProgress.total) * 100),
      )
    : null;

  return (
    <div className="seamind-component-setup-overlay">
      <section
        className="seamind-component-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="seamind-component-setup-title"
      >
        <h2 id="seamind-component-setup-title">
          {selection ? '准备可选组件' : '无法读取可选组件设置'}
        </h2>
        <p>
          {selection
            ? '安装器中选中的组件会从官方发布源下载并校验，文件保存在当前 Windows 用户目录。'
            : '组件安装选择无法读取。应用仍可正常使用，你可以关闭此提示。'}
        </p>
        {selection && (
          <ul>
            {selection.plantumlJava && <li>PlantUML Java 运行环境</li>}
            {selection.ytDlp && <li>yt-dlp</li>}
          </ul>
        )}
        {state === 'running' && (
          <div className="seamind-component-setup-progress" role="status">
            <span>{message}</span>
            {currentProgress && (
              <span>
                {formatBytes(currentProgress.downloaded)}
                {currentProgress.total
                  ? ` / ${formatBytes(currentProgress.total)}`
                  : ''}
                {progressPercent !== null ? ` (${progressPercent}%)` : ''}
              </span>
            )}
            {progressPercent !== null && (
              <progress
                max={100}
                value={progressPercent}
                aria-label="组件下载进度"
              />
            )}
          </div>
        )}
        {state === 'done' && <p role="status">{message}</p>}
        {error && (
          <p className="seamind-component-setup-error" role="alert">
            {error}
          </p>
        )}
        <div className="seamind-component-setup-actions">
          {!selection ? (
            <button type="button" onClick={() => setDismissed(true)}>
              关闭
            </button>
          ) : state === 'done' ? (
            <button type="button" onClick={() => setSelection(null)}>
              完成
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setDismissed(true)}
                disabled={state === 'running'}
              >
                稍后
              </button>
              <button
                type="button"
                onClick={() => void closeAndClear()}
                disabled={state === 'running'}
              >
                跳过剩余组件
              </button>
              <button
                type="button"
                onClick={() => void installSelected()}
                disabled={state === 'running'}
              >
                {state === 'running' ? '正在安装…' : '开始安装'}
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
