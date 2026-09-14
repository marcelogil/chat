import { describe, expect, it } from 'vitest'
import type { AdoThread } from './prs'
import { computePrState, summarizeThreads, type PrStateInput, type PrThreadSummary } from './prState'
import { PRS } from './constants'

// The waiting-state rules, with a fixed `now` and no network. Everything here
// is wall-clock arithmetic on plain data, so every boundary in the table is
// checkable exactly rather than approximately.

const T0 = Date.parse('2026-09-01T00:00:00Z')
const HOUR = 3_600_000
const DAY = 86_400_000
const hours = (n: number): number => T0 + n * HOUR
const days = (n: number): number => T0 + n * DAY

const AUTHOR = 'author-1'
const ANA = 'rev-ana'
const BOB = 'rev-bob'

const THRESHOLDS = { reviewSlaHours: PRS.reviewSlaHours, staleAfterDays: PRS.staleAfterDays }

function input(over: Partial<PrStateInput> = {}): PrStateInput {
  return {
    createdAt: T0,
    authorId: AUTHOR,
    authorName: 'Grace Hopper',
    meId: ANA,
    reviewers: [{ id: ANA, name: 'Ana', vote: 0, required: true }],
    threads: [],
    threadsKnown: true,
    lastPushAt: null,
    ...over,
  }
}

function thread(over: Partial<PrThreadSummary> = {}): PrThreadSummary {
  return {
    open: true,
    openedAt: hours(2),
    lastCommentAt: hours(2),
    lastCommentById: ANA,
    openedById: ANA,
    ...over,
  }
}

// ---------------------------------------------------------------------------

describe('computePrState — needs-review', () => {
  it('waits on every reviewer without an approving vote, since the last push', () => {
    const s = computePrState(
      input({
        lastPushAt: hours(4),
        reviewers: [
          { id: ANA, name: 'Ana', vote: 0, required: true },
          { id: BOB, name: 'Bob', vote: 0, required: false },
        ],
      }),
      hours(6),
      THRESHOLDS,
    )
    expect(s.kind).toBe('needs-review')
    expect(s.next).toBe('reviewers')
    expect(s.nextIds).toEqual([ANA, BOB])
    expect(s.nextNames).toEqual(['Ana', 'Bob'])
    expect(s.since).toBe(hours(4))
    expect(s.lastPushAt).toBe(hours(4))
  })

  it('falls back to the creation time when nothing was ever pushed', () => {
    const s = computePrState(input(), hours(1), THRESHOLDS)
    expect(s.kind).toBe('needs-review')
    expect(s.since).toBe(T0)
    expect(s.lastPushAt).toBeNull()
    expect(s.lastActivityAt).toBe(T0)
  })

  it('drops a reviewer who has already approved since the push', () => {
    const s = computePrState(
      input({
        lastPushAt: hours(4),
        reviewers: [
          { id: ANA, name: 'Ana', vote: 10, required: true, votedAt: hours(5) },
          { id: BOB, name: 'Bob', vote: 0, required: true },
        ],
      }),
      hours(6),
      THRESHOLDS,
    )
    expect(s.kind).toBe('needs-review')
    expect(s.nextIds).toEqual([BOB])
  })

  it('puts the viewer first among the people it is waiting on', () => {
    const s = computePrState(
      input({
        meId: BOB,
        reviewers: [
          { id: ANA, name: 'Ana', vote: 0, required: true },
          { id: BOB, name: 'Bob', vote: 0, required: true },
        ],
      }),
      hours(6),
      THRESHOLDS,
    )
    expect(s.nextIds).toEqual([BOB, ANA])
    expect(s.nextNames).toEqual(['Bob', 'Ana'])
  })

  it('a PR nobody was asked to review waits on nobody', () => {
    const s = computePrState(input({ reviewers: [] }), hours(80), THRESHOLDS)
    expect(s.kind).toBe('needs-review')
    expect(s.next).toBe('nobody')
    expect(s.nextIds).toEqual([])
    expect(s.nextNames).toEqual([])
    // …and "nobody is late" — overdue only ever applies to a real reviewer.
    expect(s.overdue).toBe(false)
  })
})

