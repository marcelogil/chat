import { useEffect, useRef, useState } from 'react'
import type { PrView } from '@shared/types'
import { TEAM_CONV } from '@shared/constants'
import { shouldNotifyPr } from '@shared/notifyDecision'
import { useStore } from '@/store'
import { IconGitPull } from '@/app/icons'
import { truncate } from '@/app/chrome'

// Spec §2.7 — the red "new pull request" card. Mounted once in AppShell next to
// BeamSurface (z-index lane 850, fixed top-right). It also owns the dock badge:
// the unseen count is the only number the app puts on its icon for PRs.
//
// Two rules keep it quiet: it never fires for the first list this session (the
// key set is seeded from the first *completed* poll, so opening the app is not
// an event), and it never fires while the PR pane is already the open
// conversation.

const AUTO_DISMISS_MS = 12_000

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export function PrAlert() {
  const prs = useStore((s) => s.prs)
  const status = useStore((s) => s.prsStatus)
  const activeConv = useStore((s) => s.activeConv)
  const setActiveConv = useStore((s) => s.setActiveConv)

  const [fresh, setFresh] = useState<PrView[] | null>(null)
  const seenKeys = useRef<Set<string> | null>(null)
  const [calm] = useState(reducedMotion)

  // Dock/taskbar badge: mirrors the sidebar's red count.
  const unseen = status?.unseen ?? 0
  useEffect(() => {
    void window.bridge.app.setBadge(unseen).catch(() => {})
  }, [unseen])

  // Leaving the team (a folder change unmounts AppShell) takes the badge with
  // it: nothing else writes the icon, so without this the last count would sit
  // on the dock while the app is back on the onboarding screen.
  useEffect(() => {
    return () => {
      void window.bridge.app.setBadge(0).catch(() => {})
    }
  }, [])

  // Diff the key set against the previous push. `lastPollAt` gates the seeding:
  // the service answers `prs.list()` with an empty list until its first poll
  // lands (FIRST_POLL_MS after launch), and that empty list must not count as
  // "the previous poll" or the first real one would look like N new PRs. Main
  // suppresses the OS notification for the same poll (`caughtUp`).
  useEffect(() => {
    if (!status || status.lastPollAt === null) return
    const previous = seenKeys.current
    seenKeys.current = new Set(prs.map((p) => p.key))
    if (previous === null) return // first real list of the session — seed only
    // An approved PR is listed from 1.4 on ("Ready to complete") but is nobody's
    // review to do — it never raises the card, exactly as it never counts in
    // `PrsStatus.unseen`.
    //
    // The device's preference then decides the rest, through the same pure
    // helper the main-side toast uses: "only mine" keeps the pull requests
    // waiting on me, "paused" and a running snooze keep none. The badge above
    // is deliberately not filtered — it counts rather than interrupts.
    const settings = useStore.getState().settings
    const now = Date.now()
    const arrived = prs.filter(
      (p) =>
        !p.seen &&
        p.state?.kind !== 'approved' &&
        !previous.has(p.key) &&
        (!settings || shouldNotifyPr({ view: p, meId: status.me?.id ?? null, settings, now })),
    )
    if (arrived.length === 0) return
    if (useStore.getState().activeConv === TEAM_CONV.prs) return
    setFresh(arrived)
  }, [prs, status])

  // Opening the pane answers the alert.
  useEffect(() => {
    if (activeConv === TEAM_CONV.prs) setFresh(null)
  }, [activeConv])

  useEffect(() => {
    if (fresh === null) return undefined
    const t = window.setTimeout(() => setFresh(null), AUTO_DISMISS_MS)
    return () => window.clearTimeout(t)
  }, [fresh])

  if (fresh === null || fresh.length === 0) return null

  const many = fresh.length > 1
  const shown = fresh.slice(0, 3)
  const rest = fresh.length - shown.length

  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        top: 52,
        right: 12,
        // Above every full-window overlay (diagram editor 1100, lightbox
        // 1000) — a PR alert the editor can hide is no alert. See the ladder
        // in app/toasts.tsx.
        zIndex: 1150,
        width: 320,
        padding: 14,
        background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
        backdropFilter: 'blur(20px) saturate(1.2)',
        border: '1px solid var(--danger)',
        borderRadius: 'var(--r-xl)',
        boxShadow: 'var(--elev-3)',
        animation: calm ? undefined : 'sem-rise var(--t-base) var(--ease-pop)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          aria-hidden="true"
          style={{
            width: 28,
            height: 28,
            borderRadius: 'var(--r-md)',
            background: 'var(--danger-soft)',
            color: 'var(--danger)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <IconGitPull size={16} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>
            {many ? `${fresh.length} new pull requests` : 'New pull request'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>waiting for review</div>
        </div>
      </div>

      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {shown.map((p) => (
          <div key={p.key} style={{ display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)', flexShrink: 0 }}>
              #{p.id}
            </span>
            <span title={`${p.title} — ${p.repoName}`} style={{ ...truncate, fontSize: 12, color: 'var(--text-2)' }}>
              {p.title}
            </span>
          </div>
        ))}
        {rest > 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>and {rest} more</div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button
          className="sem-chip-btn sem-focus"
          onClick={() => setFresh(null)}
          title="Dismiss"
          aria-label="Dismiss the new pull request alert"
          style={{ height: 26 }}
        >
          Dismiss
        </button>
        <button
          className="sem-chip-btn sem-focus"
          onClick={() => {
            setFresh(null)
            setActiveConv(TEAM_CONV.prs)
          }}
          title="Open the pull request list"
          aria-label="Review the new pull requests"
          style={{ height: 26, background: 'var(--danger)', borderColor: 'var(--danger)', color: 'var(--on-accent)' }}
        >
          Review
        </button>
      </div>
    </div>
  )
}
