import { describe, expect, it } from 'vitest'
import type { ConvId } from '@shared/types'
import type { MessageView } from '@shared/merge'
import { diagramFallbackText } from '@shared/diagram'
import { pollFallbackText } from '@shared/poll'
import {
  buildConvIndex,
  dayBucket,
  foldText,
  foldWithMap,
  hitSegments,
  matchRanges,
  placeholderOf,
  relativeDateLabel,
  searchMessages,
  searchableTextOf,
  segmentsOf,
  snippetAround,
  tokenizeQuery,
} from './messageSearch'

// Message search for the quick switcher (1.6). Everything here is the pure
// half: what a message contributes, what counts as a match, which hits survive
// the cap, and what the snippet reads like.

let seq = 0

function msg(over: Partial<MessageView> & { body?: MessageView['body'] } = {}): MessageView {
  seq += 1
  return {
    id: `${String(1_700_000_000_000 + seq).padStart(13, '0')}-0001-aaaaaaaa`,
    conv: 'chan:general' as ConvId,
    authorDevice: 'aaaaaaaa',
    authorName: 'Ana Ruiz',
    hlcMs: 1_700_000_000_000 + seq,
    sentWall: 1_700_000_000_000 + seq,
    senderSeq: seq,
    body: { kind: 'text', text: 'hello there' },
    attachments: [],
    edited: false,
    deleted: false,
    pinned: false,
    verified: true,
    reactions: [],
    ...over,
  }
}

function index(conv: string, messages: MessageView[]) {
  return buildConvIndex(conv as ConvId, messages)
}

describe('foldText', () => {
  it('folds case and accents together', () => {
    expect(foldText('CAFÉ')).toBe('cafe')
    expect(foldText('Señor Ñandú')).toBe('senor nandu')
    // Already-decomposed input folds to the same thing as precomposed input.
    expect(foldText('cafe\u0301')).toBe(foldText('caf\u00e9'))
  })
})

describe('foldWithMap', () => {
  it('maps every folded offset back onto the source string', () => {
    const { folded, map } = foldWithMap('Café au lait')
    expect(folded).toBe('cafe au lait')
    // "au" is at the same offset in both here, but the decomposed source is
    // where a naive fold drifts.
    expect(map[folded.indexOf('au')]).toBe('Café au lait'.indexOf('au'))
  })

  it('keeps the map honest when folding shortens the string', () => {
    const src = 'cafe\u0301 au lait' // 'e' + combining acute: one char longer than its fold
    const { folded, map } = foldWithMap(src)
    expect(folded).toBe('cafe au lait')
    expect(map[folded.indexOf('au')]).toBe(src.indexOf('au'))
    expect(src.slice(map[folded.indexOf('lait')])).toBe('lait')
  })
})

describe('tokenizeQuery', () => {
  it('splits on anything that is not a word character, folds and dedupes', () => {
    expect(tokenizeQuery('  Ship   it! ')).toEqual(['ship', 'it'])
    expect(tokenizeQuery('CAFÉ café')).toEqual(['cafe'])
    expect(tokenizeQuery('   ')).toEqual([])
  })
})

describe('searchableTextOf', () => {
  it('indexes text and code by their body text', () => {
    expect(searchableTextOf(msg({ body: { kind: 'text', text: 'ship  it\n today' } }))).toBe('ship it today')
    expect(searchableTextOf(msg({ body: { kind: 'code', text: 'const x = 1', lang: 'ts' } }))).toBe('const x = 1')
  })

  it('indexes a diagram by its title, never the pre-1.2 fallback sentence', () => {
    const m = msg({ body: { kind: 'diagram', text: diagramFallbackText('Sprint plan') } })
    expect(searchableTextOf(m)).toBe('Sprint plan')
    expect(searchableTextOf(m)).not.toMatch(/update Chat/)
  })

  it('indexes a poll by its question, never the pre-1.3 fallback sentence', () => {
    const poll = {
      question: 'Ship on Friday?',
      options: [
        { id: 'yes', text: 'Yes' },
        { id: 'no', text: 'No' },
      ],
      multi: false,
      anonymous: false,
    }
    const m = msg({ body: { kind: 'poll', text: pollFallbackText(poll.question), poll } })
    expect(searchableTextOf(m)).toBe('Ship on Friday?')
    expect(searchableTextOf(m)).not.toMatch(/update Chat/)
  })

  it('has nothing to say about a GIF or a deleted message', () => {
    expect(searchableTextOf(msg({ body: { kind: 'gif', text: '', packId: 'wave' } }))).toBe('')
    expect(searchableTextOf(msg({ deleted: true, body: { kind: 'text', text: '' } }))).toBe('')
  })
})

