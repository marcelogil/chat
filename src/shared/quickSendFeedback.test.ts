import { describe, expect, it } from 'vitest'
import { quickSendFeedback } from './quickSendFeedback'

// The composer's honesty contract for a quick-reply chip. The chip's text is
// never in the textarea, so a rejection that is reported as "queued" when
// nothing was queued loses the message with no trace — see
// publishWithOutbox in src/main/services/chatService.ts for which rejections
// mean what.

describe('quickSendFeedback', () => {
  it("treats the outbox's 'queued' rejection as queued, and says so quietly", () => {
    const fb = quickSendFeedback('On it 👀', new Error('queued'))
    expect(fb.queued).toBe(true)
    expect(fb.tone).toBe('info')
    expect(fb.text).toContain('On it 👀')
    expect(fb.text).toContain('folder is back')
  })

  // The regression: alice deletes #product, bob clicks a chip before his poll
  // tick moves him off it. chatService rejects with 'unknown conversation …'
  // and nothing is queued — so the footer's queued chip must stay dark and a
  // danger toast must say the send did not happen.
  it('does not call an unknown conversation queued', () => {
    const fb = quickSendFeedback('LGTM ✅', new Error('unknown conversation chan:abc123'))
    expect(fb.queued).toBe(false)
    expect(fb.tone).toBe('danger')
    expect(fb.text).toBe('Could not send “LGTM ✅” — that conversation is gone.')
    expect(fb.text).not.toContain('ueued')
  })

  it('reports any other failure with its own reason, never as queued', () => {
    const fb = quickSendFeedback('Done ✅', new Error('EACCES: permission denied'))
    expect(fb.queued).toBe(false)
    expect(fb.tone).toBe('danger')
    expect(fb.text).toBe('Could not send “Done ✅” — EACCES: permission denied')
  })

  it('handles a non-Error rejection and an empty reason', () => {
    expect(quickSendFeedback('Brb', 'boom')).toEqual({
      queued: false,
      text: 'Could not send “Brb” — boom',
      tone: 'danger',
    })
    expect(quickSendFeedback('Brb', new Error('')).text).toBe('Could not send “Brb”')
    expect(quickSendFeedback('Brb', undefined).queued).toBe(false)
  })

  it('always produces toast text that names the message that was lost', () => {
    for (const err of [new Error('queued'), new Error('unknown conversation chan:x'), new Error('nope'), null]) {
      const fb = quickSendFeedback('Can someone review my PR? 🙏', err)
      expect(fb.text).toContain('Can someone review my PR? 🙏')
      expect(fb.text.length).toBeGreaterThan(0)
    }
  })
})
