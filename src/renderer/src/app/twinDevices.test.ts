import { describe, expect, it } from 'vitest'
import type { ConvId, PresenceView } from '@shared/types'
import { preferFreshestTwin } from './twinDevices'

// The window main cannot close (1.4): a re-joined person whose previous run
// was killed without writing a goodbye beacon is two live-looking devices
// until that last heartbeat goes stale (≤ PRESENCE.onlineWithinMs). Every
// surface that has to turn a name into ONE device resolves it here.

function person(over: Partial<PresenceView> & { deviceId: string; name: string }): PresenceView {
  return {
    hostname: 'GILS-MACBOOK',
    fingerprint: 'AAAA-0000',
    state: 'online',
    status: '',
    lastSeenMs: 1_000,
    trust: 'pinned',
    dmConv: `dm:${over.deviceId}` as ConvId,
    departed: false,
    ...over,
  }
}

describe('preferFreshestTwin', () => {
  it('keeps the device that beaconed most recently of two the same person left behind', () => {
    // The hard-kill case: the ghost's beacon is frozen at the moment it died,
    // the survivor's is seconds old, and neither is `departed` yet.
    const ghost = person({ deviceId: 'gil00old', name: 'Gil', lastSeenMs: 1_000 })
    const live = person({ deviceId: 'gil00new', name: 'Gil', lastSeenMs: 9_000 })
    expect(preferFreshestTwin([ghost, live]).map((p) => p.deviceId)).toEqual(['gil00new'])
    // Order in doesn't decide it — the beacon does.
    expect(preferFreshestTwin([live, ghost]).map((p) => p.deviceId)).toEqual(['gil00new'])
  })

  it('never collapses two people who merely share a name', () => {
    const one = person({ deviceId: 'gil00001', name: 'Gil', hostname: 'GILS-MACBOOK', lastSeenMs: 1_000 })
    const two = person({ deviceId: 'gil00002', name: 'Gil', hostname: 'GIL-DESKTOP', lastSeenMs: 9_000 })
    expect(preferFreshestTwin([one, two]).map((p) => p.deviceId)).toEqual(['gil00001', 'gil00002'])
  })

  it('reads the name the way a person retypes it', () => {
    const a = person({ deviceId: 'gil00old', name: '  gil ', lastSeenMs: 1_000 })
    const b = person({ deviceId: 'gil00new', name: 'Gil', lastSeenMs: 2_000 })
    expect(preferFreshestTwin([a, b]).map((p) => p.deviceId)).toEqual(['gil00new'])
  })

  it('leaves a row main has already resolved exactly where it is', () => {
    // `supersededBy` is a decision, not an ambiguity: the sidebar keeps that
    // DM reachable under "(previous device)" and this rule must not eat it.
    const ghost = person({
      deviceId: 'gil00old',
      name: 'Gil',
      departed: true,
      supersededBy: 'gil00new',
      state: 'offline',
      lastSeenMs: 1_000,
    })
    const live = person({ deviceId: 'gil00new', name: 'Gil', lastSeenMs: 9_000 })
    expect(preferFreshestTwin([ghost, live]).map((p) => p.deviceId)).toEqual(['gil00old', 'gil00new'])
  })

  it('keeps the first row when neither has ever been seen, and preserves order otherwise', () => {
    const a = person({ deviceId: 'a', name: 'Gil', lastSeenMs: null })
    const b = person({ deviceId: 'b', name: 'Gil', lastSeenMs: null })
    const ana = person({ deviceId: 'c', name: 'Ana', hostname: 'ANA-BOX' })
    expect(preferFreshestTwin([ana, a, b]).map((p) => p.deviceId)).toEqual(['c', 'a'])
  })

  it('leaves an ordinary roster alone', () => {
    const rows = [person({ deviceId: 'a', name: 'Ana', hostname: 'ANA-BOX' }), person({ deviceId: 'b', name: 'Bo' })]
    expect(preferFreshestTwin(rows)).toEqual(rows)
  })
})
