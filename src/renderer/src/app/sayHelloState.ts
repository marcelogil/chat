// The "Say hello" button's state machine (1.4), split out of EmptyStates.tsx so
// it can be unit-tested in the node environment the suite runs in — same split
// as LaunchNudge / launchNudgeState.ts.
//
// What it fixes: `EmptyConvOverlay` is rendered once by AppShell as
// `<EmptyConvOverlay conv={activeConv} />`, in a fixed position with no `key`,
// so switching conversations re-renders that *same* component instance — its
// state survives. The old button raised a plain `sending` flag it only ever
// lowered again on failure, which meant one successful hello left the flag up
// for the rest of the run: every empty conversation opened afterwards drew a
// disabled button, and clicking it did nothing at all. That is the "sometimes
// the Say hello button doesn't do anything" report.
//
// So the latch is a set of conversations with a send in flight or landed, not
// a single slot: a button drawn for a conversation with no entry starts from
// `idle`, whatever happened in any other one, and — unlike a single `{ conv,
// phase }` slot — pressing hello in a second conversation while the first is
// still in flight cannot evict the first conversation's latch. With a single
// slot that eviction was real: switch back to the first conversation before
// its send resolves and its latch had already been overwritten, so a second
// press there queued a second "Hello 👋".

export type SayHelloPhase = 'idle' | 'sending' | 'sent'

export interface SayHelloState {
  /** Every conversation with a latch up (sending or sent), keyed by conv id. */
  byConv: Map<string, SayHelloPhase>
}

/** Nothing in flight, nothing sent — the state every button starts from. */
export const SAY_HELLO_IDLE: SayHelloState = { byConv: new Map() }

/** The phase the button for `conv` should draw itself in. */
export function sayHelloPhase(state: SayHelloState, conv: string): SayHelloPhase {
  return state.byConv.get(conv) ?? 'idle'
}

/** Is the button for `conv` disabled (a send in flight, or one that landed)? */
export function sayHelloBusy(state: SayHelloState, conv: string): boolean {
  return sayHelloPhase(state, conv) !== 'idle'
}

/**
 * A click. `send` says whether the caller should actually publish: a second
 * click while the first is still in flight (in this conversation, or a
 * lingering latch from one already sent) is swallowed — one hello per
 * conversation — but a click in any other conversation is never blocked by it.
 */
export function pressSayHello(state: SayHelloState, conv: string): { state: SayHelloState; send: boolean } {
  if (sayHelloBusy(state, conv)) return { state, send: false }
  const byConv = new Map(state.byConv)
  byConv.set(conv, 'sending')
  return { state: { byConv }, send: true }
}

/**
 * The send landed — or was queued for the outbox, which counts as landed too
 * (see `sayHelloWasQueued`): either way the overlay gives way to the real
 * message the moment its event push arrives, so this phase is normally
 * invisible. It exists so that a hello which somehow does not clear the
 * overlay cannot be sent twice, and it only ever touches `conv`'s own entry.
 */
export function sayHelloSent(state: SayHelloState, conv: string): SayHelloState {
  if (!state.byConv.has(conv)) return state
  const byConv = new Map(state.byConv)
  byConv.set(conv, 'sent')
  return { byConv }
}

/** The send was rejected: the button for `conv` (and only `conv`) is live again. */
export function sayHelloFailed(state: SayHelloState, conv: string): SayHelloState {
  if (!state.byConv.has(conv)) return state
  const byConv = new Map(state.byConv)
  byConv.delete(conv)
  return { byConv }
}

/** Toast tone for a rejection — a queued hello is news, not a failure. */
export type SayHelloTone = 'info' | 'danger'

export interface SayHelloToast {
  text: string
  tone: SayHelloTone
}

/**
 * Main's own words, with Electron's IPC wrapper ("Error invoking remote method
 * 'chat:send': Error: queued") peeled off.
 */
export function sayHelloReason(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err ?? '')).trim()
  const tail = raw.split(/Error:\s*/).pop()
  return (tail ?? raw).trim()
}

// `ChatService.send` throws this exact word when the share was unreachable and
// the message went to the outbox instead (see `publishWithOutbox`). Nothing is
// lost — it sends itself once the folder is back — so the caller should treat
// it as a success (`sayHelloSent`, not `sayHelloFailed`): re-enabling the
// button here queued a second "Hello 👋" the moment the first press landed in
// the outbox instead of on the share.
const QUEUED_RE = /^queued\b/

/** Was this rejection actually the outbox taking the hello, not a real failure? */
export function sayHelloWasQueued(err: unknown): boolean {
  return QUEUED_RE.test(sayHelloReason(err))
}

/** What main's rejection codes mean to somebody looking at an empty channel. */
const EXPLANATIONS: [RegExp, string, SayHelloTone][] = [
  [QUEUED_RE, 'the shared folder is unreachable — your hello is queued and goes out when it is back', 'info'],
  [/^unknown conversation\b/, 'this conversation is not on the shared folder any more', 'danger'],
  [/^not-ready\b/, 'the app is still opening the shared folder — try again in a moment', 'danger'],
  [/^files-not-ready\b/, 'the file service is still starting — try again in a moment', 'danger'],
]

/** The toast a rejected hello puts on the rail. Never silent, always a reason. */
export function sayHelloToast(err: unknown): SayHelloToast {
  const reason = sayHelloReason(err)
  for (const [re, text, tone] of EXPLANATIONS) {
    if (re.test(reason)) return { text: `Could not say hello — ${text}.`, tone }
  }
  return { text: `Could not say hello — ${reason || 'the shared folder refused the message'}.`, tone: 'danger' }
}
