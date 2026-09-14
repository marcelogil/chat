import type { SettingsView } from './bridge'
import type { PrState, PrView } from './types'

// Who gets to interrupt you (1.4). One pure module, three consumers:
// `ChatService.maybeNotify` (OS toasts for messages and live boards),
// `PrService` (OS toasts for pull requests) and the renderer's `PrAlert` card
// — so the in-app card and the OS notification can never disagree about what
// is silenced, and the quick-controls popover can render the same state it
// writes.
//
// Everything here is data in, boolean out: no Electron, no store, no clock of
// its own. `now` is always passed so a snooze that has run out is a pure
// function of the two numbers rather than of when the test happened to run.
//
// The three settings are optional on `SettingsView` (they were added in 1.4 and
// a profile written by 1.3 has none of them), so every read here defaults to
// the pre-1.4 behaviour: all pull requests alert, DMs and private groups
// always notify, nothing is paused.
//
// Quiet hours are older than all of that and were, until 1.4, stored and edited
// but enforced nowhere: the switch silenced nothing. They are enforced here,
// next to the pause, so the one gate covers OS toasts for messages, live-board
// invites and pull requests, plus the in-app PR alert card. Beam offers
// deliberately stay outside it (`drops.ts`): somebody is waiting at the other
// end of a transfer for an answer, and a file offer that expires in silence is
// worse than a chime at 23:00.

/** The three conversation kinds a chat notification can come from. */
export type NotifyConvKind = 'chan' | 'dm' | 'grp'

/**
 * Just the notification-relevant slice of `SettingsView`. Callers pass the
 * whole thing; tests (and the popover's previews) pass a literal.
 */
export type NotifyPrefs = Pick<SettingsView, 'notifyChannels'> &
  Partial<Pick<SettingsView, 'notifyDms' | 'notifyPrs' | 'snoozeUntil' | 'quietHours'>>

/** The stored quiet-hours window: two 'HH:MM' local times and a switch. */
export type QuietHours = SettingsView['quietHours']

/**
 * Minutes since local midnight for `now`. `tz` is an IANA zone and exists for
 * the tests — the app always means the machine's own clock, which is what
 * somebody typing "22:00" into a preferences pane means too. An unknown zone
 * answers null rather than throwing, and null never silences anything.
 */
function minutesOfDay(now: number, tz?: string): number | null {
  if (!Number.isFinite(now)) return null
  if (tz === undefined) {
    const d = new Date(now)
    return d.getHours() * 60 + d.getMinutes()
  }
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(now))
    const hour = Number(parts.find((p) => p.type === 'hour')?.value)
    const minute = Number(parts.find((p) => p.type === 'minute')?.value)
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
    // Some ICU builds render midnight as "24" under hour12: false.
    return (hour % 24) * 60 + minute
  } catch {
    return null
  }
}

