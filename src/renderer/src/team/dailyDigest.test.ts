import { describe, expect, it } from 'vitest'
import type { CalendarItem } from '@shared/calendar'
import { dailyDigest, isBirthdayTag, joinNames, shouldShowDigest } from './dailyDigest'

function item(
  id: string,
  title: string,
  tag: string,
  start: string,
  end: string,
  annual = false,
): CalendarItem {
  return {
    id,
    title,
    tag,
    color: 0,
    start,
    end,
    annual,
    notes: '',
    author: 'device1',
    updatedId: `e-${id}`,
  }
}

describe('isBirthdayTag', () => {
  it('matches the plain English word', () => {
    expect(isBirthdayTag('Birthday')).toBe(true)
    expect(isBirthdayTag('birthday')).toBe(true)
  })

  it('matches every listed locale, case/accent-insensitive', () => {
    expect(isBirthdayTag('Aniversário')).toBe(true)
    expect(isBirthdayTag('ANIVERSARIO')).toBe(true)
    expect(isBirthdayTag('Anniversaire')).toBe(true)
    expect(isBirthdayTag('Geburtstag')).toBe(true)
  })

  it('rejects an unrelated tag', () => {
    expect(isBirthdayTag('Release')).toBe(false)
    expect(isBirthdayTag('Freeze')).toBe(false)
    expect(isBirthdayTag('')).toBe(false)
  })
})

describe('joinNames', () => {
  it('joins with no Oxford comma', () => {
    expect(joinNames(['Ana'])).toBe('Ana')
    expect(joinNames(['Ana', 'Bob'])).toBe('Ana and Bob')
    expect(joinNames(['Ana', 'Bob', 'Cy'])).toBe('Ana, Bob and Cy')
  })
})

