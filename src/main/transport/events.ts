import { BEACON, DST, EVENT } from '@shared/constants'
import { hlcObserve, hlcTick } from '@shared/hlc'
import { dayShard, eventFileName, isChanConv, isGrpConv, parseEventFileName } from '@shared/ids'
import type { ConvId, EventPayload, EventType, SignedRecord, VerifiedEvent } from '@shared/types'
import { buildAad, decryptRecord, encryptRecord, recordKid } from '../crypto/envelope'
import { signRecord, verifyRecord } from '../crypto/identity'
import type { Session } from './session'

// Append-only event logs, one encrypted file per event. The filename stem is
// the event id and total order. Publishing also ratchets the HLC; ingesting a
// remote event folds its timestamp into our clock.

interface ConvLog {
  events: Map<string, VerifiedEvent>
  /** Days already fully scanned (catch-up bookkeeping). */
  scannedDays: Set<string>
  newestStem: string | null
  /**
   * Private-group files written under an epoch whose key we don't have yet
   * (day → file names). The rekey DM that carries it may simply be behind us
   * in the ingest order, so these are parked, not quarantined: their day never
   * counts as fully scanned, and `replayParked()` retries them the moment a
   * new key lands.
   */
  parked: Map<string, Set<string>>
  /**
   * Day shard covered by the last *full* catch-up (one that listed the day
   * directories). While it is still today, a sweep can skip that listing and
   * open today's directory by name — see catchUp({ fast: true }).
   */
  fullScanDay: string | null
}

export type EventListener = (conv: ConvId, event: VerifiedEvent) => void

/**
 * Fired when `publish()` loads a channel this session didn't know about yet
 * (see the comment there) — the sidebar has the conv id already but not its
 * name until the channels push this drives goes out.
 */
export type ChannelDiscoveredListener = () => void

/**
 * Ceiling on files parked for one conversation while their key is in flight.
 * Generous next to a real rotation (a rekey DM is on the share before the first
 * record under the new key is), and small enough that a peer inventing epochs
 * cannot make this device hold an unbounded list of names.
 */
const MAX_PARKED_PER_CONV = 500

export class EventStore {
  private logs = new Map<ConvId, ConvLog>()
  private listeners: EventListener[] = []
  private channelDiscoveredListeners: ChannelDiscoveredListener[] = []
  /** Sticky skew flags per device (UI banner). */
  readonly skewFlagged = new Set<string>()

  constructor(private session: Session) {}

  onEvent(cb: EventListener): void {
    this.listeners.push(cb)
  }

  onChannelDiscovered(cb: ChannelDiscoveredListener): void {
    this.channelDiscoveredListeners.push(cb)
  }

  private log(conv: ConvId): ConvLog {
    let l = this.logs.get(conv)
    if (!l)
      this.logs.set(
        conv,
        (l = {
          events: new Map(),
          scannedDays: new Set(),
          newestStem: null,
          parked: new Map(),
          fullScanDay: null,
        }),
      )
    return l
  }

  /**
   * Drop every cached event for a conversation. Used when a channel or group
   * folds to deleted (or we leave a group): the log on the share is on its way
   * out, and a local copy that outlives it would resurrect the conversation on
   * the next materialize.
   */
  forget(conv: ConvId): void {
    this.logs.delete(conv)
  }

  getEvents(conv: ConvId): VerifiedEvent[] {
    return [...this.log(conv).events.values()]
  }

  has(conv: ConvId, stem: string): boolean {
    return this.log(conv).events.has(stem)
  }

  newestStem(conv: ConvId): string | null {
    return this.log(conv).newestStem
  }

  // -------------------------------------------------------------------------

