import { describe, expect, it } from 'vitest'
import { provenSameMachine, sameMachine, supersededDevices, supersedes, type DeviceFacts } from './supersede'

const base: DeviceFacts = {
  deviceId: 'old',
  displayName: 'Gil',
  hostname: 'Gils-MacBook-Pro.local',
  machineIdHash: 'mid-gil',
  firstSeen: 1_000,
  live: false,
}

const facts = (over: Partial<DeviceFacts>): DeviceFacts => ({ ...base, ...over })

describe('supersedes', () => {
  const older = facts({ deviceId: 'old', firstSeen: 1_000 })
  const newer = facts({ deviceId: 'new', firstSeen: 2_000 })

  it('fires for the same person, same machine, later registration', () => {
    expect(supersedes(newer, older)).toBe(true)
  })

  it('only ever points forward in time', () => {
    expect(supersedes(older, newer)).toBe(false)
    expect(supersedes(newer, facts({ deviceId: 'twin', firstSeen: 2_000 }))).toBe(false)
  })

  it('ignores a record against itself', () => {
    expect(supersedes(newer, facts({ deviceId: 'new', firstSeen: 1_000 }))).toBe(false)
  })

  it('reads the display name the way a person retypes it', () => {
    expect(supersedes(facts({ deviceId: 'new', firstSeen: 2_000, displayName: '  gil  ' }), older)).toBe(true)
    expect(supersedes(facts({ deviceId: 'new', firstSeen: 2_000, displayName: 'Gil B' }), older)).toBe(false)
  })

  it('compares sanitized hostnames, not raw ones', () => {
    // Same machine, one record written before the .local suffix was trimmed.
    expect(supersedes(facts({ deviceId: 'new', firstSeen: 2_000, hostname: 'Gils-MacBook-Pro' }), older)).toBe(true)
    expect(supersedes(facts({ deviceId: 'new', firstSeen: 2_000, hostname: 'gil-desktop' }), older)).toBe(false)
  })

  it('treats a missing machine fingerprint as unknown, never as different', () => {
    expect(supersedes(facts({ deviceId: 'new', firstSeen: 2_000, machineIdHash: null }), older)).toBe(true)
    expect(supersedes(newer, facts({ machineIdHash: null }))).toBe(true)
    expect(supersedes(facts({ deviceId: 'new', firstSeen: 2_000, machineIdHash: 'mid-other' }), older)).toBe(false)
  })

  it('answers the same question without a clock, for TOFU', () => {
    // `Roster.ingest` asks it to tell a re-join from someone claiming a
    // pinned name (roster.ts): no beacons to read there, and no firstSeen
    // ordering either — either record may be ingested first.
    const machine = { displayName: 'Gil', hostname: 'Gils-MacBook-Pro.local', machineIdHash: 'mid-gil' }
    expect(sameMachine(machine, { ...machine, machineIdHash: null })).toBe(true)
    expect(sameMachine(machine, { ...machine, hostname: 'gil-desktop' })).toBe(false)
    expect(sameMachine(machine, { ...machine, displayName: 'Gil B' })).toBe(false)
    expect(sameMachine(machine, { ...machine, machineIdHash: 'mid-other' })).toBe(false)
  })

  it('demands a fingerprint before it will drop an impersonation warning', () => {
    // Hiding a row tolerates "fingerprint unavailable" because it still needs
    // the predecessor to be provably silent. Un-flagging has no such second
    // half, so it takes a positive match — otherwise anyone who copies a
    // display name and a hostname un-flags themselves.
    const machine = { displayName: 'Gil', hostname: 'Gils-MacBook-Pro.local', machineIdHash: 'mid-gil' }
    expect(provenSameMachine(machine, { ...machine })).toBe(true)
    expect(provenSameMachine(machine, { ...machine, machineIdHash: null })).toBe(false)
    expect(provenSameMachine({ ...machine, machineIdHash: null }, { ...machine, machineIdHash: null })).toBe(false)
    expect(provenSameMachine(machine, { ...machine, hostname: 'gil-desktop' })).toBe(false)
  })

  it('never supersedes a device that is beaconing right now', () => {
    // Two live profiles on one machine under one name: a real device answers,
    // a destroyed one cannot.
    expect(supersedes(newer, facts({ live: true }))).toBe(false)
  })
})

describe('supersededDevices', () => {
  it('maps every dead predecessor to the newest survivor', () => {
    const map = supersededDevices([
      facts({ deviceId: 'a', firstSeen: 1_000 }),
      facts({ deviceId: 'b', firstSeen: 2_000 }),
      facts({ deviceId: 'c', firstSeen: 3_000, live: true }),
      facts({ deviceId: 'bob', displayName: 'Bob', hostname: 'bob-box', machineIdHash: 'mid-bob', live: true }),
    ])
    expect(map.get('a')).toBe('c')
    expect(map.get('b')).toBe('c')
    expect(map.has('c')).toBe(false)
    expect(map.has('bob')).toBe(false)
  })

  it('leaves a lone registration alone', () => {
    expect(supersededDevices([facts({ deviceId: 'only' })]).size).toBe(0)
  })
})
