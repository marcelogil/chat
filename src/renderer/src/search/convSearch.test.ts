import { describe, expect, it } from 'vitest'
import type { ConvId } from '@shared/types'
import { MAX_HITS, type Hit, type SearchResult } from './messageSearch'
import { SCAN_ALL, countLine, flattenHits, moveCursor, searchLabelFor } from './convSearch'

// The scoped, per-conversation search (1.6.1). Pure, so the three things worth
// pinning — that one conversation's hits come back newest-first and capped only
// by MAX_HITS, that the count line never claims to show more than it does, and
// that the cursor cannot leave the list — need no pane mounted.

const GENERAL = 'chan:general' as ConvId
const DUO = 'grp:duo' as ConvId

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

function result(groups: { conv: ConvId; hits: Hit[] }[], capped = false): SearchResult {
  return { groups, total: groups.reduce((n, g) => n + g.hits.length, 0), capped }
}

describe('searchLabelFor', () => {
  it('names a channel with its hash and a group plainly', () => {
    expect(searchLabelFor('channel', 'general')).toBe('Search in #general')
    expect(searchLabelFor('group', 'Duo')).toBe('Search in Duo')
  })

  it('names a direct message without naming the peer', () => {
    expect(searchLabelFor('dm')).toBe('Search in this direct message')
    // A DM label never leaks the peer, even when one is handed in.
    expect(searchLabelFor('dm', 'Ana')).toBe('Search in this direct message')
  })

  it('falls back rather than rendering an empty name', () => {
    expect(searchLabelFor('channel', '')).toBe('Search in this conversation')
    expect(searchLabelFor('group', undefined)).toBe('Search in this conversation')
  })

  it('always starts with the prefix the header button and pane share', () => {
    for (const label of [
      searchLabelFor('channel', 'general'),
      searchLabelFor('group', 'Duo'),
      searchLabelFor('dm'),
      searchLabelFor('channel', ''),
    ])
      expect(label.startsWith('Search in ')).toBe(true)
  })
})

describe('flattenHits', () => {
  it('returns only this conversation, newest first', () => {
    const r = result([
      { conv: GENERAL, hits: [hit(GENERAL, '300'), hit(GENERAL, '100'), hit(GENERAL, '200')] },
      { conv: DUO, hits: [hit(DUO, '400')] },
    ])
    expect(flattenHits(r, GENERAL).map((h) => h.id)).toEqual(['300', '200', '100'])
    expect(flattenHits(r, DUO).map((h) => h.id)).toEqual(['400'])
  })

  it('is empty for a conversation with no group of its own', () => {
    expect(flattenHits(result([{ conv: DUO, hits: [hit(DUO, '1')] }]), GENERAL)).toEqual([])
    expect(flattenHits({ groups: [], total: 0, capped: false }, GENERAL)).toEqual([])
  })

  it('keeps every hit — the dropdown’s per-conversation cap is not this one’s', () => {
    const hits = Array.from({ length: 40 }, (_, i) => hit(GENERAL, String(1000 + i)))
    expect(flattenHits(result([{ conv: GENERAL, hits }]), GENERAL)).toHaveLength(40)
  })

  it('keeps the newest MAX_HITS when there are more', () => {
    // Ids are HLC stems: same width, so lexicographic order is chronological.
    const hits = Array.from({ length: MAX_HITS + 25 }, (_, i) => hit(GENERAL, String(10_000 + i)))
    const flat = flattenHits(result([{ conv: GENERAL, hits }]), GENERAL)
    expect(flat).toHaveLength(MAX_HITS)
    expect(flat[0].id).toBe(String(10_000 + MAX_HITS + 24))
    expect(flat[flat.length - 1].id).toBe(String(10_000 + 25))
  })
})

describe('countLine', () => {
  it('counts matches when nothing was dropped', () => {
    expect(countLine(0, false, 0)).toBe('0 matches')
    expect(countLine(1, false, 1)).toBe('1 match')
    expect(countLine(12, false, 12)).toBe('12 matches')
  })

  it('says so when the cap hid the older hits', () => {
    expect(countLine(512, false, MAX_HITS)).toBe(`Showing the newest ${MAX_HITS} of 512`)
  })

  it('does not invent a total a truncated result never carried', () => {
    // searchMessages capped it itself: `total` is the kept count, and the hits
    // it dropped can no longer be counted — so the line stops at what is shown.
    expect(countLine(MAX_HITS, true, MAX_HITS)).toBe(`Showing the newest ${MAX_HITS}`)
  })
})

describe('moveCursor', () => {
  it('steps within the list', () => {
    expect(moveCursor(0, 1, 5)).toBe(1)
    expect(moveCursor(3, -1, 5)).toBe(2)
  })

  it('clamps instead of wrapping', () => {
    expect(moveCursor(4, 1, 5)).toBe(4)
    expect(moveCursor(0, -1, 5)).toBe(0)
  })

  it('pulls a stale cursor back into a list that shrank', () => {
    expect(moveCursor(9, 0, 3)).toBe(2)
  })

  it('answers 0 for an empty list', () => {
    expect(moveCursor(0, 1, 0)).toBe(0)
    expect(moveCursor(4, -1, 0)).toBe(0)
  })
})

describe('SCAN_ALL', () => {
  it('is past anything a conversation can hold, so the total stays honest', () => {
    expect(SCAN_ALL).toBeGreaterThan(MAX_HITS)
    expect(Number.isSafeInteger(SCAN_ALL)).toBe(true)
  })
})
