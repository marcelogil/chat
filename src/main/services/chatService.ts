import { BrowserWindow, Notification } from 'electron'
import type {
  ChannelView,
  CursorView,
  DmView,
  PushMessage,
  SendDraft,
  SettingsView,
} from '@shared/bridge'
import type {
  Attachment,
  CalPayload,
  ConvId,
  Cursor,
  EventPayload,
  MsgBody,
  MsgPayload,
  PollBody,
  PresenceView,
  PrsPayload,
  SysPayload,
  VerifiedEvent,
  VotPayload,
} from '@shared/types'
import type { AttachDraft } from '@shared/bridge'
import { DIAGRAM, DIR, TEAM_CONV } from '@shared/constants'
import { diagramFallbackText, diagramFitsInline, diagramPreview } from '@shared/diagram'
import { materialize } from '@shared/merge'
import type { MessageView } from '@shared/merge'
import {
  calibrateClosesAt,
  checkChoice,
  isPollClosed,
  normalizePollBody,
  pollFallbackText,
  pollNotifySnippet,
  validatePollDraft,
} from '@shared/poll'
import { isChanConv, isDmConv, isGrpConv, isTeamConv, sanitizeHostname } from '@shared/ids'
import { shouldNotifyChat } from '@shared/notifyDecision'
import { EventStore } from '../transport/events'
import { BeaconWriter } from '../transport/beacon'
import { fingerprintFromEdPub } from '../crypto/identity'
import { Poller } from '../transport/poller'
import { selfPresenceView } from '../transport/selfPresence'
import type { IoTier } from './ioTier'
import type { Session } from '../transport/session'
import { boardLiveIsFresh, boardLiveNotifyLine } from './boards'
import { fixedChannelId, foldChannelSys, normalizeChannelName } from './channels'
import { GroupService } from './groups'
import { notifyLineFor } from './notifyLine'

// Orchestrates the live chat slice: event publishing with an offline outbox,
// beacon lifecycle, polling, cursors/read receipts, notifications.

/**
 * A publish that could not reach the share. Messages and team-log writes share
 * the queue: a share mounted later replays both in order.
 */
type OutboxItem =
  | { conv: ConvId; type: 'msg'; payload: MsgPayload }
  | { conv: `team:${string}`; type: 'cal' | 'prs'; payload: CalPayload | PrsPayload }

/** Newest event stem this device has read in a conversation, and when. */
interface ReadMark {
  stem: string
  at: number
}

const READS_SECRET = 'read-cursors'

export class ChatService {
  readonly events: EventStore
  readonly beacon: BeaconWriter
  readonly poller: Poller
  /** Private groups (1.2) — owns their keys, state and sys-event folding. */
  readonly groups: GroupService
  private remoteCursors = new Map<ConvId, Map<string, CursorView>>()
  private outbox: OutboxItem[] = []
  private push: (msg: PushMessage) => void
  /** Set by the drops service: a peer's beacon hinted at a new drop for us. */
  dropHintHandler: ((fromDeviceId: string) => void) | null = null
  /** Set by the blobs service: a peer's beacon carried upload progress. */
  xferHandler: ((deviceId: string, xfers: Record<string, { done: number; total: number }>) => void) | null = null
  /** Set by the blobs service: uploads local files, returns attachment refs. */
  attachmentUploader: ((items: AttachDraft[], conv: ConvId) => Promise<Attachment[]>) | null = null
  /** Set by the update service (1.2): a verified beacon named a newer build. */
  peerVersionHandler: ((version: string, name: string) => void) | null = null
  /** Current share-I/O tier (1.2); `diag:shareStats` reports it. */
  ioTier: IoTier = 'blurred'