describe('placeholderOf', () => {
  it('names what a wordless message actually is', () => {
    expect(placeholderOf(msg({ body: { kind: 'gif', text: '', packId: 'wave' } }))).toBe('GIF')
    expect(
      placeholderOf(msg({ attachments: [{ blobId: 'a', key: 'k', name: 'plan.pdf', size: 1, mime: 'application/pdf', sha256: 'f' }] })),
    ).toBe('plan.pdf')
  })
})

describe('buildConvIndex', () => {
  it('leaves deleted messages out entirely', () => {
    const idx = index('chan:general', [
      msg({ body: { kind: 'text', text: 'kept' } }),
      msg({ deleted: true, body: { kind: 'text', text: '' } }),
    ])
    expect(idx.messages).toHaveLength(1)
    expect(idx.messages[0].text).toBe('kept')
  })
})

describe('matchRanges', () => {
  const entry = (text: string, authorName = 'Ana Ruiz') =>
    index('chan:general', [msg({ body: { kind: 'text', text }, authorName })]).messages[0]

  it('matches whole words and word prefixes, but never mid-word', () => {
    expect(matchRanges(entry('hello there'), ['hell'])).not.toBeNull()
    expect(matchRanges(entry('hello there'), ['hello'])).not.toBeNull()
    expect(matchRanges(entry('hello there'), ['ello'])).toBeNull()
  })

  it('requires every term (AND), in any order', () => {
    expect(matchRanges(entry('the deploy is blocked'), ['deploy', 'blocked'])).not.toBeNull()
    expect(matchRanges(entry('the deploy is blocked'), ['blocked', 'deploy'])).not.toBeNull()
    expect(matchRanges(entry('the deploy is blocked'), ['deploy', 'friday'])).toBeNull()
  })

  it('ignores case and accents on both sides', () => {
    expect(matchRanges(entry('Está en el café'), ['esta', 'cafe'])).not.toBeNull()
    expect(matchRanges(entry('esta en el cafe'), tokenizeQuery('ESTÁ CAFÉ'))).not.toBeNull()
  })

  it('reports the matched spans against the original text', () => {
    const m = matchRanges(entry('the deploy is blocked'), ['blocked'])
    expect(m?.ranges).toEqual([{ start: 14, end: 21 }])
    expect('the deploy is blocked'.slice(14, 21)).toBe('blocked')
  })

  it('counts the author display name as part of the haystack', () => {
    const m = matchRanges(entry('the deploy is blocked'), ['ana', 'deploy'])
    expect(m).not.toBeNull()
    expect(m?.authorRanges).toEqual([{ start: 0, end: 3 }])
    expect(m?.ranges).toEqual([{ start: 4, end: 10 }])
  })

  it('never matches an empty term list', () => {
    expect(matchRanges(entry('anything'), [])).toBeNull()
  })
})

describe('searchMessages', () => {
  const alice = index('chan:general', [
    msg({ body: { kind: 'text', text: 'the deploy is blocked' } }),
    msg({ body: { kind: 'text', text: 'deploy again please' } }),
  ])
  const duo = index('grp:duo', [msg({ body: { kind: 'text', text: 'deploy the duo build' }, authorName: 'Bob' })])

  it('groups by conversation, newest hit first, newest conversation first', () => {
    const r = searchMessages([alice, duo], ['deploy'])
    expect(r.total).toBe(3)
    expect(r.capped).toBe(false)
    // `duo` holds the newest message of the three (the factory counts up).
    expect(r.groups.map((g) => g.conv)).toEqual(['grp:duo', 'chan:general'])
    const general = r.groups.find((g) => g.conv === 'chan:general')!
    expect(general.hits.map((h) => h.text)).toEqual(['deploy again please', 'the deploy is blocked'])
  })

  it('returns nothing for a term nobody wrote', () => {
    expect(searchMessages([alice, duo], ['zzzqqq'])).toEqual({ groups: [], total: 0, capped: false })
  })

  it('keeps the newest hits when the cap bites, and says so', () => {
    const many = index(
      'chan:general',
      Array.from({ length: 10 }, (_, i) => msg({ body: { kind: 'text', text: `deploy ${i}` } })),
    )
    const r = searchMessages([many], ['deploy'], { max: 3 })
    expect(r.total).toBe(3)
    expect(r.capped).toBe(true)
    expect(r.groups[0].hits.map((h) => h.text)).toEqual(['deploy 9', 'deploy 8', 'deploy 7'])
  })

  it('carries the conversation of the index it came from', () => {
    const r = searchMessages([duo], ['duo'])
    expect(r.groups[0].hits[0].conv).toBe('grp:duo')
    expect(r.groups[0].hits[0].authorName).toBe('Bob')
  })
})

