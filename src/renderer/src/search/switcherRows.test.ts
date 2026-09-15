import { describe, expect, it } from 'vitest'
import type { ConvId } from '@shared/types'
import type { Hit, HitGroup, SearchResult } from './messageSearch'
import { buildSwitcherRows, type ConvMeta, type Item, type Line, type Row } from './switcherRows'

// Row/line composition for the quick switcher's dropdown (1.6). Pure, so the
// two things worth pinning — that `index` values line up with `rows` (what
// makes ↑/↓ and Enter address the row a click would) and that a group's
// truncation/expansion is exactly `HITS_PER_CONV` — can be checked without
// mounting QuickSwitcher.tsx.

const GENERAL = 'chan:general' as ConvId
const DUO = 'grp:duo' as ConvId
const GHOST = 'chan:ghost' as ConvId

const CHANNEL_META: ConvMeta = { label: 'general', kind: 'channel' }
const GROUP_META: ConvMeta = { label: 'duo', kind: 'group' }

function item(key: string): Item {
  return { key, kind: 'channel', label: key, sub: 'channel', score: 1 }
}

function hit(conv: ConvId, id: string): Hit {
  return {
    conv,
    id,
    hlcMs: Number(id),
    authorName: 'Ana Ruiz',
    text: `message ${id}`,
    placeholder: 'message',
    ranges: [],
    authorRanges: [],
  }
}

function group(conv: ConvId, ids: string[]): HitGroup {
  return { conv, hits: ids.map((id) => hit(conv, id)) }
}

function result(groups: HitGroup[]): SearchResult {
  const total = groups.reduce((n, g) => n + g.hits.length, 0)
  return { groups, total, capped: false }
}

const EMPTY_RESULT: SearchResult = { groups: [], total: 0, capped: false }

/** Every `{kind:'row'}` line's row must be the row that same index names. */
function addressingHolds(lines: readonly Line[], rows: readonly Row[]): boolean {
  return lines
    .filter((l): l is Extract<Line, { kind: 'row' }> => l.kind === 'row')
    .every((l) => rows[l.index] === l.row)
}

describe('buildSwitcherRows', () => {
  it('with nothing to search, lists just the items — no section, no headers', () => {
    const items = [item('c:a'), item('c:b')]
    const { lines, rows } = buildSwitcherRows(items, EMPTY_RESULT, new Map(), [])
    expect(rows.map((r) => (r.kind === 'item' ? r.item.key : r.kind))).toEqual(['c:a', 'c:b'])
    expect(lines.every((l) => l.kind === 'row')).toBe(true)
    expect(addressingHolds(lines, rows)).toBe(true)
  })

  it('assigns contiguous indices across items and hits, skipping headers and the section note', () => {
    const items = [item('c:a')]
    const meta = new Map([[GENERAL, CHANNEL_META]])
    const { lines, rows } = buildSwitcherRows(items, result([group(GENERAL, ['1', '2'])]), meta, [])

    const rowIndices = lines.filter((l) => l.kind === 'row').map((l) => (l as Extract<Line, { kind: 'row' }>).index)
    expect(rowIndices).toEqual([0, 1, 2]) // the item, then two hits
    expect(rows).toHaveLength(3)
    expect(addressingHolds(lines, rows)).toBe(true)

    // Headers and the section divider render but carry no index to walk to.
    expect(lines.some((l) => l.kind === 'section')).toBe(true)
    expect(lines.some((l) => l.kind === 'header')).toBe(true)
  })

  it('↑/↓ addressing survives a "N more…" row and an expanded group', () => {
    const meta = new Map([[GENERAL, CHANNEL_META]])
    const fiveHits = group(GENERAL, ['1', '2', '3', '4', '5'])

    const collapsed = buildSwitcherRows([], result([fiveHits]), meta, [])
    // HITS_PER_CONV (3) shown, then one "2 more…" row.
    expect(collapsed.rows.map((r) => r.kind)).toEqual(['hit', 'hit', 'hit', 'more'])
    const more = collapsed.rows[3]
    expect(more.kind === 'more' && more.n).toBe(2)
    expect(addressingHolds(collapsed.lines, collapsed.rows)).toBe(true)

    const expanded = buildSwitcherRows([], result([fiveHits]), meta, [GENERAL])
    expect(expanded.rows.map((r) => r.kind)).toEqual(['hit', 'hit', 'hit', 'hit', 'hit'])
    expect(addressingHolds(expanded.lines, expanded.rows)).toBe(true)
  })

  it('drops a group whose conversation convMeta cannot name, without a headless section', () => {
    const meta = new Map([[GENERAL, CHANNEL_META]]) // GHOST is deliberately absent
    const { lines, rows } = buildSwitcherRows([], result([group(GHOST, ['1'])]), meta, [])
    expect(rows).toHaveLength(0)
    expect(lines).toHaveLength(0) // no section note left dangling over zero groups
  })

  it('keeps multiple groups in the order they were handed, each addressable', () => {
    const meta = new Map([
      [GENERAL, CHANNEL_META],
      [DUO, GROUP_META],
    ])
    const { lines, rows } = buildSwitcherRows(
      [item('c:a')],
      result([group(GENERAL, ['1']), group(DUO, ['2'])]),
      meta,
      [],
    )
    expect(rows.map((r) => (r.kind === 'hit' ? r.conv : r.kind))).toEqual(['item', GENERAL, DUO])
    expect(addressingHolds(lines, rows)).toBe(true)
  })
})
