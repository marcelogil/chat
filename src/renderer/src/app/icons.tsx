import type { ReactNode } from 'react'

// Tiny inline stroke icons — no icon library ships with Semaphore.

interface IconProps {
  size?: number
}

function Svg({ size = 16, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      {children}
    </svg>
  )
}

export function IconSearch({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20.5 20.5 16.2 16.2" />
    </Svg>
  )
}

export function IconPlus({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  )
}

// Feather's "settings" icon (MIT — feathericons.com), swapped in for a
// sun/asterisk glyph that testers kept misreading as anything but prefs.
export function IconGear({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Svg>
  )
}

export function IconPin({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M9 4h6l1 7 2.5 2.5V15h-11v-1.5L10 11l-1-7z" />
      <path d="M12 15v6" />
    </Svg>
  )
}

export function IconPanel({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M15 4.5v15" />
    </Svg>
  )
}

export function IconX({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  )
}

export function IconFolder({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M3 7.5a2 2 0 0 1 2-2h4l2 2.2h8a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5z" />
    </Svg>
  )
}

export function IconCheck({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M5 13l4.2 4.2L19 7" />
    </Svg>
  )
}

export function IconWarn({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 3.5 22 20.5H2L12 3.5z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.6v.2" />
    </Svg>
  )
}

export function IconLock({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Svg>
  )
}

export function IconUsers({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="9" cy="8" r="3.4" />
      <path d="M3.2 20c0-3.2 2.6-5.8 5.8-5.8s5.8 2.6 5.8 5.8" />
      <circle cx="17" cy="9" r="2.6" />
      <path d="M17.8 14.4c2.4.4 4.2 2.4 4.2 5" />
    </Svg>
  )
}

export function IconInfo({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5" />
      <path d="M12 8v.2" />
    </Svg>
  )
}

export function IconBolt({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M13 3 5 13.5h5L11 21l8-10.5h-5L13 3z" />
    </Svg>
  )
}

export function IconArrowUp({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </Svg>
  )
}

export function IconFile({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M7 3h7l4 4v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M14 3v4h4" />
    </Svg>
  )
}

export function IconCalendar({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 9.5h17" />
      <path d="M8 3.2v3.6M16 3.2v3.6" />
    </Svg>
  )
}

export function IconGitPull({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="6.5" cy="6" r="2.5" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="17.5" cy="18" r="2.5" />
      <path d="M6.5 8.5v7" />
      <path d="M17.5 15.5V9.5a2.5 2.5 0 0 0-2.5-2.5h-3.4" />
      <path d="M13.4 4.6 11 7l2.4 2.4" />
    </Svg>
  )
}

export function IconGitBranch({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="6.5" cy="5.5" r="2.5" />
      <circle cx="6.5" cy="18.5" r="2.5" />
      <circle cx="17.5" cy="8" r="2.5" />
      <path d="M6.5 8v8" />
      <path d="M17.5 10.5c0 3.4-2.8 5.2-6.2 5.6-1.9.2-3.3.7-4.4 1.6" />
    </Svg>
  )
}

export function IconRefresh({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M20 11a8 8 0 1 0-.7 4.5" />
      <path d="M20 4.5V11h-6.2" />
    </Svg>
  )
}

export function IconFilter({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M3.5 5.5h17l-6.6 7.6v5.6l-3.8 2v-7.6L3.5 5.5z" />
    </Svg>
  )
}

export function IconChevronLeft({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M14.5 5.5 8 12l6.5 6.5" />
    </Svg>
  )
}

export function IconChevronRight({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M9.5 5.5 16 12l-6.5 6.5" />
    </Svg>
  )
}

export function IconExternal({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M13.5 4.5H19.5V10.5" />
      <path d="M19.5 4.5 11 13" />
      <path d="M18 14v4.5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2H10" />
    </Svg>
  )
}

/** Row context-menu trigger (channel/group "⋯" — 1.2). */
export function IconMore({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="5.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18.5" r="1.5" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** Enter full screen (diagram editor whole-window mode — 1.3). */
export function IconExpand({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
    </Svg>
  )
}

/** Exit full screen (1.3) — same corners, arrows pointing inward. */
export function IconCollapse({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5" />
    </Svg>
  )
}


/** Notification controls (1.4) — the bell that opens the quick-controls popover. */
export function IconBell({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M18 9a6 6 0 1 0-12 0c0 4.2-1.5 5.6-2 6.4-.2.4.1.9.6.9h14.8c.5 0 .8-.5.6-.9-.5-.8-2-2.2-2-6.4z" />
      <path d="M10 19.5a2.2 2.2 0 0 0 4 0" />
    </Svg>
  )
}

/** The same bell with a slash: alerts are paused, or silenced outright. */
export function IconBellOff({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M18 9a6 6 0 0 0-8.6-5.4" />
      <path d="M6.2 7.2A6 6 0 0 0 6 9c0 4.2-1.5 5.6-2 6.4-.2.4.1.9.6.9h13" />
      <path d="M10 19.5a2.2 2.2 0 0 0 4 0" />
      <path d="M3.5 3.5l17 17" />
    </Svg>
  )
}
