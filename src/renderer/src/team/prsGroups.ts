import type { PrState, PrStateKind, PrView } from '@shared/types'
import { DEFAULT_THRESHOLDS, type PrThresholds } from '@shared/prState'

// Chat 1.4 — pure grouping/sorting/labelling for the pull-requests pane.
// `PrView.state` is attached by the main-side PR service (contract in
// `@shared/types`); this module never touches IPC/React, so it's trivially
// testable (prsGroups.test.ts) independent of agent M's landing schedule for
// `state` itself. A `PrView` with no `state` yet (pre-1.4 cache, or simply
// before M's change lands) falls into the `legacy` bucket and keeps rendering
// the way the pane always has — see PrsPane.tsx/PrRow.

export type PrGroupKey = 'attention' | 'review' | 'author' | 'replied' | 'complete' | 'stale' | 'legacy'

export interface PrGroup {
  key: PrGroupKey
  /** Section header text (spec §2 U). Empty for `legacy` — it renders with no header, like today. */
  label: string
  prs: PrView[]
}

/**
 * The team's two thresholds — the same shape `computePrState` is given
 * main-side, deliberately not a second declaration of it: the pane reads them
 * off `PrsStatus` (always concrete) and only falls back to `DEFAULT_THRESHOLDS`
 * for the moment before the first status arrives.
 */
export type PrsThresholds = PrThresholds
export { DEFAULT_THRESHOLDS }

export const GROUP_LABELS: Record<Exclude<PrGroupKey, 'legacy'>, string> = {
  attention: 'Needs your attention',
  review: 'Waiting for review',
  author: 'Waiting on the author',
  replied: 'Author replied — reviewers to resolve',
  complete: 'Ready to complete',
  stale: 'Stale',
}

const GROUP_ORDER: PrGroupKey[] = ['attention', 'review', 'author', 'replied', 'complete', 'stale', 'legacy']

/** I'm the one who should act: either named directly, or the PR is mine and it's my move. */
function isAttention(pr: PrView, meId: string | null, state: PrState): boolean {
  if (meId === null) return false
  if (state.nextIds.includes(meId)) return true
  return pr.author.id === meId && state.next === 'author'
}

function kindGroup(kind: PrStateKind): Exclude<PrGroupKey, 'attention' | 'stale' | 'legacy'> {
  switch (kind) {
    case 'needs-review':
      return 'review'
    case 'changes-requested':
    case 'comments-open':
      return 'author'
    case 'author-replied':
      return 'replied'
    case 'approved':
      return 'complete'
    default: {
      const exhaustive: never = kind
      throw new Error(`prsGroups: unhandled PrStateKind ${String(exhaustive)}`)
    }
  }
}

function groupKeyFor(pr: PrView, meId: string | null): PrGroupKey {
  const state = pr.state
  if (!state) return 'legacy'
  // Stale is pulled out of whichever bucket the PR would otherwise land in —
  // attention included: a PR dead for two weeks needs "abandon or revive?",
  // not to sit disguised among this week's urgent asks.
  if (state.stale) return 'stale'
  return isAttention(pr, meId, state) ? 'attention' : kindGroup(state.kind)
}

function byWaitAsc(a: PrView, b: PrView): number {
  const as = a.state?.since ?? 0
  const bs = b.state?.since ?? 0
  if (as !== bs) return as - bs
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/** The legacy bucket has no `state.since` to sort by — same rule PrsPane has always used: newest first. */
function byNewestFirst(a: PrView, b: PrView): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
  return a.key < b.key ? -1 : 1
}

/**
 * Buckets `prs` by what to do about them (spec §2 U): `attention` first, then
 * the per-kind buckets, then `stale`, then anything with no `state` yet.
 * Within a bucket, longest wait first (`state.since` ascending), ties by key.
 * Empty buckets are omitted entirely — callers just map over what's returned.
 *
 * `now` is accepted (not just for symmetry with `waitLabel`/`waitTone`) so a
 * single render pass threads one consistent snapshot through grouping and
 * presentation, even though no bucket boundary here is time-relative today —
 * every input it would need (`state.stale`, `state.since`) is precomputed by
 * the PR service.
 */
export function groupPrs(prs: PrView[], meId: string | null, now: number): PrGroup[] {
  void now
  const buckets = new Map<PrGroupKey, PrView[]>(GROUP_ORDER.map((k): [PrGroupKey, PrView[]] => [k, []]))
  for (const pr of prs) buckets.get(groupKeyFor(pr, meId))!.push(pr)

  const groups: PrGroup[] = []
  for (const key of GROUP_ORDER) {
    const list = buckets.get(key)!
    if (list.length === 0) continue
    list.sort(key === 'legacy' ? byNewestFirst : byWaitAsc)
    groups.push({ key, label: key === 'legacy' ? '' : GROUP_LABELS[key], prs: list })
  }
  return groups
}

/** "45 m" / "4 h" / "21 d" — compact, space-separated, never negative. */
function waitDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h`
  return `${Math.round(hours / 24)} d`
}

/**
 * The wait chip's text (spec §2 U): "Review · 3 d", "Author · 2 comments · 5 d",
 * "Reviewers · replied 4 h ago", "Complete · 6 d", "Stale · 21 d". `stale`
 * overrides the kind entirely and measures from `lastActivityAt` — staleness
 * is dead air, not whichever kind-specific wait happened to be running when
 * activity stopped. Only `comments-open` gets an open-comment count in the
 * label; `changes-requested` is a blocking vote, not a thread count, even
 * though it could technically have open threads too.
 */
export function waitLabel(state: PrState, now: number): string {
  if (state.stale) return `Stale · ${waitDuration(now - state.lastActivityAt)}`
  const waited = waitDuration(now - state.since)
  switch (state.kind) {
    case 'needs-review':
      return `Review · ${waited}`
    case 'changes-requested':
      return `Author · ${waited}`
    case 'comments-open': {
      const n = state.openThreads
      return `Author · ${n} comment${n === 1 ? '' : 's'} · ${waited}`
    }
    case 'author-replied':
      return `Reviewers · replied ${waited} ago`
    case 'approved':
      return `Complete · ${waited}`
    default: {
      const exhaustive: never = state.kind
      throw new Error(`prsGroups: unhandled PrStateKind ${String(exhaustive)}`)
    }
  }
}

/**
 * Traffic-light tone for the wait chip: neutral under the team's review SLA,
 * `warn` at it, `danger` at 2×. `stale` is always `danger`, regardless of how
 * fresh the current wait happens to be (e.g. a brand-new thread on a PR whose
 * *overall* activity has otherwise gone quiet for weeks).
 */
export function waitTone(state: PrState, thresholds: PrsThresholds, now: number): 'neutral' | 'warn' | 'danger' {
  if (state.stale) return 'danger'
  const slaMs = thresholds.reviewSlaHours * 3_600_000
  const waited = now - state.since
  if (waited >= slaMs * 2) return 'danger'
  if (waited >= slaMs) return 'warn'
  return 'neutral'
}

/** "Next: Ana, Bob" / "Next: Carlos (author)" / "" when nobody's named. */
export function nextLine(state: PrState): string {
  if (state.next === 'nobody' || state.nextNames.length === 0) return ''
  const names = state.nextNames.join(', ')
  return state.next === 'author' ? `Next: ${names} (author)` : `Next: ${names}`
}
