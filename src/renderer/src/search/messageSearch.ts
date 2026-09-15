import type { ConvId } from '@shared/types'
import type { MessageView } from '@shared/merge'
import { diagramTitleOf } from '@shared/diagram'
import { pollQuestionFor } from '@shared/poll'

// Message search for the quick switcher (1.6). Pure — no React, no DOM, no
// bridge — so the decisions (what is searchable, what counts as a match, which
// hits survive the cap, what the snippet reads like) are unit-testable and the
// component is left with nothing but rendering.
//
// The store already prefetches every log this client can read (store/index.ts
// loadTeam), so "search every conversation" needs no new I/O and no share
// format change: it is a fold over what is already in memory. What it does need
// is to stay cheap while somebody types — hence the folded-once index per
// conversation, keyed on that conversation's event count (an edit or a delete
// is itself an appended event, so the count moves whenever the text can).

/** Below this many typed characters the Messages section stays closed. */
export const MIN_QUERY_CHARS = 2

/** Newest hits kept across the whole team. Beyond this the note says so. */
export const MAX_HITS = 200

/** Hits shown per conversation before the "N more…" row. */
export const HITS_PER_CONV = 3

/** How long the typing pause is before a search runs. */
export const SEARCH_DEBOUNCE_MS = 150

export interface Range {
  start: number
  end: number
}

export interface IndexedMessage {
  id: string
  hlcMs: number
  authorName: string
  /** The searchable text — also the snippet source. Empty when there are no words to search. */
  text: string
  /** What the row shows when `text` is empty (a GIF, a bare attachment). Never searched. */
  placeholder: string
  /** `text`, folded. */
  folded: string
  /** folded offset -> offset in `text` (one extra sentinel entry at the end). */
  map: number[]
  /** `authorName`, folded. */
  foldedAuthor: string
  authorMap: number[]
}

export interface ConvIndex {
  conv: ConvId
  messages: IndexedMessage[]
}

export interface Hit {
  conv: ConvId
  id: string
  hlcMs: number
  authorName: string
  text: string
  placeholder: string
  /** Matched spans in `text`, merged and ascending. */
  ranges: Range[]
  /** Matched spans in `authorName`. */
  authorRanges: Range[]
}

export interface HitGroup {
  conv: ConvId
  hits: Hit[]
}

export interface SearchResult {
  groups: HitGroup[]
  /** Hits actually returned (never more than the cap). */
  total: number
  /** True when the cap threw older hits away. */
  capped: boolean
}

export const EMPTY_RESULT: SearchResult = { groups: [], total: 0, capped: false }

// ---------------------------------------------------------------------------
// Folding

const MARKS = /\p{M}/gu
const WORD_CHAR = /[\p{L}\p{N}_]/u

/**
 * Case- and accent-insensitive form: NFD, drop the combining marks, lowercase.
 * "Café" and "CAFE" fold to the same thing, which is what somebody typing into
 * a search box means by them.
 */
export function foldText(s: string): string {
  return s.normalize('NFD').replace(MARKS, '').toLowerCase()
}

/**
 * The same fold, plus the offset map back into the source string — folding is
 * not length-preserving ("ﬁ", "İ", a decomposed "é"), and a highlight that is
 * off by one character is worse than no highlight at all.
 *
 * Folding character by character is equivalent to folding the whole string: a
 * lone combining mark folds away to nothing either way, and no decomposition
 * this uses ever spans two source characters.
 */
export function foldWithMap(s: string): { folded: string; map: number[] } {
  let folded = ''
  const map: number[] = []
  let at = 0
  for (const ch of s) {
    const f = foldText(ch)
    for (let k = 0; k < f.length; k++) map.push(at)
    folded += f
    at += ch.length
  }
  map.push(s.length) // sentinel, so map[folded.length] is a real end offset
  return { folded, map }
}

function toSource(map: number[], srcLen: number, from: number, to: number): Range {
  const start = map[from] ?? srcLen
  const end = map[to] ?? srcLen
  const lastStart = map[to - 1] ?? start
  return { start, end: Math.max(end, lastStart + 1) }
}

/**
 * The words in a query. Everything that is not a letter, digit or underscore
 * separates, so "ship it!" is two terms and "c++" is one.
 */
export function tokenizeQuery(q: string): string[] {
  const out: string[] = []
  for (const raw of foldText(q).split(/[^\p{L}\p{N}_]+/u)) {
    if (raw && !out.includes(raw)) out.push(raw)
  }
  return out
}

