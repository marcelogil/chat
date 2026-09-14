import { randomBytes } from 'node:crypto'
import { DIR, DST, FILE_EXT, KID } from '@shared/constants'
import type { ChannelMeta, ConvId, ProtocolFile, SignedRecord, TeamConfig } from '@shared/types'
import { isChanConv, isGrpConv, isTeamConv } from '@shared/ids'
import { newHlcState, type HlcState } from '@shared/hlc'
import { buildAad, decryptRecord, encryptRecord } from '../crypto/envelope'
import {
  convToken,
  deriveConvKey,
  deriveDmKey,
  deriveTeamKeys,
  dmPairToken,
  type TeamKeys,
} from '../crypto/keys'
import { dmSharedSecret, signRecord, verifyRecord, type DeviceIdentity } from '../crypto/identity'
import type { SecretStore } from '../store/secretStore'
import { Roster } from './roster'
import type { ShareIo } from './shareIo'

// A Session is the fully-unlocked state: share mounted, passphrase verified,
// identity loaded, team keys derived. It owns conversation key material and
// the channel/DM registries; transports (events, beacon, blobs) hang off it.

export interface ChannelState {
  channelId: string
  token: string
  meta: ChannelMeta
  key: Buffer
  /**
   * Current name (1.2): `meta.name` folded with every `channel-renamed` sys
   * event, LWW by event id. The metadata file is never rewritten — clients
   * read it once and cache it, so a rewrite would reach nobody.
   */
  name: string
  /** Author of the winning rename, and its event id (LWW bookkeeping). */
  renamedBy?: string
  renameStem?: string
  /** Set by a folded `channel-deleted` tombstone — sticky: a later rename never resurrects. */
  deletedAt?: number
}

export interface DmState {
  peerDeviceId: string
  pairToken: string
  key: Buffer
}

/**
 * A team conversation ('team:calendar', 'team:prs'): an app-defined event log
 * under `team/<token>/events`. There is no `channel.json.e1` metadata file —
 * the whole ConvId is the key id and the existence of the log is implied.
 */
export interface TeamState {
  conv: `team:${string}`
  token: string
  key: Buffer
}

/** Where a conversation's log lives and what unlocks it. */
export interface ConvInfo {
  key: Buffer
  eventsDir: string
  kid: string
  scope: string
}

/**
 * Result of routing one group record to a key by the epoch named in its kid.
 * `unknown-epoch` is not a failure: the rekey DM that carries that key may
 * still be in flight, so the reader parks the file instead of quarantining it.
 */
export type GroupKeyLookup = { kind: 'key'; key: Buffer } | { kind: 'unknown-epoch' } | { kind: 'reject' }

/**
 * Private groups (1.2) live outside the team key hierarchy: their keys arrive
 * as DM sys events, so the session can only answer `grp:` questions through
 * the GroupService, which registers itself here at construction.
 */
export interface GroupProvider {
  /** Conv info at the group's current epoch; null when unknown, left or deleted. */
  info(conv: ConvId): ConvInfo | null
  /** Key for the epoch named in a record's kid. */
  keyForKid(conv: ConvId, kid: string): GroupKeyLookup
  /**
   * When this record's epoch stopped being current, if it is a former member's
   * write under a retired key — else null. The verdict is the caller's: a
   * filename stem is chosen by its writer, so only the file's own mtime can say
   * whether it landed after the rotation (see EventStore.ingestFile).
   */
  staleWriteCut(conv: ConvId, kid: string, author: string): string | null
  /** Folded membership test — a beacon section from a former member is not news. */
  isMember(conv: ConvId, deviceId: string): boolean
  /** Opaque directory token of a group we hold keys for. */
  token(conv: ConvId): string | null
  /** Reverse lookup for beacon sections: dir token → conv id. */
  convForToken(token: string): ConvId | null
  /** Every epoch key we hold, newest first (beacon sections carry no epoch hint). */
  keys(conv: ConvId): Buffer[]
  /** Live groups (not left, not deleted) — the poller's catch-up list. */
  convs(): ConvId[]
}

export class Session {
  readonly hlc: HlcState = newHlcState()
  readonly channels = new Map<string, ChannelState>() // channelId -> state
  readonly channelsByToken = new Map<string, ChannelState>()
  readonly dms = new Map<string, DmState>() // peerDeviceId -> state
  readonly dmsByToken = new Map<string, DmState>()
  /** Derived lazily per team conv id; HKDF is cheap but convInfo() is hot. */
  private teams = new Map<string, TeamState>()
  /** Private groups (1.2) — set by GroupService; null before it loads. */
  groups: GroupProvider | null = null
  readonly keys: TeamKeys
  /** Per-conversation monotonic sequence for our own messages (gap detection). */
  private senderSeqs: Record<string, number>

