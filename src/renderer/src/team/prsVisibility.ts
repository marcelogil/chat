import type { PrView } from '@shared/types'

// Chat 1.5 — the pull-requests header's "N overdue" / "N stale" count toggles.
// Pure so PrsPane just wires it to a click handler; prsGroups.ts stays about
// *how* a list gets bucketed, this is about *which* PRs make it into that
// list at all. Applied after the pane's own scope/branch/repo/search filters
// and before grouping — see PrsPane's `filtered` -> `visible` -> `groups`.

export interface PrsVisibility {
  hideOverdue: boolean
  hideStale: boolean
}

export const VISIBLE_DEFAULT: PrsVisibility = { hideOverdue: false, hideStale: false }

/**
 * The two toggles as pure reducers, so the pane can hand them straight to
 * `setState` instead of computing the next value from the current render's
 * state. Two clicks dispatched inside one React batch then compose (and net
 * out to the original) rather than both reading the same stale flag and
 * counting as one.
 */
export function toggleOverdue(v: PrsVisibility): PrsVisibility {
  return { ...v, hideOverdue: !v.hideOverdue }
}

export function toggleStale(v: PrsVisibility): PrsVisibility {
  return { ...v, hideStale: !v.hideStale }
}

/**
 * The keys handed to `prs.markSeen` — deliberately the list *before*
 * `applyVisibility`, i.e. everything the pane's own filters kept, hidden rows
 * included.
 *
 * `PrsStatus.unseen` counts every tracked, non-approved PR with `seen: false`,
 * and that number is the sidebar's red badge and the OS dock badge. A hide
 * toggle persists per device, so marking only what is on screen would leave a
 * PR that arrived already overdue permanently unseen — a badge with no UI path
 * to clear it, surviving every restart. Hiding is "stop showing me these", not
 * "stop counting them" (the header counts say the same, off `filtered`).
 */
export function seenKeys(prs: PrView[]): string[] {
  return prs.map((p) => p.key)
}

function isHidden(pr: PrView, visibility: PrsVisibility): boolean {
  const state = pr.state
  if (!state) return false
  if (visibility.hideOverdue && state.overdue) return true
  if (visibility.hideStale && state.stale) return true
  return false
}

/**
 * `prs` minus whatever the active toggles hide. A PR that is both overdue and
 * stale (common: the stale threshold is normally well past the review SLA) is
 * hidden by either toggle alone — there is no "un-hide the overlap" case.
 */
export function applyVisibility(prs: PrView[], visibility: PrsVisibility): PrView[] {
  if (!visibility.hideOverdue && !visibility.hideStale) return prs
  return prs.filter((p) => !isHidden(p, visibility))
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * One line per active toggle that is actually hiding something right now, in
 * header order (overdue, then stale). Counts off `prs` — the list *before*
 * hiding — so the number matches the header's own count exactly, the same
 * list `applyVisibility` was given.
 */
export function visibilityNotes(prs: PrView[], visibility: PrsVisibility): string[] {
  const notes: string[] = []
  if (visibility.hideOverdue) {
    const n = prs.reduce((count, p) => count + (p.state?.overdue ? 1 : 0), 0)
    if (n > 0) notes.push(`${plural(n, 'overdue pull request')} hidden — click the count to show them`)
  }
  if (visibility.hideStale) {
    const n = prs.reduce((count, p) => count + (p.state?.stale ? 1 : 0), 0)
    if (n > 0) notes.push(`${plural(n, 'stale pull request')} hidden — click the count to show them`)
  }
  return notes
}

// ---------------------------------------------------------------------------
// Per-device persistence (localStorage). Deliberately not shared-folder state:
// this is what one machine's owner chose to stop looking at, not a team-wide
// decision — and it must survive a restart of just this app.

const OVERDUE_KEY = 'sem-prs-hide-overdue'
const STALE_KEY = 'sem-prs-hide-stale'

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null // private mode / blocked storage
  }
}

function readFlag(key: string): boolean {
  try {
    return store()?.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    const s = store()
    if (!s) return
    if (value) s.setItem(key, '1')
    else s.removeItem(key)
  } catch {
    // quota / private mode — the in-session toggle still applies this run
  }
}

export function readVisibility(): PrsVisibility {
  return { hideOverdue: readFlag(OVERDUE_KEY), hideStale: readFlag(STALE_KEY) }
}

export function writeHideOverdue(value: boolean): void {
  writeFlag(OVERDUE_KEY, value)
}

export function writeHideStale(value: boolean): void {
  writeFlag(STALE_KEY, value)
}

/**
 * Persist both flags at once. The pane calls this from an effect keyed on the
 * state itself, so what lands on disk is always the state that was actually
 * rendered — no write can disagree with the UI, however the state got there.
 */
export function writeVisibility(v: PrsVisibility): void {
  writeHideOverdue(v.hideOverdue)
  writeHideStale(v.hideStale)
}
