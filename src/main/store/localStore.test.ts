import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { LocalStore } from './localStore'
import type { OsKeystore } from './osKeystore'

// A stand-in for DPAPI: a fixed per-"user" key, and a switch to simulate the
// keystore going away (moved profile, denied access, hardened image).
function fakeKeystore(): OsKeystore & { on: boolean } {
  const key = randomBytes(32)
  const ks = {
    on: true,
    available: () => ks.on,
    seal: (plain: Buffer) => {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      return Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()])
    },
    open: (sealed: Buffer) => {
      const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12))
      d.setAuthTag(sealed.subarray(-16))
      return Buffer.concat([d.update(sealed.subarray(12, -16)), d.final()])
    },
  }
  return ks
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sem-store-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const files = () => readdirSync(dir).sort()

describe('LocalStore without an OS keystore (macOS)', () => {
  it('is fresh on first run and locked-by-passphrase on the next', () => {
    const a = new LocalStore(dir, null)
    expect(a.init()).toBe('fresh')
    expect(a.unlocked).toBe(false)
    expect(() => a.writeSecret('x', Buffer.from('y'))).toThrow(/locked/)

    a.createPassphraseLmk('correct horse')
    expect(a.unlocked).toBe(true)
    expect(a.mode).toBe('passphrase')
    a.writeSecretJson('identity', { ed: 'abc' })
    expect(readFileSync(join(dir, 'lmk.sealed')).subarray(0, 4).toString()).toBe('PASS')
    expect(files()).not.toContain('lmk.sealed.tmp')

    const b = new LocalStore(dir, null)
    expect(b.init()).toBe('passphrase')
    expect(b.unlocked).toBe(false)
    expect(b.unlockWithPassphrase('wrong horse')).toBe(false)
    expect(b.unlocked).toBe(false)
    expect(b.unlockWithPassphrase('correct horse')).toBe(true)
    expect(b.readSecretJson('identity')).toEqual({ ed: 'abc' })
  })

  it('normalizes the passphrase (NFKD) so composed/decomposed input both unlock', () => {
    const a = new LocalStore(dir, null)
    a.init()
    a.createPassphraseLmk('café')
    const b = new LocalStore(dir, null)
    b.init()
    expect(b.unlockWithPassphrase('café')).toBe(true)
  })

  it('re-wraps under a new passphrase without touching the secrets', () => {
    const a = new LocalStore(dir, null)
    a.init()
    a.createPassphraseLmk('team one')
    a.writeSecretJson('identity', { ed: 'keep-me' })
    const before = readFileSync(join(dir, 'identity.enc'))

    a.rewrapPassphrase('team two')
    expect(readFileSync(join(dir, 'identity.enc')).equals(before)).toBe(true)
    expect(a.readSecretJson('identity')).toEqual({ ed: 'keep-me' })

    const b = new LocalStore(dir, null)
    expect(b.init()).toBe('passphrase')
    expect(b.unlockWithPassphrase('team one')).toBe(false)
    expect(b.unlockWithPassphrase('team two')).toBe(true)
    expect(b.readSecretJson('identity')).toEqual({ ed: 'keep-me' })
  })

  it('a fresh setup discards orphaned secrets from an earlier profile', () => {
    writeFileSync(join(dir, 'identity.enc'), Buffer.from('garbage'))
    const a = new LocalStore(dir, null)
    expect(a.init()).toBe('fresh')
    a.createPassphraseLmk('pw')
    expect(a.readSecret('identity')).toBeNull()
  })

  it('treats an OS-sealed profile as unrecoverable, and wipe() gets back to fresh', () => {
    const ks = fakeKeystore()
    const win = new LocalStore(dir, ks)
    expect(win.init()).toBe('unlocked')
    win.writeSecretJson('identity', { ed: 'dpapi' })
    win.writeSettings({ theme: 'light' })

    const mac = new LocalStore(dir, null)
    expect(mac.init()).toBe('unrecoverable')
    expect(mac.unlocked).toBe(false)
    expect(mac.unlockWithPassphrase('anything')).toBe(false)

    mac.wipe()
    expect(files()).toEqual(['settings.json'])
    expect(mac.init()).toBe('fresh')
    expect(mac.readSettings()).toEqual({ theme: 'light' })
  })

  it('a flipped tag reads as a wrong passphrase, never a crash', () => {
    const a = new LocalStore(dir, null)
    a.init()
    a.createPassphraseLmk('pw')
    const sealed = readFileSync(join(dir, 'lmk.sealed'))
    sealed[sealed.length - 1] ^= 0x01
    writeFileSync(join(dir, 'lmk.sealed'), sealed)
    const b = new LocalStore(dir, null)
    expect(b.init()).toBe('passphrase')
    expect(b.unlockWithPassphrase('pw')).toBe(false)
  })

  it('a seal no passphrase could ever open is unrecoverable, not "wrong passphrase" forever', () => {
    const a = new LocalStore(dir, null)
    a.init()
    a.createPassphraseLmk('pw')
    const good = readFileSync(join(dir, 'lmk.sealed'))

    // Truncated to the marker (also what the abandoned pre-release format looked like).
    writeFileSync(join(dir, 'lmk.sealed'), Buffer.from('PASS'))
    expect(new LocalStore(dir, null).init()).toBe('unrecoverable')

    // A future format version this build doesn't know.
    const future = Buffer.from(good)
    future[4] = 2
    writeFileSync(join(dir, 'lmk.sealed'), future)
    expect(new LocalStore(dir, null).init()).toBe('unrecoverable')

    // Record cut short.
    writeFileSync(join(dir, 'lmk.sealed'), good.subarray(0, 5 + 16 + 10))
    expect(new LocalStore(dir, null).init()).toBe('unrecoverable')

    // The pristine seal still classifies and opens.
    writeFileSync(join(dir, 'lmk.sealed'), good)
    const b = new LocalStore(dir, null)
    expect(b.init()).toBe('passphrase')
    expect(b.unlockWithPassphrase('pw')).toBe(true)
  })

  it('a seal that exists but cannot be read is unrecoverable, never a throw', () => {
    // init() is the very first thing the boot does; a throw out of it has no
    // window to land in. A seal the OS won't hand over (EACCES on a restored
    // profile, EIO, a delete racing the existsSync — EISDIR stands in here)
    // has to classify like any other seal this build can't open.
    mkdirSync(join(dir, 'lmk.sealed'), { recursive: true })
    const a = new LocalStore(dir, null)
    expect(a.init()).toBe('unrecoverable')
    expect(a.unlocked).toBe(false)
    expect(a.unlockWithPassphrase('pw')).toBe(false) // and stays locked, not crashed
  })
})

