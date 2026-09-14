import { describe, expect, it } from 'vitest'
import { notifyLineFor, prTransitionLine } from './notifyLine'

// The whole wording matrix an OS notification can produce: three conversation
// kinds times previews on/off. A private group notifies like a DM (you were
// invited into it personally) but must never *read* like one, and with previews
// off nothing at all about the message may leave the app.

describe('notifyLineFor', () => {
  it('names the channel when previews are on', () => {
    expect(notifyLineFor({ kind: 'chan', who: 'Alice', convName: 'general', previews: true, snippet: 'hello team' })).toEqual(
      { title: 'Alice in #general', body: 'hello team' },
    )
  })

  it('is just the sender for a DM', () => {
    expect(notifyLineFor({ kind: 'dm', who: 'Alice', previews: true, snippet: 'secret plan' })).toEqual({
      title: 'Alice',
      body: 'secret plan',
    })
  })

  it('marks a private group with the lock and its name', () => {
    expect(
      notifyLineFor({ kind: 'grp', who: 'Alice', convName: 'Ops crew', previews: true, snippet: 'kickoff at 10' }),
    ).toEqual({ title: 'Alice in 🔒 Ops crew', body: 'kickoff at 10' })
  })

  it('falls back when the conversation has no name yet', () => {
    expect(notifyLineFor({ kind: 'chan', who: 'Alice', convName: null, previews: true, snippet: 'x' }).title).toBe(
      'Alice in #channel',
    )
    expect(notifyLineFor({ kind: 'grp', who: 'Alice', convName: '', previews: true, snippet: 'x' }).title).toBe(
      'Alice in 🔒 private group',
    )
  })

  it('leaks nothing with previews off — not the sender, not the room, not a word', () => {
    for (const kind of ['chan', 'dm', 'grp'] as const) {
      const line = notifyLineFor({ kind, who: 'Alice', convName: 'Ops crew', previews: false, snippet: 'kickoff at 10' })
      expect(line.title).toBe('Chat')
      expect(line.body).not.toContain('Alice')
      expect(line.body).not.toContain('Ops crew')
      expect(line.body).not.toContain('kickoff')
    }
    expect(notifyLineFor({ kind: 'dm', who: 'Alice', previews: false, snippet: 'x' }).body).toBe('New direct message')
    // A private group is not a direct message and does not claim to be one.
    expect(notifyLineFor({ kind: 'grp', who: 'Alice', previews: false, snippet: 'x' }).body).toBe('New message')
    expect(notifyLineFor({ kind: 'chan', who: 'Alice', previews: false, snippet: 'x' }).body).toBe('New message')
  })
})

// The author side (1.4): what my own pull request says when it moves. The body
// is always "<title> · <repo>", so the assertions below are about the title.
describe('prTransitionLine', () => {
  const pr = { id: 123, title: 'Clamp the refund window', repoName: 'api' }

  it('names the reviewer who requested changes', () => {
    expect(prTransitionLine({ ...pr, kind: 'changes-requested', by: ['Ana'], openThreads: 0 })).toEqual({
      title: 'Your PR #123 — changes requested by Ana',
      body: 'Clamp the refund window · api',
    })
  })

  it('joins two names, and counts the rest instead of listing them', () => {
    expect(prTransitionLine({ ...pr, kind: 'changes-requested', by: ['Ana', 'Bob'], openThreads: 0 }).title).toBe(
      'Your PR #123 — changes requested by Ana and Bob',
    )
    expect(
      prTransitionLine({ ...pr, kind: 'changes-requested', by: ['Ana', 'Bob', 'Cai'], openThreads: 0 }).title,
    ).toBe('Your PR #123 — changes requested by Ana and 2 others')
  })

  it('still reads as a sentence when nobody can be named', () => {
    expect(prTransitionLine({ ...pr, kind: 'changes-requested', by: ['', '  '], openThreads: 0 }).title).toBe(
      'Your PR #123 — changes requested',
    )
  })

  it('counts open comments, singular and plural', () => {
    expect(prTransitionLine({ ...pr, kind: 'comments-open', by: [], openThreads: 1 }).title).toBe(
      'Your PR #123 has 1 open comment',
    )
    expect(prTransitionLine({ ...pr, kind: 'comments-open', by: [], openThreads: 2 }).title).toBe(
      'Your PR #123 has 2 open comments',
    )
    // A server too old to serve threads reports zero; the news is still true.
    expect(prTransitionLine({ ...pr, kind: 'comments-open', by: [], openThreads: 0 }).title).toBe(
      'Your PR #123 has 1 open comment',
    )
  })

  it('says what to do next when it is approved', () => {
    expect(prTransitionLine({ ...pr, kind: 'approved', by: [], openThreads: 0 }).title).toBe(
      'Your PR #123 is approved — ready to complete',
    )
  })
})
