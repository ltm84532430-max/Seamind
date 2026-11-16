import React, { lazy, Suspense, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { readTheme, type Theme } from './app/app-storage';
import { LaunchSplash } from './app/LaunchSplash';
import type {
  TerminalCliPreset,
  TerminalShellType,
} from './terminal/terminal-types';
import './styles.css';
import './ebook/ebook-shelf-layout.css';
import './knowledge/knowledge-surface.css';
import './media/topbar-mini-player.css';
import './themes-extended.css';

const TerminalWorkspace = lazy(() => import('./terminal/TerminalWorkspace'));

function parseThemeParam(value: string | null): Theme {
  if (
    value === 'light' ||
    value === 'dark' ||
    value === 'navy' ||
    value === 'purple'
  ) {
    return value;
  }
  return readTheme();
}

function parseShellParam(value: string | null): TerminalShellType {
  if (
    value === 'powershell' ||
    value === 'wsl' ||
    value === 'bash' ||
    value === 'cmd'
  ) {
    return value;
  }
  return 'powershell';
}

function parseCliParam(value: string | null): TerminalCliPreset | undefined {
  if (value === 'agy' || value === 'claude' || value === 'codex') {
    return value;
  }
  return undefined;
}

const searchParams = new URLSearchParams(window.location.search);
const isStandaloneTerminal = searchParams.get('window') === 'terminal';

function Root() {
  const [initialTheme] = useState<Theme>(() => readTheme());
  if (isStandaloneTerminal) {
    const theme = parseThemeParam(searchParams.get('theme'));
    const cwd = searchParams.get('cwd') ?? '';
    const shell = parseShellParam(searchParams.get('shell'));
    const cli = parseCliParam(searchParams.get('cli'));
    return (
      <div className="app-shell" data-theme={theme}>
        <Suspense
          fallback={
            <div className="seamind-terminal-loading">正在启动独立终端…</div>
          }
        >
          <TerminalWorkspace
            active
            standalone
            cwd={cwd}
            theme={theme}
            initialShell={shell}
            initialCli={cli}
          />
        </Suspense>
      </div>
    );
  }
  return (
    <>
      <LaunchSplash theme={initialTheme} />
      <App />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
