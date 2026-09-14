import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent, KeyboardEvent } from 'react'
import type { ConvId } from '@shared/types'
import type { SendDraft } from '@shared/bridge'
import type { MessageView } from '@shared/merge'
import { quickSendFeedback } from '@shared/quickSendFeedback'
import { useStore, selfOf } from '@/store'
import { preferFreshestTwin } from '@/app/twinDevices'
import { toast } from '@/app/toasts'
import { Avatar, DeviceChip, IconButton } from '@/ui/atoms'
import { GifPicker } from '@/content/GifPicker'
import { DiagramButton } from '@/diagram/DiagramButton'
import { PollButton } from '@/poll/PollButton'
import { QuickRepliesRow } from './QuickRepliesRow'
import { CODE_LANGUAGES, readStoredLang, writeStoredLang } from '@/content/languages'
import { detectEntities, firstUrlOf, looksLikeCode, snippetOf, withTimeout } from './util'
import { ClockIcon, CloseIcon, CodeIcon, GifIcon, SendIcon } from './icons'

// The composer (spec §2.1 min 44px, §4.4 paste-as-code, §4.5 GIF anchor):
// auto-grow textarea, mention autocomplete, code mode, link previews,
// typing beacon, reply bar, queued-send honesty.

export interface ComposerApi {
  insert(text: string): void
  focus(): void
}

const MAX_TA_HEIGHT = 8 * 20 + 10 // ~8 lines

interface MentionCand {
  key: string
  label: string
  device?: string
  special?: 'here'
  hostname?: string
  fingerprint?: string
}

interface Props {
  conv: ConvId
  label: string
  replyTarget: MessageView | null
  onClearReply: () => void
  onEditLast: () => void
  apiRef: { current: ComposerApi | null }
}