  constructor(
    readonly io: ShareIo,
    readonly store: SecretStore,
    readonly identity: DeviceIdentity,
    readonly proto: ProtocolFile,
    readonly teamSalt: Buffer,
    readonly tmk: Buffer,
    readonly tmk1: Buffer,
    readonly roster: Roster,
    public displayName: string,
  ) {
    this.keys = deriveTeamKeys(proto.epoch, tmk, tmk1, teamSalt)
    this.senderSeqs = store.readSecretJson<Record<string, number>>('sender-seqs') ?? {}
  }

  get deviceId(): string {
    return this.identity.deviceId
  }

  get deviceId8(): string {
    return this.identity.deviceId.slice(0, 8)
  }

  nextSenderSeq(conv: ConvId): number {
    const n = (this.senderSeqs[conv] ?? 0) + 1
    this.senderSeqs[conv] = n
    this.store.writeSecretJson('sender-seqs', this.senderSeqs)
    return n
  }

  // -------------------------------------------------------------------------
  // Channels

  async loadChannels(): Promise<void> {
    const tokens = await this.io.listDirs(DIR.channels)
    for (const token of tokens) {
      if (this.channelsByToken.has(token)) continue
      await this.loadChannel(token)
    }
  }

  /**
   * Load one channel by its id, without listing the channels directory: the
   * token is `convToken(kMeta, channelId)`, so a conv id we were handed is
   * enough to find (and verify) its metadata in a single read.
   *
   * This is what closes the discovery window (1.4): a channel reaches the
   * sidebar the moment a beacon head or a sys event names it, but the session
   * only *loads* channels on the poller's blanket sweep (1–10 minutes), so a
   * send in between had nothing to encrypt against and was rejected with
   * "unknown conversation" — the "Say hello does nothing" report. A channel
   * already in the map is returned as it stands, tombstone included: a deleted
   * channel must stay closed for writing (see `convInfo`), and re-reading its
   * metadata would only hand back a state with no tombstone folded into it.
   */
  async ensureChannel(conv: ConvId): Promise<ChannelState | null> {
    if (!isChanConv(conv)) return null
    const channelId = conv.slice(5)
    const known = this.channels.get(channelId)
    if (known) return known
    return await this.loadChannel(convToken(this.keys.kMeta, channelId))
  }

  private async loadChannel(token: string): Promise<ChannelState | null> {
    const rel = `${DIR.channels}/${token}/channel.json${FILE_EXT.record}`
    const buf = await this.io.readMaybe(rel)
    if (!buf) return null
    try {
      const aad = buildAad('meta', rel, token)
      const plain = decryptRecord(buf, this.keys.kMeta, aad)
      const signed = JSON.parse(plain.toString('utf8')) as SignedRecord<ChannelMeta>
      const author = this.roster.get(signed.by)
      if (author && !verifyRecord(signed, DST.record, author.edPubKey)) return null
      const meta = signed.p
      if (convToken(this.keys.kMeta, meta.channelId) !== token) return null // dir/meta mismatch
      const state: ChannelState = {
        channelId: meta.channelId,
        token,
        meta,
        name: meta.name,
        key: deriveConvKey(this.tmk, this.teamSalt, this.proto.epoch, meta.channelId),
      }
      this.channels.set(meta.channelId, state)
      this.channelsByToken.set(token, state)
      return state
    } catch {
      return null
    }
  }

  /**
   * `fixed` is written once, by the bootstrap `general` creation (1.2): the
   * team's home channel can never be renamed or deleted. Teams created before
   * 1.2 carry no flag anywhere — readers then fall back to the oldest channel.
   */
  async createChannel(name: string, topic = '', opts?: { fixed?: true }): Promise<ChannelState> {
    const channelId = randomBytes(4).toString('hex')
    const token = convToken(this.keys.kMeta, channelId)
    const meta: ChannelMeta = {
      type: 'channel',
      channelId,
      name,
      topic,
      creator: this.deviceId,
      created: this.io.calibratedNow(),
      ...(opts?.fixed ? { fixed: true as const } : {}),
    }
    const signed = signRecord(this.identity, DST.record, meta)
    const rel = `${DIR.channels}/${token}/channel.json${FILE_EXT.record}`
    const aad = buildAad('meta', rel, token)
    await this.io.publish(rel, encryptRecord(this.keys.kMeta, KID.meta(this.proto.epoch), Buffer.from(JSON.stringify(signed)), aad))
    await this.io.ensureDir(`${DIR.channels}/${token}/events`)
    const state: ChannelState = {
      channelId,
      token,
      meta,
      name,
      key: deriveConvKey(this.tmk, this.teamSalt, this.proto.epoch, channelId),
    }
    this.channels.set(channelId, state)
    this.channelsByToken.set(token, state)
    return state
  }

