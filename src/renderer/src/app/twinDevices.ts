// The gap the supersession rule cannot close, and what the pickers do about
// it (1.4).
//
// Main hides a re-joined person's old registration the moment it can *prove*
// nobody is behind it: a goodbye beacon, or a heartbeat gone stale. When the
// previous run was killed hard — force quit, crash, power cut — it wrote no
// goodbye, and the proof only arrives when that last heartbeat ages past
// `PRESENCE.onlineWithinMs` (50 s). It cannot arrive sooner: a live second
// instance on the same machine may sit at the idle tier and beacon only every
// `BEACON.idleHeartbeatMs` (45 s), so anything quicker would hide a device
// that is right there. For those few seconds two registrations of one person
// both look alive, and `supersededBy` is (correctly) set on neither.
//
// Listing both for a moment is survivable. Silently *binding* to the wrong
// one is not: `detectEntities` gives "@Gil" the first roster row with that
// name, and a mention only notifies the device it names
// (`chatService`: `e.device === session.deviceId`), so picking the dead twin
// sends the notification nowhere at all and nothing on screen says so.
//
// So every surface that turns a name into one device — the mention picker and
// the roster behind it, the quick switcher, the group add-member picker —
// runs its list through this first: of two registrations that look like the
// same person on the same machine, the one that beaconed most recently wins.
// In the re-join window that is always the survivor (the ghost's beacon is
// frozen at the moment it died); with two genuinely live instances it is
// whichever is more awake, and both are the same person anyway.
//
// Rows main has already resolved (`supersededBy`) pass through untouched:
// they are a decision, not an ambiguity, and the sidebar deliberately keeps
// one of them reachable under "(previous device)".

/** Everything the rule reads. `PresenceView` satisfies it. */
export interface TwinFacts {
  deviceId: string
  name: string
  hostname: string
  lastSeenMs: number | null
  supersededBy?: string
}

function twinKey(p: TwinFacts): string {
  return `${p.name.trim().replace(/\s+/g, ' ').toLowerCase()}|${p.hostname.trim().toLowerCase()}`
}

/**
 * One row per person-machine: the freshest beacon wins, input order is
 * otherwise preserved, and anything already marked `supersededBy` is left
 * exactly where it was.
 */
export function preferFreshestTwin<T extends TwinFacts>(people: readonly T[]): T[] {
  const winner = new Map<string, T>()
  for (const p of people) {
    if (p.supersededBy) continue
    const key = twinKey(p)
    const best = winner.get(key)
    // Strictly-greater keeps the first row when two have never been seen (or
    // were seen at the same instant), so the order a caller passed in is the
    // tie-break rather than the iteration order of a map.
    if (!best || (p.lastSeenMs ?? -1) > (best.lastSeenMs ?? -1)) winner.set(key, p)
  }
  return people.filter((p) => p.supersededBy || winner.get(twinKey(p)) === p)
}