describe('computePrState — changes-requested', () => {
  it('a −10 after the last push puts the ball with the author', () => {
    const s = computePrState(
      input({
        lastPushAt: hours(4),
        reviewers: [{ id: ANA, name: 'Ana', vote: -10, required: true, votedAt: hours(5) }],
      }),
      hours(9),
      THRESHOLDS,
    )
    expect(s.kind).toBe('changes-requested')
    expect(s.next).toBe('author')
    expect(s.nextIds).toEqual([AUTHOR])
    expect(s.nextNames).toEqual(['Grace Hopper'])
    expect(s.since).toBe(hours(5))
  })

  it('takes the earliest blocking vote as the start of the wait', () => {
    const s = computePrState(
      input({
        reviewers: [
          { id: ANA, name: 'Ana', vote: -5, required: true, votedAt: hours(7) },
          { id: BOB, name: 'Bob', vote: -10, required: false, votedAt: hours(3) },
        ],
      }),
      hours(9),
      THRESHOLDS,
    )
    expect(s.kind).toBe('changes-requested')
    expect(s.since).toBe(hours(3))
  })

  it('ignores a −5 that predates the last push — the author already answered it', () => {
    const s = computePrState(
      input({
        lastPushAt: hours(6),
        reviewers: [{ id: ANA, name: 'Ana', vote: -5, required: true, votedAt: hours(2) }],
      }),
      hours(7),
      THRESHOLDS,
    )
    expect(s.kind).toBe('needs-review')
    expect(s.next).toBe('reviewers')
    expect(s.nextIds).toEqual([ANA])
    expect(s.since).toBe(hours(6))
  })

  it('outranks open comment threads', () => {
    const s = computePrState(
      input({
        reviewers: [{ id: ANA, name: 'Ana', vote: -5, required: true, votedAt: hours(5) }],
        threads: [thread({ lastCommentAt: hours(3) })],
      }),
      hours(6),
      THRESHOLDS,
    )
    expect(s.kind).toBe('changes-requested')
  })
})

