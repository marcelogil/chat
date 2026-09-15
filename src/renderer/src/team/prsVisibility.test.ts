import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrState, PrStateKind, PrView } from '@shared/types'
import {
  applyVisibility,
  isToggleDisabled,
  readVisibility,
  seenKeys,
  toggleOverdue,
  toggleStale,
  visibilityNotes,
  writeHideOverdue,
  writeHideStale,
  writeVisibility,
} from './prsVisibility'
import type { PrsVisibility } from './prsVisibility'

// localStorage is a browser API and vitest runs in node, so the module's
// global is stubbed with the same shape drafts.test.ts uses.
class FakeStorage {
  map = new Map<string, string>()
  getItem(k: string): string | null {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v)
  }
  removeItem(k: string): void {
    this.map.delete(k)
  }
  get length(): number {
    return this.map.size
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null
  }
}

function state(overrides: Partial<PrState> & { kind: PrStateKind }): PrState {
  return {
    next: 'reviewers',
    nextIds: [],
    nextNames: [],
    since: 0,
    lastActivityAt: 0,
    lastPushAt: null,
    openThreads: 0,
    threadsKnown: true,
    stale: false,
    overdue: false,
    ...overrides,
  }
}

function pr(key: string, overrides: Partial<PrView> = {}): PrView {
  return {
    key,
    id: 1,
    title: `PR ${key}`,
    repoId: 'repo1',
    repoName: 'repo-one',
    author: { id: 'author1', name: 'Ann Author' },
    sourceBranch: 'feature',
    targetBranch: 'main',
    createdAt: 0,
    isDraft: false,
    reviewers: [],
    assignedToMe: false,
    myVote: 0,
    webUrl: 'https://example.test/pr',
    seen: true,
    ...overrides,
  }
}

const NONE: PrsVisibility = { hideOverdue: false, hideStale: false }

describe('applyVisibility', () => {
  it('returns every PR when neither toggle hides anything', () => {
    const list = [pr('a'), pr('b', { state: state({ kind: 'needs-review', overdue: true }) })]
    expect(applyVisibility(list, NONE)).toEqual(list)
  })

  it('hides every PR whose state.overdue is true, and only those', () => {
    const overdue = pr('a', { state: state({ kind: 'needs-review', overdue: true }) })
    const fine = pr('b', { state: state({ kind: 'needs-review', overdue: false }) })
    const result = applyVisibility([overdue, fine], { hideOverdue: true, hideStale: false })
    expect(result).toEqual([fine])
  })

  it('hides every PR whose state.stale is true — the whole stale bucket', () => {
    const stale = pr('a', { state: state({ kind: 'needs-review', stale: true }) })
    const fine = pr('b', { state: state({ kind: 'approved' }) })
    const result = applyVisibility([stale, fine], { hideOverdue: false, hideStale: true })
    expect(result).toEqual([fine])
  })

  it('hides a PR that is both overdue and stale under either toggle alone', () => {
    const both = pr('a', { state: state({ kind: 'needs-review', overdue: true, stale: true }) })
    expect(applyVisibility([both], { hideOverdue: true, hideStale: false })).toEqual([])
    expect(applyVisibility([both], { hideOverdue: false, hideStale: true })).toEqual([])
  })

  it('never hides a legacy PR with no state', () => {
    const legacy = pr('a')
    expect(applyVisibility([legacy], { hideOverdue: true, hideStale: true })).toEqual([legacy])
  })

  it('applies both toggles together', () => {
    const overdue = pr('a', { state: state({ kind: 'needs-review', overdue: true }) })
    const stale = pr('b', { state: state({ kind: 'needs-review', stale: true }) })
    const fine = pr('c', { state: state({ kind: 'approved' }) })
    const result = applyVisibility([overdue, stale, fine], { hideOverdue: true, hideStale: true })
    expect(result).toEqual([fine])
  })
})

describe('visibilityNotes', () => {
  it('is empty when neither toggle is on', () => {
    const list = [pr('a', { state: state({ kind: 'needs-review', overdue: true }) })]
    expect(visibilityNotes(list, NONE)).toEqual([])
  })

  it('is empty when a toggle is on but nothing matches it', () => {
    const list = [pr('a', { state: state({ kind: 'approved' }) })]
    expect(visibilityNotes(list, { hideOverdue: true, hideStale: true })).toEqual([])
  })

  it('reports the overdue count, counted from the pre-hide list, pluralized', () => {
    const list = [
      pr('a', { state: state({ kind: 'needs-review', overdue: true }) }),
      pr('b', { state: state({ kind: 'needs-review', overdue: true }) }),
    ]
    expect(visibilityNotes(list, { hideOverdue: true, hideStale: false })).toEqual([
      '2 overdue pull requests hidden — click the count to show them',
    ])
  })

  it('uses the singular for exactly one', () => {
    const list = [pr('a', { state: state({ kind: 'needs-review', overdue: true }) })]
    expect(visibilityNotes(list, { hideOverdue: true, hideStale: false })).toEqual([
      '1 overdue pull request hidden — click the count to show them',
    ])
  })

  it('reports stale separately, in header order (overdue, then stale)', () => {
    const list = [
      pr('a', { state: state({ kind: 'needs-review', overdue: true }) }),
      pr('b', { state: state({ kind: 'needs-review', stale: true }) }),
    ]
    expect(visibilityNotes(list, { hideOverdue: true, hideStale: true })).toEqual([
      '1 overdue pull request hidden — click the count to show them',
      '1 stale pull request hidden — click the count to show them',
    ])
  })
})

