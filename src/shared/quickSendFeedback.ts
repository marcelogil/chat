// What the composer says when clicking a quick-reply chip does not resolve.
// Pure — no Electron, no DOM — so the wording and the queued/failed split are
// testable without mounting React.
//
// `chat.send` rejects for two very different reasons (see
// `publishWithOutbox` in src/main/services/chatService.ts):
//
//   • 'queued' — the share was unreachable, the message IS in the outbox and
//     will go out on remount. Honest, and the composer's footer chip already
//     says exactly that.
//   • anything else — the conversation is gone (a deleted channel, a group we
//     were removed from: 'unknown conversation …'), or the outbox write itself
//     failed. Nothing was queued and nothing will be retried.
//
// The second case is why this exists. A chip's text never passes through the
// textarea, so a failed quick reply leaves *no* trace to retry from — telling
// someone it is "queued — will send when the folder is back" when it was
// silently dropped is the one thing the composer must not do. Every caller
// raises the toast; only `queued` may also light the footer's queued chip.

export interface QuickSendFeedback {
  /** True only when the message really did reach the outbox (error 'queued'). */
  queued: boolean
  /** Toast text — always shown, since the chip's text is gone from the UI. */
  text: string
  tone: 'info' | 'danger'
}

export function quickSendFeedback(msg: string, err: unknown): QuickSendFeedback {
  const reason = (err instanceof Error ? err.message : String(err ?? '')).trim()
  if (reason === 'queued') {
    return { queued: true, text: `Queued “${msg}” — it will send when the folder is back.`, tone: 'info' }
  }
  if (reason.startsWith('unknown conversation')) {
    return { queued: false, text: `Could not send “${msg}” — that conversation is gone.`, tone: 'danger' }
  }
  return { queued: false, text: reason ? `Could not send “${msg}” — ${reason}` : `Could not send “${msg}”`, tone: 'danger' }
}
