import { useEffect, useRef } from 'react'
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { Button } from '@/ui/atoms'
import { NO_DRAG } from './chrome'

/** Tab/Shift+Tab wrap-around within a dialog root — `Button` doesn't forward
 * refs, so this walks the DOM rather than tracking individual element refs.
 * Exported for GroupDialog, the other `aria-modal` surface in this app. */
export function trapTabWithin(root: HTMLElement | null, e: KeyboardEvent): void {
  if (e.key !== 'Tab' || !root) return
  const focusables = root.querySelectorAll<HTMLElement>(
    'button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )
  if (focusables.length === 0) return
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

// Small generic pieces shared by the channel and group row menus (1.2):
// a popover dropdown, its menu items, and the danger-confirm dialog used by
// Delete channel / Delete group / Leave group. Kept here so both row kinds
// (ChannelRow, GroupRow — both in Sidebar.tsx) share one look and one
// outside-click behavior instead of duplicating it.

/** Full-screen invisible layer that closes an open popover on outside click — the same trick as Sidebar's StatusPopover. */
function PopoverBackdrop({ onClose, zIndex }: { onClose: () => void; zIndex: number }) {
  return <div style={{ position: 'fixed', inset: 0, zIndex }} onClick={onClose} aria-hidden="true" />
}

/** Row-menu dropdown, anchored to the top-right of its `position: relative` parent. */
export function Dropdown({
  open,
  onClose,
  width = 190,
  children,
}: {
  open: boolean
  onClose: () => void
  width?: number
  children: ReactNode
}) {
  // Same Escape-to-close as the confirm dialogs below — a row menu opened by
  // keyboard (Enter/Space on the now-always-present "⋯" trigger) had no way
  // out except a mouse click on the backdrop.
  useEffect(() => {
    if (!open) return
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <>
      <PopoverBackdrop onClose={onClose} zIndex={71} />
      <div
        role="menu"
        className="sem-frost"
        onClick={(e: MouseEvent) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 26,
          right: 4,
          zIndex: 72,
          width,
          borderRadius: 'var(--r-md)',
          border: '1px solid var(--border-subtle)',
          boxShadow: 'var(--elev-2)',
          padding: 4,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          animation: 'sem-pop var(--t-fast) var(--ease-standard)',
        }}
      >
        {children}
      </div>
    </>
  )
}

export function MenuItem({
  children,
  onClick,
  disabled,
  danger,
  title,
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
  title?: string
}) {
  return (
    <button
      role="menuitem"
      className="sem-row"
      disabled={disabled}
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        if (!disabled) onClick?.()
      }}
      style={{
        width: '100%',
        height: 30,
        padding: '0 10px',
        borderRadius: 'var(--r-sm)',
        fontSize: 13,
        color: disabled ? 'var(--text-3)' : danger ? 'var(--danger)' : 'var(--text-1)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  )
}

/** A caption line inside a Dropdown — e.g. the fixed-channel explanation. */
export function MenuNote({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: '6px 10px 4px', fontSize: 11, color: 'var(--text-3)', lineHeight: '15px' }}>{children}</div>
  )
}

/**
 * Scrim + dialog confirm, same visual language as CalendarDialog/PrsPrefs —
 * used for Delete channel, Delete group, Leave group, and the diagram editor's
 * "close with unsent work" (which passes a `zIndex` because it has to land on
 * top of the full-window editor overlay rather than under it).
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  tone = 'danger',
  busy,
  zIndex = 85,
  onConfirm,
  onClose,
}: {
  title: string
  /** Usually a sentence; the delete-channel dialog appends a `ReactNode` warning line when older peers are present. */
  message: ReactNode
  confirmLabel: string
  tone?: 'danger' | 'primary'
  busy?: boolean
  /** Above the sidebar/menus by default; callers inside a higher overlay pass their own. */
  zIndex?: number
  onConfirm: () => void
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // aria-modal is a promise the dialog has to keep itself: focus the primary
  // action on open (Delete/Leave dialogs are opened from a menu item, so
  // nothing inside the dialog is focused by default) and trap Tab within it.
  useEffect(() => {
    const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button')
    if (buttons && buttons.length > 0) buttons[buttons.length - 1].focus()
  }, [])

  return (
    <div
      onClick={onClose}
      role="presentation"
      style={{
        // 1.4: a modal backdrop covers the shell's drag strip, and Chromium
        // works the draggable region out from the DOM rather than from z-order
        // — so without this, click-away-to-dismiss in the top ~36 px started a
        // window drag instead. Same reason the diagram editor's header owns its
        // own region; see app/overlayChrome.ts.
        ...NO_DRAG,
        position: 'fixed',
        inset: 0,
        zIndex,
        background: 'var(--bg-overlay)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'sem-fade var(--t-fast) var(--ease-standard)',
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-label={title}
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => trapTabWithin(dialogRef.current, e)}
        style={{
          width: 400,
          maxWidth: 'calc(100vw - 48px)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--elev-3)',
          overflow: 'hidden',
          animation: 'sem-pop var(--t-base) var(--ease-pop)',
        }}
      >
        <div style={{ padding: '16px 20px 8px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-1)' }}>{title}</div>
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 8, lineHeight: '18px' }}>{message}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, padding: '14px 20px 18px', justifyContent: 'flex-end' }}>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} disabled={busy} onClick={onConfirm}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
