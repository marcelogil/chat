import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIR, PRESENCE } from '@shared/constants'
import { parseBeaconFileName } from '@shared/ids'
import { normalizeStatus, restoredBeaconPresence, statusFromSettings } from '@shared/presenceStatus'
import type { BeaconContent, SignedRecord } from '@shared/types'
import { buildAad, decryptRecord } from '../crypto/envelope'
import { generateIdentity } from '../crypto/identity'
import { LocalStore } from '../store/localStore'
import type { SecretStore } from '../store/secretStore'
import { BeaconWriter } from './beacon'
import { createOrJoinTeam } from './bootstrap'
import { Roster } from './roster'
import { selfPresenceView } from './selfPresence'
import { Session } from './session'
import { ShareIo } from './shareIo'

// The status line (1.4). Three things had to be true for Gil's report to stop
// being true, and each gets a test here: the status is written down (settings,
// plaintext), it is back in the beacon before the first publish of the next
// launch, and this device has a presence row of its own to show it in.

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

/** A session on its own temp share; nobody else has to be there to read our own beacon. */
async function soloSession(): Promise<Session> {
  const io = new ShareIo(mkdtempSync(join(tmpdir(), 'sem-status-')))
  const res = await createOrJoinTeam(io, 'correct horse battery staple', 'Test Team')
  if ('error' in res) throw new Error(res.error)
  const { proto, teamSalt, tmk } = res.join
  const store = new FakeStore()
  const identity = generateIdentity().identity
  const roster = new Roster(io, store, tmk, proto.epoch)
  return new Session(io, store, identity, proto, teamSalt, tmk, tmk, roster, 'Me')
}

function latestBeacon(session: Session): BeaconContent {
  const names = readdirSync(session.io.abs(DIR.beacon)).filter((n) => parseBeaconFileName(n))
  const newest = names.sort((a, b) => parseBeaconFileName(a)!.seq - parseBeaconFileName(b)!.seq).pop()!
  const rel = `${DIR.beacon}/${newest}`
  const plain = decryptRecord(
    readFileSync(session.io.abs(rel)),
    session.keys.kPres,
    buildAad('pres', rel, session.deviceId8),
  )
  return (JSON.parse(plain.toString('utf8')) as SignedRecord<BeaconContent>).p
}

describe('status persistence (plaintext settings)', () => {
  it('survives a restart: written by one LocalStore, read by the next', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sem-settings-'))
    const first = new LocalStore(dir, null)
    first.writeSettings({ theme: 'dark', notifyDms: true, status: normalizeStatus('  back at 3  ') })

    // A new process, a new store over the same profile — which is all a
    // relaunch is. The beacon is memory only, so this file is the only thing
    // that can carry the status across.
    const second = new LocalStore(dir, null)
    const saved = second.readSettings<{ theme: string; status?: string }>()
    expect(saved?.status).toBe('back at 3')
    expect(statusFromSettings(saved)).toBe('back at 3')
  })

  it('settings from a build before the status existed read as no status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sem-settings-old-'))
    new LocalStore(dir, null).writeSettings({ theme: 'system', fontSize: 'M' })
    const saved = new LocalStore(dir, null).readSettings<{ status?: string }>()
    expect(saved?.status).toBeUndefined()
    expect(statusFromSettings(saved)).toBe('')
  })

  it('normalizes what it stores: one line, trimmed, bounded', () => {
    expect(normalizeStatus(' heads-down\nuntil 4 ')).toBe('heads-down until 4')
    expect(normalizeStatus(null)).toBe('')
    expect(normalizeStatus('x'.repeat(200))).toHaveLength(80)
  })
})

describe('BeaconWriter with a restored status', () => {
  it('carries the saved status in its very first publish', async () => {
    const session = await soloSession()
    const writer = new BeaconWriter(session)
    // Exactly what startSession does between constructing the writer and
    // starting it.
    writer.presence = restoredBeaconPresence(writer.presence, ' back at 3 ')

    writer.start()
    await vi.waitFor(() => {
      if (!readdirSync(session.io.abs(DIR.beacon)).some((n) => parseBeaconFileName(n))) {
        throw new Error('no beacon yet')
      }
    })
    await writer.stop(false)

    const content = latestBeacon(session)
    expect(content.presence.status).toBe('back at 3')
    expect(content.presence.state).toBe('online')
  }, 60_000)

  it('publishes an empty status when nothing was saved', async () => {
    const session = await soloSession()
    const writer = new BeaconWriter(session)
    writer.presence = restoredBeaconPresence(writer.presence, undefined)

    await writer.bump('startup')

    expect(latestBeacon(session).presence.status).toBe('')
  }, 60_000)

  it('a status set while running lands on the share', async () => {
    const session = await soloSession()
    const writer = new BeaconWriter(session)
    writer.setPresence({ status: 'in a meeting' })
    await writer.bump('presence')

    expect(latestBeacon(session).presence.status).toBe('in a meeting')
  }, 60_000)
})

describe('selfPresenceView', () => {
  const base = {
    deviceId: 'dev00001',
    name: 'Ana',
    hostname: 'MBP-ANA',
    fingerprint: 'Q7RC-2MZE',
    nowMs: 1_700_000_000_000,
  }

  it('is a row of its own, carrying the status the beacon is about to publish', () => {
    const view = selfPresenceView({ ...base, presence: { state: 'online', status: 'back at 3', idleSec: 0 } })
    expect(view.deviceId).toBe('dev00001')
    expect(view.status).toBe('back at 3')
    expect(view.state).toBe('online')
    expect(view.departed).toBe(false)
    expect(view.lastSeenMs).toBe(base.nowMs)
  })

  it('follows the same idle rule the poller applies to everyone else', () => {
    const away = selfPresenceView({
      ...base,
      presence: { state: 'online', status: '', idleSec: PRESENCE.awayIdleSec },
    })
    expect(away.state).toBe('away')
  })

  it('"appear offline" wins over the idle counter', () => {
    const hidden = selfPresenceView({ ...base, presence: { state: 'offline', status: 'shh', idleSec: 0 } })
    expect(hidden.state).toBe('offline')
    expect(hidden.status).toBe('shh')
  })
})