describe('isToggleDisabled', () => {
  it('is disabled at zero when not hidden — nothing to hide', () => {
    expect(isToggleDisabled(0, false)).toBe(true)
  })

  it('is enabled at zero while hidden — clicking is the only way back', () => {
    expect(isToggleDisabled(0, true)).toBe(false)
  })

  it('is enabled with a positive count, hidden or not', () => {
    expect(isToggleDisabled(1, false)).toBe(false)
    expect(isToggleDisabled(1, true)).toBe(false)
  })
})

describe('seenKeys', () => {
  it('keeps a hidden PR in the seen list — hiding must never strand the unseen badge', () => {
    const overdue = pr('a', { seen: false, state: state({ kind: 'needs-review', overdue: true }) })
    const fine = pr('b', { seen: false, state: state({ kind: 'needs-review' }) })
    const filtered = [overdue, fine]
    const hideOverdue: PrsVisibility = { hideOverdue: true, hideStale: false }

    // The row is gone from the list...
    expect(applyVisibility(filtered, hideOverdue)).toEqual([fine])
    // ...but markSeen is still told about it, so PrsStatus.unseen can reach 0
    // and the sidebar / dock badges clear.
    expect(seenKeys(filtered)).toEqual(['a', 'b'])
  })

  it('marks every key of the list it is given, in order, and nothing else', () => {
    expect(seenKeys([pr('b'), pr('a')])).toEqual(['b', 'a'])
    expect(seenKeys([])).toEqual([])
  })
})

describe('toggleOverdue / toggleStale', () => {
  it('flips exactly one flag and leaves the other alone', () => {
    expect(toggleOverdue(NONE)).toEqual({ hideOverdue: true, hideStale: false })
    expect(toggleStale(NONE)).toEqual({ hideOverdue: false, hideStale: true })
    expect(toggleOverdue({ hideOverdue: false, hideStale: true })).toEqual({ hideOverdue: true, hideStale: true })
  })

  it('applied twice is the identity — two clicks in one React batch net out', () => {
    for (const start of [NONE, { hideOverdue: true, hideStale: true }] as PrsVisibility[]) {
      expect(toggleOverdue(toggleOverdue(start))).toEqual(start)
      expect(toggleStale(toggleStale(start))).toEqual(start)
    }
  })

  it('does not mutate the state it is given', () => {
    const before: PrsVisibility = { hideOverdue: false, hideStale: false }
    toggleOverdue(before)
    toggleStale(before)
    expect(before).toEqual({ hideOverdue: false, hideStale: false })
  })
})

describe('per-device persistence', () => {
  let fake: FakeStorage

  beforeEach(() => {
    fake = new FakeStorage()
    vi.stubGlobal('localStorage', fake)
  })

  it('defaults both flags to false with nothing stored', () => {
    expect(readVisibility()).toEqual({ hideOverdue: false, hideStale: false })
  })

  it('round-trips hideOverdue independently of hideStale', () => {
    writeHideOverdue(true)
    expect(readVisibility()).toEqual({ hideOverdue: true, hideStale: false })
    writeHideStale(true)
    expect(readVisibility()).toEqual({ hideOverdue: true, hideStale: true })
    writeHideOverdue(false)
    expect(readVisibility()).toEqual({ hideOverdue: false, hideStale: true })
  })

  it('survives being read again — a fresh readVisibility() sees a prior write, like a restart would', () => {
    writeHideStale(true)
    // A brand-new call, exactly what a fresh app launch does.
    expect(readVisibility().hideStale).toBe(true)
  })

  it('writeVisibility stores the whole state, which is what the pane persists after a toggle', () => {
    // What PrsPane does: state through the pure reducers, then one write of
    // the result. Two toggles in a row land as the state the user can see.
    let v: PrsVisibility = readVisibility()
    v = toggleOverdue(v)
    writeVisibility(v)
    expect(readVisibility()).toEqual({ hideOverdue: true, hideStale: false })

    v = toggleOverdue(v) // and back again — the key is removed, not left at "0"
    writeVisibility(v)
    expect(readVisibility()).toEqual({ hideOverdue: false, hideStale: false })
    expect(fake.map.has('sem-prs-hide-overdue')).toBe(false)
  })

  it('does not throw when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(() => readVisibility()).not.toThrow()
    expect(readVisibility()).toEqual({ hideOverdue: false, hideStale: false })
    expect(() => writeHideOverdue(true)).not.toThrow()
  })
})
