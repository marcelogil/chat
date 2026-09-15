import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import type { IndexLocationWithAlign, VirtuosoHandle } from 'react-virtuoso'
import type { ConvId } from '@shared/types'
import { isDmConv } from '@shared/ids'
import type { MaterializedLog, MessageView, SysView } from '@shared/merge'
import { useStore } from '@/store'
import { toast } from '@/app/toasts'
import { JUMP_FLASH_MS, isDuplicateInvocation, resolveJump, shouldClear, type PendingJump } from '@/search/jump'
import { JUMP_SETTLE_MS, isInside, newLanding, nextLandingStep } from '@/search/landing'
import { formatDayDivider, formatTime } from '@/ui/atoms'
import { openLiveBoard } from '@/diagram/collab'
import { boardJoinAction, type LiveBoardEntry } from '@/diagram/live'
import { MessageRow } from './MessageRow'
import { EggSentinel, useEasterEggFeed } from './EasterEggFeed'
import { dayKeyOf, sysLine, type ChipData } from './util'

// Virtualized message area: day dividers, unread divider, system rows,
// grouped flat rows, jump-to-latest pill, DM read receipts, markRead.

type Item =
  | { kind: 'msg'; key: string; m: MessageView; groupStart: boolean; pop: boolean }
  | { kind: 'sys'; key: string; s: SysView }
  | { kind: 'day'; key: string; ms: number }
  | { kind: 'unread'; key: string }

const GROUP_WINDOW_MS = 5 * 60_000

const ListHeader = () => <div style={{ height: 12 }} />
const ListFooter = () => <div style={{ height: 10 }} />

interface Props {
  conv: ConvId
  log: MaterializedLog
  loaded: boolean
  selfId: string
  anchorRead: string
  editingId: string | null
  chipOf: (device: string) => ChipData
  nameOf: (device: string) => string
  getMessage: (id: string) => MessageView | undefined
  onReply: (id: string) => void
  onEditStart: (id: string) => void
  onEditDone: () => void
}

