import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsView, ShareStats } from '@shared/bridge'
import { useStore, selfOf, type SettingsSection } from '@/store'
import { isSnoozed, prAlertMode, snoozeChoices } from '@shared/notifyDecision'
import {
  DEFAULT_QUICK_MESSAGES,
  QUICK_MESSAGE_LIMITS,
  effectiveQuickMessages,
  normalizeQuickMessages,
} from '@shared/quickMessages'
import { LOGIN_ITEM_APPROVAL } from './launchNudgeState'
import { Avatar, DeviceChip, IconButton, Spinner } from '@/ui/atoms'
import { SectionLabel, Toggle, isMac, truncate } from './chrome'
import { IconArrowUp, IconLock, IconX } from './icons'
import { toast } from './toasts'

// Spec §2.6 — settings modal, 720×520, left nav.

// The union lives in the store (1.4): the modal can now be opened straight
// onto a section from the notifications popover, which has no way to reach
// this component's own state.
type Section = SettingsSection

const NAV: { id: Section; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'quickMessages', label: 'Quick messages' },
  { id: 'storage', label: 'Storage & Share' },
  { id: 'about', label: 'About' },
]

function Segmented<T extends string>({
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
        display: 'inline-flex',
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
            height: 24,
            padding: '0 12px',
            border: 'none',
            borderRadius: 'var(--r-xs)',
            fontSize: 12,
            fontWeight: value === o.v ? 600 : 400,
            fontFamily: 'var(--font-ui)',
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

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <SectionLabel>{label}</SectionLabel>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: '15px' }}>{hint}</div>}
    </div>
  )
}

function ToggleRow({
  label,
  sub,
  on,
  onChange,
}: {
  label: string
  sub?: string
  on: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, color: 'var(--text-1)' }}>{label}</span>
        {sub && <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>{sub}</span>}
      </span>
      <Toggle on={on} onChange={onChange} label={label} />
    </div>
  )
}

