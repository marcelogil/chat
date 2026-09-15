import { describe, expect, it } from 'vitest'
import type { ConvId } from '@shared/types'
import {
  JUMP_FADE_MS,
  JUMP_FLASH_MS,
  JUMP_HOLD_MS,
  JUMP_MISSING_TOAST,
  isDuplicateInvocation,
  resolveJump,
  shouldClear,
} from './jump'

// The `pendingJump` handoff (1.6): the quick switcher asks, the target
// conversation's MessageList answers. Everything worth getting wrong is here —
// acting on somebody else's request, toasting "gone" at a log that has simply
// not loaded yet, or leaving a request behind to fire again.

const GENERAL = 'chan:general' as ConvId
const DUO = 'grp:duo' as ConvId

const ctx = (over: Partial<{ conv: ConvId; loaded: boolean; ids: string[] }> = {}) => ({
  conv: over.conv ?? GENERAL,
  loaded: over.loaded ?? true,
  indexOf: (id: string) => (over.ids ?? ['a', 'b', 'c']).indexOf(id),
})

describe('resolveJump', () => {
  it('does nothing when nothing is pending', () => {
    expect(resolveJump(null, ctx())).toEqual({ kind: 'none' })
  })

  it('ignores a request aimed at another conversation', () => {
    expect(resolveJump({ conv: DUO, id: 'b' }, ctx({ conv: GENERAL }))).toEqual({ kind: 'none' })
  })

  it('waits while the log is still being read', () => {
    expect(resolveJump({ conv: GENERAL, id: 'b' }, ctx({ loaded: false, ids: [] }))).toEqual({ kind: 'wait' })
  })

  it('scrolls to the row the message sits on', () => {
    expect(resolveJump({ conv: GENERAL, id: 'c' }, ctx())).toEqual({ kind: 'scroll', id: 'c', index: 2 })
  })

  it('reports a message retention has already swept away', () => {
    expect(resolveJump({ conv: GENERAL, id: 'gone' }, ctx())).toEqual({
      kind: 'missing',
      id: 'gone',
      toast: JUMP_MISSING_TOAST,
    })
    expect(JUMP_MISSING_TOAST).toBe('That message is no longer on the share')
  })

  it('does not call a loaded-but-empty conversation "still loading"', () => {
    expect(resolveJump({ conv: GENERAL, id: 'a' }, ctx({ ids: [] })).kind).toBe('missing')
  })

  it('scrolls to a row that is already rendered even before the log says loaded (1.6.1)', () => {
    // `loadTeam` prefetched this log minutes ago; `loaded` only tracks whether
    // this pane's own `ensureEvents` has come back. Waiting for it means
    // missing the mount, and the mount is the only moment the list can be
    // *born* at the target instead of scrolled to it.
    expect(resolveJump({ conv: GENERAL, id: 'b' }, ctx({ loaded: false }))).toEqual({
      kind: 'scroll',
      id: 'b',
      index: 1,
    })
  })
})

describe('the highlight clock', () => {
  it('holds, then fades, and the React timer covers both', () => {
    // CHAT_CSS builds its animation from the same two numbers; if this sum
    // ever stopped matching, the class would be pulled mid-fade.
    expect(JUMP_FLASH_MS).toBe(JUMP_HOLD_MS + JUMP_FADE_MS)
    expect(JUMP_HOLD_MS).toBeGreaterThan(JUMP_FADE_MS)
  })
})

describe('shouldClear', () => {
  it('clears both terminal outcomes and nothing else', () => {
    expect(shouldClear({ kind: 'scroll', id: 'a', index: 0 })).toBe(true)
    expect(shouldClear({ kind: 'missing', id: 'a', toast: JUMP_MISSING_TOAST })).toBe(true)
    // A request that is still waiting for its log must survive the render that
    // noticed it — clearing here is how a jump silently does nothing.
    expect(shouldClear({ kind: 'wait' })).toBe(false)
    expect(shouldClear({ kind: 'none' })).toBe(false)
  })
})

describe('isDuplicateInvocation', () => {
  it('is not a duplicate the first time — nothing has been handled yet', () => {
    expect(isDuplicateInvocation({ conv: GENERAL, id: 'a' }, null)).toBe(false)
  })

  it('catches StrictMode calling the effect twice for the exact same request', () => {
    const pending = { conv: GENERAL, id: 'a' }
    expect(isDuplicateInvocation(pending, pending)).toBe(true)
  })

  it('is never a duplicate of nothing pending', () => {
    expect(isDuplicateInvocation(null, { conv: GENERAL, id: 'a' })).toBe(false)
    expect(isDuplicateInvocation(null, null)).toBe(false)
  })

  it('uses identity, not structural equality: a later jump to the same message is not a duplicate of the one already handled', () => {
    const handled = { conv: GENERAL, id: 'a' }
    const later = { conv: GENERAL, id: 'a' } // same values, a distinct request
    expect(isDuplicateInvocation(later, handled)).toBe(false)
  })
})
