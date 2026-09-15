// Chat-pane shared helpers: entity detection, paste heuristics, attachment
// preprocessing, and the pane's injected CSS (keyframes + hover behaviors).

import type { AttachDraft } from '@shared/bridge'
import type { BodyEntity } from '@shared/types'
import type { MessageView, SysView } from '@shared/merge'
import { EVENT } from '@shared/constants'
import { diagramPreview } from '@shared/diagram'
import { pollPreview } from '@shared/poll'
import { formatBytes } from '@/ui/atoms'
import { firstLinkOf } from '@/content/parse'

export const EMPTY: never[] = []

export interface ChipData {
  hostname: string
  fingerprint: string
  warn: boolean
}

export const UNKNOWN_CHIP: ChipData = { hostname: 'unknown', fingerprint: '????', warn: false }

/** Event-id stems start with a 13-digit HLC millisecond timestamp. */
export function hlcMsOf(stem: string): number {
  const n = Number(stem.slice(0, 13))
  return Number.isFinite(n) ? n : 0
}

export function dayKeyOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

export function formatFullDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** One-line preview of a message, for reply quotes and the composer bar. */
export function snippetOf(m: MessageView): string {
  if (m.deleted) return 'message deleted'
  if (m.body.kind === 'gif') return 'GIF'
  // `body.text` on a diagram is the fallback sentence a 1.1 client prints
  // ("📐 Diagram: X — update Chat to view it"). Quoting that back at a 1.2 user
  // tells them to update the app they are running; name the diagram instead.
  if (m.body.kind === 'diagram') return diagramPreview(m.body.text)
  // Same trap one version on: a poll's `body.text` is the "update Chat to vote"
  // line written for pre-1.3 clients. Quote the question.
  if (m.body.kind === 'poll') return pollPreview(m.body)
  if (m.body.kind === 'code') return m.body.text.split('\n')[0]?.trim() || 'code block'
  if (m.body.text.trim()) return m.body.text.replace(/\s+/g, ' ').trim()
  if (m.attachments.length > 0)
    return m.attachments.length === 1 ? m.attachments[0].name : `${m.attachments.length} files`
  return 'message'
}

/**
 * What the row's **Copy text** puts on the clipboard.
 *
 * For everything with words of its own that is `body.text`, byte for byte —
 * newlines and indentation included, which is the whole point of copying a code
 * block. For a diagram or a poll it must not be: `body.text` there is the
 * sentence written for clients too old to render the thing ("…— update Chat to
 * vote"), so copying a poll pasted an instruction to update the app into
 * whatever the person was writing. They get the same one-line preview a reply
 * quote shows.
 */
export function copyTextOf(m: MessageView): string {
  if (m.body.kind === 'diagram') return diagramPreview(m.body.text)
  if (m.body.kind === 'poll') return pollPreview(m.body)
  return m.body.text
}

// ---------------------------------------------------------------------------
// Entities

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g

/** The URL the preview is fetched for: the same one the body will linkify. */
export function firstUrlOf(text: string): string | null {
  return firstLinkOf(text)
}

export function detectEntities(text: string, roster: { name: string; device: string }[]): BodyEntity[] {
  const out: BodyEntity[] = []
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index
    if (start === undefined) continue
    out.push({ type: 'link', url: m[0], start, end: start + m[0].length })
  }
  const taken: [number, number][] = []
  const overlaps = (s: number, e: number): boolean => taken.some(([a, b]) => s < b && e > a)
  for (const m of text.matchAll(/@here\b/g)) {
    const start = m.index
    if (start === undefined) continue
    out.push({ type: 'mention', special: 'here', start, end: start + 5 })
    taken.push([start, start + 5])
  }
  // Longest names first so "Ana Ruiz" wins over a hypothetical "Ana".
  const sorted = [...roster].filter((r) => r.name.trim().length > 0).sort((a, b) => b.name.length - a.name.length)
  for (const r of sorted) {
    const needle = '@' + r.name
    let from = 0
    for (;;) {
      const i = text.indexOf(needle, from)
      if (i === -1) break
      const end = i + needle.length
      const after = text[end]
      if (!overlaps(i, end) && (after === undefined || !/[\w@]/.test(after))) {
        out.push({ type: 'mention', device: r.device, start: i, end })
        taken.push([i, end])
      }
      from = i + 1
    }
  }
  out.sort((a, b) => a.start - b.start)
  return out
}

// ---------------------------------------------------------------------------
// Paste-as-code heuristic

export function looksLikeCode(text: string): boolean {
  const lines = text.split('\n')
  if (lines.length < 3) return false
  const nonEmpty = lines.filter((l) => l.trim().length > 0)
  if (nonEmpty.length < 3) return false
  let signal = 0
  for (const l of nonEmpty) {
    if (/^(\s{2,}|\t)/.test(l)) signal++
    if (/[{}();[\]]\s*$/.test(l.trimEnd())) signal++
    if (
      /^\s*(import|export|function|const|let|var|def|class|return|if|else|for|while|fn|pub|#include|package|using|public|private|async|await)\b/.test(
        l,
      )
    )
      signal++
    if (/=>|::|->|===|!==|&&|\|\||<\/|\/>/.test(l)) signal++
  }
  return signal >= nonEmpty.length
}

