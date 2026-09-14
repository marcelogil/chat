import { POLL, PRESENCE, TEAM_CONV } from '@shared/constants'
import type { BeaconContent, ConvId, DmBeaconSection, PresenceStateKind, PresenceView } from '@shared/types'
import { fingerprintFromEdPub } from '../crypto/identity'
import { isChanConv, isTeamConv, sanitizeHostname } from '@shared/ids'
import { sweepMsFor, tickMsFor, type IoTier } from '../services/ioTier'
import { BeaconReader, type BeaconObservation } from './beacon'
import type { EventStore } from './events'
import type { Session } from './session'
import { supersededDevices } from './supersede'

// Drives the whole read side: beacon polling, event ingestion via heads,
// channel discovery, presence derivation, typing, and remote cursors.

interface DeviceObservation {
  content: BeaconContent
  verified: boolean
}

export interface PollerEvents {
  onPresence?: (views: PresenceView[]) => void
  onTyping?: (conv: ConvId, deviceId: string, until: number) => void
  onCursors?: (conv: ConvId, deviceId: string, cursor: { read: string; ingested: string }) => void
  onDropHint?: (fromDeviceId: string) => void
  onXfers?: (deviceId: string, xfers: NonNullable<BeaconContent['xfers']>) => void
  onHealthChange?: (reachable: boolean) => void
  onNewDevice?: () => void
  /** A verified beacon named the Chat build behind it (1.2+ writers only). */
  onPeerVersion?: (version: string, name: string) => void
}

export class Poller {
  private reader: BeaconReader
  private observations = new Map<string, DeviceObservation>() // full deviceId
  private timer: NodeJS.Timeout | null = null
  private ticks = 0
  private polled = false // first beacon listing done: absence now means something
  private running = false
  private degraded = false
  listeners: PollerEvents = {}
  /** I/O tier (1.2) — drives both the tick and the blanket-sweep cadence. */
  private tier: IoTier = 'blurred'
  /**
   * Current tick period. Derived from the tier, never from POLL.defaultMs: a
   * client that launches unfocused never gets a setTier('blurred') (it is
   * already there and setTier early-returns), so a default of defaultMs meant
   * it polled at 1.5 s for the rest of its life.
   */
  intervalMs: number = tickMsFor(this.tier) ?? POLL.defaultMs
  /** Share clock of the last blanket sweep; 0 = sweep on the next tick. */
  private lastSweepAt = 0
  private kick: (() => void) | null = null
  /**
   * Which loop chain is allowed to reschedule. A tier speed-up starts a fresh
   * chain; any tick still in flight from the previous one carries an older id
   * and bows out instead of scheduling a second, parallel wake-up.
   */
  private chain = 0

  constructor(
    private session: Session,
    private events: EventStore,
  ) {
    this.reader = new BeaconReader(session)
  }

  start(): void {
    this.running = true
    this.intervalMs = tickMsFor(this.tier) ?? this.intervalMs
    // Sweep on the very first tick. ChatService.start() has just caught every
    // conversation up, but channel *discovery* lives inside the sweep, so
    // deferring it a whole period means a channel created while we were away
    // (or one whose first event nobody has beaconed) stays invisible for one
    // to ten minutes after launch.
    this.lastSweepAt = 0
    const loop = async (id: number): Promise<void> => {
      if (!this.running || this.isPaused() || id !== this.chain) return
      const t0 = Date.now()
      try {
        await this.tick()
      } catch {
        // tick errors surface through share health
      }
      // Re-checked after the await: a lock-screen during a slow tick must not
      // schedule one more wake-up, and neither must a tick whose chain was
      // superseded by a speed-up while it was in flight.
      if (!this.running || this.isPaused() || id !== this.chain) return
      const elapsed = Date.now() - t0
      this.timer = setTimeout(() => void loop(id), Math.max(200, this.intervalMs - elapsed))
    }
    this.kick = () => {
      const id = ++this.chain
      void loop(id)
    }
    this.kick()
  }

  stop(): void {
    this.running = false
    this.chain++ // any tick still in flight loses its claim to reschedule
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /**
   * Move to an I/O tier: `paused` (screen locked / machine suspended) stops the
   * loop dead, anything else sets the cadence and — when we are speeding up or
   * coming back from paused — ticks once right away so the window is never
   * showing a stale room for a whole idle interval.
   */
  setTier(tier: IoTier): void {
    const prev = this.tier
    if (tier === prev) return
    this.tier = tier
    const next = tickMsFor(tier)
    if (next === null) {
      // paused: the running loop returns on its own, but a scheduled wake-up
      // would still fire once — drop it.
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      return
    }
    const faster = next < this.intervalMs
    this.intervalMs = next
    if (!this.running) return
    if (prev === 'paused' || faster) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      this.kick?.()
    }
  }