  async publish(conv: ConvId, type: EventType, payload: EventPayload): Promise<VerifiedEvent> {
    const s = this.session
    let info = s.convInfo(conv)
    // A channel can reach the UI before this session has read its metadata —
    // the sidebar hears about one as soon as a beacon head or a sys event
    // names it, while `loadChannels()` only runs on the poller's 1–10 minute
    // sweep. Writing into that window used to be rejected outright ("Say hello
    // does nothing"), so the conv id buys one targeted read of its
    // `channel.json.e1` first (the token is derivable from the id — no
    // directory listing), then the log, so a tombstone or a rename that is
    // already on the share folds before we decide. Only channels: a DM token
    // cannot be reversed to a peer, and a group's key only ever arrives in an
    // invite — for both, not knowing it really is the answer.
    if (!info && isChanConv(conv)) {
      if (await s.ensureChannel(conv)) {
        await this.catchUp(conv)
        info = s.convInfo(conv)
        // The sidebar already has this conv id (that's how we got handed it);
        // without this it would still show up nameless until some unrelated
        // sweep or beacon head happened to push `channels` again.
        for (const cb of this.channelDiscoveredListeners) cb()
      }
    }
    if (!info) throw new Error(`unknown conversation ${conv}`)
    const { ms, ctr } = hlcTick(s.hlc, s.io.calibratedNow())
    const fileName = eventFileName(ms, ctr, s.deviceId, type)
    const stem = fileName.slice(0, fileName.indexOf('.'))
    const day = dayShard(ms)
    const rel = `${info.eventsDir}/${day}/${fileName}`

    const signed = signRecord(s.identity, DST.record, payload)
    const plain = Buffer.from(JSON.stringify(signed), 'utf8')
    if (plain.length > EVENT.maxFileBytes) throw new Error('event too large — use the blob store')
    const aad = buildAad(info.scope, rel, stem)
    const buf = encryptRecord(info.key, info.kid, plain, aad)
    await s.io.publish(rel, buf, { calibrate: true })

    const ev: VerifiedEvent = {
      id: stem,
      type,
      payload,
      author: s.deviceId,
      verified: true,
      receivedAt: Date.now(),
    }
    this.insert(conv, ev)
    return ev
  }

  // -------------------------------------------------------------------------

  /** Ingest one event file by name (from a beacon head or a day scan). */
  async ingestFile(conv: ConvId, day: string, fileName: string): Promise<VerifiedEvent | null> {
    const parsed = parseEventFileName(fileName)
    if (!parsed) return null
    const l = this.log(conv)
    if (l.events.has(parsed.stem)) return l.events.get(parsed.stem)!
    // Already waiting for a key: don't pay for the read again on every sweep —
    // replayParked() is what retries these, once a rekey actually arrives.
    if (l.parked.get(day)?.has(fileName)) return null

    const s = this.session
    const info = s.convInfo(conv)
    if (!info) return null
    const rel = `${info.eventsDir}/${day}/${fileName}`
    const buf = await s.io.readMaybe(rel)
    if (!buf) return null

    try {
      // Private groups rotate keys under a stable directory, so the record's
      // own kid — not the conversation's current epoch — picks the key.
      let key = info.key
      let grpKid = ''
      if (isGrpConv(conv)) {
        grpKid = recordKid(buf)
        const lookup = s.groups?.keyForKid(conv, grpKid) ?? { kind: 'reject' as const }
        if (lookup.kind === 'unknown-epoch') {
          this.park(conv, day, fileName)
          return null
        }
        if (lookup.kind !== 'key') return null
        key = lookup.key
      }
      const aad = buildAad(info.scope, rel, parsed.stem)
      const plain = decryptRecord(buf, key, aad)
      const signed = JSON.parse(plain.toString('utf8')) as SignedRecord<EventPayload>

      let author = s.roster.get(signed.by)
      if (!author) {
        author = (await s.roster.loadOne(signed.by)) ?? undefined
        if (author) s.refreshDms()
      }
      const verified = !!author && verifyRecord(signed, DST.record, author.edPubKey)
      // The filename's device prefix must match the signer — otherwise someone
      // is replaying another author's payload under their own slot.
      if (!signed.by.startsWith(parsed.deviceId8)) return null
      // A channel or DM shows an unverified record with a warning chip: the
      // team key already bounds who could have written it, and a lost roster
      // entry must not silently swallow history. A private group cannot afford
      // that: every rule it has — who may rename, who may remove, whose
      // tombstone counts, whose retired-key write is refused — is a statement
      // about the *author*, and an unverified record has no author to hold to
      // any of them. Anyone holding a leaked epoch key could otherwise write as
      // the owner. So a group record that does not verify never enters the log.
      if (isGrpConv(conv) && !verified) return null
      // Removing someone from a group rotates the key, which stops them
      // reading it. They still hold the old key, so this is what stops them
      // writing into it: a retired epoch used after the rotation, by someone
      // who is no longer a member, does not count. The *stem* cannot decide
      // that — a removed device picks its own filename and can back-date it
      // freely — so the rotation point is compared against when the file
      // actually appeared on the share.
      if (grpKid) {
        const cut = s.groups?.staleWriteCut(conv, grpKid, signed.by) ?? null
        if (cut !== null) {
          const st = await s.io.statMaybe(rel)
          const wroteAt = st ? st.mtimeMs : parsed.hlcMs
          if (wroteAt > Number(cut.slice(0, 13))) return null
        }
      }

      const skewed = hlcObserve(s.hlc, parsed.hlcMs, s.io.calibratedNow())
      if (skewed) this.skewFlagged.add(signed.by)

      const ev: VerifiedEvent = {
        id: parsed.stem,
        type: parsed.type,
        payload: signed.p,
        author: signed.by,
        verified,
        receivedAt: Date.now(),
      }
      this.insert(conv, ev)
      return ev
    } catch {
      return null // auth failure / corrupt — quarantine by skipping
    }
  }

