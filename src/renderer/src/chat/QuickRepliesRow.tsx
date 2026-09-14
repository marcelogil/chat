import type { ConvId } from '@shared/types'
import { effectiveQuickMessages } from '@shared/quickMessages'
import { showQuickReplies } from '@shared/quickReplyVisibility'
import { useStore } from '@/store'

// The composer's quick replies: a single inline row of chips directly above
// the textarea, replacing the earlier ⚡ popover — five defaults fit on
// screen at once, so a picker just added a click. Visibility is the pure
// `showQuickReplies` rule (shared/quickReplyVisibility.ts): hidden the
// moment a draft is in progress, and in conversations nothing can be sent to.
//
// A plain click sends the chip immediately as its own message — a quick
// reply is meant to be one tap. Option/Alt-click inserts it at the composer's
// caret instead, for when it's a starting point rather than the whole
// message; that mirrors the caret-aware insert Composer.tsx already does for
// @mentions (`insertQuickMessage`, reused here as `onInsert`).

export function QuickRepliesRow({
  conv,
  text,
  onInsert,
  onSendNow,
}: {
  conv: ConvId
  text: string
  /** Option/Alt-click: insert at the composer's caret (replacing a selection) and focus it. */
  onInsert: (text: string) => void
  /** Plain click: send this text immediately, independent of whatever is drafted. */
  onSendNow: (text: string) => void
}) {
  const settings = useStore((s) => s.settings)
  if (!showQuickReplies(conv, text)) return null
  const messages = effectiveQuickMessages(settings)
  if (messages.length === 0) return null

  return (
    <div
      role="group"
      aria-label="Quick replies"
      style={{
        display: 'flex',
        flexWrap: 'nowrap',
        gap: 6,
        marginBottom: 6,
        overflowX: 'auto',
      }}
    >
      {messages.map((msg, i) => (
        <button
          key={`${i}-${msg}`}
          type="button"
          className="sem-chip-btn sem-focus"
          title={`Send “${msg}” (⌥-click to insert)`}
          aria-label={`Send quick reply: ${msg}`}
          onClick={(e) => {
            if (e.altKey) onInsert(msg)
            else onSendNow(msg)
          }}
          style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
        >
          {msg}
        </button>
      ))}
    </div>
  )
}