export default function SettingsModal({ onClose, section: opensOn }: { onClose: () => void; section?: Section }) {
  const settings = useStore((s) => s.settings)
  const refreshSettings = useStore((s) => s.refreshSettings)
  const launchInfo = useStore((s) => s.launchInfo)
  const refreshLaunchInfo = useStore((s) => s.refreshLaunchInfo)
  const health = useStore((s) => s.health)
  const boot = useStore((s) => s.boot)
  const self = selfOf(boot)
  const [section, setSection] = useState<Section>(opensOn ?? 'profile')
  const [confirmingFolderChange, setConfirmingFolderChange] = useState(false)

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function patch(p: Partial<SettingsView>) {
    try {
      await window.bridge.settings.set(p)
      await refreshSettings()
    } catch {
      toast('Could not save that setting', 'danger')
    }
  }

  // 1.4 — these two are OS state, not part of SettingsView, so they go through
  // app:* rather than settings:set; launchInfo is what LaunchNudge also reads,
  // so both surfaces agree the moment either one changes it.
  async function setOpenAtLogin(on: boolean) {
    try {
      await window.bridge.app.setOpenAtLogin(on)
      await refreshLaunchInfo()
    } catch {
      toast('Could not change the login item', 'danger')
    }
  }

  async function sendTestNotification() {
    try {
      await window.bridge.app.testNotification()
      await refreshSettings() // picks up notificationsAccepted flipping to true
      toast('Test notification sent', 'success')
    } catch {
      toast('Could not send a test notification', 'danger')
    }
  }

  return (
    <div
      onClick={onClose}
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'var(--bg-overlay)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'sem-fade var(--t-fast) var(--ease-standard)',
      }}
    >
      <div
        role="dialog"
        aria-label="Settings"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 720,
          height: 520,
          maxWidth: 'calc(100vw - 48px)',
          maxHeight: 'calc(100vh - 48px)',
          display: 'flex',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--elev-3)',
          overflow: 'hidden',
          animation: 'sem-pop var(--t-base) var(--ease-pop)',
        }}
      >
        <div
          style={{
            width: 160,
            flexShrink: 0,
            background: 'var(--bg-sidebar)',
            borderRight: '1px solid var(--border-subtle)',
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-1)', padding: '10px 10px 12px' }}>Settings</div>
          {NAV.map((n) => (
            <button
              key={n.id}
              className="sem-row sem-focus"
              onClick={() => setSection(n.id)}
              title={n.label}
              aria-current={section === n.id}
              style={{
                height: 30,
                padding: '0 10px',
                borderRadius: 'var(--r-sm)',
                fontSize: 13,
                fontWeight: section === n.id ? 600 : 400,
                color: section === n.id ? 'var(--text-1)' : 'var(--text-2)',
                background: section === n.id ? 'var(--accent-soft)' : undefined,
              }}
            >
              {n.label}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <button
            className="sem-row sem-focus"
            onClick={onClose}
            title="Close settings (Esc)"
            style={{ height: 30, padding: '0 10px', borderRadius: 'var(--r-sm)', fontSize: 13, color: 'var(--text-3)' }}
          >
            Close
          </button>
        </div>

        <div className="sem-scroll" style={{ flex: 1, minWidth: 0, padding: 24 }}>
          {!settings ? (
            <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
              <Spinner />
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
              {section === 'profile' && self && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    <Avatar name={self.displayName} size={56} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-1)' }}>{self.displayName}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>{self.teamName}</div>
                    </div>
                  </div>
                  <Field label="Display name" hint="Name changes announce themselves in channels, so identity can't silently swap.">
                    <input className="sem-input" value={self.displayName} disabled aria-label="Display name (read-only)" style={{ maxWidth: 280 }} />
                  </Field>
                  <Field label="Device signature">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <DeviceChip hostname={self.hostname} fingerprint={self.fingerprint} full />
                      <span style={{ color: 'var(--text-3)', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                        <IconLock size={12} /> Derived from this machine — visible to teammates, not editable.
                      </span>
                    </div>
                  </Field>
                </>
              )}

              {section === 'appearance' && (
                <>
                  <Field label="Theme">
                    <Segmented
                      label="Theme"
                      value={settings.theme}
                      options={[
                        { v: 'system' as const, label: 'System' },
                        { v: 'dark' as const, label: 'Dark' },
                        { v: 'light' as const, label: 'Light' },
                      ]}
                      onChange={(v) => void patch({ theme: v })}
                    />
                  </Field>
                  <Field label="Message text size" hint="S = 14px · M = 15px · L = 16px">
                    <Segmented
                      label="Message text size"
                      value={settings.fontSize}
                      options={[
                        { v: 'S' as const, label: 'S' },
                        { v: 'M' as const, label: 'M' },
                        { v: 'L' as const, label: 'L' },
                      ]}
                      onChange={(v) => void patch({ fontSize: v })}
                    />
                  </Field>
                  <Field label="Autoplay GIFs">
                    <Segmented
                      label="Autoplay GIFs"
                      value={settings.autoplayGifs}
                      options={[
                        { v: 'always' as const, label: 'Always' },
                        { v: 'hover' as const, label: 'While hovered' },
                        { v: 'never' as const, label: 'Never' },
                      ]}
                      onChange={(v) => void patch({ autoplayGifs: v })}
                    />
                  </Field>
                </>
              )}

              {section === 'notifications' && (
                <>
                  <Field label="Channel messages">
                    <Segmented
                      label="Notify for channel messages"
                      value={settings.notifyChannels}
                      options={[
                        { v: 'all' as const, label: 'All' },
                        { v: 'mentions' as const, label: 'Mentions only' },
                        { v: 'none' as const, label: 'Nothing' },
                      ]}
                      onChange={(v) => void patch({ notifyChannels: v })}
                    />
                  </Field>
                  {/* 1.4 — the same three settings the bell popover writes.
                      Two views of one state: whichever you change, the other
                      is already showing it. */}
                  <ToggleRow
                    label="Direct messages and private groups"
                    sub="These ignore the channel setting above — you were invited into them personally."
                    on={settings.notifyDms !== false}
                    onChange={(v) => void patch({ notifyDms: v })}
                  />
                  <Field
                    label="Pull request alerts"
                    hint={
                      prAlertMode(settings) === 'all'
                        ? 'New pull requests in every watched repo.'
                        : prAlertMode(settings) === 'mine'
                          ? 'Only reviews assigned to you and your own pull requests.'
                          : 'No pull-request alerts — the badge still counts.'
                    }
                  >
                    <Segmented
                      label="Notify for pull requests"
                      value={prAlertMode(settings)}
                      options={[
                        { v: 'all' as const, label: 'All' },
                        { v: 'mine' as const, label: 'Only mine' },
                        { v: 'none' as const, label: 'Paused' },
                      ]}
                      onChange={(v) => void patch({ notifyPrs: v })}
                    />
                  </Field>
                  <Field
                    label="Pause everything"
                    hint={
                      isSnoozed(settings, Date.now())
                        ? `Paused until ${new Date(settings.snoozeUntil ?? 0).toLocaleString()}. Beam offers still come through — they need an answer.`
                        : 'Silences every chat and pull-request alert for a while.'
                    }
                  >
                    <Segmented
                      label="Pause all alerts"
                      value={
                        isSnoozed(settings, Date.now())
                          ? settings.snoozeUntil === snoozeChoices(Date.now()).tomorrow
                            ? 'tomorrow'
                            : 'hour'
                          : 'off'
                      }
                      options={[
                        { v: 'off' as const, label: 'Off' },
                        { v: 'hour' as const, label: 'For 1 hour' },
                        { v: 'tomorrow' as const, label: 'Until 9:00 tomorrow' },
                      ]}
                      onChange={(v) => {
                        const { hour, tomorrow } = snoozeChoices(Date.now())
                        void patch({ snoozeUntil: v === 'off' ? null : v === 'hour' ? hour : tomorrow })
                      }}
                    />
                  </Field>
                  <ToggleRow
                    label="Show message content in notifications"
                    sub="Off shows only who wrote, never what."
                    on={settings.notifyPreviews}
                    onChange={(v) => void patch({ notifyPreviews: v })}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <ToggleRow
                      label="Quiet hours"
                      sub="Silences notifications and the pull-request alert between these times; the app still updates, and unread counts still add up."
                      on={settings.quietHours.enabled}
                      onChange={(v) => void patch({ quietHours: { ...settings.quietHours, enabled: v } })}
                    />
                    {settings.quietHours.enabled && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 2 }}>
                        <input
                          type="time"
                          className="sem-input"
                          style={{ width: 104 }}
                          value={settings.quietHours.from}
                          aria-label="Quiet hours start"
                          onChange={(e) => void patch({ quietHours: { ...settings.quietHours, from: e.target.value } })}
                        />
                        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>to</span>
                        <input
                          type="time"
                          className="sem-input"
                          style={{ width: 104 }}
                          value={settings.quietHours.to}
                          aria-label="Quiet hours end"
                          onChange={(e) => void patch({ quietHours: { ...settings.quietHours, to: e.target.value } })}
                        />
                      </div>
                    )}
                  </div>
                  {(launchInfo?.openAtLoginSupported || launchInfo?.notificationsSupported) && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <SectionLabel>Launch</SectionLabel>
                      {launchInfo?.openAtLoginSupported && (
                        <ToggleRow
                          label="Open Chat when I log in"
                          sub={
                            // macOS 13+ can register the item and still hold it
                            // behind an approval — the toggle is on, and this
                            // says where the last tick lives (1.4).
                            launchInfo.status === 'requires-approval'
                              ? LOGIN_ITEM_APPROVAL
                              : isMac
                                ? "You'll still enter the team passphrase after a restart."
                                : 'Chat opens automatically the next time you sign in.'
                          }
                          on={launchInfo.openAtLogin}
                          onChange={(v) => void setOpenAtLogin(v)}
                        />
                      )}
                      {launchInfo?.notificationsSupported && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ display: 'block', fontSize: 13, color: 'var(--text-1)' }}>
                              Notifications
                            </span>
                            <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>
                              {settings.notificationsAccepted
                                ? 'Asked on this device.'
                                : isMac
                                  ? 'Not confirmed yet — macOS will ask the first time.'
                                  : 'Not confirmed yet.'}
                            </span>
                          </span>
                          <button className="sem-chip-btn" onClick={() => void sendTestNotification()}>
                            Send a test notification
                          </button>
                        </div>
                      )}
                      <ToggleRow
                        label="Suggest these at launch"
                        sub="Shows a reminder to turn these on until both are accepted."
                        on={settings.suggestAtLaunch !== false}
                        onChange={(v) => void patch({ suggestAtLaunch: v })}
                      />
                    </div>
                  )}
                </>
              )}

              {section === 'privacy' && (
                <ToggleRow
                  label="Automatically accept beams from teammates"
                  sub="Off by default. Beams from new or flagged devices always ask first."
                  on={settings.autoAcceptBeams}
                  onChange={(v) => void patch({ autoAcceptBeams: v })}
                />
              )}

              {section === 'quickMessages' && <QuickMessagesSection settings={settings} patch={patch} />}

              {section === 'storage' && self && (
                <>
                  <Field label="Team folder">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        title={self.sharePath}
                        style={{
                          ...truncate,
                          flex: 1,
                          minWidth: 0,
                          fontFamily: 'var(--font-mono)',
                          fontSize: 12,
                          color: 'var(--text-2)',
                          background: 'var(--bg-input)',
                          border: '1px solid var(--border-subtle)',
                          borderRadius: 'var(--r-sm)',
                          padding: '6px 10px',
                          userSelect: 'text',
                        }}
                      >
                        {self.sharePath}
                      </span>
                      <button
                        className="sem-chip-btn"
                        onClick={() => void window.bridge.app.showInFolder(self.sharePath)}
                        title={isMac ? 'Show in Finder' : 'Show in file manager'}
                      >
                        {isMac ? 'Show in Finder' : 'Show in Explorer'}
                      </button>
                    </div>
                  </Field>
                  <Field label="Share health">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-2)' }}>
                      <span
                        aria-hidden="true"
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: health.reachable ? 'var(--success)' : 'var(--danger)',
                        }}
                      />
                      {health.reachable
                        ? `Connected${health.latencyMs !== null ? ` · ${health.latencyMs}ms` : ''}`
                        : 'Unreachable — retrying'}
                    </div>
                  </Field>
                  <Field label="Change team folder">
                    <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: '17px', marginBottom: 8 }}>
                      Everyone who picks the same folder lands in the same team — switching folders
                      switches teams. Your name and this device's identity are kept; messages stay
                      (encrypted) in the old folder.
                    </div>
                    {confirmingFolderChange ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 13, color: 'var(--warning)' }}>
                          Disconnect and re-run setup?
                        </span>
                        <button
                          className="sem-chip-btn"
                          style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
                          onClick={() => void window.bridge.app.changeTeamFolder()}
                        >
                          Yes, change folder
                        </button>
                        <button className="sem-chip-btn" onClick={() => setConfirmingFolderChange(false)}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button className="sem-chip-btn" onClick={() => setConfirmingFolderChange(true)}>
                        Change team folder…
                      </button>
                    )}
                  </Field>
                </>
              )}

              {section === 'about' && (
                <>
                  <div>
                    <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-1)' }}>Chat</div>
                    <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 4 }}>
                      Serverless team chat over an encrypted shared folder.
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: 'var(--text-2)' }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <span style={{ width: 90, color: 'var(--text-3)' }}>Electron</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, userSelect: 'text' }}>
                        {window.bridge.versions.electron}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <span style={{ width: 90, color: 'var(--text-3)' }}>Chrome</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, userSelect: 'text' }}>
                        {window.bridge.versions.chrome}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <span style={{ width: 90, color: 'var(--text-3)' }}>Platform</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{window.bridge.platform}</span>
                    </div>
                    <ShareTraffic />
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * What this client is actually costing the shared folder, right now (1.2). The
 * number is the trailing-60 s rate from ShareIo's own counter plus the tier the
 * poller is in, so "why is the NAS light blinking" has an answer that does not
 * need a packet capture. Polled only while the About pane is open.
 *
 * It counts the metadata chatter this app's cadence controls — beacon listings
 * and reads, event publishes, sweeps, the drops inbox. Blob and beam bodies
 * stream straight through `node:fs` (one counted `stat` at the head, then raw
 * reads/writes), so a file transfer barely moves this number even while it
 * saturates the link — hence the label.
 */
