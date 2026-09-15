// Message easter eggs (1.5): the third pure piece — turning "what this pane
// knows about a row" into the candidate the queue judges.
//
// It used to be three expressions inlined in EasterEggFeed.tsx, which is
// exactly where a rule nobody can run a test against goes to rot: the node
// suite cannot load a .tsx, so the one part of the feature that decides
// *whether a reader ever sees anything* had no coverage at all. It lives here
// now, and the component does nothing but supply the three facts.
//
// The two subtleties, both of which cost a real bug once:
//
//   - **"Never read" means everything in it is unread.** A conversation with
//     no read cursor — nobody has ever opened it, or it was opened while still
//     empty (there is no newest message to mark) — reports `''`. Comparing
//     `id > ''` is true for every id, but the NEW divider deliberately refuses
//     to draw in that case (a first visit should not be a wall of NEW), and
//     copying that refusal here made every message in a conversation you had
//     never opened permanently silent: `live` cannot save it (see below), so
//     the DM where somebody wished you happy birthday stayed quiet forever.
//     The divider's silence is a layout choice; eligibility is not.
//   - **The pane's baseline is not "live".** `loadTeam` prefetches every log at
//     boot, so what the log holds when a pane opens already includes whatever
//     arrived while you were looking at another conversation. Real liveness is
//     recorded where it is still knowable, at the push (store/liveEvents.ts);
//     the baseline stays as a second opinion for the one case the registry
//     cannot cover — a log still loading, where nothing is history yet.
//
// The 24 h ceiling, the once-per-id rule and the throttle all live in
// easterEggQueue.ts; nothing here decides whether an animation plays, only
// whether this message is the kind of message that could.

import type { EasterEgg } from '@shared/easterEggs'
import type { EggCandidate } from '@/app/easterEggQueue'

/** A row the detector recognised, as the pane sees it. */
export interface EggSighting {
  /** The message's event stem. */
  id: string
  egg: EasterEgg
  /** Share-clock ms (the stem's HLC millisecond). */
  ms: number
  /** `MessageView.authorDevice`. */
  author: string
}

/** What the reader's pane knows about itself. */
export interface EggViewer {
  /** This device's id ('' before boot is ready — then nothing is "mine"). */
  selfId: string
  /** My read mark for this conversation as it stood when it opened; '' = never read. */
  anchorRead: string
  /**
   * The ids the conversation's log already held when the pane opened, or null
   * while the log is still loading (nothing can be called history yet).
   */
  baseline: ReadonlySet<string> | null
  /** Did this event arrive over the push during this session? */
  arrivedLive: (id: string) => boolean
}

export function eggCandidate(row: EggSighting, v: EggViewer): EggCandidate {
  return {
    id: row.id,
    egg: row.egg,
    ms: row.ms,
    mine: v.selfId !== '' && row.author === v.selfId,
    live: v.arrivedLive(row.id) || v.baseline === null || !v.baseline.has(row.id),
    unreadAtOpen: v.anchorRead === '' || row.id > v.anchorRead,
  }
}
