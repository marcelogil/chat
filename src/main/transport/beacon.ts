import { BEACON, DIR, DST, KID, PRESENCE } from '@shared/constants'
import {
  beaconFileName,
  isDmConv,
  isGrpConv,
  parseBeaconFileName,
  parseEventFileName,
  seqToBase36,
} from '@shared/ids'
import type { BeaconContent, ConvId, Cursor, DmBeaconSection, SignedRecord } from '@shared/types'
import { buildAad, decryptRecord, encryptRecord } from '../crypto/envelope'
import { signRecord, verifyRecord } from '../crypto/identity'
import type { IoTier } from '../services/ioTier'
import type { Session } from './session'

/**
 * How often a beacon publish also stats the file it just wrote to re-derive the
 * share-clock offset. That offset is an EMA that moves 0.3 per sample and drifts
 * by milliseconds an hour, so sampling it once every few minutes is generous —
 * and every event publish calibrates as well, so an active conversation keeps
 * it fresher still. Before 1.2 every single beacon bump paid for this stat.
 */
const CALIBRATE_EVERY_MS = 5 * 60_000

/**
 * How many `grp` notice filenames a DM section advertises (1.2). Invites and
 * rekeys are rare — a handful over a group's whole life — and the blanket sweep
 * picks up anything that falls off the end, so this stays small.
 */
export const GRP_HEADS_RING = 4

/**
 * Event types a 1.2 client's filename regex can parse. Anything else (1.3's
 * `vot`, and whatever comes after it) goes in `heads2` instead of `heads`.
 *
 * Not because the name itself would hurt an older reader: `ingestHeads` skips a
 * filename it cannot parse (`if (!parsed) continue`) *before* the gap check, in
 * 1.2 exactly as here, so a `.vot.e1` in `heads` would cost it no catch-up and
 * no read. The reason is the ring: `heads` holds `BEACON.headsRingSize` (16)
 * names per conversation, and votes are the one event type that arrives in a
 * burst — a poll with a dozen voters would push every `msg` filename out of the
 * ring before an older reader next polls. It would then learn nothing about the
 * new messages from the beacon and wait for its next bounded day scan to find
 * them, which is the cheap path we built `heads` to avoid. Their own field gives
 * votes their own budget, and costs an older reader nothing at all: an unknown
 * top-level field is not a name it has to make sense of, it is one it never sees.
 */
const HEADS_1_2_TYPES = new Set(['msg', 'edt', 'del', 'rct', 'pin', 'sys', 'prv', 'cal', 'prs', 'grp'])

/**
 * How many new-type filenames a conversation advertises in `heads2`. Votes are
 * the only thing riding it today and they arrive in small bursts (one per
 * person, once); the blanket sweep picks up anything that falls off the end.
 */
export const HEADS2_RING = 8

// The beacon: one single-writer file per device whose SEQUENCE lives in the
// filename, so one readdir of beacon/ per poll tick reveals every device's
// latest state with zero stat calls. Contents carry presence, typing, heads
// (exact filenames of recent events), cursors, transfer progress, drop hints,
// and LAN reachability. DM-related state is nested and encrypted per-pair so
// teammates can't map who talks to whom.

export class BeaconWriter {
  private seq: number
  private lastPublishedName: string | null = null
  private dirty = false
  private pendingTimer: NodeJS.Timeout | null = null
  private heartbeat: NodeJS.Timeout | null = null
  /** The schedule `heartbeat` is actually running on; null when it is silent. */
  private scheduled: { periodMs: number; jitter: boolean } | null = null
  private lastBumpAt = 0
  /** I/O tier (1.2): heartbeat cadence, `presence.idleSec`, and paused = silent. */
  private tier: IoTier = 'blurred'
  private started = false
  /** Share clock of the last calibration stat; 0 = never (the startup beacon). */
  private lastCalibrateAt = 0
  /** Tail of the publish queue — see publishNow(). */
  private publishing: Promise<void> = Promise.resolve()

