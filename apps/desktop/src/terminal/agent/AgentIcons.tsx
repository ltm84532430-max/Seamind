import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function baseProps(size: number, props: IconProps): SVGProps<SVGSVGElement> {
  const { className, ...rest } = props;
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    className: className ? `ag-icon ${className}` : 'ag-icon',
    ...rest,
  };
}

export function PlusIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <path d="M8 3.25V12.75M3.25 8H12.75" />
    </svg>
  );
}

export function CloseIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <path d="M4.25 4.25L11.75 11.75M11.75 4.25L4.25 11.75" />
    </svg>
  );
}

export function ChevronDownIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <path d="M4.25 6.25L8 10L11.75 6.25" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <path d="M6.25 4.25L10 8L6.25 11.75" />
    </svg>
  );
}

export function CheckIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <path d="M3.25 8.25L6.25 11.25L12.75 4.75" />
    </svg>
  );
}

export function AlertTriangleIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <path d="M8 2.5L13.75 12.75H2.25L8 2.5Z" />
      <path d="M8 6.25V8.75" />
      <circle cx="8" cy="10.75" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function XCircleIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M6 6L10 10M10 6L6 10" />
    </svg>
  );
}

export function SlashCircleIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M4.25 4.25L11.75 11.75" />
    </svg>
  );
}

export function SpinnerIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <path d="M8 2.25A5.75 5.75 0 1 1 2.65 10.1" />
    </svg>
  );
}

export function ToolIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <path d="M10.4 2.75A3.2 3.2 0 0 0 6.8 6.8L3 10.6a1.4 1.4 0 1 0 2 2l3.8-3.8a3.2 3.2 0 0 0 4.05-3.6l-1.9 1.9-1.85-1.85 1.3-2.5Z" />
    </svg>
  );
}

export function TerminalIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <rect x="2" y="2.75" width="12" height="10.5" rx="1.5" />
      <path d="M4.75 6.25L7 8L4.75 9.75M8.25 9.75H11" />
    </svg>
  );
}

export function CopyIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <rect x="5.5" y="5.5" width="7.75" height="7.75" rx="1.25" />
      <path d="M10.5 5.5V3.75A1.25 1.25 0 0 0 9.25 2.5H3.75A1.25 1.25 0 0 0 2.5 3.75V9.25A1.25 1.25 0 0 0 3.75 10.5H5.5" />
    </svg>
  );
}

export function SendIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <path d="M2.5 8H13.25M9.25 4L13.25 8L9.25 12" />
    </svg>
  );
}

export function StopSquareIcon({ size = 12, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <rect
        x="3.5"
        y="3.5"
        width="9"
        height="9"
        rx="1.25"
        fill="currentColor"
      />
    </svg>
  );
}

export function RefreshIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <path d="M13.25 8A5.25 5.25 0 1 1 11.7 4.3M13.25 2.75V5.5H10.5" />
    </svg>
  );
}

export function PanelRightIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M10 2.5V13.5" />
    </svg>
  );
}

export function BookIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <path d="M2.5 3.5H6.25A1.75 1.75 0 0 1 8 5.25V13A1.5 1.5 0 0 0 6.5 11.5H2.5V3.5Z" />
      <path d="M13.5 3.5H9.75A1.75 1.75 0 0 0 8 5.25V13A1.5 1.5 0 0 1 9.5 11.5H13.5V3.5Z" />
    </svg>
  );
}

export function DatabaseIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <ellipse cx="8" cy="4.25" rx="5" ry="1.75" />
      <path d="M3 4.25V11.75C3 12.72 5.24 13.5 8 13.5S13 12.72 13 11.75V4.25" />
      <path d="M3 8C3 8.97 5.24 9.75 8 9.75S13 8.97 13 8" />
    </svg>
  );
}

export function FlaskIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <path d="M6 2.5H10M6.75 2.5V6L3.3 11.8A1.2 1.2 0 0 0 4.35 13.5H11.65A1.2 1.2 0 0 0 12.7 11.8L9.25 6V2.5" />
      <path d="M5.25 9.75H10.75" />
    </svg>
  );
}

export function FileTextIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <path d="M4 2.25H9.5L12.5 5.25V13.25A0.75 0.75 0 0 1 11.75 14H4A0.75 0.75 0 0 1 3.25 13.25V3A0.75 0.75 0 0 1 4 2.25Z" />
      <path d="M9.5 2.25V5.25H12.5M5.5 8H10.5M5.5 10.75H8.75" />
    </svg>
  );
}

export function SlidersIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <path d="M3 4.5H13M3 8H13M3 11.5H13" />
      <circle cx="5.75" cy="4.5" r="1.15" fill="currentColor" />
      <circle cx="10.25" cy="8" r="1.15" fill="currentColor" />
      <circle cx="6.75" cy="11.5" r="1.15" fill="currentColor" />
    </svg>
  );
}

export function TableIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.25" />
      <path d="M2.25 6.25H13.75M6.25 6.25V13.25M10.25 6.25V13.25" />
    </svg>
  );
}

export function ArrowDownIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <path d="M8 3V12.5M4.5 9L8 12.5L11.5 9" />
    </svg>
  );
}

export function SparkCpuIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)}>
      <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.25" />
      <path d="M6.5 2V4.25M9.5 2V4.25M6.5 11.75V14M9.5 11.75V14M2 6.5H4.25M2 9.5H4.25M11.75 6.5H14M11.75 9.5H14" />
    </svg>
  );
}
