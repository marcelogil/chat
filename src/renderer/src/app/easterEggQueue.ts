// Message easter eggs (1.5): when an animation is allowed to play.
//
// Detection (shared/easterEggs.ts) answers *what*; this answers *whether*, and
// it is the half that keeps the joke from becoming a nuisance:
//
//   - once per message id, ever — persisted, so re-reading a channel tomorrow
//     is silent (the cap keeps the key small; 500 ids is far more than a
//     working week of eggs);
//   - only for something you could have reacted to: a message you just sent,
//     one that arrived live while you had the app open, or one that was already
//     unread when you opened the conversation. Scrolling back through history
//     never plays anything;
//   - never for a message older than a day, whatever the above says — a cold
//     start that ingests a week of backlog should not throw a party;
//   - at most one every 8 s. Extra triggers *collapse*: they are marked seen
//     and dropped, not queued, so a burst of five "congrats" in a row is one
//     confetti fall rather than forty seconds of them.
//
// Nothing here touches the DOM, so all of it is testable in the node suite.
// The only impure corner is the localStorage mirror of `seen` at the bottom,
// which is wrapped the same way the update banner's is.

import type { EasterEgg } from '@shared/easterEggs'

/** Older than this and no animation plays, however it arrived. */
export const EGG_MAX_AGE_MS = 24 * 60 * 60 * 1000
/**
 * Minimum spacing between two animations. Longer than the longest animation
 * (the bug's 3 s run), which is what makes "at most one at a time" fall out of
 * the same rule — nothing can still be on screen when the next one is allowed.
 */
export const EGG_MIN_GAP_MS = 8_000
/** How many played message ids the localStorage mirror keeps (oldest dropped). */
export const EGG_SEEN_CAP = 500
export const EGG_SEEN_KEY = 'easter-eggs-seen'

export interface EggCandidate {
  /** The message's event stem. */
  id: string
  egg: EasterEgg
  /** Share-clock ms the message carries (its stem's HLC millisecond). */
  ms: number
  /** This device wrote it — the sender always gets the animation. */
  mine: boolean
  /** The event arrived over the push during this session. */
  live: boolean
  /** It was already past my read mark when the conversation was opened. */
  unreadAtOpen: boolean
}

export interface EggQueueState {
  /** Played (or collapsed) message ids, oldest first. */
  seen: readonly string[]
  /** Local-clock ms of the last animation that started; 0 = none yet. */
  lastPlayAt: number
}

export interface EggEnv {
  now: number
  /** SettingsView.easterEggs, with absent meaning on. */
  enabled: boolean
  /** The OS asked for less movement — the whole feature is off. */
  reducedMotion: boolean
}

export const EMPTY_EGG_STATE: EggQueueState = { seen: [], lastPlayAt: 0 }

/**
 * 'play' — start this animation now. 'collapse' — it qualified but something
 * else is holding the 8 s window, so it is spent without being shown.
 * 'skip' — it never qualified, and nothing is remembered about it (a message
 * scrolled past in history must not spend one of the 500 slots).
 */
export type EggOutcome = 'play' | 'collapse' | 'skip'

/**
 * 1.5.x — Settings → Appearance's "Play them anyway", offered only while the
 * OS is actually asking for reduced motion. The override only ever turns
 * `considerEgg`'s hard-off *off*: an OS that isn't asking for reduced motion
 * in the first place is untouched by the setting either way. Pulled out as
 * its own pure function (rather than composed inline where `offerEgg` is
 * called, in EasterEggFeed.tsx) so the rule is testable in the node suite —
 * the same reasoning `eggEligibility.ts` is a module of its own.
 */
export function effectiveReducedMotion(osReducedMotion: boolean, ignoreReducedMotion: boolean): boolean {
  return osReducedMotion && !ignoreReducedMotion
}

export function rememberSeen(seen: readonly string[], id: string): readonly string[] {
  if (seen.includes(id)) return seen
  const next = [...seen, id]
  return next.length > EGG_SEEN_CAP ? next.slice(next.length - EGG_SEEN_CAP) : next
}

export function considerEgg(
  state: EggQueueState,
  cand: EggCandidate,
  env: EggEnv,
): { state: EggQueueState; outcome: EggOutcome; play: EasterEgg | null } {
  const skip = { state, outcome: 'skip' as const, play: null }
  if (!env.enabled || env.reducedMotion) return skip
  if (state.seen.includes(cand.id)) return skip
  // Eligibility, then age. Order matters only for the cap: an ineligible
  // message must not be remembered, and neither must an ancient one.
  if (!cand.mine && !cand.live && !cand.unreadAtOpen) return skip
  if (env.now - cand.ms > EGG_MAX_AGE_MS) return skip

  const seen = rememberSeen(state.seen, cand.id)
  if (env.now - state.lastPlayAt < EGG_MIN_GAP_MS) {
    return { state: { ...state, seen }, outcome: 'collapse', play: null }
  }
  return { state: { seen, lastPlayAt: env.now }, outcome: 'play', play: cand.egg }
}

// ---------------------------------------------------------------------------
// The one live instance, plus its localStorage mirror.

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null // private mode / blocked storage
  }
}

export function loadSeen(): readonly string[] {
  try {
    const raw = storage()?.getItem(EGG_SEEN_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const ids = parsed.filter((v): v is string => typeof v === 'string')
    return ids.length > EGG_SEEN_CAP ? ids.slice(ids.length - EGG_SEEN_CAP) : ids
  } catch {
    return [] // corrupt value — worst case somebody sees one egg twice
  }
}

export function saveSeen(seen: readonly string[]): void {
  try {
    storage()?.setItem(EGG_SEEN_KEY, JSON.stringify(seen))
  } catch {
    // quota / private mode — the in-session state still holds
  }
}

let live: EggQueueState | null = null

/**
 * Offer one message to the queue; returns the animation to start, or null.
 * Loads the persisted ids on first use, and writes them back whenever the set
 * actually grows.
 */
export function offerEgg(cand: EggCandidate, env: EggEnv): EasterEgg | null {
  if (live === null) live = { seen: loadSeen(), lastPlayAt: 0 }
  const r = considerEgg(live, cand, env)
  const grew = r.state.seen !== live.seen
  live = r.state
  if (grew) saveSeen(live.seen)
  return r.play
}

/** Tests only: forget the session's queue (and optionally seed it). */
export function resetEggQueue(state: EggQueueState | null = null): void {
  live = state
}