/** 'HH:MM' → minutes since midnight, or null for anything else. */
function clockMinutes(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim())
  if (!m) return null
  const hours = Number(m[1])
  const minutes = Number(m[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/**
 * Is the clock inside the quiet-hours window right now?
 *
 * The window is local wall-clock time and routinely spans midnight
 * (22:00–07:00 is the default shape), so it is a *set of times of day*, not an
 * interval between two instants: `from > to` wraps. Both ends behave the way a
 * person reading "22:00–07:00" expects — quiet from 22:00 inclusive, awake
 * again at 07:00 — and `from === to` is the empty window, which is off rather
 * than "silent for 24 hours" (nobody types 09:00–09:00 meaning "never
 * interrupt me again").
 *
 * Anything malformed reads as off. This function can only ever *suppress* a
 * notification, so a bad value must fail towards letting it through.
 */
export function inQuietHours(quietHours: QuietHours | undefined, now: number, tz?: string): boolean {
  if (!quietHours || quietHours.enabled !== true) return false
  const from = clockMinutes(quietHours.from)
  const to = clockMinutes(quietHours.to)
  if (from === null || to === null || from === to) return false
  const at = minutesOfDay(now, tz)
  if (at === null) return false
  return from < to ? at >= from && at < to : at >= from || at < to
}

/** What the pull-request selector is set to, defaulted for a pre-1.4 profile. */
export function prAlertMode(settings: NotifyPrefs): 'all' | 'mine' | 'none' {
  return settings.notifyPrs === 'mine' || settings.notifyPrs === 'none' ? settings.notifyPrs : 'all'
}

/**
 * The snooze deadline as a number, or 0. A renderer can write anything through
 * `settings.set` (the handler takes a `Partial<SettingsView>` and merges it),
 * so a non-number here must read as "not paused" rather than as a comparison
 * against NaN — which is false in one direction and false in the other too.
 */
function snoozeUntilMs(settings: NotifyPrefs): number {
  const v = settings.snoozeUntil
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** True while "pause everything" is running. A deadline in the past is simply Off. */
export function isSnoozed(settings: NotifyPrefs, now: number): boolean {
  return snoozeUntilMs(settings) > now
}

/** ms left on the pause, 0 when it is not running — for the popover's "Paused until 15:30". */
export function snoozeRemainingMs(settings: NotifyPrefs, now: number): number {
  return Math.max(0, snoozeUntilMs(settings) - now)
}

/**
 * Should this message raise an OS notification?
 *
 * A private group is a conversation you were personally invited into, so it
 * follows the DM switch rather than the channel preference — the same rule
 * `maybeNotify` has always applied, now with a switch of its own behind it.
 * `mentioned` covers both a direct @mention and @here.
 */
export function shouldNotifyChat(input: {
  kind: NotifyConvKind
  mentioned: boolean
  settings: NotifyPrefs
  now: number
  /** Tests only: the zone the quiet-hours window is read in (default: this machine's). */
  tz?: string
}): boolean {
  const { kind, mentioned, settings, now } = input
  if (isSnoozed(settings, now)) return false
  if (inQuietHours(settings.quietHours, now, input.tz)) return false
  if (kind === 'dm' || kind === 'grp') return settings.notifyDms !== false
  if (settings.notifyChannels === 'none') return false
  if (settings.notifyChannels === 'mentions') return mentioned
  return true
}

/** The parts of a `PrView` the decision reads. A whole `PrView` satisfies it. */
export type PrNotifyView = Pick<PrView, 'author' | 'assignedToMe'> & { state?: PrState }

/**
 * "Mine": this pull request is waiting on me right now (I am in `state.nextIds`),
 * or it was assigned to me for review, or I wrote it. The first of those is the
 * 1.4 addition — being a listed reviewer is not the same as being the person
 * everyone is currently waiting for.
 *
 * `meId` is the identity the poll authenticated as. On a team's shared token
 * that is whoever configured the group, not the reader, so the author test is
 * only meaningful when the caller passes a personal identity — exactly like
 * the "never toast my own PR" rule in `PrService.notify`.
 */
export function prInvolvesMe(view: PrNotifyView, meId: string | null | undefined): boolean {
  const id = typeof meId === 'string' ? meId : ''
  if (id !== '' && (view.state?.nextIds ?? []).includes(id)) return true
  if (view.assignedToMe) return true
  return id !== '' && view.author.id === id
}

/**
 * Should this pull request interrupt — as an OS toast, or as the in-app alert
 * card? Arrival rules (is it new, is it approved, did I write it) stay with the
 * callers; this is only the preference gate, so both surfaces share it.
 */
export function shouldNotifyPr(input: {
  view: PrNotifyView
  meId: string | null | undefined
  settings: NotifyPrefs
  now: number
  /** Tests only: the zone the quiet-hours window is read in (default: this machine's). */
  tz?: string
}): boolean {
  const { view, meId, settings, now } = input
  if (isSnoozed(settings, now)) return false
  if (inQuietHours(settings.quietHours, now, input.tz)) return false
  const mode = prAlertMode(settings)
  if (mode === 'none') return false
  if (mode === 'all') return true
  return prInvolvesMe(view, meId)
}

// ---------------------------------------------------------------------------
// The popover's chat selector
//
// Three named presets over two switches. The pair can also hold combinations no
// preset names (channels off but DMs on, say, from the Settings modal) — that
// is 'custom', and the popover shows it as the selected state rather than
// silently rewriting a deliberate setup the first time somebody opens the bell.

export type ChatAlertPreset = 'all' | 'mine' | 'none' | 'custom'

export function chatPreset(settings: NotifyPrefs): ChatAlertPreset {
  const dms = settings.notifyDms !== false
  if (settings.notifyChannels === 'all' && dms) return 'all'
  if (settings.notifyChannels === 'mentions' && dms) return 'mine'
  if (settings.notifyChannels === 'none' && !dms) return 'none'
  return 'custom'
}

/** What picking a preset writes. 'custom' is never written — it is only ever read. */
export function chatPresetPatch(preset: Exclude<ChatAlertPreset, 'custom'>): {
  notifyChannels: SettingsView['notifyChannels']
  notifyDms: boolean
} {
  if (preset === 'all') return { notifyChannels: 'all', notifyDms: true }
  if (preset === 'mine') return { notifyChannels: 'mentions', notifyDms: true }
  return { notifyChannels: 'none', notifyDms: false }
}

/**
 * The two pauses on offer: an hour from now, and tomorrow morning at 9:00.
 * Local time on purpose — "9:00 tomorrow" is a promise about the machine's
 * own clock, not about UTC — and always the *next* day, so a pause set at 2am
 * does not quietly expire seven hours later on the same morning it was set.
 */
export function snoozeChoices(now: number): { hour: number; tomorrow: number } {
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  return { hour: now + 3_600_000, tomorrow: tomorrow.getTime() }
}

/**
 * Is *everything* silenced? Drives the slash on the bell icon: the pause is
 * running, quiet hours are running, or both selectors sit at their quietest
 * setting and nothing at all can come through.
 */
export function alertsSilenced(settings: NotifyPrefs, now: number, tz?: string): boolean {
  if (isSnoozed(settings, now)) return true
  if (inQuietHours(settings.quietHours, now, tz)) return true
  return prAlertMode(settings) === 'none' && chatPreset(settings) === 'none'
}
