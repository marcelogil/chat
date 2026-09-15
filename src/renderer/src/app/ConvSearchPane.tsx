import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { ConvId } from '@shared/types'
import { materialize } from '@shared/merge'
import { useStore } from '@/store'
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
import { SCAN_ALL, countLine, flattenHits, moveCursor, searchLabelFor } from '@/search/convSearch'
import { truncate } from './chrome'
import { useGroupMap } from './dm'

// The right rail's Search tab (1.6.1): the same search the ⌘K box runs, aimed
// at one conversation instead of the whole team. "Where in #general did we
// decide that" is a different question from "where on the share was that", and
// the dropdown answers the second — it caps each conversation at three hits and
// closes the moment you look away from it.
//
// Same three guarantees as the quick switcher, for the same reason: it folds
// `store.events`, which `loadTeam()` already prefetched, so a search costs zero
// share I/O, is invisible to every other client, and can only ever reach what
// this device can already decrypt.

/** Widest snippet the 320px rail can show without the match falling off it. */
const SNIPPET_WIDTH = 84

/**
 * How long a row's `mousedown` gets to claim the `click` that follows it. Long
 * enough for the slowest real press-and-release, short enough that a mousedown
 * which never produced a click cannot swallow an unrelated one later.
 */
const MOUSEDOWN_CLAIM_MS = 300

