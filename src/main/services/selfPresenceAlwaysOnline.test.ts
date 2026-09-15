import { describe, expect, it, vi } from 'vitest'

// ChatService reaches for `BrowserWindow` as a type and raises OS notifications
// it never gets near here; both are stubbed so the import resolves under
// node-only vitest.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  Notification: class {
    static isSupported(): boolean {
      return false
    }
    on(): this {
      return this
    }
    show(): void {}
  },
}))

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PushMessage, SettingsView } from '@shared/bridge'
import { PRESENCE } from '@shared/constants'
import { generateIdentity } from '../crypto/identity'
import type { SecretStore } from '../store/secretStore'
import { createOrJoinTeam } from '../transport/bootstrap'
import { Roster } from '../transport/roster'
import { Session } from '../transport/session'
import { ShareIo } from '../transport/shareIo'
import { ChatService } from './chatService'

// The footer dot and the right-rail row are the only window Gil has onto his
// own presence: the poller's list is everyone *else* by construction. With
// always-online on (1.5) the beacon on the share and `beacon.presence` say
// different things on purpose — the override is applied at publish time so the
// truthful idle state survives underneath it — and the row has to follow the
// share, or the setting looks broken to the one person it exists for.

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

async function soloSession(): Promise<Session> {
  const io = new ShareIo(mkdtempSync(join(tmpdir(), 'sem-selfpres-')))
  const res = await createOrJoinTeam(io, 'correct horse battery staple', 'Test Team')
  if ('error' in res) throw new Error(res.error)
  const { proto, teamSalt, tmk } = res.join
  const store = new FakeStore()
  const identity = generateIdentity().identity
  const roster = new Roster(io, store, tmk, proto.epoch)
  return new Session(io, store, identity, proto, teamSalt, tmk, tmk, roster, 'Gil')
}

const baseSettings = (): SettingsView => ({
  theme: 'system',
  notifyChannels: 'none',
  notifyPreviews: false,
  autoplayGifs: 'never',
  autoAcceptBeams: false,
  quietHours: { enabled: false, from: '22:00', to: '07:00' },
  fontSize: 'M',
})

/** A ChatService that never touches the share: only the local beacon matters. */
async function makeChat(prefs: SettingsView): Promise<ChatService> {
  return new ChatService(await soloSession(), () => null, () => prefs)
}

describe("ChatService.selfPresence — Gil's own row under always-online (1.5)", () => {
  it('stays online through an idle stretch, exactly like the beacon teammates read', async () => {
    const prefs: SettingsView = { ...baseSettings(), alwaysOnline: true }
    const chat = await makeChat(prefs)

    chat.setIoTier('idle', PRESENCE.awayIdleSec + 60) // ten minutes without input
    expect(chat.beacon.presence.idleSec).toBeGreaterThanOrEqual(PRESENCE.awayIdleSec) // truthful underneath
    expect(chat.selfPresence().state).toBe('online')

    chat.setIoTier('paused', 0) // and behind a locked screen
    expect(chat.selfPresence().state).toBe('online')
  })

  it('goes away with everyone else when the setting is off', async () => {
    const chat = await makeChat(baseSettings())
    chat.setIoTier('idle', PRESENCE.awayIdleSec + 60)
    expect(chat.selfPresence().state).toBe('away')
  })

  it('still shows offline when appear-offline is chosen', async () => {
    const prefs: SettingsView = { ...baseSettings(), alwaysOnline: true }
    const chat = await makeChat(prefs)
    chat.setOwnPresence({ state: 'offline' })
    expect(chat.selfPresence().state).toBe('offline')
  })

  it('follows the toggle the moment it is flipped, without waiting for a poll tick', async () => {
    const prefs: SettingsView = { ...baseSettings(), alwaysOnline: false }
    const chat = await makeChat(prefs)
    const pushes: PushMessage[] = []
    chat.setPush((m) => pushes.push(m))

    chat.setIoTier('idle', PRESENCE.awayIdleSec + 60)
    expect(chat.selfPresence().state).toBe('away')

    prefs.alwaysOnline = true // what AppController.setSettings stores...
    chat.onSettingsChanged() // ...and then announces
    const last = pushes.filter((p) => p.kind === 'self-presence').at(-1)
    expect(last).toBeDefined()
    expect(last?.kind === 'self-presence' && last.view.state).toBe('online')
  })
})
