// Wire types for everything that crosses the shared folder or the IPC bridge.
// All timestamps are share-calibrated milliseconds unless suffixed Wall.

// ---------------------------------------------------------------------------
// Identity

export interface DeviceRecord {
  type: 'device-record'
  v: 1
  deviceId: string // 32 hex chars = SHA-256(edPub)[0..16]
  edPub: string // base64url raw 32 bytes
  xPub: string // base64url raw 32 bytes
  displayName: string
  hostname: string
  osUser: string
  platform: 'darwin' | 'win32' | 'linux'
  machineIdHash: string | null // SHA-256("smbchat-mid"||machineGuid) hex, null when unavailable
  firstSeen: number
  recSeq: number // monotonic; readers reject regressions
}

export interface Revocation {
  type: 'revocation'
  target: string // deviceId being revoked
  reason: string
  at: number
}

/** Local TOFU pin state for a device. */
export type TrustState = 'pinned' | 'trusted' | 'flagged' | 'revoked'

export interface DevicePin {
  deviceId: string
  edPub: string
  xPub: string
  displayName: string
  hostname: string
  firstSeen: number
  trust: TrustState
}

// ---------------------------------------------------------------------------
// Events (one file per event; filename stem is the event id)

// 'grp' (1.2) carries the private-group notices that travel in a DM log —
// invite, rekey, "you were removed". They are deliberately NOT 'sys': a 1.1
// client has no default in `sysLine()`, so a sys row it doesn't know renders as
// a blank line in the DM timeline. A `.grp.e1` filename doesn't parse on 1.1 at
// all, so the file is ignored in silence — the same trick 'cal'/'prs' use.
export type EventType = 'msg' | 'edt' | 'del' | 'rct' | 'pin' | 'sys' | 'prv' | 'cal' | 'prs' | 'grp' | 'vot'

export interface EventId {
  hlcMs: number
  ctr: number
  deviceId8: string
  stem: string // "<13>-<4>-<8>"
}

// dm:<pairToken>; team:<fixed name> — team convs are app-defined logs
// (see TEAM_CONV) that live under DIR.team and are never day-swept.
// grp:<groupId> (1.2) — a private group: a random key sealed to each member
// (delivered as a `group-invite` sys event in the owner↔member DM log), dir
// token = HMAC(epoch-1 key, 'grp-dirtoken') so non-members can't even find it.
export type ConvId = `chan:${string}` | `dm:${string}` | `team:${string}` | `grp:${string}`

export type BodyEntity =
  | { type: 'code'; lang: string | null; start: number; end: number }
  | { type: 'mention'; device?: string; special?: 'here'; start: number; end: number }
  | { type: 'link'; url: string; start: number; end: number }

export interface Attachment {
  blobId: string // 32 hex
  key: string // base64 32-byte blobKey
  name: string
  size: number
  mime: string
  sha256: string // hex of plaintext
  w?: number
  h?: number
  durMs?: number
  thumb?: string // data: URI, <= EVENT.maxThumbBytes
}

export interface LinkPreview {
  url: string
  title?: string
  desc?: string
  img?: string // data: URI WebP
  domain: string
  failed?: boolean // fetch attempted and blocked — render honest degraded card
  /** Why it failed (absent on pre-1.0.2 senders: treat as 'network'). */
  reason?: 'network' | 'http' | 'nometa'
}

/**
 * A whiteboard/diagram message (1.2). The scene ships inline when small
 * (deflate-raw + base64 of the .excalidraw JSON, ≤ DIAGRAM.maxInlineBytes
 * compressed — it then lives as long as messages do, 180 days) and as a
 * `.excalidraw` blob attachment otherwise (7-day media retention). `thumb` is
 * the instant WebP preview; the crisp SVG is rendered locally from `data`.
 */
export interface DiagramBody {
  fmt: 'excalidraw'
  /** Compressed scene; absent when the scene is the blob attachment instead. */
  data?: string
  /** Scene bounding box in px, for tile layout before any decode. */
  w: number
  h: number
  /** Inline WebP preview (data: URI), ≤ EVENT.maxThumbBytes. */
  thumb?: string
  /** Element count, for the tile caption ("Diagram · 14 shapes"). */
  elements: number
}