  private isPaused(): boolean {
    return this.tier === 'paused'
  }

  /** Milliseconds between blanket catch-up sweeps at the current tier. */
  private sweepMs(): number | null {
    return sweepMsFor(this.tier)
  }

  async tick(): Promise<void> {
    const s = this.session
    this.ticks++

    // Degraded-mode detection & recovery
    if (this.degraded) {
      const back = await s.io.probe()
      if (!back) return
      this.degraded = false
      this.listeners.onHealthChange?.(true)
    }

    let observations: BeaconObservation[]
    try {
      observations = await this.reader.poll()
    } catch {
      if (!this.degraded) {
        this.degraded = true
        this.listeners.onHealthChange?.(false)
      }
      return
    }
    const firstPoll = !this.polled

    for (const obs of observations) {
      await this.processObservation(obs)
    }
    // Only now: processObservation pushes presence for every device it meets,
    // and until the whole listing is in, everyone not reached yet still looks
    // like they have no beacon at all — i.e. departed. Flip the guard after.
    this.polled = true

    // Channel discovery + a full catch-up sweep on a slower cadence (new
    // channels, day rollover, events from devices whose beacons we missed).
    // Wall-clock driven since 1.2, so the tick rate and the sweep rate are
    // independent: 1/3/10 minutes for focused/blurred/idle.
    const sweepMs = this.sweepMs()
    if (sweepMs !== null && Date.now() - this.lastSweepAt >= sweepMs) {
      this.lastSweepAt = Date.now()
      const before = s.channels.size
      await s.loadChannels()
      if (s.channels.size !== before) this.listeners.onNewDevice?.()
      // `fast` opens today's day directory by name instead of listing the day
      // directories first — half the readdirs per conversation, and it lapses
      // back to the full walk by itself at the day rollover (see catchUp).
      const sweep = { fast: true } as const
      for (const ch of s.activeChannels()) {
        await this.events.catchUp(s.convIdForChannel(ch.channelId), sweep)
      }
      for (const dm of s.dms.values()) {
        await this.events.catchUp(`dm:${dm.pairToken}`, sweep)
      }
      // Team logs (calendar, PR config) have no discovery step — their ids are
      // fixed, so the sweep just catches each one up.
      for (const conv of Object.values(TEAM_CONV)) {
        await this.events.catchUp(conv, sweep)
      }
      // Private groups (1.2): no discovery either — the invite brought the key,
      // and the sweep picks up anything the beacon heads missed.
      for (const conv of s.groups?.convs() ?? []) {
        await this.events.catchUp(conv, sweep)
      }
    }

    // Silence is a state change too (online → away → offline with nobody
    // else's beacon to prompt a refresh), so re-derive on a slow cadence.
    if (observations.length > 0 || firstPoll || this.ticks % 10 === 0) this.emitPresence()
  }