  /**
   * Scan a conversation's day directories and ingest everything missing.
   * Closed days that were fully scanned once are skipped forever.
   *
   * `fast` is the poller's blanket sweep (1.2): once a full scan has covered
   * today, the only directory a live peer can be writing into is today's, and
   * its name is computable — so the sweep opens it by name and skips listing
   * the day directories, halving the sweep's cost per conversation. The moment
   * the day rolls over (or this conversation has never been scanned) it falls
   * back to the full walk on its own. Anything a peer writes into an older day
   * still arrives through its beacon heads, exactly as before.
   */
  async catchUp(conv: ConvId, opts?: { fast?: boolean }): Promise<number> {
    const s = this.session
    const info = s.convInfo(conv)
    if (!info) return 0
    const l = this.log(conv)
    const today = dayShard(s.io.calibratedNow())
    let ingested = 0

    if (opts?.fast && l.fullScanDay === today) {
      const files = await s.io.list(`${info.eventsDir}/${today}`)
      for (const f of files.sort()) {
        const before = l.events.size
        await this.ingestFile(conv, today, f)
        if (l.events.size > before) ingested++
      }
      return ingested
    }

    const days = (await s.io.listDirs(info.eventsDir)).sort()
    for (const day of days) {
      if (l.scannedDays.has(day) && day < today) continue
      const files = await s.io.list(`${info.eventsDir}/${day}`)
      for (const f of files.sort()) {
        const before = l.events.size
        await this.ingestFile(conv, day, f)
        if (l.events.size > before) ingested++
      }
      // A day holding parked files is never "done": the key for them may still
      // be in flight, and this scan is what will pick them up afterwards.
      if (day < today && !l.parked.get(day)?.size) l.scannedDays.add(day)
    }
    l.fullScanDay = today
    return ingested
  }

  private park(conv: ConvId, day: string, fileName: string): void {
    const l = this.log(conv)
    // Parking is unbounded work held in memory on someone else's say-so: every
    // parked name is re-read the moment any key arrives, and the epoch in a kid
    // is whatever its writer typed. Past the cap we simply stop remembering —
    // the file is not lost, the next full day scan finds it again once the
    // backlog clears (GroupService also refuses to park an epoch far above the
    // newest key we hold, which is the other half of this).
    if (this.parkedCount(conv) >= MAX_PARKED_PER_CONV) return
    const set = l.parked.get(day) ?? new Set<string>()
    set.add(fileName)
    l.parked.set(day, set)
    l.scannedDays.delete(day)
  }

