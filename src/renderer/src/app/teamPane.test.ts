import { describe, expect, it } from 'vitest'
import { TEAM_CONV } from '@shared/constants'
import type { ConvId } from '@shared/types'
import { teamPaneFor } from './teamPane'

// The centre column's choice for a `team:` conversation. This exists because
// the choice used to be a two-way `calendar ? … : PrsPane` that quietly became
// a two-of-three when `TEAM_CONV` grew `settings` in 1.5.

describe('teamPaneFor', () => {
  it('names the pane for each conv that has one', () => {
    expect(teamPaneFor(TEAM_CONV.calendar)).toBe('calendar')
    expect(teamPaneFor(TEAM_CONV.prs)).toBe('prs')
  })

  it('has no pane for a log-only team conv — the pull-request pane is not a fallback', () => {
    expect(teamPaneFor(TEAM_CONV.settings)).toBeNull()
    // A conv from a newer build, or a fourth TEAM_CONV member added later.
    expect(teamPaneFor('team:whatever-comes-next' as ConvId)).toBeNull()
    expect(teamPaneFor(null)).toBeNull()
  })

  it('covers every TEAM_CONV member deliberately, pane or no pane', () => {
    // Fails loudly when somebody adds a fifth member without deciding: every
    // value must be one of the two panes or an explicit `null`.
    for (const conv of Object.values(TEAM_CONV)) {
      expect(['calendar', 'prs', null]).toContain(teamPaneFor(conv))
    }
    expect(
      Object.values(TEAM_CONV)
        .filter((c) => teamPaneFor(c) !== null)
        .sort(),
    ).toEqual([TEAM_CONV.calendar, TEAM_CONV.prs].sort())
  })
})
