import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, renameSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, scryptSync } from 'node:crypto'
import { buildAad, decryptRecord, encryptRecord, parseRecord } from '../crypto/envelope'
import { KDF, KID } from '@shared/constants'
import type { OsKeystore } from './osKeystore'
import type { SecretStore } from './secretStore'

// Everything the app persists locally lives under userData, encrypted with a
// random Local Master Key (LMK). The LMK itself is sealed one of two ways:
//
//   OSKS — by the OS keystore (DPAPI on Windows). Silent, per-user, survives
//          app updates. See osKeystore.ts for why macOS doesn't get this.
//   PASS — wrapped under a KEK derived (scrypt) from the team passphrase,
//          which the user types at each launch. The LMK stays random, so a
//          passphrase change only re-wraps this one small file — the
//          encrypted secrets are never touched.
//
// Either way the LMK is what encrypts the secrets, and it never leaves memory
// unwrapped. A copied userData folder is useless without the seal — which on
// macOS means: without the team passphrase. That is the accepted trade for
// staying out of the Keychain; README spells it out.

export type LmkMode = 'os' | 'passphrase' | 'locked'

/** What init() found on disk, and therefore what the boot flow must do next. */
export type LmkStatus =
  | 'unlocked' // OS keystore opened (or just created) the LMK
  | 'passphrase' // passphrase-wrapped LMK on disk: unlockWithPassphrase()
  | 'fresh' // nothing on disk and no OS keystore: onboarding creates it
  | 'unrecoverable' // no build/keystore can open what's on disk: wipe()

const LMK_SEALED = 'lmk.sealed'
const SETTINGS = 'settings.json'
// Written by BlobService (services/blobs.ts), cleared from here so the whole
// "forget this profile" story stays in one place.
const DERIVED_DIRS = ['blob-cache']
const MAGIC_PASS = Buffer.from('PASS')
const MAGIC_OS = Buffer.from('OSKS')
const PASS_VERSION = 1
const PASS_SALT_LEN = 16

// Same work factor as the team KDF (~200 ms once per launch): a copied
// profile folder must never be a cheaper offline oracle for the team
// passphrase than protocol.json's own check value is.
const KEK_SCRYPT = { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: KDF.maxmem }
const LMK_AAD = buildAad('local', 'lmk', 'lmk')

function deriveKek(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize('NFKD'), salt, 32, KEK_SCRYPT)
}

// A PASS seal this build could conceivably open: right version, and a salt
// plus a well-formed SFC1 record behind it. Anything else is not "wrong
// passphrase" — no passphrase will ever open it, so say so up front.
function passSealIsWellFormed(raw: Buffer): boolean {
  if (raw[4] !== PASS_VERSION) return false
  try {
    parseRecord(raw.subarray(5 + PASS_SALT_LEN))
    return true
  } catch {
    return false
  }
}

export class LocalStore implements SecretStore {
  private lmk: Buffer | null = null
  mode: LmkMode = 'locked'

  constructor(
    private readonly dir: string,
    private readonly keystore: OsKeystore | null,
  ) {
    mkdirSync(this.dir, { recursive: true })
  }

  /** True once the LMK is available and encrypted files can be read. */
  get unlocked(): boolean {
    return this.lmk !== null
  }

  /**
   * True when a sealed LMK is already on disk — i.e. this profile belongs to a
   * device that has been set up, whether or not this process can open it. The
   * identity, the DM keys and every cached secret hang off that one file, so
   * "is there a seal here?" is the question every destructive path has to ask
   * before it writes a new one.
   */
  hasSealedData(): boolean {
    return existsSync(this.sealedPath)
  }

  private get sealedPath(): string {
    return join(this.dir, LMK_SEALED)
  }

  private keystoreReady(): boolean {
    try {
      return this.keystore?.available() ?? false
    } catch {
      return false
    }
  }