/**
 * A poll (1.3). Votes are `vot` events targeting the poll message (LWW per
 * voter, empty choice = retract). The author closes it with an `edt` carrying
 * `closedAt`; readers also treat `closesAt <= now` as closed. `anonymous`
 * hides names in the UI only — every vote is still a signed event on the share.
 */
export interface PollBody {
  question: string
  options: { id: string; text: string }[] // 2–10, ids unique within the poll
  multi: boolean
  anonymous: boolean
  /** Share-calibrated ms; absent = open until the author closes it. */
  closesAt?: number
  /** "Quick decision" preset: Yes/No/Abstain, shows "Decided: …" when closed. */
  decision?: boolean
  /** Set by the author's closing `edt`. */
  closedAt?: number
}

export interface MsgBody {
  kind: 'text' | 'code' | 'gif' | 'diagram' | 'poll'
  text: string
  lang?: string | null // kind:'code'
  packId?: string // kind:'gif' from the bundled pack — zero share I/O
  entities?: BodyEntity[]
  /** kind:'diagram' — `text` carries a fallback line for pre-1.2 clients. */
  diagram?: DiagramBody
  /** kind:'poll' (1.3) — `text` carries a fallback line for pre-1.3 clients. */
  poll?: PollBody
}

/** A vote on a poll message (1.3). The latest verified `vot` per device wins. */
export interface VotPayload {
  t: 'vot'
  conv: ConvId
  target: string // the poll message's event stem
  choice: string[] // option ids; [] retracts
}

export interface MsgPayload {
  t: 'msg'
  conv: ConvId
  author: { device: string; name: string }
  senderSeq: number // per-device monotonic — deletion detection
  sentWall: number // sender wall clock, display only
  body: MsgBody
  replyTo?: string // event stem
  attachments?: Attachment[]
  linkPreview?: LinkPreview
}

export interface EdtPayload {
  t: 'edt'
  conv: ConvId
  target: string
  body: MsgBody
}

export interface DelPayload {
  t: 'del'
  conv: ConvId
  target: string
}

export interface RctPayload {
  t: 'rct'
  conv: ConvId
  target: string
  emoji: string
  op: 'add' | 'remove'
}

export interface PinPayload {
  t: 'pin'
  conv: ConvId
  target: string
  op: 'pin' | 'unpin'
}

export interface PrvPayload {
  t: 'prv'
  conv: ConvId
  target: string
  linkPreview: LinkPreview
}

export interface SysPayload {
  t: 'sys'
  conv: ConvId
  kind:
    | 'channel-created'
    | 'channel-renamed' // data: { name } — any member, LWW by event id (1.2)
    | 'channel-deleted' // data: {} — any member; never for the fixed channel (1.2)
    | 'topic-changed'
    | 'name-changed'
    | 'beam-receipt'
    | 'purge-blob'
    | 'screenshare'
    | 'screenshare-ended'
    // Private groups (1.2). The two `group-invite`/`group-rekey` kinds travel in
    // the owner↔member DM log (E2E) and carry key material — see GroupInviteData.
    // The rest live in the group's own log and are LWW-materialized like
    // channel metadata; `group-member-removed`/`group-deleted` count only when
    // signed by the owner, the others when signed by a current member.
    | 'group-invite'
    | 'group-rekey'
    | 'group-created' // data: { name, members }
    | 'group-renamed' // data: { name }
    | 'group-members-added' // data: { members }
    | 'group-member-removed' // data: { member, epoch } — written under the new epoch key
    | 'group-left' // data: {} — the author left
    | 'group-deleted' // data: {}
    | 'group-removed' // data: { groupId, epoch } — "you were removed", a `grp` event (1.2)
    // Live boards (1.3): a real-time diagram session over boards/<sessionId>/.
    | 'board-live' // data: { sessionId, boardId, title, host, startedAt }
    | 'board-ended' // data: { sessionId, boardId, resultStem? } — host only
  data: Record<string, unknown>
}

