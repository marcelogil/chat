import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import type { ConvId } from '@shared/types'
import { TEAM_CONV } from '@shared/constants'
import { isTeamConv } from '@shared/ids'
import { materialize } from '@shared/merge'
import { useStore, selfOf } from '@/store'
import {
  EMPTY_RESULT,
  MIN_QUERY_CHARS,
  SEARCH_DEBOUNCE_MS,
  buildConvIndex,
  hitSegments,
  relativeDateLabel,
  searchMessages,
  segmentsOf,
  tokenizeQuery,
  type ConvIndex,
  type Segment,
} from '@/search/messageSearch'
import { buildSwitcherRows, type ConvMeta, type Item, type Row } from '@/search/switcherRows'
import { Avatar, identityHue } from '@/ui/atoms'
import { modKey, truncate } from './chrome'
import { IconCalendar, IconGitPull, IconLock, IconSearch } from './icons'
import { openDm } from './dm'
import { PREVIOUS_DEVICE, peopleRows } from './peopleRows'
import { preferFreshestTwin } from './twinDevices'

// Sidebar quick switcher (spec §2.2.2): ⌘K/Ctrl-K focuses it; fuzzy-matches
// channels and people; ↑↓ navigate, ⏎ opens, Esc dismisses.
//
// Since 1.6 it also searches *inside* every conversation this client holds
// (search/messageSearch.ts): the store already prefetches every log for the
// unread badges, so the whole team's history is in memory and searching it
// costs no share I/O and no main-process round trip. Opening a hit hands the
// store a `pendingJump`, which the target conversation's MessageList consumes
// once its log is in (search/jump.ts).

const NO_INDEXES: ConvIndex[] = []

/** The fixed team destinations — always searchable, they have no list to join. */
const TEAM_ITEMS: { conv: ConvId; label: string; sub: string; icon: ReactNode }[] = [
  { conv: TEAM_CONV.calendar, label: 'Calendar', sub: 'team', icon: <IconCalendar size={14} /> },
  { conv: TEAM_CONV.prs, label: 'Pull requests', sub: 'team', icon: <IconGitPull size={14} /> },
]

function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let qi = 0
  let score = 0
  let last = -2
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      score += last === i - 1 ? 3 : 1
      if (i === 0) score += 2
      last = i
      qi++
    }
  }
  return qi === q.length ? score - t.length * 0.01 : null
}