  /** Is this exact file already waiting for a key? (Not a gap — see ingestHeads.) */
  private isParked(conv: ConvId, day: string, fileName: string): boolean {
    return this.log(conv).parked.get(day)?.has(fileName) ?? false
  }

  /** How many files are waiting for a key in this conversation (tests/diagnostics). */
  parkedCount(conv: ConvId): number {
    let n = 0
    for (const set of this.log(conv).parked.values()) n += set.size
    return n
  }

  /**
   * Retry every parked file — called when a `group-rekey` hands us a key we
   * were missing. Files still under an unknown epoch simply park again.
   */
  async replayParked(conv: ConvId): Promise<number> {
    const l = this.log(conv)
    if (l.parked.size === 0) return 0
    const pending: [string, string[]][] = [...l.parked.entries()].map(([day, files]) => [day, [...files]])
    l.parked.clear()
    let ingested = 0
    for (const [day, files] of pending) {
      for (const f of files.sort()) {
        const before = l.events.size
        await this.ingestFile(conv, day, f)
        if (l.events.size > before) ingested++
      }
    }
    return ingested
  }

  /**
   * Ingest the exact files a peer's beacon `heads` names (zero readdirs).
   *
   * `ringSize` is the capacity of the ring these names came out of — 16 for
   * `heads` and a sealed section's `heads`, smaller for `grpHeads`/`heads2`.
   * It is what makes an overflowed ring detectable; see the continuity check
   * at the bottom.
   */
  async ingestHeads(
    conv: ConvId,
    headFileNames: string[],
    ringSize: number = BEACON.headsRingSize,
  ): Promise<boolean> {
    let sawNew = false
    let mayHaveGap = false
    /** Advertised names that parse — the ring's real length to a reader. */
    let advertised = 0
    /**
     * Names we can account for without reading anything new: already ingested,
     * or parked waiting for a key. One of these is the proof of continuity the
     * overflow check below looks for.
     */
    let accounted = 0
    const l = this.log(conv)
    for (const f of headFileNames) {
      const parsed = parseEventFileName(f)
      if (!parsed) continue
      advertised++
      if (l.events.has(parsed.stem)) {
        accounted++
        continue
      }
      const day = dayShard(parsed.hlcMs)
      const ev = await this.ingestFile(conv, day, f)
      if (ev) sawNew = true
      // A parked head is not a gap: we know exactly what that file is and are
      // waiting for its key. Treating it as one made every peer bump during a
      // rekey cost a full day-directory walk of the group, over and over, for
      // as long as the rotation took to reach us.
      else if (this.isParked(conv, day, f)) accounted++
      else mayHaveGap = true
    }
    // An advertised head we could not read means older un-advertised events may
    // exist too.
    //
    // So does a *full* ring in which we recognized nothing (1.6.1). The ring
    // holds only the writer's last `ringSize` filenames: publish 45 messages
    // between two of a reader's polls — a paste storm, an import, a burst of
    // votes — and the 29 oldest are never advertised to anybody. Every one of
    // the 16 names that survive reads back perfectly, so the missing-head rule
    // above never fires, and the reader is left silently 29 events behind until
    // its next blanket sweep (up to 10 minutes away at the idle tier). Not
    // recognizing a single name in a ring that is at capacity is exactly the
    // signature of that: in the steady state a reader already holds all but the
    // newest one or two. A reader meeting a chatty conversation for the first
    // time trips it too, and should — it needs the history either way.
    if (advertised >= ringSize && accounted === 0) mayHaveGap = true
    if (mayHaveGap) await this.catchUp(conv)
    return sawNew
  }

  private insert(conv: ConvId, ev: VerifiedEvent): void {
    const l = this.log(conv)
    l.events.set(ev.id, ev)
    if (!l.newestStem || ev.id > l.newestStem) l.newestStem = ev.id
    for (const cb of this.listeners) cb(conv, ev)
  }
}
