import { describe, expect, it } from 'vitest'
import { presenceLine, SET_A_STATUS } from './presenceLine'

// The second line under a name (1.4). The rule every person row shares: a real
// status when there is one, presence when there isn't, and the footer's
// invitation on our own row — never a blank line, because a row that grows a
// second line only when a teammate has typed something jumps around.

describe('presenceLine', () => {
  it('shows the status when there is one', () => {
    expect(presenceLine({ status: 'back at 3', state: 'online' })).toEqual({ text: 'back at 3', muted: false })
  })

  it('normalizes a status that arrived with whitespace in it', () => {
    expect(presenceLine({ status: '  back\nat 3  ', state: 'away' })).toEqual({ text: 'back at 3', muted: false })
  })

  it('falls back to presence, muted, when the status is empty', () => {
    expect(presenceLine({ status: '', state: 'online' })).toEqual({ text: 'Online', muted: true })
    expect(presenceLine({ status: '   ', state: 'away' })).toEqual({ text: 'Away', muted: true })
    expect(presenceLine({ status: undefined, state: 'offline' })).toEqual({ text: 'Offline', muted: true })
  })

  it('says so when nobody is behind the registration any more', () => {
    expect(presenceLine({ state: 'offline', departed: true })).toEqual({
      text: 'No longer on the share',
      muted: true,
    })
  })

  it('invites a status on our own row, and shows ours once set', () => {
    expect(presenceLine({ state: 'online', self: true })).toEqual({ text: SET_A_STATUS, muted: true })
    expect(presenceLine({ status: 'heads-down', state: 'online', self: true })).toEqual({
      text: 'heads-down',
      muted: false,
    })
  })

  it('a real status wins over "departed" — it is still what they said', () => {
    expect(presenceLine({ status: 'on leave', state: 'offline', departed: true })).toEqual({
      text: 'on leave',
      muted: false,
    })
  })
})
