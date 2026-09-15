import type { ReactNode } from 'react'
import type { ConvId } from '@shared/types'
import { HITS_PER_CONV, type Hit, type SearchResult } from './messageSearch'

// Pure row/line composition for the quick switcher's dropdown (1.6). Kept out
// of QuickSwitcher.tsx so the addressing rules — which lines carry a
// navigable `index`, which don't, how a truncated group's "N more…" row
// expands in place without moving the cursor — are unit-testable without
// mounting anything.
//
// Two lists come out of one call: `lines` is everything the dropdown paints,
// in render order, including the headers and the "Messages" section divider
// that carry no index of their own; `rows` is the addressable subset — the
// exact array `↑`/`↓` walk and `rows[sel]` reads back on Enter. A line's
// `index` is always `rows.indexOf(that line's row)`, which is what makes
// `data-row-index` on the rendered element line up with keyboard selection.

/** One fuzzy-matched sidebar destination (a channel, person, team pane, group). */
export interface Item {
  key: string
  kind: 'channel' | 'person' | 'team' | 'group'
  label: string
  sub: string
  conv?: ConvId
  peerDeviceId?: string
  icon?: ReactNode
  score: number
}

/** A conversation the message search can name — and therefore can show. */
export interface ConvMeta {
  label: string
  kind: 'channel' | 'group' | 'dm'
}

/** One navigable line of the dropdown. Headers and the section note are not in here. */
export type Row =
  | { kind: 'item'; key: string; item: Item }
  | { kind: 'hit'; key: string; conv: ConvId; meta: ConvMeta; hit: Hit }
  | { kind: 'more'; key: string; conv: ConvId; meta: ConvMeta; n: number }

/** The dropdown in render order — navigable rows plus the headings between them. */
export type Line =
  | { kind: 'row'; key: string; row: Row; index: number }
  | { kind: 'section'; key: string; total: number; capped: boolean }
  | { kind: 'header'; key: string; conv: ConvId; meta: ConvMeta; count: number }

/**
 * Compose the dropdown's lines and its addressable rows from the switcher's
 * two result lists — the fuzzy sidebar `items` and the message-search
 * `result` — plus which message-search groups are currently expanded past
 * `HITS_PER_CONV`.
 *
 * Item rows always come first, un-indexed headers and the section note never
 * consume an index, and a message group whose conversation `convMeta` cannot
 * name is dropped rather than left as a headless section (the two memos that
 * feed this can disagree for one render when a group's name vanishes).
 */
export function buildSwitcherRows(
  items: readonly Item[],
  result: SearchResult,
  convMeta: ReadonlyMap<string, ConvMeta>,
  expandedGroups: readonly string[],
): { lines: Line[]; rows: Row[] } {
  const rows: Row[] = items.map((item) => ({ kind: 'item' as const, key: item.key, item }))
  const lines: Line[] = rows.map((row, index) => ({ kind: 'row' as const, key: row.key, row, index }))

  const groups = result.groups.filter((g) => convMeta.has(g.conv))
  if (groups.length > 0) {
    lines.push({ kind: 'section', key: 'section:messages', total: result.total, capped: result.capped })
    for (const group of groups) {
      const meta = convMeta.get(group.conv)
      if (!meta) continue
      lines.push({ kind: 'header', key: `h:${group.conv}`, conv: group.conv, meta, count: group.hits.length })
      const open = expandedGroups.includes(group.conv)
      const shown = open ? group.hits : group.hits.slice(0, HITS_PER_CONV)
      for (const hit of shown) {
        const row: Row = { kind: 'hit', key: `m:${group.conv}:${hit.id}`, conv: group.conv, meta, hit }
        lines.push({ kind: 'row', key: row.key, row, index: rows.length })
        rows.push(row)
      }
      if (group.hits.length > shown.length) {
        const row: Row = {
          kind: 'more',
          key: `more:${group.conv}`,
          conv: group.conv,
          meta,
          n: group.hits.length - shown.length,
        }
        lines.push({ kind: 'row', key: row.key, row, index: rows.length })
        rows.push(row)
      }
    }
  }
  return { lines, rows }
}