  constructor(
    readonly session: Session,
    private getWindow: () => BrowserWindow | null,
    private getSettings: () => SettingsView,
    /** This build's version, for the beacon's `app` field. Injected for tests. */
    private getAppVersion: () => string = () => '',
  ) {
    this.events = new EventStore(session)
    this.beacon = new BeaconWriter(session, getAppVersion)
    this.poller = new Poller(session, this.events)
    // Registers itself as the session's `grp:` provider — construct it before
    // anything can try to read a group conversation.
    this.groups = new GroupService(session, this)
    this.outbox = session.store.readSecretJson<OutboxItem[]>('outbox') ?? []
    for (const [conv, r] of Object.entries(session.store.readSecretJson<Record<string, ReadMark>>(READS_SECRET) ?? {})) {
      this.readCursors.set(conv as ConvId, r)
    }
    this.push = () => {}
  }

  setPush(push: (msg: PushMessage) => void): void {
    this.push = push
  }

  /**
   * This device's own presence row (1.4). The poller's list is everyone else
   * by construction, so the footer had nothing to show: the status you set was
   * live on the share and invisible at home. Built from the live beacon, so it
   * is true the instant setStatus/setAppearState returns.
   */
  selfPresence(): PresenceView {
    const s = this.session
    const entry = s.roster.all().find((e) => e.record.deviceId === s.deviceId)
    return selfPresenceView({
      deviceId: s.deviceId,
      name: s.displayName,
      hostname: sanitizeHostname(entry?.record.hostname ?? ''),
      fingerprint: entry ? fingerprintFromEdPub(entry.pin.edPub) : s.identity.fingerprint,
      presence: this.beacon.presence,
      nowMs: s.io.calibratedNow(),
      app: this.getAppVersion(),
    })
  }

  /** Change this device's beacon presence and tell the renderer at once. */
  setOwnPresence(p: Partial<{ state: 'online' | 'offline'; status: string; idleSec: number }>): void {
    this.beacon.setPresence(p)
    this.pushSelfPresence()
  }

  pushSelfPresence(): void {
    this.push({ kind: 'self-presence', view: this.selfPresence() })
  }