  // State assembled into each beacon
  presence: BeaconContent['presence'] = { state: 'online', status: '', idleSec: 0 }
  typing: BeaconContent['typing'] | undefined
  private heads = new Map<ConvId, string[]>() // channels + team convs (sealed convs live below)
  /** Post-1.2 event types (`vot`, …) for those same conversations — see HEADS_1_2_TYPES. */
  private heads2 = new Map<ConvId, string[]>()
  private cursors = new Map<ConvId, { read: string; ingested: string }>()
  /**
   * Heads/cursor/typing for every conversation whose existence is private: DMs
   * (who talks to whom) and private groups (1.2). Keyed by ConvId here, split
   * into `dmSealed` / `grpSealed` at publish time and encrypted under that
   * conversation's own key — everyone else sees an opaque token and nothing else.
   */
  private sealedSections = new Map<ConvId, DmBeaconSection>()
  xfers: BeaconContent['xfers'] = {}
  drops: BeaconContent['drops'] = {}
  lanIps: string[] = []
  wsPort: number | undefined

  constructor(
    private session: Session,
    /** Injected so tests (and the budget harness) don't need electron's app. */
    private getAppVersion: () => string = () => '',
    /**
     * Gil's always-online preference (1.5), pulled fresh on every heartbeat
     * decision and every publish — the same seam chatService/prService use
     * for settings elsewhere (`getSettings()` called at the point of
     * decision, not pushed). Content therefore follows the setting on the
     * very next beacon by itself; the *schedule* cannot, because a beacon
     * that is not beating has no "next beacon" to re-decide on, so flipping
     * the setting calls `syncHeartbeat()` (ChatService.onSettingsChanged) to
     * re-evaluate it. `SettingsView.alwaysOnline` is otherwise unenforced —
     * harmless if set by hand on some other device — because the gate that
     * matters is which display name the Settings UI offers the toggle to
     * (`isGil`, `@shared/gilMode`), not anything checked here.
     */
    private getAlwaysOnline: () => boolean = () => false,
  ) {
    this.seq = session.store.readSecretJson<number>('beacon-seq') ?? 0
  }

  start(): void {
    this.started = true
    this.restartHeartbeat()
    void this.bump('startup')
  }

  async stop(goodbye = true): Promise<void> {
    this.started = false
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (this.pendingTimer) clearTimeout(this.pendingTimer)
    if (goodbye) {
      this.presence = { ...this.presence, state: 'offline' }
      await this.publishNow().catch(() => {})
    }
  }

  /**
   * The presence teammates are about to read: the truthful state with Gil's
   * always-online override (1.5) applied. Everything that has to agree with
   * the share reads presence through here — the beacon body itself, and this
   * device's own footer/right-rail row (`ChatService.selfPresence`), which
   * derives away/online from `idleSec` exactly the way a peer does. Reading
   * the raw field there instead made Gil's own dot go amber after five idle
   * minutes while every teammate saw him green: the one vantage point he has
   * on the setting showed it not working.
   */
  get publishedPresence(): BeaconContent['presence'] {
    return this.keepingGreen() ? { ...this.presence, state: 'online' as const, idleSec: 0 } : this.presence
  }

  /** Gil's always-online preference, with appear-offline outranking it. */
  private keepingGreen(): boolean {
    return this.getAlwaysOnline() && this.presence.state !== 'offline'
  }

  /**
   * Heartbeat schedule for the current tier; null while paused — except for
   * Gil, who keeps beating at the idle cadence through a locked screen so
   * peers keep seeing green (1.5). Appear-offline still wins: if the presence
   * itself says offline there is nothing left to keep looking online, so the
   * paused device goes back to publishing its one goodbye and falling silent.
   *
   * That keep-green beat is the one schedule carrying no jitter. Jitter only
   * ever pushes a period later (see below), and 45 s + up to 3 s against
   * PRESENCE.onlineWithinMs (50 s) leaves a peer barely 2 s of slack before it
   * paints a locked-but-green Gil "away" anyway — the poller measures age from
   * the beacon's own `hlc`. A single device beating behind a lock screen has
   * no team to spread against, and its phase is already randomized by the
   * moment the screen locked, so it runs at exactly BEACON.idleHeartbeatMs and
   * keeps the whole 5 s.
   */
  private heartbeatPlan(): { periodMs: number; jitter: boolean } | null {
    if (this.tier === 'paused') {
      return this.keepingGreen() ? { periodMs: BEACON.idleHeartbeatMs, jitter: false } : null
    }
    return { periodMs: this.tier === 'idle' ? BEACON.idleHeartbeatMs : BEACON.heartbeatMs, jitter: true }
  }

