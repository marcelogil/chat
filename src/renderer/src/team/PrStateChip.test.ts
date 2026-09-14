// PrStateChip.tsx is imported *first*, before anything else in the pane's
// module graph, and that is half the point of this file: the chip imports
// `agoPhrase` from PrsPane.tsx, which imports the chip back. The cycle is only
// safe while neither side reads the other at module-eval time, and whichever
// module is entered first is what decides whether that stays true — so the
// suite enters through the leaf, which is the order no component uses.
import { describe, expect, it, vi } from 'vitest'

// The pane's module graph reads `window.bridge.platform` at eval time
// (app/chrome.tsx), and the suite runs in the node environment. `vi.hoisted`
// runs before *any* import below, so the stub is in place for the real
// modules — nothing here is mocked away.
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window = {
    bridge: { platform: 'darwin' },
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  }
})

import { PrStateChip, prStateTooltip } from './PrStateChip'
import type { PrState } from '@shared/types'

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0)
const HOUR = 3_600_000
const DAY = 24 * HOUR

function state(over: Partial<PrState> = {}): PrState {
  return {
    kind: 'needs-review',
    next: 'reviewers',
    nextIds: [],
    nextNames: [],
    since: NOW - 3 * DAY,
    lastActivityAt: NOW - 3 * DAY,
    lastPushAt: NOW - 3 * DAY,
    openThreads: 0,
    threadsKnown: true,
    stale: false,
    overdue: false,
    ...over,
  }
}

describe('PrStateChip module', () => {
  it('loads leaf-first without either side of the PrsPane cycle being half-built', () => {
    expect(typeof PrStateChip).toBe('function')
    expect(typeof prStateTooltip).toBe('function')
  })
})

describe('prStateTooltip', () => {
  it('reads the four facts of a healthy PR', () => {
    const s = state({ openThreads: 2, lastPushAt: NOW - 5 * HOUR, lastActivityAt: NOW - 5 * HOUR })
    expect(prStateTooltip(s, NOW - 3 * DAY, NOW)).toBe(
      'created 3d ago · last push 5h ago · last activity 5h ago · 2 open comments',
    )
  })

  it('says the comment status is unavailable rather than claiming zero open threads', () => {
    // A pre-3.0 server, or a detail read that has not landed yet: "0 open
    // comments" would be a statement about the PR, and this is a statement
    // about the server.
    const s = state({ threadsKnown: false, openThreads: 0 })
    expect(prStateTooltip(s, NOW - 3 * DAY, NOW)).toContain('comment status unavailable on this server')
    expect(prStateTooltip(s, NOW - 3 * DAY, NOW)).not.toContain('0 open comment')
  })

  it('says no pushes are known rather than dating one from the epoch', () => {
    const s = state({ lastPushAt: null })
    expect(prStateTooltip(s, NOW - 3 * DAY, NOW)).toContain('no pushes known')
    expect(prStateTooltip(s, NOW - 3 * DAY, NOW)).not.toContain('last push')
  })

  it('pluralizes one open comment, and reports an unknown creation date honestly', () => {
    expect(prStateTooltip(state({ openThreads: 1 }), 0, NOW)).toBe(
      'created unknown · last push 3d ago · last activity 3d ago · 1 open comment',
    )
  })
})
