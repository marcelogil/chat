import type { ConvId } from '@shared/types'
import { MAX_HITS, type Hit, type SearchResult } from './messageSearch'

// The scoped search opened from a conversation's own header (1.6.1). The
// matching, folding and snippets are all messageSearch.ts's — this module only
// owns what changes when the search has exactly one conversation in it:
//
//  - the dropdown's per-conversation cap (`HITS_PER_CONV`, the "N more…" row)
//    is gone, because there is nothing to make room for. Every hit shows, up
//    to the global `MAX_HITS`;
//  - the result therefore needs a count line of its own, which has to be
//    honest about the cap when it bites;
//  - ↑/↓ walk a flat list rather than a composed one.
//
// Pure — no React, no DOM, no bridge — so all three decisions are unit-tested
// without mounting the pane.

/**
 * The `max` the pane hands `searchMessages`. Deliberately past any conversation
 * a share can hold: the cap belongs to `flattenHits`, so `result.total` is the
 * honest number of matches and the count line can say "of N" rather than "of
 * the 200 I stopped counting at".
 */
export const SCAN_ALL = Number.MAX_SAFE_INTEGER

export type ConvSearchKind = 'channel' | 'group' | 'dm'

/**
 * The one place the scoped search's name is built. The header button, the
 * input and the results listbox all carry the same string — they are the same
 * control as far as a screen reader is concerned — and it always starts with
 * "Search in " so the pane can be found by that prefix alone.
 */
export function searchLabelFor(kind: ConvSearchKind, name?: string): string {
  if (kind === 'dm') return 'Search in this direct message'
  if (!name) return 'Search in this conversation'
  return kind === 'channel' ? `Search in #${name}` : `Search in ${name}`
}

/**
 * One conversation's hits, newest first and capped at `MAX_HITS`.
 *
 * The sort is restated rather than inherited: `searchMessages` groups in the
 * order it met the conversations, and a caller is free to hand us a result
 * assembled some other way. Event ids are HLC stems, so lexicographic order is
 * chronological order — and it is the only order every client agrees on.
 */
export function flattenHits(result: SearchResult, conv: ConvId): Hit[] {
  const out: Hit[] = []
  for (const group of result.groups) {
    if (group.conv !== conv) continue
    for (const hit of group.hits) out.push(hit)
  }
  out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  return out.length > MAX_HITS ? out.slice(0, MAX_HITS) : out
}

/**
 * The line above the results. `total` is how many matches exist, `shown` how
 * many rows are rendered; they differ only when the cap threw the oldest ones
 * away, which the line then says out loud instead of quietly showing fewer.
 *
 * `capped` covers the other route to the same truth — a `SearchResult` that was
 * already truncated by `searchMessages` itself, where `total` is the kept count
 * and the missing hits can no longer be counted.
 */
export function countLine(total: number, capped: boolean, shown: number): string {
  if (shown < total) return `Showing the newest ${shown} of ${total}`
  if (capped) return `Showing the newest ${shown}`
  return `${total} match${total === 1 ? '' : 'es'}`
}

/**
 * Move the keyboard cursor by `delta` over a list of `len` rows. Clamps rather
 * than wraps, and a `delta` of 0 is the way to pull a stale cursor back inside
 * a list that just shrank under it (the debounced search lands one render after
 * the typing that caused it).
 */
export function moveCursor(sel: number, delta: number, len: number): number {
  if (len <= 0) return 0
  const next = sel + delta
  if (next < 0) return 0
  return next > len - 1 ? len - 1 : next
}