describe('LocalStore with an OS keystore (Windows / DPAPI)', () => {
  it('creates and reopens the LMK silently, tagged with our marker', () => {
    const ks = fakeKeystore()
    const a = new LocalStore(dir, ks)
    expect(a.init()).toBe('unlocked')
    expect(a.mode).toBe('os')
    a.writeSecretJson('identity', { ed: 'win' })
    expect(readFileSync(join(dir, 'lmk.sealed')).subarray(0, 4).toString()).toBe('OSKS')

    const b = new LocalStore(dir, ks)
    expect(b.init()).toBe('unlocked')
    expect(b.readSecretJson('identity')).toEqual({ ed: 'win' })
    // The passphrase is not the seal here: re-wrapping is a no-op, never a throw.
    b.rewrapPassphrase('irrelevant')
    expect(readFileSync(join(dir, 'lmk.sealed')).subarray(0, 4).toString()).toBe('OSKS')
  })

  it('migrates a pre-1.0.2 bare safeStorage blob in place', () => {
    const ks = fakeKeystore()
    const lmk = randomBytes(32)
    writeFileSync(join(dir, 'lmk.sealed'), ks.seal(lmk))
    const a = new LocalStore(dir, ks)
    expect(a.init()).toBe('unlocked')
    a.writeSecretJson('probe', 1)
    expect(readFileSync(join(dir, 'lmk.sealed')).subarray(0, 4).toString()).toBe('OSKS')

    const b = new LocalStore(dir, ks)
    expect(b.init()).toBe('unlocked')
    expect(b.readSecretJson('probe')).toBe(1)
  })

  it('is unrecoverable when the keystore later refuses, and falls back to passphrase on a fresh profile', () => {
    const ks = fakeKeystore()
    const a = new LocalStore(dir, ks)
    a.init()
    ks.on = false
    const b = new LocalStore(dir, ks)
    expect(b.init()).toBe('unrecoverable')

    b.wipe()
    expect(b.init()).toBe('fresh')
    b.createPassphraseLmk('pw')
    const c = new LocalStore(dir, ks)
    expect(c.init()).toBe('passphrase') // PASS marker wins even with a keystore present
    expect(c.unlockWithPassphrase('pw')).toBe(true)
  })

  it('a profile copied to another user (keystore opens nothing) is unrecoverable', () => {
    const a = new LocalStore(dir, fakeKeystore())
    a.init()
    a.writeSecretJson('identity', { ed: 'mine' })
    const other = new LocalStore(dir, fakeKeystore()) // available, but a different DPAPI key
    expect(other.init()).toBe('unrecoverable')
    expect(other.unlocked).toBe(false)
  })

  it('a legacy blob that opens but cannot be rewritten still unlocks', () => {
    const ks = fakeKeystore()
    const lmk = randomBytes(32)
    const bare = ks.seal(lmk)
    writeFileSync(join(dir, 'lmk.sealed'), bare)
    const openOnly: OsKeystore = {
      available: () => true,
      open: (b) => ks.open(b),
      seal: () => {
        throw new Error('EBUSY')
      },
    }
    const a = new LocalStore(dir, openOnly)
    expect(a.init()).toBe('unlocked')
    expect(readFileSync(join(dir, 'lmk.sealed')).equals(bare)).toBe(true) // untouched, retried next launch
  })

  it('a first run over leftover secrets discards them', () => {
    writeFileSync(join(dir, 'identity.enc'), Buffer.from('from-a-seal-that-is-gone'))
    const a = new LocalStore(dir, fakeKeystore())
    expect(a.init()).toBe('unlocked')
    expect(a.readSecret('identity')).toBeNull()
  })

  it('a keystore whose seal throws does not crash the boot', () => {
    const broken: OsKeystore = {
      available: () => true,
      seal: () => {
        throw new Error('DPAPI failed')
      },
      open: () => {
        throw new Error('DPAPI failed')
      },
    }
    const a = new LocalStore(dir, broken)
    expect(a.init()).toBe('fresh')
    expect(files()).not.toContain('lmk.sealed')
  })
})

