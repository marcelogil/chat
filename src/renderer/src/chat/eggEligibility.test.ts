import { describe, expect, it } from 'vitest'
import { considerEgg, EMPTY_EGG_STATE, type EggEnv } from '@/app/easterEggQueue'
import { eggCandidate, type EggSighting, type EggViewer } from './eggEligibility'

// The mapping that decides whether a reader is ever offered an animation. Two
// of these cases are regressions, both of them of the same shape: a message
// that really did arrive while the app was open, in a pane that was not on
// screen, going permanently silent.

const ME = 'device-mine'
const NOW = 1_700_000_000_000

const row = (over: Partial<EggSighting> = {}): EggSighting => ({
  id: '1700000000000-0001-aaaaaaaa',
  egg: 'confetti',
  ms: NOW - 1_000,
  author: 'device-carol',
  ...over,
})

const viewer = (over: Partial<EggViewer> = {}): EggViewer => ({
  selfId: ME,
  anchorRead: '1600000000000-0001-aaaaaaaa',
  baseline: new Set<string>(),
  arrivedLive: () => false,
  ...over,
})

describe('eggCandidate — mine', () => {
  it('marks my own message, and only mine', () => {
    expect(eggCandidate(row({ author: ME }), viewer()).mine).toBe(true)
    expect(eggCandidate(row(), viewer()).mine).toBe(false)
  })

  it('claims nothing before boot has told us who we are', () => {
    expect(eggCandidate(row({ author: '' }), viewer({ selfId: '' })).mine).toBe(false)
  })
})

describe('eggCandidate — live', () => {
  it('trusts the push registry over the pane baseline', () => {
    // The exact shape of the bug: the message is in the log by the time the
    // pane opens (loadTeam prefetched it and the push filled it in), so the
    // baseline knows it — but it arrived this session, with the app open.
    const r = row()
    const v = viewer({ baseline: new Set([r.id]), arrivedLive: (id) => id === r.id })
    expect(eggCandidate(r, v).live).toBe(true)
  })

  it('calls anything the open pane already held history', () => {
    const r = row()
    expect(eggCandidate(r, viewer({ baseline: new Set([r.id]) })).live).toBe(false)
  })

  it('treats a log that has not finished loading as all-new', () => {
    expect(eggCandidate(row(), viewer({ baseline: null })).live).toBe(true)
  })

  it('is live for a message the baseline never saw', () => {
    expect(eggCandidate(row(), viewer({ baseline: new Set(['other-id']) })).live).toBe(true)
  })
})

describe('eggCandidate — unreadAtOpen', () => {
  it('counts everything in a conversation with no read mark', () => {
    // Never opened, or opened while it was still empty (there is no newest
    // message to mark read): both report ''. Every message in it is unread.
    expect(eggCandidate(row(), viewer({ anchorRead: '' })).unreadAtOpen).toBe(true)
  })

  it('compares stems for a conversation that has one', () => {
    const read = '1700000000000-0005-aaaaaaaa'
    expect(eggCandidate(row({ id: '1700000000000-0006-aaaaaaaa' }), viewer({ anchorRead: read })).unreadAtOpen).toBe(
      true,
    )
    expect(eggCandidate(row({ id: '1700000000000-0004-aaaaaaaa' }), viewer({ anchorRead: read })).unreadAtOpen).toBe(
      false,
    )
    expect(eggCandidate(row({ id: read }), viewer({ anchorRead: read })).unreadAtOpen).toBe(false)
  })
})

describe('eggCandidate + considerEgg — the scenarios that were silent', () => {
  const env: EggEnv = { now: NOW, enabled: true, reducedMotion: false }
  const play = (r: EggSighting, v: EggViewer) => considerEgg(EMPTY_EGG_STATE, eggCandidate(r, v), env)

  it('plays in a DM I have never opened, for a message that landed while I was elsewhere', () => {
    const r = row({ egg: 'confetti', author: 'device-carol' })
    const v = viewer({ anchorRead: '', baseline: new Set([r.id]), arrivedLive: () => true })
    expect(play(r, v)).toMatchObject({ outcome: 'play', play: 'confetti' })
  })

  it('plays for the first message in a channel I have never read', () => {
    const r = row({ egg: 'bug' })
    // Prefetched at boot, so the pane's baseline holds it and the push
    // registry does not — the arm that has to carry it is "never read".
    const v = viewer({ anchorRead: '', baseline: new Set([r.id]) })
    expect(play(r, v)).toMatchObject({ outcome: 'play', play: 'bug' })
  })

  it('still says nothing about week-old history scrolled back into view', () => {
    const r = row({ id: '1500000000000-0001-aaaaaaaa', ms: NOW - 7 * 24 * 3600_000 })
    const v = viewer({ anchorRead: '1600000000000-0001-aaaaaaaa', baseline: new Set([r.id]) })
    expect(play(r, v)).toMatchObject({ outcome: 'skip', play: null })
  })

  it('never resurrects an old message just because the conversation is unread', () => {
    // The age ceiling is the guard for a first visit to a chatty channel: no
    // read mark makes everything eligible, and the day-old ones still lose.
    const r = row({ ms: NOW - 25 * 3600_000 })
    expect(play(r, viewer({ anchorRead: '', baseline: new Set([r.id]) }))).toMatchObject({ outcome: 'skip' })
  })
})
