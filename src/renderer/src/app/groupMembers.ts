import type { ConvId, PresenceView } from '@shared/types'
import { PREVIOUS_DEVICE } from './peopleRows'
import { preferFreshestTwin } from './twinDevices'

// Pure filtering/ordering helpers shared by GroupDialog (who can be added,
// and how a current member is named) and RightRail (who is currently in the
// group) — 1.2 private groups. Kept dependency-free so they're trivially
// unit-testable (groupMembers.test.ts).

/**
 * People eligible to be added to a group: present, not departed, not the
 * local device, not already a member. Optionally narrowed by a search query
 * matched against name or hostname (case-insensitive substring).
 */
export function pickAddCandidates(
  presence: PresenceView[],
  selfDeviceId: string,
  currentMembers: readonly string[],
  query = '',
): PresenceView[] {
  const q = query.trim().toLowerCase()
  const members = new Set(currentMembers)
  // `preferFreshestTwin`: in the seconds before main can prove a re-joined
  // person's old registration is dead (twinDevices.ts), the picker would
  // otherwise offer the same person twice with no way to tell which row can
  // still read the group key.
  return preferFreshestTwin(presence)
    .filter((p) => !p.departed && p.deviceId !== selfDeviceId && !members.has(p.deviceId))
    .filter((p) => q === '' || p.name.toLowerCase().includes(q) || p.hostname.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The tail of a "Current members" row's name in GroupDialog: owner, you, and
 * — the 1.4 case — a device superseded by a re-join from the same machine.
 *
 * That dialog is the one people-listing surface that deliberately does *not*
 * drop a superseded device the way the members rail does (`groupMemberRows`).
 * A group membership is a list of device ids, and the old id is still on it
 * holding a key that can still decrypt: the owner has to be able to see it
 * and remove it. So the row stays and says which device it is, instead of
 * showing the same person twice under one name — and the Remove button's
 * label says it too, so "Remove Gil (previous device)" can never be mistaken
 * for removing the Gil who is actually there.
 */
export function memberRowSuffix(
  person: PresenceView | undefined,
  opts: { owner?: boolean; self?: boolean } = {},
): string {
  const previous = person?.supersededBy ? ` ${PREVIOUS_DEVICE}` : ''
  return `${previous}${opts.owner ? ' · owner' : ''}${opts.self ? ' (you)' : ''}`
}

export interface SelfIdentity {
  deviceId: string
  name: string
  hostname: string
  fingerprint: string
  /** 1.4 — our own status/presence, from the store's `selfPresence`. Absent reads as no status, online. */
  status?: string
  state?: PresenceView['state']
}

const RANK = { online: 0, away: 1, offline: 2 } as const

/**
 * Presence rows for a group's current members, in display order (online
 * first, then away, then offline; alphabetical within each tier). `presence`
 * never includes the local device (the main process filters it out of the
 * roster), so `self` is spliced in directly wherever the member list names
 * it — which it always does, for a group this device can even see.
 * `selfConv` fills the unused-but-required PresenceView.dmConv field.
 */
export function groupMemberRows(
  members: readonly string[],
  presence: PresenceView[],
  self: SelfIdentity | null,
  selfConv: ConvId,
): PresenceView[] {
  const rows: PresenceView[] = []
  for (const id of members) {
    if (self && id === self.deviceId) {
      rows.push({
        deviceId: self.deviceId,
        name: self.name,
        hostname: self.hostname,
        fingerprint: self.fingerprint,
        state: self.state ?? 'online',
        status: self.status ?? '',
        lastSeenMs: null,
        trust: 'trusted',
        dmConv: selfConv,
        departed: false,
      })
      continue
    }
    const p = presence.find((pp) => pp.deviceId === id)
    // A member presence hasn't been seen (or is no longer roster-visible) —
    // skip rather than fabricate a row, matching how the channel members
    // list only ever shows what presence actually knows. A device superseded
    // by a re-join from the same machine (1.4) is skipped for the opposite
    // reason: presence knows it perfectly well, and knows nobody is behind it
    // — listing it puts the same person in the rail twice.
    if (p && !p.supersededBy) rows.push(p)
  }
  return rows.sort((a, b) => RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name))
}
