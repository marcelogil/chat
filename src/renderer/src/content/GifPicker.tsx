import { useEffect, useMemo, useRef, useState } from 'react'
import type { SendDraft } from '@shared/bridge'
import { FilmIcon, SearchIcon } from './icons'
import { filterPack, packCategories, type GifItem } from './gifFilter'
import './content.css'

// Spec §4.5 — GIF picker popover. 380×440 frosted surface anchored by the
// caller. v1 honesty: the bundled pack is empty and search is offline, so the
// empty state carries the personality — but the plumbing is fully live and
// renders a 2-col grid the moment either source returns results.

const CATEGORIES = [
  { emoji: '\u{1F44D}', label: 'Nice' },
  { emoji: '\u{1F389}', label: 'Ship it' },
  { emoji: '\u{1F926}', label: 'Facepalm' },
  { emoji: '\u{1F440}', label: 'Looking' },
  { emoji: '\u{1F602}', label: 'LOL' },
  { emoji: '\u{1F64F}', label: 'Please' },
  { emoji: '☕', label: 'Monday' },
  { emoji: '\u{1F480}', label: 'Prod is down' },
]

function shuffled<T>(list: T[]): T[] {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export function GifPicker({
  onSend,
  onClose,
}: {
  onSend: (draft: SendDraft) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [online, setOnline] = useState<boolean | null>(null)
  const [results, setResults] = useState<GifItem[]>([])
  const [pack, setPack] = useState<GifItem[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const categories = useMemo(() => shuffled(CATEGORIES), [])
  const availableCategories = useMemo(() => packCategories(pack), [pack])
  const visibleCategories = categories.filter((c) => availableCategories.has(c.label.toLowerCase()))

  // Load the bundled pack + probe online reachability on open.
  useEffect(() => {
    let alive = true
    void window.bridge.gifs
      .packList()
      .then((items) => {
        if (alive)
          setPack(items.map((p) => ({ url: p.url, w: p.w, h: p.h, packId: p.id, category: p.category })))
      })
      .catch(() => {})
    void window.bridge.gifs
      .search('')
      .then((r) => {
        if (alive) setOnline(r.online)
      })
      .catch(() => {
        if (alive) setOnline(false)
      })
    inputRef.current?.focus()
    return () => {
      alive = false
    }
  }, [])

  // Debounced search.
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults([])
      return
    }
    const t = setTimeout(() => {
      void window.bridge.gifs
        .search(q)
        .then((r) => {
          setOnline(r.online)
          setResults(r.results.map((g) => ({ url: g.url, w: g.w, h: g.h })))
        })
        .catch(() => setResults([]))
    }, 250)
    return () => clearTimeout(t)
  }, [query])

  const q = query.trim().toLowerCase()
  const packMatches = filterPack(pack, query, activeCategory)
  const items: GifItem[] = results.length > 0 ? results : packMatches

  const send = (item: GifItem): void => {
    const draft: SendDraft = { text: item.url, kind: 'gif' }
    if (item.packId) draft.packId = item.packId
    onSend(draft)
    onClose()
  }

  return (
    <div
      className="sem-gifpicker"
      role="dialog"
      aria-label="GIF picker"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
      style={{
        width: 380,
        height: 440,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 'var(--r-xl)',
        border: '1px solid var(--border-subtle)',
        background: 'color-mix(in srgb, var(--bg-panel) 85%, transparent)',
        backdropFilter: 'blur(20px) saturate(1.2)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.2)',
        boxShadow: 'var(--elev-3)',
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      {/* Search field */}
      <div style={{ padding: '12px 12px 8px' }}>
        <div
          style={{
            height: 36,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 10px',
            borderRadius: 'var(--r-sm)',
            border: '1px solid var(--border-subtle)',
            background: 'var(--bg-input)',
            boxSizing: 'border-box',
          }}
        >
          <span style={{ color: 'var(--text-3)', display: 'inline-flex' }}>
            <SearchIcon size={15} />
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setActiveCategory(null)
              setQuery(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && items.length > 0) send(items[0])
            }}
            placeholder="Search GIFs"
            aria-label="Search GIFs"
            style={{
              flex: 1,
              minWidth: 0,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'var(--text-1)',
              fontSize: 13,
              fontFamily: 'var(--font-ui)',
            }}
          />
          <span
            title={
              online
                ? 'Online GIF search is reachable'
                : 'No internet reachable — searching the bundled pack only'
            }
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              flexShrink: 0,
              fontSize: 11,
              fontWeight: 500,
              color: 'var(--text-3)',
              padding: '2px 7px',
              borderRadius: 'var(--r-full)',
              background: 'var(--bg-raised)',
              border: '1px solid var(--border-subtle)',
              userSelect: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            {online && (
              <span
                aria-hidden
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--success)',
                }}
              />
            )}
            {online === null ? '…' : online ? 'GIPHY' : `Offline pack · ${pack.length}`}
          </span>
        </div>
      </div>

      {/* Category chips */}
      <div
        style={{
          display: 'flex',
          gap: 6,
          padding: '0 12px 10px',
          overflowX: 'auto',
          flexShrink: 0,
          scrollbarWidth: 'none',
        }}
      >
        {visibleCategories.map((c) => {
          const pressed = activeCategory === c.label
          return (
            <button
              key={c.label}
              className="sem-gif-chip"
              title={pressed ? `Clear the "${c.label}" filter` : `Filter by "${c.label}" GIFs`}
              aria-label={pressed ? `Clear the ${c.label} filter` : `Filter by ${c.label} GIFs`}
              aria-pressed={pressed}
              onClick={() => setActiveCategory((cur) => (cur === c.label ? null : c.label))}
              style={
                pressed
                  ? { background: 'var(--accent-soft)', color: 'var(--accent-text)', borderColor: 'var(--accent)' }
                  : undefined
              }
            >
              <span aria-hidden>{c.emoji}</span>
              {c.label}
            </button>
          )
        })}
      </div>

      {/* Grid or empty state */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 12px 12px' }}>
        {items.length > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
            {items.map((item, i) => (
              <button
                key={`${item.url}-${i}`}
                className="sem-gif-item"
                onClick={() => send(item)}
                title="Send this GIF"
                aria-label="Send this GIF"
              >
                <img src={item.url} alt="GIF result" loading="lazy" draggable={false} />
              </button>
            ))}
          </div>
        ) : (
          <div
            style={{
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              textAlign: 'center',
              padding: '0 28px',
              userSelect: 'none',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 56,
                height: 56,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 'var(--r-lg)',
                background: 'var(--accent-soft)',
                color: 'var(--accent-text)',
              }}
            >
              <FilmIcon size={26} />
            </span>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>
              {q || activeCategory ? 'Nothing in the vault for that' : 'No GIFs here yet'}
            </div>
            <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-3)' }}>
              Try another word, or drag any GIF into the chat.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
