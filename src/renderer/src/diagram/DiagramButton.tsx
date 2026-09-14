import { useState } from 'react'
import type { ConvId } from '@shared/types'
import { useStore } from '@/store'
import { NO_DRAG } from '@/app/chrome'
import { IconButton } from '@/ui/atoms'

// The composer's Diagram control. Lives here rather than inside Composer.tsx so
// the composer keeps one line of diagram code, and so nothing on the startup
// path can accidentally reach Excalidraw: opening the editor only sets a store
// slot; DiagramRoot's lazy() does the loading.

export function DiagramIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="1.75" y="1.75" width="5" height="4" rx="1" />
      <rect x="9.25" y="10.25" width="5" height="4" rx="1" />
      <path d="M4.25 5.75v3.5a1 1 0 0 0 1 1h4" />
      <path d="M11.75 10.25V7" />
    </svg>
  )
}

export function DiagramButton({ conv }: { conv: ConvId }) {
  const [open, setOpen] = useState(false)

  const start = (autoImport: boolean): void => {
    setOpen(false)
    useStore.getState().openDiagramEditor({ conv, mode: 'edit', title: '', scene: null, autoImport })
  }

  return (
    <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      <IconButton label="Draw a diagram" active={open} onClick={() => setOpen((v) => !v)}>
        <DiagramIcon size={16} />
      </IconButton>
      {open && (
        <>
          {/* Spans the shell's drag strip, so it has to opt out of it — see
              app/overlayChrome.ts. */}
          <div style={{ ...NO_DRAG, position: 'fixed', inset: 0, zIndex: 30 }} onMouseDown={() => setOpen(false)} />
          <div
            className="sem-popover"
            role="menu"
            aria-label="Diagram"
            style={{
              position: 'absolute',
              bottom: '100%',
              right: 0,
              marginBottom: 8,
              width: 200,
              padding: 4,
              background: 'var(--bg-raised)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--r-md)',
              boxShadow: 'var(--elev-3)',
              zIndex: 31,
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setOpen(false)
              }
            }}
          >
            <MenuItem label="New diagram" onClick={() => start(false)} />
            <MenuItem label="Import diagram…" onClick={() => start(true)} />
          </div>
        </>
      )}
    </span>
  )
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      className="sem-row sem-focus"
      onClick={onClick}
      style={{
        width: '100%',
        height: 28,
        gap: 8,
        padding: '0 8px',
        border: 'none',
        borderRadius: 'var(--r-sm)',
        background: 'transparent',
        color: 'var(--text-1)',
        fontSize: 13,
        fontFamily: 'var(--font-ui)',
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )
}
