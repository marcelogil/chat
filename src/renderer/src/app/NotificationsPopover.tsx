import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { SettingsView } from '@shared/bridge'
import {
  alertsSilenced,
  chatPreset,
  chatPresetPatch,
  inQuietHours,
  isSnoozed,
  prAlertMode,
  snoozeChoices,
  type ChatAlertPreset,
} from '@shared/notifyDecision'
import { useStore } from '@/store'
import { NO_DRAG, SectionLabel } from './chrome'
import { trapTabWithin } from './ChannelMenu'
import { IconBell, IconBellOff } from './icons'
import { toast } from './toasts'

// The quick notification controls (1.4). One small overlay, opened from the
// bell in the sidebar footer and from the pull-request pane's header, holding
// the three things people actually reach for mid-work: how loud pull requests
// are, how loud chat is, and "not now".
//
// Every control here writes the *same* settings the Settings modal edits —
// there is no parallel state, no per-pane override and nothing to reconcile.
// That is the whole design: the popover is a shortcut into `settings.set`,
// so whichever surface you change it from, the other one already agrees.

const PR_HINT: Record<'all' | 'mine' | 'none', string> = {
  all: 'New pull requests in every watched repo',
  mine: 'Only reviews assigned to you and your own pull requests',
  none: 'No pull-request alerts — the badge still counts',
}

const CHAT_HINT: Record<ChatAlertPreset, string> = {
  all: 'Every message in every channel, plus direct messages',
  mine: 'Mentions, direct messages and private groups',
  none: 'Nothing at all — unread counts still add up',
  custom: 'Mixed settings from the Settings window',
}

/** "15:30" in whatever the machine calls half past three. */
function clockTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/**
 * A full-width segmented picker. Wraps to a second line rather than squeezing
 * its labels — the chat row grows a fourth "Custom" segment whenever the two
 * underlying switches are in a combination this popover has no name for.
 */
