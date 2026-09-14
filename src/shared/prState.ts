import type { PrState, PrStateKind } from './types'
import type { AdoThread } from './prs'
import { isApproved } from './prs'
import { PRS } from './constants'

// The pull-request waiting state (1.4): given what Azure DevOps says about a
// PR — its reviewers' votes, its comment threads and its last push — decide
// *who* is being waited on and *since when*. Pure and plain-data in, so it
// runs in a unit test with a fixed `now` and no network.
//
// Two ideas carry the whole file:
//
//   1. **A vote is only evidence about the code that was there when it was
//      cast.** Azure DevOps does not timestamp votes, so the service keeps its
//      own observation times (`prs-history`) and passes them in as `votedAt`.
//      A vote observed before the last push is treated here as no vote at all
//      — that is the `effective` projection below, and it is what makes
//      "approved, then the author pushed again" read as needs-review.
//   2. **A thread belongs to whoever spoke last.** If that is the author, the
//      reviewers owe a reply; if it is anybody else, the author does. Nothing
//      here reads thread text or resolution intent — only who, and when.

/**
 * One comment thread of a pull request, reduced to the four facts the state
 * machine needs. Built by `summarizeThreads`; kept as a separate input so the
 * rules can be tested without an Azure DevOps JSON fixture.
 */
export interface PrThreadSummary {
  /** Unresolved: ADO status 'active' or 'pending'. */
  open: boolean
  /** ms epoch the thread was started. */
  openedAt: number
  /** ms epoch of the newest human comment in it. */
  lastCommentAt: number
  /** Identity id of whoever wrote that newest comment. */
  lastCommentById: string
  /** Identity id of whoever started the thread. */
  openedById: string
}

export interface PrStateReviewer {
  id: string
  name: string
  vote: number
  required: boolean
  /** ms epoch this vote was first observed; null/undefined = never observed. */
  votedAt?: number | null
}

export interface PrStateInput {
  createdAt: number
  authorId: string
  authorName: string
  /**
   * This device's Azure DevOps identity, when known. The rules themselves are
   * viewer-independent — only the *order* of `nextIds` uses it, so a pane row
   * reads "Next: you, Bob" rather than burying you in the middle of a list.
   */
  meId: string | null
  reviewers: PrStateReviewer[]
  threads: PrThreadSummary[]
  /** False on a server too old to serve threads, or before the first detail fetch. */
  threadsKnown: boolean
  lastPushAt: number | null
}

export interface PrThresholds {
  reviewSlaHours: number
  staleAfterDays: number
}

export const DEFAULT_THRESHOLDS: PrThresholds = {
  reviewSlaHours: PRS.reviewSlaHours,
  staleAfterDays: PRS.staleAfterDays,
}

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** ADO thread statuses that mean "still open". Everything else is resolved. */
const OPEN_STATUSES = new Set(['active', 'pending'])

function ms(v: unknown): number {
  if (typeof v !== 'string' || v === '') return 0
  const t = Date.parse(v)
  return Number.isNaN(t) ? 0 : t
}

/**
 * The Azure DevOps threads of one PR, reduced to `PrThreadSummary[]`.
 *
 * Dropped outright: deleted threads, and threads with no human comment left —
 * ADO files its own "voted 10" / "updated the pull request" notes as `system`
 * comments inside real-looking threads, and those are not a conversation
 * anyone owes a reply to.
 */
export function summarizeThreads(threads: AdoThread[]): PrThreadSummary[] {
  const out: PrThreadSummary[] = []
  for (const t of Array.isArray(threads) ? threads : []) {
    if (!t || typeof t !== 'object' || t.isDeleted === true) continue
    const comments = (Array.isArray(t.comments) ? t.comments : []).filter(
      (c) => !!c && typeof c === 'object' && c.isDeleted !== true && (c.commentType ?? 'text') !== 'system',
    )
    if (comments.length === 0) continue

    const threadAt = ms(t.publishedDate) || ms(t.lastUpdatedDate)
    let first = comments[0]
    let last = comments[0]
    for (const c of comments) {
      if (ms(c.publishedDate) < ms(first.publishedDate)) first = c
      if (ms(c.publishedDate) >= ms(last.publishedDate)) last = c
    }
    out.push({
      open: OPEN_STATUSES.has(String(t.status ?? '')),
      openedAt: ms(first.publishedDate) || threadAt,
      lastCommentAt: ms(last.publishedDate) || ms(t.lastUpdatedDate) || threadAt,
      lastCommentById: String(last.author?.id ?? ''),
      openedById: String(first.author?.id ?? ''),
    })
  }
  return out
}

/** The names behind a set of identity ids, in reviewer order. */
function namesOf(ids: string[], input: PrStateInput): string[] {
  return ids.map((id) => {
    if (id === input.authorId) return input.authorName
    return input.reviewers.find((r) => r.id === id)?.name ?? id
  })
}

function minOf(values: number[], fallback: number): number {
  let best = Number.POSITIVE_INFINITY
  for (const v of values) if (v > 0 && v < best) best = v
  return best === Number.POSITIVE_INFINITY ? fallback : best
}

function maxOf(values: number[]): number {
  let best = 0
  for (const v of values) if (v > best) best = v
  return best
}