  async start(): Promise<void> {
    const s = this.session

    this.events.onEvent((conv, event) => {
      this.push({ kind: 'event', conv, event })
      // Channel rename/delete and every group sys event fold into local state
      // before the renderer hears about them, so the `channels`/`groups` push
      // that follows is already the new truth.
      this.foldSys(conv, event)
      if (event.author !== s.deviceId) {
        // Team logs carry no read receipts — nobody "reads" a calendar.
        if (!isTeamConv(conv)) this.beacon.setCursor(conv, this.ownCursor(conv))
        this.maybeNotify(conv, event)
      }
    })

    // The other on-demand-load path (poller.ts's head discovery already nudges
    // via onNewDevice below): a publish into a channel this session only knew
    // by id loads it just-in-time, and the sidebar needs its name the moment
    // that happens, not on the next unrelated push.
    this.events.onChannelDiscovered(() => void this.pushChannels())

    this.poller.listeners = {
      onPresence: (views: PresenceView[]) => {
        this.push({ kind: 'presence', views })
        // Our own row rides the same beat (no share I/O — it is read off the
        // local beacon): the footer dot follows the idle tier like everyone
        // else's, instead of freezing at whatever it was on launch.
        this.pushSelfPresence()
      },
      onTyping: (conv, deviceId, until) => this.push({ kind: 'typing', conv, deviceId, until }),
      onCursors: (conv, deviceId, cursor) => {
        let m = this.remoteCursors.get(conv)
        if (!m) this.remoteCursors.set(conv, (m = new Map()))
        m.set(deviceId, cursor)
        this.push({ kind: 'cursors', conv, deviceId, cursor })
      },
      onHealthChange: (reachable) => {
        // offsetMs (1.3): the renderer decides "is this poll closed" on the
        // share clock, which only main knows. Rides the health push because
        // that is the one thing already telling the renderer about the folder.
        const offsetMs = s.io.getClockOffsetMs()
        this.push({
          kind: 'health',
          health: { reachable, latencyMs: s.io.getHealth().latencyMs, ...(offsetMs === null ? {} : { offsetMs }) },
        })
        if (reachable) void this.flushOutbox()
      },
      onNewDevice: () => {
        s.refreshDms()
        this.push({ kind: 'presence', views: this.poller.presenceViews() })
        void this.pushChannels()
      },
      onDropHint: (from) => this.dropHintHandler?.(from),
      onXfers: (deviceId, xfers) => this.xferHandler?.(deviceId, xfers),
      onPeerVersion: (version, name) => this.peerVersionHandler?.(version, name),
    }

    await s.roster.refresh()
    s.refreshDms()
    await s.loadChannels()
    if (s.channels.size === 0) {
      // The team's home channel: flagged at creation so every 1.2 client
      // agrees on which one can never be renamed or deleted.
      await s.createChannel('general', 'Team-wide chat', { fixed: true }).catch(() => {})
    }
    // Channels first: a `channel-deleted` folded here closes the conversation,
    // so the catch-up below skips what the tombstone already retired.
    for (const ch of [...s.channels.values()]) {
      await this.events.catchUp(s.convIdForChannel(ch.channelId))
    }
    for (const dm of s.dms.values()) {
      await this.events.catchUp(`dm:${dm.pairToken}`)
    }
    // Team logs (calendar, PR config): fixed ids, no discovery, no receipts.
    for (const conv of Object.values(TEAM_CONV)) {
      await this.events.catchUp(conv)
    }
    // Private groups: keys come from the DM logs just caught up, so any invite
    // that arrived while this device was off has already been adopted.
    await this.groups.settle()
    await this.groups.catchUpAll()
    // Last launch's watermarks go into the very first beacon; without them
    // every peer's "Read"/"Delivered" would blink back to nothing.
    for (const ch of s.activeChannels()) this.primeCursor(s.convIdForChannel(ch.channelId))
    for (const dm of s.dms.values()) this.primeCursor(`dm:${dm.pairToken}`)
    for (const conv of this.groups.convs()) this.primeCursor(conv)

    this.beacon.start()
    this.poller.start()
    await this.pushChannels()
    this.pushGroups()
    this.push({ kind: 'presence', views: this.poller.presenceViews() })
    // Carries the status restored from settings into the footer on the first
    // paint — the renderer also pulls it in loadTeam(), for the launch where
    // this push lands before the window is listening.
    this.pushSelfPresence()

    // A backlog left by a previous run. The poller only calls onHealthChange
    // on a degraded→reachable edge, which never happens when the share is
    // reachable at launch, so nothing else would ever replay these.
    if (this.outbox.length > 0) {
      this.push({ kind: 'outbox', queued: this.outbox.length })
      void this.flushOutbox()
    }
  }

  async stop(): Promise<void> {
    this.poller.stop()
    await this.beacon.stop(true)
  }

  // -------------------------------------------------------------------------

  channelViews(): ChannelView[] {
    // Deleted channels are omitted everywhere: the tombstone is the truth, and
    // the janitor removes the directory once the grace period passes.
    const alive = this.session.activeChannels()
    const fixed = fixedChannelId(alive)
    return alive.map((ch) => ({
      conv: `chan:${ch.channelId}` as ConvId,
      channelId: ch.channelId,
      name: ch.name,
      topic: ch.meta.topic,
      fixed: ch.channelId === fixed,
    }))
  }

  private async pushChannels(): Promise<void> {
    this.push({ kind: 'channels', channels: this.channelViews() })
  }

  pushGroups(): void {
    this.push({ kind: 'groups', groups: this.groups.views() })
  }

  /** Ring a file we just wrote into the beacon (GroupHost). */
  noteOwnEvent(conv: ConvId, fileName: string): void {
    this.beacon.noteOwnEvent(conv, fileName)
  }

  async createChannel(name: string, topic = ''): Promise<ChannelView> {
    const ch = await this.session.createChannel(name, topic)
    await this.pushChannels()
    const view = this.channelViews().find((v) => v.channelId === ch.channelId)
    return view ?? { conv: `chan:${ch.channelId}`, channelId: ch.channelId, name: ch.name, topic: ch.meta.topic, fixed: false }
  }