/**
 * One participant's frame in a live board session (1.3): the writer's full
 * element list (Excalidraw keeps `isDeleted` tombstones, so full lists
 * reconcile cleanly), files it introduced since its last frame, its pointer
 * and selection. Signed, then encrypted under the conversation key with
 * `KID.board(sessionId, convInfo.kid)` — the conversation's kid rides along so
 * a reader knows which key (for a group, which epoch) the frame wants; file
 * `boards/<sessionId>/<deviceId8>.<seq36>`.
 */
export interface BoardFrameDraft {
  elements: unknown[]
  /** Newly introduced binary files (id -> Excalidraw BinaryFileData), sent once. */
  files?: Record<string, unknown>
  pointer?: { x: number; y: number; tool: 'pointer' | 'laser' }
  selectedIds?: string[]
}

export interface BoardFrame extends BoardFrameDraft {
  sessionId: string
  device: string
  name: string
  seq: number
  /** Share-calibrated ms when written. */
  at: number
}

/**
 * A private-group notice inside the owner↔member DM log (1.2). Its own event
 * type, not `sys`: `sysLine()` on a shipped 1.1 client has no default branch, so
 * an unknown sys kind renders as an empty row in the DM. A `.grp.e1` file fails
 * 1.1's `EVENT_RE` outright and is skipped without a trace instead.
 *
 * `group-invite`/`group-rekey` carry `GroupInviteData` (key material — the
 * bridge blanks `key`/`key1` before the renderer ever sees them); the
 * `group-removed` notice the owner sends to the person they removed carries
 * only the group id and the epoch it rotated to.
 *
 * `materialize()` folds these into the same `sys` row list under the same kind
 * strings, so `sysLine` and the conversation-vanished toast keep working.
 */
export interface GrpPayload {
  t: 'grp'
  /** The DM the notice travels in — never the group's own conv. */
  conv: ConvId
  kind: 'group-invite' | 'group-rekey' | 'group-removed'
  data: GroupInviteData | GroupRemovedData
}

/** `data` of a `group-removed` notice: enough to drop the group, nothing more. */
export interface GroupRemovedData {
  groupId: string
  /** The epoch the owner rotated to when removing this device. */
  epoch: number
  /**
   * The group's name at that moment — for the DM row alone ("You were removed
   * from 🔒 Ops crew"). The removed device is dropping its local state, so it
   * has nowhere else left to look the name up; nothing secret travels here that
   * the recipient did not already have.
   */
  name?: string
}

/** `data` of a `group-invite` (epoch 1) or `group-rekey` (epoch ≥ 2) DM sys event. */
export interface GroupInviteData {
  groupId: string // 8 hex, random, chosen by the owner
  name: string
  owner: string // deviceId
  members: string[] // deviceIds, owner included
  epoch: number
  key: string // base64 32-byte group key for this epoch
  /**
   * Epoch-1 key, base64 — the directory token derives from it, so it rides
   * along on every message that carries an epoch above 1: a rekey, and an
   * invite sent to someone joining after a rotation. Absent at epoch 1, where
   * `key` already is the epoch-1 key.
   */
  key1?: string
  createdAt: number
}

// ---------------------------------------------------------------------------
// Team calendar (conv 'team:calendar', event type 'cal')

export interface CalendarEntry {
  id: string // 16 hex, random, chosen by the creator; stable across edits
  title: string // <= 120 chars
  tag: string // <= 24 chars, free text ('Release', 'Freeze', 'Birthday', …)
  color: number // 0..7 -> var(--hue-N)
  start: string // 'YYYY-MM-DD' (calendar date, no timezone)
  end: string // 'YYYY-MM-DD' inclusive; === start for single-day
  annual: boolean // repeats every year on the same month/day (birthdays)
  notes: string // '' when empty — never undefined (canonical JSON)
}