  private restartHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    this.scheduled = null
    const plan = this.heartbeatPlan()
    if (!this.started || !plan) return
    this.scheduled = plan
    // Jitter spreads a team's writes apart; it must never pull the period in.
    // `Math.floor(Math.random() * 2 - 1)` only ever yielded -1 or 0, so every
    // client ran its beacon between 15% early and on time — a systematic
    // overshoot of the cadence the constants describe.
    this.heartbeat = setInterval(
      () => void this.bump('heartbeat'),
      plan.periodMs + (plan.jitter ? Math.floor(Math.random() * BEACON.heartbeatJitterMs) : 0),
    )
  }

  /**
   * Re-evaluate the heartbeat against the tier, the presence and the
   * always-online setting, restarting the interval only when the schedule it
   * should run at actually changed — so a repeated tier report or a status
   * edit never resets the phase (and never brings the next write forward).
   *
   * Public because two inputs move without a tier change: the setting itself
   * (ChatService.onSettingsChanged) and appear-offline chosen while already
   * paused, which used to leave a paused device beating forever.
   */
  syncHeartbeat(): void {
    if (!this.started) return
    const plan = this.heartbeatPlan()
    if (plan?.periodMs === this.scheduled?.periodMs && plan?.jitter === this.scheduled?.jitter) return
    this.restartHeartbeat()
  }

  /**
   * Follow the I/O tier (1.2). `idleSec` finally carries the truth — peers
   * derive "away" from it (PRESENCE.awayIdleSec), which until now could only
   * ever happen by a beacon going stale. A paused device (locked screen,
   * suspended machine) publishes one last beacon saying so and then goes
   * quiet: the idle heartbeat still beats PRESENCE.offlineAfterMs, so a 1.1
   * reader shows "away" rather than a hole.
   */
  setTier(tier: IoTier, idleSec = 0): void {
    const prev = this.tier
    this.tier = tier
    const changed = prev !== tier
    const state =
      this.presence.state === 'offline'
        ? 'offline' // the user chose to appear offline — never override that
        : tier === 'paused'
          ? 'away'
          : 'online'
    // The goodbye beacon has to read as "away" to a reader that only looks at
    // `idleSec` — which is every reader, 1.1 and 1.2 alike: presenceViews()
    // special-cases `state:'offline'` and otherwise derives away/online from
    // idleSec, and the paused device stops publishing right after this, so
    // nothing later can correct it. The OS idle counter is meaningless behind a
    // lock screen anyway, so floor it at the threshold rather than send a 0.
    const sec = tier === 'paused' ? Math.max(idleSec, PRESENCE.awayIdleSec) : idleSec
    // A drifting idleSec rides the next heartbeat rather than provoking a
    // write of its own — otherwise "still idle" would cost more traffic than
    // the idle tier saves.
    this.presence = { ...this.presence, state, idleSec: sec }
    // The schedule depends on more than the tier name (appear-offline, the
    // always-online setting), so re-evaluate it on every report; syncHeartbeat
    // restarts nothing when the schedule is unchanged, which is the common case.
    this.syncHeartbeat()
    if (!changed) return
    if (this.started) void this.bump('presence')
  }

  /** DMs and private groups seal their section; channels/team convs go plain. */
  private isSealed(conv: ConvId): boolean {
    return isDmConv(conv) || isGrpConv(conv)
  }

  private sectionFor(conv: ConvId): DmBeaconSection {
    const section = this.sealedSections.get(conv) ?? { heads: [], cursor: { read: '', ingested: '' } }
    this.sealedSections.set(conv, section)
    return section
  }

  noteOwnEvent(conv: ConvId, fileName: string): void {
    const type = parseEventFileName(fileName)?.type
    // 1.3: a type older readers cannot parse rides its own ring, plain or
    // sealed, so that a burst of votes cannot evict the `msg` heads those
    // readers do use (see HEADS_1_2_TYPES). Same trick as `grpHeads` below,
    // generalized — that one stays as it is, because a 1.2 peer already knows
    // to look in it for invites.
    const newType = !!type && !HEADS_1_2_TYPES.has(type)
    // Only DMs and private groups need a sealed section (who talks to whom, and
    // who is in which group, is private); channels and team convs advertise
    // heads in the plain section.
    if (this.isSealed(conv)) {
      const section = this.sectionFor(conv)
      if (newType) {
        const ring = section.heads2 ?? []
        ring.push(fileName)
        while (ring.length > HEADS2_RING) ring.shift()
        section.heads2 = ring
      }
      // A `grp` notice (invite, rekey, "you were removed") rides its own ring.
      // The DM peer on the other end may be a 1.1 client, and it *can* open this
      // section — it is their DM. A `.grp.e1` name there is a name it cannot
      // parse: harmless in itself (its `ingestHeads` skips it before the gap
      // check), but it would be occupying one of the 16 slots the DM's real
      // `msg` heads need, and a rekey storm would clear the lot. Their own ring,
      // their own budget; an unknown field costs that peer nothing.
      else if (type === 'grp') {
        const ring = section.grpHeads ?? []
        ring.push(fileName)
        while (ring.length > GRP_HEADS_RING) ring.shift()
        section.grpHeads = ring
      } else {
        section.heads.push(fileName)
        while (section.heads.length > BEACON.headsRingSize) section.heads.shift()
      }
    } else {
      const rings = newType ? this.heads2 : this.heads
      const limit = newType ? HEADS2_RING : BEACON.headsRingSize
      const ring = rings.get(conv) ?? []
      ring.push(fileName)
      while (ring.length > limit) ring.shift()
      rings.set(conv, ring)
    }
    void this.bump('event')
  }

  setCursor(conv: ConvId, cursor: Cursor): void {
    if (this.primeCursor(conv, cursor)) void this.bump('cursor')
  }

  /**
   * Record a cursor without publishing — restoring last launch's watermarks
   * before the startup beacon, so peers' receipts don't blink back to nothing.
   * Returns whether anything changed.
   */
  primeCursor(conv: ConvId, cursor: Cursor): boolean {
    const same = (a: Cursor | undefined): boolean =>
      !!a && a.read === cursor.read && a.ingested === cursor.ingested && a.readAt === cursor.readAt
    if (this.isSealed(conv)) {
      const section = this.sectionFor(conv)
      if (same(section.cursor)) return false
      section.cursor = cursor
    } else {
      if (same(this.cursors.get(conv))) return false
      this.cursors.set(conv, cursor)
    }
    return true
  }

  setTyping(conv: ConvId | null): void {
    const until = this.session.io.calibratedNow() + BEACON.typingTtlMs
    if (conv && this.isSealed(conv)) {
      this.sectionFor(conv).typingUntil = until
      void this.bump('typing')
      return
    }
    this.typing = conv ? { conv, until } : undefined
    void this.bump('typing')
  }

  setPresence(p: Partial<BeaconContent['presence']>): void {
    this.presence = { ...this.presence, ...p }
    // Appear-offline outranks always-online, including when it is chosen after
    // the screen is already locked: without this the keep-green heartbeat kept
    // beating on a device that had just said goodbye, so a paused, deliberately
    // invisible client went on writing to the share every 45 s forever.
    this.syncHeartbeat()
    void this.bump('presence')
  }

  noteDropHint(recipientDeviceId: string): void {
    this.drops = { ...this.drops, [recipientDeviceId]: this.session.io.calibratedNow() }
    void this.bump('event')
  }

  setXfer(blobId: string, progress: { done: number; total: number } | null): void {
    const x = { ...(this.xfers ?? {}) }
    if (progress) x[blobId] = progress
    else delete x[blobId]
    this.xfers = x
    void this.bump('cursor') // coalesced cadence is fine for progress
  }

  /**
   * Where one sealed section goes and what locks it: the DM pair key, or the
   * group's current epoch key (whose epoch travels in the kid, so a member
   * still catching up on a rotation knows which key to try).
   */
  private sealTarget(
    conv: ConvId,
  ): { bucket: 'dm' | 'grp'; token: string; key: Buffer; kid: string; aadScope: string } | null {
    const s = this.session
    if (isDmConv(conv)) {
      const token = conv.slice(3)
      const dm = s.dmsByToken.get(token)
      return dm ? { bucket: 'dm', token, key: dm.key, kid: KID.dm(token), aadScope: 'dmb' } : null
    }
    const token = s.groups?.token(conv)
    const info = token ? s.convInfo(conv) : null
    return token && info ? { bucket: 'grp', token, key: info.key, kid: info.kid, aadScope: 'grpb' } : null
  }

  /** Coalesced bump: events/typing go fast, cursors coalesce. */
  async bump(reason: 'startup' | 'heartbeat' | 'event' | 'typing' | 'cursor' | 'presence'): Promise<void> {
    this.dirty = true
    const now = Date.now()
    const minGap = reason === 'cursor' ? BEACON.cursorCoalesceMs : reason === 'typing' ? BEACON.typingBumpMinMs : 0
    const wait = Math.max(0, this.lastBumpAt + minGap - now)
    if (wait === 0) {
      await this.publishNow().catch(() => {})
    } else if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null
        void this.publishNow().catch(() => {})
      }, wait)
    }
  }

  /**
   * One publish at a time. Overlapping publishes can complete out of order on a
   * slow share, and then the older one's epilogue deletes the *newer* beacon and
   * leaves its own stale file as this device's latest — peers that already read
   * the newer seq skip the survivor, so heads and presence go stale until the
   * next bump. Queueing keeps seq order and the previous-name bookkeeping honest
   * (it also guarantees stop()'s goodbye lands last) for the price of one await.
   */
  private publishNow(): Promise<void> {
    const done = this.publishing.then(() => this.writeBeacon())
    this.publishing = done.catch(() => {})
    return done
  }

  private async writeBeacon(): Promise<void> {
    if (!this.dirty && this.lastPublishedName) {
      // Heartbeats still rewrite (freshness is the signal), so fall through.
    }
    this.dirty = false
    this.lastBumpAt = Date.now()
    const s = this.session
    this.seq += 1
    s.store.writeSecretJson('beacon-seq', this.seq)
    const name = beaconFileName(s.deviceId, this.seq)
    const seq36 = seqToBase36(this.seq)

    // Seal each private conversation's section under its own key: a DM under
    // the pair key, a group under its current epoch key. Everyone else reads a
    // token and a blob.
    const dmSealed: Record<string, string> = {}
    const grpSealed: Record<string, string> = {}
    for (const [conv, section] of this.sealedSections) {
      const target = this.sealTarget(conv)
      if (!target) continue // key gone (left the group, unknown peer) — say nothing
      const aad = buildAad(target.aadScope, `${target.token}/${s.deviceId8}`, seq36)
      const sealed = encryptRecord(target.key, target.kid, Buffer.from(JSON.stringify(section)), aad).toString('base64')
      if (target.bucket === 'dm') dmSealed[target.token] = sealed
      else grpSealed[target.token] = sealed
    }

    // Gil's always-online preference (1.5): forced at publish time rather than
    // stored into `this.presence`, so the truthful idleSec/tier state is never
    // lost underneath it — switching the setting back off just resumes
    // publishing whatever the tier already says. Appear-offline still wins:
    // `setPresence({ state: 'offline' })` is a deliberate choice to look
    // offline, and nothing about wanting to look online should undo that.
    const presence = this.publishedPresence

    const content: BeaconContent = {
      device: s.deviceId,
      name: s.displayName,
      seq: seq36,
      hlc: s.io.calibratedNow(),
      presence,
      typing: this.typing && this.typing.until > s.io.calibratedNow() ? this.typing : undefined,
      heads: Object.fromEntries(this.heads),
      // 1.3: heads of event types a 1.2 reader cannot parse. Absent unless we
      // actually wrote one, so a team that never uses polls publishes exactly
      // the beacon 1.2 published.
      heads2: this.heads2.size ? Object.fromEntries(this.heads2) : undefined,
      cursors: Object.fromEntries(this.cursors),
      dmSealed: Object.keys(dmSealed).length ? dmSealed : undefined,
      // 1.2: same shape, group keys. 1.1 readers ignore the field.
      grpSealed: Object.keys(grpSealed).length ? grpSealed : undefined,
      xfers: this.xfers && Object.keys(this.xfers).length ? this.xfers : undefined,
      drops: this.drops && Object.keys(this.drops).length ? this.drops : undefined,
      lanIps: this.lanIps.length ? this.lanIps : undefined,
      p2p: this.wsPort ? { caps: ['rtc-v1'], wsPort: this.wsPort } : undefined,
      // 1.2: peers on an older build raise their own update banner from this.
      // 1.1 readers parse the record and ignore the field (readOne does no
      // schema validation), so adding it is safe mid-rollout.
      app: this.getAppVersion() || undefined,
    }

    const signed = signRecord(s.identity, DST.record, content)
    const rel = `${DIR.beacon}/${name}`
    const aad = buildAad('pres', rel, s.deviceId8)
    // Calibration is a second round trip; it rides an occasional beacon rather
    // than every one of them.
    const calibrate = Date.now() - this.lastCalibrateAt >= CALIBRATE_EVERY_MS
    if (calibrate) this.lastCalibrateAt = Date.now()
    await s.io.publish(rel, encryptRecord(s.keys.kPres, KID.pres(s.proto.epoch), Buffer.from(JSON.stringify(signed)), aad), {
      calibrate,
    })
    const old = this.lastPublishedName
    this.lastPublishedName = name
    if (old && old !== name) await s.io.delete(`${DIR.beacon}/${old}`).catch(() => {})
  }
}