  /**
   * Rename a channel for the whole team (1.2). Any member may do it; the home
   * channel may not be renamed at all. The name is normalized exactly as the
   * create field normalizes it, so a rename can never produce a name that
   * creation would have refused.
   */
  async renameChannel(conv: ConvId, name: string): Promise<void> {
    const ch = this.requireChannel(conv)
    const clean = normalizeChannelName(name)
    if (!clean) throw new Error('invalid-name')
    if (clean === ch.name) return
    await this.publishChannelSys(conv, 'channel-renamed', { name: clean })
  }

  /** Tombstone a channel for the whole team (1.2). Never the home channel. */
  async deleteChannel(conv: ConvId): Promise<void> {
    this.requireChannel(conv)
    await this.publishChannelSys(conv, 'channel-deleted', {})
  }

  private requireChannel(conv: ConvId): { channelId: string; name: string } {
    if (!isChanConv(conv)) throw new Error('not-a-channel')
    const ch = this.session.channels.get(conv.slice(5))
    if (!ch || ch.deletedAt) throw new Error('unknown-channel')
    if (fixedChannelId(this.session.activeChannels()) === ch.channelId) throw new Error('fixed-channel')
    return ch
  }

  private async publishChannelSys(conv: ConvId, kind: 'channel-renamed' | 'channel-deleted', data: Record<string, unknown>): Promise<void> {
    const ev = await this.events.publish(conv, 'sys', { t: 'sys', conv, kind, data })
    this.beacon.noteOwnEvent(conv, `${ev.id}.sys.e1`)
    // The fold ran inside publish (via the event listener); this is the push
    // that lands the new name — or the disappearance — in the sidebar.
    await this.pushChannels()
  }

  /**
   * Fold a `sys` event into channel or group state. Channel state is folded
   * here; group state (including the DM-borne invites and rekeys) belongs to
   * GroupService, which pushes for itself.
   */
  private foldSys(conv: ConvId, event: VerifiedEvent): void {
    if (event.type !== 'sys' && event.type !== 'grp') return
    if (isChanConv(conv)) {
      if (event.type !== 'sys') return
      const ch = this.session.channels.get(conv.slice(5))
      if (!ch) return
      // `foldChannelSys` refuses a tombstone for a channel flagged `fixed`;
      // this is the same refusal for a team created before the flag existed,
      // where the home channel is whatever the fold computes (oldest, lowest
      // id). Both clients agree on that answer, so both ignore the event.
      if (
        (event.payload as SysPayload).kind === 'channel-deleted' &&
        fixedChannelId(this.session.activeChannels()) === ch.channelId
      ) {
        return
      }
      if (!foldChannelSys(ch, event)) return
      // A channel that just folded to deleted must not keep a local copy of
      // its log around: it would resurrect the conversation on the next read.
      if (ch.deletedAt) this.events.forget(conv)
      void this.pushChannels()
      return
    }
    this.groups.onEvent(conv, event)
  }

  /**
   * Conversation directories whose tombstone has aged out — handed to the
   * janitor, which does the deleting (one writer, idempotent).
   */
  deletedConvDirs(): { rel: string; deletedAt: number }[] {
    const out = [...this.session.channels.values()]
      .filter((c) => c.deletedAt)
      .map((c) => ({ rel: `${DIR.channels}/${c.token}`, deletedAt: c.deletedAt! }))
    return [...out, ...this.groups.deletedDirs()]
  }

  dmFor(peerDeviceId: string): DmView | null {
    const dm = this.session.dmFor(peerDeviceId)
    return dm ? { conv: `dm:${dm.pairToken}`, peerDeviceId } : null
  }

  getEvents(conv: ConvId): VerifiedEvent[] {
    return this.events.getEvents(conv)
  }

