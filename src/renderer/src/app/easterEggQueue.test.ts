import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EGG_MAX_AGE_MS,
  EGG_MIN_GAP_MS,
  EGG_SEEN_CAP,
  EGG_SEEN_KEY,
  EMPTY_EGG_STATE,
  considerEgg,
  effectiveReducedMotion,
  loadSeen,
  offerEgg,
  rememberSeen,
  resetEggQueue,
  saveSeen,
  type EggCandidate,
  type EggEnv,
  type EggQueueState,
} from './easterEggQueue'

// The rules that decide whether an animation is a delight or a nuisance. The
// component around them only knows how to draw an insect.

const NOW = 1_700_000_000_000

const env = (over: Partial<EggEnv> = {}): EggEnv => ({
  now: NOW,
  enabled: true,
  reducedMotion: false,
  ...over,
})

const cand = (over: Partial<EggCandidate> = {}): EggCandidate => ({
  id: '1700000000000-aaa',
  egg: 'bug',
  ms: NOW - 1_000,
  mine: false,
  live: true,
  unreadAtOpen: false,
  ...over,
})

describe('considerEgg — eligibility', () => {
  it('plays for a message that arrived live this session', () => {
    const r = considerEgg(EMPTY_EGG_STATE, cand(), env())
    expect(r.outcome).toBe('play')
    expect(r.play).toBe('bug')
    expect(r.state.lastPlayAt).toBe(NOW)
    expect(r.state.seen).toEqual(['1700000000000-aaa'])
  })

  it('plays for my own message the moment it comes back', () => {
    const r = considerEgg(EMPTY_EGG_STATE, cand({ mine: true, live: false, egg: 'confetti' }), env())
    expect(r.play).toBe('confetti')
  })

  it('plays for a message that was unread when the conversation opened', () => {
    expect(considerEgg(EMPTY_EGG_STATE, cand({ live: false, unreadAtOpen: true }), env()).outcome).toBe('play')
  })

  // Scrolling back through a channel is the common case, and it has to be
  // silent — otherwise every trip through history is a parade.
  it('stays silent for old history scrolled back into view, and remembers nothing about it', () => {
    const r = considerEgg(EMPTY_EGG_STATE, cand({ live: false, unreadAtOpen: false }), env())
    expect(r.outcome).toBe('skip')
    expect(r.state).toBe(EMPTY_EGG_STATE)
    expect(r.state.seen).toEqual([])
  })

  it('never plays for a message older than a day, however it arrived', () => {
    const old = cand({ ms: NOW - EGG_MAX_AGE_MS - 1, live: true, mine: true })
    const r = considerEgg(EMPTY_EGG_STATE, old, env())
    expect(r.outcome).toBe('skip')
    // A day-old backlog must not spend the 500 remembered slots either.
    expect(r.state.seen).toEqual([])
  })

  it('still plays right on the 24 h edge', () => {
    expect(considerEgg(EMPTY_EGG_STATE, cand({ ms: NOW - EGG_MAX_AGE_MS }), env()).outcome).toBe('play')
  })

  it('tolerates a share clock running slightly ahead of this machine', () => {
    expect(considerEgg(EMPTY_EGG_STATE, cand({ ms: NOW + 4_000 }), env()).outcome).toBe('play')
  })
})

describe('considerEgg — off switches', () => {
  it('does nothing when the setting is off', () => {
    const r = considerEgg(EMPTY_EGG_STATE, cand(), env({ enabled: false }))
    expect(r.outcome).toBe('skip')
    // Deliberately not remembered: turning the setting back on should not have
    // silently burned the ids that went past while it was off.
    expect(r.state.seen).toEqual([])
  })

  it('does nothing when the OS asked for reduced motion', () => {
    expect(considerEgg(EMPTY_EGG_STATE, cand(), env({ reducedMotion: true })).outcome).toBe('skip')
  })
})

describe('effectiveReducedMotion — "Play them anyway"', () => {
  it('is the OS value when the override is off', () => {
    expect(effectiveReducedMotion(true, false)).toBe(true)
    expect(effectiveReducedMotion(false, false)).toBe(false)
  })

  it('the override cancels reduced motion when the OS is asking for it', () => {
    expect(effectiveReducedMotion(true, true)).toBe(false)
  })

  it('the override does nothing when the OS was never asking for it', () => {
    expect(effectiveReducedMotion(false, true)).toBe(false)
  })

  it('feeds straight into considerEgg: overridden, a candidate plays', () => {
    const reducedMotion = effectiveReducedMotion(true, true)
    const r = considerEgg(EMPTY_EGG_STATE, cand(), env({ reducedMotion }))
    expect(r.outcome).toBe('play')
  })

  it('feeds straight into considerEgg: not overridden, a candidate is skipped', () => {
    const reducedMotion = effectiveReducedMotion(true, false)
    const r = considerEgg(EMPTY_EGG_STATE, cand(), env({ reducedMotion }))
    expect(r.outcome).toBe('skip')
  })
})