export function MessageList({
  conv,
  log,
  loaded,
  selfId,
  anchorRead,
  editingId,
  chipOf,
  nameOf,
  getMessage,
  onReply,
  onEditStart,
  onEditDone,
}: Props) {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  /** The row a quick-switcher jump landed on, highlighted for JUMP_FLASH_MS. */
  const [flashId, setFlashId] = useState<string | null>(null)
  const seenRef = useRef<Set<string>>(new Set())
  const initializedRef = useRef(false)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  const leftAtRef = useRef<string | null>(null)

  const items = useMemo<Item[]>(() => {
    const stream: ({ t: 'm'; v: MessageView } | { t: 's'; v: SysView })[] = [
      ...log.messages.map((v) => ({ t: 'm' as const, v })),
      ...log.sys.map((v) => ({ t: 's' as const, v })),
    ].sort((a, b) => (a.v.id < b.v.id ? -1 : 1))

    const fresh = initializedRef.current
    const seen = seenRef.current
    const next: Item[] = []
    let lastDay = ''
    let prevMsg: MessageView | null = null
    let unreadPlaced = false

    for (const entry of stream) {
      const day = dayKeyOf(entry.v.hlcMs)
      if (day !== lastDay) {
        next.push({ kind: 'day', key: `day-${day}`, ms: entry.v.hlcMs })
        lastDay = day
        prevMsg = null
      }
      if (entry.t === 's') {
        next.push({ kind: 'sys', key: entry.v.id, s: entry.v })
        prevMsg = null
        continue
      }
      const m = entry.v
      if (!unreadPlaced && anchorRead !== '' && m.id > anchorRead && m.authorDevice !== selfId) {
        next.push({ kind: 'unread', key: 'unread' })
        prevMsg = null
        unreadPlaced = true
      }
      // Unverified messages always start a group so the warning badge and
      // identity chip are visible right where the doubt is.
      const groupStart =
        !prevMsg ||
        prevMsg.authorDevice !== m.authorDevice ||
        m.hlcMs - prevMsg.hlcMs > GROUP_WINDOW_MS ||
        m.verified === false
      const pop = fresh && !seen.has(m.id) && m.authorDevice === selfId
      next.push({ kind: 'msg', key: m.id, m, groupStart, pop })
      prevMsg = m
    }

    if (loaded) {
      seenRef.current = new Set(log.messages.map((m) => m.id))
      initializedRef.current = true
    }
    return next
  }, [log, selfId, anchorRead, loaded])

  const newestId = log.messages.length > 0 ? log.messages[log.messages.length - 1].id : null

  // DM receipt under my newest message: Sent (on the share) → Delivered (the
  // peer's client picked it up) → Read (they had it on screen).
  const cursors = useStore((s) => s.cursors[conv])
  /** Which live boards are still running — the Join button's whole condition. */
  const liveBoards = useStore((s) => s.liveBoards)
  const receiptFor = useMemo(() => {
    if (!isDmConv(conv)) return null
    let mineNewest: MessageView | null = null
    for (let i = log.messages.length - 1; i >= 0; i--) {
      const m = log.messages[i]
      if (m.authorDevice === selfId) {
        mineNewest = m
        break
      }
    }
    if (!mineNewest || mineNewest.deleted) return null
    const peer = cursors ? Object.keys(cursors).find((d) => d !== selfId) : undefined
    const cur = peer ? cursors![peer] : undefined
    if (cur?.read && cur.read >= mineNewest.id) {
      return { id: mineNewest.id, text: cur.readAt ? `Read ${formatTime(cur.readAt)}` : 'Read' }
    }
    if (cur?.ingested && cur.ingested >= mineNewest.id) return { id: mineNewest.id, text: 'Delivered' }
    return { id: mineNewest.id, text: 'Sent' }
  }, [conv, cursors, log, selfId])

  // Jump to one message (1.6): the quick switcher's message search sets
  // `pendingJump` and this is the only place that can act on it — the row index
  // exists nowhere else, and neither does the virtuoso handle. Rules (whose
  // list, loaded yet, still there at all) live in search/jump.ts.
  const pendingJump = useStore((s) => s.pendingJump)
  /**
   * The exact `pendingJump` object this effect has already resolved — guards
   * against React.StrictMode invoking the effect body twice for one commit
   * (isDuplicateInvocation, search/jump.ts). Without it, a retention-miss
   * toast (or a scroll) could fire twice for a single jump.
   */
  const lastHandledJumpRef = useRef<PendingJump | null>(null)
  /** This list's own DOM root: every landing measurement is scoped to it. */
  const rootRef = useRef<HTMLDivElement>(null)
  /** Virtuoso's scrolling element, cached while it stays in the document. */
  const scrollerRef = useRef<HTMLElement | null>(null)
  /**
   * The live `items`, read by the landing loop. It re-derives the row index
   * every retry rather than trusting the one it started with: a landing spans
   * many frames, and anything that folds into the log mid-flight (a peer's
   * message, an edit, a delete) shifts every index after it.
   */
  const itemsRef = useRef(items)
  itemsRef.current = items
  /**
   * Where Virtuoso mounts. Latched on the render that first mounts it (below,
   * past the early returns) because that is the only render it reads the prop
   * on — and mounting *at* the target is the whole reason a jump into another
   * conversation is on screen from the first frame instead of scrolling there
   * from the bottom.
   */
  const mountAtRef = useRef<IndexLocationWithAlign | number | null>(null)
  /**
   * True while a jump is landing and through the settle window after it, with
   * `followOutput` off for that whole span. A ref *and* a state: the mount
   * path has to have it off in the very render that mounts at the target
   * (before any effect runs), while the state is only there to schedule the
   * re-render that turns following back on.
   */
  const jumpingRef = useRef(false)
  const [jumping, setJumping] = useState(false)
  const landingRef = useRef<{ frame: number | null; settle: number | null }>({ frame: null, settle: null })

  const stopLanding = useCallback(() => {
    const l = landingRef.current
    if (l.frame !== null) window.cancelAnimationFrame(l.frame)
    if (l.settle !== null) window.clearTimeout(l.settle)
    l.frame = null
    l.settle = null
  }, [])

  /**
   * Land on a message and *prove* it landed.
   *
   * One `scrollToIndex` is not enough. Virtuoso measures the rows it has just
   * been handed over several frames, so a scroll issued while the list is
   * still sizing itself lands short — and the row it aimed at keeps moving as
   * the rows above it get their real heights. So this measures the target row
   * against the scroller every frame, re-asks whenever it is outside, and
   * stops only once it has stayed inside (`nextLandingStep`, search/landing.ts
   * owns the budget and the streak).
   *
   * Cancelled by a newer jump (`stopLanding` above) and by the list going
   * away, which the loop notices itself: an unmounted root is disconnected.
   * Deliberately *not* cancelled from an effect cleanup — clearing the request
   * re-runs the jump effect immediately, and a cleanup would cancel the very
   * landing it had just asked for.
   */
  const startLanding = useCallback(
    (id: string) => {
      stopLanding()
      jumpingRef.current = true
      setJumping(true)
      // Where the reader is about to be parked, for the jump pill's count. The
      // atBottom transition that follows a landing would otherwise mark it at
      // the *newest* id, and a pill counting messages newer than the newest is
      // a pill that never appears — leaving no way back to the bottom from a
      // row 44 messages up.
      leftAtRef.current = id
      let state = newLanding()
      const tick = (): void => {
        landingRef.current.frame = null
        const root = rootRef.current
        // The list went away under the landing — a real unmount, or one of the
        // early returns below emptying the rows. Let go of `jumping` on the way
        // out: leaving it latched pins `followOutput` off for the life of this
        // list, and nothing would ever turn it back on.
        if (!root?.isConnected) {
          jumpingRef.current = false
          setJumping(false)
          return
        }
        const scroller = scrollerOf(root, scrollerRef)
        const row = root.querySelector<HTMLElement>('[data-jump-target="1"]')
        // A row virtuoso has not rendered yet is exactly as un-landed as one
        // scrolled past, and both are answered the same way: ask again.
        const inside =
          row !== null && scroller !== null && isInside(row.getBoundingClientRect(), scroller.getBoundingClientRect())
        if (!inside) {
          const index = itemsRef.current.findIndex((it) => it.kind === 'msg' && it.m.id === id)
          if (index >= 0) virtuosoRef.current?.scrollToIndex({ index, align: 'center', behavior: 'auto' })
        }
        const step = nextLandingStep(state, inside)
        state = step.state
        if (step.action === 'retry') {
          landingRef.current.frame = window.requestAnimationFrame(tick)
          return
        }
        // Landed, or quietly out of budget: hold `followOutput` off a little
        // longer either way. Virtuoso's own at-bottom belief is not settled the
        // frame the row arrives, and *any* change to `items` while it is
        // unsettled — a peer's message landing a beat after the jump — reads to
        // followOutput as "new output, go to the bottom", undoing a landing
        // that had just succeeded. (Not the unread divider: ChatPane freezes
        // `anchorRead` for as long as the conversation stays open, so nothing
        // this list does can make that row come or go.)
        landingRef.current.settle = window.setTimeout(() => {
          landingRef.current.settle = null
          jumpingRef.current = false
          setJumping(false)
        }, JUMP_SETTLE_MS)
      }
      landingRef.current.frame = window.requestAnimationFrame(tick)
    },
    [stopLanding],
  )

  useEffect(() => {
    if (isDuplicateInvocation(pendingJump, lastHandledJumpRef.current)) return
    // Resolve against the store's live value rather than trust the closed-over
    // `pendingJump`: this effect's side effects must reflect the request as it
    // stands right now, not as it stood when this render was scheduled.
    const current = useStore.getState().pendingJump
    const action = resolveJump(current, {
      conv,
      loaded,
      indexOf: (id) => items.findIndex((it) => it.kind === 'msg' && it.m.id === id),
    })
    if (shouldClear(action)) {
      lastHandledJumpRef.current = current
      useStore.getState().clearPendingJump()
    }
    if (action.kind === 'scroll') {
      setFlashId(action.id)
      startLanding(action.id)
      return
    }
    if (action.kind === 'missing') toast(action.toast, 'info')
    // A mount that latched onto a target (below) but never became a landing —
    // the request was withdrawn between that render and this effect — must not
    // leave `followOutput` off for the life of the list.
    const l = landingRef.current
    if (jumpingRef.current && l.frame === null && l.settle === null) {
      jumpingRef.current = false
      setJumping(false)
    }
  }, [pendingJump, conv, loaded, items, startLanding])

  useEffect(() => {
    if (flashId === null) return undefined
    const t = window.setTimeout(() => setFlashId(null), JUMP_FLASH_MS)
    return () => window.clearTimeout(t)
  }, [flashId])

  // Don't leave the settle timer running past the list. Mount-only, and it
  // clears the *timer* rather than calling `stopLanding`: React.StrictMode runs
  // this cleanup on its simulated remount, in the same pass the jump effect
  // started the landing in, so cancelling the frame loop here would kill every
  // dev-mode jump (`isDuplicateInvocation` then refuses to restart it). The
  // frame loop needs no cleanup — it stops itself the first frame the root is
  // disconnected — while a settle timer can only exist a frame or more later,
  // which is long after StrictMode's extra cleanup has come and gone.
  useEffect(
    () => () => {
      const l = landingRef.current
      if (l.settle !== null) window.clearTimeout(l.settle)
      l.settle = null
    },
    [],
  )

  // Mark read while parked at the bottom with app focus.
  //
  // A landing is the one time the list is not where `atBottom` says it is: it
  // mounts believing it is at the bottom (that is the initial state) and
  // virtuoso's own at-bottom stream is debounced, so a mount-at-target jump
  // would publish a read cursor for the newest message the instant it landed on
  // a row 44 messages above it — clearing the unread badge for messages nobody
  // has seen, and telling a DM peer "Read" for one nobody looked at. So a
  // landing suppresses it, and `jumping` is in the deps precisely so the end of
  // the settle window re-runs this: reaching the bottom for real marks read
  // exactly as before.
  useEffect(() => {
    if (!newestId) return
    const mark = (): void => {
      if (jumpingRef.current || !atBottomRef.current || !document.hasFocus()) return
      useStore.getState().markRead(conv, newestId)
    }
    mark()
    window.addEventListener('focus', mark)
    return () => window.removeEventListener('focus', mark)
  }, [conv, newestId, atBottom, jumping])

  // Track where we left the bottom, for the jump pill count.
  useEffect(() => {
    atBottomRef.current = atBottom
    // A landing is not an arrival at the bottom, whatever virtuoso still
    // believes mid-flight: clearing the mark here would throw away the row
    // `startLanding` parked the reader on. Re-runs on `jumping` so the settle
    // window ending re-reads a genuine at-bottom.
    if (atBottom && !jumpingRef.current) leftAtRef.current = null
    else if (!atBottom && leftAtRef.current === null) leftAtRef.current = newestId ?? ''
  }, [atBottom, newestId, jumping])

  const newCount = useMemo(() => {
    if (atBottom || leftAtRef.current === null) return 0
    const from = leftAtRef.current
    let n = 0
    for (let i = log.messages.length - 1; i >= 0; i--) {
      const m = log.messages[i]
      if (m.id <= from) break
      if (m.authorDevice !== selfId) n++
    }
    return n
  }, [atBottom, log, selfId])

  // Message easter eggs (1.5): the feed decides, the sentinel under each row
  // says when that row is genuinely on screen. Both are no-ops when the
  // setting is off or the message says nothing special.
  const onEggVisible = useEasterEggFeed({ conv, messages: log.messages, loaded, selfId, anchorRead })

  const renderItem = useCallback(
    (_index: number, it: Item) => {
      switch (it.kind) {
        case 'day':
          return <DayDivider ms={it.ms} />
        case 'unread':
          return <UnreadDivider />
        case 'sys':
          return <SysRow line={sysLine(it.s, nameOf)} action={boardJoinAction(it.s, liveBoards)} />
        case 'msg':
          return (
            <>
              <MessageRow
                conv={conv}
                m={it.m}
                groupStart={it.groupStart}
                pop={it.pop}
                flash={flashId === it.m.id}
                selfId={selfId}
                chip={chipOf(it.m.authorDevice)}
                receipt={receiptFor && receiptFor.id === it.m.id ? receiptFor.text : null}
                isEditing={editingId === it.m.id}
                getMessage={getMessage}
                nameOf={nameOf}
                onReply={onReply}
                onEditStart={onEditStart}
                onEditDone={onEditDone}
              />
              <EggSentinel id={it.m.id} onVisible={onEggVisible} />
            </>
          )
      }
    },
    [
      conv,
      selfId,
      chipOf,
      nameOf,
      getMessage,
      liveBoards,
      onReply,
      onEditStart,
      onEditDone,
      editingId,
      receiptFor,
      onEggVisible,
      flashId,
    ],
  )

  if (!loaded && items.length === 0) return <SkeletonRows />
  // The empty conversation state is rendered once by EmptyConvOverlay (shell),
  // layered over this pane so the composer stays reachable underneath.
  if (loaded && items.length === 0) return null

  // Latched here, not in an effect: this is the render Virtuoso mounts on, and
  // `initialTopMostItemIndex` is read once, at mount. ChatPane keys this list
  // by conversation, so a jump elsewhere is always a fresh mount — and a jump
  // that names a row already in `items` is born centred on it rather than born
  // at the bottom and scrolled. `loaded` is not consulted on purpose: the rows
  // being here is the proof (see resolveJump).
  if (mountAtRef.current === null) {
    const target =
      pendingJump && pendingJump.conv === conv
        ? items.findIndex((it) => it.kind === 'msg' && it.m.id === pendingJump.id)
        : -1
    mountAtRef.current = target >= 0 ? { index: target, align: 'center' } : Math.max(0, items.length - 1)
    // Mounting at a target is itself a landing: following has to be off from
    // this very render, before the first change to `items` can snap to the
    // bottom. The jump effect above takes it from here, on this same commit.
    if (target >= 0) jumpingRef.current = true
  }

  return (
    <div ref={rootRef} style={{ position: 'absolute', inset: 0 }}>
      <Virtuoso<Item>
        ref={virtuosoRef}
        style={{ height: '100%' }}
        data={items}
        computeItemKey={(_i, it) => it.key}
        itemContent={renderItem}
        followOutput={jumpingRef.current || jumping ? false : 'smooth'}
        initialTopMostItemIndex={mountAtRef.current}
        atBottomStateChange={(b) => {
          atBottomRef.current = b
          setAtBottom(b)
        }}
        increaseViewportBy={{ top: 600, bottom: 200 }}
        components={{ Header: ListHeader, Footer: ListFooter }}
      />
      {newCount > 0 && (
        <button
          className="sem-jump"
          title="Jump to the latest messages"
          aria-label={`Jump to ${newCount} new message${newCount > 1 ? 's' : ''}`}
          onClick={() =>
            virtuosoRef.current?.scrollToIndex({ index: items.length - 1, align: 'end', behavior: 'smooth' })
          }
          style={{
            position: 'absolute',
            bottom: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 10,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 14px',
            borderRadius: 'var(--r-full)',
            border: 'none',
            background: 'var(--accent)',
            color: 'var(--on-accent)',
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'var(--font-ui)',
            boxShadow: 'var(--elev-2)',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          ↓ {newCount} new message{newCount > 1 ? 's' : ''}
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * The element a landing measures against. react-virtuoso marks its own
 * scroller (`data-virtuoso-scroller`), which is the whole contract here; the
 * search for a child that actually overflows is the fallback for the day that
 * attribute changes, so a library bump degrades into a slower query rather
 * than into jumps that silently never land. Cached while it stays in the
 * document — this runs once a frame.
 */
function scrollerOf(root: HTMLElement, cache: { current: HTMLElement | null }): HTMLElement | null {
  const cached = cache.current
  if (cached?.isConnected && root.contains(cached)) return cached
  const marked = root.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')
  const found =
    marked ??
    Array.from(root.querySelectorAll<HTMLElement>('*')).find((el) => el.scrollHeight > el.clientHeight + 1) ??
    null
  cache.current = found
  return found
}

function DayDivider({ ms }: { ms: number }) {
  return (
    <div style={{ position: 'relative', textAlign: 'center', padding: '14px 0 4px', userSelect: 'none' }}>
      <div
        aria-hidden
        style={{ position: 'absolute', left: 16, right: 16, top: 'calc(50% + 5px)', height: 1, background: 'var(--border-subtle)' }}
      />
      <span
        style={{
          position: 'relative',
          display: 'inline-block',
          fontSize: 12,
          fontWeight: 500,
          color: 'var(--text-2)',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--r-full)',
          padding: '3px 10px',
        }}
      >
        {formatDayDivider(ms)}
      </span>
    </div>
  )
}

function UnreadDivider() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px 4px', userSelect: 'none' }}>
      <div style={{ flex: 1, height: 1, background: 'var(--accent)' }} />
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent-text)', letterSpacing: '0.08em' }}>NEW</span>
    </div>
  )
}

/**
 * A system notice. Since 1.3 it can carry one action — the **Join** button on
 * a `board-live` row, for as long as that session is still running (the
 * decision is `boardJoinAction`, which the store's live-board registry feeds).
 * Rows without one look exactly as they always did.
 */
function SysRow({ line, action }: { line: string; action?: { label: string; entry: LiveBoardEntry } | null }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        textAlign: 'center',
        padding: '4px 24px',
        fontSize: 12,
        color: 'var(--text-3)',
      }}
    >
      <span>{line}</span>
      {action && (
        <button
          onClick={() => openLiveBoard(action.entry)}
          // "Join" on its own is every Join button in the log: the name has to
          // say which board, since a screen reader reads the button without the
          // sentence it sits next to.
          aria-label={`${action.label} the live board${action.entry.title ? `: ${action.entry.title}` : ''}`}
          title={`Join the live board${action.entry.title ? ` ${action.entry.title}` : ''}`}
          style={{
            height: 20,
            padding: '0 9px',
            borderRadius: 999,
            border: '1px solid color-mix(in srgb, var(--success) 55%, transparent)',
            background: 'color-mix(in srgb, var(--success) 14%, transparent)',
            color: 'var(--text-1)',
            fontSize: 11.5,
            fontWeight: 600,
            fontFamily: 'var(--font-ui)',
            cursor: 'pointer',
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}

function SkeletonRows() {
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', padding: '16px 16px 0' }} aria-label="Loading messages">
      {[72, 44, 58, 36, 64, 50].map((w, i) => (
        <div key={i} style={{ display: 'flex', gap: 12, marginBottom: 22 }}>
          <div className="sem-skel" style={{ width: 36, height: 36, borderRadius: 'var(--r-md)', flexShrink: 0 }} />
          <div style={{ flex: 1, paddingTop: 2 }}>
            <div className="sem-skel" style={{ width: '22%', height: 12, borderRadius: 4, marginBottom: 8 }} />
            <div className="sem-skel" style={{ width: `${w}%`, height: 12, borderRadius: 4 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

