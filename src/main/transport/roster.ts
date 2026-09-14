import type { KeyObject } from 'node:crypto'
import { DIR, DST, FILE_EXT, KID } from '@shared/constants'
import type { DevicePin, DeviceRecord, SignedRecord } from '@shared/types'
import { buildAad, decryptRecord, encryptRecord } from '../crypto/envelope'
import {
  deviceIdFromEdPub,
  importEdPub,
  signRecord,
  verifyRecord,
  type DeviceIdentity,
} from '../crypto/identity'
import type { SecretStore } from '../store/secretStore'
import type { ShareIo } from './shareIo'
import { provenSameMachine } from './supersede'

// Device roster: signed self-registrations on the share, TOFU pins locally.
// A device record is self-certifying — the edPub inside must hash to the
// deviceId in the filename, and the signature must verify against that edPub.
// Trust decisions (name collisions, revocations) are local state.

export interface RosterEntry {
  record: DeviceRecord
  pin: DevicePin
  edPubKey: KeyObject
}

const PINS_SECRET = 'pins'

export class Roster {
  private entries = new Map<string, RosterEntry>() // deviceId -> entry
  private pins = new Map<string, DevicePin>()
  private onChange: (() => void) | null = null

  constructor(
    private io: ShareIo,
    private store: SecretStore,
    private kMeta: Buffer,
    private epoch: number,
  ) {}

  setOnChange(cb: () => void): void {
    this.onChange = cb
  }

  loadPins(): void {
    const saved = this.store.readSecretJson<DevicePin[]>(PINS_SECRET)
    if (saved) for (const p of saved) this.pins.set(p.deviceId, p)
  }

  private savePins(): void {
    this.store.writeSecretJson(PINS_SECRET, [...this.pins.values()])
  }

  all(): RosterEntry[] {
    return [...this.entries.values()]
  }

  get(deviceId: string): RosterEntry | undefined {
    return this.entries.get(deviceId)
  }

  /** Find by the 8-char filename prefix used in event/beacon names. */
  getByPrefix(deviceId8: string): RosterEntry | undefined {
    for (const e of this.entries.values()) if (e.record.deviceId.startsWith(deviceId8)) return e
    return undefined
  }

  getPin(deviceId: string): DevicePin | undefined {
    return this.pins.get(deviceId)
  }

  setTrust(deviceId: string, trust: DevicePin['trust']): void {
    const pin = this.pins.get(deviceId)
    if (pin) {
      pin.trust = trust
      this.savePins()
      const e = this.entries.get(deviceId)
      if (e) e.pin = pin
      this.onChange?.()
    }
  }

  /** Publish (or refresh) our own registration. */
  async publishSelf(identity: DeviceIdentity, record: Omit<DeviceRecord, 'type' | 'v'>): Promise<void> {
    const full: DeviceRecord = { type: 'device-record', v: 1, ...record }
    const signed = signRecord(identity, DST.devrec, full)
    const rel = `${DIR.devices}/${identity.deviceId}.json${FILE_EXT.record}`
    const aad = buildAad('meta', rel, identity.deviceId)
    const buf = encryptRecord(this.kMeta, KID.meta(this.epoch), Buffer.from(JSON.stringify(signed)), aad)
    await this.io.publish(rel, buf, { calibrate: true })
    this.ingest(identity.deviceId, signed)
  }

  /** Load every registration from the share. */
  async refresh(): Promise<void> {
    const names = await this.io.list(DIR.devices)
    for (const name of names) {
      const m = /^([0-9a-f]{32})\.json\.e1$/.exec(name)
      if (!m) continue
      const deviceId = m[1]
      if (this.entries.has(deviceId)) continue
      await this.loadOne(deviceId)
    }
    this.healFlags() // judged against the whole listing, not the part read so far
  }

  async loadOne(deviceId: string): Promise<RosterEntry | null> {
    const rel = `${DIR.devices}/${deviceId}.json${FILE_EXT.record}`
    const buf = await this.io.readMaybe(rel)
    if (!buf) return null
    try {
      const aad = buildAad('meta', rel, deviceId)
      const plain = decryptRecord(buf, this.kMeta, aad)
      const signed = JSON.parse(plain.toString('utf8')) as SignedRecord<DeviceRecord>
      return this.ingest(deviceId, signed)
    } catch {
      return null // corrupt/foreign — skip, never crash
    }
  }