/**
 * The wait a pull request is in, and who ends it.
 *
 * Precedence, highest first — the first rule that matches wins, because each
 * one describes a stronger claim on somebody's attention than the next:
 *
 * | kind              | when                                                | next     | since                          |
 * |-------------------|-----------------------------------------------------|----------|--------------------------------|
 * | changes-requested | a −5/−10 vote cast after the last push               | author   | that vote (earliest of them)   |
 * | comments-open     | an open thread whose last comment isn't the author's | author   | that comment (earliest)        |
 * | author-replied    | open threads, all last-spoken-in by the author       | reviewers| the author's earliest reply    |
 * | approved          | isApproved on votes since the push, no open threads  | author   | the approval that completed it |
 * | needs-review      | anything else: reviewers without a fresh approval    | reviewers| the last push (or creation)    |
 *
 * A PR with no reviewers at all is `needs-review` with `next: 'nobody'` —
 * nobody has been asked, so nobody is late.
 */
export function computePrState(
  input: PrStateInput,
  now: number,
  thresholds: PrThresholds = DEFAULT_THRESHOLDS,
): PrState {
  const createdAt = input.createdAt > 0 ? input.createdAt : 0
  const lastPushAt = typeof input.lastPushAt === 'number' && input.lastPushAt > 0 ? input.lastPushAt : null
  /** Everything before this mark belongs to code that has since been replaced. */
  const pushMark = Math.max(lastPushAt ?? 0, createdAt)

  const voteAt = (r: PrStateReviewer): number =>
    typeof r.votedAt === 'number' && r.votedAt > 0 ? r.votedAt : pushMark
  /** A vote counts only if it was cast against the code that is there now. */
  const fresh = (r: PrStateReviewer): boolean => r.vote !== 0 && voteAt(r) >= pushMark
  const effective = input.reviewers.map((r) => ({ ...r, vote: fresh(r) ? r.vote : 0 }))

  const threads = input.threadsKnown ? input.threads : []
  const open = threads.filter((t) => t.open)
  const openThreads = open.length

  const blockers = input.reviewers.filter((r) => r.vote < 0 && fresh(r))
  const approvals = input.reviewers.filter((r) => r.vote >= 5 && fresh(r))
  const pending = effective.filter((r) => r.vote < 5)

  // Latest of: creation, push, any comment (open or resolved), any observed vote.
  const lastActivityAt = maxOf([
    createdAt,
    lastPushAt ?? 0,
    maxOf(threads.map((t) => t.lastCommentAt)),
    maxOf(input.reviewers.filter((r) => r.vote !== 0).map(voteAt)),
  ])

  let kind: PrStateKind
  let next: PrState['next']
  let nextIds: string[]
  let since: number

  const waitingOnAuthor = open.filter((t) => t.lastCommentById !== input.authorId)

  if (blockers.length > 0) {
    kind = 'changes-requested'
    next = 'author'
    nextIds = [input.authorId]
    since = minOf(blockers.map(voteAt), pushMark)
  } else if (waitingOnAuthor.length > 0) {
    kind = 'comments-open'
    next = 'author'
    nextIds = [input.authorId]
    since = minOf(
      waitingOnAuthor.map((t) => t.lastCommentAt),
      pushMark,
    )
  } else if (openThreads > 0) {
    // Every open thread's last word is the author's: the ball is with whoever
    // started those threads. A thread the author opened themselves names no
    // reviewer, so fall back to the reviewers who still owe a vote.
    kind = 'author-replied'
    next = 'reviewers'
    // Openers the PR can actually wait on. The set comes out empty more often
    // than it looks: a thread whose opening comment was *deleted* is
    // summarized from whoever spoke next — frequently the author — so
    // "nobody opened these" is not evidence that nobody is owed a reply.
    // Fall back to the reviewers who still owe a vote, then to every
    // reviewer; only a PR with no reviewers at all waits on nobody.
    const openers = [...new Set(open.map((t) => t.openedById))].filter((id) => id !== '' && id !== input.authorId)
    nextIds =
      openers.length > 0 ? openers : pending.length > 0 ? pending.map((r) => r.id) : input.reviewers.map((r) => r.id)
    if (nextIds.length === 0) next = 'nobody'
    since = minOf(
      open.map((t) => t.lastCommentAt),
      pushMark,
    )
  } else if (isApproved(effective)) {
    kind = 'approved'
    next = 'author'
    nextIds = [input.authorId]
    // The wait to *complete* it began when the last required approval landed.
    since = maxOf(approvals.map(voteAt)) || pushMark
  } else {
    kind = 'needs-review'
    next = pending.length > 0 ? 'reviewers' : 'nobody'
    nextIds = pending.map((r) => r.id)
    since = pushMark
  }

  if (since <= 0) since = createdAt
  const waited = now - since
  // The viewer first, so the pane can say "Next: you, Bob".
  if (input.meId && nextIds.length > 1 && nextIds.includes(input.meId)) {
    nextIds = [input.meId, ...nextIds.filter((id) => id !== input.meId)]
  }

  return {
    kind,
    next,
    nextIds,
    nextNames: namesOf(nextIds, input),
    since,
    lastActivityAt: lastActivityAt || createdAt,
    lastPushAt,
    openThreads,
    threadsKnown: input.threadsKnown === true,
    // Both boundaries are inclusive: at exactly 48 h the review *is* overdue.
    // Staleness is a claim about *silence*, and only a server that serves
    // threads can tell silence from "we cannot see the comments". Without
    // them, `lastActivityAt` collapses to creation/push/votes, and a busy
    // month-old PR on a 2.0 server would read as abandoned — and be pulled
    // out of every other group in the pane to say so.
    stale:
      input.threadsKnown === true &&
      lastActivityAt > 0 &&
      now - lastActivityAt >= thresholds.staleAfterDays * DAY_MS,
    overdue: next === 'reviewers' && waited >= thresholds.reviewSlaHours * HOUR_MS,
  }
}
