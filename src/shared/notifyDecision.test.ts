import { describe, expect, it } from 'vitest'
import type { PrState } from './types'
import {
  alertsSilenced,
  chatPreset,
  chatPresetPatch,
  inQuietHours,
  isSnoozed,
  prAlertMode,
  prInvolvesMe,
  shouldNotifyChat,
  shouldNotifyPr,
  snoozeChoices,
  snoozeRemainingMs,
  type NotifyPrefs,
} from './notifyDecision'

// The whole interruption matrix, with a fixed clock. Every combination that
// can reach an OS notification or the in-app card is decided here, so the two
// services and the alert card only have to agree on *calling* this.

const NOW = Date.parse('2026-09-14T15:00:00Z')
const MIN = 60_000

function prefs(over: Partial<NotifyPrefs> = {}): NotifyPrefs {
  return { notifyChannels: 'all', ...over }
}

const ME = 'me-1'
const ANA = 'ana-2'

function state(over: Partial<PrState> = {}): PrState {
  return {
    kind: 'needs-review',
    next: 'reviewers',
    nextIds: [ANA],
    nextNames: ['Ana'],
    since: NOW - 3600_000,
    lastActivityAt: NOW - 3600_000,
    lastPushAt: null,
    openThreads: 0,
    threadsKnown: true,
    stale: false,
    overdue: false,
    ...over,
  }
}

function view(over: { authorId?: string; assignedToMe?: boolean; state?: PrState } = {}) {
  return {
    author: { id: over.authorId ?? 'author-9', name: 'Grace' },
    assignedToMe: over.assignedToMe ?? false,
    state: over.state ?? state(),
  }
}

describe('a pre-1.4 profile behaves exactly as 1.3 did', () => {
  it('alerts for every pull request, notifies DMs, and is never paused', () => {
    const p = prefs({ notifyChannels: 'mentions' }) // none of the 1.4 keys present
    expect(prAlertMode(p)).toBe('all')
    expect(isSnoozed(p, NOW)).toBe(false)
    expect(shouldNotifyChat({ kind: 'dm', mentioned: false, settings: p, now: NOW })).toBe(true)
    expect(shouldNotifyChat({ kind: 'grp', mentioned: false, settings: p, now: NOW })).toBe(true)
    expect(shouldNotifyPr({ view: view(), meId: ME, settings: p, now: NOW })).toBe(true)
  })
})

describe('shouldNotifyChat', () => {
  it('follows notifyChannels for a channel', () => {
    const cases: [NotifyPrefs['notifyChannels'], boolean, boolean][] = [
      ['all', false, true],
      ['all', true, true],
      ['mentions', false, false],
      ['mentions', true, true],
      ['none', false, false],
      ['none', true, false], // a mention in a silenced channel stays silent
    ]
    for (const [notifyChannels, mentioned, want] of cases) {
      expect(shouldNotifyChat({ kind: 'chan', mentioned, settings: prefs({ notifyChannels }), now: NOW })).toBe(want)
    }
  })

  it('gates DMs and private groups on notifyDms, whatever the channel setting says', () => {
    for (const kind of ['dm', 'grp'] as const) {
      const loud = prefs({ notifyChannels: 'none', notifyDms: true })
      const quiet = prefs({ notifyChannels: 'all', notifyDms: false })
      expect(shouldNotifyChat({ kind, mentioned: false, settings: loud, now: NOW })).toBe(true)
      expect(shouldNotifyChat({ kind, mentioned: true, settings: quiet, now: NOW })).toBe(false)
    }
  })

  it('is silenced completely while the pause is running', () => {
    const paused = prefs({ notifyChannels: 'all', notifyDms: true, snoozeUntil: NOW + 5 * MIN })
    for (const kind of ['chan', 'dm', 'grp'] as const) {
      expect(shouldNotifyChat({ kind, mentioned: true, settings: paused, now: NOW })).toBe(false)
    }
  })

  it('comes back by itself the millisecond the pause expires', () => {
    const p = prefs({ notifyChannels: 'all', snoozeUntil: NOW })
    expect(isSnoozed(p, NOW - 1)).toBe(true)
    expect(isSnoozed(p, NOW)).toBe(false) // the deadline itself is already over
    expect(shouldNotifyChat({ kind: 'chan', mentioned: false, settings: p, now: NOW })).toBe(true)
    expect(snoozeRemainingMs(p, NOW - 2 * MIN)).toBe(2 * MIN)
    expect(snoozeRemainingMs(p, NOW + MIN)).toBe(0)
  })

  it('treats a null, missing or nonsense snooze as not paused', () => {
    for (const snoozeUntil of [null, undefined, Number.NaN, 'soon' as unknown as number]) {
      expect(isSnoozed(prefs({ snoozeUntil }), NOW)).toBe(false)
    }
  })
})

