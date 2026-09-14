import type { ConvId, PresenceView } from '@shared/types'

// Who the sidebar's "Direct messages" section lists, and under what name
// (1.4). Pure so it can be unit-tested without mounting Sidebar.tsx.
//
// Three kinds of row can come out of one presence list:
//
//  - live teammates, always listed;
//  - a device superseded by a re-join from the same machine (`supersededBy`),
//    which is a person's *previous* identity — listed only when that DM holds
//    something, and labelled so nobody wonders why they are on the list twice;
//  - everyone else main has flagged `departed` (no beacon at all, or quiet for
//    days), listed only while they still owe us something unread.
//
// The superseded row is deliberately stickier than the departed one: its
// history can never move anywhere else. The old identity's DM is a separate
// conversation from the new one (a different pair token, a different key), so
// hiding it the moment it is read would put those messages out of reach for
// good.

export const PREVIOUS_DEVICE = '(previous device)'

export interface PersonRow {
  person: PresenceView
  /** What to render as the name — the label, never `person.name`, in the UI. */
  label: string
}

const RANK = { online: 0, away: 1, offline: 2 } as const

export interface DmFacts {
  /** Does this DM hold any message at all (sent or received, read or not)? */
  hasHistory(conv: ConvId): boolean
  /** Unread messages waiting in this DM. */
  unread(conv: ConvId): number
}

export function peopleRows(
  presence: readonly PresenceView[],
  selfDeviceId: string,
  dm: DmFacts,
): PersonRow[] {
  const rows: PersonRow[] = []
  for (const person of presence) {
    if (person.deviceId === selfDeviceId) continue
    if (person.supersededBy) {
      if (!dm.hasHistory(person.dmConv)) continue
      rows.push({ person, label: `${person.name} ${PREVIOUS_DEVICE}` })
      continue
    }
    if (person.departed && dm.unread(person.dmConv) <= 0) continue
    rows.push({ person, label: person.name })
  }
  return rows.sort(
    (a, b) => RANK[a.person.state] - RANK[b.person.state] || a.label.localeCompare(b.label),
  )
}
