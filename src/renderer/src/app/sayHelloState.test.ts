import { describe, expect, it } from 'vitest'
import {
  SAY_HELLO_IDLE,
  pressSayHello,
  sayHelloBusy,
  sayHelloFailed,
  sayHelloPhase,
  sayHelloReason,
  sayHelloSent,
  sayHelloToast,
  sayHelloWasQueued,
} from './sayHelloState'

const A = 'chan:aaaa1111'
const B = 'chan:bbbb2222'

describe('say hello button state', () => {
  it('sends on the first click and swallows a second while it is in flight', () => {
    const first = pressSayHello(SAY_HELLO_IDLE, A)
    expect(first.send).toBe(true)
    expect(sayHelloBusy(first.state, A)).toBe(true)

    const second = pressSayHello(first.state, A)
    expect(second.send).toBe(false)
    expect(second.state).toBe(first.state)
  })

  it('re-enables itself when the send is rejected (sending → error → enabled)', () => {
    const pressed = pressSayHello(SAY_HELLO_IDLE, A)
    expect(sayHelloPhase(pressed.state, A)).toBe('sending')

    const failed = sayHelloFailed(pressed.state, A)
    expect(sayHelloPhase(failed, A)).toBe('idle')
    expect(sayHelloBusy(failed, A)).toBe(false)

    // ...and the next click really does publish again.
    expect(pressSayHello(failed, A).send).toBe(true)
  })

  it('stays latched for the conversation it succeeded in — one hello, not two', () => {
    const pressed = pressSayHello(SAY_HELLO_IDLE, A)
    const sent = sayHelloSent(pressed.state, A)
    expect(sayHelloPhase(sent, A)).toBe('sent')
    expect(pressSayHello(sent, A).send).toBe(false)
  })

  it('never carries a latch into another conversation (the original reported bug)', () => {
    // The overlay component is never remounted between conversations, so this
    // is the exact sequence behind "sometimes the button does nothing": hello
    // in A succeeds, the user opens empty channel B, clicks — and before the
    // fix that click hit a `sending` flag left standing from A.
    const sent = sayHelloSent(pressSayHello(SAY_HELLO_IDLE, A).state, A)
    expect(sayHelloBusy(sent, B)).toBe(false)
    expect(sayHelloPhase(sent, B)).toBe('idle')

    const inB = pressSayHello(sent, B)
    expect(inB.send).toBe(true)
    expect(sayHelloPhase(inB.state, B)).toBe('sending')
    // A's own latch is a separate entry in the set: pressing hello in B must
    // not touch it (it stays 'sent' — see the mid-flight-switch test below for
    // the sequel bug that a single shared slot caused here).
    expect(sayHelloBusy(inB.state, A)).toBe(true)
    expect(sayHelloPhase(inB.state, A)).toBe('sent')
  })

  it('a rejection in the conversation we left does not disable the one we are in', () => {
    const inB = pressSayHello(SAY_HELLO_IDLE, B)
    // A late rejection from A lands after the user moved on: it must not touch
    // B's in-flight latch.
    expect(sayHelloFailed(inB.state, A)).toBe(inB.state)
    expect(sayHelloSent(inB.state, A)).toBe(inB.state)
    expect(sayHelloPhase(inB.state, B)).toBe('sending')
  })

  it('keeps both latches when a second conversation is pressed while the first is still in flight', () => {
    // The bug this closes: the old state was a single { conv, phase } slot, so
    // pressing hello in B while A's send was still in flight *evicted* A's
    // latch. Switching back to A before its send resolved found the button
    // idle again, and a second press there queued a second "Hello 👋" on top
    // of the one already in flight. The latch is a set now, so both stay up.
    const afterA = pressSayHello(SAY_HELLO_IDLE, A)
    const afterB = pressSayHello(afterA.state, B)
    expect(afterB.send).toBe(true)

    // Switching back to A: still busy, a press there is still swallowed.
    expect(sayHelloBusy(afterB.state, A)).toBe(true)
    expect(pressSayHello(afterB.state, A).send).toBe(false)

    // A's send lands late; B is untouched and still latched on its own.
    const aSent = sayHelloSent(afterB.state, A)
    expect(sayHelloPhase(aSent, A)).toBe('sent')
    expect(sayHelloPhase(aSent, B)).toBe('sending')

    // B's send fails; A's latch (now 'sent') is untouched.
    const bFailed = sayHelloFailed(aSent, B)
    expect(sayHelloPhase(bFailed, B)).toBe('idle')
    expect(sayHelloPhase(bFailed, A)).toBe('sent')
  })

  it('treats a queued send as success: the latch stays up, not a second click', () => {
    // `ChatService.send` resolves the outbox path by *rejecting* with "queued"
    // (see `publishWithOutbox`) — a real outcome, not a failure, since the
    // hello still goes out once the share is back. The caller is expected to
    // route a queued rejection through `sayHelloSent`, not `sayHelloFailed`.
    const pressed = pressSayHello(SAY_HELLO_IDLE, A)
    expect(sayHelloWasQueued(new Error("Error invoking remote method 'chat:send': Error: queued"))).toBe(true)

    const queued = sayHelloSent(pressed.state, A)
    expect(sayHelloPhase(queued, A)).toBe('sent')
    expect(sayHelloBusy(queued, A)).toBe(true)
    // A second press before the outbox flushes must not queue a second hello.
    expect(pressSayHello(queued, A).send).toBe(false)
  })

  it('does not mistake an unrelated rejection for a queued one', () => {
    expect(sayHelloWasQueued(new Error('unknown conversation chan:ab12'))).toBe(false)
    expect(sayHelloWasQueued(new Error('not-ready'))).toBe(false)
    expect(sayHelloWasQueued(new Error(''))).toBe(false)
    expect(sayHelloWasQueued(undefined)).toBe(false)
  })
})

describe('say hello rejection messages', () => {
  it("peels Electron's IPC wrapper off main's message", () => {
    expect(sayHelloReason(new Error("Error invoking remote method 'chat:send': Error: queued"))).toBe('queued')
    expect(sayHelloReason(new Error('unknown conversation chan:ab12'))).toBe('unknown conversation chan:ab12')
    expect(sayHelloReason('plain string rejection')).toBe('plain string rejection')
    expect(sayHelloReason(undefined)).toBe('')
  })

  it('explains the codes main actually throws', () => {
    const queued = sayHelloToast(new Error("Error invoking remote method 'chat:send': Error: queued"))
    expect(queued.tone).toBe('info')
    expect(queued.text).toMatch(/queued/)

    const gone = sayHelloToast(new Error('unknown conversation chan:ab12'))
    expect(gone.tone).toBe('danger')
    expect(gone.text).toMatch(/not on the shared folder any more/)

    const notReady = sayHelloToast(new Error('not-ready'))
    expect(notReady.tone).toBe('danger')
    expect(notReady.text).toMatch(/still opening the shared folder/)
  })

  it('never produces an empty, reason-free toast', () => {
    for (const err of [new Error(''), '', null, undefined, new Error('something odd happened')]) {
      const t = sayHelloToast(err)
      expect(t.text.startsWith('Could not say hello — ')).toBe(true)
      expect(t.text.length).toBeGreaterThan('Could not say hello — '.length + 3)
    }
  })
})
