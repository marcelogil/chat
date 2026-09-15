import type { ConvId } from '@shared/types'

// "Take me to that message" (1.6). The rules for the store's `pendingJump`
// field live here, away from the virtualized list that consumes them, because
// the interesting parts are all decisions: whose list this is, whether the log
// has arrived yet, and what to do when the message simply is not there any
// more.
//
// The shape is deliberately a one-shot request rather than a scroll position:
// the quick switcher cannot scroll anything (the list is not mounted yet when
// the conversation changes), and MessageList cannot ask for a jump (it does not
// know one was requested). The field is the handoff, and it is cleared the
// moment it is acted on — a pending jump that outlived its scroll would fire
// again on the next render that touched the log.

export interface PendingJump {
  conv: ConvId
  id: string
}

/** What the toast says when retention has already swept the message away. */
export const JUMP_MISSING_TOAST = 'That message is no longer on the share'

/** How long the target row stays highlighted once it is on screen. */
export const JUMP_FLASH_MS = 2000

export type JumpAction =
  /** Not for this list (or nothing pending) — leave the request alone. */
  | { kind: 'none' }
  /** For this list, but its log has not been read yet. Keep waiting. */
  | { kind: 'wait' }
  | { kind: 'scroll'; id: string; index: number }
  | { kind: 'missing'; id: string; toast: string }

export interface JumpContext {
  /** The conversation this list is rendering. */
  conv: ConvId
  /** Has `ensureEvents` finished for it? */
  loaded: boolean
  /** Row index of a message id in the rendered list, or -1. */
  indexOf(id: string): number
}

export function resolveJump(pending: PendingJump | null, ctx: JumpContext): JumpAction {
  if (!pending) return { kind: 'none' }
  if (pending.conv !== ctx.conv) return { kind: 'none' }
  // A log that is still loading says nothing about whether the message exists,
  // so this must not fall through to 'missing' — that is how a jump into a
  // conversation opened for the first time would always toast.
  if (!ctx.loaded) return { kind: 'wait' }
  const index = ctx.indexOf(pending.id)
  if (index >= 0) return { kind: 'scroll', id: pending.id, index }
  return { kind: 'missing', id: pending.id, toast: JUMP_MISSING_TOAST }
}

/** Both terminal outcomes clear the request; 'wait' deliberately does not. */
export function shouldClear(action: JumpAction): boolean {
  return action.kind === 'scroll' || action.kind === 'missing'
}

/**
 * Guards the jump effect against React.StrictMode's double-invoke: dev mode
 * runs an effect's body twice for the same commit, both calls closing over
 * the identical `pending` value. Without this, a terminal outcome (`scroll`
 * or `missing`) would run its side effect — the toast, the scroll — twice.
 *
 * Identity, not structural equality, on purpose: `lastHandled` is the exact
 * object the effect resolved a moment ago, so a *later* request that happens
 * to name the same conversation and message (jumping to it again) is a new
 * `{conv, id}` literal and is correctly treated as a fresh request, not a
 * duplicate of the one already handled.
 */
export function isDuplicateInvocation(
  pending: PendingJump | null,
  lastHandled: PendingJump | null,
): boolean {
  return pending !== null && pending === lastHandled
}
