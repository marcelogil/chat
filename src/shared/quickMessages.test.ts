import { describe, expect, it } from 'vitest'
import { DEFAULT_QUICK_MESSAGES, QUICK_MESSAGE_LIMITS, effectiveQuickMessages, normalizeQuickMessages } from './quickMessages'

// What the inline chip row and the Settings editor both have to agree on:
// which list renders when nobody has customized anything, and the exact
// trim/cap rules a settings save applies.

describe('effectiveQuickMessages', () => {
  it('falls back to the defaults for null, absent, or empty settings', () => {
    expect(effectiveQuickMessages(null)).toBe(DEFAULT_QUICK_MESSAGES)
    expect(effectiveQuickMessages(undefined)).toBe(DEFAULT_QUICK_MESSAGES)
    expect(effectiveQuickMessages({})).toBe(DEFAULT_QUICK_MESSAGES)
    expect(effectiveQuickMessages({ quickMessages: null })).toBe(DEFAULT_QUICK_MESSAGES)
    expect(effectiveQuickMessages({ quickMessages: [] })).toBe(DEFAULT_QUICK_MESSAGES)
  })

  it('returns a clean custom list unchanged', () => {
    const custom = ['Brb', 'On call tonight']
    expect(effectiveQuickMessages({ quickMessages: custom })).toEqual(custom)
  })

  // The read path, not just the editor's save path: a profile customized under
  // the 1.4 draft (40 entries × 120 chars) must not put 40 chips — or a
  // horizontally scrolling strip — above the composer.
  it('caps a stale over-long custom list at maxEntries, keeping order', () => {
    const forty = Array.from({ length: 40 }, (_, i) => `msg ${i}`)
    const out = effectiveQuickMessages({ quickMessages: forty })
    expect(out.length).toBe(QUICK_MESSAGE_LIMITS.maxEntries)
    expect(out).toEqual(['msg 0', 'msg 1', 'msg 2', 'msg 3', 'msg 4'])
  })

  it('truncates an over-long custom entry to maxChars', () => {
    const [out] = effectiveQuickMessages({ quickMessages: ['x'.repeat(400)] })
    expect(out.length).toBe(QUICK_MESSAGE_LIMITS.maxChars)
  })

  // A blank entry used to survive to the row as a zero-width chip that did
  // nothing when clicked. It is dropped on the way out now, so it cannot.
  it('drops blank and whitespace-only entries before they can render', () => {
    expect(effectiveQuickMessages({ quickMessages: ['', 'ok', '   '] })).toEqual(['ok'])
    expect(effectiveQuickMessages({ quickMessages: ['  Brb  '] })).toEqual(['Brb'])
  })

  it('falls back to the defaults when a custom list cleans away to nothing', () => {
    expect(effectiveQuickMessages({ quickMessages: ['', '   '] })).toEqual(DEFAULT_QUICK_MESSAGES)
  })

  it('never renders more than maxEntries, whatever settings hold', () => {
    for (const list of [null, [], ['a'], Array.from({ length: 99 }, (_, i) => `m${i}`), ['', 'b', '']]) {
      expect(effectiveQuickMessages({ quickMessages: list }).length).toBeLessThanOrEqual(QUICK_MESSAGE_LIMITS.maxEntries)
    }
  })

  it('caps the entry limit at 5 and ships exactly five defaults', () => {
    expect(QUICK_MESSAGE_LIMITS.maxEntries).toBe(5)
    expect(DEFAULT_QUICK_MESSAGES).toEqual(['On it 👀', 'LGTM ✅', 'Can someone review my PR? 🙏', 'In a meeting, back in 15', 'Done ✅'])
    expect(DEFAULT_QUICK_MESSAGES.length).toBe(QUICK_MESSAGE_LIMITS.maxEntries)
  })

  it('keeps every default message unique and within the character limit', () => {
    const seen = new Set<string>()
    for (const msg of DEFAULT_QUICK_MESSAGES) {
      expect(msg.length).toBeLessThanOrEqual(QUICK_MESSAGE_LIMITS.maxChars)
      expect(seen.has(msg)).toBe(false)
      seen.add(msg)
    }
  })
})

describe('normalizeQuickMessages', () => {
  it('trims whitespace and drops empty lines', () => {
    expect(normalizeQuickMessages(['  On it 👀  ', '', '   ', 'Done ✅'])).toEqual(['On it 👀', 'Done ✅'])
  })

  it('truncates an over-long line to the character limit', () => {
    const long = 'x'.repeat(200)
    const [out] = normalizeQuickMessages([long])
    expect(out.length).toBe(QUICK_MESSAGE_LIMITS.maxChars)
    expect(out).toBe('x'.repeat(QUICK_MESSAGE_LIMITS.maxChars))
  })

  it('caps the list at maxEntries (5), keeping the earliest rows in order', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `msg ${i}`)
    const out = normalizeQuickMessages(lines)
    expect(out.length).toBe(5)
    expect(out.length).toBe(QUICK_MESSAGE_LIMITS.maxEntries)
    expect(out[0]).toBe('msg 0')
    expect(out.at(-1)).toBe(`msg ${QUICK_MESSAGE_LIMITS.maxEntries - 1}`)
  })

  it('is a no-op on an already-clean list under the cap', () => {
    const clean = ['a', 'b', 'c']
    expect(normalizeQuickMessages(clean)).toEqual(clean)
  })

  it('returns an empty list when every line is blank', () => {
    expect(normalizeQuickMessages(['', '   ', '\n'])).toEqual([])
  })
})