// ---------------------------------------------------------------------------
// Attachment preprocessing (thumbnails + dimensions, all best-effort)

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      setTimeout(() => rej(new Error('timeout')), ms)
    }),
  ])
}

function makeThumb(source: CanvasImageSource, w: number, h: number): string | undefined {
  if (!w || !h) return undefined
  const scale = Math.min(1, 48 / Math.max(w, h))
  const cw = Math.max(1, Math.round(w * scale))
  const ch = Math.max(1, Math.round(h * scale))
  const c = document.createElement('canvas')
  c.width = cw
  c.height = ch
  const ctx = c.getContext('2d')
  if (!ctx) return undefined
  try {
    ctx.drawImage(source, 0, 0, cw, ch)
    for (const q of [0.6, 0.35]) {
      const uri = c.toDataURL('image/webp', q)
      if (uri.length <= EVENT.maxThumbBytes) return uri
    }
  } catch {
    /* tainted/undecodable — thumb is optional */
  }
  return undefined
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image()
    img.onload = () => res(img)
    img.onerror = () => rej(new Error('image-decode'))
    img.src = url
  })
}

export async function buildAttachment(file: File): Promise<AttachDraft> {
  const draft: AttachDraft = { path: window.bridge.files.pathForFile(file) }
  const url = URL.createObjectURL(file)
  try {
    if (file.type.startsWith('image/')) {
      const img = await withTimeout(loadImage(url), 4000)
      draft.w = img.naturalWidth
      draft.h = img.naturalHeight
      const t = makeThumb(img, img.naturalWidth, img.naturalHeight)
      if (t) draft.thumb = t
    } else if (file.type.startsWith('video/')) {
      const v = document.createElement('video')
      v.preload = 'auto'
      v.muted = true
      v.src = url
      await withTimeout(
        new Promise<void>((res, rej) => {
          v.onloadedmetadata = () => res()
          v.onerror = () => rej(new Error('video-metadata'))
        }),
        4000,
      )
      if (v.videoWidth) draft.w = v.videoWidth
      if (v.videoHeight) draft.h = v.videoHeight
      if (Number.isFinite(v.duration)) draft.durMs = Math.round(v.duration * 1000)
      // First-frame thumb, best-effort: wait briefly for decodable data.
      await new Promise<void>((res) => {
        if (v.readyState >= 2) {
          res()
          return
        }
        v.onloadeddata = () => res()
        setTimeout(res, 2000)
      })
      if (v.readyState >= 2 && draft.w && draft.h) {
        const t = makeThumb(v, draft.w, draft.h)
        if (t) draft.thumb = t
      }
      v.removeAttribute('src')
    }
  } catch {
    /* dimensions/thumb are optional — path alone is a valid attachment */
  } finally {
    URL.revokeObjectURL(url)
  }
  return draft
}

// ---------------------------------------------------------------------------
// System rows

export function sysLine(sys: SysView, nameOf: (device: string) => string): string {
  const str = (k: string): string | undefined =>
    typeof sys.data[k] === 'string' ? (sys.data[k] as string) : undefined
  const author = nameOf(sys.authorDevice)
  switch (sys.kind) {
    case 'channel-created':
      return `${author} created this channel`
    case 'channel-renamed':
      return `${author} renamed this channel${str('name') ? ` to #${str('name')}` : ''}`
    case 'topic-changed':
      return `${author} set the topic${str('topic') ? `: “${str('topic')}”` : ''}`
    case 'name-changed':
      return `${str('prev') ?? author} is now known as ${str('name') ?? author}`
    case 'beam-receipt': {
      const size = typeof sys.data.size === 'number' ? ` · ${formatBytes(sys.data.size)}` : ''
      return `⚡ ${author} received ${str('name') ?? 'a file'}${size}`
    }
    case 'purge-blob':
      return `a shared file was cleaned up by retention`
    case 'screenshare':
      return `${author} started sharing their screen`
    case 'screenshare-ended':
      return `screen share ended`
    // 1.2 — channel lifecycle and private groups
    case 'channel-deleted':
      return `${author} deleted this channel`
    case 'group-invite':
      return `${author} added you to 🔒 ${str('name') ?? 'a private group'}`
    case 'group-rekey':
      return `🔒 ${str('name') ?? 'group'} keys were rotated`
    case 'group-created': {
      const n = Array.isArray(sys.data.members) ? (sys.data.members as unknown[]).length : 0
      return `${author} created this private group${n ? ` with ${n} member${n === 1 ? '' : 's'}` : ''}`
    }
    case 'group-renamed':
      return `${author} renamed this group${str('name') ? ` to ${str('name')}` : ''}`
    case 'group-members-added': {
      const list = Array.isArray(sys.data.members) ? (sys.data.members as unknown[]) : []
      const names = list.filter((d): d is string => typeof d === 'string').map(nameOf)
      return `${author} added ${names.length ? names.join(', ') : 'members'}`
    }
    case 'group-member-removed':
      return `${author} removed ${str('member') ? nameOf(str('member')!) : 'a member'}`
    case 'group-left':
      return `${author} left the group`
    case 'group-deleted':
      return `${author} deleted this group`
    // 1.3 — live boards
    case 'board-live':
      return `${author} opened a live board${str('title') ? `: ${str('title')}` : ''}`
    case 'board-ended':
      return `${author} ended the live board${str('title') ? ` ${str('title')}` : ''}`
    // 1.5 — team settings
    case 'team-renamed':
      return `${author} renamed the team${str('name') ? ` to ${str('name')}` : ''}`
    case 'group-removed':
      return `You were removed from 🔒 ${str('name') ?? 'a private group'}`
    default:
      // A kind from a newer build. Never `undefined` on the row: an unknown
      // notice reads as one neutral line rather than an empty gap — the exact
      // failure this whole event type exists to avoid on 1.1.
      return 'something changed in this conversation'
  }
}