  cursors(conv: ConvId): Record<string, CursorView> {
    return Object.fromEntries(this.remoteCursors.get(conv) ?? [])
  }

  // -------------------------------------------------------------------------

  async send(conv: ConvId, draft: SendDraft): Promise<{ id: string }> {
    const s = this.session
    // A diagram's scene either rides inside the event (small, 180-day life) or
    // goes to the blob store as a `.excalidraw` attachment (7-day life). The
    // renderer has already made that call — it is the only side that knows the
    // compressed size — so all that is left here is to hold it to the limits
    // and write the pre-1.2 fallback line.
    const diagram = draft.kind === 'diagram' ? draft.diagram : undefined
    if (draft.kind === 'diagram' && !diagram) throw new Error('diagram-missing')
    if (diagram?.data) {
      if (diagram.data.length > DIAGRAM.maxInlineBytes) throw new Error('diagram-too-large')
      if (!diagramFitsInline(diagram.data.length, diagram.thumb?.length ?? 0)) {
        throw new Error('diagram-too-large')
      }
    }

    // A poll (1.3). The renderer's dialog validates too, but renderer input is
    // untrusted: the limits, the option ids and the deadline are all settled
    // here, on the one clock every reader compares against.
    let poll: PollBody | undefined
    if (draft.kind === 'poll') {
      const problem = validatePollDraft(draft.poll)
      if (problem) throw new Error(problem)
      poll = normalizePollBody(draft.poll!)
      poll.closesAt = calibrateClosesAt(poll.closesAt, Date.now(), s.io.calibratedNow())
      if (poll.closesAt === undefined) delete poll.closesAt
      // Closing is the author's own `edt`; a draft never arrives closed.
      delete poll.closedAt
    }

    let attachments: Attachment[] | undefined
    if (draft.attachments?.length) {
      if (!this.attachmentUploader) throw new Error('files-not-ready')
      attachments = await this.attachmentUploader(draft.attachments, conv)
    }
    const payload: MsgPayload = {
      t: 'msg',
      conv,
      author: { device: s.deviceId, name: s.displayName },
      senderSeq: s.nextSenderSeq(conv),
      sentWall: Date.now(),
      body: {
        kind: draft.kind,
        // `draft.text` is the diagram's title; the body text is what a 1.1.x
        // client prints in its place, so it has to name the diagram itself.
        // A poll works the same way one version on: pre-1.3 clients cannot vote
        // (their filename regex drops the `.vot.e1` files), so the line says so.
        text: diagram ? diagramFallbackText(draft.text) : poll ? pollFallbackText(poll.question) : draft.text,
        lang: draft.lang,
        packId: draft.packId,
        entities: draft.entities,
        diagram,
        poll,
      },
      replyTo: draft.replyTo,
      attachments,
      linkPreview: draft.linkPreview,
    }
    const ev = await this.publishWithOutbox({ conv, type: 'msg', payload })
    // A queued message has no id yet: the composer turns this rejection into
    // its "queued — will send when the folder is back" chip.
    if (!ev) throw new Error('queued')
    return { id: ev.id }
  }

  /**
   * Append to a team log ('team:calendar', 'team:prs'). Same outbox/degraded
   * handling as a message, so an entry added while the share is unreachable
   * still lands once it comes back — and, unlike a message, that queueing
   * resolves rather than rejects: a caller told "could not save" retries, and
   * a retried *new* entry carries a fresh id, so the team ends up with one
   * duplicate per press instead of one LWW entry.
   */
  async publishTeam(
    conv: `team:${string}`,
    type: 'cal' | 'prs',
    payload: CalPayload | PrsPayload,
  ): Promise<{ queued: boolean }> {
    const ev = await this.publishWithOutbox({ conv, type, payload })
    return { queued: ev === null }
  }