  /** Reads (or, with an OS keystore, creates) the LMK. Never throws. */
  init(): LmkStatus {
    this.lmk = null
    this.mode = 'locked'

    if (existsSync(this.sealedPath)) {
      // A seal that is there but unreadable (EACCES from a restored/copied
      // profile, EIO, EBUSY behind a scanner, or a delete racing the
      // existsSync) is no different to the user than a seal that doesn't fit:
      // say 'unrecoverable' so the unlock screen can offer to start fresh.
      // This method must never throw — a rejection here has no boot path left.
      let raw: Buffer
      try {
        raw = readFileSync(this.sealedPath)
      } catch {
        return 'unrecoverable'
      }
      if (raw.subarray(0, 4).equals(MAGIC_PASS)) return passSealIsWellFormed(raw) ? 'passphrase' : 'unrecoverable'

      // OS-sealed, either with our marker or the pre-1.0.2 bare blob.
      if (!this.keystoreReady()) return 'unrecoverable'
      const legacy = !raw.subarray(0, 4).equals(MAGIC_OS)
      let lmk: Buffer
      try {
        lmk = this.keystore!.open(legacy ? raw : raw.subarray(4))
      } catch {
        return 'unrecoverable'
      }
      if (lmk.length !== 32) return 'unrecoverable'
      this.lmk = lmk
      this.mode = 'os'
      if (legacy) {
        // Best effort: the bare blob still opens next launch if the rewrite
        // fails (file held by a scanner, read-only profile).
        try {
          this.writeSealed(Buffer.concat([MAGIC_OS, this.keystore!.seal(lmk)]))
        } catch {}
      }
      return 'unlocked'
    }

    // First run. With an OS keystore the LMK is created right here and the
    // user never sees a prompt; otherwise onboarding wraps it under the team
    // passphrase once it has one.
    if (this.keystoreReady()) {
      try {
        const lmk = randomBytes(32)
        const sealed = Buffer.concat([MAGIC_OS, this.keystore!.seal(lmk)])
        this.clearSecrets() // leftovers from a seal that's gone would never decrypt
        this.writeSealed(sealed)
        this.lmk = lmk
        this.mode = 'os'
        return 'unlocked'
      } catch {
        // Keystore claimed availability but failed to seal — fall through to
        // the passphrase path rather than crash the boot.
      }
    }
    return 'fresh'
  }

  /** First run without an OS keystore: fresh random LMK wrapped under the passphrase. */
  createPassphraseLmk(passphrase: string): void {
    // The floor under every caller, and the last line of defence for someone's
    // device identity: a new LMK over an existing seal makes identity.enc,
    // pins.enc and every cache permanently unreadable. It is *destroying* local
    // data, not creating it, and the one path allowed to do that is the
    // explicit, user-confirmed reset — which calls wipe() first, so no seal is
    // here by the time it gets back to this method. (2026-09-14: onboarding
    // called this against a locked profile and destroyed a real identity.)
    if (this.hasSealedData()) {
      throw new Error('LocalStore already holds sealed data — wipe() is the only way to replace it')
    }
    // Any *.enc left over (an aborted setup, a wiped-by-hand seal) can't be
    // read under a new LMK and would only ever throw. Start clean.
    this.clearSecrets()
    const lmk = randomBytes(32)
    this.writeSealed(this.wrapPassphrase(lmk, passphrase))
    this.lmk = lmk
    this.mode = 'passphrase'
  }

  /** Wrong passphrase → false and the store stays locked. Never throws. */
  unlockWithPassphrase(passphrase: string): boolean {
    let raw: Buffer
    try {
      raw = readFileSync(this.sealedPath)
    } catch {
      return false
    }
    if (!raw.subarray(0, 4).equals(MAGIC_PASS) || raw[4] !== PASS_VERSION) return false
    const salt = raw.subarray(5, 5 + PASS_SALT_LEN)
    const record = raw.subarray(5 + PASS_SALT_LEN)
    try {
      const lmk = decryptRecord(record, deriveKek(passphrase, salt), LMK_AAD)
      if (lmk.length !== 32) return false
      this.lmk = lmk
      this.mode = 'passphrase'
      return true
    } catch {
      return false // GCM tag mismatch: wrong passphrase (or a corrupt seal)
    }
  }