describe('a sealed profile is not overwritable', () => {
  // The floor under AppController.onboardSubmit (see appController.test.ts for
  // the flow, and CLAUDE.md → "Profiles and test runs" for what it cost to
  // learn): a second LMK over an existing seal doesn't "re-set-up" a machine,
  // it destroys the device identity sealed under the first one. Only wipe() —
  // reached from the user-confirmed reset — may do that.
  it('refuses a second LMK over an existing seal, locked or not', () => {
    const a = new LocalStore(dir, null)
    a.init()
    a.createPassphraseLmk('the real passphrase')
    a.writeSecretJson('identity', { ed: 'the-real-device' })
    const seal = readFileSync(join(dir, 'lmk.sealed'))

    // Still unlocked in this process…
    expect(a.hasSealedData()).toBe(true)
    expect(() => a.createPassphraseLmk('something else')).toThrow(/sealed data/)

    // …and in the dangerous case: a fresh launch that hasn't been unlocked.
    const b = new LocalStore(dir, null)
    expect(b.init()).toBe('passphrase')
    expect(b.unlocked).toBe(false)
    expect(b.hasSealedData()).toBe(true)
    expect(() => b.createPassphraseLmk('something else')).toThrow(/sealed data/)

    // Nothing was touched on the way out, so the device still opens.
    expect(readFileSync(join(dir, 'lmk.sealed')).equals(seal)).toBe(true)
    expect(b.unlockWithPassphrase('the real passphrase')).toBe(true)
    expect(b.readSecretJson('identity')).toEqual({ ed: 'the-real-device' })
  })

  it('wipe() is the way through, and hasSealedData() says so', () => {
    const a = new LocalStore(dir, null)
    expect(a.hasSealedData()).toBe(false)
    a.init()
    a.createPassphraseLmk('first')
    expect(a.hasSealedData()).toBe(true)

    a.wipe()
    expect(a.hasSealedData()).toBe(false)
    a.createPassphraseLmk('second') // the explicit reset path, and only it
    expect(a.unlocked).toBe(true)
  })
})

describe('derived plaintext under userData', () => {
  it('the decrypted attachment cache goes with the seal, and on a team change', () => {
    const store = new LocalStore(dir, null)
    store.init()
    store.createPassphraseLmk('pw')
    store.writeSecretJson('app-config', { sharePath: '/Volumes/team' })
    const cache = join(dir, 'blob-cache')

    // Leaving the team folder: the secrets stay, this team's plaintext does not.
    mkdirSync(cache, { recursive: true })
    writeFileSync(join(cache, 'a'.repeat(32)), 'contract.pdf, decrypted')
    store.clearDerivedData()
    expect(existsSync(cache)).toBe(false)
    expect(store.readSecretJson('app-config')).toEqual({ sharePath: '/Volumes/team' })

    // "Start fresh": nothing the old profile could open is left behind.
    mkdirSync(cache, { recursive: true })
    writeFileSync(join(cache, 'b'.repeat(32)), 'screenshot, decrypted')
    store.wipe()
    expect(existsSync(cache)).toBe(false)
    expect(files()).not.toContain('blob-cache')
  })
})