  /**
   * Publish, or hand the item to the outbox. Returns the published event, or
   * `null` when the share was unreachable and the item is queued for remount.
   * Throws only when the item could not even be queued.
   */
  private async publishWithOutbox(item: OutboxItem): Promise<VerifiedEvent | null> {
    try {
      const ev = await this.events.publish(item.conv, item.type, item.payload)
      this.beacon.noteOwnEvent(item.conv, `${ev.id}.${item.type}.e1`)
      return ev
    } catch (err) {
      // A conversation that no longer exists (a deleted channel, a group we
      // left) is not a share outage: queueing it would retry forever and hold
      // up everything behind it. Fail the call instead.
      if (err instanceof Error && err.message.startsWith('unknown conversation')) throw err
      this.outbox.push(item)
      try {
        this.session.store.writeSecretJson('outbox', this.outbox)
      } catch {
        // The queue itself is broken — this write really is lost.
        this.outbox.pop()
        throw err
      }
      this.push({ kind: 'outbox', queued: this.outbox.length })
      this.push({ kind: 'health', health: { reachable: false, latencyMs: null } })
      return null
    }
  }

  private async flushOutbox(): Promise<void> {
    const queued = this.outbox
    this.outbox = []
    for (const item of queued) {
      try {
        // Fresh HLC stamp on flush; original sentWall preserved for display.
        const ev = await this.events.publish(item.conv, item.type, item.payload)
        this.beacon.noteOwnEvent(item.conv, `${ev.id}.${item.type}.e1`)
      } catch {
        this.outbox.push(item)
      }
    }
    this.session.store.writeSecretJson('outbox', this.outbox)
    this.push({ kind: 'outbox', queued: this.outbox.length })
  }

  async mutate(conv: ConvId, type: 'edt' | 'del' | 'rct' | 'pin', payload: EventPayload): Promise<void> {
    const ev = await this.events.publish(conv, type, payload)
    this.beacon.noteOwnEvent(conv, `${ev.id}.${type}.e1`)
  }

  // -------------------------------------------------------------------------
  // Polls (1.3)

  /**
   * The poll as it stands *now* — materialized, so the author's closing `edt`
   * counts. Reading the `msg` event alone would let a vote land in a poll that
   * was closed an hour ago.
   */
  private pollMessage(conv: ConvId, target: string): MessageView & { body: { poll: PollBody } } {
    const m = materialize(this.events.getEvents(conv)).messages.find((x) => x.id === target)
    if (!m || m.deleted) throw new Error('unknown-poll')
    if (m.body.kind !== 'poll' || !m.body.poll) throw new Error('not-a-poll')
    return m as MessageView & { body: { poll: PollBody } }
  }

  /**
   * Vote, change a vote, or take it back (`[]`). One `vot` event per press:
   * the latest one this device wrote wins everywhere, so there is nothing to
   * delete and nothing that can half-apply.
   */
  async vote(conv: ConvId, target: string, choice: string[]): Promise<void> {
    const poll = this.pollMessage(conv, target).body.poll
    if (isPollClosed(poll, this.session.io.calibratedNow())) throw new Error('poll-closed')
    const checked = checkChoice(poll, choice)
    if ('error' in checked) throw new Error(checked.error)
    const payload: VotPayload = { t: 'vot', conv, target, choice: checked.choice }
    const ev = await this.events.publish(conv, 'vot', payload)
    // Into `heads2`, never `heads` — votes are the one event type that arrives
    // in a burst, and `heads` is a 16-name ring every older reader still ingests
    // its `msg` names from (see beacon.ts: an unparseable name costs them
    // nothing, an evicted `msg` head costs them the cheap path).
    this.beacon.noteOwnEvent(conv, `${ev.id}.vot.e1`)
  }

  /**
   * Close a poll for everyone: the author republishes the body with `closedAt`
   * through the ordinary edit path, so every reader — including one that was
   * offline for it — gets the closed poll by the rules it already has (an `edt`
   * only counts from the message's own author).
   */
  async closePoll(conv: ConvId, target: string): Promise<void> {
    const m = this.pollMessage(conv, target)
    if (m.authorDevice !== this.session.deviceId) throw new Error('not-poll-author')
    if (m.body.poll.closedAt) return // already closed — idempotent
    const body: MsgBody = { ...m.body, poll: { ...m.body.poll, closedAt: this.session.io.calibratedNow() } }
    await this.mutate(conv, 'edt', { t: 'edt', conv, target, body })
  }

