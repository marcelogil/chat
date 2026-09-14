import { describe, expect, it } from 'vitest'
import type { PrState, PrStateKind, PrView } from '@shared/types'
import { computePrState } from '@shared/prState'
import { GROUP_LABELS, groupPrs, nextLine, waitLabel, waitTone } from './prsGroups'
import type { PrsThresholds } from './prsGroups'

const THRESHOLDS: PrsThresholds = { reviewSlaHours: 48, staleAfterDays: 14 }
const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 8, 14, 12, 0, 0)

function state(overrides: Partial<PrState> & { kind: PrStateKind }): PrState {
  return {
    next: 'reviewers',
    nextIds: [],
    nextNames: [],
    since: NOW - 3 * DAY,
    lastActivityAt: NOW - 3 * DAY,
    lastPushAt: NOW - 3 * DAY,
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
    createdAt: NOW - 5 * DAY,
    isDraft: false,
    reviewers: [],
    assignedToMe: false,
    myVote: 0,
    webUrl: 'https://example.test/pr',
    seen: true,
    ...overrides,
  }
}

describe('groupPrs', () => {
  it('groups a PR where I am a blocking reviewer into attention, not review', () => {
    const p = pr('r:1', { state: state({ kind: 'needs-review', nextIds: ['me'], nextNames: ['Me'] }) })
    const groups = groupPrs([p], 'me', NOW)
    expect(groups.map((g) => g.key)).toEqual(['attention'])
    expect(groups[0].prs).toEqual([p])
  })

  it('groups a PR where I am the author and next is author into attention', () => {
    const p = pr('r:2', {
      author: { id: 'me', name: 'Me' },
      state: state({ kind: 'comments-open', next: 'author', nextIds: [], nextNames: ['Me'] }),
    })
    const groups = groupPrs([p], 'me', NOW)
    expect(groups.map((g) => g.key)).toEqual(['attention'])
  })

  it('does not treat me as next just because I authored a PR waiting on reviewers', () => {
    const p = pr('r:2b', {
      author: { id: 'me', name: 'Me' },
      state: state({ kind: 'needs-review', next: 'reviewers', nextIds: ['other'], nextNames: ['Other'] }),
    })
    const groups = groupPrs([p], 'me', NOW)
    expect(groups.map((g) => g.key)).toEqual(['review'])
  })

  it('groups needs-review PRs that do not block me into review', () => {
    const p = pr('r:3', { state: state({ kind: 'needs-review', nextIds: ['other'], nextNames: ['Other'] }) })
    const groups = groupPrs([p], 'me', NOW)
    expect(groups.map((g) => g.key)).toEqual(['review'])
  })

  it('groups changes-requested and comments-open together under author', () => {
    const a = pr('r:4', {
      state: state({ kind: 'changes-requested', next: 'author', nextIds: ['other-author'], since: NOW - 2 * DAY }),
    })
    const b = pr('r:5', {
      state: state({ kind: 'comments-open', next: 'author', nextIds: ['other-author'], since: NOW - 1 * DAY }),
    })
    const groups = groupPrs([a, b], 'me', NOW)
    expect(groups.map((g) => g.key)).toEqual(['author'])
    // Longest wait first: r:4 has waited longer (since is further in the past).
    expect(groups[0].prs.map((p) => p.key)).toEqual(['r:4', 'r:5'])
  })

  it('groups author-replied into replied', () => {
    const p = pr('r:6', { state: state({ kind: 'author-replied', next: 'reviewers', nextIds: ['other'] }) })
    const groups = groupPrs([p], 'me', NOW)
    expect(groups.map((g) => g.key)).toEqual(['replied'])
  })

  it('groups approved into complete', () => {
    const p = pr('r:7', { state: state({ kind: 'approved', next: 'author', nextIds: ['other-author'] }) })
    const groups = groupPrs([p], 'me', NOW)
    expect(groups.map((g) => g.key)).toEqual(['complete'])
  })

  it('pulls a stale PR out of attention into stale', () => {
    const p = pr('r:8', { state: state({ kind: 'needs-review', nextIds: ['me'], stale: true }) })
    const groups = groupPrs([p], 'me', NOW)
    expect(groups.map((g) => g.key)).toEqual(['stale'])
  })

  it('pulls a stale approved PR out of complete into stale', () => {
    const p = pr('r:9', { state: state({ kind: 'approved', next: 'author', nextIds: ['other-author'], stale: true }) })
    const groups = groupPrs([p], 'me', NOW)
    expect(groups.map((g) => g.key)).toEqual(['stale'])
  })

  it('leaves the stale group empty on a server that cannot serve threads', () => {
    // The real thing end to end, because this is the bug that emptied the
    // other five groups: a 40-day-old PR on a 2.0 server (threadsKnown false)
    // is not silent, it is unobserved — it belongs in "Needs your attention",
    // not in "Abandon or revive?".
    const state = computePrState(
      {
        createdAt: NOW - 40 * DAY,
        authorId: 'author1',
        authorName: 'Ann Author',
        meId: 'me',
        reviewers: [{ id: 'me', name: 'Me', vote: 0, required: true, votedAt: null }],
        threads: [],
        threadsKnown: false,
        lastPushAt: null,
      },
      NOW,
      THRESHOLDS,
    )
    expect(state.stale).toBe(false)
    const groups = groupPrs([pr('r:9b', { createdAt: NOW - 40 * DAY, state })], 'me', NOW)
    expect(groups.map((g) => g.key)).toEqual(['attention'])
  })

  it('never assigns attention when meId is null', () => {
    const p = pr('n:1', { state: state({ kind: 'needs-review', nextIds: ['someone'] }) })
    const groups = groupPrs([p], null, NOW)
    expect(groups.map((g) => g.key)).toEqual(['review'])
  })

  it('orders groups attention, review, author, replied, complete, stale, then legacy — omitting empties', () => {
    const attention = pr('a:1', { state: state({ kind: 'needs-review', nextIds: ['me'] }) })
    const review = pr('a:2', { state: state({ kind: 'needs-review', nextIds: ['other'] }) })
    const author = pr('a:3', { state: state({ kind: 'comments-open', next: 'author', nextIds: ['other-author'] }) })
    const replied = pr('a:4', { state: state({ kind: 'author-replied', nextIds: ['other'] }) })
    const complete = pr('a:5', { state: state({ kind: 'approved', next: 'author', nextIds: ['other-author'] }) })
    const stale = pr('a:6', { state: state({ kind: 'needs-review', nextIds: ['other'], stale: true }) })
    const legacy = pr('a:7')

    const groups = groupPrs([legacy, stale, complete, replied, author, review, attention], 'me', NOW)
    expect(groups.map((g) => g.key)).toEqual(['attention', 'review', 'author', 'replied', 'complete', 'stale', 'legacy'])
  })

  it('omits empty groups entirely and carries the right label', () => {
    const p = pr('x:1', { state: state({ kind: 'approved', next: 'author', nextIds: ['other-author'] }) })
    const groups = groupPrs([p], 'me', NOW)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ key: 'complete', label: 'Ready to complete' })
  })

  it('sorts within a group by since ascending — the longest wait first', () => {
    const soon = pr('s:soon', { state: state({ kind: 'needs-review', nextIds: ['other'], since: NOW - 1 * DAY }) })
    const longest = pr('s:longest', { state: state({ kind: 'needs-review', nextIds: ['other'], since: NOW - 10 * DAY }) })
    const middle = pr('s:middle', { state: state({ kind: 'needs-review', nextIds: ['other'], since: NOW - 5 * DAY }) })
    const groups = groupPrs([soon, longest, middle], 'me', NOW)
    expect(groups[0].prs.map((p) => p.key)).toEqual(['s:longest', 's:middle', 's:soon'])
  })

  it('breaks a since tie by key, ascending', () => {
    const b = pr('t:b', { state: state({ kind: 'needs-review', nextIds: ['other'], since: NOW - DAY }) })
    const a = pr('t:a', { state: state({ kind: 'needs-review', nextIds: ['other'], since: NOW - DAY }) })
    const groups = groupPrs([b, a], 'me', NOW)
    expect(groups[0].prs.map((p) => p.key)).toEqual(['t:a', 't:b'])
  })

  it('falls back PRs with no state to legacy, newest first like today', () => {
    const older = pr('l:older', { createdAt: NOW - 10 * DAY })
    const newer = pr('l:newer', { createdAt: NOW - 1 * DAY })
    const groups = groupPrs([older, newer], 'me', NOW)
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('legacy')
    expect(groups[0].label).toBe('')
    expect(groups[0].prs.map((p) => p.key)).toEqual(['l:newer', 'l:older'])
  })

  it('returns nothing for an empty input', () => {
    expect(groupPrs([], 'me', NOW)).toEqual([])
  })
})

