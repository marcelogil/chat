import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BEACON, DIR, PRESENCE } from '@shared/constants'
import { parseBeaconFileName } from '@shared/ids'
import type { BeaconContent, ConvId, SignedRecord } from '@shared/types'
import { buildAad, decryptRecord } from '../crypto/envelope'
import { generateIdentity } from '../crypto/identity'
import type { SecretStore } from '../store/secretStore'
import { BeaconWriter } from './beacon'
import { createOrJoinTeam } from './bootstrap'
import { Roster } from './roster'
import { selfPresenceView } from './selfPresence'
import { Session } from './session'
import { ShareIo } from './shareIo'

// The beacon is a single-writer file whose sequence lives in its name, and the
// writer deletes its own previous name after each publish. Publishes therefore
// have to be serialized: two in flight at once (a send plus the heartbeat) can
// finish out of order, and the older one's epilogue would delete the newer file
// and leave a stale beacon as this device's latest.

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

/** A session on its own temp share; no peers needed to watch our own writes. */
async function soloSession(): Promise<Session> {
  const io = new ShareIo(mkdtempSync(join(tmpdir(), 'sem-beacon-')))
  const res = await createOrJoinTeam(io, 'correct horse battery staple', 'Test Team')
  if ('error' in res) throw new Error(res.error)
  const { proto, teamSalt, tmk } = res.join
  const store = new FakeStore()
  const identity = generateIdentity().identity
  const roster = new Roster(io, store, tmk, proto.epoch)
  return new Session(io, store, identity, proto, teamSalt, tmk, tmk, roster, 'Me')
}

/**
 * Make publishes complete out of order: the nth call takes `delaysMs[n]` ms
 * (0 past the end). Records the order writes and deletes actually land.
 */
function instrument(session: Session, delaysMs: number[]): string[] {
  const io = session.io
  const log: string[] = []
  const realPublish = io.publish.bind(io)
  const realDelete = io.delete.bind(io)
  let call = 0
  io.publish = async (rel, data, opts) => {
    const wait = delaysMs[call++] ?? 0
    if (wait) await new Promise((r) => setTimeout(r, wait))
    await realPublish(rel, data, opts)
    log.push(`publish ${rel}`)
  }
  io.delete = async (rel) => {
    log.push(`delete ${rel}`)
    return realDelete(rel)
  }
  return log
}

function beaconNames(session: Session): string[] {
  return readdirSync(session.io.abs(DIR.beacon)).filter((n) => parseBeaconFileName(n))
}

function readBeacon(session: Session, name: string): BeaconContent {
  const rel = `${DIR.beacon}/${name}`
  const buf = readFileSync(session.io.abs(rel))
  const aad = buildAad('pres', rel, session.deviceId8)
  const plain = decryptRecord(buf, session.keys.kPres, aad)
  return (JSON.parse(plain.toString('utf8')) as SignedRecord<BeaconContent>).p
}

