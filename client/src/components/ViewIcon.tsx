import type { ViewMode } from '../hooks/useRoomLayout';

/** Small line icons for the view-mode switch: default (stage + panel), theatre (wide), full screen. */
export function ViewIcon({ mode }: { mode: ViewMode }) {
  const common = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (mode === 'default') {
    return (
      <svg {...common}>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M15 5v14" />
      </svg>
    );
  }
  if (mode === 'theatre') {
    return (
      <svg {...common}>
        <rect x="2" y="7" width="20" height="10" rx="1.5" />
        <path d="M16 7v10" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
  );
}
