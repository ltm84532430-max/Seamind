import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function baseProps(size = 13, props?: IconProps): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.45,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    ...props,
  };
}

export function LabPlayIcon({ size = 13, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M4.5 3.25 12.25 8 4.5 12.75V3.25Z" fill="currentColor" />
    </svg>
  );
}

export function LabPlayAllIcon({ size = 13, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M2.5 3.6 7.4 8l-4.9 4.4V3.6Z" />
      <path d="M8.6 3.6 13.5 8l-4.9 4.4V3.6Z" />
    </svg>
  );
}

export function LabStopIcon({ size = 13, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor" />
    </svg>
  );
}

export function LabPlusIcon({ size = 13, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </svg>
  );
}

export function LabNoteIcon({ size = 13, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M3 4h10M3 8h10M3 12h6.5" />
    </svg>
  );
}

export function LabResetIcon({ size = 13, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M3.2 8a4.8 4.8 0 1 1 1.4 3.4" />
      <path d="M3.2 4.6V8h3.4" />
    </svg>
  );
}

export function LabTerminalOutIcon({ size = 13, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M2.5 4.2 6.2 8l-3.7 3.8" />
      <path d="M7.6 11.8h5.9" />
    </svg>
  );
}

export function LabSparkIcon({ size = 13, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M8.8 2 4.2 8.7h3.6L7.2 14l4.6-6.7H8.2L8.8 2Z" />
    </svg>
  );
}

export function LabCloseIcon({ size = 13, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" />
    </svg>
  );
}

export function LabChevronDownIcon({ size = 12, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="m4.2 6.2 3.8 3.8 3.8-3.8" />
    </svg>
  );
}

export function LabChevronRightIcon({ size = 12, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="m6.2 4.2 3.8 3.8-3.8 3.8" />
    </svg>
  );
}

export function LabArrowUpIcon({ size = 12, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M8 12.2V3.8M4.5 7.2 8 3.7l3.5 3.5" />
    </svg>
  );
}

export function LabArrowDownIcon({ size = 12, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M8 3.8v8.4M4.5 8.8 8 12.3l3.5-3.5" />
    </svg>
  );
}

export function LabStarIcon({
  size = 12,
  filled = false,
  ...rest
}: IconProps & { filled?: boolean }) {
  return (
    <svg {...baseProps(size, rest)}>
      <path
        d="M8 2.4 9.7 5.9l3.8.55-2.75 2.68.65 3.77L8 11.12 4.6 12.9l.65-3.77L2.5 6.45l3.8-.55L8 2.4Z"
        fill={filled ? 'currentColor' : 'none'}
      />
    </svg>
  );
}

export function LabSaveIcon({ size = 13, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M3 2.5h8.2L13.5 4.8V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z" />
      <path d="M5 2.5v3.3h5.2V2.5M5 13.5v-4h6v4" />
    </svg>
  );
}

export function LabVarsIcon({ size = 13, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11M6.5 4v8" />
    </svg>
  );
}

export function LabMoreIcon({ size = 13, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function LabCopyIcon({ size = 12, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="0.8" />
      <path d="M10.5 5.5V3.5a.8.8 0 0 0-.8-.8H3.5a.8.8 0 0 0-.8.8v6.2a.8.8 0 0 0 .8.8h2" />
    </svg>
  );
}

export function LabCheckIcon({ size = 12, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="m3.2 8.2 3.1 3.1 6.5-6.6" />
    </svg>
  );
}

export function LabEditIcon({ size = 12, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M10.8 2.8 13.2 5.2 5.8 12.6H3.4v-2.4l7.4-7.4Z" />
    </svg>
  );
}

export function LabCodeIcon({ size = 13, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M5.5 4.2 2 8l3.5 3.8M10.5 4.2 14 8l-3.5 3.8M9 3.2 7 12.8" />
    </svg>
  );
}

export function LabCellsIcon({ size = 13, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <rect x="2.5" y="2.8" width="11" height="4" rx="0.6" />
      <rect x="2.5" y="9.2" width="11" height="4" rx="0.6" />
    </svg>
  );
}

export function LabTrashIcon({ size = 12, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M3.2 4.5h9.6M5.8 4.5V3.2h4.4v1.3M4.5 4.5l.6 8.3h5.8l.6-8.3" />
    </svg>
  );
}

export function LabFolderIcon({ size = 12, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M2.2 4.2a1 1 0 0 1 1-1h3l1.2 1.3h5.4a1 1 0 0 1 1 1v6.3a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1V4.2Z" />
    </svg>
  );
}