  private async processObservation(obs: BeaconObservation): Promise<void> {
    const s = this.session
    const deviceId = obs.content.device
    const known = this.observations.has(deviceId)
    this.observations.set(deviceId, { content: obs.content, verified: obs.verified })
    if (!known) this.listeners.onNewDevice?.()
    if (!obs.verified) return // unverified beacons never drive ingestion

    // A teammate on a newer build (1.2+). Unverified beacons are excluded on
    // purpose: an update banner must not be raisable by anyone who can write
    // to the share. The listener dedupes per version.
    if (obs.content.app) this.listeners.onPeerVersion?.(obs.content.app, obs.content.name)

    // Channel + team heads → ingest the exact new event files. Only channels
    // need a discovery refresh; team conv ids are fixed and always derivable.
    // `heads2` (1.3) carries the same thing for event types a 1.2 reader cannot
    // parse (`vot`, …) — a separate field so that a burst of votes cannot push
    // the `msg` names out of the 16-slot `heads` ring those readers still ingest
    // from (an unparseable name in there would be skipped, not mistaken for a
    // gap; losing the ring slot is the real cost). Here both rings mean the same
    // thing, so they go through one loop.
    const plainHeads = new Map<string, string[]>()
    for (const [conv, heads] of Object.entries(obs.content.heads ?? {})) plainHeads.set(conv, [...heads])
    for (const [conv, heads] of Object.entries(obs.content.heads2 ?? {})) {
      plainHeads.set(conv, [...(plainHeads.get(conv) ?? []), ...heads])
    }
    for (const [conv, heads] of plainHeads) {
      if (!isChanConv(conv) && !isTeamConv(conv)) continue
      if (isChanConv(conv) && !s.channels.get(conv.slice(5))) {
        // One targeted read of that channel's metadata — the token comes from
        // the conv id, so a head naming a channel nobody has loaded no longer
        // costs a listing of every channel directory on the share.
        const loaded = await s.ensureChannel(conv as ConvId)
        // And tell the shell: this is the discovery path for a channel created
        // while we were running, and the sweep below compares sizes *after*
        // this ran — so without a nudge here the new channel sat in the
        // session, fully loaded, without ever reaching the sidebar.
        if (loaded) this.listeners.onNewDevice?.()
      }
      // A tombstoned channel is closed: don't re-read a log on its way out.
      if (isChanConv(conv) && s.channels.get(conv.slice(5))?.deletedAt) continue
      await this.events.ingestHeads(conv as ConvId, heads)
    }
    // Channel cursors → delivery/read receipts
    for (const [conv, cursor] of Object.entries(obs.content.cursors ?? {})) {
      this.listeners.onCursors?.(conv as ConvId, deviceId, cursor)
    }
    // Sealed sections: DM pairs that involve us, plus private groups we hold a
    // key for (1.2) — same treatment, the reader already did the decrypting.
    const sealed: [ConvId, DmBeaconSection][] = [...obs.dmSections].map(([token, section]) => [
      `dm:${token}` as ConvId,
      section,
    ])
    for (const [token, section] of obs.grpSections ?? []) {
      const conv = s.groups?.convForToken(token)
      if (conv) sealed.push([conv, section])
    }
    for (const [conv, section] of sealed) {
      if (section.heads.length) await this.events.ingestHeads(conv, section.heads)
      // Private-group notices in a DM (1.2) travel in their own ring, out of
      // `heads`, so that they never take ring slots from the `msg` names a 1.1
      // peer reading the same section ingests. Same ingestion, one field over.
      if (section.grpHeads?.length) await this.events.ingestHeads(conv, section.grpHeads)
      // Post-1.2 types inside a sealed section (1.3) — a vote in a DM or a
      // private group. Same reason for the separate ring, same ingestion.
      if (section.heads2?.length) await this.events.ingestHeads(conv, section.heads2)
      this.listeners.onCursors?.(conv, deviceId, section.cursor)
      if (section.typingUntil && section.typingUntil > s.io.calibratedNow()) {
        this.listeners.onTyping?.(conv, deviceId, section.typingUntil)
      }
    }
    // Channel typing
    if (obs.content.typing && obs.content.typing.until > s.io.calibratedNow()) {
      this.listeners.onTyping?.(obs.content.typing.conv, deviceId, obs.content.typing.until)
    }
    // Drop hints addressed to us
    if (obs.content.drops?.[s.deviceId]) {
      this.listeners.onDropHint?.(deviceId)
    }
    if (obs.content.xfers) this.listeners.onXfers?.(deviceId, obs.content.xfers)
  }

  // -------------------------------------------------------------------------
  // Presence

