import { useEffect, useRef, useState } from 'react';
import type { ConnectivityCheck, InstallProgress } from './youtube-diagnostics';
import {
  fetchCapabilities,
  fetchSettings,
  installYtDlp,
  runConnectivityChecks,
  saveProxy,
} from './youtube-diagnostics';
import type {
  YouTubePlaybackCapabilities,
  YouTubeSettings,
} from './youtube-player';
import { readPreferNative, writePreferNative } from './youtube-player';

type BrowserName = 'firefox' | 'edge' | 'chrome';

interface YouTubeDiagnosticsProps {
  videoId: string;
  failure: string | null;
  busy: boolean;
  onBrowserSession: (browser: BrowserName) => void;
}

type InstallState =
  | { phase: 'idle' }
  | { phase: 'running'; progress: InstallProgress | null }
  | { phase: 'done'; version: string }
  | { phase: 'failed'; message: string };

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  return error instanceof Error ? error.message : '操作失败。';
}

function capabilityChips(
  capabilities: YouTubePlaybackCapabilities,
): { label: string; ok: boolean }[] {
  return [
    {
      label: capabilities.extractor
        ? `${capabilities.extractor}${capabilities.extractorManaged ? '（Seamind 管理）' : ''}`
        : capabilities.extractorTimedOut
          ? 'yt-dlp 响应过慢（超过 20 秒），请重新打开面板重试'
          : '未找到 yt-dlp',
      ok: Boolean(capabilities.extractor),
    },
    {
      label:
        capabilities.ejsAvailable === null
          ? 'JS 解算组件：随 yt-dlp 提供'
          : capabilities.ejsAvailable
            ? 'JS 解算组件：已安装'
            : 'JS 解算组件：缺少 yt-dlp-ejs',
      ok: capabilities.ejsAvailable !== false,
    },
    {
      label: capabilities.nodeAvailable ? 'Node.js 可用' : '未找到 Node.js',
      ok: capabilities.nodeAvailable,
    },
    {
      label: capabilities.mpvAvailable ? 'mpv 可用' : '未找到 mpv',
      ok: capabilities.mpvAvailable,
    },
    {
      label:
        capabilities.ffplayAvailable && capabilities.ffmpegAvailable
          ? 'ffmpeg/ffplay 可用'
          : '缺少 ffmpeg/ffplay',
      ok: capabilities.ffplayAvailable && capabilities.ffmpegAvailable,
    },
  ];
}