  /**
   * Does this record take a display name already pinned to somebody else —
   * the impersonation warning?
   *
   * A pin that is the *same person on the same machine* is not somebody else:
   * it is the registration a "Reset local data" + re-join left behind (1.4,
   * `supersede.ts`). Without this, the fix that hides the ghost leaves the
   * real person wearing a permanent red chip on every teammate's screen —
   * the sidebar DM row, the members rail, the group dialog — because TOFU
   * fired the moment the new record landed.
   *
   * It takes a *proven* machine match (`provenSameMachine`): the two records
   * carry the same `machineIdHash`, which on macOS and Windows is a hash of
   * the hardware UUID and survives any amount of local wiping. A missing
   * fingerprint keeps the warning — silence is not evidence, and this is the
   * one place in the re-join story where being wrong is a security answer
   * rather than a layout one.
   *
   * Liveness is deliberately not part of it: two live instances on one
   * machine under one name are not impersonation either, and `ingest` has no
   * beacons to read.
   */
  private nameCollision(rec: DeviceRecord): boolean {
    for (const p of this.pins.values()) {
      if (p.deviceId === rec.deviceId) continue
      if (p.trust === 'revoked') continue
      if (p.displayName !== rec.displayName) continue
      // `machineIdHash` lives on the record, not the pin, so this can only
      // answer for a device whose record is loaded. Until it is, the pin
      // reads as fingerprint-less and the flag stands — `healFlags()` comes
      // back for it once the whole listing is in.
      const known = this.entries.get(p.deviceId)?.record
      const same = provenSameMachine(
        { displayName: rec.displayName, hostname: rec.hostname, machineIdHash: rec.machineIdHash },
        { displayName: p.displayName, hostname: p.hostname, machineIdHash: known?.machineIdHash ?? null },
      )
      if (!same) return true
    }
    return false
  }

  /**
   * Re-ask the impersonation question for every flagged pin, now that the
   * whole listing is in. `ingest` can only judge against the records loaded
   * *before* it, and the device directory is listed in filename (= key hash)
   * order — so whether a re-joined device's own record is read before or
   * after its predecessor's is a coin flip that lands the same way on every
   * launch. Without this pass, half of all re-joins would wear the chip for
   * ever, and every client that flagged one before this rule existed would
   * keep doing so.
   *
   * Only ever relaxes `flagged` → `pinned`: `revoked` and a hand-set
   * `trusted` are decisions.
   */
  private healFlags(): void {
    let changed = false
    for (const pin of this.pins.values()) {
      if (pin.trust !== 'flagged') continue
      const rec = this.entries.get(pin.deviceId)?.record
      if (!rec || this.nameCollision(rec)) continue
      pin.trust = 'pinned' // entries hold this very object, so the view follows
      changed = true
    }
    if (changed) {
      this.savePins()
      this.onChange?.()
    }
  }

  private ingest(deviceId: string, signed: SignedRecord<DeviceRecord>): RosterEntry | null {
    const rec = signed.p
    // Self-certification: id must equal hash of the embedded key…
    if (rec.deviceId !== deviceId || deviceIdFromEdPub(rec.edPub) !== deviceId) return null
    const edPubKey = importEdPub(rec.edPub)
    // …and the signature must verify against that key.
    if (!verifyRecord(signed, DST.devrec, edPubKey)) return null

    const existing = this.entries.get(deviceId)
    if (existing && rec.recSeq < existing.record.recSeq) return existing // reject regressions

    let pin = this.pins.get(deviceId)
    if (!pin) {
      // TOFU: first sight of this deviceId. Flag when the display name is
      // already pinned to a DIFFERENT device — the impersonation warning.
      const nameCollision = this.nameCollision(rec)
      pin = {
        deviceId,
        edPub: rec.edPub,
        xPub: rec.xPub,
        displayName: rec.displayName,
        hostname: rec.hostname,
        firstSeen: rec.firstSeen,
        trust: nameCollision ? 'flagged' : 'pinned',
      }
      this.pins.set(deviceId, pin)
      this.savePins()
    } else if (pin.edPub !== rec.edPub) {
      // Impossible for a matching deviceId (id = hash of key) — but guard anyway.
      return null
    } else {
      if (pin.displayName !== rec.displayName) {
        pin.displayName = rec.displayName
        this.savePins()
      }
      // Drop a flag that no longer describes anything (1.4). A client that
      // pinned this device before the re-join rule existed — or before the
      // predecessor's own record had been read — holds a `flagged` pin for
      // the one device the person is actually using, and nothing else would
      // ever clear it: a chip that says "impersonator" on the survivor of a
      // reset, for good. Only ever relaxes `flagged`; `revoked` and a
      // hand-set `trusted` are decisions, not guesses.
      if (pin.trust === 'flagged' && !this.nameCollision(rec)) {
        pin.trust = 'pinned'
        this.savePins()
      }
    }

    const entry: RosterEntry = { record: rec, pin, edPubKey }
    this.entries.set(deviceId, entry)
    this.onChange?.()
    return entry
  }
}