describe('computePrState — comments-open and author-replied', () => {
  it('an open thread whose last word is a reviewer’s waits on the author', () => {
    const s = computePrState(
      input({
        threads: [
          thread({ lastCommentAt: hours(5), lastCommentById: ANA }),
          thread({ lastCommentAt: hours(3), lastCommentById: BOB, openedById: BOB }),
        ],
      }),
      hours(8),
      THRESHOLDS,
    )
    expect(s.kind).toBe('comments-open')
    expect(s.next).toBe('author')
    expect(s.nextIds).toEqual([AUTHOR])
    expect(s.openThreads).toBe(2)
    // The oldest unanswered comment is when the author started being late.
    expect(s.since).toBe(hours(3))
  })

  it('ignores resolved threads entirely', () => {
    const s = computePrState(
      input({ threads: [thread({ open: false, lastCommentAt: hours(5), lastCommentById: ANA })] }),
      hours(8),
      THRESHOLDS,
    )
    expect(s.kind).toBe('needs-review')
    expect(s.openThreads).toBe(0)
    // …but a resolved thread is still activity: it holds off "stale".
    expect(s.lastActivityAt).toBe(hours(5))
  })

  it('once the author has replied everywhere, the openers owe a resolution', () => {
    const s = computePrState(
      input({
        threads: [
          thread({ openedById: ANA, lastCommentAt: hours(6), lastCommentById: AUTHOR }),
          thread({ openedById: BOB, lastCommentAt: hours(9), lastCommentById: AUTHOR }),
        ],
        reviewers: [
          { id: ANA, name: 'Ana', vote: 0, required: true },
          { id: BOB, name: 'Bob', vote: 0, required: false },
        ],
      }),
      hours(10),
      THRESHOLDS,
    )
    expect(s.kind).toBe('author-replied')
    expect(s.next).toBe('reviewers')
    expect(s.nextIds).toEqual([ANA, BOB])
    expect(s.since).toBe(hours(6))
  })

  it('one unanswered thread is enough to keep it on the author', () => {
    const s = computePrState(
      input({
        threads: [
          thread({ openedById: ANA, lastCommentAt: hours(6), lastCommentById: AUTHOR }),
          thread({ openedById: BOB, lastCommentAt: hours(7), lastCommentById: BOB }),
        ],
      }),
      hours(10),
      THRESHOLDS,
    )
    expect(s.kind).toBe('comments-open')
    expect(s.since).toBe(hours(7))
  })

  it('a thread the author opened and answered themselves names no reviewer, so it falls back to the pending ones', () => {
    const s = computePrState(
      input({
        threads: [thread({ openedById: AUTHOR, lastCommentById: AUTHOR, lastCommentAt: hours(5) })],
        reviewers: [{ id: BOB, name: 'Bob', vote: 0, required: true }],
      }),
      hours(6),
      THRESHOLDS,
    )
    expect(s.kind).toBe('author-replied')
    expect(s.next).toBe('reviewers')
    expect(s.nextIds).toEqual([BOB])
  })

  it('falls back to every reviewer when a deleted opening comment left the thread looking like the author\u2019s', () => {
    // Bo opened this thread and deleted that first comment; summarizeThreads
    // can only see the author's reply, so the openers set comes out empty —
    // and Bo has already approved, so the pending set is empty too. Bo still
    // owes the resolution: "nobody" would quietly retire the thread.
    const s = computePrState(
      input({
        threads: [thread({ openedById: AUTHOR, lastCommentById: AUTHOR, lastCommentAt: hours(5) })],
        reviewers: [{ id: BOB, name: 'Bob', vote: 10, required: true, votedAt: hours(1) }],
      }),
      hours(6),
      THRESHOLDS,
    )
    expect(s.kind).toBe('author-replied')
    expect(s.next).toBe('reviewers')
    expect(s.nextIds).toEqual([BOB])
    expect(s.nextNames).toEqual(['Bob'])
  })

  it('…and waits on nobody when there is no reviewer left to name either', () => {
    const s = computePrState(
      input({
        threads: [thread({ openedById: AUTHOR, lastCommentById: AUTHOR, lastCommentAt: hours(5) })],
        reviewers: [],
      }),
      hours(6),
      THRESHOLDS,
    )
    expect(s.kind).toBe('author-replied')
    expect(s.next).toBe('nobody')
    expect(s.nextIds).toEqual([])
  })
})