export type CalPayload =
  | { t: 'cal'; conv: ConvId; op: 'put'; entry: CalendarEntry }
  | { t: 'cal'; conv: ConvId; op: 'del'; id: string }

// ---------------------------------------------------------------------------
// Pull-request group (conv 'team:prs', event type 'prs')

export interface PrsRepo {
  id: string
  name: string
}

export interface PrsConfig {
  /** 'https://dev.azure.com/org' | 'https://tfs.corp/tfs/DefaultCollection' — no trailing slash. */
  baseUrl: string
  project: string // project name (or id)
  repos: PrsRepo[] // watched repositories; empty = nothing tracked
  sharedToken: string // '' when the configurer chose not to share
  /** 1.4 — a review is overdue after this many hours (default PRS.reviewSlaHours). */
  reviewSlaHours?: number
  /** 1.4 — a PR is stale after this many days without activity (default PRS.staleAfterDays). */
  staleAfterDays?: number
}

/** Full snapshot of the group config; LWW by event stem. */
export type PrsPayload = { t: 'prs'; conv: ConvId; config: PrsConfig }

export type EventPayload =
  | MsgPayload
  | EdtPayload
  | DelPayload
  | RctPayload
  | PinPayload
  | PrvPayload
  | SysPayload
  | CalPayload
  | PrsPayload
  | GrpPayload
  | VotPayload

/** What actually gets encrypted into an .e1 file. */
export interface SignedRecord<T = unknown> {
  p: T
  by: string // author deviceId (32 hex) — key lookup for verification
  sig: string // base64 Ed25519 over DST || 0x00 || canonicalJSON(p)
}

// ---------------------------------------------------------------------------
// Beacon

export type PresenceStateKind = 'online' | 'away' | 'offline'

export interface BeaconContent {
  device: string
  name: string
  seq: string // base36, 8 chars, mirrors filename
  hlc: number
  presence: { state: PresenceStateKind; status: string; idleSec: number }
  typing?: { conv: ConvId; until: number }
  /** Last N event filenames this device wrote, per conversation (channels only). */
  heads: Record<string, string[]>
  /**
   * Heads of event types introduced after 1.2 (`vot`, …), kept out of `heads` so
   * that a burst of them cannot evict the names an older reader does ingest from
   * that 16-slot ring (a name it cannot parse is skipped before the gap check, so
   * it costs nothing in itself — losing the `msg` heads costs it the cheap path).
   * 1.3 readers ingest both rings; older ones never see this field.
   */
  heads2?: Record<string, string[]>
  /** Read/ingest watermarks per conversation (channels only). */
  cursors: Record<string, Cursor>
  /** DM section: pairToken -> SFC1-under-pair-key, base64. Hides DM activity from the team. */
  dmSealed?: Record<string, string>
  /** Private groups (1.2): group dir token -> SFC1 under the group's current epoch key (KID.grp), base64. */
  grpSealed?: Record<string, string>
  /** App version of the writer (1.2) — peers on older builds raise an update banner. */
  app?: string
  /** Live upload progress: blobId -> chunks done/total. */
  xfers?: Record<string, { done: number; total: number }>
  /** Drop hints: recipientDeviceId -> hlc of newest drop placed. */
  drops?: Record<string, number>
  /** P2P reachability. */
  lanIps?: string[]
  p2p?: { caps: string[]; wsPort?: number }
}

/** The pair-key-encrypted part of a beacon for one DM. */
export interface DmBeaconSection {
  heads: string[]
  cursor: Cursor
  typingUntil?: number
  /**
   * Heads of `grp` event files in this DM (1.2), kept out of `heads` on purpose:
   * a 1.1 reader that meets a `.grp.e1` name there cannot parse it, counts it as
   * a gap, and pays for a full `catchUp` on every bump we make. It ignores an
   * unknown field instead. Short ring — invites and rekeys are rare.
   */
  grpHeads?: string[]
  /** Same rule as BeaconContent.heads2, inside the sealed section (1.3). */
  heads2?: string[]
}