  /**
   * Re-wrap the LMK under a different passphrase — joining another team
   * folder, or a team passphrase rotation. The secrets themselves are untouched.
   */
  rewrapPassphrase(newPassphrase: string): void {
    if (!this.lmk) throw new Error('LocalStore locked')
    if (this.mode !== 'passphrase') return // OS-sealed: the passphrase isn't the seal
    this.writeSealed(this.wrapPassphrase(this.lmk, newPassphrase))
  }

  /**
   * Forget everything sealed on this machine (the seal and every secret);
   * plaintext settings survive. The only way forward from 'unrecoverable'.
   */
  wipe(): void {
    this.lmk = null
    this.mode = 'locked'
    rmSync(this.sealedPath, { force: true })
    rmSync(`${this.sealedPath}.tmp`, { force: true })
    rmSync(join(this.dir, 'lmk.salt'), { force: true }) // pre-release passphrase format
    this.clearSecrets()
    this.clearDerivedData()
  }

  /**
   * Derived plaintext that lives under userData but is nobody's secret: the
   * decrypted attachment cache. It is written for the team folder currently
   * set up, so wiping the profile or leaving that folder has to take it too —
   * otherwise gigabytes of decrypted attachments outlive the seal that was
   * the only thing tying them to a team.
   */
  clearDerivedData(): void {
    for (const d of DERIVED_DIRS) rmSync(join(this.dir, d), { recursive: true, force: true })
  }

  // -------------------------------------------------------------------------

  private wrapPassphrase(lmk: Buffer, passphrase: string): Buffer {
    const salt = randomBytes(PASS_SALT_LEN)
    const record = encryptRecord(deriveKek(passphrase, salt), KID.local('lmk'), lmk, LMK_AAD)
    return Buffer.concat([MAGIC_PASS, Buffer.from([PASS_VERSION]), salt, record])
  }

  /** Temp-write + rename: a crash mid-write can't leave a half-written seal. */
  private writeSealed(data: Buffer): void {
    const tmp = `${this.sealedPath}.tmp`
    writeFileSync(tmp, data)
    renameSync(tmp, this.sealedPath)
  }

  private clearSecrets(): void {
    for (const f of readdirSync(this.dir)) {
      if (f.endsWith('.enc')) rmSync(join(this.dir, f), { force: true })
    }
  }

  // -------------------------------------------------------------------------

  private secretPath(name: string): string {
    return join(this.dir, `${name}.enc`)
  }

  writeSecret(name: string, data: Buffer): void {
    if (!this.lmk) throw new Error('LocalStore locked')
    const aad = buildAad('local', name, name)
    writeFileSync(this.secretPath(name), encryptRecord(this.lmk, KID.local(name), data, aad))
  }

  readSecret(name: string): Buffer | null {
    if (!this.lmk) throw new Error('LocalStore locked')
    const p = this.secretPath(name)
    if (!existsSync(p)) return null
    const aad = buildAad('local', name, name)
    return decryptRecord(readFileSync(p), this.lmk, aad)
  }

  writeSecretJson(name: string, value: unknown): void {
    this.writeSecret(name, Buffer.from(JSON.stringify(value), 'utf8'))
  }

  readSecretJson<T>(name: string): T | null {
    const buf = this.readSecret(name)
    return buf ? (JSON.parse(buf.toString('utf8')) as T) : null
  }

  deleteSecret(name: string): void {
    rmSync(this.secretPath(name), { force: true })
  }

  // Plaintext settings (theme, notification prefs — no secrets)

  readSettings<T>(): T | null {
    const p = join(this.dir, SETTINGS)
    if (!existsSync(p)) return null
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as T
    } catch {
      return null
    }
  }

  writeSettings(value: unknown): void {
    writeFileSync(join(this.dir, SETTINGS), JSON.stringify(value, null, 2))
  }
}