function Choice<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: { v: T; label: string }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 2,
        padding: 2,
        background: 'var(--bg-input)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--r-sm)',
      }}
    >
      {options.map((o) => (
        <button
          key={o.v}
          role="radio"
          aria-checked={value === o.v}
          title={o.label}
          className="sem-focus"
          onClick={() => onChange(o.v)}
          style={{
            flex: '1 1 auto',
            height: 24,
            padding: '0 8px',
            border: 'none',
            borderRadius: 'var(--r-xs)',
            fontSize: 11.5,
            fontFamily: 'var(--font-ui)',
            fontWeight: value === o.v ? 600 : 400,
            whiteSpace: 'nowrap',
            color: value === o.v ? 'var(--text-1)' : 'var(--text-3)',
            background: value === o.v ? 'var(--bg-raised)' : 'transparent',
            cursor: 'pointer',
            transition: 'background var(--t-fast) var(--ease-standard), color var(--t-fast) var(--ease-standard)',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Row({ label, children, hint }: { label: string; children: ReactNode; hint: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <SectionLabel>{label}</SectionLabel>
      {children}
      <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: '15px' }}>{hint}</div>
    </div>
  )
}

/**
 * Where the panel hangs: above the bell in the sidebar footer, or below it in
 * a pane header. Both anchor to the nearest positioned ancestor, so the caller
 * only has to be `position: relative`.
 */
export type PopoverPlacement = 'sidebar' | 'header'

export function NotificationsPopover({
  onClose,
  placement,
}: {
  onClose: () => void
  placement: PopoverPlacement
}) {
  const settings = useStore((s) => s.settings)
  const refreshSettings = useStore((s) => s.refreshSettings)
  const openSettings = useStore((s) => s.openSettings)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Open with the keyboard and the first control is where the focus already is.
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('button')?.focus()
  }, [])

  if (!settings) return null

  async function patch(p: Partial<SettingsView>) {
    try {
      await window.bridge.settings.set(p)
      await refreshSettings()
    } catch {
      toast('Could not save that setting', 'danger')
    }
  }

  const now = Date.now()
  const paused = isSnoozed(settings, now)
  const { hour, tomorrow } = snoozeChoices(now)
  const chat = chatPreset(settings)
  const quiet = settings.quietHours
  // Enforced since 1.4 (shared/notifyDecision.ts), so the line says which of
  // the two it is: running right now, or merely switched on for later.
  const quietNow = inQuietHours(quiet, now)

  return (
    <>
      {/* NO_DRAG (1.4): a click-away layer spans the shell's drag strip, and
          Chromium derives the draggable region from the DOM rather than from
          z-order — without this, dismissing near the top dragged the window.
          See app/overlayChrome.ts. */}
      <div style={{ ...NO_DRAG, position: 'fixed', inset: 0, zIndex: 70 }} onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-label="Notifications"
        className="sem-frost"
        onKeyDown={(e) => trapTabWithin(panelRef.current, e)}
        style={{
          position: 'absolute',
          ...(placement === 'sidebar' ? { left: 8, bottom: 58 } : { right: 4, top: 34 }),
          width: 288,
          zIndex: 71,
          borderRadius: 'var(--r-lg)',
          border: '1px solid var(--border-subtle)',
          boxShadow: 'var(--elev-2)',
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          animation: 'sem-rise var(--t-base) var(--ease-pop)',
        }}
      >
        <Row label="Pull requests" hint={PR_HINT[prAlertMode(settings)]}>
          <Choice
            label="Pull request alerts"
            value={prAlertMode(settings)}
            options={[
              { v: 'all' as const, label: 'All' },
              { v: 'mine' as const, label: 'Only mine' },
              { v: 'none' as const, label: 'Paused' },
            ]}
            onChange={(v) => void patch({ notifyPrs: v })}
          />
        </Row>

        <Row label="Chat" hint={CHAT_HINT[chat]}>
          <Choice
            label="Chat alerts"
            value={chat}
            options={[
              { v: 'all' as const, label: 'Everything' },
              { v: 'mine' as const, label: 'Only about me' },
              { v: 'none' as const, label: 'Nothing' },
              // Shown only while it is the truth: a combination the Settings
              // window can produce and this popover has no name for. Picking
              // any of the three above replaces it; nothing is overwritten
              // until somebody does.
              ...(chat === 'custom' ? [{ v: 'custom' as const, label: 'Custom' }] : []),
            ]}
            onChange={(v) => {
              if (v !== 'custom') void patch(chatPresetPatch(v))
            }}
          />
        </Row>

        <Row
          label="Pause everything"
          hint={
            paused
              ? `Paused until ${clockTime(settings.snoozeUntil ?? 0)} — beam offers still come through`
              : 'Silences chat and pull-request alerts for a while'
          }
        >
          <Choice
            label="Pause all alerts"
            value={paused ? (settings.snoozeUntil === tomorrow ? 'tomorrow' : 'hour') : 'off'}
            options={[
              { v: 'off' as const, label: 'Off' },
              { v: 'hour' as const, label: '1 hour' },
              { v: 'tomorrow' as const, label: 'Until 9:00 tomorrow' },
            ]}
            onChange={(v) => void patch({ snoozeUntil: v === 'off' ? null : v === 'hour' ? hour : tomorrow })}
          />
        </Row>

        {quiet.enabled && (
          <div style={{ fontSize: 11, color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span aria-hidden="true" style={{ display: 'flex', color: 'var(--text-3)' }}>
              <IconBellOff size={12} />
            </span>
            {quietNow
              ? `Quiet hours: notifications are silenced until ${quiet.to}`
              : `Quiet hours ${quiet.from}–${quiet.to} are on — notifications are silenced then`}
          </div>
        )}

        <button
          className="sem-row sem-focus"
          onClick={() => {
            onClose()
            openSettings('notifications')
          }}
          style={{
            height: 26,
            padding: '0 8px',
            borderRadius: 'var(--r-sm)',
            fontSize: 12,
            color: 'var(--accent-text)',
            justifyContent: 'flex-start',
            cursor: 'pointer',
          }}
        >
          All notification settings…
        </button>
      </div>
    </>
  )
}

/**
 * The bell that opens it. Slashed while everything is silenced, so the state is
 * legible without opening anything — which is the point of putting it in the
 * footer next to the gear.
 */
export function NotificationsBell({
  open,
  onToggle,
  size = 28,
}: {
  open: boolean
  onToggle: () => void
  size?: number
}) {
  const settings = useStore((s) => s.settings)
  const silenced = settings ? alertsSilenced(settings, Date.now()) : false
  const label = silenced ? 'Notifications — paused' : 'Notifications'
  return (
    <button
      className="sem-row sem-focus"
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-expanded={open}
      aria-haspopup="dialog"
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 'var(--r-sm)',
        background: open ? 'var(--accent-soft)' : undefined,
        color: silenced ? 'var(--text-3)' : open ? 'var(--accent-text)' : 'var(--text-2)',
      }}
    >
      {silenced ? <IconBellOff size={16} /> : <IconBell size={16} />}
    </button>
  )
}