/** A device's watermarks in one conversation: event stems, plus when it last read. */
export interface Cursor {
  read: string
  ingested: string
  readAt?: number // share-calibrated ms; absent from pre-1.0.2 beacons
}

// ---------------------------------------------------------------------------
// Channel / team metadata

export interface ChannelMeta {
  type: 'channel'
  channelId: string // 8 hex, random
  name: string
  topic: string
  creator: string
  created: number
  /**
   * The team's home channel (1.2): written by the bootstrap `general`
   * creation; can't be renamed or deleted. Teams created before 1.2 have no
   * flagged channel — then the oldest `created` (ties: lowest channelId) is it.
   */
  fixed?: true
}

export interface TeamConfig {
  type: 'team-config'
  teamName: string
  admins: string[] // deviceIds allowed to del others' messages
  retention?: Partial<{
    eventDays: number
    blobDays: number
    dropHours: number
  }>
  defaultChannels?: string[]
}

export interface ProtocolFile {
  protocol: 'fdc'
  version: number
  minReader: number
  minWriter: number
  teamId: string
  teamName: string
  epoch: number
  kdf: { alg: 'scrypt'; N: number; r: number; p: number; saltB64: string }
  check: string // HMAC prefix (base64) for instant wrong-passphrase detection
  created: number
}

// ---------------------------------------------------------------------------
// Drops (beams)

export interface DropOffer {
  type: 'drop-offer'
  dropId: string
  from: string
  name: string
  size: number
  mime: string
  sha256: string
  blobKey: string // base64
  note?: string
  thumb?: string
}

export interface DropAck {
  type: 'drop-ack'
  dropId: string
  state: 'accepted' | 'receiving' | 'saved' | 'declined'
  bytesDone?: number
}

// ---------------------------------------------------------------------------
// RTC signaling

export type RtcSignalType = 'offer' | 'answer' | 'bye' | 'busy'
export type RtcPurpose = 'screenshare' | 'xfer'

export interface RtcSignal {
  type: 'rtc'
  sessionId: string // 16 hex
  purpose: RtcPurpose
  signal: RtcSignalType
  from: string
  to: string
  sdp?: string
  reason?: 'ended' | 'fallback' | 'error' | 'declined' | 'upgraded'
  /** xfer offers carry metadata so the receiver can accept/decline pre-answer. */
  xmeta?: { name: string; size: number; mime: string; resumeFrom?: number }
}

export interface ScreenshareAnnounce {
  sessionId: string
  presenterDevice: string
  frameKey: string // base64, wrapped by conversation encryption already
  nonceBase: string // base64 4 bytes
  w: number
  h: number
  gen: number
}

// ---------------------------------------------------------------------------
// Updates

export interface VersionManifest {
  schema: 1
  version: string
  released: string
  minSupported: string
  notes: string
  files: Record<string, { name: string; sha256: string; bytes: number }>
  sig: string
}

// ---------------------------------------------------------------------------
// Renderer-facing view models (decrypted, verified)

export interface VerifiedEvent {
  id: string // stem
  type: EventType
  payload: EventPayload
  author: string // deviceId
  verified: boolean
  receivedAt: number
}

// ---------------------------------------------------------------------------
// Azure DevOps (pull-request group). Lives here — not in services/ado.ts — so
// bridge.ts can name these types without importing main-process code.

export type AdoErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'proxy-auth'
  | 'tls'
  | 'dns'
  | 'network'
  | 'timeout'
  | 'http'
  | 'bad-url'
  | 'api-version'

/** `detail` never contains the token. */
export interface AdoError {
  code: AdoErrorCode
  detail: string
}

export type AdoResult<T> = { ok: true; value: T } | { ok: false; error: AdoError }

/** Who should act on a pull request right now (1.4). */
export type PrNextActor = 'reviewers' | 'author' | 'nobody'

/**
 * The wait a pull request is in (1.4), computed locally from the PR list plus
 * its threads and iterations. Drafts are excluded before this is computed.
 */