// ---------------------------------------------------------------------------
// Injected pane CSS (keyframes + hover-only affordances)

export const CHAT_CSS = `
@keyframes sem-pop-in { from { transform: scale(0.97) translateY(6px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes sem-tdot { 0%, 60%, 100% { transform: none; } 30% { transform: translateY(-4px); } }
@keyframes sem-bob { 0%, 100% { transform: translateY(-3px); } 50% { transform: translateY(3px); } }
/* Centred variant of chrome.tsx's sem-rise, for absolutely-positioned pills that
   sit at left:50%. It must NOT be called sem-rise: this stylesheet is injected
   inside ChatPane, later in document order than ChromeCss, so a duplicate name
   would replace the chrome keyframes document-wide and translate every other
   riser (PrAlert, the sidebar popover, BeamSurface) 50% of its own width left. */
@keyframes sem-rise-center { from { transform: translate(-50%, 8px); opacity: 0; } to { transform: translate(-50%, 0); opacity: 1; } }
@keyframes sem-shimmer { from { background-position: -200px 0; } to { background-position: 200px 0; } }
@keyframes sem-scale-in { from { transform: scale(0.96); opacity: 0; } to { transform: none; opacity: 1; } }
.sem-row { position: relative; }
.sem-row:hover { background: color-mix(in srgb, var(--bg-raised) 55%, transparent); }
.sem-pop { animation: sem-pop-in 180ms var(--ease-pop); }
.sem-toolbar { opacity: 0; transform: translateX(-2px); pointer-events: none; }
.sem-row:hover .sem-toolbar, .sem-toolbar[data-open='1'] {
  opacity: 1; transform: none; pointer-events: auto;
  transition: opacity var(--t-instant) var(--ease-standard), transform var(--t-instant) var(--ease-standard);
}
.sem-gutter-ts { opacity: 0; }
.sem-row:hover .sem-gutter-ts { opacity: 1; }
.sem-selectable, .sem-selectable * { user-select: text; }
.sem-composer { border: 1px solid var(--border-subtle); transition: border-color var(--t-fast) var(--ease-standard); }
.sem-composer:focus-within { border-color: color-mix(in srgb, var(--accent) 55%, var(--border-strong)); }
.sem-jump { animation: sem-rise-center 200ms var(--ease-glide); }
.sem-popover { animation: sem-scale-in 200ms var(--ease-pop); transform-origin: bottom right; }
.sem-skel {
  background: linear-gradient(90deg, var(--bg-raised) 25%, var(--bg-panel) 37%, var(--bg-raised) 63%);
  background-size: 400px 100%; animation: sem-shimmer 1.4s linear infinite;
}
.sem-chipbtn { transition: border-color var(--t-instant) var(--ease-standard), background var(--t-instant) var(--ease-standard); }
.sem-chipbtn:hover { border-color: var(--border-strong) !important; }
.sem-emoji-btn { transition: background var(--t-instant) var(--ease-standard); }
.sem-emoji-btn:hover { background: var(--accent-soft); }
.sem-mention-row[data-active='1'] { background: var(--accent-soft); }
.sem-hello:hover { background: var(--accent-soft); border-color: var(--accent) !important; }
@keyframes sem-chip-pop { 0% { transform: scale(0.6); } 60% { transform: scale(1.15); } 100% { transform: none; } }
.sem-chip-in { animation: sem-chip-pop 260ms var(--ease-pop); }
.sem-reaction { transition: transform var(--t-instant) var(--ease-standard), border-color var(--t-instant) var(--ease-standard); }
.sem-reaction:hover { transform: translateY(-1px); border-color: var(--border-strong); }
.sem-danger-btn:hover { background: var(--danger-soft) !important; }
.sem-typing-dot { animation: sem-tdot 1.2s infinite; }
@media (prefers-reduced-motion: reduce) {
  .sem-typing-dot, .sem-bob-glyph, .sem-skel { animation: none !important; }
}
`