// ---------------------------------------------------------------------------
// What a message contributes

/**
 * The words a message is searchable by — deliberately not `snippetOf`:
 *
 *  - a diagram's `body.text` is the sentence written for pre-1.2 clients
 *    ("📐 Diagram: X — update Chat to view it"), so searching it would match
 *    every diagram on the word "update";
 *  - a poll's is the pre-1.3 equivalent, same trap one version on.
 *
 * Both are indexed by the thing a person would actually remember: the title,
 * and the question.
 */
export function searchableTextOf(m: MessageView): string {
  if (m.deleted) return ''
  if (m.body.kind === 'diagram') return collapse(diagramTitleOf(m.body.text))
  if (m.body.kind === 'poll') return collapse(pollQuestionFor(m.body))
  if (m.body.kind === 'gif') return ''
  return collapse(m.body.text)
}

/** What a hit row shows when the message has no searchable words of its own. */
export function placeholderOf(m: MessageView): string {
  if (m.body.kind === 'gif') return 'GIF'
  if (m.attachments.length === 1) return m.attachments[0].name
  if (m.attachments.length > 1) return `${m.attachments.length} files`
  return 'message'
}

function collapse(s: string): string {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Fold one conversation's materialized messages once. Deleted messages are left
 * out entirely: a tombstone has no text, and surfacing "message deleted" rows
 * in a search is an invitation to wonder what they said.
 */
export function buildConvIndex(conv: ConvId, messages: readonly MessageView[]): ConvIndex {
  const out: IndexedMessage[] = []
  for (const m of messages) {
    if (m.deleted) continue
    const text = searchableTextOf(m)
    const body = foldWithMap(text)
    const author = foldWithMap(m.authorName)
    out.push({
      id: m.id,
      hlcMs: m.hlcMs,
      authorName: m.authorName,
      text,
      placeholder: placeholderOf(m),
      folded: body.folded,
      map: body.map,
      foldedAuthor: author.folded,
      authorMap: author.map,
    })
  }
  return { conv, messages: out }
}

// ---------------------------------------------------------------------------
// Matching

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && WORD_CHAR.test(c)
}

/**
 * Where `term` starts a word in `folded`. Whole words and word *prefixes* only:
 * "hel" finds "hello", "ello" does not — a substring search over a whole team's
 * history matches far too much to be useful.
 */
function wordStarts(folded: string, term: string): number[] {
  const out: number[] = []
  let from = 0
  for (;;) {
    const i = folded.indexOf(term, from)
    if (i === -1) break
    if (!isWordChar(folded[i - 1])) out.push(i)
    from = i + 1
  }
  return out
}

function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length < 2) return ranges
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Range[] = [sorted[0]]
  for (const r of sorted.slice(1)) {
    const last = out[out.length - 1]
    if (r.start <= last.end) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}

/**
 * Every term has to appear (AND), in the body or in the author's name — the two
 * together are one haystack, so "ana ship" finds Ana's message about shipping.
 * Null means this message is not a hit.
 */
export function matchRanges(
  entry: IndexedMessage,
  terms: readonly string[],
): { ranges: Range[]; authorRanges: Range[] } | null {
  if (terms.length === 0) return null
  const ranges: Range[] = []
  const authorRanges: Range[] = []
  for (const term of terms) {
    const inBody = wordStarts(entry.folded, term)
    const inAuthor = wordStarts(entry.foldedAuthor, term)
    if (inBody.length === 0 && inAuthor.length === 0) return null
    for (const i of inBody) ranges.push(toSource(entry.map, entry.text.length, i, i + term.length))
    for (const i of inAuthor)
      authorRanges.push(toSource(entry.authorMap, entry.authorName.length, i, i + term.length))
  }
  return { ranges: mergeRanges(ranges), authorRanges: mergeRanges(authorRanges) }
}

// ---------------------------------------------------------------------------
// Search

/**
 * Every hit across every indexed conversation, newest first, grouped by
 * conversation — the groups in the order their newest hit fell, which is what
 * "where was that, again" wants to see first.
 *
 * The cap is global and takes the newest: an old conversation cannot push a
 * message from this morning off the list.
 */
