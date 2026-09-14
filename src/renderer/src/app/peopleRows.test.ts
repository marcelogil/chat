import { describe, expect, it } from 'vitest'
import type { ConvId, PresenceView } from '@shared/types'
import { PREVIOUS_DEVICE, peopleRows, type DmFacts } from './peopleRows'
import { groupMemberRows, pickAddCandidates } from './groupMembers'
import { countPreTombstonePeers } from './outdatedPeers'

// The renderer half of "I reset my machine and now there are two of me" (1.4):
// main flags the leftover registration `departed` + `supersededBy`, and every
// surface that lists people has to act on it.

function person(over: Partial<PresenceView> & { deviceId: string; name: string }): PresenceView {
  return {
    hostname: 'GILS-MACBOOK',
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

/** No DM anywhere holds anything, unless named. */
function dms(history: string[] = [], unread: string[] = []): DmFacts {
  return {
    hasHistory: (conv) => history.includes(conv) || unread.includes(conv),
    unread: (conv) => (unread.includes(conv) ? 1 : 0),
  }
}

const ME = 'me000001'
const GIL_OLD = person({ deviceId: 'gil00old', name: 'Gil', departed: true, supersededBy: 'gil00new', state: 'offline' })
const GIL_NEW = person({ deviceId: 'gil00new', name: 'Gil' })
const ANA = person({ deviceId: 'ana00001', name: 'Ana', hostname: 'ANA-BOX' })

describe('peopleRows', () => {
  it('lists one Gil after a re-join, and it is the new device', () => {
    const rows = peopleRows([GIL_OLD, GIL_NEW, ANA, person({ deviceId: ME, name: 'Me' })], ME, dms())
    expect(rows.map((r) => r.person.deviceId)).toEqual(['ana00001', 'gil00new'])
  })

  it('keeps the superseded device when its DM holds history, under its own label', () => {
    const rows = peopleRows([GIL_OLD, GIL_NEW], ME, dms(['dm:gil00old']))
    expect(rows.map((r) => r.label)).toEqual(['Gil', `Gil ${PREVIOUS_DEVICE}`])
    // Both rows open different conversations — that is the whole point of
    // keeping the old one reachable.
    expect(rows.map((r) => r.person.dmConv)).toEqual(['dm:gil00new', 'dm:gil00old'])
  })

  it('keeps it for history that has already been read, unlike an ordinary departed row', () => {
    // A merely-departed teammate's row goes the moment their last message is
    // read; the superseded device's history can never move anywhere else.
    const quiet = person({ deviceId: 'zoe00001', name: 'Zoe', departed: true, state: 'offline' })
    const rows = peopleRows([GIL_OLD, quiet], ME, dms(['dm:gil00old', 'dm:zoe00001']))
    expect(rows.map((r) => r.person.deviceId)).toEqual(['gil00old'])
  })

  it('still lists a departed teammate who left something unread', () => {
    const quiet = person({ deviceId: 'zoe00001', name: 'Zoe', departed: true, state: 'offline' })
    const rows = peopleRows([quiet], ME, dms([], ['dm:zoe00001']))
    expect(rows.map((r) => r.label)).toEqual(['Zoe'])
  })

  it('never lists the local device', () => {
    expect(peopleRows([person({ deviceId: ME, name: 'Me' })], ME, dms())).toEqual([])
  })

  it('orders online first, then away, then offline, alphabetically inside each', () => {
    const rows = peopleRows(
      [
        person({ deviceId: 'd1', name: 'Zoe' }),
        person({ deviceId: 'd2', name: 'Ana', state: 'offline' }),
        person({ deviceId: 'd3', name: 'Bo', state: 'away' }),
        person({ deviceId: 'd4', name: 'Al' }),
      ],
      ME,
      dms(),
    )
    expect(rows.map((r) => r.label)).toEqual(['Al', 'Zoe', 'Bo', 'Ana'])
  })
})

describe('the other surfaces that list people', () => {
  it('leaves a superseded device out of the group members rail', () => {
    const rows = groupMemberRows(['gil00old', 'gil00new', 'ana00001'], [GIL_OLD, GIL_NEW, ANA], null, 'dm:me' as ConvId)
    expect(rows.map((r) => r.deviceId)).toEqual(['ana00001', 'gil00new'])
  })

  it('leaves it out of the group add-member picker', () => {
    const out = pickAddCandidates([GIL_OLD, GIL_NEW, ANA], ME, [])
    expect(out.map((p) => p.deviceId)).toEqual(['ana00001', 'gil00new'])
  })

  it('does not count it as a teammate on an older build', () => {
    // No `app` on the leftover record (nothing has beaconed one since the
    // reset), which is exactly what the update banner counts.
    expect(countPreTombstonePeers([{ ...GIL_OLD, app: undefined }, { ...GIL_NEW, app: '1.4.0' }])).toBe(0)
  })
})
