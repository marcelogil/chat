// Landing a jump (1.6.1). `jump.ts` decides *whether* to jump; this decides
// when a jump has actually arrived.
//
// Why any of this is needed: a virtualized list does not scroll where it is
// told on the first try. Virtuoso measures the rows it has just been handed
// over several animation frames, so a single `scrollToIndex` issued while the
// list is still sizing itself lands short — and the row it aimed at keeps
// moving underneath as the rows above it are measured. 1.6.0 asked once, one
// frame after the request, and the person watched the list settle somewhere
// else entirely.
//
// So the list asks, then *checks*: every frame, compare the target row's rect
// with the scroller's, re-ask when it is outside, and stop only when it has
// stayed inside across consecutive frames. All of that judgement lives here,
// with no DOM in sight — MessageList supplies the two rects and wires the
// frame loop.

/** The vertical half of a `DOMRect` — all these rules ever look at. */
export interface EdgeRect {
  top: number
  bottom: number
}

/**
 * Sub-pixel slack. Row and scroller rects are fractional (zoom, device pixel
 * ratio, a border), and a landing that is off by a third of a pixel is a
 * landing — without the tolerance the loop would re-scroll forever and only
 * ever stop by running out of budget.
 */
export const LANDING_TOLERANCE_PX = 2

/**
 * How many consecutive frames the row has to be inside before we believe it.
 * One frame is not proof: virtuoso can have the row in the right place on the
 * frame it is measured and shift it on the next one, as the rows above it get
 * their real heights.
 */
export const LANDING_INSIDE_FRAMES = 2

/**
 * The attempt budget, in frames rather than milliseconds: frames are the unit
 * the loop actually gets to measure in, so a display that paints faster gets
 * its chances faster rather than fewer. ~1.5 s at 60 Hz.
 */
export const LANDING_MAX_FRAMES = 90

/**
 * How long followOutput stays off after a jump lands. Nothing about the
 * landing itself needs it; what needs it is virtuoso's own at-bottom belief,
 * which is not settled the frame the row arrives (it is a debounced stream).
 * While it is unsettled, *any* change to `items` — a peer's message landing a
 * beat after the jump, an edit folding in — reads to `followOutput` as "new
 * output, scroll to the end", and that snap is what put the person back at the
 * bottom right after a jump that had landed correctly.
 *
 * Not the unread divider, which is the story this comment used to tell: that
 * row comes from `anchorRead`, and ChatPane captures it once per conversation
 * and holds it while the conversation stays open, so nothing the list does
 * mid-session can add or remove it. Marking read at mount was a real bug, but
 * a different one (it published a read cursor for messages nobody had seen);
 * it is fixed in MessageList's markRead effect, not here.
 */
export const JUMP_SETTLE_MS = 1500

/**
 * Is the row fully within the scroller's viewport?
 *
 * A row taller than the viewport can never be "fully inside" by the plain
 * reading, so it is landed when it *covers* the viewport instead — otherwise
 * one very tall message (a big diagram tile) would burn the whole budget and
 * report a failure that is not one.
 */
export function isInside(row: EdgeRect, scroller: EdgeRect, tolerancePx = LANDING_TOLERANCE_PX): boolean {
  if (row.top >= scroller.top - tolerancePx && row.bottom <= scroller.bottom + tolerancePx) return true
  if (row.bottom - row.top > scroller.bottom - scroller.top) {
    return row.top <= scroller.top + tolerancePx && row.bottom >= scroller.bottom - tolerancePx
  }
  return false
}

export interface LandingState {
  /** Frames measured so far, budget included. */
  attempts: number
  /** Consecutive frames the row has been fully inside. */
  insideStreak: number
}

export type LandingAction =
  /** Keep the frame loop running (and re-ask, if the row was outside). */
  | 'retry'
  /** It is there, and it stayed there. Stop. */
  | 'done'
  /** Out of budget. Stop quietly — a jump that half-landed beats a busy loop. */
  | 'give-up'

export const newLanding = (): LandingState => ({ attempts: 0, insideStreak: 0 })

/**
 * One frame's worth of progress. `insideNow` is false for a row that is not on
 * screen *and* for a row that is not in the DOM at all — a row virtuoso has
 * not rendered yet is exactly as un-landed as one that is scrolled past.
 */
export function nextLandingStep(
  state: LandingState,
  insideNow: boolean,
): { state: LandingState; action: LandingAction } {
  const next: LandingState = {
    attempts: state.attempts + 1,
    insideStreak: insideNow ? state.insideStreak + 1 : 0,
  }
  // Success is checked first: the frame that both completes the streak and
  // exhausts the budget is a landing, not a timeout.
  if (next.insideStreak >= LANDING_INSIDE_FRAMES) return { state: next, action: 'done' }
  if (next.attempts >= LANDING_MAX_FRAMES) return { state: next, action: 'give-up' }
  return { state: next, action: 'retry' }
}