  // -------------------------------------------------------------------------

  // Own read watermarks, persisted: they drive peers' receipts and this
  // device's unread badges, neither of which should reset on relaunch.
  private readCursors = new Map<ConvId, ReadMark>()

  private ownCursor(conv: ConvId): Cursor {
    const mark = this.readCursors.get(conv)
    const ingested = this.events.newestStem(conv) ?? mark?.stem ?? ''
    return mark ? { read: mark.stem, ingested, readAt: mark.at } : { read: '', ingested }
  }

  private primeCursor(conv: ConvId): void {
    const cur = this.ownCursor(conv)
    if (cur.read || cur.ingested) this.beacon.primeCursor(conv, cur)
  }

  myReads(): Record<ConvId, string> {
    const out: Record<string, string> = {}
    for (const [conv, mark] of this.readCursors) out[conv] = mark.stem
    return out
  }

  markRead(conv: ConvId, stem: string): void {
    if (isTeamConv(conv)) return // team logs have no unread state and no receipts
    const prev = this.readCursors.get(conv)?.stem ?? ''
    if (stem <= prev) return
    this.readCursors.set(conv, { stem, at: this.session.io.calibratedNow() })
    this.session.store.writeSecretJson(READS_SECRET, Object.fromEntries(this.readCursors))
    this.beacon.setCursor(conv, this.ownCursor(conv))
  }

  setTyping(conv: ConvId | null): void {
    this.beacon.setTyping(conv)
  }

  // -------------------------------------------------------------------------

  private maybeNotify(conv: ConvId, event: VerifiedEvent): void {
    // Calendar edits never toast; PR alerts are the PR service's job.
    if (isTeamConv(conv)) return
    // Live boards (1.3) are the one sys event worth a toast: a session can only
    // be joined while it is running, so it cannot wait to be scrolled past.
    if (event.type === 'sys') return this.maybeNotifyBoardLive(conv, event)
    if (event.type !== 'msg' || !event.verified) return
    const win = this.getWindow()
    if (win?.isFocused()) return // in-app treatment only
    const settings = this.getSettings()
    const p = event.payload as MsgPayload
    // A private group is a conversation you were personally invited into, so
    // it notifies like a DM rather than obeying the channel preference.
    const isGrp = isGrpConv(conv)
    const isDm = isDmConv(conv) || isGrp
    const mentioned = (p.body.entities ?? []).some(
      (e) => e.type === 'mention' && (e.special === 'here' || e.device === this.session.deviceId),
    )
    // Who may interrupt (1.4): the channel preference, the DM/private-group
    // switch and "pause everything" all live in one pure decision, shared with
    // the PR service and the renderer's alert card. `isGrp` is decided there
    // too — a private group follows the DM switch, not the channel one.
    if (
      !shouldNotifyChat({
        kind: isGrp ? 'grp' : isDmConv(conv) ? 'dm' : 'chan',
        mentioned,
        settings,
        now: Date.now(),
      })
    ) {
      return
    }
    if (!Notification.isSupported()) return

    const entry = this.session.roster.get(event.author)
    const who = entry ? `${p.author.name}` : 'Someone'
    const chName = !isDm ? this.session.channels.get(conv.slice(5))?.name : null
    const grpName = isGrp ? (this.groups.nameOf(conv) ?? 'private group') : null
    // The wording matrix (three conversation kinds x previews on/off) is a pure
    // function and lives in notifyLine.ts, where it is unit-tested; what stays
    // here is everything that needs this service — who, which conversation, and
    // the one-line preview of the body.
    const { title, body } = notifyLineFor({
      kind: isGrp ? 'grp' : isDmConv(conv) ? 'dm' : 'chan',
      who,
      convName: isGrp ? grpName : chName,
      previews: settings.notifyPreviews,
      // A diagram's `body.text` is the sentence written FOR 1.1 clients
      // ("…— update Chat to view it"); showing that to a 1.2 user tells them to
      // update the app they are already running. Name the diagram instead.
      snippet:
        p.body.kind === 'gif'
          ? 'sent a GIF'
          : p.body.kind === 'diagram'
            ? diagramPreview(p.body.text)
            : // 1.3: "Ana in #general" / "started a poll: Ship on Friday?" —
              // same reason as the diagram line, one version on.
              p.body.kind === 'poll'
              ? pollNotifySnippet(p.body)
              : p.body.text.slice(0, 140),
    })
    const n = new Notification({ title, body, silent: false })
    n.on('click', () => {
      win?.show()
      win?.focus()
      this.push({ kind: 'typing', conv, deviceId: '', until: 0 }) // no-op nudge; renderer routes via focus event
    })
    n.show()
  }

