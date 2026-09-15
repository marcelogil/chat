import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ConvId } from '@shared/types'
import type { MessageView } from '@shared/merge'
import { detectEasterEgg, type EasterEgg } from '@shared/easterEggs'
import { useStore } from '@/store'
import { arrivedLive } from '@/store/liveEvents'
import { effectiveReducedMotion, offerEgg } from '@/app/easterEggQueue'
import { playEasterEgg, prefersReducedMotion } from '@/app/EasterEggOverlay'
import { eggCandidate } from './eggEligibility'

// Message easter eggs (1.5), the wiring: which message on screen, if any, gets
// to set off an animation.
//
// Three facts have to meet, and they live in three different places, which is
// why this sits between them:
//
//   - *what* the text says            → shared/easterEggs.ts (pure, testable)
//   - *whether* it may play           → app/easterEggQueue.ts (pure, testable)
//   - *when the reader can see it*    → the sentinel below
//
// The last one is the reason this is a component at all. "Every reader sees it
// once, when the message first becomes visible" cannot be answered by the
// store: a message sitting three screens down in a conversation nobody has
// scrolled to has not been seen, and playing its animation then would be a
// beetle running across the window for something the reader never read.
//
// Nothing about any of this touches the wire: the reader decides, from
// `body.text`, on their own machine.

interface EggRow {
  egg: EasterEgg
  /** Share-clock ms (the event stem's HLC millisecond). */
  ms: number
  author: string
}

interface FeedArgs {
  conv: ConvId
  messages: readonly MessageView[]
  /** The conversation's log has finished its first read for this session. */
  loaded: boolean
  selfId: string
  /** My read mark as it stood when the conversation opened ('' = none). */
  anchorRead: string
}

/**
 * Returns the callback a row's sentinel calls the first time that row is
 * actually on screen. Stable for the life of the pane, so the sentinels below
 * never re-observe.
 */
export function useEasterEggFeed({ conv, messages, loaded, selfId, anchorRead }: FeedArgs): (id: string) => void {
  // Absent means on — nobody has ever opened the setting.
  const enabled = useStore((s) => s.settings?.easterEggs !== false)
  // 1.5.x — Settings → Appearance's "Play them anyway", offered only while
  // reduced motion is on. Absent means off: reduced motion is an
  // accessibility signal, not something to override by default.
  const ignoreReducedMotion = useStore((s) => s.settings?.easterEggsIgnoreReducedMotion === true)

  // Only `kind: 'text'`, and never a deleted one: a code block is code (the
  // detector strips fences, but a whole-message code block is the same thing
  // at a larger size), a GIF's text is a pack id, and a diagram's or a poll's
  // is the fallback sentence written for older clients.
  const candidates = useMemo(() => {
    const map = new Map<string, EggRow>()
    for (const m of messages) {
      if (m.deleted || m.body.kind !== 'text') continue
      const egg = detectEasterEgg(m.body.text)
      if (egg) map.set(m.id, { egg, ms: m.hlcMs, author: m.authorDevice })
    }
    return map
  }, [messages])

  // What the log already held the moment this conversation opened. Only a
  // fallback for the case the push registry cannot answer — a log still
  // loading, where nothing counts as history yet; real liveness is recorded at
  // the push (store/liveEvents.ts), because `loadTeam` has already prefetched
  // every log long before anybody clicks a conversation. Seeded during render,
  // not in an effect: the sentinels below are children, and a child's effect
  // runs before the parent's.
  const baseline = useRef<{ conv: ConvId; ids: Set<string> } | null>(null)
  if (baseline.current?.conv !== conv) {
    baseline.current = loaded ? { conv, ids: new Set(messages.map((m) => m.id)) } : null
  }

  const ctx = useRef({ candidates, selfId, anchorRead, enabled, ignoreReducedMotion })
  ctx.current = { candidates, selfId, anchorRead, enabled, ignoreReducedMotion }

  return useCallback((id: string) => {
    const { candidates: rows, selfId: me, anchorRead: read, enabled: on, ignoreReducedMotion: ignore } = ctx.current
    const row = rows.get(id)
    if (!row) return
    const base = baseline.current
    const egg = offerEgg(
      eggCandidate(
        { id, ...row },
        { selfId: me, anchorRead: read, baseline: base === null ? null : base.ids, arrivedLive },
      ),
      { now: Date.now(), enabled: on, reducedMotion: effectiveReducedMotion(prefersReducedMotion(), ignore) },
    )
    if (egg) playEasterEgg(egg)
  }, [])
}

/**
 * A zero-height marker at the bottom of a message row. When it enters the
 * viewport the row has been seen — clipped by the virtualized scroller the
 * same way the eye is, which `useEffect` on mount alone would not be (Virtuoso
 * mounts a screenful of overscan above and below).
 *
 * One observer per visible row is a handful of them at a time, and each one
 * disconnects the instant it fires.
 */
export function EggSentinel({ id, onVisible }: { id: string; onVisible: (id: string) => void }) {
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      onVisible(id)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect()
          onVisible(id)
        }
      },
      { threshold: 0 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [id, onVisible])

  // 1px tall with a matching negative margin: a real box for the observer to
  // measure (a zero-area target is not reliably reported), no effect on the
  // row's height or on Virtuoso's measurement of it.
  return <span ref={ref} aria-hidden style={{ display: 'block', height: 1, marginTop: -1 }} />
}
