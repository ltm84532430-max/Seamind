export function TaskSidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="2"
        y="2.5"
        width="12"
        height="11"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path d="M6.2 2.5v11" stroke="currentColor" strokeWidth="1.25" />
      <path
        d={collapsed ? 'm8.8 6.2 1.8 1.8-1.8 1.8' : 'm10.6 6.2-1.8 1.8 1.8 1.8'}
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