  /** Channels that still exist — a folded tombstone hides one everywhere. */
  activeChannels(): ChannelState[] {
    return [...this.channels.values()].filter((c) => !c.deletedAt)
  }

  // -------------------------------------------------------------------------
  // DMs — derived lazily per known peer; both sides compute identical tokens.

  dmFor(peerDeviceId: string): DmState | null {
    const existing = this.dms.get(peerDeviceId)
    if (existing) return existing
    const peer = this.roster.get(peerDeviceId)
    if (!peer) return null
    const shared = dmSharedSecret(this.identity, peer.pin.xPub)
    const key = deriveDmKey(shared, this.deviceId, peerDeviceId)
    const state: DmState = { peerDeviceId, pairToken: dmPairToken(key), key }
    this.dms.set(peerDeviceId, state)
    this.dmsByToken.set(state.pairToken, state)
    return state
  }

  /** Materialize DM states for every known roster device (cheap DH each). */
  refreshDms(): void {
    for (const e of this.roster.all()) {
      if (e.record.deviceId !== this.deviceId) this.dmFor(e.record.deviceId)
    }
  }

  // -------------------------------------------------------------------------
  // Conversation helpers shared by events/beacon

  /**
   * Key material and directory for a team conv. No metadata file and no
   * discovery step: the ConvId itself ('team:calendar') is the key id, so both
   * sides derive the same token and key from the team keys alone.
   */
  teamFor(conv: `team:${string}`): TeamState {
    const existing = this.teams.get(conv)
    if (existing) return existing
    const state: TeamState = {
      conv,
      token: convToken(this.keys.kMeta, conv),
      key: deriveConvKey(this.tmk, this.teamSalt, this.proto.epoch, conv),
    }
    this.teams.set(conv, state)
    return state
  }

  convInfo(conv: ConvId): ConvInfo | null {
    if (isChanConv(conv)) {
      const ch = this.channels.get(conv.slice(5))
      // A tombstoned channel is closed for reading and writing alike: the
      // events are on their way out and nothing new belongs in them.
      if (!ch || ch.deletedAt) return null
      return {
        key: ch.key,
        eventsDir: `${DIR.channels}/${ch.token}/events`,
        kid: KID.conv(this.proto.epoch, ch.token),
        scope: 'conv',
      }
    }
    if (isTeamConv(conv)) {
      const t = this.teamFor(conv)
      return {
        key: t.key,
        eventsDir: `${DIR.team}/${t.token}/events`,
        kid: KID.conv(this.proto.epoch, t.token),
        scope: 'team',
      }
    }
    if (isGrpConv(conv)) return this.groups?.info(conv) ?? null
    const dm = this.dmsByToken.get(conv.slice(3))
    if (!dm) return null
    return {
      key: dm.key,
      eventsDir: `${DIR.dm}/${dm.pairToken}/events`,
      kid: KID.dm(dm.pairToken),
      scope: 'dm',
    }
  }

  convIdForChannel(channelId: string): ConvId {
    return `chan:${channelId}`
  }

  convIdForPeer(peerDeviceId: string): ConvId | null {
    const dm = this.dmFor(peerDeviceId)
    return dm ? `dm:${dm.pairToken}` : null
  }

  // -------------------------------------------------------------------------
  // Team config

  async readTeamConfig(): Promise<TeamConfig | null> {
    const rel = `${DIR.config}/team.json${FILE_EXT.record}`
    const buf = await this.io.readMaybe(rel)
    if (!buf) return null
    try {
      const aad = buildAad('meta', rel, 'team-config')
      const signed = JSON.parse(decryptRecord(buf, this.keys.kMeta, aad).toString('utf8')) as SignedRecord<TeamConfig>
      return signed.p
    } catch {
      return null
    }
  }

  async writeTeamConfig(config: TeamConfig): Promise<void> {
    const rel = `${DIR.config}/team.json${FILE_EXT.record}`
    const aad = buildAad('meta', rel, 'team-config')
    const signed = signRecord(this.identity, DST.record, config)
    await this.io.publish(rel, encryptRecord(this.keys.kMeta, KID.meta(this.proto.epoch), Buffer.from(JSON.stringify(signed)), aad))
  }
}