describe('dailyDigest', () => {
  it('returns null with no entries at all', () => {
    expect(dailyDigest([], '2026-09-15')).toBeNull()
  })

  it('returns null on a malformed today', () => {
    expect(dailyDigest([item('a', 'Release', 'Release', '2026-09-15', '2026-09-15')], 'not-a-date')).toBeNull()
  })

  it('one birthday today — singular phrasing, contains the word "birthday"', () => {
    const items = [item('a', "Ana's birthday", 'Birthday', '2026-09-15', '2026-09-15')]
    expect(dailyDigest(items, '2026-09-15')).toBe("🎂 Today: Ana's birthday")
  })

  it('an annual birthday matches by month/day across years', () => {
    // Entered against its original year; today is decades later.
    const items = [item('a', "Dana's birthday", 'Birthday', '1990-09-15', '1990-09-15', true)]
    expect(dailyDigest(items, '2026-09-15')).toBe("🎂 Today: Dana's birthday")
    // A day off either way must not match.
    expect(dailyDigest(items, '2026-09-14')).not.toBe("🎂 Today: Dana's birthday")
    expect(dailyDigest(items, '2026-09-16')).not.toBe("🎂 Today: Dana's birthday")
  })

  it('two birthdays today join without the word "birthday"', () => {
    const items = [
      item('a', "Ana's birthday", 'Birthday', '2026-09-15', '2026-09-15'),
      item('b', "Bob's birthday", 'Birthday', '2026-09-15', '2026-09-15'),
    ]
    expect(dailyDigest(items, '2026-09-15')).toBe('🎂 Today: Ana and Bob')
  })

  it('a bare-name birthday title (no possessive suffix) passes through unchanged', () => {
    const items = [item('a', 'Ana', 'Birthday', '2026-09-15', '2026-09-15')]
    expect(dailyDigest(items, '2026-09-15')).toBe("🎂 Today: Ana's birthday")
  })

  it('a localized birthday tag still counts (the toast wording itself stays English)', () => {
    const items = [item('a', "Ana's aniversário", 'Aniversário', '2026-09-15', '2026-09-15')]
    expect(dailyDigest(items, '2026-09-15')).toBe("🎂 Today: Ana's birthday")
  })

  it('a single event covering today, single-day', () => {
    const items = [item('a', 'Release 1.1', 'Release', '2026-09-15', '2026-09-15')]
    expect(dailyDigest(items, '2026-09-15')).toBe('📅 Release 1.1 — until Tue 15 Sep')
  })

  it('a multi-day event covering today reports its end date', () => {
    // 2026-09-18 is a Friday.
    const items = [item('a', 'Code freeze', 'Freeze', '2026-09-10', '2026-09-18')]
    expect(dailyDigest(items, '2026-09-15')).toBe('📅 Code freeze — until Fri 18 Sep')
  })

  it('an event that started before today and ends after it still counts as "covering" today', () => {
    const items = [item('a', 'Offsite', 'Travel', '2026-09-01', '2026-09-30')]
    const out = dailyDigest(items, '2026-09-15')
    expect(out).toContain('Offsite')
    expect(out).toContain('until')
  })

  it('multiple events covering today (a tie) join their titles', () => {
    const items = [
      item('a', 'Code freeze', 'Freeze', '2026-09-10', '2026-09-18'),
      item('b', 'Sprint demo', 'Meeting', '2026-09-15', '2026-09-15'),
    ]
    expect(dailyDigest(items, '2026-09-15')).toBe('📅 Code freeze and Sprint demo today')
  })

  it('a birthday today outranks an event also covering today', () => {
    const items = [
      item('a', "Ana's birthday", 'Birthday', '2026-09-15', '2026-09-15'),
      item('b', 'Code freeze', 'Freeze', '2026-09-10', '2026-09-18'),
    ]
    expect(dailyDigest(items, '2026-09-15')).toBe("🎂 Today: Ana's birthday")
  })

  it('with nothing today, counts down to the next upcoming entry', () => {
    const items = [item('a', 'Release 2.1', 'Release', '2026-09-18', '2026-09-18')]
    expect(dailyDigest(items, '2026-09-15')).toBe('📅 Release 2.1 in 3 days')
  })

  it('singular "day" at exactly one day out', () => {
    const items = [item('a', 'Release 2.1', 'Release', '2026-09-16', '2026-09-16')]
    expect(dailyDigest(items, '2026-09-15')).toBe('📅 Release 2.1 in 1 day')
  })

  it('a countdown tie — two entries share the same next date — joins their titles', () => {
    const items = [
      item('a', 'Release 2.1', 'Release', '2026-09-18', '2026-09-18'),
      item('b', 'Freeze ends', 'Freeze', '2026-09-18', '2026-09-18'),
    ]
    expect(dailyDigest(items, '2026-09-15')).toBe('📅 Freeze ends and Release 2.1 in 3 days')
  })

  it('picks the nearest of several future entries, not the furthest', () => {
    const items = [
      item('a', 'Far off', 'Release', '2026-12-01', '2026-12-01'),
      item('b', 'Release 2.1', 'Release', '2026-09-18', '2026-09-18'),
    ]
    expect(dailyDigest(items, '2026-09-15')).toBe('📅 Release 2.1 in 3 days')
  })

  it('an annual entry due next year still counts down correctly', () => {
    // Today is 2026-09-15; the annual entry's next occurrence is 2027-01-05.
    const items = [item('a', "Team kickoff", 'Event', '2020-01-05', '2020-01-05', true)]
    expect(dailyDigest(items, '2026-09-15')).toBe('📅 Team kickoff in 112 days')
  })

  it('returns null when nothing is today and nothing is upcoming within a year', () => {
    const items = [item('a', 'Long past', 'Event', '2020-01-01', '2020-01-01')]
    expect(dailyDigest(items, '2026-09-15')).toBeNull()
  })
})

describe('shouldShowDigest', () => {
  it('shows on the first-ever check (no lastShown)', () => {
    expect(shouldShowDigest(null, '2026-09-15')).toBe(true)
  })

  it('does not show again the same day', () => {
    expect(shouldShowDigest('2026-09-15', '2026-09-15')).toBe(false)
  })

  it('shows again once the date has rolled forward', () => {
    expect(shouldShowDigest('2026-09-14', '2026-09-15')).toBe(true)
  })

  it('does not show when the clock has moved backward relative to lastShown', () => {
    expect(shouldShowDigest('2026-09-16', '2026-09-15')).toBe(false)
  })

  it('treats a malformed lastShown as never-shown', () => {
    expect(shouldShowDigest('garbage', '2026-09-15')).toBe(true)
  })

  it('refuses a malformed today', () => {
    expect(shouldShowDigest(null, 'garbage')).toBe(false)
  })
})