  presenceViews(): PresenceView[] {
    const s = this.session
    const shareNow = s.io.calibratedNow()
    const all = s.roster.all()
    // Superseded registrations are computed over the WHOLE roster — this
    // device's own record included, even though it never gets a view of its
    // own. After "Reset local data" + re-join it is the local record that
    // supersedes the leftover one, so leaving it out is exactly how a person
    // ends up looking at two of themselves (1.4).
    // …and only once a beacon listing has been read: the rule's one veto (the
    // predecessor is still beaconing) can only be exercised after that, so
    // before it every device on the share looks dead. See `departed`.
    const superseded = !this.polled
      ? new Map<string, string>()
      : supersededDevices(
          all.map((e) => ({
            deviceId: e.record.deviceId,
            displayName: e.record.displayName,
            hostname: e.record.hostname,
            machineIdHash: e.record.machineIdHash,
            firstSeen: e.record.firstSeen,
            live: this.beaconLive(e.record.deviceId, shareNow),
          })),
        )
    const entries = all.filter((e) => e.record.deviceId !== s.deviceId)
    const views: PresenceView[] = []

    for (const entry of entries) {
      const deviceId = entry.record.deviceId
      const obs = this.observations.get(deviceId)
      let state: PresenceStateKind = 'offline'
      let lastSeenMs: number | null = null
      let status = ''
      if (obs) {
        // The beacon's own stamp, not when we noticed it: a device that quit
        // last week reads as "last week" even on a fresh launch.
        lastSeenMs = Math.min(obs.content.hlc, shareNow)
        status = obs.content.presence.status
        // Freshness comes from that same stamp, not from when this reader got
        // round to reading the file. Measuring from the observation made the
        // answer depend on our own tick rate (a 45–48 s idle heartbeat has only
        // 2 s of slack inside PRESENCE.onlineWithinMs, and an idle reader's poll
        // delay is 15 s), and it let a beacon written hours ago read as "online"
        // for a whole minute after a cold start or a resume from a locked screen.
        const age = Math.max(0, shareNow - lastSeenMs)
        if (obs.content.presence.state === 'offline') state = 'offline'
        else if (age < PRESENCE.onlineWithinMs) {
          state = obs.content.presence.idleSec >= PRESENCE.awayIdleSec ? 'away' : 'online'
        } else if (age < PRESENCE.offlineAfterMs) state = 'away'
        else state = 'offline'
      }
      // Departed devices stay in the list (flagged) so their old messages
      // keep a name and an unread DM from them still has a row to open.
      // Supersession is not gated on `state` (it carries its own, stricter
      // liveness test): a leftover registration whose goodbye beacon is two
      // minutes from going stale is still a person listed twice for those two
      // minutes, and nothing about it is coming back.
      const supersededBy = superseded.get(deviceId)
      const departed = this.departed(lastSeenMs, shareNow, supersededBy)
      // A superseded identity cannot come back — its keys are gone — so its
      // leftover beacon must not paint a green dot next to the one row that
      // still shows it (the DM that holds its history).
      if (supersededBy) state = 'offline'
      views.push({
        deviceId,
        name: obs?.content.name ?? entry.pin.displayName,
        hostname: sanitizeHostname(entry.record.hostname),
        fingerprint: fingerprintFromEdPub(entry.pin.edPub),
        state,
        status,
        lastSeenMs,
        trust: entry.pin.trust,
        dmConv: `dm:${s.dmFor(deviceId)?.pairToken ?? ''}`,
        // Same gate as onPeerVersion: a build number nobody signed for is not
        // evidence, and it is what the update banner reads.
        app: obs?.verified ? obs.content.app : undefined,
        departed,
        ...(supersededBy ? { supersededBy } : {}),
      })
    }
    return views
  }

  /**
   * Is somebody behind this device *right now*: a heartbeat fresher than
   * `onlineWithinMs` that doesn't say goodbye. Both sides of that comparison
   * are share-clock values, which is the whole point — it is the one question
   * `supersede.ts` needs answered and the one it must not ask itself, since a
   * record's `firstSeen` is written on its author's local clock.
   *
   * Deliberately stricter than `state !== 'offline'`: that tolerates two
   * minutes of silence, and this is the guard standing between a leftover
   * registration and being hidden.
   */
  private beaconLive(deviceId: string, shareNow: number): boolean {
    const obs = this.observations.get(deviceId)
    if (!obs || obs.content.presence.state === 'offline') return false
    return shareNow - Math.min(obs.content.hlc, shareNow) < PRESENCE.onlineWithinMs
  }

  /**
   * A registration nobody is behind any more: plainly superseded — the same
   * person on the same machine set up again, so this identity will never sign
   * anything again (`supersede.ts`) — or no beacon at all (the janitor swept
   * it, or the device never came back after a reset), or quiet for longer than
   * a long weekend. Only a hide: the roster entry stays, so its old messages
   * still verify and the row is back the moment the device is.
   *
   * Nothing is judged before the first beacon listing, supersession included.
   * A successor record on its own looks like evidence — but the rule that
   * reads it is only sound because a live predecessor can veto it, and that
   * veto is a beacon: until one listing has been read, `beaconLive` is false
   * for every device on the share. Answering early would take the two-live-
   * instances case (two dev profiles on one machine under one name) and call
   * the older one somebody's "(previous device)" on every client's very first
   * `presence:list` — the renderer issues one in `loadTeam`, before our first
   * tick lands. The cost of waiting is one poll (1 s focused) on the client
   * that just re-joined; the cost of not waiting is a wrong answer about a
   * device that is right there.
   */
  private departed(lastSeenMs: number | null, shareNow: number, supersededBy: string | undefined): boolean {
    if (!this.polled) return false // before the first listing, nothing here means anything yet
    if (supersededBy) return true
    if (lastSeenMs === null) return true
    return shareNow - lastSeenMs > PRESENCE.departedAfterMs
  }

  private emitPresence(): void {
    this.listeners.onPresence?.(this.presenceViews())
  }

  getObservation(deviceId: string): { content: BeaconContent; verified: boolean } | null {
    const o = this.observations.get(deviceId)
    return o ? { content: o.content, verified: o.verified } : null
  }
}
