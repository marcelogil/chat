// What the Live pill says about the session, in words a tester can act on.
//
// 1.4, tester feedback: "I can't … see if it's live with other team mates and
// if they can see the changes in real time". The pill already listed who was on
// the board; what it never said was whether anything was actually travelling.
// These four states are derived from facts the hook already has — when a frame
// of ours was last accepted, when a peer's frame last landed, whether a write
// is in flight — plus the share's own reachability.
//
// Pure, so the timings are testable without a canvas or a folder.

export type LiveSync = 'synced' | 'sending' | 'waiting' | 'reconnecting'

export interface LiveSyncStats {
  /** `Date.now()` when a write of ours was last accepted by main; 0 = never. */
  sentAt: number
  /** `Date.now()` when a peer's frame was last applied to this canvas; 0 = never. */
  recvAt: number
  /** `Date.now()` of the oldest write still in flight, or null when none is. */
  pendingSince: number | null
  /** Everyone else whose frame is still fresh (the pill's own roster). */
  peers: number
  /** `store.health.reachable` — is the share answering at all? */
  reachable: boolean
}

/** A frame in either direction this recently and the board is demonstrably live. */
export const SYNCED_MS = 5_000

/**
 * Silence longer than this, while somebody else is on the board, means the
 * poll is not coming back: every participant republishes its last frame every
 * `BOARD.keepaliveMs` (10 s), so a live peer cannot be quiet for 15 s.
 */
export const RECONNECT_MS = 15_000

/**
 * The pill's sync state. Ordered worst-news-first: a share that is not
 * answering outranks a pending write, which outranks an empty room.
 */
export function liveSyncState(s: LiveSyncStats, now: number): LiveSync {
  if (!s.reachable) return 'reconnecting'
  // `peers > 0` is the guard that keeps this honest: once everybody has left,
  // their frames stop arriving for a good reason, and `pruneParticipants` has
  // already emptied the roster by then.
  if (s.peers > 0 && s.recvAt > 0 && now - s.recvAt > RECONNECT_MS) return 'reconnecting'
  if (s.pendingSince !== null) return 'sending'
  if (s.peers === 0) return 'waiting'
  // Traffic inside SYNCED_MS is direct proof. Past that the keepalive above is
  // what makes "Synced" true rather than hopeful — anything longer than
  // RECONNECT_MS has already been caught.
  return 'synced'
}

const LABELS: Record<LiveSync, string> = {
  synced: 'Synced',
  sending: 'Sending…',
  waiting: 'Waiting for teammates',
  reconnecting: 'Reconnecting…',
}

/** The words shown in the pill — and, verbatim, the tail of its `aria-label`. */
export function liveStatusLabel(s: LiveSyncStats, now: number): string {
  return LABELS[liveSyncState(s, now)]
}

/**
 * The whole pill as one sentence. `[role="status"][aria-label^="Live board"]`
 * is what the E2E reads and what a screen reader announces when the roster or
 * the sync state changes, so the prefix is load-bearing — don't reword it.
 */
export function liveAriaLabel(names: readonly string[], s: LiveSyncStats, now: number): string {
  const who = names.length ? `drawing with ${names.join(', ')}` : 'nobody else has joined yet'
  return `Live board, ${who}, ${liveStatusLabel(s, now)}`
}

/** The same sentence as a tooltip, with the "what this means" half spelled out. */
export function liveTitle(names: readonly string[], s: LiveSyncStats, now: number): string {
  const state = liveSyncState(s, now)
  const who = names.length
    ? `drawing with ${names.join(', ')}`
    : 'nobody else is here yet — they can join from the message in the conversation'
  const why: Record<LiveSync, string> = {
    synced: 'Everyone on this board is seeing your changes within about a second.',
    sending: 'Your latest change is on its way to the shared folder.',
    waiting: 'Your changes are published — they will show up for anyone who joins.',
    reconnecting: 'The shared folder has stopped answering. Your work is safe; it will catch up.',
  }
  return `Live board · ${who}\n${why[state]}`
}
