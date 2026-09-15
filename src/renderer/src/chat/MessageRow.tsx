import { memo, useEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import type { ConvId } from '@shared/types'
import type { MessageView } from '@shared/merge'
import { Avatar, DeviceChip, formatTime } from '@/ui/atoms'
import { MessageBody } from '@/content/RichContent'
import { copyTextOf, formatFullDate, snippetOf, type ChipData } from './util'
import { ReplyIcon, PencilIcon, TrashIcon, CopyIcon, PinIcon, SmilePlusIcon } from './icons'

// One flat, full-width message row (spec §3.2): 36px avatar gutter, no
// bubbles, hover toolbar, reactions, reply quote, edit-in-place.

const QUICK_EMOJIS = ['\u{1F44D}', '\u{1F389}', '\u{1F440}']
const MINI_EMOJIS = [
  '\u{1F44D}', '\u{1F389}', '\u{1F440}', '❤️', '\u{1F602}', '\u{1F525}', '\u{1F680}', '✅',
  '\u{1F62E}', '\u{1F622}', '\u{1F64F}', '\u{1F4AF}', '\u{1F44F}', '\u{1F914}', '\u{1F605}', '\u{1FAE1}',
  '\u{1F973}', '\u{1F62D}', '\u{1F480}', '☕', '\u{1F41B}', '\u{1F6E0}️', '⚡', '\u{1F9E0}',
]

interface Props {
  conv: ConvId
  m: MessageView
  groupStart: boolean
  pop: boolean
  /** 1.6 — a quick-switcher jump landed here: highlight the row while it lasts. */
  flash?: boolean
  selfId: string
  chip: ChipData
  receipt: string | null
  isEditing: boolean
  getMessage: (id: string) => MessageView | undefined
  nameOf: (device: string) => string
  onReply: (id: string) => void
  onEditStart: (id: string) => void
  onEditDone: () => void
}

export const MessageRow = memo(function MessageRow({
  conv,
  m,
  groupStart,
  pop,
  flash = false,
  selfId,
  chip,
  receipt,
  isEditing,
  getMessage,
  nameOf,
  onReply,
  onEditStart,
  onEditDone,
}: Props) {
  const mine = m.authorDevice === selfId
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null)

  const react = (emoji: string): void => {
    const have = m.reactions.find((r) => r.emoji === emoji)?.devices.includes(selfId)
    void window.bridge.chat.react(conv, m.id, emoji, have ? 'remove' : 'add').catch(() => {})
  }

  const openPicker = (e: MouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const w = 8 * 30 + 16
    const x = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))
    const below = r.bottom + 6
    const y = below + 140 > window.innerHeight ? Math.max(8, r.top - 146) : below
    setPicker({ x, y })
  }

  const replyTarget = m.replyTo ? getMessage(m.replyTo) : undefined

  return (
    <div
      className={`sem-row${pop ? ' sem-pop' : ''}${flash ? ' sem-jump-flash' : ''}`}
      // The attribute is the highlight's whole contract: the CSS paints on it,
      // and the E2E drive looks for it to prove a jump actually landed — in the
      // right conversation, which is what `data-conv` is doing here (only the
      // active conversation's rows are ever in the DOM).
      data-jump-target={flash ? '1' : undefined}
      data-conv={conv}
      style={{ display: 'flex', gap: 12, padding: `${groupStart ? 12 : 2}px 16px 2px 16px` }}
    >
      {/* Gutter: avatar for group starts, hover timestamp for follow-ups */}
      <div
        style={{
          width: 36,
          flexShrink: 0,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-start',
        }}
      >
        {groupStart ? (
          <Avatar name={m.authorName} size={36} />
        ) : (
          <span
            className="sem-gutter-ts"
            title={formatFullDate(m.sentWall)}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-3)',
              lineHeight: '22px',
              userSelect: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            {formatTime(m.sentWall)}
          </span>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {groupStart && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 1, minWidth: 0 }}>
            <span
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: 'var(--text-1)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {m.authorName}
            </span>
            <DeviceChip hostname={chip.hostname} fingerprint={chip.fingerprint} warn={chip.warn} />
            <span
              title={formatFullDate(m.sentWall)}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)', flexShrink: 0 }}
            >
              {formatTime(m.sentWall)}
            </span>
            {m.verified === false && (
              <span
                title="Signature could not be verified against this device's pinned key"
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: 'var(--danger)',
                  background: 'var(--danger-soft)',
                  border: '1px solid var(--danger)',
                  borderRadius: 'var(--r-xs)',
                  padding: '0 4px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  userSelect: 'none',
                }}
              >
                unverified
              </span>
            )}
            {m.pinned && (
              <span title="Pinned in this conversation" style={{ color: 'var(--accent-text)', display: 'inline-flex' }}>
                <PinIcon size={12} />
              </span>
            )}
          </div>
        )}

        {/* Reply quote */}
        {replyTargetLine(m, replyTarget)}

        {isEditing ? (
          <EditBox conv={conv} id={m.id} initial={m.body.text} onDone={onEditDone} />
        ) : (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, minWidth: 0 }}>
            <div style={{ minWidth: 0, flex: '0 1 auto' }}>
              <MessageBody view={m} />
            </div>
            {m.edited && !m.deleted && (
              <span
                title="This message was edited"
                style={{ fontSize: 11, color: 'var(--text-3)', flexShrink: 0, paddingBottom: 3, userSelect: 'none' }}
              >
                (edited)
              </span>
            )}
          </div>
        )}

        {/* Reactions */}
        {!m.deleted && m.reactions.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
            {m.reactions.map((r) => {
              const mineR = r.devices.includes(selfId)
              const who = r.devices.map(nameOf).join(', ')
              return (
                <button
                  key={r.emoji}
                  className="sem-reaction sem-chip-in"
                  title={`${who} reacted with ${r.emoji}`}
                  aria-label={`${r.emoji} ${r.devices.length} — click to ${mineR ? 'remove your' : 'add your'} reaction`}
                  onClick={() => react(r.emoji)}
                  style={{
                    height: 24,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '0 8px',
                    borderRadius: 'var(--r-full)',
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily: 'var(--font-ui)',
                    cursor: 'pointer',
                    background: mineR ? 'var(--accent-soft)' : 'var(--bg-raised)',
                    border: `1px solid ${mineR ? 'var(--accent)' : 'var(--border-subtle)'}`,
                    color: 'var(--text-1)',
                  }}
                >
                  <span style={{ fontSize: 15, lineHeight: 1 }}>{r.emoji}</span>
                  {r.devices.length}
                </button>
              )
            })}
            <button
              className="sem-reaction"
              title="Add a reaction"
              aria-label="Add a reaction"
              onClick={openPicker}
              style={{
                height: 24,
                width: 28,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 'var(--r-full)',
                cursor: 'pointer',
                background: 'var(--bg-raised)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-3)',
                fontSize: 14,
                lineHeight: 1,
              }}
            >
              +
            </button>
          </div>
        )}

        {receipt && (
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, userSelect: 'none' }}>{receipt}</div>
        )}
      </div>

      {/* Hover toolbar */}
      {!m.deleted && !isEditing && (
        <div
          className="sem-toolbar"
          data-open={picker ? 1 : undefined}
          style={{
            position: 'absolute',
            top: -12,
            right: 16,
            display: 'flex',
            gap: 1,
            padding: 2,
            background: 'var(--bg-raised)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            boxShadow: 'var(--elev-2)',
            zIndex: 3,
          }}
        >
          {QUICK_EMOJIS.map((e) => (
            <ToolBtn key={e} label={`React with ${e}`} onClick={() => react(e)}>
              <span style={{ fontSize: 14, lineHeight: 1 }}>{e}</span>
            </ToolBtn>
          ))}
          <ToolBtn label="More reactions" onClick={openPicker}>
            <SmilePlusIcon size={15} />
          </ToolBtn>
          <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border-subtle)', margin: '3px 2px' }} />
          <ToolBtn label="Reply" onClick={() => onReply(m.id)}>
            <ReplyIcon size={15} />
          </ToolBtn>
          {m.body.text !== '' && (
            <ToolBtn label="Copy text" onClick={() => void window.bridge.app.copyText(copyTextOf(m)).catch(() => {})}>
              <CopyIcon size={15} />
            </ToolBtn>
          )}
          <ToolBtn
            label={m.pinned ? 'Unpin message' : 'Pin message'}
            active={m.pinned}
            onClick={() => void window.bridge.chat.pin(conv, m.id, m.pinned ? 'unpin' : 'pin').catch(() => {})}
          >
            <PinIcon size={15} />
          </ToolBtn>
          {mine && m.body.kind === 'text' && (
            <ToolBtn label="Edit message" onClick={() => onEditStart(m.id)}>
              <PencilIcon size={15} />
            </ToolBtn>
          )}
          {mine && (
            <ToolBtn
              label="Delete message"
              danger
              onClick={() => void window.bridge.chat.remove(conv, m.id).catch(() => {})}
            >
              <TrashIcon size={15} />
            </ToolBtn>
          )}
        </div>
      )}

      {/* Mini emoji picker (fixed-position popover) */}
      {picker && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onMouseDown={() => setPicker(null)} />
          <div
            className="sem-popover"
            role="menu"
            aria-label="Pick a reaction"
            style={{
              position: 'fixed',
              left: picker.x,
              top: picker.y,
              zIndex: 41,
              display: 'grid',
              gridTemplateColumns: 'repeat(8, 30px)',
              gap: 2,
              padding: 6,
              background: 'var(--bg-raised)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--r-lg)',
              boxShadow: 'var(--elev-3)',
            }}
          >
            {MINI_EMOJIS.map((e) => (
              <button
                key={e}
                className="sem-emoji-btn"
                title={`React with ${e}`}
                aria-label={`React with ${e}`}
                onClick={() => {
                  react(e)
                  setPicker(null)
                }}
                style={{
                  width: 30,
                  height: 30,
                  fontSize: 16,
                  background: 'transparent',
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {e}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
})

function replyTargetLine(m: MessageView, target: MessageView | undefined): ReactNode {
  if (!m.replyTo || m.deleted) return null
  return (
    <div
      title={target ? snippetOf(target) : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        marginBottom: 3,
        fontSize: 12,
        color: 'var(--text-3)',
        minWidth: 0,
        maxWidth: '72ch',
      }}
    >
      <span style={{ width: 2, alignSelf: 'stretch', background: 'var(--accent)', borderRadius: 1, flexShrink: 0 }} />
      <span style={{ fontWeight: 600, color: 'var(--text-2)', flexShrink: 0 }}>
        {target ? target.authorName : 'unknown'}
      </span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {target ? snippetOf(target) : 'original message unavailable'}
      </span>
    </div>
  )
}

function ToolBtn({
  label,
  onClick,
  danger,
  active,
  children,
}: {
  label: string
  onClick: (e: MouseEvent<HTMLButtonElement>) => void
  danger?: boolean
  active?: boolean
  children: ReactNode
}) {
  return (
    <button
      className={danger ? 'sem-emoji-btn sem-danger-btn' : 'sem-emoji-btn'}
      title={label}
      aria-label={label}
      onClick={onClick}
      style={{
        width: 26,
        height: 26,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 'none',
        background: active ? 'var(--accent-soft)' : 'transparent',
        color: danger ? 'var(--danger)' : active ? 'var(--accent-text)' : 'var(--text-2)',
        borderRadius: 6,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

function EditBox({ conv, id, initial, onDone }: { conv: ConvId; id: string; initial: string; onDone: () => void }) {
  const [val, setVal] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  const save = (): void => {
    const t = val.trim()
    if (t && t !== initial.trim()) void window.bridge.chat.edit(conv, id, t).catch(() => {})
    onDone()
  }

  return (
    <div style={{ maxWidth: '72ch' }}>
      <textarea
        ref={ref}
        value={val}
        aria-label="Edit message"
        onChange={(e) => {
          setVal(e.target.value)
          e.target.style.height = 'auto'
          e.target.style.height = `${e.target.scrollHeight}px`
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            save()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onDone()
          }
        }}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          resize: 'none',
          background: 'var(--bg-input)',
          border: '1px solid color-mix(in srgb, var(--accent) 55%, var(--border-strong))',
          borderRadius: 'var(--r-md)',
          padding: '6px 10px',
          fontSize: 15,
          lineHeight: '22px',
          fontFamily: 'var(--font-ui)',
          color: 'var(--text-1)',
          outline: 'none',
          userSelect: 'text',
        }}
      />
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, userSelect: 'none' }}>
        enter to save · esc to cancel
      </div>
    </div>
  )
}
