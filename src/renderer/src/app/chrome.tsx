import type { CSSProperties, ReactNode } from 'react'

// Shared chrome helpers for the shell + onboarding surfaces (owned by this slice).

export const DRAG = { WebkitAppRegion: 'drag' } as CSSProperties
export const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties

// Full-window overlays (diagram editor, lightbox, screen-share viewer) draw
// their own top strip over the shell's drag strip — and Chromium works out the
// draggable region from the DOM, not from z-order, so they have to opt out of
// it control by control and dodge the OS chrome themselves. Re-exported here so
// there is one import for all of it; the helper itself is pure (and tested) in
// overlayChrome.ts, which is why it is not written inline in this .tsx.
export { overlayChromeInsets, type ChromeInsets } from './overlayChrome'

export const isMac = window.bridge.platform === 'darwin'
export const modKey = isMac ? '⌘' : 'Ctrl'

export const truncate: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/** Small accessible switch used in settings + status popover. */
export function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      onClick={() => onChange(!on)}
      className="sem-focus"
      style={{
        width: 34,
        height: 20,
        borderRadius: 'var(--r-full)',
        border: `1px solid ${on ? 'transparent' : 'var(--border-strong)'}`,
        background: on ? 'var(--accent)' : 'var(--bg-input)',
        position: 'relative',
        cursor: 'pointer',
        padding: 0,
        flexShrink: 0,
        transition: 'background var(--t-fast) var(--ease-standard)',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: 2,
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: on ? 'var(--on-accent)' : 'var(--text-3)',
          transform: on ? 'translateX(14px)' : 'translateX(0)',
          transition: 'transform var(--t-fast) var(--ease-standard), background var(--t-fast) var(--ease-standard)',
        }}
      />
    </button>
  )
}

export function SectionLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.06em',
        color: 'var(--text-3)',
        textTransform: 'uppercase',
        userSelect: 'none',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

const CSS = `
.sem-input {
  width: 100%;
  height: 32px;
  box-sizing: border-box;
  background: var(--bg-input);
  color: var(--text-1);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-sm);
  padding: 0 10px;
  font-family: var(--font-ui);
  font-size: 13px;
  transition: border-color var(--t-fast) var(--ease-standard);
}
.sem-input::placeholder { color: var(--text-3); }
.sem-input:hover { border-color: var(--border-strong); }
.sem-input:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
.sem-input:disabled { opacity: 0.6; cursor: default; }
.sem-focus:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.sem-row {
  display: flex;
  align-items: center;
  border: none;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  text-align: left;
  font-family: var(--font-ui);
  font-size: 13px;
  transition: background var(--t-instant) var(--ease-standard);
}
.sem-row:hover { background: var(--bg-raised); }
/* Row "⋯" menu triggers (Sidebar's ChannelRow/GroupRow, 1.2): the button is
   always in the DOM — never conditionally rendered — so Tab can reach it;
   only its visibility is hover/focus/open-gated, via CSS rather than a
   render gate. */
.sem-row-trigger { opacity: 0; pointer-events: none; transition: opacity var(--t-fast) var(--ease-standard); }
.sem-row-hoverable:hover .sem-row-trigger,
.sem-row-hoverable:focus-within .sem-row-trigger,
.sem-row-trigger[data-open='1'] { opacity: 1; pointer-events: auto; }
.sem-row-hoverable:focus-within .sem-row-badge { display: none; }
/* The identity chip on a person row (1.4): hostname·fingerprint is the answer
   to "is this really them", not something to read all day, so it sits at the
   end of the status line invisible and un-hittable until the row is hovered or
   focused. Opacity rather than display keeps the status line's layout still,
   and pointer-events:none keeps the chip's tooltip out of the way until it is
   actually on screen. visibility rides along with opacity (delayed on the
   way out, immediate on the way in) so the chip is also out of the
   accessibility tree and tab order while hidden, not just invisible — a screen
   reader stepping through the row no longer announces a chip nobody can see.
   A flagged chip never gets this class — see PersonLines. */
.sem-chip-reveal {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity var(--t-fast) var(--ease-standard), visibility 0s linear var(--t-fast);
}
.sem-row:hover .sem-chip-reveal,
.sem-row:focus-visible .sem-chip-reveal,
.sem-reveal-host:hover .sem-chip-reveal,
.sem-reveal-host:focus-within .sem-chip-reveal {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transition: opacity var(--t-fast) var(--ease-standard);
}
.sem-frost {
  background: color-mix(in srgb, var(--bg-raised) 86%, transparent);
  backdrop-filter: blur(20px) saturate(1.2);
}
.sem-scroll { overflow-y: auto; }
.sem-clamp2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.sem-chip-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  border-radius: var(--r-full);
  background: var(--bg-raised);
  border: 1px solid var(--border-subtle);
  color: var(--text-1);
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--t-fast) var(--ease-standard), border-color var(--t-fast) var(--ease-standard);
}
.sem-chip-btn:hover { background: var(--accent-soft); border-color: var(--accent); }
@keyframes sem-shake {
  0%, 100% { transform: translateX(0); }
  15% { transform: translateX(-4px); }
  30% { transform: translateX(4px); }
  45% { transform: translateX(-4px); }
  60% { transform: translateX(4px); }
  80% { transform: translateX(-2px); }
}
@keyframes sem-step-in-r { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: translateX(0); } }
@keyframes sem-step-in-l { from { opacity: 0; transform: translateX(-24px); } to { opacity: 1; transform: translateX(0); } }
@keyframes sem-pop { from { opacity: 0; transform: scale(0.8); } to { opacity: 1; transform: scale(1); } }
@keyframes sem-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes sem-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes sem-banner-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes sem-toast-in { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: translateX(0); } }
.sem-drift-a, .sem-drift-b { animation: none; }
@media (prefers-reduced-motion: no-preference) {
  .sem-drift-a { animation: sem-drift-a 60s ease-in-out infinite alternate; }
  .sem-drift-b { animation: sem-drift-b 74s ease-in-out infinite alternate; }
}
@keyframes sem-drift-a { from { transform: translate(-12%, -8%) scale(1); } to { transform: translate(10%, 6%) scale(1.15); } }
@keyframes sem-drift-b { from { transform: translate(8%, 10%) scale(1.1); } to { transform: translate(-10%, -6%) scale(0.95); } }
`

export function ChromeCss() {
  return <style>{CSS}</style>
}