describe('considerEgg — once per message', () => {
  it('refuses a message id it has already played', () => {
    const played: EggQueueState = { seen: ['1700000000000-aaa'], lastPlayAt: 0 }
    const r = considerEgg(played, cand(), env())
    expect(r.outcome).toBe('skip')
    expect(r.state).toBe(played)
  })
})

describe('considerEgg — throttle', () => {
  it('collapses a second trigger inside the 8 s window, spending the id', () => {
    const first = considerEgg(EMPTY_EGG_STATE, cand({ id: 'a' }), env())
    const second = considerEgg(first.state, cand({ id: 'b', egg: 'confetti' }), env({ now: NOW + 1_000 }))
    expect(second.outcome).toBe('collapse')
    expect(second.play).toBeNull()
    expect(second.state.seen).toEqual(['a', 'b'])
    // The window still runs from the animation that actually played.
    expect(second.state.lastPlayAt).toBe(NOW)
  })

  it('a collapsed message does not come back later', () => {
    const first = considerEgg(EMPTY_EGG_STATE, cand({ id: 'a' }), env())
    const second = considerEgg(first.state, cand({ id: 'b' }), env({ now: NOW + 1_000 }))
    const retry = considerEgg(second.state, cand({ id: 'b' }), env({ now: NOW + 60_000 }))
    expect(retry.outcome).toBe('skip')
  })

  it('plays again once the window has passed', () => {
    const first = considerEgg(EMPTY_EGG_STATE, cand({ id: 'a' }), env())
    const later = considerEgg(first.state, cand({ id: 'b' }), env({ now: NOW + EGG_MIN_GAP_MS }))
    expect(later.outcome).toBe('play')
    expect(later.state.lastPlayAt).toBe(NOW + EGG_MIN_GAP_MS)
  })

  // Five "congrats" in a row (a release day) is one fall of confetti.
  it('collapses a burst down to a single animation', () => {
    let state = EMPTY_EGG_STATE
    let plays = 0
    for (let i = 0; i < 5; i++) {
      const r = considerEgg(state, cand({ id: `m${i}`, egg: 'confetti' }), env({ now: NOW + i * 200 }))
      state = r.state
      if (r.play) plays++
    }
    expect(plays).toBe(1)
    expect(state.seen.length).toBe(5)
  })
})

describe('rememberSeen', () => {
  it('appends and de-duplicates', () => {
    expect(rememberSeen(['a'], 'b')).toEqual(['a', 'b'])
    const same = ['a', 'b']
    expect(rememberSeen(same, 'b')).toBe(same)
  })

  it('caps the list, dropping the oldest ids', () => {
    const full = Array.from({ length: EGG_SEEN_CAP }, (_, i) => `id${i}`)
    const next = rememberSeen(full, 'newest')
    expect(next.length).toBe(EGG_SEEN_CAP)
    expect(next[0]).toBe('id1')
    expect(next[next.length - 1]).toBe('newest')
  })
})

// --------------------------------------------------------------------------

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string): string | null {
    return this.m.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v)
  }
  removeItem(k: string): void {
    this.m.delete(k)
  }
  clear(): void {
    this.m.clear()
  }
  key(): string | null {
    return null
  }
  get length(): number {
    return this.m.size
  }
}

const g = globalThis as { localStorage?: unknown }

beforeEach(() => {
  g.localStorage = new MemStorage() as unknown as Storage
  resetEggQueue()
})

afterEach(() => {
  delete g.localStorage
  resetEggQueue()
})

describe('the persisted half', () => {
  it('survives a restart: an id played yesterday plays nothing today', () => {
    expect(offerEgg(cand({ id: 'x' }), env())).toBe('bug')
    expect(JSON.parse(localStorage.getItem(EGG_SEEN_KEY) ?? '[]')).toEqual(['x'])
    resetEggQueue() // a fresh launch, same profile
    expect(offerEgg(cand({ id: 'x' }), env({ now: NOW + 86_400_000 / 2 }))).toBeNull()
  })

  it('reads a capped list back and shrugs off a corrupt one', () => {
    saveSeen(['a', 'b'])
    expect(loadSeen()).toEqual(['a', 'b'])
    localStorage.setItem(EGG_SEEN_KEY, '{ not json')
    expect(loadSeen()).toEqual([])
    localStorage.setItem(EGG_SEEN_KEY, JSON.stringify(Array.from({ length: 900 }, (_, i) => `id${i}`)))
    expect(loadSeen().length).toBe(EGG_SEEN_CAP)
  })

  it('works with no storage at all (blocked or private mode)', () => {
    delete g.localStorage
    resetEggQueue()
    expect(offerEgg(cand({ id: 'y' }), env())).toBe('bug')
    expect(offerEgg(cand({ id: 'y' }), env({ now: NOW + 60_000 }))).toBeNull()
  })
})
