import { useEffect } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { avatarHue, initialOf } from '../player/format';
import './workspace-sidebar-rail.css';

export interface RailItem {
  key: string;
  label: string;
  active?: boolean;
  icon?: ReactNode;
  thumb?: {
    name: string;
    color?: string | null;
    shape?: 'circle' | 'rounded' | 'square';
    tone?: 'index' | 'avatar';
    code?: string;
  };
  dot?: boolean;
  disabled?: boolean;
  onClick(): void;
  onContextMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

export interface RailSection {
  key: string;
  items: RailItem[];
}

export function SidebarChevronIcon({
  collapsed,
  size = 14,
}: {
  collapsed: boolean;
  size?: number;
}) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <path
        d={collapsed ? 'M6 3l5 5-5 5' : 'M10 3L5 8l5 5'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SidebarCollapseButton({
  collapsed,
  onClick,
  title,
  ariaLabel,
  ariaExpanded,
  ariaControls,
  className = '',
}: {
  collapsed: boolean;
  onClick(): void;
  title?: string;
  ariaLabel?: string;
  ariaExpanded?: boolean;
  ariaControls?: string;
  className?: string;
}) {
  const defaultTitle = collapsed
    ? '展开侧边栏 (快捷键 Ctrl+B)'
    : '收起侧边栏 (快捷键 Ctrl+B)';
  const defaultAria = collapsed ? '展开侧边栏' : '收起侧边栏';

  return (
    <button
      type="button"
      className={`seamind-rail-collapse-btn${collapsed ? ' is-collapsed' : ''}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      title={title ?? defaultTitle}
      aria-label={ariaLabel ?? defaultAria}
      aria-expanded={ariaExpanded ?? !collapsed}
      aria-controls={ariaControls}
    >
      <SidebarChevronIcon collapsed={collapsed} size={collapsed ? 14 : 13} />
    </button>
  );
}

const HAS_CJK_RE = /[\u4e00-\u9fff]/;

/**
 * Produces a concise 1–2 character typographic index code for collapsed rails
 * (e.g. "阿杉电脑" -> "阿杉", "Bloomberg-Originals" -> "BO", "MIT OpenCourseWare" -> "MO").
 */
export function formatRailIndexCode(rawName: string): string {
  const clean = rawName.trim();
  if (!clean) return '--';
  if (HAS_CJK_RE.test(clean)) {
    const chars = Array.from(clean.replace(/[\s/\\_-]+/g, ''));
    return chars.slice(0, 2).join('') || '--';
  }
  const tokens = clean.split(/[\s./\\_-]+/).filter(Boolean);
  if (tokens.length >= 2) {
    return `${tokens[0][0] ?? ''}${tokens[1][0] ?? ''}`.toUpperCase();
  }
  const letters = clean.replace(/[^A-Za-z0-9]/g, '');
  if (letters.length >= 2) return letters.slice(0, 2).toUpperCase();
  return initialOf(clean);
}

export function SidebarThumbAvatar({
  name,
  color,
  size = 22,
  shape = 'circle',
  tone = 'avatar',
  code,
}: {
  name: string;
  color?: string | null;
  size?: number;
  shape?: 'circle' | 'rounded' | 'square';
  tone?: 'index' | 'avatar';
  code?: string;
}) {
  if (tone === 'index') {
    const label = code ?? formatRailIndexCode(name);
    const hasCjk = HAS_CJK_RE.test(label);
    return (
      <span
        className={`seamind-rail-thumb is-index${hasCjk ? ' is-cjk' : ''}${shape === 'square' ? ' is-square' : ''}`}
        aria-hidden="true"
      >
        {label}
      </span>
    );
  }
  const background = color || `hsl(${avatarHue(name)} 34% 42%)`;
  return (
    <span
      className={`seamind-rail-thumb${shape === 'rounded' ? ' is-rounded' : shape === 'square' ? ' is-square' : ''}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.46),
        background,
      }}
      aria-hidden="true"
    >
      {initialOf(name)}
    </span>
  );
}

const IGNORED_SHORTCUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export function shouldHandleSidebarShortcut(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  target: { tagName?: string; isContentEditable?: boolean } | null;
}): boolean {
  if (event.defaultPrevented) return false;
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
    return false;
  }
  if (event.key.toLowerCase() !== 'b') return false;
  const target = event.target;
  if (
    target &&
    ((target.tagName && IGNORED_SHORTCUT_TAGS.has(target.tagName)) ||
      target.isContentEditable)
  ) {
    return false;
  }
  return true;
}

/**
 * 统一绑定 Ctrl+B / Cmd+B 切换当前激活工作区的侧边栏折叠状态，与播放器保持一致。
 */