export function searchMessages(
  indexes: readonly ConvIndex[],
  terms: readonly string[],
  opts: { max?: number } = {},
): SearchResult {
  if (terms.length === 0) return EMPTY_RESULT
  const max = opts.max ?? MAX_HITS
  const all: Hit[] = []
  for (const idx of indexes) {
    for (const entry of idx.messages) {
      const m = matchRanges(entry, terms)
      if (!m) continue
      all.push({
        conv: idx.conv,
        id: entry.id,
        hlcMs: entry.hlcMs,
        authorName: entry.authorName,
        text: entry.text,
        placeholder: entry.placeholder,
        ranges: m.ranges,
        authorRanges: m.authorRanges,
      })
    }
  }
  // Event ids are HLC stems: lexicographic order is chronological order, and it
  // is the only order every client agrees on.
  all.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  const kept = all.slice(0, max)
  const byConv = new Map<ConvId, Hit[]>()
  for (const hit of kept) {
    const list = byConv.get(hit.conv)
    if (list) list.push(hit)
    else byConv.set(hit.conv, [hit])
  }
  return {
    groups: [...byConv.entries()].map(([conv, hits]) => ({ conv, hits })),
    total: kept.length,
    capped: all.length > kept.length,
  }
}

// ---------------------------------------------------------------------------
// Snippet

export interface Snippet {
  text: string
  marks: Range[]
}

export interface Segment {
  text: string
  mark: boolean
}

/**
 * One line of the message, centred on its first match, with the matched spans
 * carried across. Never returns markup: the caller renders the segments as
 * elements, so nothing a teammate typed can become HTML.
 */
export function snippetAround(text: string, ranges: readonly Range[], width = 96): Snippet {
  if (text.length <= width) return { text, marks: clampAll(ranges, 0, text.length, 0) }
  const first = ranges.length > 0 ? ranges[0] : { start: 0, end: 0 }
  const centre = Math.floor((first.start + first.end) / 2)
  let start = Math.max(0, centre - Math.floor(width / 2))
  let end = Math.min(text.length, start + width)
  start = Math.max(0, end - width)
  // Prefer a word boundary, but never at the cost of hiding the match itself.
  if (start > 0) {
    const sp = text.indexOf(' ', start)
    if (sp !== -1 && sp + 1 <= first.start && sp - start < 16) start = sp + 1
  }
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end)
    if (sp >= first.end && end - sp < 16) end = sp
  }
  const head = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  const body = text.slice(start, end)
  return { text: head + body + tail, marks: clampAll(ranges, start, end, head.length - start) }
}

function clampAll(ranges: readonly Range[], from: number, to: number, shift: number): Range[] {
  const out: Range[] = []
  for (const r of ranges) {
    const start = Math.max(r.start, from)
    const end = Math.min(r.end, to)
    if (end > start) out.push({ start: start + shift, end: end + shift })
  }
  return out
}

/** Split text into plain/marked runs — the shape a React row maps over. */
export function segmentsOf(text: string, ranges: readonly Range[]): Segment[] {
  const out: Segment[] = []
  let at = 0
  for (const r of ranges) {
    const start = Math.max(at, Math.min(r.start, text.length))
    const end = Math.max(start, Math.min(r.end, text.length))
    if (start > at) out.push({ text: text.slice(at, start), mark: false })
    if (end > start) out.push({ text: text.slice(start, end), mark: true })
    at = end
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false })
  return out
}

/** The line a hit row renders: the snippet when there is one, else the placeholder. */
export function hitSegments(hit: Hit, width = 96): Segment[] {
  if (hit.text === '') return [{ text: hit.placeholder, mark: false }]
  const snip = snippetAround(hit.text, hit.ranges, width)
  return segmentsOf(snip.text, snip.marks)
}

// ---------------------------------------------------------------------------
// Dates

export type DayBucket = 'today' | 'yesterday' | 'week' | 'older'

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function dayBucket(ms: number, now: number): DayBucket {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return 'week'
  return 'older'
}

/** "14:32" / "Yesterday" / "Tue" / "14 Mar" — the date a hit row shows. */
export function relativeDateLabel(ms: number, now: number = Date.now()): string {
  const d = new Date(ms)
  switch (dayBucket(ms, now)) {
    case 'today':
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    case 'yesterday':
      return 'Yesterday'
    case 'week':
      return d.toLocaleDateString(undefined, { weekday: 'short' })
    default:
      return d.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        ...(d.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
      })
  }
}