describe('computePrState — approved', () => {
  it('every required reviewer approved and no thread is open', () => {
    const s = computePrState(
      input({
        reviewers: [
          { id: ANA, name: 'Ana', vote: 10, required: true, votedAt: hours(4) },
          { id: BOB, name: 'Bob', vote: 5, required: true, votedAt: hours(7) },
        ],
      }),
      hours(9),
      THRESHOLDS,
    )
    expect(s.kind).toBe('approved')
    expect(s.next).toBe('author')
    expect(s.nextIds).toEqual([AUTHOR])
    // The wait to *complete* began with the approval that finished the job.
    expect(s.since).toBe(hours(7))
    expect(s.overdue).toBe(false)
  })

  it('an optional reviewer who never voted does not hold it back', () => {
    const s = computePrState(
      input({
        reviewers: [
          { id: ANA, name: 'Ana', vote: 10, required: true, votedAt: hours(4) },
          { id: BOB, name: 'Bob', vote: 0, required: false },
        ],
      }),
      hours(9),
      THRESHOLDS,
    )
    expect(s.kind).toBe('approved')
  })

  it('a required reviewer sitting at 0 does', () => {
    const s = computePrState(
      input({
        reviewers: [
          { id: ANA, name: 'Ana', vote: 10, required: false, votedAt: hours(4) },
          { id: BOB, name: 'Bob', vote: 0, required: true },
        ],
      }),
      hours(9),
      THRESHOLDS,
    )
    expect(s.kind).toBe('needs-review')
    expect(s.nextIds).toEqual([BOB])
  })

  it('an open thread keeps an otherwise-approved PR on the author', () => {
    const s = computePrState(
      input({
        reviewers: [{ id: ANA, name: 'Ana', vote: 10, required: true, votedAt: hours(4) }],
        threads: [thread({ lastCommentAt: hours(5), lastCommentById: ANA })],
      }),
      hours(9),
      THRESHOLDS,
    )
    expect(s.kind).toBe('comments-open')
  })

  it('an approval cast before the last push is no approval of what is there now', () => {
    const before = computePrState(
      input({ reviewers: [{ id: ANA, name: 'Ana', vote: 10, required: true, votedAt: hours(2) }], lastPushAt: hours(6) }),
      hours(7),
      THRESHOLDS,
    )
    expect(before.kind).toBe('needs-review')
    expect(before.nextIds).toEqual([ANA])
    expect(before.since).toBe(hours(6))

    const after = computePrState(
      input({ reviewers: [{ id: ANA, name: 'Ana', vote: 10, required: true, votedAt: hours(8) }], lastPushAt: hours(6) }),
      hours(9),
      THRESHOLDS,
    )
    expect(after.kind).toBe('approved')
  })

  it('a vote observed exactly at the push still counts (that is where first sight is floored)', () => {
    const s = computePrState(
      input({ reviewers: [{ id: ANA, name: 'Ana', vote: 10, required: true, votedAt: hours(6) }], lastPushAt: hours(6) }),
      hours(7),
      THRESHOLDS,
    )
    expect(s.kind).toBe('approved')
  })

  it('a vote with no observation time at all is treated as cast at the push', () => {
    const s = computePrState(
      input({ reviewers: [{ id: ANA, name: 'Ana', vote: 10, required: true, votedAt: null }], lastPushAt: hours(6) }),
      hours(7),
      THRESHOLDS,
    )
    expect(s.kind).toBe('approved')
    expect(s.since).toBe(hours(6))
  })
})

describe('computePrState — threads unknown (a pre-3.0 server)', () => {
  it('computes from votes alone and says so', () => {
    const s = computePrState(
      input({
        threadsKnown: false,
        threads: [thread({ lastCommentById: ANA })],
        reviewers: [{ id: ANA, name: 'Ana', vote: 10, required: true, votedAt: hours(4) }],
      }),
      hours(9),
      THRESHOLDS,
    )
    expect(s.threadsKnown).toBe(false)
    expect(s.openThreads).toBe(0)
    // The thread is not even counted as activity — we are not supposed to know.
    expect(s.lastActivityAt).toBe(hours(4))
    expect(s.kind).toBe('approved')
  })
})

