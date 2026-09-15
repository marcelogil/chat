import type { CalendarItem } from '@shared/calendar'
import { addDays, daysBetween, isYmd, occurrencesInRange } from '@shared/calendar'

// The daily calendar toast (1.5) — a pure summary of "what does today's team
// calendar look like", computed once per calendar day per device. All I/O
// (turning events into `CalendarItem[]`, remembering which day was last
// shown, deciding whether to actually interrupt with a toast) lives in
// team/CalendarDigest.tsx; this file is the part worth testing without a DOM.
//
// Priority, strictly one line ever: a birthday today beats an ordinary event
// covering today, which beats a countdown to the next upcoming entry.

const BIRTHDAY_WORDS = ['birthday', 'aniversario', 'anniversaire', 'geburtstag']

/** Strip accents and case so 'Aniversário' and 'ANIVERSARIO' compare equal. */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

/** The tag names a birthday, in any of the listed languages (accent/case-insensitive). */
export function isBirthdayTag(tag: string): boolean {
  const folded = fold(tag)
  return BIRTHDAY_WORDS.some((w) => folded.includes(w))
}

const SUFFIX_RE = /^(.+?)['’]s\s+(?:birthday|aniversário|aniversario|anniversaire|geburtstag)\.?\s*$/i

/**
 * "Ana's birthday" -> "Ana". A title that is not a possessive birthday phrase
 * (an entry whose *tag* says birthday but whose title is just a bare name, or
 * something free-form) passes through unchanged.
 */
export function birthdayName(title: string): string {
  const m = title.match(SUFFIX_RE)
  return (m ? m[1] : title).trim()
}

/** 'a' | 'a and b' | 'a, b and c' — never an Oxford comma; matches the spec examples. */
export function joinNames(names: string[]): string {
  const list = names.filter((n) => n.length > 0)
  if (list.length === 0) return ''
  if (list.length === 1) return list[0]
  if (list.length === 2) return `${list[0]} and ${list[1]}`
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

const WEEKDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 'YYYY-MM-DD' -> 'Fri 19 Sep' — local-calendar parts only, no Date-locale dependence. */
function shortDate(day: string): string {
  const y = Number(day.slice(0, 4))
  const m = Number(day.slice(5, 7))
  const d = Number(day.slice(8, 10))
  const weekday = WEEKDAY[(new Date(y, m - 1, d).getDay() + 6) % 7]
  return `${weekday} ${d} ${MONTH[m - 1]}`
}

/** In-order de-dup (a Set preserves insertion order in JS). */
function uniq(list: string[]): string[] {
  return [...new Set(list)]
}

/**
 * One line for `today`, or null when the calendar has nothing to say. Reads
 * only `items` — the caller supplies whatever `materializeCalendar` produced,
 * already merged and tombstone-free.
 */
export function dailyDigest(items: CalendarItem[], today: string): string | null {
  if (!isYmd(today)) return null

  // 1) Birthdays today — annual entries already expanded by month/day
  // regardless of the year they were entered in.
  const todays = occurrencesInRange(items, today, today)
  const birthdays = todays.filter((o) => isBirthdayTag(o.item.tag))
  if (birthdays.length > 0) {
    const names = uniq(birthdays.map((o) => birthdayName(o.item.title)))
    return names.length === 1 ? `🎂 Today: ${names[0]}'s birthday` : `🎂 Today: ${joinNames(names)}`
  }

  // 2) Otherwise, the ordinary event(s) whose span covers today.
  if (todays.length > 0) {
    if (todays.length === 1) {
      const [o] = todays
      return `📅 ${o.item.title} — until ${shortDate(o.end)}`
    }
    return `📅 ${joinNames(uniq(todays.map((o) => o.item.title)))} today`
  }

  // 3) Otherwise, a countdown to the next upcoming entry — within a year,
  // which guarantees a hit for any annual entry (worst case, 365 days off).
  const future = occurrencesInRange(items, addDays(today, 1), addDays(today, 365))
  if (future.length === 0) return null
  const nextDate = future[0].date
  const tied = future.filter((o) => o.date === nextDate)
  const n = daysBetween(today, nextDate)
  return `📅 ${joinNames(uniq(tied.map((o) => o.item.title)))} in ${n} day${n === 1 ? '' : 's'}`
}

/**
 * Once per calendar day per device: `lastShown` is the last day the digest ran
 * (checked — not necessarily shown; see CalendarDigest.tsx), and this is true
 * only the first time `today` is checked, or once `today` has moved *forward*
 * from it. A clock stepping backward (DST, a manual change) must not reopen
 * the gate — "again when the app is focused on a **later** date" is the spec,
 * verbatim.
 */
export function shouldShowDigest(lastShown: string | null, today: string): boolean {
  if (!isYmd(today)) return false
  if (lastShown === null || !isYmd(lastShown)) return true
  return daysBetween(lastShown, today) > 0
}
