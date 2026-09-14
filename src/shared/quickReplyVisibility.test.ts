import { describe, expect, it } from 'vitest'
import { showQuickReplies } from './quickReplyVisibility'

describe('showQuickReplies', () => {
  it('shows in a channel with an empty draft', () => {
    expect(showQuickReplies('chan:general', '')).toBe(true)
  })

  it('shows in a DM with an empty draft', () => {
    expect(showQuickReplies('dm:abc123', '')).toBe(true)
  })

  it('shows in a group with an empty draft', () => {
    expect(showQuickReplies('grp:abc123', '')).toBe(true)
  })

  it('hides once there is any text, even whitespace-only', () => {
    expect(showQuickReplies('chan:general', 'a')).toBe(false)
    expect(showQuickReplies('chan:general', ' ')).toBe(false)
  })

  it('hides in a team conversation regardless of draft state', () => {
    expect(showQuickReplies('team:opaque', '')).toBe(false)
    expect(showQuickReplies('team:opaque', 'x')).toBe(false)
  })
})