describe('computePrState — overdue and stale', () => {
  it('is overdue exactly at the SLA, not a millisecond before', () => {
    const at = computePrState(input({ lastPushAt: T0 }), T0 + 48 * HOUR, THRESHOLDS)
    const just = computePrState(input({ lastPushAt: T0 }), T0 + 48 * HOUR - 1, THRESHOLDS)
    expect(at.overdue).toBe(true)
    expect(just.overdue).toBe(false)
  })

  it('honours a team threshold other than the default', () => {
    const s = computePrState(input({ lastPushAt: T0 }), T0 + 5 * HOUR, { reviewSlaHours: 4, staleAfterDays: 14 })
    expect(s.overdue).toBe(true)
  })

  it('never calls a wait on the author overdue — that is a review SLA', () => {
    const s = computePrState(
      input({ reviewers: [{ id: ANA, name: 'Ana', vote: -10, required: true, votedAt: T0 }] }),
      days(30),
      THRESHOLDS,
    )
    expect(s.kind).toBe('changes-requested')
    expect(s.overdue).toBe(false)
    expect(s.stale).toBe(true)
  })

  it('is stale exactly at the threshold, measured from the last activity of any kind', () => {
    const base = input({ lastPushAt: days(1), threads: [thread({ open: false, lastCommentAt: days(2) })] })
    expect(computePrState(base, days(16), THRESHOLDS).stale).toBe(true)
    expect(computePrState(base, days(16) - 1, THRESHOLDS).stale).toBe(false)
  })

  it('is never stale on a server that cannot serve threads — silence there is not evidence', () => {
    // A 2.0 server (or a first detail read that failed): the PR is 40 days old
    // and commented on daily, but none of that is visible here. Calling it
    // stale would pull every older PR out of its group into "Abandon or
    // revive?" the moment a team's server is too old.
    const blind = input({ threadsKnown: false, threads: [], lastPushAt: null, createdAt: days(-26) })
    expect(computePrState(blind, days(14), THRESHOLDS).stale).toBe(false)
    // …the same PR, once the threads are readable and genuinely silent.
    expect(computePrState({ ...blind, threadsKnown: true }, days(14), THRESHOLDS).stale).toBe(true)
  })

  it('an observed vote counts as activity', () => {
    const s = computePrState(
      input({ reviewers: [{ id: ANA, name: 'Ana', vote: 5, required: false, votedAt: days(13) }] }),
      days(20),
      THRESHOLDS,
    )
    expect(s.lastActivityAt).toBe(days(13))
    expect(s.stale).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('summarizeThreads', () => {
  function ado(over: Partial<AdoThread> = {}): AdoThread {
    return {
      id: 1,
      status: 'active',
      publishedDate: '2026-09-01T02:00:00Z',
      lastUpdatedDate: '2026-09-01T03:00:00Z',
      comments: [
        { id: 1, author: { id: ANA, displayName: 'Ana' }, publishedDate: '2026-09-01T02:00:00Z', commentType: 'text' },
        { id: 2, author: { id: AUTHOR, displayName: 'Grace' }, publishedDate: '2026-09-01T03:00:00Z', commentType: 'text' },
      ],
      ...over,
    }
  }

  it('reads the opener, the last speaker and both times', () => {
    const [t] = summarizeThreads([ado()])
    expect(t.open).toBe(true)
    expect(t.openedById).toBe(ANA)
    expect(t.openedAt).toBe(hours(2))
    expect(t.lastCommentById).toBe(AUTHOR)
    expect(t.lastCommentAt).toBe(hours(3))
  })

  it('treats only active and pending threads as open', () => {
    const statuses = ['active', 'pending', 'fixed', 'wontFix', 'closed', 'byDesign', 'unknown']
    const open = summarizeThreads(statuses.map((status, i) => ado({ id: i + 1, status }))).map((t) => t.open)
    expect(open).toEqual([true, true, false, false, false, false, false])
  })

  it('drops deleted threads and deleted comments', () => {
    expect(summarizeThreads([ado({ isDeleted: true })])).toEqual([])
    const [t] = summarizeThreads([
      ado({
        comments: [
          { id: 1, author: { id: ANA }, publishedDate: '2026-09-01T02:00:00Z' },
          { id: 2, author: { id: AUTHOR }, publishedDate: '2026-09-01T03:00:00Z', isDeleted: true },
        ],
      }),
    ])
    expect(t.lastCommentById).toBe(ANA)
  })

  it('ignores Azure DevOps’s own system threads — "Ana voted 10" is not a conversation', () => {
    expect(
      summarizeThreads([
        ado({
          comments: [{ id: 1, author: { id: ANA }, publishedDate: '2026-09-01T02:00:00Z', commentType: 'system' }],
        }),
      ]),
    ).toEqual([])
  })

  it('survives missing dates, authors and comment arrays', () => {
    expect(summarizeThreads([{ id: 7 }])).toEqual([])
    const [t] = summarizeThreads([ado({ publishedDate: undefined, comments: [{ id: 1 }] })])
    expect(t.openedById).toBe('')
    expect(t.lastCommentAt).toBe(hours(3)) // falls back to lastUpdatedDate
  })
})
