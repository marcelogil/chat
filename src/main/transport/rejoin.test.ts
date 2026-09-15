import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConvId, MsgPayload, PresenceView } from '@shared/types'
import { generateIdentity, type DeviceIdentity } from '../crypto/identity'
import type { SecretStore } from '../store/secretStore'
import { BeaconWriter } from './beacon'
import { createOrJoinTeam } from './bootstrap'
import { EventStore } from './events'
import { Poller } from './poller'
import { Roster } from './roster'
import { Session } from './session'
import { ShareIo } from './shareIo'

// "Reset local data", then re-join from the same machine with the same name:
// three in-process clients against one folder — the device that was reset
// (alice-old), the one that replaced it (alice-new), and Bob watching from the
// other side. The bug this covers is a person appearing twice on every roster
// surface, forever on their own client and for three days on everyone else's.

vi.mock('electron', () => ({
  app: { getVersion: () => '1.4.0', getPath: () => '/tmp', dock: null },
  BrowserWindow: class {},
  Notification: class {
    static isSupported(): boolean {
      return false
    }
  },
  shell: { openPath: async () => '', showItemInFolder: () => {} },
  dialog: {},
  nativeImage: { createFromDataURL: () => ({}) },
}))

class FakeStore implements SecretStore {
  readonly unlocked = true
  private m = new Map<string, Buffer>()
  writeSecret(name: string, data: Buffer): void {
    this.m.set(name, Buffer.from(data))
  }
  readSecret(name: string): Buffer | null {
    return this.m.get(name) ?? null
  }
  writeSecretJson(name: string, value: unknown): void {
    this.writeSecret(name, Buffer.from(JSON.stringify(value)))
  }
  readSecretJson<T>(name: string): T | null {
    const b = this.readSecret(name)
    return b ? (JSON.parse(b.toString()) as T) : null
  }
  deleteSecret(name: string): void {
    this.m.delete(name)
  }
}

const PASS = 'correct horse battery staple'

interface Client {
  identity: DeviceIdentity
  session: Session
  roster: Roster
  writer: BeaconWriter
  poller: Poller
  events: EventStore
}

interface Facts {
  displayName: string
  hostname: string
  machineIdHash: string | null
  firstSeen: number
}

/** One share folder plus a factory for as many independent clients as we like. */
async function team(): Promise<{ newClient: (facts: Facts) => Promise<Client> }> {
  const root = mkdtempSync(join(tmpdir(), 'sem-rejoin-'))
  const res = await createOrJoinTeam(new ShareIo(root), PASS, 'Test Team')
  if ('error' in res) throw new Error(res.error)
  const { proto, teamSalt, tmk } = res.join

  const newClient = async (facts: Facts): Promise<Client> => {
    // A client is its own process on the real thing: its own identity, its own
    // local secret store, its own handle on the folder.
    const identity = generateIdentity().identity
    const io = new ShareIo(root)
    const store = new FakeStore()
    const seed = new Session(
      io,
      store,
      identity,
      proto,
      teamSalt,
      tmk,
      tmk,
      new Roster(io, store, tmk, proto.epoch),
      facts.displayName,
    )
    const roster = new Roster(io, store, seed.keys.kMeta, proto.epoch)
    roster.loadPins()
    const session = new Session(io, store, identity, proto, teamSalt, tmk, tmk, roster, facts.displayName)
    await roster.publishSelf(identity, {
      deviceId: identity.deviceId,
      edPub: identity.edPub,
      xPub: identity.xPub,
      displayName: facts.displayName,
      hostname: facts.hostname,
      osUser: 'gil',
      platform: 'darwin',
      machineIdHash: facts.machineIdHash,
      firstSeen: facts.firstSeen,
      recSeq: 1,
    })
    const events = new EventStore(session)
    return {
      identity,
      session,
      roster,
      writer: new BeaconWriter(session),
      poller: new Poller(session, events),
      events,
    }
  }
  return { newClient }
}

/** What a client's roster surfaces would show right now, by device id. */
async function viewsOf(c: Client): Promise<Map<string, PresenceView>> {
  await c.roster.refresh()
  c.session.refreshDms()
  await c.poller.tick()
  return new Map(c.poller.presenceViews().map((v) => [v.deviceId, v]))
}