// ---------------------------------------------------------------------------

export interface BeaconObservation {
  deviceId8: string
  content: BeaconContent
  verified: boolean
  dmSections: Map<string, DmBeaconSection> // pairToken -> decrypted section (ours only)
  /** 1.2: grp dir token -> decrypted section, for groups we hold a key to. */
  grpSections?: Map<string, DmBeaconSection>
  observedAtMono: number
}

export class BeaconReader {
  private lastSeqs = new Map<string, number>() // id8 -> seq

  constructor(private session: Session) {}

  /** One poll tick: single readdir; reads only changed beacons. */
  async poll(): Promise<BeaconObservation[]> {
    const s = this.session
    const names = await s.io.list(DIR.beacon)
    const best = new Map<string, { seq: number; name: string }>()
    for (const n of names) {
      const p = parseBeaconFileName(n)
      if (!p) continue
      const cur = best.get(p.deviceId8)
      if (!cur || p.seq > cur.seq) best.set(p.deviceId8, { seq: p.seq, name: n })
    }

    const out: BeaconObservation[] = []
    for (const [id8, { seq, name }] of best) {
      if (id8 === s.deviceId8) continue
      if ((this.lastSeqs.get(id8) ?? -1) >= seq) continue
      const obs = await this.readOne(id8, name)
      if (obs) {
        this.lastSeqs.set(id8, seq)
        out.push(obs)
      }
    }
    return out
  }