  /**
   * "Ana opened a live board: Sprint plan" (1.3). A board is an invitation
   * rather than a mention, so the "mentions only" channel setting keeps quiet
   * instead of guessing; DMs and private groups toast like a message, which
   * from 1.4 means they follow the direct-message switch.
   * The wording itself is pure and unit-tested in boards.ts.
   */
  private maybeNotifyBoardLive(conv: ConvId, event: VerifiedEvent): void {
    const p = event.payload as SysPayload
    if (p.kind !== 'board-live' || !event.verified) return
    if (event.author === this.session.deviceId) return // our own session
    // Only a session that could still be running: a board is an invitation to
    // join something live, and catching up a log that was not read since Friday
    // (or a conversation opened for the first time) must not toast sessions the
    // janitor swept days ago. `RETENTION.boardsDeadMinutes` is exactly how long
    // a board outlives its last frame, so it is the window for the toast too.
    if (!boardLiveIsFresh(Number(p.data.startedAt), this.session.io.calibratedNow())) return
    const win = this.getWindow()
    if (win?.isFocused()) return // in-app treatment only
    const settings = this.getSettings()
    const isGrp = isGrpConv(conv)
    // A board is an invitation rather than a mention, so it passes `mentioned:
    // false` — "mentions only" keeps quiet, exactly as it did before 1.4 — and
    // picks up the DM switch and the pause for free.
    if (
      !shouldNotifyChat({
        kind: isGrp ? 'grp' : isDmConv(conv) ? 'dm' : 'chan',
        mentioned: false,
        settings,
        now: Date.now(),
      })
    ) {
      return
    }
    if (!Notification.isSupported()) return
    const who = this.session.roster.get(event.author)?.record.displayName ?? 'Someone'
    const where = isGrp
      ? `🔒 ${this.groups.nameOf(conv) ?? 'private group'}`
      : isDmConv(conv)
        ? 'Direct message'
        : `#${this.session.channels.get(conv.slice(5))?.name ?? 'channel'}`
    const line = boardLiveNotifyLine({
      who,
      where,
      title: typeof p.data.title === 'string' ? p.data.title : '',
      previews: settings.notifyPreviews,
    })
    const n = new Notification({ title: line.title, body: line.body, silent: false })
    n.on('click', () => {
      win?.show()
      win?.focus()
    })
    n.show()
  }

  /**
   * Move the whole read side to an I/O tier (1.2). The poller changes cadence
   * (and stops dead when paused), the beacon changes heartbeat and starts
   * telling peers the truth about idleness, and coming back from paused/idle
   * costs one immediate beacon so nobody sees a ghost.
   */
  setIoTier(tier: IoTier, idleSec = 0): void {
    this.ioTier = tier
    // Both of these publish/tick once on a real tier change and do nothing on a
    // repeat — coming back from a locked screen must not cost two beacons.
    this.poller.setTier(tier)
    this.beacon.setTier(tier, idleSec)
  }
}