export default function YouTubeDiagnostics({
  videoId,
  failure,
  busy,
  onBrowserSession,
}: YouTubeDiagnosticsProps) {
  const [open, setOpen] = useState(false);
  const [capabilities, setCapabilities] =
    useState<YouTubePlaybackCapabilities | null>(null);
  const [settings, setSettings] = useState<YouTubeSettings | null>(null);
  const [proxyInput, setProxyInput] = useState('');
  const [settingsMessage, setSettingsMessage] = useState('');
  const [checks, setChecks] = useState<ConnectivityCheck[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [install, setInstall] = useState<InstallState>({ phase: 'idle' });
  const [browser, setBrowser] = useState<BrowserName>('firefox');
  const [preferNative, setPreferNative] = useState(readPreferNative);
  const testAbort = useRef<AbortController | null>(null);

  useEffect(() => () => testAbort.current?.abort(), []);

  const load = () => {
    void fetchCapabilities().then(setCapabilities, () => setCapabilities(null));
    void fetchSettings().then(
      (loaded) => {
        setSettings(loaded);
        setProxyInput(loaded.proxyUrl ?? '');
      },
      () => setSettings(null),
    );
  };

  const submitProxy = async () => {
    setSettingsMessage('');
    try {
      const saved = await saveProxy(proxyInput);
      setSettings(saved);
      setProxyInput(saved.proxyUrl ?? '');
      setSettingsMessage(
        saved.proxyUrl === saved.webviewProxyUrl
          ? '已保存。'
          : '已保存。内置播放器、解析器和 mpv 立即生效；YouTube 内嵌播放器（iframe）需要重启应用。',
      );
    } catch (error) {
      setSettingsMessage(messageOf(error));
    }
  };

  const runChecks = async () => {
    testAbort.current?.abort();
    const controller = new AbortController();
    testAbort.current = controller;
    setTesting(true);
    setChecks(null);
    try {
      setChecks(await runConnectivityChecks(videoId, controller.signal));
    } finally {
      if (testAbort.current === controller) setTesting(false);
    }
  };

  const runInstall = async () => {
    setInstall({ phase: 'running', progress: null });
    try {
      const result = await installYtDlp((progress) =>
        setInstall({ phase: 'running', progress }),
      );
      setInstall({ phase: 'done', version: result.version });
      void fetchCapabilities().then(setCapabilities, () => undefined);
    } catch (error) {
      setInstall({ phase: 'failed', message: messageOf(error) });
    }
  };

  const progress = install.phase === 'running' ? install.progress : null;

  return (
    <details
      className="youtube-player-auth youtube-player-diagnostics"
      onToggle={(event) => {
        const nowOpen = event.currentTarget.open;
        setOpen(nowOpen);
        if (nowOpen) load();
      }}
    >
      <summary>播放诊断与设置</summary>
      {open && (
        <div className="youtube-diagnostics-body">
          {failure && (
            <section>
              <h3>最近一次失败</h3>
              <p className="youtube-diagnostics-failure">{failure}</p>
            </section>
          )}

          <section>
            <h3>网络出口</h3>
            <p>
              应用的内置播放器、解析器和外部播放器共用这里的代理；留空则使用系统网络（TUN
              模式的代理工具无需设置）。直链绑定的是解析时的出口
              IP，节点轮换或多出口会导致取流 403。
            </p>
            <div className="youtube-player-auth-controls">
              <input
                type="text"
                value={proxyInput}
                placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:7891"
                aria-label="代理地址"
                onChange={(event) => setProxyInput(event.target.value)}
              />
              <button
                type="button"
                className="youtube-player-action"
                onClick={() => void submitProxy()}
                disabled={proxyInput.trim() === (settings?.proxyUrl ?? '')}
              >
                保存
              </button>
              <button
                type="button"
                className="youtube-player-action"
                onClick={() => void runChecks()}
                disabled={testing}
              >
                {testing ? '正在测试…' : '测试连通性'}
              </button>
            </div>
            {settingsMessage && <p role="status">{settingsMessage}</p>}
            {checks && (
              <ul className="youtube-diagnostics-checks">
                {checks.map((check) => (
                  <li key={check.id} data-ok={check.ok}>
                    <strong>{check.ok ? '✓' : '✗'}</strong>
                    <span>{check.label}</span>
                    <span>{check.detail}</span>
                    {check.milliseconds !== null && (
                      <span>{Math.round(check.milliseconds)} ms</span>
                    )}
                  </li>
                ))}
                {checks.some((check) => check.id === 'reference' && check.ok) &&
                  checks.some((check) => check.id === 'video' && !check.ok) && (
                    <li className="youtube-diagnostics-hint">
                      参考视频可以解析，说明连接正常，只是当前这个视频被 YouTube
                      限制了。
                    </li>
                  )}
              </ul>
            )}
          </section>

          <section>
            <h3>播放环境</h3>
            {capabilities ? (
              <div className="youtube-player-capabilities">
                {capabilityChips(capabilities).map((chip) => (
                  <span key={chip.label} data-ok={chip.ok}>
                    {chip.ok ? '✓' : '·'} {chip.label}
                  </span>
                ))}
              </div>
            ) : (
              <p>正在读取…</p>
            )}
            <div className="youtube-player-auth-controls">
              <button
                type="button"
                className="youtube-player-action"
                onClick={() => void runInstall()}
                disabled={install.phase === 'running'}
              >
                {install.phase === 'running'
                  ? progress
                    ? `正在下载 ${formatMegabytes(progress.downloaded)}${progress.total ? ` / ${formatMegabytes(progress.total)}` : ''}`
                    : '正在下载…'
                  : '安装 / 更新 yt-dlp'}
              </button>
              {install.phase === 'done' && (
                <span role="status">已安装 yt-dlp {install.version}</span>
              )}
              {install.phase === 'failed' && (
                <span role="alert">{install.message}</span>
              )}
            </div>
            <p>
              从 GitHub 发布页下载官方 yt-dlp.exe 并校验 SHA-256，保存到
              %LOCALAPPDATA%\Seamind\tools。
            </p>
          </section>

          <section>
            <h3>用浏览器登录会话解析（yt-dlp）</h3>
            <p>
              YouTube 要求登录或真人验证时，可以让 yt-dlp 读取所选浏览器的
              Cookie 重试；Seamind 不保存也不外传。Firefox 最可靠，Chrome 127+
              和 Edge 在 Windows 上的 Cookie 通常无法被读取。
            </p>
            <div className="youtube-player-auth-controls">
              <select
                value={browser}
                aria-label="浏览器"
                onChange={(event) =>
                  setBrowser(event.target.value as BrowserName)
                }
              >
                <option value="firefox">Firefox</option>
                <option value="edge">Edge</option>
                <option value="chrome">Chrome</option>
              </select>
              <button
                type="button"
                className="youtube-player-action"
                onClick={() => onBrowserSession(browser)}
                disabled={busy}
              >
                {busy ? '正在解析…' : '读取会话并重试'}
              </button>
            </div>
          </section>

          <label className="youtube-diagnostics-toggle">
            <input
              type="checkbox"
              checked={preferNative}
              onChange={(event) => {
                setPreferNative(event.target.checked);
                writePreferNative(event.target.checked);
              }}
            />
            打开视频时优先使用内置播放器（失败时自动回到 YouTube 内嵌播放器）
          </label>
        </div>
      )}
    </details>
  );
}