export default function QuickSwitcher() {
  const channels = useStore((s) => s.channels)
  const groups = useStore((s) => s.groups)
  const presence = useStore((s) => s.presence)
  const events = useStore((s) => s.events)
  const myReads = useStore((s) => s.myReads)
  const unreadCount = useStore((s) => s.unreadCount)
  const boot = useStore((s) => s.boot)
  const setActiveConv = useStore((s) => s.setActiveConv)
  const jumpToMessage = useStore((s) => s.jumpToMessage)
  const self = selfOf(boot)

  const people = useMemo(
    () =>
      peopleRows(preferFreshestTwin(presence), self?.deviceId ?? '', {
        hasHistory: (conv) => (events[conv] ?? []).some((e) => e.type === 'msg'),
        unread: (conv) => unreadCount(conv),
      }),
    // events/myReads are what unreadCount reads; listing them keeps the memo honest.
    [presence, self?.deviceId, unreadCount, events, myReads],
  )

  const [q, setQ] = useState('')
  const [focused, setFocused] = useState(false)
  const [sel, setSel] = useState(0)
  const [expanded, setExpanded] = useState<readonly string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const items = useMemo<Item[]>(() => {
    if (!q.trim()) return []
    const out: Item[] = []
    for (const ch of channels) {
      const s = fuzzyScore(q, ch.name)
      if (s !== null)
        out.push({ key: `c:${ch.conv}`, kind: 'channel', label: ch.name, sub: ch.topic || 'channel', conv: ch.conv, score: s + 0.5 })
    }
    for (const t of TEAM_ITEMS) {
      const s = fuzzyScore(q, t.label)
      if (s !== null)
        out.push({ key: `t:${t.conv}`, kind: 'team', label: t.label, sub: t.sub, conv: t.conv, icon: t.icon, score: s + 0.5 })
    }
    for (const g of groups) {
      const s = fuzzyScore(q, g.name)
      if (s !== null)
        out.push({ key: `g:${g.conv}`, kind: 'group', label: g.name, sub: 'private group', conv: g.conv, score: s + 0.5 })
    }
    // The same rows the sidebar's DM list shows, under the same names (1.4):
    // a device superseded by a re-join is searchable exactly while its DM
    // still holds history, and then as "Gil (previous device)" — the sidebar
    // keeps that conversation reachable, and ⌘K was the one way to reach a
    // conversation that could not find it. `preferFreshestTwin` settles the
    // seconds before main can tell the two apart (twinDevices.ts).
    for (const row of people) {
      const p = row.person
      const s = fuzzyScore(q, row.label) ?? fuzzyScore(q, p.hostname)
      if (s !== null)
        out.push({
          key: `p:${p.deviceId}`,
          kind: 'person',
          label: row.label,
          sub: `${p.hostname} · ${p.supersededBy ? 'no longer on the share' : p.state}`,
          peerDeviceId: p.deviceId,
          score: s,
        })
    }
    out.sort((a, b) => b.score - a.score)
    return out.slice(0, 8)
  }, [q, channels, groups, people])

  // ---------------------------------------------------------------- messages

  // Searching every log on every keystroke would rebuild the folded index of a
  // whole team's history between two characters. The debounce is what makes the
  // box feel like a box rather than a search engine.
  const [typed, setTyped] = useState('')
  useEffect(() => {
    if (q.trim().length < MIN_QUERY_CHARS) {
      setTyped('')
      return undefined
    }
    const t = window.setTimeout(() => setTyped(q), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [q])

  const terms = useMemo(() => tokenizeQuery(typed), [typed])
  const searching = terms.length > 0

  /**
   * conv → what to call it. Also the guest list: a conversation nothing can
   * name (a channel that was deleted, a DM with someone presence has never
   * seen) is left out rather than shown as an opaque id.
   */
  const convMeta = useMemo(() => {
    const map = new Map<string, ConvMeta>()
    // No `#`/lock prefix here: ConvGlyph already draws that marker beside the
    // label wherever this is shown, so baking it into the text too would show
    // it twice (channel headers used to read "##general").
    for (const c of channels) map.set(c.conv, { label: c.name, kind: 'channel' })
    for (const g of groups) map.set(g.conv, { label: g.name, kind: 'group' })
    for (const p of presence)
      map.set(p.dmConv, {
        label: p.supersededBy ? `${p.name} ${PREVIOUS_DEVICE}` : p.name,
        kind: 'dm',
      })
    return map
  }, [channels, groups, presence])

  // One folded index per conversation, rebuilt only when that conversation's
  // event count moves — an edit or a delete is itself an appended event, so the
  // count changes whenever the text can. Nothing is built at all until somebody
  // is actually searching.
  const indexCache = useRef(new Map<string, { count: number; index: ConvIndex }>())
  const indexes = useMemo<ConvIndex[]>(() => {
    if (!searching) return NO_INDEXES
    const cache = indexCache.current
    const out: ConvIndex[] = []
    const live = new Set<string>()
    for (const conv of Object.keys(events)) {
      // The team panes (calendar, pull requests) are not chat: their logs carry
      // `cal`/`prs` records that materialize elsewhere entirely.
      if (isTeamConv(conv) || !convMeta.has(conv)) continue
      live.add(conv)
      const list = events[conv] ?? []
      const cached = cache.get(conv)
      if (cached && cached.count === list.length) {
        out.push(cached.index)
        continue
      }
      const index = buildConvIndex(conv as ConvId, materialize(list).messages)
      cache.set(conv, { count: list.length, index })
      out.push(index)
    }
    for (const key of [...cache.keys()]) if (!live.has(key)) cache.delete(key)
    return out
  }, [events, convMeta, searching])

  const result = useMemo(
    () => (searching ? searchMessages(indexes, terms) : EMPTY_RESULT),
    [indexes, terms, searching],
  )

  // Pure composition (search/switcherRows.ts): which lines render, in what
  // order, and which of them are addressable — `rows[line.index]` for every
  // `{kind:'row'}` line, headers and the section note carrying no index at all.
  const { lines, rows } = useMemo(
    () => buildSwitcherRows(items, result, convMeta, expanded),
    [items, result, convMeta, expanded],
  )

  useEffect(() => {
    setSel(0)
    setExpanded([])
  }, [q])

  // The debounced search lands one render after the typing that caused it, so
  // the cursor can be left pointing past the end of a list that just shrank.
  useEffect(() => {
    setSel((s) => (s < rows.length ? s : Math.max(0, rows.length - 1)))
  }, [rows.length])

  // Keep the cursor visible once the list is long enough to scroll.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-row-index="${sel}"]`)
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' })
  }, [sel, lines])

  function dismiss() {
    setQ('')
    setTyped('')
    setExpanded([])
    inputRef.current?.blur()
  }

  function openItem(it: Item) {
    if ((it.kind === 'channel' || it.kind === 'team' || it.kind === 'group') && it.conv) setActiveConv(it.conv)
    else if (it.peerDeviceId) void openDm(it.peerDeviceId)
    dismiss()
  }

  function activate(row: Row) {
    if (row.kind === 'item') {
      openItem(row.item)
      return
    }
    if (row.kind === 'hit') {
      void jumpToMessage(row.conv, row.hit.id)
      dismiss()
      return
    }
    // "N more…" expands its group in place: the switcher stays open, and the
    // cursor stays where it was so ↓ walks straight into what just appeared.
    setExpanded((prev) => (prev.includes(row.conv) ? prev : [...prev, row.conv]))
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(s + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      const row = rows[sel]
      if (row) activate(row)
    } else if (e.key === 'Escape') {
      dismiss()
    }
  }

  const open = focused && rows.length > 0
  // With message hits in it the panel outgrows the 260px sidebar: a one-line
  // snippet centred on the match is useless if the match is past the ellipsis.
  // It overhangs the conversation pane, which is what a dropdown is for.
  const wide = result.groups.length > 0

  return (
    <div style={{ position: 'relative', padding: '8px 8px 4px' }}>
      <div style={{ position: 'relative' }}>
        <span
          style={{
            position: 'absolute',
            left: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--text-3)',
            pointerEvents: 'none',
          }}
        >
          <IconSearch size={14} />
        </span>
        <input
          ref={inputRef}
          className="sem-input"
          style={{ paddingLeft: 28, paddingRight: 38 }}
          placeholder="Jump to…"
          aria-label={`Quick switcher — press ${modKey}K`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            right: 6,
            top: '50%',
            transform: 'translateY(-50%)',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            fontWeight: 500,
            color: 'var(--text-3)',
            background: 'var(--bg-raised)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--r-xs)',
            padding: '1px 5px',
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          {modKey}K
        </span>
      </div>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label="Quick switcher results"
          className="sem-frost"
          style={{
            position: 'absolute',
            top: 42,
            left: 8,
            ...(wide ? { width: 'min(460px, calc(100vw - 300px))' } : { right: 8 }),
            zIndex: 60,
            borderRadius: 'var(--r-lg)',
            border: '1px solid var(--border-subtle)',
            boxShadow: 'var(--elev-2)',
            overflowY: 'auto',
            maxHeight: 'min(62vh, 440px)',
            padding: 4,
            animation: 'sem-pop var(--t-fast) var(--ease-standard)',
          }}
        >
          {lines.map((line) => {
            if (line.kind === 'section')
              return (
                <div
                  key={line.key}
                  role="presentation"
                  data-search-section="messages"
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 8,
                    padding: '8px 8px 2px',
                    borderTop: '1px solid var(--border-subtle)',
                    marginTop: 4,
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      color: 'var(--text-3)',
                    }}
                  >
                    Messages
                  </span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                    {line.capped ? `showing the newest ${line.total}` : `${line.total} found`}
                  </span>
                </div>
              )
            if (line.kind === 'header')
              return (
                <div
                  key={line.key}
                  role="presentation"
                  data-search-conv={line.conv}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px 2px' }}
                >
                  <ConvGlyph meta={line.meta} />
                  <span style={{ ...truncate, fontSize: 12, fontWeight: 600, color: 'var(--text-2)', flex: 1, minWidth: 0 }}>
                    {line.meta.label}
                  </span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-3)', flexShrink: 0 }}>
                    {line.count} hit{line.count === 1 ? '' : 's'}
                  </span>
                </div>
              )
            const { row, index } = line
            const selected = index === sel
            if (row.kind === 'item')
              return (
                <ItemRow
                  key={line.key}
                  item={row.item}
                  index={index}
                  selected={selected}
                  onHover={setSel}
                  onPick={() => activate(row)}
                />
              )
            if (row.kind === 'hit')
              return (
                <HitRow
                  key={line.key}
                  row={row}
                  index={index}
                  selected={selected}
                  onHover={setSel}
                  onPick={() => activate(row)}
                />
              )
            return (
              <button
                key={line.key}
                role="option"
                aria-selected={selected}
                data-row-index={index}
                title={`Show ${row.n} more result${row.n === 1 ? '' : 's'} in ${row.meta.label}`}
                className="sem-row"
                onMouseEnter={() => setSel(index)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  activate(row)
                }}
                style={{
                  width: '100%',
                  gap: 8,
                  padding: '4px 8px 6px 34px',
                  textAlign: 'left',
                  borderRadius: 'var(--r-sm)',
                  fontSize: 11.5,
                  color: 'var(--accent-text)',
                  background: selected ? 'var(--accent-soft)' : 'transparent',
                }}
              >
                {row.n} more…
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function ConvGlyph({ meta }: { meta: ConvMeta }) {
  const style: CSSProperties = {
    width: 18,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: identityHue(meta.label),
    filter: 'saturate(0.6)',
  }
  if (meta.kind === 'channel')
    return (
      <span aria-hidden="true" style={{ ...style, fontWeight: 600, fontSize: 13 }}>
        #
      </span>
    )
  if (meta.kind === 'group')
    return (
      <span aria-hidden="true" style={style}>
        <IconLock size={12} />
      </span>
    )
  return (
    <span aria-hidden="true" style={{ ...style, filter: 'none' }}>
      <Avatar name={meta.label} size={16} />
    </span>
  )
}

function ItemRow({
  item,
  index,
  selected,
  onHover,
  onPick,
}: {
  item: Item
  index: number
  selected: boolean
  onHover: (i: number) => void
  onPick: () => void
}) {
  return (
    <button
      role="option"
      aria-selected={selected}
      data-row-index={index}
      title={
        item.kind === 'channel'
          ? `Open #${item.label}`
          : item.kind === 'team' || item.kind === 'group'
            ? `Open ${item.label}`
            : `Message ${item.label}`
      }
      className="sem-row"
      onMouseEnter={() => onHover(index)}
      onMouseDown={(e) => {
        e.preventDefault()
        onPick()
      }}
      style={{
        width: '100%',
        height: 34,
        gap: 10,
        padding: '0 8px',
        borderRadius: 'var(--r-sm)',
        background: selected ? 'var(--accent-soft)' : 'transparent',
      }}
    >
      {item.kind === 'channel' ? (
        <span
          aria-hidden="true"
          style={{
            width: 20,
            textAlign: 'center',
            fontWeight: 600,
            fontSize: 14,
            color: identityHue(item.label),
            filter: 'saturate(0.6)',
            flexShrink: 0,
          }}
        >
          #
        </span>
      ) : item.kind === 'team' ? (
        <span
          aria-hidden="true"
          style={{
            width: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-3)',
            flexShrink: 0,
          }}
        >
          {item.icon}
        </span>
      ) : item.kind === 'group' ? (
        <span
          aria-hidden="true"
          style={{
            width: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: identityHue(item.label),
            filter: 'saturate(0.6)',
            flexShrink: 0,
          }}
        >
          <IconLock size={14} />
        </span>
      ) : (
        <Avatar name={item.label} size={20} />
      )}
      <span style={{ ...truncate, color: 'var(--text-1)', fontSize: 13, flex: 1, minWidth: 0 }}>{item.label}</span>
      <span style={{ ...truncate, color: 'var(--text-3)', fontSize: 11, maxWidth: 110 }}>{item.sub}</span>
    </button>
  )
}

/**
 * One message hit. Everything a teammate wrote is rendered as text nodes —
 * `<mark>` elements around the matched spans, never a string of HTML — so a
 * message containing markup stays a message containing markup.
 */
function HitRow({
  row,
  index,
  selected,
  onHover,
  onPick,
}: {
  row: Extract<Row, { kind: 'hit' }>
  index: number
  selected: boolean
  onHover: (i: number) => void
  onPick: () => void
}) {
  const { hit, meta } = row
  return (
    <button
      role="option"
      aria-selected={selected}
      data-row-index={index}
      data-search-hit="1"
      data-conv={row.conv}
      title={`Jump to this message in ${meta.label}`}
      className="sem-row"
      onMouseEnter={() => onHover(index)}
      onMouseDown={(e) => {
        e.preventDefault()
        onPick()
      }}
      style={{
        display: 'block',
        width: '100%',
        padding: '4px 8px 5px 34px',
        textAlign: 'left',
        borderRadius: 'var(--r-sm)',
        background: selected ? 'var(--accent-soft)' : 'transparent',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
        <span style={{ ...truncate, fontSize: 12, fontWeight: 600, color: 'var(--text-1)', maxWidth: 180 }}>
          <Marked segments={segmentsOf(hit.authorName, hit.authorRanges)} />
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--text-3)', flexShrink: 0 }}>{relativeDateLabel(hit.hlcMs)}</span>
      </span>
      <span style={{ ...truncate, display: 'block', fontSize: 12, color: 'var(--text-2)' }}>
        <Marked segments={hitSegments(hit, 72)} />
      </span>
    </button>
  )
}

function Marked({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((seg, i) =>
        seg.mark ? (
          <mark
            key={i}
            style={{
              background: 'var(--accent-soft)',
              color: 'var(--accent-text)',
              borderRadius: 2,
              padding: '0 1px',
            }}
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  )
}
