import { useState } from 'react'
import { useStore } from '@/store'
import { toast } from './toasts'
import { LOGIN_ITEM_APPROVAL, nudgeRows, shouldShowLaunchNudge, type LaunchNudgeRowId } from './launchNudgeState'

// 1.4 — the launch nudge: suggest opening Chat at login and allowing OS
// notifications, once per launch, until both are accepted (Gil's ask,
// verbatim: "Each time they open the app, if not accepted yet, they should
// have the suggestion to do so."). Bottom-left, sitting higher than
// UpdateBanner — same fixed-chip pattern, just taller — so the two never
// overlap when both show.
//
// It is a suggestion, not an alert, so it lives *below* the popover lane in
// the z-ladder (toasts.tsx): the sidebar's own notification popover opens at
// bottom-left too (left 8, bottom 58) and a card at 690 covered it. Anything a
// person deliberately opened outranks a card that appeared on its own.
//
// "Not now" lives in the store, not in component state, and nothing is
// written to disk: it lasts exactly one launch, unlike the update banner's
// localStorage "remind me later", which is meant to persist. The store is
// what makes "one launch" true — AppShell remounts (a boot-mode change, an
// unlock, a hot reload) would otherwise bring the card straight back.

export function LaunchNudge() {
  const boot = useStore((s) => s.boot)
  const settings = useStore((s) => s.settings)
  const launchInfo = useStore((s) => s.launchInfo)
  const refreshSettings = useStore((s) => s.refreshSettings)
  const refreshLaunchInfo = useStore((s) => s.refreshLaunchInfo)
  const dismissed = useStore((s) => s.launchNudgeDismissed)
  const dismissLaunchNudge = useStore((s) => s.dismissLaunchNudge)
  const [busy, setBusy] = useState<LaunchNudgeRowId | null>(null)

  // Gate on 'ready' (boot complete *and* unlocked — the passphrase screen is
  // its own boot mode) so the card never fights the unlock screen for room.
  if (boot?.mode !== 'ready' || dismissed) return null
  if (!shouldShowLaunchNudge(settings, launchInfo)) return null
  // shouldShowLaunchNudge already null-checked both; narrow them for nudgeRows.
  if (!settings || !launchInfo) return null

  const rows = nudgeRows(settings, launchInfo, window.bridge.platform)

  async function turnOn(id: LaunchNudgeRowId) {
    setBusy(id)
    try {
      if (id === 'openAtLogin') {
        const res = await window.bridge.app.setOpenAtLogin(true)
        await refreshLaunchInfo()
        if (!res.openAtLogin) {
          toast(
            window.bridge.platform === 'darwin'
              ? LOGIN_ITEM_APPROVAL
              : 'Windows did not confirm the login item — try again from Settings.',
          )
        }
      } else {
        await window.bridge.app.testNotification()
        await refreshSettings()
      }
    } catch {
      toast('Could not turn that on — try again from Settings → Notifications.', 'danger')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      role="group"
      aria-label="Suggested setup"
      style={{
        position: 'fixed',
        bottom: 56,
        left: 272,
        // Under popovers (70/71), the quick switcher (60) and dialogs (80);
        // above every pane-level layer (≤ 41). See the ladder in toasts.tsx.
        zIndex: 55,
        width: 300,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 14,
        background: 'var(--bg-raised)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--r-lg)',
        boxShadow: 'var(--elev-2)',
        animation: 'sem-rise var(--t-base) var(--ease-standard)',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>Get the most out of Chat</div>

      {rows.map((row) => (
        <div key={row.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--text-1)' }}>{row.label}</span>
            {row.sub && (
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{row.sub}</span>
            )}
          </span>
          {row.done ? (
            <span
              aria-label="Turned on"
              title="Turned on"
              style={{ color: 'var(--success)', fontSize: 14, fontWeight: 700, flexShrink: 0, lineHeight: '20px' }}
            >
              ✓
            </span>
          ) : (
            <button
              className="sem-chip-btn"
              disabled={busy === row.id}
              onClick={() => void turnOn(row.id)}
              style={{ flexShrink: 0, height: 24, padding: '0 10px' }}
            >
              {busy === row.id ? '…' : 'Turn on'}
            </button>
          )}
        </div>
      ))}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={dismissLaunchNudge}
          style={{ border: 'none', background: 'transparent', color: 'var(--text-3)', fontSize: 12, cursor: 'pointer' }}
        >
          Not now
        </button>
      </div>
    </div>
  )
}