describe('snippetAround', () => {
  const long = `${'padding words here '.repeat(8)}the deploy is blocked ${'trailing words '.repeat(8)}`.trim()

  it('returns short text untouched, marks and all', () => {
    const s = snippetAround('the deploy is blocked', [{ start: 14, end: 21 }])
    expect(s.text).toBe('the deploy is blocked')
    expect(s.marks).toEqual([{ start: 14, end: 21 }])
  })

  it('centres a long line on the first match and keeps the mark over it', () => {
    const at = long.indexOf('blocked')
    const s = snippetAround(long, [{ start: at, end: at + 7 }], 40)
    expect(s.text.length).toBeLessThanOrEqual(44)
    expect(s.text.startsWith('…')).toBe(true)
    expect(s.text.endsWith('…')).toBe(true)
    const mark = s.marks[0]
    expect(s.text.slice(mark.start, mark.end)).toBe('blocked')
  })

  it('drops marks that fall outside the window it chose', () => {
    const at = long.lastIndexOf('trailing')
    const s = snippetAround(long, [{ start: at, end: at + 8 }, { start: 0, end: 7 }], 40)
    expect(s.marks.every((r) => r.start >= 0 && r.end <= s.text.length)).toBe(true)
    expect(s.text.slice(s.marks[0].start, s.marks[0].end)).toBe('trailing')
  })
})

describe('segmentsOf', () => {
  it('splits into plain and marked runs, losing nothing', () => {
    const segs = segmentsOf('the deploy is blocked', [
      { start: 4, end: 10 },
      { start: 14, end: 21 },
    ])
    expect(segs.map((s) => s.text).join('')).toBe('the deploy is blocked')
    expect(segs.filter((s) => s.mark).map((s) => s.text)).toEqual(['deploy', 'blocked'])
  })

  it('hands back markup as text, never as markup', () => {
    const segs = segmentsOf('<img src=x onerror=alert(1)> deploy', [{ start: 29, end: 35 }])
    expect(segs[0]).toEqual({ text: '<img src=x onerror=alert(1)> ', mark: false })
    expect(segs[1]).toEqual({ text: 'deploy', mark: true })
  })
})

describe('hitSegments', () => {
  it('falls back to the placeholder when the message has no words', () => {
    const idx = index('chan:general', [msg({ body: { kind: 'gif', text: '', packId: 'wave' }, authorName: 'Ana' })])
    const r = searchMessages([idx], ['ana'])
    expect(hitSegments(r.groups[0].hits[0])).toEqual([{ text: 'GIF', mark: false }])
  })
})

describe('dayBucket', () => {
  const noon = new Date(2026, 2, 15, 12, 0, 0).getTime()
  const day = 86_400_000

  it('buckets by local calendar day, not by elapsed hours', () => {
    expect(dayBucket(new Date(2026, 2, 15, 0, 5).getTime(), noon)).toBe('today')
    expect(dayBucket(new Date(2026, 2, 14, 23, 55).getTime(), noon)).toBe('yesterday')
    expect(dayBucket(noon - 3 * day, noon)).toBe('week')
    expect(dayBucket(noon - 30 * day, noon)).toBe('older')
  })

  it('treats a clock that runs ahead as today rather than the future', () => {
    expect(dayBucket(noon + day, noon)).toBe('today')
  })
})

describe('relativeDateLabel', () => {
  it('names yesterday outright', () => {
    const now = new Date(2026, 2, 15, 12, 0, 0).getTime()
    expect(relativeDateLabel(new Date(2026, 2, 14, 9, 0, 0).getTime(), now)).toBe('Yesterday')
  })

  it('gives today a time and an older day a date', () => {
    const now = new Date(2026, 2, 15, 12, 0, 0).getTime()
    expect(relativeDateLabel(new Date(2026, 2, 15, 9, 30, 0).getTime(), now)).toMatch(/\d/)
    expect(relativeDateLabel(new Date(2025, 10, 2, 9, 30, 0).getTime(), now)).toMatch(/\d/)
  })
})