export function useSidebarCollapseShortcut(
  onToggle: () => void,
  active = true,
): void {
  useEffect(() => {
    if (!active) return;
    const handleKey = (event: KeyboardEvent) => {
      if (
        !shouldHandleSidebarShortcut({
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          defaultPrevented: event.defaultPrevented,
          target: event.target as HTMLElement | null,
        })
      ) {
        return;
      }
      event.preventDefault();
      onToggle();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [active, onToggle]);
}

function RailItemButton({ item }: { item: RailItem }) {
  const isThumb = Boolean(item.thumb);
  return (
    <button
      type="button"
      className={`seamind-rail-button${isThumb ? ' is-thumb' : ''}${item.active ? ' is-current' : ''}`}
      title={item.label}
      aria-label={item.label}
      aria-current={item.active ? 'page' : undefined}
      disabled={item.disabled}
      onClick={item.onClick}
      onContextMenu={item.onContextMenu}
    >
      {item.thumb ? (
        <SidebarThumbAvatar
          name={item.thumb.name}
          color={item.thumb.color}
          shape={item.thumb.shape ?? 'circle'}
          tone={item.thumb.tone ?? 'avatar'}
          code={item.thumb.code}
        />
      ) : (
        item.icon
      )}
      {item.dot && <span className="seamind-rail-dot" aria-hidden="true" />}
    </button>
  );
}

export function WorkspaceSidebarRail({
  ariaLabel,
  expandTitle,
  expandAriaLabel,
  ariaControls,
  headerHeight = 52,
  className = '',
  onExpand,
  sections,
  footerItems = [],
  footerExtra,
}: {
  ariaLabel: string;
  expandTitle?: string;
  expandAriaLabel?: string;
  ariaControls?: string;
  headerHeight?: number;
  className?: string;
  onExpand(): void;
  sections: RailSection[];
  footerItems?: RailItem[];
  footerExtra?: ReactNode;
}) {
  const nonEmptySections = sections.filter(
    (section) => section.items.length > 0,
  );

  return (
    <nav
      className={`seamind-rail${className ? ` ${className}` : ''}`}
      aria-label={ariaLabel}
    >
      <div
        className="seamind-rail-header"
        style={{ height: headerHeight, flexBasis: headerHeight }}
      >
        <SidebarCollapseButton
          collapsed
          onClick={onExpand}
          title={expandTitle}
          ariaLabel={expandAriaLabel}
          ariaExpanded={false}
          ariaControls={ariaControls}
        />
      </div>

      <div className="seamind-rail-scroll">
        {nonEmptySections.map((section, sectionIndex) => (
          <div key={section.key} className="seamind-rail-group">
            {sectionIndex > 0 && (
              <div className="seamind-rail-divider" role="separator" />
            )}
            {section.items.map((item) => (
              <RailItemButton key={item.key} item={item} />
            ))}
          </div>
        ))}
      </div>

      {(footerItems.length > 0 || footerExtra) && (
        <div className="seamind-rail-footer">
          {footerItems.map((item) => (
            <RailItemButton key={item.key} item={item} />
          ))}
          {footerExtra}
        </div>
      )}
    </nav>
  );
}

function RailSvg({
  children,
  size = 14,
}: {
  children: ReactNode;
  size?: number;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function RailListIcon() {
  return (
    <RailSvg>
      <path d="M5.5 4h8M5.5 8h8M5.5 12h8" />
      <circle cx="2.7" cy="4" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="2.7" cy="8" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="2.7" cy="12" r="0.8" fill="currentColor" stroke="none" />
    </RailSvg>
  );
}

export function RailClockIcon({ filled = false }: { filled?: boolean }) {
  return (
    <RailSvg>
      <circle cx="8" cy="8" r="5.6" fill={filled ? 'currentColor' : 'none'} />
      <path
        d="M8 4.8V8l2.2 1.3"
        stroke={filled ? 'var(--panel, #fff)' : 'currentColor'}
      />
    </RailSvg>
  );
}

export function RailInboxIcon() {
  return (
    <RailSvg>
      <path d="M2.5 9.5V4.8a1.3 1.3 0 0 1 1.3-1.3h8.4a1.3 1.3 0 0 1 1.3 1.3v4.7l-1.5 3H4l-1.5-3Z" />
      <path d="M2.5 9.5h3.2l1 1.4h2.6l1-1.4h3.2" />
    </RailSvg>
  );
}

export function RailArchiveIcon() {
  return (
    <RailSvg>
      <rect x="2.2" y="2.8" width="11.6" height="2.8" rx="0.6" />
      <path d="M3.2 5.6v6.8a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1V5.6" />
      <path d="M6.3 8.5h3.4" />
    </RailSvg>
  );
}

export function RailNoteIcon() {
  return (
    <RailSvg>
      <path d="M4 2.3h5.5L12.7 5.5v8.2a.8.8 0 0 1-.8.8H4a.8.8 0 0 1-.8-.8V3.1a.8.8 0 0 1 .8-.8Z" />
      <path d="M9.3 2.5v3.2h3.2M5.5 8h5M5.5 10.6h3.5" />
    </RailSvg>
  );
}

export function RailBookIcon() {
  return (
    <RailSvg>
      <path d="M3 3.2a1.5 1.5 0 0 1 1.5-1.4h7.8v10.8H4.5A1.5 1.5 0 0 0 3 14.1V3.2Z" />
      <path d="M3 12.6A1.5 1.5 0 0 1 4.5 11.2h7.8M5.6 5.2h4.2" />
    </RailSvg>
  );
}

export function RailBookOpenIcon() {
  return (
    <RailSvg>
      <path d="M8 4.2c-1.4-1-3.2-1.3-5.2-1v9c2-.3 3.8 0 5.2 1 1.4-1 3.2-1.3 5.2-1v-9c-2-.3-3.8 0-5.2 1Z" />
      <path d="M8 4.2v9" />
    </RailSvg>
  );
}

export function RailPlayIcon() {
  return (
    <RailSvg>
      <rect x="2" y="3.2" width="12" height="9.6" rx="1.6" />
      <path
        d="M6.6 5.9 10.4 8l-3.8 2.1V5.9Z"
        fill="currentColor"
        stroke="none"
      />
    </RailSvg>
  );
}

export function RailCheckCircleIcon({ filled = false }: { filled?: boolean }) {
  return (
    <RailSvg>
      <circle cx="8" cy="8" r="5.6" fill={filled ? 'currentColor' : 'none'} />
      <path
        d="M5.4 8.1 7.2 9.9l3.5-3.6"
        stroke={filled ? 'var(--panel, #fff)' : 'currentColor'}
      />
    </RailSvg>
  );
}

export function RailStarIcon({ filled = false }: { filled?: boolean }) {
  return (
    <RailSvg>
      <path
        d="M8 2.1l1.8 3.6 4 .6-2.9 2.8.7 4L8 11.2l-3.6 1.9.7-4-2.9-2.8 4-.6L8 2.1Z"
        fill={filled ? 'currentColor' : 'none'}
      />
    </RailSvg>
  );
}

export function RailSunIcon() {
  return (
    <RailSvg>
      <circle cx="8" cy="8" r="2.9" />
      <path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1" />
    </RailSvg>
  );
}

export function RailFolderIcon() {
  return (
    <RailSvg>
      <path d="M2.2 4.3a1 1 0 0 1 1-1h3.1l1.2 1.4h5.3a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1V4.3Z" />
    </RailSvg>
  );
}

export function RailOutlineIcon() {
  return (
    <RailSvg>
      <path d="M3 4h1M6 4h7M3 8h1M6 8h7M3 12h1M6 12h7" />
    </RailSvg>
  );
}

export function RailPlusIcon() {
  return (
    <RailSvg>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </RailSvg>
  );
}

export function RailSparklesIcon() {
  return (
    <RailSvg>
      <path d="M8.5 2.2 9.7 5.3l3.1 1.2-3.1 1.2-1.2 3.1-1.2-3.1-3.1-1.2 3.1-1.2 1.2-3.1Z" />
      <path d="M3.2 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6.6-1.4Z" />
    </RailSvg>
  );
}

export function RailHomeIcon() {
  return (
    <RailSvg>
      <path d="M2.5 7.4 8 2.8l5.5 4.6" />
      <path d="M4.2 6.5v6.2a.8.8 0 0 0 .8.8h6a.8.8 0 0 0 .8-.8V6.5" />
    </RailSvg>
  );
}

export function RailEyeIcon() {
  return (
    <RailSvg>
      <path d="M1.8 8s2.3-3.8 6.2-3.8S14.2 8 14.2 8s-2.3 3.8-6.2 3.8S1.8 8 1.8 8Z" />
      <circle cx="8" cy="8" r="1.6" />
    </RailSvg>
  );
}

export function RailTagIcon() {
  return (
    <RailSvg>
      <path d="M3 4.5h10M3 8h7M3 11.5h5" />
    </RailSvg>
  );
}

export function RailRssIcon() {
  return (
    <RailSvg>
      <circle cx="4" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <path d="M3.5 7.8A4.7 4.7 0 0 1 8.2 12.5M3.5 4a8.5 8.5 0 0 1 8.5 8.5" />
    </RailSvg>
  );
}

export function RailAudioIcon() {
  return (
    <RailSvg>
      <path d="M3.3 9.2V8a4.7 4.7 0 0 1 9.4 0v1.2" />
      <rect x="2.5" y="9" width="2.5" height="4" rx="0.8" />
      <rect x="11" y="9" width="2.5" height="4" rx="0.8" />
    </RailSvg>
  );
}