describe('shouldNotifyPr', () => {
  it("'all' lets everything through, 'none' nothing", () => {
    const mineToo = view({ authorId: ME, assignedToMe: true })
    expect(shouldNotifyPr({ view: view(), meId: ME, settings: prefs({ notifyPrs: 'all' }), now: NOW })).toBe(true)
    expect(shouldNotifyPr({ view: mineToo, meId: ME, settings: prefs({ notifyPrs: 'none' }), now: NOW })).toBe(false)
  })

  it("'mine' means waiting on me, assigned to me, or written by me", () => {
    const p = prefs({ notifyPrs: 'mine' })
    const waiting = view({ state: state({ nextIds: [ME, ANA], nextNames: ['you', 'Ana'] }) })
    expect(shouldNotifyPr({ view: waiting, meId: ME, settings: p, now: NOW })).toBe(true)
    expect(shouldNotifyPr({ view: view({ assignedToMe: true }), meId: ME, settings: p, now: NOW })).toBe(true)
    expect(shouldNotifyPr({ view: view({ authorId: ME }), meId: ME, settings: p, now: NOW })).toBe(true)
  })

  it("'mine' drops a pull request nobody is waiting on me for", () => {
    const p = prefs({ notifyPrs: 'mine' })
    expect(shouldNotifyPr({ view: view(), meId: ME, settings: p, now: NOW })).toBe(false)
    // No identity at all (a shared token that has not identified yet): the
    // author and next-actor tests are meaningless, so only an explicit
    // assignment can match.
    expect(shouldNotifyPr({ view: view({ authorId: ME }), meId: null, settings: p, now: NOW })).toBe(false)
    expect(shouldNotifyPr({ view: view({ assignedToMe: true }), meId: null, settings: p, now: NOW })).toBe(true)
  })

  it('reads a view with no state yet (the first poll of a 1.3 server)', () => {
    const bare = { author: { id: 'author-9', name: 'Grace' }, assignedToMe: false }
    expect(prInvolvesMe(bare, ME)).toBe(false)
    expect(shouldNotifyPr({ view: bare, meId: ME, settings: prefs({ notifyPrs: 'mine' }), now: NOW })).toBe(false)
    expect(shouldNotifyPr({ view: bare, meId: ME, settings: prefs({ notifyPrs: 'all' }), now: NOW })).toBe(true)
  })

  it('is silenced by the pause even for a pull request waiting on me', () => {
    const waiting = view({ state: state({ nextIds: [ME], nextNames: ['you'] }) })
    for (const notifyPrs of ['all', 'mine'] as const) {
      const p = prefs({ notifyPrs, snoozeUntil: NOW + MIN })
      expect(shouldNotifyPr({ view: waiting, meId: ME, settings: p, now: NOW })).toBe(false)
      expect(shouldNotifyPr({ view: waiting, meId: ME, settings: { ...p, snoozeUntil: NOW - 1 }, now: NOW })).toBe(true)
    }
  })
})