function ShareTraffic() {
  const [stats, setStats] = useState<ShareStats | null>(null)

  useEffect(() => {
    let alive = true
    const read = async () => {
      try {
        const s = await window.bridge.diag.shareStats()
        if (alive) setStats(s)
      } catch {
        if (alive) setStats(null) // no session yet (locked / onboarding)
      }
    }
    void read()
    const t = setInterval(() => void read(), 2000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const TIER_LABEL: Record<ShareStats['tier'], string> = {
    focused: 'active',
    blurred: 'in the background',
    idle: 'idle',
    paused: 'paused (screen locked or asleep)',
  }

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <span style={{ width: 90, color: 'var(--text-3)' }}>
        Share traffic
        <br />
        <span style={{ fontSize: 11 }}>excluding file transfers</span>
      </span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, userSelect: 'text' }}>
        {stats
          ? `${stats.ratePerSec.toFixed(1)} ops/s now · ${stats.total.toLocaleString()} since launch · ${TIER_LABEL[stats.tier]}`
          : '—'}
      </span>
    </div>
  )
}

/**
 * Settings → Quick messages: the flat, editable list behind the composer's
 * inline chip row (QuickRepliesRow.tsx). At most `QUICK_MESSAGE_LIMITS.maxEntries`
 * rows — that's what fits in one line of chips above the composer without
 * wrapping — in the display order the row renders them.
 *
 * `rows` is the source of truth while this section stays mounted: it seeds
 * once from `settings` and is never resynced from it afterward, so this
 * component's own save (settings.set → refreshSettings, a round trip through
 * main) can never fight a keystroke that landed a moment later. A row commits
 * on blur, not on every keystroke, for the same reason — typing stays purely
 * local until the field is left. Structural edits (add/remove/reorder/reset)
 * commit immediately, same as every toggle elsewhere in this modal.
 */