  private async readOne(id8: string, name: string): Promise<BeaconObservation | null> {
    const s = this.session
    const rel = `${DIR.beacon}/${name}`
    const buf = await s.io.readMaybe(rel)
    if (!buf) return null
    try {
      const aad = buildAad('pres', rel, id8)
      const plain = decryptRecord(buf, s.keys.kPres, aad)
      const signed = JSON.parse(plain.toString('utf8')) as SignedRecord<BeaconContent>
      let author = s.roster.get(signed.by)
      if (!author) {
        author = (await s.roster.loadOne(signed.by)) ?? undefined
        if (author) s.refreshDms()
      }
      const verified = !!author && verifyRecord(signed, DST.record, author.edPubKey)
      if (!signed.by.startsWith(id8)) return null

      const dmSections = new Map<string, DmBeaconSection>()
      if (signed.p.dmSealed) {
        for (const [token, b64] of Object.entries(signed.p.dmSealed)) {
          const dm = s.dmsByToken.get(token)
          if (!dm) continue // not our pair — unreadable by design
          try {
            const sAad = buildAad('dmb', `${token}/${id8}`, signed.p.seq)
            const sec = JSON.parse(decryptRecord(Buffer.from(b64, 'base64'), dm.key, sAad).toString('utf8'))
            dmSections.set(token, sec as DmBeaconSection)
          } catch {
            // skip broken section
          }
        }
      }

      // Group sections (1.2): only groups we hold a key for open, and the
      // writer may be an epoch ahead of or behind us, so try every key we have.
      const grpSections = new Map<string, DmBeaconSection>()
      if (signed.p.grpSealed) {
        for (const [token, b64] of Object.entries(signed.p.grpSealed)) {
          const conv = s.groups?.convForToken(token)
          if (!conv) continue // not our group — unreadable by design
          // Holding a key is not the same as being in the group: a removed
          // member keeps every epoch key they were ever given, and their client
          // goes on sealing a section for a group it no longer belongs to. Its
          // heads would drag us back to their retired-key writes on every poll.
          // Membership is the fold's answer, not the key's.
          if (!s.groups?.isMember(conv, signed.by)) continue
          const sAad = buildAad('grpb', `${token}/${id8}`, signed.p.seq)
          for (const key of s.groups?.keys(conv) ?? []) {
            try {
              const sec = JSON.parse(decryptRecord(Buffer.from(b64, 'base64'), key, sAad).toString('utf8'))
              grpSections.set(token, sec as DmBeaconSection)
              break
            } catch {
              // wrong epoch (or a broken section) — try the next key
            }
          }
        }
      }

      return {
        deviceId8: id8,
        content: signed.p,
        verified,
        dmSections,
        grpSections: grpSections.size ? grpSections : undefined,
        observedAtMono: Date.now(),
      }
    } catch {
      return null
    }
  }
}
