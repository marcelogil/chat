import { sanitizeHostname } from '@shared/ids'

// One person, one machine, two registrations (1.4).
//
// "Reset local data" destroys the device identity and nothing else: the old
// registration stays on the share forever (a roster record is never deleted —
// its signature is what keeps every message that device ever signed
// verifiable), so re-joining from the same machine leaves *two* device records
// with the same person behind them. Every roster surface then shows that
// person twice, one of the two being an identity nobody can ever sign with
// again.
//
// The tie-break is a plain record comparison, kept here as a pure function so
// it can be tested without a share: same display name, same sanitized
// hostname, machine fingerprints equal (or unavailable on either side), and a
// later `firstSeen` on the survivor.
//
// The one thing a record comparison alone gets wrong is two *live* clients on
// one machine under one name (two dev profiles, a scratch instance beside the
// real one), so a device that is beaconing right now is never superseded. Note
// what that guard does NOT do: it never compares a beacon stamp (share clock)
// against a `firstSeen` (the writer's own wall clock) — on a share whose clock
// is minutes out, that comparison silently decides the wrong way. "Is it live"
// is asked entirely in share time by the caller.

/** Everything the rule reads about one registration. */
export interface DeviceFacts {
  deviceId: string
  displayName: string
  /** Raw hostname off the record; sanitized here, never at the call site. */
  hostname: string
  machineIdHash: string | null
  firstSeen: number
  /**
   * Beaconing right now, and not a goodbye: a fresh heartbeat that does not
   * say `offline`. A device destroyed by a reset can never produce one again;
   * a second live instance produces one every heartbeat.
   */
  live: boolean
}

/** Trimmed, whitespace-collapsed, case-insensitive: what a person retypes. */
function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** The half of a registration that says *which machine and person* it is. */
export type MachineFacts = Pick<DeviceFacts, 'displayName' | 'hostname' | 'machineIdHash'>

export function sameMachine(a: MachineFacts, b: MachineFacts): boolean {
  if (normalizeName(a.displayName) !== normalizeName(b.displayName)) return false
  if (sanitizeHostname(a.hostname) !== sanitizeHostname(b.hostname)) return false
  // A null fingerprint is "unavailable" (Linux, or ioreg/reg refused), never
  // "different" — the display name and hostname still have to match.
  if (a.machineIdHash && b.machineIdHash && a.machineIdHash !== b.machineIdHash) return false
  return true
}

/**
 * Same person, same machine, *proven* — the machine fingerprints match, not
 * merely fail to contradict each other.
 *
 * TOFU asks this one. `Roster.ingest` flags a new device that claims a pinned
 * display name as an impersonator; after a "Reset local data" + re-join the
 * new device *is* the person, so the flag would brand the survivor for good
 * on every teammate's screen — hiding the ghost does nothing about a red chip
 * on the row that stays. But "I could not read a fingerprint" is not evidence
 * of anything, and unlike hiding a row, dropping the impersonation warning is
 * a security answer: where the rule above tolerates a missing `machineIdHash`
 * (it still needs the predecessor to be provably silent, which no impostor
 * can arrange), this one refuses to. A device with no fingerprint keeps the
 * warning; the person on that platform can still say "trust" by hand.
 */
export function provenSameMachine(a: MachineFacts, b: MachineFacts): boolean {
  if (!a.machineIdHash || a.machineIdHash !== b.machineIdHash) return false
  return sameMachine(a, b)
}

/** Is `newer` the same person, on the same machine, set up after `older`? */
export function supersedes(newer: DeviceFacts, older: DeviceFacts): boolean {
  if (newer.deviceId === older.deviceId) return false
  if (older.live) return false // still here: two instances, not a re-join
  if (!(newer.firstSeen > older.firstSeen)) return false
  return sameMachine(newer, older)
}

/**
 * deviceId -> the deviceId that replaced it, for every registration in
 * `facts` that a later one supersedes (newest successor wins when someone has
 * reset more than once). Devices with no successor are absent from the map.
 *
 * Pass the WHOLE roster, this device's own record included: the commonest
 * shape of this bug is a person looking at their own sidebar the day they
 * re-joined, where the superseding record is the local one.
 */
export function supersededDevices(facts: readonly DeviceFacts[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const older of facts) {
    let best: DeviceFacts | null = null
    for (const newer of facts) {
      if (!supersedes(newer, older)) continue
      if (!best || newer.firstSeen > best.firstSeen) best = newer
    }
    if (best) out.set(older.deviceId, best.deviceId)
  }
  return out
}