export default function ConvSearchPane({ conv, onClose }: { conv: ConvId; onClose?: () => void }) {
  const channels = useStore((s) => s.channels)
  const groupMap = useGroupMap()
  const events = useStore((s) => s.events[conv])

  const channel = channels.find((c) => c.conv === conv)
  const group = groupMap[conv]
  // The header button carries this exact string too (searchLabelFor is the one
  // place it is built): the button and this input are one control.
  const label = channel
    ? searchLabelFor('channel', channel.name)
    : group
      ? searchLabelFor('group', group.name)
      : searchLabelFor('dm')

  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // `autoFocus` alone is not enough: the tab body is mounted into a panel that
  // is itself being shown, and a freshly shown subtree does not reliably win
  // the focus race. Asking again once costs nothing.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Re-folding a whole conversation between two keystrokes is what makes a
  // search box feel like a search engine. Same debounce as the ⌘K box.
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

  // One folded index, rebuilt only when this conversation's event count moves
  // (an edit or a delete is itself an appended event, so the count changes
  // whenever the text can), and not built at all until somebody searches. The
  // pane is keyed by `conv` in the rail, so the cache can never cross
  // conversations.
  const cache = useRef<{ count: number; index: ConvIndex } | null>(null)
  const result = useMemo(() => {
    if (terms.length === 0) return EMPTY_RESULT
    const list = events ?? []
    const cached = cache.current
    const index =
      cached && cached.count === list.length ? cached.index : buildConvIndex(conv, materialize(list).messages)
    cache.current = { count: list.length, index }
    // SCAN_ALL, not the default cap: with one conversation in the search the
    // count line wants the honest total, and flattenHits owns the cap.
    return searchMessages([index], terms, { max: SCAN_ALL })
  }, [conv, events, terms])

  const hits = useMemo(() => flattenHits(result, conv), [result, conv])

  useEffect(() => {
    setSel(0)
  }, [typed])

  // The debounced search lands one render after the typing that caused it, so
  // the cursor can be left pointing past the end of a list that just shrank.
  useEffect(() => {
    setSel((s) => moveCursor(s, 0, hits.length))
  }, [hits.length])

  // Keyed on the cursor and the row count, never on `hits` itself: that array
  // gets a new identity every time an event lands in this conversation, and
  // scrolling the cursor back into view on a teammate's message would yank the
  // list out from under someone reading the older matches.
  useEffect(() => {
    const el = listRef.current?.querySelectorAll('[data-conv-search-hit]')[sel]
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' })
  }, [sel, hits.length])

  /**
   * The pane deliberately stays open, query and all, after a jump: the point of
   * a scoped search is walking its results, and closing on the first one would
   * make the second cost the whole query again.
   */
  function jump(id: string) {
    void useStore.getState().jumpToMessage(conv, id)
  }

  // A row activates on `mousedown` so the jump lands before focus moves off the
  // input, and on `click` so anything driving the pane synthetically (or with
  // the keyboard's own click) still works. The pair a real mouse sends must
  // jump once, not twice — hence remembering which row the mousedown already
  // took, and letting that row's click through once.
  //
  // Time-bounded, because a mousedown is not promised a click: press a row,
  // drag off it, release, and a sticky flag would silently swallow the next
  // click-only activation of that same row (Enter on a focused row, or a
  // synthetic `row.click()`). A real click follows its mousedown within a
  // frame or two; anything later is a different gesture.
  const tookMouseDown = useRef<{ id: string; at: number } | null>(null)

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => moveCursor(s, 1, hits.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => moveCursor(s, -1, hits.length))
    } else if (e.key === 'Enter') {
      const hit = hits[sel]
      if (hit) {
        e.preventDefault()
        jump(hit.id)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      // Esc empties the box first and only then leaves — the same two-step the
      // fullscreen editor uses, so a typo never costs the whole panel.
      if (q === '') onClose?.()
      else setQ('')
    }
  }

  const short = q.trim().length < MIN_QUERY_CHARS
  const settled = !short && typed !== ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
      {/* The box stays put while the results scroll under it: with the cap at
          200 hits, a query you can no longer see is a query you have to
          retype. The negative margins pull it out of the rail's own 12px
          padding so it can sit flush against the top of the scrollport. */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 1,
          margin: '-12px -12px 0',
          padding: '12px 12px 4px',
          background: 'var(--bg-panel)',
        }}
      >
        <input
          ref={inputRef}
          className="sem-input"
          autoFocus
          placeholder="Find a message…"
          aria-label={label}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
      </div>

      {short ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '4px 2px' }}>
          Type at least {MIN_QUERY_CHARS} characters
        </div>
      ) : hits.length > 0 ? (
        <>
          <div
            data-conv-search-count={result.total}
            style={{ fontSize: 11, color: 'var(--text-3)', padding: '0 2px' }}
          >
            {countLine(result.total, result.capped, hits.length)}
          </div>
          <div ref={listRef} role="listbox" aria-label={label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {hits.map((hit, i) => (
              <button
                key={hit.id}
                role="option"
                aria-selected={i === sel}
                data-conv-search-hit="1"
                data-msg-id={hit.id}
                title="Jump to this message"
                className="sem-row"
                onMouseEnter={() => setSel(i)}
                onMouseDown={(e) => {
                  // Keeps the caret in the box, so ↑/↓ keep walking the results
                  // after a click.
                  e.preventDefault()
                  tookMouseDown.current = { id: hit.id, at: Date.now() }
                  jump(hit.id)
                }}
                onClick={() => {
                  const claim = tookMouseDown.current
                  tookMouseDown.current = null
                  if (claim && claim.id === hit.id && Date.now() - claim.at < MOUSEDOWN_CLAIM_MS) return
                  jump(hit.id)
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '6px 8px 7px',
                  textAlign: 'left',
                  borderRadius: 'var(--r-sm)',
                  border: '1px solid var(--border-subtle)',
                  background: i === sel ? 'var(--accent-soft)' : 'var(--bg-raised)',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
                  <span style={{ ...truncate, fontSize: 12, fontWeight: 600, color: 'var(--text-1)', minWidth: 0 }}>
                    {/* The name the author signed the message with — a device
                        that has since left the share still has to have one. */}
                    <Marked segments={segmentsOf(hit.authorName, hit.authorRanges)} />
                  </span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-3)', flexShrink: 0, marginLeft: 'auto' }}>
                    {relativeDateLabel(hit.hlcMs)}
                  </span>
                </span>
                {/* No `display` of its own: .sem-clamp2 is a -webkit-box, and
                    an inline display:block would beat that class and take the
                    two-line clamp with it. */}
                <span className="sem-clamp2" style={{ fontSize: 12, color: 'var(--text-2)' }}>
                  <Marked segments={hitSegments(hit, SNIPPET_WIDTH)} />
                </span>
              </button>
            ))}
          </div>
        </>
      ) : settled ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '4px 2px' }}>No messages match</div>
      ) : null}
    </div>
  )
}

/**
 * Matched spans as `<mark>` elements around text nodes — never a string of
 * HTML, so a message containing markup stays a message containing markup.
 */
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
