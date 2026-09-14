import { describe, expect, it } from 'vitest'
import type { ConvId, PresenceView } from '@shared/types'
import { groupMemberRows, memberRowSuffix, pickAddCandidates } from './groupMembers'

function person(over: Partial<PresenceView> & { deviceId: string; name: string }): PresenceView {
  return {
    hostname: 'host',
    fingerprint: 'AAAA-0000',
    state: 'online',
    status: '',
    lastSeenMs: 1,
    trust: 'trusted',
    dmConv: `dm:${over.deviceId}` as ConvId,
    departed: false,
    ...over,
  }
}

describe('pickAddCandidates', () => {
  const presence = [
    person({ deviceId: 'ana00001', name: 'Ana' }),
    person({ deviceId: 'bo000001', name: 'Bo', hostname: 'bo-laptop' }),
    person({ deviceId: 'cy000001', name: 'Cy', departed: true }),
    person({ deviceId: 'me000001', name: 'Me' }),
  ]

  it('excludes the local device, departed devices, and existing members', () => {
    const out = pickAddCandidates(presence, 'me000001', ['ana00001'])
    expect(out.map((p) => p.deviceId)).toEqual(['bo000001'])
  })

  it('is case-insensitive and matches hostname as well as name', () => {
    const out = pickAddCandidates(presence, 'me000001', [], 'laptop')
    expect(out.map((p) => p.deviceId)).toEqual(['bo000001'])
  })

  it('sorts alphabetically by name', () => {
    const out = pickAddCandidates(presence, 'zzz00000', [])
    expect(out.map((p) => p.name)).toEqual(['Ana', 'Bo', 'Me'])
  })

  it('returns nothing when the query matches nobody', () => {
    expect(pickAddCandidates(presence, 'me000001', [], 'nope')).toEqual([])
  })

  it('offers one row for a person whose re-join main cannot yet tell apart', () => {
    // Killed without a goodbye beacon, so neither registration is `departed`
    // for another ≤50 s (twinDevices.ts). Adding the dead one to a group
    // would hand the key to a device that can never read it.
    const twins = [
      person({ deviceId: 'gil00old', name: 'Gil', hostname: 'gils-mac', lastSeenMs: 1_000 }),
      person({ deviceId: 'gil00new', name: 'Gil', hostname: 'gils-mac', lastSeenMs: 9_000 }),
    ]
    expect(pickAddCandidates(twins, 'me000001', []).map((p) => p.deviceId)).toEqual(['gil00new'])
  })
})

describe('memberRowSuffix', () => {
  const ghost = person({ deviceId: 'gil00old', name: 'Gil', departed: true, supersededBy: 'gil00new' })

  it('names the previous device, so the dialog never shows one person twice under one name', () => {
    expect(memberRowSuffix(ghost)).toBe(' (previous device)')
  })

  it('keeps owner and you where they were', () => {
    expect(memberRowSuffix(person({ deviceId: 'a', name: 'Ana' }), { owner: true })).toBe(' · owner')
    expect(memberRowSuffix(undefined, { self: true })).toBe(' (you)')
    expect(memberRowSuffix(person({ deviceId: 'a', name: 'Ana' }), {})).toBe('')
  })

  it('reads the previous device first — it is part of who the row is, not a role', () => {
    expect(memberRowSuffix(ghost, { owner: true })).toBe(' (previous device) · owner')
  })

  it('says nothing for a member presence has never seen', () => {
    expect(memberRowSuffix(undefined)).toBe('')
  })
})

describe('groupMemberRows', () => {
  const presence = [
    person({ deviceId: 'owner01', name: 'Owner', state: 'away' }),
    person({ deviceId: 'ana00001', name: 'Ana', state: 'offline' }),
  ]
  const self = { deviceId: 'me000001', name: 'Me', hostname: 'my-mac', fingerprint: 'BBBB-1111' }
  const selfConv = 'grp:x' as ConvId

  it('splices the local device in as an online row wherever the member list names it', () => {
    const rows = groupMemberRows(['owner01', 'me000001', 'ana00001'], presence, self, selfConv)
    const me = rows.find((r) => r.deviceId === 'me000001')
    expect(me).toEqual(
      expect.objectContaining({ name: 'Me', state: 'online', hostname: 'my-mac', fingerprint: 'BBBB-1111' }),
    )
  })

  it('orders online before away before offline, alphabetically within each', () => {
    const rows = groupMemberRows(['owner01', 'me000001', 'ana00001'], presence, self, selfConv)
    expect(rows.map((r) => r.deviceId)).toEqual(['me000001', 'owner01', 'ana00001'])
  })

  it('skips a member id presence has no row for, rather than fabricating one', () => {
    const rows = groupMemberRows(['owner01', 'ghost0001'], presence, self, selfConv)
    expect(rows.map((r) => r.deviceId)).toEqual(['owner01'])
  })

  it('works with no self identity (e.g. boot not ready yet)', () => {
    const rows = groupMemberRows(['owner01', 'ana00001'], presence, null, selfConv)
    expect(rows.map((r) => r.deviceId)).toEqual(['owner01', 'ana00001'])
  })
})
