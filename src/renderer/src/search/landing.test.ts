import { describe, expect, it } from 'vitest'
import {
  JUMP_SETTLE_MS,
  LANDING_INSIDE_FRAMES,
  LANDING_MAX_FRAMES,
  LANDING_TOLERANCE_PX,
  isInside,
  newLanding,
  nextLandingStep,
} from './landing'

// Proving a jump landed (1.6.1). The bug these rules exist for: one
// scrollToIndex into a list that is still measuring itself lands short, and
// nothing ever noticed.

const scroller = { top: 100, bottom: 500 }

describe('isInside', () => {
  it('accepts a row sitting wholly within the scroller', () => {
    expect(isInside({ top: 200, bottom: 260 }, scroller)).toBe(true)
  })

  it('rejects a row scrolled off the top or the bottom', () => {
    expect(isInside({ top: 40, bottom: 90 }, scroller)).toBe(false)
    expect(isInside({ top: 520, bottom: 580 }, scroller)).toBe(false)
  })

  it('rejects a row that is only half on screen — the landing is not finished', () => {
    expect(isInside({ top: 80, bottom: 140 }, scroller)).toBe(false)
    expect(isInside({ top: 460, bottom: 540 }, scroller)).toBe(false)
  })

  it('forgives sub-pixel overhang, and only sub-pixel', () => {
    expect(isInside({ top: 100 - LANDING_TOLERANCE_PX, bottom: 500 + LANDING_TOLERANCE_PX }, scroller)).toBe(true)
    expect(isInside({ top: 98.5, bottom: 200 }, scroller)).toBe(true)
    expect(isInside({ top: 90, bottom: 200 }, scroller)).toBe(false)
  })

  it('takes a row taller than the viewport as landed once it covers it', () => {
    // A big diagram tile cannot fit; centred on it, it fills the scroller.
    expect(isInside({ top: 40, bottom: 900 }, scroller)).toBe(true)
    // Covering only the top half is still a half-landed jump.
    expect(isInside({ top: -400, bottom: 300 }, scroller)).toBe(false)
  })

  it('honours an explicit tolerance', () => {
    expect(isInside({ top: 90, bottom: 200 }, scroller, 12)).toBe(true)
  })
})

describe('nextLandingStep', () => {
  it('retries while the row is outside, and never counts a streak', () => {
    let s = newLanding()
    for (let i = 0; i < 5; i++) {
      const step = nextLandingStep(s, false)
      expect(step.action).toBe('retry')
      expect(step.state.insideStreak).toBe(0)
      s = step.state
    }
    expect(s.attempts).toBe(5)
  })

  it('is not satisfied by a single inside frame', () => {
    const step = nextLandingStep(newLanding(), true)
    expect(step.action).toBe('retry')
    expect(step.state.insideStreak).toBe(1)
  })

  it('stops after the row has been inside on consecutive frames', () => {
    let s = newLanding()
    let action = ''
    for (let i = 0; i < LANDING_INSIDE_FRAMES; i++) {
      const step = nextLandingStep(s, true)
      s = step.state
      action = step.action
    }
    expect(action).toBe('done')
    expect(LANDING_INSIDE_FRAMES).toBeGreaterThan(1)
  })

  it('resets the streak when the row slips back out — virtuoso is still moving rows', () => {
    const one = nextLandingStep(newLanding(), true)
    const out = nextLandingStep(one.state, false)
    expect(out.state.insideStreak).toBe(0)
    expect(out.action).toBe('retry')
    expect(nextLandingStep(out.state, true).action).toBe('retry')
  })

  it('gives up once the budget is spent, and not before', () => {
    let s = newLanding()
    for (let i = 0; i < LANDING_MAX_FRAMES - 1; i++) {
      const step = nextLandingStep(s, false)
      expect(step.action).toBe('retry')
      s = step.state
    }
    expect(nextLandingStep(s, false).action).toBe('give-up')
  })

  it('calls the last frame a landing when it completes the streak', () => {
    // The frame that both finishes the streak and exhausts the budget is a
    // success: giving up on it would drop a jump that had just arrived.
    let s = newLanding()
    for (let i = 0; i < LANDING_MAX_FRAMES - LANDING_INSIDE_FRAMES; i++) s = nextLandingStep(s, false).state
    for (let i = 0; i < LANDING_INSIDE_FRAMES - 1; i++) s = nextLandingStep(s, true).state
    const last = nextLandingStep(s, true)
    expect(last.state.attempts).toBe(LANDING_MAX_FRAMES)
    expect(last.action).toBe('done')
  })
})

describe('the settle window', () => {
  it('outlasts a frame or two of list churn', () => {
    // Virtuoso's at-bottom belief is a debounced stream, and while it is
    // unsettled any change to `items` (a peer's message arriving right behind
    // the jump) reads to followOutput as new output and snaps to the bottom.
    // The window has to outlast that, which is React state plus a poll, not a
    // frame.
    expect(JUMP_SETTLE_MS).toBeGreaterThanOrEqual(1000)
  })
})