export type PrStateKind =
  | 'needs-review' // nobody blocking, no open threads, a reviewer still to vote since the last push → reviewers
  | 'changes-requested' // a −5/−10 vote after the last push → author
  | 'comments-open' // unresolved threads whose last comment is not the author's → author
  | 'author-replied' // every open thread's last comment is the author's → the reviewers who opened them
  | 'approved' // all required reviewers approved, no open threads → author, to complete

export interface PrState {
  kind: PrStateKind
  next: PrNextActor
  /** ADO identity ids / display names of who should act now. */
  nextIds: string[]
  nextNames: string[]
  /** ms epoch when the current wait began. */
  since: number
  /** ms epoch of the last activity of any kind: creation, push, comment, or an observed vote. */
  lastActivityAt: number
  lastPushAt: number | null
  /** Unresolved (active/pending) threads. */
  openThreads: number
  /** False when the server cannot serve threads (API < 3.0) or they were not fetched yet. */
  threadsKnown: boolean
  /** No activity for `staleAfterDays`. */
  stale: boolean
  /** Waiting on reviewers longer than `reviewSlaHours`. */
  overdue: boolean
}

export interface PrView {
  key: string // `${repoId}:${pullRequestId}`
  id: number
  title: string
  repoId: string
  repoName: string
  author: { id: string; name: string }
  sourceBranch: string // 'refs/heads/' stripped
  targetBranch: string // 'refs/heads/' stripped
  createdAt: number // ms epoch
  isDraft: boolean
  reviewers: { id: string; name: string; vote: number; required: boolean }[]
  assignedToMe: boolean // I appear in reviewers
  myVote: number // 0 when not a reviewer
  webUrl: string
  seen: boolean
  /** 1.4 — always set by the service; optional only so the contract typechecks ahead of it. */
  state?: PrState
  /** `lastMergeSourceCommit.commitId` — a cheap "the author pushed" signal (1.4). */
  lastMergeCommit?: string
}

export interface PrsStatus {
  configured: boolean
  baseUrl: string
  project: string
  repos: PrsRepo[]
  tokenSource: 'personal' | 'shared' | 'none'
  /** True when the team config currently carries a shared token (independent of tokenSource, which is per viewer). */
  sharedTokenSet: boolean
  me: { id: string; name: string } | null
  lastPollAt: number | null
  polling: boolean
  error: AdoError | null
  /** PRs still waiting for someone. An `approved` PR is listed but never counted here (1.4). */
  unseen: number
  /** 1.4 — PRs waiting on reviewers past the team's SLA, and PRs with no activity past the stale threshold. */
  overdue: number
  stale: number
  /**
   * 1.4 — the team's live thresholds, defaulted from `PRS` when the config
   * predates them. The prefs pane prefills from these, and the pane's stale
   * line quotes them ("No activity for 14+ days").
   */
  reviewSlaHours: number
  staleAfterDays: number
}

export type PrsProbe =
  | { ok: true; me: { id: string; name: string }; projects: { id: string; name: string }[]; apiVersion: string }
  | { ok: false; error: AdoError }

export interface PresenceView {
  deviceId: string
  name: string
  hostname: string
  fingerprint: string // "Q7RC-2MZE" — computed from the pinned verifying key
  state: PresenceStateKind
  status: string
  lastSeenMs: number | null
  trust: TrustState
  dmConv: ConvId
  /** Chat version this device last beaconed (1.2+ writers only). */
  app?: string
  /**
   * Nobody is behind this registration any more (swept beacon, quiet for
   * days, or superseded by a re-setup). Kept in the list so names still
   * resolve and pending DM traffic stays reachable; roster surfaces hide it.
   */
  departed: boolean
  /**
   * 1.4 — the device id that replaced this one: the same person, on the same
   * machine, set up again after "Reset local data" (`transport/supersede.ts`).
   * Always implies `departed`; the extra field is what lets a surface say
   * *why* — a DM with history is labelled "(previous device)" rather than
   * quietly disappearing like a teammate who has merely been quiet for days.
   */
  supersededBy?: string
}