describe('GROUP_LABELS', () => {
  it('matches the spec strings exactly', () => {
    expect(GROUP_LABELS.attention).toBe('Needs your attention')
    expect(GROUP_LABELS.review).toBe('Waiting for review')
    expect(GROUP_LABELS.author).toBe('Waiting on the author')
    expect(GROUP_LABELS.replied).toBe('Author replied — reviewers to resolve')
    expect(GROUP_LABELS.complete).toBe('Ready to complete')
    expect(GROUP_LABELS.stale).toBe('Stale')
  })
})

describe('waitLabel', () => {
  it('needs-review', () => {
    expect(waitLabel(state({ kind: 'needs-review', since: NOW - 3 * DAY }), NOW)).toBe('Review · 3 d')
  })

  it('changes-requested carries no comment count', () => {
    expect(waitLabel(state({ kind: 'changes-requested', since: NOW - 5 * DAY }), NOW)).toBe('Author · 5 d')
  })

  it('comments-open pluralizes the open-comment count', () => {
    expect(waitLabel(state({ kind: 'comments-open', since: NOW - 5 * DAY, openThreads: 2 }), NOW)).toBe(
      'Author · 2 comments · 5 d',
    )
    expect(waitLabel(state({ kind: 'comments-open', since: NOW - 1 * DAY, openThreads: 1 }), NOW)).toBe(
      'Author · 1 comment · 1 d',
    )
  })

  it('author-replied reads as a reply, not a raw duration', () => {
    expect(waitLabel(state({ kind: 'author-replied', since: NOW - 4 * HOUR }), NOW)).toBe('Reviewers · replied 4 h ago')
  })

  it('approved', () => {
    expect(waitLabel(state({ kind: 'approved', since: NOW - 6 * DAY }), NOW)).toBe('Complete · 6 d')
  })

  it('stale overrides the kind and measures from lastActivityAt, not since', () => {
    const s = state({ kind: 'needs-review', since: NOW - 3 * DAY, lastActivityAt: NOW - 21 * DAY, stale: true })
    expect(waitLabel(s, NOW)).toBe('Stale · 21 d')
  })
})