export function Composer({ conv, label, replyTarget, onClearReply, onEditLast, apiRef }: Props) {
  const presence = useStore((s) => s.presence)
  const boot = useStore((s) => s.boot)
  const outboxQueued = useStore((s) => s.outboxQueued)
  const send = useStore((s) => s.send)
  const self = selfOf(boot)

  const [text, setText] = useState('')
  const [codeMode, setCodeMode] = useState(false)
  const [pasteChip, setPasteChip] = useState(false)
  const [gifOpen, setGifOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const [mention, setMention] = useState<{ at: number; q: string } | null>(null)
  const [sel, setSel] = useState(0)
  // The code-block language: a sticky preference (localStorage), not reset
  // per-conversation like the rest of the draft state below.
  const [lang, setLangState] = useState<string | null>(() => readStoredLang())
  const [langOpen, setLangOpen] = useState(false)
  const langBtnRef = useRef<HTMLButtonElement>(null)

  const taRef = useRef<HTMLTextAreaElement>(null)
  const typingAt = useRef(0)
  const idleTimer = useRef<number | null>(null)
  const caretAfter = useRef<number | null>(null)

  const setLang = useCallback((id: string | null) => {
    setLangState(id)
    writeStoredLang(id)
  }, [])

  // Reset per conversation.
  useEffect(() => {
    setText('')
    setCodeMode(false)
    setPasteChip(false)
    setGifOpen(false)
    setMention(null)
    setFailed(false)
    setLangOpen(false)
    typingAt.current = 0
    taRef.current?.focus()
    return () => {
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current)
      void window.bridge.chat.setTyping(null).catch(() => {})
    }
  }, [conv])

  // The language dropdown only makes sense while the chip that opens it is on
  // screen (code mode, or the paste-as-code chip below) — closing either must
  // not leave a stale open popover for the next time one appears.
  useEffect(() => {
    if (!codeMode && !pasteChip) setLangOpen(false)
  }, [codeMode, pasteChip])

  useEffect(() => {
    apiRef.current = {
      insert(t: string) {
        setText((prev) => prev + t)
        taRef.current?.focus()
      },
      focus() {
        taRef.current?.focus()
      },
    }
    return () => {
      apiRef.current = null
    }
  }, [apiRef])

  // Auto-grow.
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TA_HEIGHT)}px`
  }, [text, codeMode])

  // Restore caret after a mention insert.
  useEffect(() => {
    if (caretAfter.current !== null && taRef.current) {
      taRef.current.setSelectionRange(caretAfter.current, caretAfter.current)
      caretAfter.current = null
    }
  }, [text])

  const roster = useMemo(() => {
    const out: { name: string; device: string }[] = []
    const seen = new Set<string>()
    if (self) {
      out.push({ name: self.displayName, device: self.deviceId })
      seen.add(self.deviceId)
    }
    // Departed devices are left out on purpose: `detectEntities` binds "@Ana"
    // to the first roster row with that name and stops, so a stale
    // registration sharing a name with a live one (the same person re-joined
    // after a reset — 1.4) would swallow every mention of them and the person
    // who is actually there would never be notified. `preferFreshestTwin`
    // covers the seconds before main can prove the stale one is stale
    // (twinDevices.ts) — the freshest beacon takes the name.
    for (const p of preferFreshestTwin(presence.filter((x) => !x.departed))) {
      if (!seen.has(p.deviceId) && p.name) {
        out.push({ name: p.name, device: p.deviceId })
        seen.add(p.deviceId)
      }
    }
    return out
  }, [presence, self])

  const cands = useMemo<MentionCand[]>(() => {
    if (!mention) return []
    const q = mention.q.toLowerCase()
    const out: MentionCand[] = []
    if ('here'.startsWith(q)) out.push({ key: 'here', label: 'here', special: 'here' })
    const seen = new Set<string>()
    const people = [
      ...(self
        ? [{ deviceId: self.deviceId, name: self.displayName, hostname: self.hostname, fingerprint: self.fingerprint }]
        : []),
      // Same list the mention *binding* reads, for the same reason.
      ...preferFreshestTwin(presence.filter((p) => !p.departed)).map((p) => ({
        deviceId: p.deviceId,
        name: p.name,
        hostname: p.hostname,
        fingerprint: p.fingerprint,
      })),
    ]
    for (const p of people) {
      if (seen.has(p.deviceId) || !p.name) continue
      seen.add(p.deviceId)
      const lower = p.name.toLowerCase()
      if (!q || lower.startsWith(q) || lower.includes(` ${q}`))
        out.push({ key: p.deviceId, label: p.name, device: p.deviceId, hostname: p.hostname, fingerprint: p.fingerprint })
    }
    return out.slice(0, 8)
  }, [mention, presence, self])

  useEffect(() => {
    setSel(0)
  }, [mention?.q])

  const updateMention = useCallback(
    (value: string, caret: number): void => {
      if (codeMode) {
        setMention(null)
        return
      }
      const upto = value.slice(0, caret)
      const m = /(^|[\s([{>])@([^\n@]{0,32})$/.exec(upto)
      if (m) setMention({ at: caret - m[2].length - 1, q: m[2] })
      else setMention(null)
    },
    [codeMode],
  )

  const pick = useCallback(
    (c: MentionCand): void => {
      if (!mention) return
      const el = taRef.current
      const caret = el ? el.selectionStart : text.length
      const insert = `@${c.label} `
      setText(text.slice(0, mention.at) + insert + text.slice(caret))
      caretAfter.current = mention.at + insert.length
      setMention(null)
      el?.focus()
    },
    [mention, text],
  )

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    const v = e.target.value
    setText(v)
    updateMention(v, e.target.selectionStart)
    if (v.trim()) {
      const now = Date.now()
      if (now - typingAt.current > 2500) {
        typingAt.current = now
        void window.bridge.chat.setTyping(conv).catch(() => {})
      }
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current)
      idleTimer.current = window.setTimeout(() => {
        void window.bridge.chat.setTyping(null).catch(() => {})
      }, 4000)
    }
  }

  const doSend = useCallback(
    async (asKind?: 'code'): Promise<void> => {
      const kind: SendDraft['kind'] = asKind ?? (codeMode ? 'code' : 'text')
      const body = kind === 'code' ? text.replace(/\s+$/, '') : text.trim()
      if (!body) return
      const target = replyTarget
      setText('')
      setPasteChip(false)
      setMention(null)
      if (target) onClearReply()
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current)
      typingAt.current = 0
      void window.bridge.chat.setTyping(null).catch(() => {})

      const draft: SendDraft = { text: body, kind }
      if (kind === 'code') {
        // null only for Auto-detect — every other choice (including the
        // paste-as-code chip, which just uses whatever is current) rides
        // through as the hljs id the language chip is set to.
        draft.lang = lang
      } else {
        const entities = detectEntities(body, roster)
        if (entities.length) draft.entities = entities
        const url = firstUrlOf(body)
        if (url) {
          try {
            draft.linkPreview = await withTimeout(window.bridge.links.preview(url), 3500)
          } catch {
            /* preview is optional — send without it */
          }
        }
      }
      if (target) draft.replyTo = target.id
      try {
        await send(conv, draft)
        setFailed(false)
      } catch {
        setFailed(true)
      }
    },
    [text, codeMode, lang, replyTarget, roster, conv, send, onClearReply],
  )

  // Quick replies (inline chip row above the composer): Option/Alt-click on a
  // chip inserts its text at the caret — same caret-aware replace-selection
  // shape as `pick` above, reusing the same `caretAfter` ref so the cursor
  // lands after the inserted text once the textarea re-renders.
  const insertQuickMessage = useCallback(
    (msg: string): void => {
      const el = taRef.current
      const start = el ? el.selectionStart : text.length
      const end = el ? el.selectionEnd : text.length
      setText(text.slice(0, start) + msg + text.slice(end))
      caretAfter.current = start + msg.length
      el?.focus()
    },
    [text],
  )

  // A plain click on a chip: send it immediately as its own text message,
  // independent of whatever is currently drafted (the draft is left alone).
  // Mirrors doSend's plain-text branch (entity detection, best-effort link
  // preview) without touching the reply target — a quick status ping is not a
  // reply, and it should not clear one that is queued. The typing beacon *is*
  // cleared, exactly like doSend: typing and then deleting a draft (which is
  // what brings this row back on screen) leaves the beacon live for 4s, and
  // teammates should not still see "…is typing" after the reply has landed.
  const sendQuickMessage = useCallback(
    async (msg: string): Promise<void> => {
      const body = msg.trim()
      if (!body) return
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current)
      typingAt.current = 0
      void window.bridge.chat.setTyping(null).catch(() => {})
      const draft: SendDraft = { text: body, kind: 'text' }
      const entities = detectEntities(body, roster)
      if (entities.length) draft.entities = entities
      const url = firstUrlOf(body)
      if (url) {
        try {
          draft.linkPreview = await withTimeout(window.bridge.links.preview(url), 3500)
        } catch {
          /* preview is optional — send without it */
        }
      }
      try {
        await send(conv, draft)
        setFailed(false)
      } catch (err) {
        // The chip's text never went through the textarea, so there is nothing
        // on screen to retry from — say what happened out loud, and only claim
        // "queued" when it really was queued (shared/quickSendFeedback.ts).
        const fb = quickSendFeedback(body, err)
        if (fb.queued) setFailed(true)
        toast(fb.text, fb.tone)
      }
    },
    [roster, conv, send],
  )

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mention && cands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((s) => (s + 1) % cands.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((s) => (s - 1 + cands.length) % cands.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pick(cands[sel] ?? cands[0])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMention(null)
        return
      }
    }
    if (e.key === 'Escape') {
      if (pasteChip) {
        setPasteChip(false)
        return
      }
      if (gifOpen) {
        setGifOpen(false)
        return
      }
      if (replyTarget) {
        onClearReply()
        return
      }
    }
    if (e.key === 'Enter') {
      const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
      const hard = (e.metaKey || e.ctrlKey) && !e.shiftKey
      if (pasteChip && (plain || hard)) {
        e.preventDefault()
        void doSend('code')
        return
      }
      if (codeMode) {
        if (hard) {
          e.preventDefault()
          void doSend()
        }
        return // plain Enter inserts a newline in code mode
      }
      if (plain || hard) {
        e.preventDefault()
        void doSend()
        return
      }
    }
    if (e.key === 'ArrowUp' && text === '' && !codeMode) {
      e.preventDefault()
      onEditLast()
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const t = e.clipboardData.getData('text/plain')
    if (t && !codeMode && looksLikeCode(t)) setPasteChip(true)
  }

  const canSend = text.trim().length > 0
  const mono = codeMode || pasteChip
  const selectedLang = useMemo(() => CODE_LANGUAGES.find((l) => l.id === lang) ?? CODE_LANGUAGES[0], [lang])

  return (
    <div style={{ position: 'relative' }}>
      {/* Mention autocomplete */}
      {mention && cands.length > 0 && (
        <div
          className="sem-popover"
          role="listbox"
          aria-label="Mention someone"
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            marginBottom: 8,
            width: 300,
            maxHeight: 236,
            overflowY: 'auto',
            background: 'var(--bg-raised)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--r-md)',
            boxShadow: 'var(--elev-3)',
            padding: 4,
            zIndex: 25,
          }}
        >
          {cands.map((c, i) => (
            <div
              key={c.key}
              className="sem-mention-row"
              role="option"
              aria-selected={i === sel}
              data-active={i === sel ? 1 : 0}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(c)
              }}
              onMouseEnter={() => setSel(i)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 8px',
                borderRadius: 'var(--r-sm)',
                cursor: 'pointer',
                fontSize: 13,
                color: 'var(--text-1)',
              }}
            >
              {c.special === 'here' ? (
                <>
                  <span style={{ color: 'var(--accent-text)', fontWeight: 600 }}>@here</span>
                  <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Notify everyone online</span>
                </>
              ) : (
                <>
                  <Avatar name={c.label} size={20} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
                  {c.hostname && c.fingerprint && <DeviceChip hostname={c.hostname} fingerprint={c.fingerprint} />}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* GIF picker */}
      {gifOpen && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 30 }} onMouseDown={() => setGifOpen(false)} />
          <div className="sem-popover" style={{ position: 'absolute', bottom: '100%', right: 0, marginBottom: 10, zIndex: 31 }}>
            <GifPicker
              onSend={(d) => {
                void send(conv, d).catch(() => setFailed(true))
              }}
              onClose={() => setGifOpen(false)}
            />
          </div>
        </>
      )}

      {/* Reply bar */}
      {replyTarget && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '5px 8px 5px 10px',
            marginBottom: 6,
            background: 'var(--bg-raised)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--r-md)',
            fontSize: 12,
            minWidth: 0,
          }}
        >
          <span style={{ width: 2, alignSelf: 'stretch', background: 'var(--accent)', borderRadius: 1, flexShrink: 0 }} />
          <span style={{ color: 'var(--text-2)', flexShrink: 0 }}>
            Replying to <b>{replyTarget.authorName}</b>
          </span>
          <span
            style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-3)' }}
          >
            {snippetOf(replyTarget)}
          </span>
          <IconButton label="Cancel reply" size={20} onClick={onClearReply}>
            <CloseIcon size={11} />
          </IconButton>
        </div>
      )}

      {/* Paste-as-code chip */}
      {pasteChip && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '5px 10px',
            marginBottom: 6,
            background: 'var(--bg-raised)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--r-md)',
            fontSize: 12,
            color: 'var(--text-2)',
          }}
        >
          <span style={{ display: 'inline-flex', color: 'var(--accent-text)' }}>
            <CodeIcon size={13} />
          </span>
          Paste as code block?
          <button
            className="sem-chipbtn"
            title="Send as a code block"
            onClick={() => void doSend('code')}
            style={{
              padding: '2px 8px',
              borderRadius: 'var(--r-sm)',
              border: '1px solid var(--accent)',
              background: 'var(--accent-soft)',
              color: 'var(--accent-text)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            ⏎ Yes
          </button>
          <button
            className="sem-chipbtn"
            title="Keep as plain text"
            onClick={() => setPasteChip(false)}
            style={{
              padding: '2px 8px',
              borderRadius: 'var(--r-sm)',
              border: '1px solid var(--border-subtle)',
              background: 'transparent',
              color: 'var(--text-3)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Esc plain
          </button>
        </div>
      )}

      <QuickRepliesRow conv={conv} text={text} onInsert={insertQuickMessage} onSendNow={(t) => void sendQuickMessage(t)} />

      {/* Input row */}
      <div
        className="sem-composer"
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 4,
          padding: '7px 8px 7px 12px',
          background: 'var(--bg-input)',
          borderRadius: 'var(--r-lg)',
          minHeight: 44,
          boxSizing: 'border-box',
        }}
      >
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onSelect={(e) => updateMention(e.currentTarget.value, e.currentTarget.selectionStart)}
          placeholder={codeMode ? 'Type or paste code — ⌘⏎ sends' : `Message ${label}`}
          aria-label={`Message ${label}`}
          style={{
            flex: 1,
            minWidth: 0,
            resize: 'none',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'var(--text-1)',
            fontSize: mono ? 13 : 14,
            lineHeight: '20px',
            fontFamily: mono ? 'var(--font-mono)' : 'var(--font-ui)',
            padding: '4px 0',
            maxHeight: MAX_TA_HEIGHT,
            userSelect: 'text',
          }}
        />
        <IconButton
          label={codeMode ? 'Switch back to plain text' : 'Send as a code block'}
          active={codeMode}
          onClick={() => {
            setCodeMode((v) => !v)
            taRef.current?.focus()
          }}
        >
          <CodeIcon size={16} />
        </IconButton>
        {(codeMode || pasteChip) && (
          <div
            style={{ position: 'relative' }}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.stopPropagation()
              setLangOpen(false)
              langBtnRef.current?.focus()
            }}
          >
            <button
              ref={langBtnRef}
              type="button"
              className="sem-chip-btn sem-focus"
              aria-haspopup="listbox"
              aria-expanded={langOpen}
              title="Code block language"
              onClick={() => setLangOpen((v) => !v)}
              style={{ height: 28, padding: '0 10px', fontSize: 12, color: 'var(--text-2)', flexShrink: 0 }}
            >
              {selectedLang.label}
              <span aria-hidden style={{ fontSize: 9, color: 'var(--text-3)' }}>
                ▾
              </span>
            </button>
            {langOpen && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 30 }} onMouseDown={() => setLangOpen(false)} />
                <div
                  className="sem-popover"
                  role="listbox"
                  aria-label="Code block language"
                  style={{
                    position: 'absolute',
                    bottom: '100%',
                    right: 0,
                    marginBottom: 8,
                    width: 190,
                    maxHeight: 280,
                    overflowY: 'auto',
                    background: 'var(--bg-raised)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--r-md)',
                    boxShadow: 'var(--elev-3)',
                    padding: 4,
                    zIndex: 31,
                  }}
                >
                  {CODE_LANGUAGES.map((opt) => (
                    <button
                      key={opt.id ?? '\0auto'}
                      type="button"
                      role="option"
                      aria-selected={opt.id === lang}
                      className="sem-row sem-focus"
                      onClick={() => {
                        setLang(opt.id)
                        setLangOpen(false)
                        langBtnRef.current?.focus()
                      }}
                      style={{
                        width: '100%',
                        height: 28,
                        gap: 8,
                        padding: '0 8px',
                        borderRadius: 'var(--r-sm)',
                        fontSize: 13,
                        color: opt.id === lang ? 'var(--accent-text)' : 'var(--text-1)',
                        background: opt.id === lang ? 'var(--accent-soft)' : 'transparent',
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        <DiagramButton conv={conv} />
        <PollButton conv={conv} label={label} />
        <IconButton label="Send a GIF" active={gifOpen} onClick={() => setGifOpen((v) => !v)}>
          <GifIcon size={17} />
        </IconButton>
        <button
          title="Send message"
          aria-label="Send message"
          disabled={!canSend}
          onClick={() => void doSend()}
          style={{
            width: 28,
            height: 28,
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            borderRadius: 'var(--r-sm)',
            background: canSend ? 'var(--accent)' : 'transparent',
            color: canSend ? 'var(--on-accent)' : 'var(--text-3)',
            cursor: canSend ? 'pointer' : 'default',
            transition: 'background var(--t-fast) var(--ease-standard)',
          }}
        >
          <SendIcon size={15} />
        </button>
      </div>

      {/* Footer line: queued honesty + code-mode hint */}
      {(outboxQueued > 0 || failed || codeMode) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 5, fontSize: 11, minHeight: 16 }}>
          {(outboxQueued > 0 || failed) && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--warning)' }}>
              <ClockIcon size={12} />
              queued — will send when the folder is back
              {outboxQueued > 0 ? ` · ${outboxQueued} waiting` : ''}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {codeMode && (
            <span style={{ color: 'var(--text-3)', userSelect: 'none' }}>⏎ newline · ⌘⏎ send</span>
          )}
        </div>
      )}
    </div>
  )
}
