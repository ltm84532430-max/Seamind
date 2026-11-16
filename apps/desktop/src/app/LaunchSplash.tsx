import { useCallback, useEffect, useState } from 'react';
import type { Theme } from './app-storage';
import './launch-splash.css';

const HOLD_BEFORE_EXIT_MS = 1220;
const EXIT_DURATION_MS = 280;

export function LaunchSplash({
  theme,
  onFinished,
}: {
  theme: Theme;
  onFinished?: () => void;
}) {
  const [phase, setPhase] = useState<'visible' | 'exiting' | 'done'>('visible');

  const beginExit = useCallback(() => {
    setPhase((current) => (current === 'visible' ? 'exiting' : current));
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const reduced =
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const holdMs = reduced ? 320 : HOLD_BEFORE_EXIT_MS;
    const timer = window.setTimeout(beginExit, holdMs);
    return () => window.clearTimeout(timer);
  }, [beginExit]);

  useEffect(() => {
    if (phase !== 'exiting') return undefined;
    const timer = window.setTimeout(() => {
      setPhase('done');
      onFinished?.();
    }, EXIT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [phase, onFinished]);

  useEffect(() => {
    if (phase !== 'visible') return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' ||
        event.key === 'Enter' ||
        event.key === ' '
      ) {
        beginExit();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [phase, beginExit]);

  if (phase === 'done') return null;

  return (
    <div
      className={`seamind-launch-splash${phase === 'exiting' ? ' is-exiting' : ''}`}
      data-theme={theme}
      role="status"
      aria-label="正在启动 Seamind"
      onClick={beginExit}
    >
      <div className="seamind-splash-grid" aria-hidden="true" />
      <div className="seamind-splash-glow" aria-hidden="true" />

      <div className="seamind-splash-stage">
        <div className="seamind-splash-mark-frame">
          <span className="seamind-splash-corner is-tl" aria-hidden="true" />
          <span className="seamind-splash-corner is-tr" aria-hidden="true" />
          <span className="seamind-splash-corner is-bl" aria-hidden="true" />
          <span className="seamind-splash-corner is-br" aria-hidden="true" />

          <svg
            className="seamind-splash-svg"
            viewBox="0 0 1024 1024"
            width="136"
            height="136"
            aria-hidden="true"
          >
            <defs>
              <linearGradient
                id="seamindSplashTileBg"
                x1="512"
                y1="32"
                x2="512"
                y2="992"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0%" stopColor="#FFFFFF" />
                <stop offset="100%" stopColor="#EDF2F6" />
              </linearGradient>
              <linearGradient
                id="seamindSplashCoralNode"
                x1="436"
                y1="136"
                x2="588"
                y2="296"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0%" stopColor="#E56244" />
                <stop offset="100%" stopColor="#CC4528" />
              </linearGradient>
            </defs>

            <rect
              className="seamind-anim-tile"
              x="32"
              y="32"
              width="960"
              height="960"
              rx="224"
              ry="224"
              fill="url(#seamindSplashTileBg)"
              stroke="#C2CED8"
              strokeWidth="24"
            />

            <path
              className="seamind-anim-paper-outer"
              d="M 512 816 L 204 692 L 204 344 L 316 392 L 512 512 L 708 392 L 820 344 L 820 692 Z"
              fill="#F4F7FA"
              stroke="none"
            />
            <path
              className="seamind-anim-paper-inner"
              d="M 512 802 L 308 652 L 308 326 C 398 360 470 422 512 508 C 554 422 626 360 716 326 L 716 652 Z"
              fill="#FFFFFF"
              stroke="none"
            />

            <path
              className="seamind-anim-stroke is-book-outer"
              pathLength={100}
              d="M 316 392 L 204 344 L 204 692 L 512 816 L 820 692 L 820 344 L 708 392"
              fill="none"
              stroke="#1E2932"
              strokeWidth="44"
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            <path
              className="seamind-anim-stroke is-book-inner"
              pathLength={100}
              d="M 512 802 L 308 652 L 308 326 C 398 360 470 422 512 508 C 554 422 626 360 716 326 L 716 652 Z"
              fill="none"
              stroke="#1E2932"
              strokeWidth="44"
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            <line
              className="seamind-anim-stroke is-spine"
              pathLength={100}
              x1="512"
              y1="802"
              x2="512"
              y2="508"
              stroke="#1E2932"
              strokeWidth="46"
              strokeLinecap="round"
            />

            <line
              className="seamind-anim-stroke is-coral-stem"
              pathLength={100}
              x1="512"
              y1="476"
              x2="512"
              y2="246"
              stroke="#D9573B"
              strokeWidth="48"
              strokeLinecap="round"
            />
            <circle
              className="seamind-anim-pulse-ring"
              cx="512"
              cy="212"
              r="78"
              fill="none"
              stroke="#D9573B"
              strokeWidth="10"
            />
            <circle
              className="seamind-anim-node is-focal"
              cx="512"
              cy="212"
              r="78"
              fill="url(#seamindSplashCoralNode)"
            />

            <path
              className="seamind-anim-stroke is-branch-1"
              pathLength={100}
              d="M 512 686 L 352 592 L 138 514"
              fill="none"
              stroke="#1E2932"
              strokeWidth="40"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              className="seamind-anim-stroke is-branch-2"
              pathLength={100}
              d="M 512 602 L 402 476"
              fill="none"
              stroke="#1E2932"
              strokeWidth="38"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              className="seamind-anim-stroke is-branch-3"
              pathLength={100}
              d="M 512 686 L 656 598 L 886 514"
              fill="none"
              stroke="#1E2932"
              strokeWidth="40"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              className="seamind-anim-stroke is-branch-4"
              pathLength={100}
              d="M 512 578 L 622 472"
              fill="none"
              stroke="#1E2932"
              strokeWidth="38"
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            <circle
              className="seamind-anim-halo is-n3"
              cx="138"
              cy="514"
              r="64"
              fill="#F2F6F9"
            />
            <circle
              className="seamind-anim-halo is-n4"
              cx="886"
              cy="514"
              r="64"
              fill="#F2F6F9"
            />
            <line
              className="seamind-anim-halo is-n3"
              x1="138"
              y1="514"
              x2="210"
              y2="540"
              stroke="#1E2932"
              strokeWidth="40"
              strokeLinecap="round"
            />
            <line
              className="seamind-anim-halo is-n4"
              x1="886"
              y1="514"
              x2="814"
              y2="540"
              stroke="#1E2932"
              strokeWidth="40"
              strokeLinecap="round"
            />

            <circle
              className="seamind-anim-node is-n1"
              cx="402"
              cy="476"
              r="46"
              fill="#1E2932"
            />
            <circle
              className="seamind-anim-node is-n3"
              cx="138"
              cy="514"
              r="52"
              fill="#1E2932"
            />
            <circle
              className="seamind-anim-node is-n2"
              cx="622"
              cy="472"
              r="44"
              fill="#1E2932"
            />
            <circle
              className="seamind-anim-node is-n2"
              cx="656"
              cy="598"
              r="46"
              fill="#1E2932"
            />
            <circle
              className="seamind-anim-node is-n4"
              cx="886"
              cy="514"
              r="52"
              fill="#1E2932"
            />
          </svg>
        </div>

        <div className="seamind-splash-wordmark">
          <span className="seamind-splash-title">SEAMIND</span>
          <span className="seamind-splash-subtitle">
            阅读 · 导图 · 视听 · 研究工作台
          </span>
        </div>

        <div className="seamind-splash-progress-track" aria-hidden="true">
          <div className="seamind-splash-progress-fill" />
        </div>
      </div>
    </div>
  );
}