describe('waitTone', () => {
  it('is neutral well within the SLA', () => {
    expect(waitTone(state({ kind: 'needs-review', since: NOW - 1 * HOUR }), THRESHOLDS, NOW)).toBe('neutral')
  })

  it('is neutral just under the SLA boundary', () => {
    const s = state({ kind: 'needs-review', since: NOW - (48 * HOUR - 1) })
    expect(waitTone(s, THRESHOLDS, NOW)).toBe('neutral')
  })

  it('is warn exactly at the SLA', () => {
    expect(waitTone(state({ kind: 'needs-review', since: NOW - 48 * HOUR }), THRESHOLDS, NOW)).toBe('warn')
  })

  it('is warn just under 2x the SLA', () => {
    const s = state({ kind: 'needs-review', since: NOW - (96 * HOUR - 1) })
    expect(waitTone(s, THRESHOLDS, NOW)).toBe('warn')
  })

  it('is danger exactly at 2x the SLA', () => {
    expect(waitTone(state({ kind: 'needs-review', since: NOW - 96 * HOUR }), THRESHOLDS, NOW)).toBe('danger')
  })

  it('is danger well past 2x the SLA', () => {
    expect(waitTone(state({ kind: 'needs-review', since: NOW - 20 * DAY }), THRESHOLDS, NOW)).toBe('danger')
  })

  it('is always danger when stale, even with a fresh since', () => {
    const s = state({ kind: 'needs-review', since: NOW - 1 * HOUR, stale: true })
    expect(waitTone(s, THRESHOLDS, NOW)).toBe('danger')
  })

  it('respects a custom SLA threshold', () => {
    const custom: PrsThresholds = { reviewSlaHours: 4, staleAfterDays: 14 }
    expect(waitTone(state({ kind: 'needs-review', since: NOW - 5 * HOUR }), custom, NOW)).toBe('warn')
  })
})

describe('nextLine', () => {
  it('lists reviewers by name', () => {
    expect(nextLine(state({ kind: 'needs-review', next: 'reviewers', nextNames: ['Ana', 'Bob'] }))).toBe(
      'Next: Ana, Bob',
    )
  })

  it('names the author with a role suffix', () => {
    expect(nextLine(state({ kind: 'comments-open', next: 'author', nextNames: ['Carlos'] }))).toBe(
      'Next: Carlos (author)',
    )
  })

  it('is empty when nobody is next', () => {
    expect(nextLine(state({ kind: 'needs-review', next: 'nobody', nextNames: [] }))).toBe('')
  })

  it('is empty when next names are empty even if next names reviewers', () => {
    expect(nextLine(state({ kind: 'needs-review', next: 'reviewers', nextNames: [] }))).toBe('')
  })
})
