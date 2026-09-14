import type { PresenceStateKind } from '@shared/types'
import { normalizeStatus } from '@shared/presenceStatus'

// What goes on the second line under a person's name (1.4).
//
// Every person row in the app is two lines now: the name, then the status.
// When there is no status the line still has to say something — otherwise the
// row jumps between one and two lines depending on whether a teammate has
// typed anything today — so presence itself fills it, muted. Pure so the rule
// is one testable place rather than four copies of `p.status || …`.

export interface PresenceLine {
  text: string
  /** True when this is a fallback (presence, or the footer's invitation), not a real status. */
  muted: boolean
}

export interface PresenceLineInput {
  status?: string | null
  state: PresenceStateKind
  /** Nobody is behind this registration any more — says so instead of "Offline". */
  departed?: boolean
  /** The local device's own row: invite a status rather than describe presence. */
  self?: boolean
}

const STATE_LABEL: Record<PresenceStateKind, string> = {
  online: 'Online',
  away: 'Away',
  offline: 'Offline',
}

/** The footer's placeholder, exported so the button's aria-label can match it. */
export const SET_A_STATUS = 'Set a status'

export function presenceLine(input: PresenceLineInput): PresenceLine {
  const status = normalizeStatus(input.status)
  if (status) return { text: status, muted: false }
  if (input.self) return { text: SET_A_STATUS, muted: true }
  if (input.departed) return { text: 'No longer on the share', muted: true }
  return { text: STATE_LABEL[input.state], muted: true }
}
