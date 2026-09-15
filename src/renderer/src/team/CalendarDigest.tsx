import { useCallback, useEffect } from 'react'
import { materializeCalendar, ymd } from '@shared/calendar'
import { TEAM_CONV } from '@shared/constants'
import { useStore } from '@/store'
import { toast } from '@/app/toasts'
import { dailyDigest, shouldShowDigest } from './dailyDigest'

// 1.5 — the daily calendar toast. Mounted once in AppShell, renders nothing.
//
// Two triggers only (spec): at boot, once the team calendar log has actually
// been read, and again on any later window focus once the calendar day has
// rolled forward. Both funnel through `attempt()`, which is itself the "once
// per day" gate — `shouldShowDigest` — so there is exactly one code path to
// get right instead of two.
//
// "Read" means `ensureEvents` has resolved at least once for team:calendar —
// checking the *event array* would treat an empty-but-fetched log the same as
// one nobody has asked for yet, and fire nothing forever on a quiet team.
//
// The toast is deliberately about a day late to fire twice: once shown (or
// once found to have nothing to say), `lastShown` moves to today regardless,
// so a dozen focus events on the same quiet afternoon do not recompute a dozen
// times. The one exception is the calendar pane being open — that suppresses
// *display* without spending the day's attempt, so closing the pane later the
// same day (or the next natural trigger) still gets a chance to show it.

const DIGEST_MS = 8000
const KEY_PREFIX = 'chat.calendarDigest.lastShown.'

function lastShownStore(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null // private mode / blocked storage
  }
}

function readLastShown(sharePath: string): string | null {
  try {
    return lastShownStore()?.getItem(KEY_PREFIX + sharePath) ?? null
  } catch {
    return null
  }
}

function writeLastShown(sharePath: string, day: string): void {
  try {
    lastShownStore()?.setItem(KEY_PREFIX + sharePath, day)
  } catch {
    // quota / private mode — worst case the digest re-checks next launch
  }
}

export function CalendarDigest() {
  const boot = useStore((s) => s.boot)
  const activeConv = useStore((s) => s.activeConv)
  const events = useStore((s) => s.events[TEAM_CONV.calendar])
  const eventsLoaded = useStore((s) => s.eventsLoaded[TEAM_CONV.calendar])
  const ensureEvents = useStore((s) => s.ensureEvents)

  useEffect(() => {
    if (boot?.mode === 'ready') void ensureEvents(TEAM_CONV.calendar)
  }, [boot?.mode, ensureEvents])

  const attempt = useCallback(() => {
    if (boot?.mode !== 'ready' || !eventsLoaded) return
    const sharePath = boot.self.sharePath
    const today = ymd(new Date())
    if (!shouldShowDigest(readLastShown(sharePath), today)) return
    // The calendar pane being open suppresses display only — the day's
    // attempt is not spent, so the next trigger (a later focus, tomorrow's
    // boot) still gets to show it.
    if (activeConv === TEAM_CONV.calendar) return
    writeLastShown(sharePath, today)
    const message = dailyDigest(materializeCalendar(events ?? []), today)
    if (message) toast(message, 'info', DIGEST_MS)
  }, [boot, activeConv, eventsLoaded, events])

  // Trigger 1: boot — fires as soon as ready + the log has been read land
  // together (in whichever order they resolve).
  useEffect(() => {
    attempt()
  }, [attempt])

  // Trigger 2: window focus, gated to a later calendar day by shouldShowDigest.
  useEffect(() => {
    function onFocus() {
      attempt()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [attempt])

  return null
}