function QuickMessagesSection({
  settings,
  patch,
}: {
  settings: SettingsView
  patch: (p: Partial<SettingsView>) => Promise<void>
}) {
  // Seed through `effectiveQuickMessages`, the same read the chip row uses:
  // a stale profile with more than `maxEntries` rows (or blank/over-long ones)
  // then opens this editor already showing exactly what is on screen above the
  // composer, instead of a longer list whose tail "+ Add message" refuses to
  // grow and whose first blur silently drops the overflow.
  const [rows, setRows] = useState<string[]>(() => effectiveQuickMessages(settings))
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])
  const focusLast = useRef(false)

  useEffect(() => {
    if (!focusLast.current) return
    focusLast.current = false
    inputRefs.current[rows.length - 1]?.focus()
  }, [rows.length])

  // An empty save is indistinguishable from "never customized" the moment it
  // round-trips through settings (effectiveQuickMessages treats null/absent
  // and [] the same, so the chip row would fall back to the defaults either
  // way) — so treat clearing the last row exactly like Reset, including in
  // what this editor shows, rather than leaving a dead empty list on screen
  // while the row quietly shows the five defaults behind it.
  function commit(next: string[]): void {
    const normalized = normalizeQuickMessages(next)
    if (normalized.length === 0) {
      setRows(DEFAULT_QUICK_MESSAGES)
      void patch({ quickMessages: null })
      return
    }
    setRows(normalized)
    void patch({ quickMessages: normalized })
  }

  function edit(i: number, value: string): void {
    setRows((prev) => prev.map((r, idx) => (idx === i ? value : r)))
  }

  function removeRow(i: number): void {
    commit(rows.filter((_, idx) => idx !== i))
  }

  function moveRow(i: number, dir: -1 | 1): void {
    const j = i + dir
    if (j < 0 || j >= rows.length) return
    const next = [...rows]
    ;[next[i], next[j]] = [next[j], next[i]]
    commit(next)
  }

  function addRow(): void {
    if (rows.length >= QUICK_MESSAGE_LIMITS.maxEntries) return
    focusLast.current = true
    setRows((prev) => [...prev, ''])
  }

  function resetToDefaults(): void {
    setRows(DEFAULT_QUICK_MESSAGES)
    void patch({ quickMessages: null })
  }

  return (
    <>
      <Field
        label="Quick messages"
        hint={`Shown as a row of chips above the composer — click one to send it right away, ⌥-click to insert it instead. One per line, up to ${QUICK_MESSAGE_LIMITS.maxEntries} messages and ${QUICK_MESSAGE_LIMITS.maxChars} characters each; blank lines are dropped.`}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((row, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                ref={(el) => {
                  inputRefs.current[i] = el
                }}
                className="sem-input"
                value={row}
                maxLength={QUICK_MESSAGE_LIMITS.maxChars}
                aria-label={`Quick message ${i + 1}`}
                onChange={(e) => edit(i, e.target.value)}
                onBlur={() => commit(rows)}
                style={{ flex: 1, minWidth: 0 }}
              />
              <span style={{ opacity: i === 0 ? 0.35 : 1, pointerEvents: i === 0 ? 'none' : undefined }}>
                <IconButton label="Move up" size={24} onClick={() => moveRow(i, -1)}>
                  <span aria-hidden style={{ display: 'inline-flex' }}>
                    <IconArrowUp size={12} />
                  </span>
                </IconButton>
              </span>
              <span style={{ opacity: i === rows.length - 1 ? 0.35 : 1, pointerEvents: i === rows.length - 1 ? 'none' : undefined }}>
                <IconButton label="Move down" size={24} onClick={() => moveRow(i, 1)}>
                  <span aria-hidden style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
                    <IconArrowUp size={12} />
                  </span>
                </IconButton>
              </span>
              <IconButton label="Remove this quick message" size={24} onClick={() => removeRow(i)}>
                <IconX size={12} />
              </IconButton>
            </div>
          ))}
        </div>
      </Field>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="sem-chip-btn"
          onClick={addRow}
          disabled={rows.length >= QUICK_MESSAGE_LIMITS.maxEntries}
          style={{ opacity: rows.length >= QUICK_MESSAGE_LIMITS.maxEntries ? 0.5 : 1 }}
        >
          + Add message
        </button>
        <button className="sem-chip-btn" onClick={resetToDefaults}>
          Reset to defaults
        </button>
      </div>
    </>
  )
}
