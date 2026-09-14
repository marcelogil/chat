import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Onboarding must never re-key a profile that already belongs to a device.
//
// 2026-09-14: a packaged verification script called onboarding.submit against
// the *default* profile while it sat on the unlock screen. onboardSubmit saw
// `!store.unlocked`, created a brand-new LMK over the existing lmk.sealed, and
// with that one write identity.enc, pins.enc and every cache became
// permanently unreadable — then it generated a fresh identity. A real person's
// device, and every DM addressed to it, gone. These tests are the two halves
// of the fix: the refusal, and the legitimate flows that must still work.

const paths = vi.hoisted(() => ({ userData: '', temp: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? paths.userData : paths.temp),
    getVersion: () => '1.4.0',
    isPackaged: false,
  },
  BrowserWindow: class {},
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  Notification: class {
    static isSupported(): boolean {
      return false
    }
  },
  net: { fetch: async () => ({ ok: false, status: 0 }) },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {},
}))

// The incident's platform: no OS keystore, so the LMK is wrapped under the
// team passphrase and the profile is *locked* until somebody types it. Pinned
// rather than inherited from process.platform so this test means the same
// thing on a Windows runner.
vi.mock('./store/osKeystore', () => ({ platformKeystore: () => null }))

const { AppController, LOCKED_PROFILE, LOCKED_PROFILE_MESSAGE } = await import('./appController')
const { LocalStore } = await import('./store/localStore')

const PASS_OLD = 'the passphrase this device was set up with'
const PASS_NEW = 'correct horse battery staple'

let share: string
const temps: string[] = []
const tmpDir = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `chat-${tag}-`))
  temps.push(d)
  return d
}

beforeEach(() => {
  paths.userData = tmpDir('profile')
  paths.temp = tmpDir('temp')
  share = tmpDir('share')
})

afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

/**
 * A controller whose `startSession` is stubbed out. Everything these tests care
 * about — the refusal, createOrJoinTeam, and the LMK decision that follows it —
 * happens before it; what comes after is pollers, a beacon writer, a janitor
 * and two network services, all on timers, none of which belong in a unit test.
 */
function controller(): { c: InstanceType<typeof AppController>; started: unknown[] } {
  const c = new AppController(() => null)
  const started: unknown[] = []
  ;(c as unknown as { startSession: (cfg: unknown) => Promise<void> }).startSession = async (cfg) => {
    started.push(cfg)
  }
  return { c, started }
}

const onboard = (c: InstanceType<typeof AppController>, sharePath: string, passphrase: string, teamName: string) =>
  c.onboardSubmit({ sharePath, passphrase, displayName: 'Gil', teamName })

describe('AppController.onboardSubmit over an existing profile', () => {
  it('refuses a locked profile and leaves every byte of it alone', async () => {
    // A device that already lives here: a sealed LMK and an identity under it.
    const existing = new LocalStore(paths.userData, null)
    expect(existing.init()).toBe('fresh')
    existing.createPassphraseLmk(PASS_OLD)
    existing.writeSecretJson('identity', { ed: 'the-real-device' })
    const sealBefore = readFileSync(join(paths.userData, 'lmk.sealed'))
    const identityBefore = readFileSync(join(paths.userData, 'identity.enc'))

    const { c, started } = controller()
    await c.init()
    expect(c.getBoot()).toEqual({ mode: 'locked', reason: 'passphrase' })

    const res = await onboard(c, share, PASS_NEW, 'Verification')

    expect(res).toEqual({ ok: false, error: LOCKED_PROFILE, message: LOCKED_PROFILE_MESSAGE })
    expect(LOCKED_PROFILE_MESSAGE).toMatch(/already holds Chat data/)
    // Nothing moved: not the seal, not the secrets, not the share, not a session.
    expect(readFileSync(join(paths.userData, 'lmk.sealed')).equals(sealBefore)).toBe(true)
    expect(readFileSync(join(paths.userData, 'identity.enc')).equals(identityBefore)).toBe(true)
    expect(readdirSync(share)).toEqual([])
    expect(started).toEqual([])

    // And the device is still exactly the device it was.
    const next = new LocalStore(paths.userData, null)
    expect(next.init()).toBe('passphrase')
    expect(next.unlockWithPassphrase(PASS_OLD)).toBe(true)
    expect(next.readSecretJson('identity')).toEqual({ ed: 'the-real-device' })
  })

  it('refuses even when the seal is one no build can open', async () => {
    // 'unrecoverable' is still somebody's device: only the confirmed reset may
    // throw it away, and onboarding is not that.
    const existing = new LocalStore(paths.userData, null)
    existing.init()
    existing.createPassphraseLmk(PASS_OLD)
    const seal = readFileSync(join(paths.userData, 'lmk.sealed'))
    rmSync(join(paths.userData, 'lmk.sealed'))
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(paths.userData, 'lmk.sealed'), seal.subarray(0, 4)) // truncated to the marker

    const { c } = controller()
    await c.init()
    expect(c.getBoot()).toEqual({ mode: 'locked', reason: 'unrecoverable' })
    const res = await onboard(c, share, PASS_NEW, 'Verification')
    expect(res).toEqual({ ok: false, error: LOCKED_PROFILE, message: LOCKED_PROFILE_MESSAGE })
    expect(readFileSync(join(paths.userData, 'lmk.sealed')).equals(seal.subarray(0, 4))).toBe(true)
  })

  it('a fresh profile still onboards, sealed under the team passphrase', async () => {
    const { c, started } = controller()
    await c.init()
    expect(c.getBoot().mode).toBe('onboarding')

    expect(await onboard(c, share, PASS_NEW, 'Verification')).toEqual({ ok: true })
    expect(started).toHaveLength(1)
    expect(c.store.unlocked).toBe(true)

    // Next launch: a locked profile this passphrase opens.
    const next = new LocalStore(paths.userData, null)
    expect(next.init()).toBe('passphrase')
    expect(next.unlockWithPassphrase(PASS_NEW)).toBe(true)
    expect(next.readSecretJson<{ teamName: string }>('app-config')?.teamName).toBe('Verification')
  })

  it('an unlocked profile re-wraps under the new passphrase and keeps its device', async () => {
    // The "change team folder" flow: the store is open, the passphrase that
    // seals it changes, and the identity must survive the move.
    const { c } = controller()
    await c.init()
    expect(await onboard(c, share, PASS_OLD, 'Team One')).toEqual({ ok: true })
    c.store.writeSecretJson('identity', { ed: 'keep-me' }) // startSession is stubbed; write what it would have

    expect(await onboard(c, tmpDir('share2'), PASS_NEW, 'Team Two')).toEqual({ ok: true })

    const next = new LocalStore(paths.userData, null)
    expect(next.init()).toBe('passphrase')
    expect(next.unlockWithPassphrase(PASS_OLD)).toBe(false)
    expect(next.unlockWithPassphrase(PASS_NEW)).toBe(true)
    expect(next.readSecretJson('identity')).toEqual({ ed: 'keep-me' })
    expect(next.readSecretJson<{ teamName: string }>('app-config')?.teamName).toBe('Team Two')
  })
})