describe('BeaconWriter concurrent publishes', () => {
  it('leaves the newest beacon on the share when a slow publish overlaps a fast one', async () => {
    const session = await soloSession()
    const log = instrument(session, [40]) // the first publish finishes last
    const writer = new BeaconWriter(session)

    // A message send and the heartbeat tick, ~simultaneously.
    await Promise.all([writer.bump('event'), writer.bump('heartbeat')])

    const names = beaconNames(session)
    expect(names).toHaveLength(1)
    expect(parseBeaconFileName(names[0])!.seq).toBe(2)
    // Nothing may be deleted before it has been superseded.
    expect(log.filter((l) => l.startsWith('delete'))).not.toContain(`delete ${DIR.beacon}/${names[0]}`)
  }, 60_000)

  it('a burst of events keeps every head, in the highest-seq file', async () => {
    const session = await soloSession()
    instrument(session, [40, 30, 20, 10]) // every publish would land out of order
    const writer = new BeaconWriter(session)
    const conv: ConvId = 'chan:deadbeef'

    const heads = ['a', 'b', 'c', 'd'].map((x) => `1700000000000-0001-${x.repeat(8)}.msg.e1`)
    await Promise.all(
      heads.map((h) => {
        writer.noteOwnEvent(conv, h) // fire-and-forget bump, exactly like a send
        return writer.bump('event')
      }),
    )

    const names = beaconNames(session)
    expect(names).toHaveLength(1)
    // Two publishes per head (noteOwnEvent's own bump, then ours): the last one wins.
    expect(parseBeaconFileName(names[0])!.seq).toBe(8)
    expect(readBeacon(session, names[0]).heads[conv]).toEqual(heads) // survivor has the whole burst
  }, 60_000)

  it("stop()'s goodbye is not deleted by a straggling earlier publish", async () => {
    const session = await soloSession()
    instrument(session, [40])
    const writer = new BeaconWriter(session)

    const inFlight = writer.bump('event') // still in flight when we quit
    await writer.stop()
    await inFlight // and it must not take the goodbye down with it

    const names = beaconNames(session)
    expect(names).toHaveLength(1)
    expect(readBeacon(session, names[0]).presence.state).toBe('offline')
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Tier → presence (1.2)
//
// A paused device (locked screen, suspended machine) publishes one last beacon
// and then stops writing entirely. That beacon is the only thing readers will
// ever see about this device again until it comes back, so it has to say
// "away" in the one field every reader actually consults.

afterEach(() => {
  vi.useRealTimers()
})

const publishes = (log: string[]): string[] => log.filter((l) => l.startsWith('publish'))

/**
 * Let the writer's real filesystem work finish while the clock is fake. A
 * publish is mkdir + write + rename, and each of those needs its own turn of
 * the event loop that `advanceTimersByTimeAsync` hands back.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 60; i++) await vi.advanceTimersByTimeAsync(1)
}

describe('BeaconWriter tiers', () => {
  it('goes quiet after one goodbye that reads as away on 1.1 and 1.2 alike', async () => {
    const session = await soloSession()
    const log = instrument(session, [])
    const writer = new BeaconWriter(session)
    vi.useFakeTimers()
    try {
      writer.start()
      await settle() // the startup beacon lands
      log.length = 0

      writer.setTier('paused', 0) // the OS idle counter is meaningless behind a lock
      await settle()
      expect(publishes(log)).toHaveLength(1)

      const names = beaconNames(session)
      expect(names).toHaveLength(1)
      const content = readBeacon(session, names[0])
      expect(content.presence.state).toBe('away')
      // presenceViews() special-cases only `offline`; everything else is derived
      // from idleSec, and nothing will follow this beacon to correct a 0.
      expect(content.presence.idleSec).toBeGreaterThanOrEqual(PRESENCE.awayIdleSec)

      // …and then nothing at all, for as long as the machine stays asleep.
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(publishes(log)).toHaveLength(1)
    } finally {
      await writer.stop(false)
    }
  }, 60_000)

  it('carries the real idle seconds on the idle tier, still online', async () => {
    const session = await soloSession()
    instrument(session, [])
    const writer = new BeaconWriter(session)
    vi.useFakeTimers()
    try {
      writer.start()
      await settle()
      writer.setTier('idle', 300)
      await settle()

      const content = readBeacon(session, beaconNames(session)[0])
      expect(content.presence.idleSec).toBe(300) // truthful, not floored
      expect(content.presence.state).toBe('online')

      // The idle heartbeat still beats PRESENCE.offlineAfterMs, so a 1.1 reader
      // sees "away" rather than a hole.
      expect(BEACON.idleHeartbeatMs).toBeLessThan(PRESENCE.offlineAfterMs)
    } finally {
      await writer.stop(false)
    }
  }, 60_000)

  it('an appear-offline user stays offline through a pause', async () => {
    const session = await soloSession()
    instrument(session, [])
    const writer = new BeaconWriter(session)
    vi.useFakeTimers()
    try {
      writer.setPresence({ state: 'offline' })
      writer.start()
      await settle()
      writer.setTier('paused', 0)
      await settle()
      expect(readBeacon(session, beaconNames(session)[0]).presence.state).toBe('offline')
    } finally {
      await writer.stop(false)
    }
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Gil's always-online preference (1.5)
//
// `getAlwaysOnline` is pulled fresh on every heartbeat decision and every
// publish — the same seam chatService/prService use for `getSettings()` — so
// it needs no dedicated "settings changed" plumbing to take effect.

describe('BeaconWriter tiers — always-online (1.5)', () => {
  it('keeps the heartbeat beating through a pause, carrying online/0', async () => {
    const session = await soloSession()
    const log = instrument(session, [])
    const writer = new BeaconWriter(session, () => '', () => true)
    vi.useFakeTimers()
    try {
      writer.start()
      await settle()
      writer.setTier('paused', 0) // screen locked
      await settle()

      const first = readBeacon(session, beaconNames(session)[0])
      expect(first.presence.state).toBe('online')
      expect(first.presence.idleSec).toBe(0)

      // Unlike a plain pause, this device keeps writing at the idle cadence —
      // that is the whole point: peers keep seeing green.
      log.length = 0
      await vi.advanceTimersByTimeAsync(BEACON.idleHeartbeatMs + BEACON.heartbeatJitterMs + 1_000)
      await settle() // let the fired heartbeat's real mkdir+write+rename finish
      expect(publishes(log).length).toBeGreaterThan(0)

      const latest = readBeacon(session, beaconNames(session)[0])
      expect(latest.presence.state).toBe('online')
      expect(latest.presence.idleSec).toBe(0)
    } finally {
      await writer.stop(false)
    }
  }, 60_000)

  it('reports idleSec 0 on the idle tier too, not the truthful count', async () => {
    const session = await soloSession()
    instrument(session, [])
    const writer = new BeaconWriter(session, () => '', () => true)
    vi.useFakeTimers()
    try {
      writer.start()
      await settle()
      writer.setTier('idle', 300)
      await settle()

      const content = readBeacon(session, beaconNames(session)[0])
      expect(content.presence.state).toBe('online')
      expect(content.presence.idleSec).toBe(0)
    } finally {
      await writer.stop(false)
    }
  }, 60_000)

  it('leaves behaviour exactly as today when the setting is off', async () => {
    const session = await soloSession()
    const log = instrument(session, [])
    const writer = new BeaconWriter(session, () => '', () => false)
    vi.useFakeTimers()
    try {
      writer.start()
      await settle()
      log.length = 0
      writer.setTier('paused', 0)
      await settle()
      expect(publishes(log)).toHaveLength(1) // the one goodbye beacon

      const content = readBeacon(session, beaconNames(session)[0])
      expect(content.presence.state).toBe('away')
      expect(content.presence.idleSec).toBeGreaterThanOrEqual(PRESENCE.awayIdleSec)

      // ...and then nothing, exactly like a paused device always did.
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(publishes(log)).toHaveLength(1)
    } finally {
      await writer.stop(false)
    }
  }, 60_000)

  it('still loses to appear-offline: state stays offline and the heartbeat goes quiet', async () => {
    const session = await soloSession()
    const log = instrument(session, [])
    const writer = new BeaconWriter(session, () => '', () => true)
    vi.useFakeTimers()
    try {
      writer.setPresence({ state: 'offline' })
      writer.start()
      await settle()
      expect(readBeacon(session, beaconNames(session)[0]).presence.state).toBe('offline')

      writer.setTier('paused', 0)
      await settle()
      expect(readBeacon(session, beaconNames(session)[0]).presence.state).toBe('offline')

      // Nothing left to keep looking online for, so — unlike the first test in
      // this block — this stays silent exactly like a plain paused,
      // appear-offline device.
      const before = publishes(log).length
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(publishes(log)).toHaveLength(before)
    } finally {
      await writer.stop(false)
    }
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Always-online, second pass (1.5). The content half of the setting is pulled
// fresh at every publish and needs no wiring; the *schedule* half does, because
// a paused device that is not beating has no next publish to re-decide on.
// `syncHeartbeat()` is what ChatService.onSettingsChanged calls.

describe('BeaconWriter — always-online schedule and the presence it publishes (1.5)', () => {
  it('starts beating when the setting is turned on behind a locked screen', async () => {
    const session = await soloSession()
    const log = instrument(session, [])
    let on = false
    const writer = new BeaconWriter(session, () => '', () => on)
    vi.useFakeTimers()
    try {
      writer.start()
      await settle()
      writer.setTier('paused', 0) // screen locked, setting still off
      await settle()
      log.length = 0
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      await settle()
      expect(publishes(log)).toHaveLength(0) // silent, like any paused device

      on = true
      writer.syncHeartbeat()
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      await settle()
      expect(publishes(log).length).toBeGreaterThan(0)
      const latest = readBeacon(session, beaconNames(session)[0])
      expect(latest.presence.state).toBe('online')
      expect(latest.presence.idleSec).toBe(0)
    } finally {
      await writer.stop(false)
    }
  }, 60_000)

  it('goes quiet again when the setting is turned off behind a locked screen', async () => {
    const session = await soloSession()
    const log = instrument(session, [])
    let on = true
    const writer = new BeaconWriter(session, () => '', () => on)
    vi.useFakeTimers()
    try {
      writer.start()
      await settle()
      writer.setTier('paused', 0)
      await settle()
      log.length = 0
      await vi.advanceTimersByTimeAsync(BEACON.idleHeartbeatMs + BEACON.heartbeatJitterMs + 1_000)
      await settle()
      expect(publishes(log).length).toBeGreaterThan(0) // beating

      on = false
      writer.syncHeartbeat()
      log.length = 0
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      await settle()
      expect(publishes(log)).toHaveLength(0) // and back to today's paused silence
    } finally {
      await writer.stop(false)
    }
  }, 60_000)

  it('stops beating when appear-offline is chosen after the screen is already locked', async () => {
    const session = await soloSession()
    const log = instrument(session, [])
    const writer = new BeaconWriter(session, () => '', () => true)
    vi.useFakeTimers()
    try {
      writer.start()
      await settle()
      writer.setTier('paused', 0)
      await settle()
      writer.setPresence({ state: 'offline' }) // the other order from the test above
      await settle()
      expect(readBeacon(session, beaconNames(session)[0]).presence.state).toBe('offline')

      // Nothing left to look online for: a deliberately invisible, paused
      // device must not keep writing to the share every 45 s forever.
      const before = publishes(log).length
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      await settle()
      expect(publishes(log)).toHaveLength(before)
    } finally {
      await writer.stop(false)
    }
  }, 60_000)

  it('beats at exactly BEACON.idleHeartbeatMs while keeping green — no jitter on top', async () => {
    const session = await soloSession()
    const log = instrument(session, [])
    const writer = new BeaconWriter(session, () => '', () => true)
    vi.useFakeTimers()
    // The worst jitter draw there is: on a jittered schedule this pushes the
    // first beat to 45 s + 3 s, past what a peer will still call online.
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.999)
    try {
      writer.start()
      await settle()
      writer.setTier('paused', 0)
      await settle()
      log.length = 0
      await vi.advanceTimersByTimeAsync(BEACON.idleHeartbeatMs)
      await settle()
      expect(publishes(log).length).toBeGreaterThan(0)
      // Which is what buys the peer its margin: the poller ages a beacon from
      // its own `hlc` against PRESENCE.onlineWithinMs.
      expect(BEACON.idleHeartbeatMs).toBeLessThan(PRESENCE.onlineWithinMs)
    } finally {
      rand.mockRestore()
      await writer.stop(false)
    }
  }, 60_000)

  it('shows this device the presence it published, not the truthful one underneath', async () => {
    const session = await soloSession()
    instrument(session, [])
    const writer = new BeaconWriter(session, () => '', () => true)
    vi.useFakeTimers()
    try {
      writer.start()
      await settle()
      writer.setTier('paused', 0)
      await settle()

      const onShare = readBeacon(session, beaconNames(session)[0]).presence
      expect(onShare.state).toBe('online')
      expect(onShare.idleSec).toBe(0)
      // The truthful state is kept, untouched, underneath the override...
      expect(writer.presence.state).toBe('away')
      expect(writer.presence.idleSec).toBeGreaterThanOrEqual(PRESENCE.awayIdleSec)
      // ...and everything that must agree with the share reads it through here.
      expect(writer.publishedPresence).toEqual(onShare)
      const self = selfPresenceView({
        deviceId: session.deviceId,
        name: 'Me',
        hostname: '',
        fingerprint: '',
        presence: writer.publishedPresence,
        nowMs: Date.now(),
      })
      expect(self.state).toBe('online')
    } finally {
      await writer.stop(false)
    }
  }, 60_000)
})