describe('a person who reset local data and re-joined from the same machine', () => {
  it('leaves exactly one of themselves on every client, at once', async () => {
    const now = Date.now()
    const { newClient } = await team()
    const machine = { hostname: 'Gils-MacBook-Pro.local', machineIdHash: 'mid-gil' }
    const oldAlice = await newClient({ displayName: 'Gil', ...machine, firstSeen: now - 30 * 86_400_000 })
    const bob = await newClient({ displayName: 'Bob', hostname: 'bob-box', machineIdHash: 'mid-bob', firstSeen: now })
    // Both are live and beaconing before the reset.
    await oldAlice.writer.bump('startup')
    await bob.writer.bump('startup')

    // Nothing is wrong yet: one registration each, nobody hidden.
    const before = await viewsOf(bob)
    expect(before.get(oldAlice.identity.deviceId)?.departed).toBe(false)

    // Quitting for the reset leaves a goodbye beacon — the app's own "nobody
    // is behind this any more", and the reason the ghost goes on the first
    // poll rather than when its heartbeat goes stale.
    await oldAlice.writer.stop()

    // The reset: a brand-new identity, same person, same machine, same name.
    // (The old registration stays on the share — it always does.)
    const newAlice = await newClient({ displayName: 'Gil', ...machine, firstSeen: now })
    await newAlice.writer.bump('startup')

    // Bob, after a single poll — not after PRESENCE.departedAfterMs.
    const onBob = await viewsOf(bob)
    const oldOnBob = onBob.get(oldAlice.identity.deviceId)
    expect(oldOnBob?.departed).toBe(true)
    expect(oldOnBob?.supersededBy).toBe(newAlice.identity.deviceId)
    expect(oldOnBob?.state).toBe('offline')
    expect(onBob.get(newAlice.identity.deviceId)?.departed).toBe(false)
    expect(onBob.get(newAlice.identity.deviceId)?.supersededBy).toBeUndefined()
    expect([...onBob.values()].filter((v) => v.name === 'Gil' && !v.departed)).toHaveLength(1)

    // And on the re-joined device itself, where the record that supersedes the
    // ghost is the local one — the case a roster comparison that skips `self`
    // can never see, and the one the person actually reported.
    const onSelf = await viewsOf(newAlice)
    expect(onSelf.has(newAlice.identity.deviceId)).toBe(false) // never lists itself
    expect(onSelf.get(oldAlice.identity.deviceId)?.departed).toBe(true)
    expect(onSelf.get(oldAlice.identity.deviceId)?.supersededBy).toBe(newAlice.identity.deviceId)
    expect([...onSelf.values()].filter((v) => v.name === 'Gil' && !v.departed)).toHaveLength(0)

    // The old registration is only *hidden*: it is still in the roster, so
    // everything it ever signed still verifies and still has a name.
    expect(bob.session.roster.get(oldAlice.identity.deviceId)?.record.displayName).toBe('Gil')

    // …and the survivor is not left wearing the impersonation chip. TOFU
    // flags a new device that claims a pinned display name; a re-join from
    // the same machine is not that, and flagging it would leave the real
    // person marked as a suspected impersonator in the sidebar, the members
    // rail and the group dialog — for good, on every teammate's screen.
    expect(bob.session.roster.getPin(newAlice.identity.deviceId)?.trust).toBe('pinned')
    expect(bob.session.roster.getPin(oldAlice.identity.deviceId)?.trust).toBe('pinned')
    expect(onBob.get(newAlice.identity.deviceId)?.trust).toBe('pinned')
  })

  // The other half of a re-join, and the one nothing covered before 1.6.1: the
  // ghost is hidden, the new device is pinned — but does what it *writes* still
  // reach the peer that pinned its predecessor? This is the cheap path (one
  // beacon read, no directory scan), because the expensive one would mask a
  // real failure behind a ten-minute sweep at the idle tier.
  it("delivers the re-joined device's channel messages on the beacon path", async () => {
    const now = Date.now()
    const { newClient } = await team()
    const machine = { hostname: 'Gils-MacBook-Pro.local', machineIdHash: 'mid-gil' }
    const oldAlice = await newClient({ displayName: 'Gil', ...machine, firstSeen: now - 30 * 86_400_000 })
    const bob = await newClient({ displayName: 'Bob', hostname: 'bob-box', machineIdHash: 'mid-bob', firstSeen: now })
    await oldAlice.writer.bump('startup')
    await bob.writer.bump('startup')
    await viewsOf(bob) // Bob pins the old device — TOFU, before the reset

    await oldAlice.writer.stop()
    const newAlice = await newClient({ displayName: 'Gil', ...machine, firstSeen: now })
    await newAlice.writer.bump('startup')
    await viewsOf(bob) // …and meets the replacement

    const ch = await newAlice.session.createChannel('general')
    const conv: ConvId = `chan:${ch.channelId}`
    const sent = await newAlice.events.publish(conv, 'msg', {
      t: 'msg',
      conv,
      author: { device: newAlice.identity.deviceId, name: 'Gil' },
      senderSeq: newAlice.session.nextSenderSeq(conv),
      sentWall: Date.now(),
      body: { kind: 'text', text: 'back, with a new device id' },
    } satisfies MsgPayload)
    newAlice.writer.noteOwnEvent(conv, `${sent.id}.msg.e1`)
    await newAlice.writer.bump('event')

    // Sweep pinned shut: only the beacon may deliver this.
    ;(bob.poller as unknown as { lastSweepAt: number }).lastSweepAt = Date.now()
    await bob.poller.tick()
    expect(bob.events.has(conv, sent.id)).toBe(true)
    expect(bob.events.getEvents(conv)[0].verified).toBe(true)
    // Nothing about the superseded predecessor changes that.
    expect(bob.session.roster.getPin(newAlice.identity.deviceId)?.trust).toBe('pinned')
  })

  it('still flags a namesake arriving from a different machine', async () => {
    const now = Date.now()
    const { newClient } = await team()
    const gil = await newClient({
      displayName: 'Gil',
      hostname: 'Gils-MacBook-Pro.local',
      machineIdHash: 'mid-gil',
      firstSeen: now - 86_400_000,
    })
    const bob = await newClient({ displayName: 'Bob', hostname: 'bob-box', machineIdHash: 'mid-bob', firstSeen: now })
    await bob.roster.refresh() // Bob pins the real Gil first — TOFU

    const impostor = await newClient({
      displayName: 'Gil',
      hostname: 'not-gils-mac',
      machineIdHash: 'mid-impostor',
      firstSeen: now,
    })
    await bob.roster.refresh()
    expect(bob.session.roster.getPin(impostor.identity.deviceId)?.trust).toBe('flagged')
    expect(bob.session.roster.getPin(gil.identity.deviceId)?.trust).toBe('pinned')
  })

  it('clears a flag an older client pinned on the device the person is actually using', async () => {
    const now = Date.now()
    const { newClient } = await team()
    const machine = { hostname: 'Gils-MacBook-Pro.local', machineIdHash: 'mid-gil' }
    const oldAlice = await newClient({ displayName: 'Gil', ...machine, firstSeen: now - 30 * 86_400_000 })
    const newAlice = await newClient({ displayName: 'Gil', ...machine, firstSeen: now })
    const bob = await newClient({ displayName: 'Bob', hostname: 'bob-box', machineIdHash: 'mid-bob', firstSeen: now })
    await bob.roster.refresh()

    // What a pre-1.4 client's pin store looks like the day it upgrades: the
    // re-joined device was flagged the moment its record landed, and nothing
    // would ever have taken that back.
    bob.session.roster.setTrust(newAlice.identity.deviceId, 'flagged')
    await bob.session.roster.loadOne(newAlice.identity.deviceId)
    expect(bob.session.roster.getPin(newAlice.identity.deviceId)?.trust).toBe('pinned')
    // A decision is not a guess: revoked survives re-reading the record.
    bob.session.roster.setTrust(oldAlice.identity.deviceId, 'revoked')
    await bob.session.roster.loadOne(oldAlice.identity.deviceId)
    expect(bob.session.roster.getPin(oldAlice.identity.deviceId)?.trust).toBe('revoked')
  })

  it('judges nothing before the first beacon listing', async () => {
    const now = Date.now()
    const { newClient } = await team()
    const machine = { hostname: 'Gils-MacBook-Pro.local', machineIdHash: 'mid-gil' }
    const oldAlice = await newClient({ displayName: 'Gil', ...machine, firstSeen: now - 30 * 86_400_000 })
    const newAlice = await newClient({ displayName: 'Gil', ...machine, firstSeen: now })
    const bob = await newClient({ displayName: 'Bob', hostname: 'bob-box', machineIdHash: 'mid-bob', firstSeen: now })
    await oldAlice.writer.stop()
    await newAlice.writer.bump('startup')

    // The renderer asks for `presence:list` in loadTeam, which can land
    // before the poller's first tick. Supersession is only sound because a
    // live predecessor can veto it, and that veto is a beacon — none have
    // been read yet, so every device on the share would look dead. Two dev
    // profiles under one name is exactly the shape that gets this wrong.
    await bob.roster.refresh()
    bob.session.refreshDms()
    const pre = bob.poller.presenceViews()
    expect(pre).toHaveLength(2)
    expect(pre.some((v) => v.departed || v.supersededBy)).toBe(false)

    // One tick later it is answered.
    const after = await viewsOf(bob)
    expect(after.get(oldAlice.identity.deviceId)?.supersededBy).toBe(newAlice.identity.deviceId)
  })

  it('takes one stale heartbeat to hide a predecessor that was killed without a goodbye', async () => {
    const now = Date.now()
    const { newClient } = await team()
    const machine = { hostname: 'Gils-MacBook-Pro.local', machineIdHash: 'mid-gil' }
    const oldAlice = await newClient({ displayName: 'Gil', ...machine, firstSeen: now - 30 * 86_400_000 })
    const bob = await newClient({ displayName: 'Bob', hostname: 'bob-box', machineIdHash: 'mid-bob', firstSeen: now })
    await oldAlice.writer.bump('startup')
    await bob.writer.bump('startup')
    // Force-quit, crash, power cut: no goodbye beacon, just a heartbeat that
    // stops. Nothing on the share says this device is gone.
    const newAlice = await newClient({ displayName: 'Gil', ...machine, firstSeen: now })
    await newAlice.writer.bump('startup')

    // For as long as that last heartbeat is younger than
    // PRESENCE.onlineWithinMs, both registrations look alive and neither is
    // hidden — the rule refuses to guess, because a second live instance on
    // one machine may beacon only every BEACON.idleHeartbeatMs (45 s) and
    // hiding it would be worse. The renderer resolves the ambiguity where it
    // can actually hurt (mentions, pickers) — see app/twinDevices.ts.
    const during = await viewsOf(bob)
    expect(during.get(oldAlice.identity.deviceId)?.departed).toBe(false)
    expect(during.get(oldAlice.identity.deviceId)?.supersededBy).toBeUndefined()

    // One missed heartbeat later — the whole of the window — it is hidden,
    // with no goodbye needed from anybody.
    const shareNow = bob.session.io.calibratedNow()
    const late = vi.spyOn(bob.session.io, 'calibratedNow').mockReturnValue(shareNow + 60_000)
    try {
      const after = await viewsOf(bob)
      expect(after.get(oldAlice.identity.deviceId)?.supersededBy).toBe(newAlice.identity.deviceId)
      expect(after.get(oldAlice.identity.deviceId)?.state).toBe('offline')
    } finally {
      late.mockRestore()
    }
  })

  it('never hides a second live instance on the same machine that keeps beaconing', async () => {
    const now = Date.now()
    const { newClient } = await team()
    const machine = { hostname: 'Gils-MacBook-Pro.local', machineIdHash: 'mid-gil' }
    const first = await newClient({ displayName: 'Gil', ...machine, firstSeen: now - 60_000 })
    const second = await newClient({ displayName: 'Gil', ...machine, firstSeen: now })
    const bob = await newClient({ displayName: 'Bob', hostname: 'bob-box', machineIdHash: 'mid-bob', firstSeen: now })
    await second.writer.bump('startup')
    await bob.writer.bump('startup')

    // With no beacon of its own the older registration reads as gone — which,
    // at that point, is all anybody can say about it.
    const cold = await viewsOf(bob)
    expect(cold.get(first.identity.deviceId)?.departed).toBe(true)

    // It answers: a live heartbeat, not a goodbye. Two profiles on one
    // machine, not a re-join — nothing a destroyed identity could ever do.
    await first.writer.bump('startup')
    const settled = await viewsOf(bob)
    expect(settled.get(first.identity.deviceId)?.departed).toBe(false)
    expect(settled.get(first.identity.deviceId)?.supersededBy).toBeUndefined()
    expect(settled.get(second.identity.deviceId)?.departed).toBe(false)
  })

  it('does not supersede a namesake on a different machine', async () => {
    const now = Date.now()
    const { newClient } = await team()
    const one = await newClient({
      displayName: 'Gil',
      hostname: 'Gils-MacBook-Pro.local',
      machineIdHash: 'mid-gil',
      firstSeen: now - 86_400_000,
    })
    const two = await newClient({
      displayName: 'Gil',
      hostname: 'gil-desktop',
      machineIdHash: 'mid-desktop',
      firstSeen: now,
    })
    const bob = await newClient({ displayName: 'Bob', hostname: 'bob-box', machineIdHash: 'mid-bob', firstSeen: now })
    await one.writer.bump('startup')
    await two.writer.bump('startup')
    await bob.writer.bump('startup')

    const views = await viewsOf(bob)
    expect(views.get(one.identity.deviceId)?.departed).toBe(false)
    expect(views.get(two.identity.deviceId)?.departed).toBe(false)
  })
})