describe('the popover presets', () => {
  it('names the three combinations it writes and calls everything else custom', () => {
    expect(chatPreset(prefs({ notifyChannels: 'all', notifyDms: true }))).toBe('all')
    expect(chatPreset(prefs({ notifyChannels: 'all' }))).toBe('all') // notifyDms absent = on
    expect(chatPreset(prefs({ notifyChannels: 'mentions', notifyDms: true }))).toBe('mine')
    expect(chatPreset(prefs({ notifyChannels: 'none', notifyDms: false }))).toBe('none')
    expect(chatPreset(prefs({ notifyChannels: 'none', notifyDms: true }))).toBe('custom')
    expect(chatPreset(prefs({ notifyChannels: 'all', notifyDms: false }))).toBe('custom')
  })

  it('round-trips every preset it can write', () => {
    for (const preset of ['all', 'mine', 'none'] as const) {
      expect(chatPreset({ ...prefs(), ...chatPresetPatch(preset) })).toBe(preset)
    }
  })

  it('offers an hour from now and 9:00 the next morning', () => {
    const { hour, tomorrow } = snoozeChoices(NOW)
    expect(hour - NOW).toBe(3_600_000)
    const t = new Date(tomorrow)
    expect(t.getHours()).toBe(9)
    expect(t.getMinutes()).toBe(0)
    // Always the next day, never later today: a pause set at 2am must not end
    // seven hours later on the same morning.
    expect(t.getDate()).toBe(new Date(NOW).getDate() + 1)
    const twoAm = new Date(NOW)
    twoAm.setHours(2, 0, 0, 0)
    const late = snoozeChoices(twoAm.getTime())
    expect(new Date(late.tomorrow).getHours()).toBe(9)
    expect(late.tomorrow - twoAm.getTime()).toBe(31 * 3_600_000)
  })

  it('slashes the bell only when nothing at all can come through', () => {
    expect(alertsSilenced(prefs(), NOW)).toBe(false)
    expect(alertsSilenced(prefs({ notifyPrs: 'none' }), NOW)).toBe(false) // chat still talks
    expect(alertsSilenced(prefs({ notifyChannels: 'none', notifyDms: false }), NOW)).toBe(false) // PRs still do
    expect(alertsSilenced(prefs({ notifyChannels: 'none', notifyDms: false, notifyPrs: 'none' }), NOW)).toBe(true)
    expect(alertsSilenced(prefs({ snoozeUntil: NOW + MIN }), NOW)).toBe(true)
    expect(alertsSilenced(prefs({ snoozeUntil: NOW - MIN }), NOW)).toBe(false)
    // …and while quiet hours are actually running, not merely switched on.
    expect(alertsSilenced(prefs({ quietHours: QUIET }), at('23:30'), 'UTC')).toBe(true)
    expect(alertsSilenced(prefs({ quietHours: QUIET }), at('12:00'), 'UTC')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Quiet hours: stored and edited since 1.0, enforced from 1.4.

const QUIET = { enabled: true, from: '22:00', to: '07:00' }

/** `now` at a wall-clock time on 2026-09-14, read in UTC by the tests. */
function at(hhmm: string): number {
  return Date.parse(`2026-09-14T${hhmm}:00Z`)
}

describe('inQuietHours', () => {
  it('is off when the switch is off, whatever the clock says', () => {
    expect(inQuietHours({ ...QUIET, enabled: false }, at('23:30'), 'UTC')).toBe(false)
    expect(inQuietHours(undefined, at('23:30'), 'UTC')).toBe(false)
  })

  it('covers a window that spans midnight, on both sides of it', () => {
    expect(inQuietHours(QUIET, at('22:30'), 'UTC')).toBe(true)
    expect(inQuietHours(QUIET, at('23:59'), 'UTC')).toBe(true)
    expect(inQuietHours(QUIET, at('00:00'), 'UTC')).toBe(true)
    expect(inQuietHours(QUIET, at('03:15'), 'UTC')).toBe(true)
  })

  it('starts inclusively and ends exclusively — awake again exactly at "to"', () => {
    expect(inQuietHours(QUIET, at('22:00'), 'UTC')).toBe(true)
    expect(inQuietHours(QUIET, at('21:59'), 'UTC')).toBe(false)
    expect(inQuietHours(QUIET, at('06:59'), 'UTC')).toBe(true)
    expect(inQuietHours(QUIET, at('07:00'), 'UTC')).toBe(false)
  })

  it('handles a daytime window that does not wrap', () => {
    const lunch = { enabled: true, from: '12:00', to: '13:00' }
    expect(inQuietHours(lunch, at('11:59'), 'UTC')).toBe(false)
    expect(inQuietHours(lunch, at('12:00'), 'UTC')).toBe(true)
    expect(inQuietHours(lunch, at('12:59'), 'UTC')).toBe(true)
    expect(inQuietHours(lunch, at('13:00'), 'UTC')).toBe(false)
  })

  it('treats an empty window as off rather than as all day', () => {
    const same = { enabled: true, from: '09:00', to: '09:00' }
    for (const time of ['08:59', '09:00', '09:01', '23:00']) {
      expect(inQuietHours(same, at(time), 'UTC')).toBe(false)
    }
  })

  it('fails towards letting a notification through on anything malformed', () => {
    const bad = [
      { enabled: true, from: '', to: '07:00' },
      { enabled: true, from: '25:00', to: '07:00' },
      { enabled: true, from: '22:60', to: '07:00' },
      { enabled: true, from: '10pm', to: '7am' },
      { enabled: true, from: '22:00', to: 'later' },
    ]
    for (const q of bad) expect(inQuietHours(q, at('23:30'), 'UTC')).toBe(false)
    expect(inQuietHours(QUIET, at('23:30'), 'Mars/Olympus')).toBe(false)
    expect(inQuietHours(QUIET, Number.NaN, 'UTC')).toBe(false)
  })

  it('reads the clock in the machine\u2019s own zone when no zone is given', () => {
    // Whatever zone this machine is in, 30 minutes into the window it is quiet
    // and 30 minutes before it is not — the window is wall-clock local.
    const local = new Date(NOW)
    const from = `${String(local.getHours()).padStart(2, '0')}:00`
    const to = `${String((local.getHours() + 2) % 24).padStart(2, '0')}:00`
    expect(inQuietHours({ enabled: true, from, to }, NOW)).toBe(true)
    expect(inQuietHours({ enabled: true, from, to }, NOW - 61 * MIN)).toBe(false)
  })
})

describe('quiet hours silence the things that interrupt', () => {
  it('stops a chat notification that would otherwise fire', () => {
    const p = prefs({ quietHours: QUIET })
    const input = { kind: 'dm' as const, mentioned: true, settings: p, tz: 'UTC' }
    expect(shouldNotifyChat({ ...input, now: at('23:30') })).toBe(false)
    expect(shouldNotifyChat({ ...input, now: at('12:00') })).toBe(true)
  })

  it('stops a mention, a private group and a live-board invite alike', () => {
    const p = prefs({ notifyChannels: 'mentions', quietHours: QUIET })
    for (const kind of ['chan', 'dm', 'grp'] as const) {
      expect(shouldNotifyChat({ kind, mentioned: true, settings: p, now: at('02:00'), tz: 'UTC' })).toBe(false)
    }
  })

  it('stops a pull-request alert waiting on me — the toast and the card both', () => {
    const p = prefs({ notifyPrs: 'mine', quietHours: QUIET })
    const v = view({ assignedToMe: true })
    expect(shouldNotifyPr({ view: v, meId: ME, settings: p, now: at('23:30'), tz: 'UTC' })).toBe(false)
    expect(shouldNotifyPr({ view: v, meId: ME, settings: p, now: at('09:00'), tz: 'UTC' })).toBe(true)
  })

  it('a 1.3 profile with quiet hours off is unaffected', () => {
    const p = prefs({ quietHours: { enabled: false, from: '18:30', to: '09:00' } })
    expect(shouldNotifyChat({ kind: 'chan', mentioned: true, settings: p, now: at('23:30'), tz: 'UTC' })).toBe(true)
    expect(shouldNotifyPr({ view: view(), meId: ME, settings: p, now: at('23:30'), tz: 'UTC' })).toBe(true)
  })
})
