import type { ReactNode } from 'react';

function Svg({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function StarIcon({ filled = false }: { filled?: boolean }) {
  return (
    <Svg>
      <path
        d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"
        fill={filled ? 'currentColor' : 'none'}
      />
    </Svg>
  );
}

export function ClockIcon({ filled = false }: { filled?: boolean }) {
  return (
    <Svg>
      <circle cx="8" cy="8" r="5.8" fill={filled ? 'currentColor' : 'none'} />
      <path
        d="M8 4.6V8l2.3 1.4"
        stroke={filled ? 'var(--player-panel, #fff)' : 'currentColor'}
      />
    </Svg>
  );
}

export function CheckIcon({ filled = false }: { filled?: boolean }) {
  return (
    <Svg>
      <circle cx="8" cy="8" r="5.8" fill={filled ? 'currentColor' : 'none'} />
      <path
        d="M5.4 8.2l1.8 1.8 3.4-3.6"
        stroke={filled ? 'var(--player-panel, #fff)' : 'currentColor'}
      />
    </Svg>
  );
}

export function ExternalIcon() {
  return (
    <Svg>
      <path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M6.5 3.5H3.5v9h9v-3" />
    </Svg>
  );
}

export function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <span className={spinning ? 'player-spin' : undefined}>
      <Svg>
        <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9L13.5 2.5m0 0v4m0-4h-4" />
      </Svg>
    </span>
  );
}

export function SettingsIcon() {
  return (
    <Svg>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
    </Svg>
  );
}

export function PlusIcon() {
  return (
    <Svg>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  );
}

export function CloseIcon() {
  return (
    <Svg>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}

export function BackIcon() {
  return (
    <Svg>
      <path d="M9.5 3L4.5 8l5 5M5 8h8" />
    </Svg>
  );
}

export function FeedIcon() {
  return (
    <Svg>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6.5 6.2v3.6L10 8z" fill="currentColor" />
    </Svg>
  );
}

export function HistoryIcon() {
  return (
    <Svg>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.7-4M2.5 2.6v3h3" />
      <path d="M8 5v3.2l2 1.2" />
    </Svg>
  );
}

export function ListIcon() {
  return (
    <Svg>
      <path d="M5.5 4h8M5.5 8h8M5.5 12h8" />
      <path d="M2.5 4h.1M2.5 8h.1M2.5 12h.1" strokeWidth="1.8" />
    </Svg>
  );
}

export function CourseIcon() {
  return (
    <Svg>
      <path d="M2 4.5L8 2l6 2.5L8 7z" />
      <path d="M4.5 6.3v3.4c0 .9 1.6 1.8 3.5 1.8s3.5-.9 3.5-1.8V6.3" />
    </Svg>
  );
}

export function WarningIcon() {
  return (
    <Svg>
      <path d="M8 2.2l6 10.6H2z" />
      <path d="M8 6.5v3M8 11.3h.01" />
    </Svg>
  );
}
