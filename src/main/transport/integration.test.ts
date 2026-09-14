import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GroupView, PushMessage } from '@shared/bridge'
import type {
  BeaconContent,
  BoardFrame,
  CalPayload,
  CalendarEntry,
  ConvId,
  GroupInviteData,
  GrpPayload,
  MsgPayload,
  PollBody,
  SysPayload,
  VotPayload,
} from '@shared/types'
import { DIR, DST, KID, RETENTION, TEAM_CONV } from '@shared/constants'
import { materializeCalendar } from '@shared/calendar'
import { pollFallbackText } from '@shared/poll'
import { beaconFileName, dayShard, isChanConv, seqToBase36 } from '@shared/ids'
import { materialize } from '@shared/merge'
import { buildAad, decryptRecord, encryptRecord, recordKid } from '../crypto/envelope'
import { generateIdentity, signRecord, type DeviceIdentity } from '../crypto/identity'
import { BoardService } from '../services/boards'
import { fixedChannelId, foldChannelSys } from '../services/channels'
import type { IoTier } from '../services/ioTier'
import { GroupPartialError, GroupService } from '../services/groups'
import { Janitor } from '../services/janitor'
import type { SecretStore } from '../store/secretStore'
import { BeaconWriter, BeaconReader } from './beacon'
import { createOrJoinTeam } from './bootstrap'
import { EventStore } from './events'
import { Poller } from './poller'
import { Roster } from './roster'
import { Session } from './session'
import { ShareIo } from './shareIo'

// Two complete clients against one local folder standing in for the SMB share:
// bootstrap race, roster TOFU, channel creation/discovery, messaging with
// signature verification, DM privacy, beacon heads-driven ingestion, and the
// impersonation flag. This is the protocol's end-to-end truth test.

class FakeStore implements SecretStore {
  readonly unlocked = true
  private m = new Map<string, Buffer>()
  writeSecret(name: string, data: Buffer): void {
    this.m.set(name, Buffer.from(data))
  }
  readSecret(name: string): Buffer | null {
    return this.m.get(name) ?? null
  }
  writeSecretJson(name: string, value: unknown): void {
    this.writeSecret(name, Buffer.from(JSON.stringify(value)))
  }
  readSecretJson<T>(name: string): T | null {
    const b = this.readSecret(name)
    return b ? (JSON.parse(b.toString()) as T) : null
  }
  deleteSecret(name: string): void {
    this.m.delete(name)
  }
}

interface Client {
  identity: DeviceIdentity
  io: ShareIo
  store: FakeStore
  session: Session
  events: EventStore
  writer: BeaconWriter
  reader: BeaconReader
  groups: GroupService
  /** How many times GroupService asked for a `groups` push (renderer signal). */
  groupPushes: number[]
}

async function makeClient(root: string, passphrase: string, name: string): Promise<Client> {
  const identity = generateIdentity().identity
  const io = new ShareIo(root)
  const store = new FakeStore()
  const result = await createOrJoinTeam(io, passphrase, 'Test Team')
  if ('error' in result) throw new Error(result.error)
  const { proto, teamSalt, tmk } = result.join
  const roster = new Roster(io, store, /* kMeta derived inside session, but roster needs it too */ tmk, proto.epoch)
  // NOTE: roster's kMeta must equal the session's kMeta — construct session first
  const session = new Session(io, store, identity, proto, teamSalt, tmk, tmk, roster, name)
  // Rebind roster with the real kMeta (test convenience: recreate)
  const realRoster = new Roster(io, store, session.keys.kMeta, proto.epoch)
  realRoster.loadPins()
  const session2 = new Session(io, store, identity, proto, teamSalt, tmk, tmk, realRoster, name)
  await realRoster.publishSelf(identity, {
    deviceId: identity.deviceId,
    edPub: identity.edPub,
    xPub: identity.xPub,
    displayName: name,
    hostname: `${name}-host`,
    osUser: name.toLowerCase(),
    platform: 'darwin',
    machineIdHash: null,
    firstSeen: Date.now(),
    recSeq: 1,
  })
  const events = new EventStore(session2)
  const writer = new BeaconWriter(session2)
  const reader = new BeaconReader(session2)
  // Exactly the wiring ChatService does: fold channel sys events into channel
  // state, hand everything else to GroupService (which registers itself as the
  // session's `grp:` provider in its constructor).
  const groupPushes: number[] = []
  const groups = new GroupService(session2, {
    events,
    noteOwnEvent: (conv, fileName) => writer.noteOwnEvent(conv, fileName),
    pushGroups: () => groupPushes.push(Date.now()),
  })
  events.onEvent((conv, event) => {
    if (event.type === 'sys' && isChanConv(conv)) {
      const ch = session2.channels.get(conv.slice(5))
      if (ch && foldChannelSys(ch, event) && ch.deletedAt) events.forget(conv)
      return
    }
    groups.onEvent(conv, event)
  })
  return { identity, io, store, session: session2, events, writer, reader, groups, groupPushes }
}

/** The conv id `a` uses for its DM with `b` (both sides derive the same one). */
function dmBetween(a: Client, b: Client): ConvId {
  return a.session.convIdForPeer(b.identity.deviceId)!
}

/** Pull a client's DM with `peer` forward and settle any invite it carried. */
async function syncInvites(client: Client, peer: Client): Promise<void> {
  await client.events.catchUp(dmBetween(client, peer))
  await client.groups.settle()
}

async function sendMessage(client: Client, conv: ConvId, text: string): Promise<string> {
  const ev = await client.events.publish(conv, 'msg', {
    t: 'msg',
    conv,
    author: { device: client.identity.deviceId, name: client.session.displayName },
    senderSeq: client.session.nextSenderSeq(conv),
    sentWall: Date.now(),
    body: { kind: 'text', text },
  } satisfies MsgPayload)
  return ev.id
}

function textsIn(client: Client, conv: ConvId): string[] {
  return materialize(client.events.getEvents(conv))
    .messages.filter((m) => !m.deleted)
    .map((m) => m.body.text)
}

describe('two-client integration over a shared folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'semaphore-share-'))
  let alice: Client
  let bob: Client

  beforeAll(async () => {
    alice = await makeClient(root, 'correct horse battery staple', 'Alice')
    bob = await makeClient(root, 'correct horse battery staple', 'Bob')
    await alice.session.roster.refresh()
    await bob.session.roster.refresh()
    alice.session.refreshDms()
    bob.session.refreshDms()
  }, 60_000)

  it('wrong passphrase is rejected', async () => {
    const io = new ShareIo(root)
    const res = await createOrJoinTeam(io, 'wrong password entirely', 'x')
    expect(res).toEqual({ error: 'wrong-passphrase' })
  }, 60_000)

  it('both clients see each other in the roster with verified records', () => {
    expect(alice.session.roster.get(bob.identity.deviceId)?.record.displayName).toBe('Bob')
    expect(bob.session.roster.get(alice.identity.deviceId)?.record.displayName).toBe('Alice')
  })

  it('channel created by Alice is discovered and readable by Bob', async () => {
    const ch = await alice.session.createChannel('general', 'team chat')
    const conv: ConvId = `chan:${ch.channelId}`
    const msg: MsgPayload = {
      t: 'msg',
      conv,
      author: { device: alice.identity.deviceId, name: 'Alice' },
      senderSeq: alice.session.nextSenderSeq(conv),
      sentWall: Date.now(),
      body: { kind: 'text', text: 'hello team' },
    }
    await alice.events.publish(conv, 'msg', msg)

    await bob.session.loadChannels()
    expect(bob.session.channels.get(ch.channelId)?.meta.name).toBe('general')
    await bob.events.catchUp(conv)
    const events = bob.events.getEvents(conv)
    expect(events).toHaveLength(1)
    expect(events[0].verified).toBe(true)
    const log = materialize(events)
    expect(log.messages[0].body.text).toBe('hello team')
    expect(log.messages[0].authorName).toBe('Alice')
  })

  it('edits and reactions merge correctly across clients', async () => {
    const ch = await alice.session.createChannel('dev')
    const conv: ConvId = `chan:${ch.channelId}`
    const sent = await alice.events.publish(conv, 'msg', {
      t: 'msg',
      conv,
      author: { device: alice.identity.deviceId, name: 'Alice' },
      senderSeq: alice.session.nextSenderSeq(conv),
      sentWall: Date.now(),
      body: { kind: 'text', text: 'typo hre' },
    } satisfies MsgPayload)
    await alice.events.publish(conv, 'edt', { t: 'edt', conv, target: sent.id, body: { kind: 'text', text: 'typo here — fixed' } })
    await bob.session.loadChannels()
    await bob.events.catchUp(conv)
    await bob.events.publish(conv, 'rct', { t: 'rct', conv, target: sent.id, emoji: '👍', op: 'add' })
    await alice.events.catchUp(conv)

    for (const c of [alice, bob]) {
      const log = materialize(c.events.getEvents(conv))
      expect(log.messages).toHaveLength(1)
      expect(log.messages[0].body.text).toBe('typo here — fixed')
      expect(log.messages[0].edited).toBe(true)
      expect(log.messages[0].reactions).toEqual([{ emoji: '👍', devices: [bob.identity.deviceId] }])
    }
  })

  it("a non-author cannot edit someone else's message", async () => {
    const ch = await alice.session.createChannel('sec')
    const conv: ConvId = `chan:${ch.channelId}`
    const sent = await alice.events.publish(conv, 'msg', {
      t: 'msg',
      conv,
      author: { device: alice.identity.deviceId, name: 'Alice' },
      senderSeq: alice.session.nextSenderSeq(conv),
      sentWall: Date.now(),
      body: { kind: 'text', text: 'original' },
    } satisfies MsgPayload)
    await bob.session.loadChannels()
    await bob.events.catchUp(conv)
    await bob.events.publish(conv, 'edt', { t: 'edt', conv, target: sent.id, body: { kind: 'text', text: 'hijacked' } })
    await alice.events.catchUp(conv)
    const log = materialize(alice.events.getEvents(conv))
    expect(log.messages[0].body.text).toBe('original')
    expect(log.messages[0].edited).toBe(false)
  })

  it('DMs are end-to-end: both participants read, dirs are opaque tokens', async () => {
    const convA = alice.session.convIdForPeer(bob.identity.deviceId)!
    const convB = bob.session.convIdForPeer(alice.identity.deviceId)!
    expect(convA).toBe(convB) // identical pair token from both sides

    await alice.events.publish(convA, 'msg', {
      t: 'msg',
      conv: convA,
      author: { device: alice.identity.deviceId, name: 'Alice' },
      senderSeq: alice.session.nextSenderSeq(convA),
      sentWall: Date.now(),
      body: { kind: 'text', text: 'secret plan' },
    } satisfies MsgPayload)
    await bob.events.catchUp(convB)
    const log = materialize(bob.events.getEvents(convB))
    expect(log.messages[0].body.text).toBe('secret plan')

    // The pair token reveals nothing about the participants
    const token = convA.slice(3)
    expect(token).not.toContain(alice.identity.deviceId.slice(0, 8))
    expect(token).not.toContain(bob.identity.deviceId.slice(0, 8))
  })

  it('beacon round-trip: heads drive ingestion without directory scans', async () => {
    const ch = await alice.session.createChannel('beacon-test')
    const conv: ConvId = `chan:${ch.channelId}`
    const sent = await alice.events.publish(conv, 'msg', {
      t: 'msg',
      conv,
      author: { device: alice.identity.deviceId, name: 'Alice' },
      senderSeq: alice.session.nextSenderSeq(conv),
      sentWall: Date.now(),
      body: { kind: 'text', text: 'via beacon' },
    } satisfies MsgPayload)
    alice.writer.noteOwnEvent(conv, `${sent.id}.msg.e1`)
    await alice.writer.bump('event')

    const observations = await bob.reader.poll()
    const fromAlice = observations.find((o) => o.content.device === alice.identity.deviceId)
    expect(fromAlice).toBeDefined()
    expect(fromAlice!.verified).toBe(true)
    const heads = fromAlice!.content.heads[conv]
    expect(heads).toContain(`${sent.id}.msg.e1`)

    await bob.session.loadChannels()
    await bob.events.ingestHeads(conv, heads)
    expect(bob.events.has(conv, sent.id)).toBe(true)
  })

  it('calendar entry round-trips A → B and lives under team/, not channels/', async () => {
    const conv = TEAM_CONV.calendar
    const channelTokensBefore = readdirSync(join(root, DIR.channels)).sort()

    const entry: CalendarEntry = {
      id: 'a1b2c3d4e5f60718',
      title: 'Release 1.1',
      tag: 'Release',
      color: 3,
      start: '2026-03-14',
      end: '2026-03-16',
      annual: false,
      notes: 'ship it',
    }
    const put = await alice.events.publish(conv, 'cal', {
      t: 'cal',
      conv,
      op: 'put',
      entry,
    } satisfies CalPayload)
    alice.writer.noteOwnEvent(conv, `${put.id}.cal.e1`)

    // On disk: one new opaque token under team/, and channels/ untouched.
    const teamDir = join(root, DIR.team)
    expect(existsSync(teamDir)).toBe(true)
    const teamTokens = readdirSync(teamDir)
    expect(teamTokens).toHaveLength(1)
    expect(teamTokens[0]).not.toContain('calendar') // opaque, not the conv id
    expect(existsSync(join(teamDir, teamTokens[0], 'events'))).toBe(true)
    expect(readdirSync(join(root, DIR.channels)).sort()).toEqual(channelTokensBefore)

    // Both sides derive the same token with no metadata file to discover.
    expect(bob.session.teamFor(conv).token).toBe(teamTokens[0])

    // Team heads ride the plain beacon section, exactly like a channel.
    await alice.writer.bump('event')
    const obs = (await bob.reader.poll()).find((o) => o.content.device === alice.identity.deviceId)
    expect(obs?.content.heads[conv]).toContain(`${put.id}.cal.e1`)

    await bob.events.catchUp(conv)
    const items = materializeCalendar(bob.events.getEvents(conv))
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('Release 1.1')
    expect(items[0].end).toBe('2026-03-16')
    expect(items[0].author).toBe(alice.identity.deviceId)
    expect(bob.events.getEvents(conv).every((e) => e.verified)).toBe(true)

    // A delete from Bob hides it on Alice after catch-up.
    await bob.events.publish(conv, 'cal', { t: 'cal', conv, op: 'del', id: entry.id } satisfies CalPayload)
    await alice.events.catchUp(conv)
    expect(materializeCalendar(alice.events.getEvents(conv))).toHaveLength(0)
  }, 60_000)

  it('a rename by one client renames the channel on the other', async () => {
    const ch = await alice.session.createChannel('planing', 'typo on purpose')
    const conv: ConvId = `chan:${ch.channelId}`
    await alice.events.publish(conv, 'sys', {
      t: 'sys',
      conv,
      kind: 'channel-renamed',
      data: { name: 'planning' },
    } satisfies SysPayload)
    expect(alice.session.channels.get(ch.channelId)!.name).toBe('planning')
    // The metadata file is deliberately NOT rewritten — the rename rides the log.
    expect(alice.session.channels.get(ch.channelId)!.meta.name).toBe('planing')

    await bob.session.loadChannels()
    expect(bob.session.channels.get(ch.channelId)!.name).toBe('planing') // meta only, so far
    await bob.events.catchUp(conv)
    expect(bob.session.channels.get(ch.channelId)!.name).toBe('planning')
  })

  it('deletes a channel for everyone, and a later rename never resurrects it', async () => {
    const ch = await alice.session.createChannel('temporary')
    const conv: ConvId = `chan:${ch.channelId}`
    await sendMessage(alice, conv, 'this will be gone')
    await alice.events.publish(conv, 'sys', { t: 'sys', conv, kind: 'channel-deleted', data: {} } satisfies SysPayload)

    // Closed on the writer's side: no key, no reads, no writes, no cached log.
    expect(alice.session.channels.get(ch.channelId)!.deletedAt).toBeGreaterThan(0)
    expect(alice.session.activeChannels().some((c) => c.channelId === ch.channelId)).toBe(false)
    expect(alice.session.convInfo(conv)).toBeNull()
    expect(alice.events.getEvents(conv)).toHaveLength(0)
    await expect(sendMessage(alice, conv, 'still here?')).rejects.toThrow(/unknown conversation/)

    // And on the reader's, from the tombstone alone.
    await bob.session.loadChannels()
    await bob.events.catchUp(conv)
    expect(bob.session.channels.get(ch.channelId)!.deletedAt).toBeGreaterThan(0)
    expect(bob.session.activeChannels().some((c) => c.channelId === ch.channelId)).toBe(false)

    // A rename that lands afterwards (from a client that hadn't seen the
    // tombstone) leaves it deleted.
    const state = bob.session.channels.get(ch.channelId)!
    foldChannelSys(state, {
      id: '9999999999999-0001-aaaaaaaa',
      type: 'sys',
      payload: { t: 'sys', conv, kind: 'channel-renamed', data: { name: 'zombie' } },
      author: alice.identity.deviceId,
      verified: true,
      receivedAt: Date.now(),
    })
    expect(state.deletedAt).toBeGreaterThan(0)
  })

  it('skips a channel dir with no metadata file (a late outbox flush can make one)', async () => {
    const before = alice.session.channels.size
    mkdirSync(join(root, DIR.channels, 'STRAYTOKEN000000000A', 'events'), { recursive: true })
    await alice.session.loadChannels()
    expect(alice.session.channels.size).toBe(before)
    expect(alice.session.channelsByToken.has('STRAYTOKEN000000000A')).toBe(false)
  })

  it('sends into a channel this client knows the id of but has not loaded yet', async () => {
    // The window the "Say hello does nothing" report lives in: Alice makes a
    // channel, Bob's client is handed the conv id (a beacon head, a sys event,
    // the channels push behind the sidebar row) and somebody writes into it
    // before Bob's next blanket sweep has read `channel.json.e1`. That used to
    // be rejected outright with "unknown conversation" — the send failed while
    // the row sat in the sidebar looking perfectly ordinary.
    const ch = await alice.session.createChannel('discovered-late')
    const conv: ConvId = `chan:${ch.channelId}`
    expect(bob.session.channels.has(ch.channelId)).toBe(false)
    expect(bob.session.convInfo(conv)).toBeNull()

    const stem = await sendMessage(bob, conv, 'Hello 👋')

    // The conv id carried its own token, so one metadata read was enough.
    expect(bob.session.channels.get(ch.channelId)?.name).toBe('discovered-late')
    expect(bob.events.has(conv, stem)).toBe(true)
    await alice.events.catchUp(conv)
    expect(textsIn(alice, conv)).toEqual(['Hello 👋'])

    // Only channels: a DM token we hold no key for, a private group we were
    // never invited to, and a channel id nobody ever created are all still
    // refused — there is nothing on the share to load for any of them.
    await expect(sendMessage(bob, 'chan:deadbeef' as ConvId, 'nope')).rejects.toThrow(/unknown conversation/)
    await expect(sendMessage(bob, 'dm:ZZZZZZZZZZZZZZZZZZZZ' as ConvId, 'nope')).rejects.toThrow(/unknown conversation/)
    await expect(sendMessage(bob, 'grp:00000000000000000000' as ConvId, 'nope')).rejects.toThrow(/unknown conversation/)
  }, 60_000)

  it('tells its listener when a send has to load the channel first, and only then', async () => {
    // The other half of the on-demand-load fix: the head-discovery path above
    // already had its own onNewDevice nudge (via the poller), but publish()'s
    // own on-demand load — the exact path the previous test exercises — used
    // to complete in silence. ChatService wires this straight to pushChannels
    // so the sidebar gets the name without waiting on an unrelated push.
    let discovered = 0
    bob.events.onChannelDiscovered(() => discovered++)

    const ch = await alice.session.createChannel('discovered-by-publish')
    const conv: ConvId = `chan:${ch.channelId}`
    expect(bob.session.channels.has(ch.channelId)).toBe(false)

    await sendMessage(bob, conv, 'first one in')
    expect(discovered).toBe(1)

    // Already known the second time around: no second nudge for the same channel.
    await sendMessage(bob, conv, 'second one in')
    expect(discovered).toBe(1)
  }, 60_000)

  it("discovers a channel from a peer's beacon head and tells the shell at once", async () => {
    // The other half of the same window: discovery used to happen only inside
    // the blanket sweep's `loadChannels()`, and the sweep decides "anything
    // new?" by comparing `channels.size` *after* the observations have already
    // been processed — so a channel loaded on the head path was loaded
    // silently and never reached the sidebar until some unrelated device
    // showed up. Now the head path loads it by id and says so.
    const poller = new Poller(bob.session, bob.events)
    let shellNudges = 0
    poller.listeners = {
      onNewDevice: () => {
        shellNudges++
      },
    }
    // Sweep suppressed on both ticks: whatever happens here is the head path.
    const pinSweep = () => ((poller as unknown as { lastSweepAt: number }).lastSweepAt = Date.now())
    // Meet Alice's beacon first, so her own first-sighting nudge is spent and
    // anything counted below can only have come from the channel.
    await alice.writer.bump('startup')
    pinSweep()
    await poller.tick()

    const ch = await alice.session.createChannel('head-discovered')
    const conv: ConvId = `chan:${ch.channelId}`
    const stem = await sendMessage(alice, conv, 'first one in')
    alice.writer.noteOwnEvent(conv, `${stem}.msg.e1`)
    await alice.writer.bump('event')
    expect(bob.session.channels.has(ch.channelId)).toBe(false)

    shellNudges = 0
    pinSweep()
    await poller.tick()

    expect(bob.session.channels.get(ch.channelId)?.name).toBe('head-discovered')
    expect(bob.events.has(conv, stem)).toBe(true)
    expect(shellNudges).toBe(1)
  }, 60_000)

  it('still refuses a send into a channel whose tombstone it has already folded', async () => {
    // The on-demand load must not become a way back into a deleted channel: a
    // channel already in the map answers from the map, tombstone and all.
    const ch = await alice.session.createChannel('closing-time')
    const conv: ConvId = `chan:${ch.channelId}`
    await alice.events.publish(conv, 'sys', { t: 'sys', conv, kind: 'channel-deleted', data: {} } satisfies SysPayload)
    expect(alice.session.channels.get(ch.channelId)!.deletedAt).toBeGreaterThan(0)
    await expect(sendMessage(alice, conv, 'anyone there?')).rejects.toThrow(/unknown conversation/)

    // And the reader who meets it for the first time through a send: the
    // metadata loads, the log catches up, the tombstone folds, and the write
    // is refused — not published into a directory on its way out.
    expect(bob.session.channels.has(ch.channelId)).toBe(false)
    await expect(sendMessage(bob, conv, 'hello?')).rejects.toThrow(/unknown conversation/)
    expect(bob.session.channels.get(ch.channelId)!.deletedAt).toBeGreaterThan(0)
  }, 60_000)

  it('agrees on the home channel: the flagged one, else the oldest', async () => {
    const flagged = await alice.session.createChannel('home', '', { fixed: true })
    await bob.session.loadChannels()
    expect(fixedChannelId(bob.session.activeChannels())).toBe(flagged.channelId)

    // A team created before the flag existed: oldest wins on both clients.
    const unflagged = alice.session.activeChannels().filter((c) => !c.meta.fixed)
    const oldest = [...unflagged].sort((a, b) => a.meta.created - b.meta.created || (a.channelId < b.channelId ? -1 : 1))[0]
    expect(fixedChannelId(unflagged)).toBe(oldest.channelId)
  })

  it('the janitor removes a deleted channel dir only after the grace period', async () => {
    const ch = await alice.session.createChannel('sweepable')
    const conv: ConvId = `chan:${ch.channelId}`
    await sendMessage(alice, conv, 'bye')
    await alice.events.publish(conv, 'sys', { t: 'sys', conv, kind: 'channel-deleted', data: {} } satisfies SysPayload)
    const dir = join(root, DIR.channels, ch.token)
    expect(existsSync(dir)).toBe(true)

    const janitor = new Janitor(alice.session)
    const deletedAt = () => alice.session.channels.get(ch.channelId)!.deletedAt!
    janitor.deletedConvs = () => [{ rel: `${DIR.channels}/${ch.token}`, deletedAt: deletedAt() }]
    await janitor.sweep()
    expect(existsSync(dir)).toBe(true) // inside the grace period: still readable

    // A tombstone dated before the grace is not enough on its own: `deletedAt`
    // comes from a filename its writer chose, so the directory's own mtime has
    // to agree before anything is removed. Here it does not — the dir is new.
    const grace = RETENTION.deletedConvGraceDays * 86_400_000
    janitor.deletedConvs = () => [{ rel: `${DIR.channels}/${ch.token}`, deletedAt: deletedAt() - grace - 60_000 }]
    await janitor.sweep()
    expect(existsSync(dir)).toBe(true)

    // Both clocks past the grace: now it goes.
    const old = (Date.now() - grace - 3_600_000) / 1000
    utimesSync(dir, old, old)
    await janitor.sweep()
    expect(existsSync(dir)).toBe(false)
  }, 60_000)

  it('publishes this build in the beacon, and reads an unknown field without flinching', async () => {
    // 1.2 writers name their version so peers on an older build can raise their
    // own update banner.
    const versioned = new BeaconWriter(alice.session, () => '1.2.0')
    await versioned.bump('startup')
    const seen = (await bob.reader.poll()).find((o) => o.content.device === alice.identity.deviceId)
    expect(seen?.verified).toBe(true)
    expect(seen?.content.app).toBe('1.2.0')

    // And the other half of the rollout story: `readOne` does no schema
    // validation, so a beacon from a *newer* build — one carrying fields this
    // code has never heard of — still verifies and still drives everything it
    // does understand. This is the property the 1.1 clients rely on to ignore
    // `grpSealed`/`app`, pinned from the other direction.
    const s = alice.session
    const seq = 9999
    const content = {
      device: s.deviceId,
      name: s.displayName,
      seq: seqToBase36(seq),
      hlc: s.io.calibratedNow(),
      presence: { state: 'online', status: '', idleSec: 0 },
      heads: {},
      cursors: {},
      app: '1.3.0',
      // Two shapes 1.2 has no idea about: an unknown scalar and an unknown map.
      somethingNew: 'from the future',
      futureSealed: { AAAA: 'opaque' },
    } as unknown as BeaconContent
    const signed = signRecord(s.identity, DST.record, content)
    const rel = `${DIR.beacon}/${beaconFileName(s.deviceId, seq)}`
    const aad = buildAad('pres', rel, s.deviceId8)
    await s.io.publish(
      rel,
      encryptRecord(s.keys.kPres, KID.pres(s.proto.epoch), Buffer.from(JSON.stringify(signed)), aad),
    )

    const future = (await bob.reader.poll()).find((o) => o.content.device === alice.identity.deviceId)
    expect(future?.verified).toBe(true)
    expect(future?.content.app).toBe('1.3.0')
    expect((future?.content as unknown as Record<string, unknown>).somethingNew).toBe('from the future')
  }, 60_000)

  it('flags a new device claiming an existing display name', async () => {
    const mallory = await makeClient(root, 'correct horse battery staple', 'Alice') // same name!
    await bob.session.roster.refresh()
    const pin = bob.session.roster.getPin(mallory.identity.deviceId)
    expect(pin?.trust).toBe('flagged')
    // The real Alice keeps her clean pin
    expect(bob.session.roster.getPin(alice.identity.deviceId)?.trust).toBe('pinned')
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Private groups (1.2). Three clients, because the interesting properties are
// all about the third one: what a non-member can see (nothing), what a removed
// member can read after the rotation (nothing new), what a member who ingests a
// post-rotation event before the rekey does with it (parks it), and what the
// owner has to tell the person they removed (that it happened at all).
//
// The tests run in order and build one story, but nothing here reads
// `views()[0]`: the group under test is captured once, and every later lookup
// goes by name or conv id, so inserting a test cannot silently repoint the one
// after it at a different group.

describe('private groups over a shared folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'semaphore-groups-'))
  const pass = 'correct horse battery staple'
  let alice: Client
  let bob: Client
  let carol: Client
  /** The group the main story happens in — set by the first test. */
  let conv: ConvId

  const groupNamed = (c: Client, name: string): GroupView | undefined => c.groups.views().find((g) => g.name === name)
  const groupIn = (c: Client, target: ConvId): GroupView | undefined => c.groups.views().find((g) => g.conv === target)
  const keyOf = (c: Client, target: ConvId, newest = 0): string => c.groups.keys(target)[newest].toString('base64')

  /** Publish a raw `grp` notice from one client into its DM with another. */
  async function publishGrpNotice(
    from: Client,
    to: Client,
    kind: GrpPayload['kind'],
    data: GrpPayload['data'],
  ): Promise<void> {
    const dm = dmBetween(from, to)
    await from.events.publish(dm, 'grp', { t: 'grp', conv: dm, kind, data } satisfies GrpPayload)
  }

  /** An invite payload that is valid in every way the caller doesn't override. */
  function inviteData(over: Partial<GroupInviteData> = {}): GroupInviteData {
    return {
      groupId: randomBytes(4).toString('hex'),
      name: 'Planted',
      owner: alice.identity.deviceId,
      members: [alice.identity.deviceId, bob.identity.deviceId, carol.identity.deviceId],
      epoch: 1,
      key: randomBytes(32).toString('base64'),
      createdAt: Date.now(),
      ...over,
    }
  }

  /**
   * Write one event into a group's log with a chosen (here: back-dated) stem.
   * The HLC only ever moves forward, so a client cannot produce an old stem by
   * accident — which is the point: a removed device *can* do this deliberately.
   */
  async function publishBackdated(client: Client, target: ConvId, atMs: number, text: string): Promise<string> {
    client.session.hlc.lastMs = atMs - 1
    client.session.hlc.ctr = 0
    const io = client.session.io
    const realNow = io.calibratedNow.bind(io)
    io.calibratedNow = () => atMs
    try {
      return await sendMessage(client, target, text)
    } finally {
      io.calibratedNow = realNow
    }
  }

  beforeAll(async () => {
    alice = await makeClient(root, pass, 'Alice')
    bob = await makeClient(root, pass, 'Bob')
    carol = await makeClient(root, pass, 'Carol')
    for (const c of [alice, bob, carol]) {
      await c.session.roster.refresh()
      c.session.refreshDms()
    }
  }, 90_000)

  it('creates a group, delivers the key by DM, and stays invisible to everyone else', async () => {
    const view = await alice.groups.create('Ops crew', [bob.identity.deviceId])
    expect(view.role).toBe('owner')
    expect(view.epoch).toBe(1)
    conv = view.conv

    // Bob learns about it from the DM invite alone — no group discovery step.
    expect(bob.groups.views()).toHaveLength(0)
    await syncInvites(bob, alice)
    const bobView = groupIn(bob, conv)
    expect(bobView?.name).toBe('Ops crew')
    expect(bobView?.role).toBe('member')
    expect(bob.groupPushes.length).toBeGreaterThan(0)

    // The invite is a `grp` event, not a `sys` one: a 1.1 client's EVENT_RE
    // cannot parse `.grp.e1` at all, so it skips the file instead of drawing a
    // blank row in the middle of the DM (its `sysLine` has no default branch).
    const dm = dmBetween(bob, alice)
    const invite = bob.events.getEvents(dm).find((e) => e.type === 'grp')
    expect(invite).toBeDefined()
    expect((invite!.payload as GrpPayload).kind).toBe('group-invite')
    // A 1.2 reader still gets an ordinary sys row out of it.
    const row = materialize(bob.events.getEvents(dm)).sys.find((r) => r.kind === 'group-invite')
    expect(row?.data.name).toBe('Ops crew')

    // On the share: one opaque directory that names nothing.
    const dirs = readdirSync(join(root, DIR.groups))
    expect(dirs).toHaveLength(1)
    expect(dirs[0]).not.toContain(view.groupId)
    expect(dirs[0]).not.toContain(alice.identity.deviceId.slice(0, 8))
    expect(bob.groups.token(conv)).toBe(dirs[0])

    // Carol is in the same team with the same passphrase and still cannot
    // compute the token, resolve the conversation, or read a single event.
    await syncInvites(carol, alice)
    expect(carol.groups.views()).toHaveLength(0)
    expect(carol.groups.convForToken(dirs[0])).toBeNull()
    expect(carol.session.convInfo(conv)).toBeNull()
    expect(await carol.events.catchUp(conv)).toBe(0)
    expect(carol.events.getEvents(conv)).toHaveLength(0)
  }, 90_000)

  it('advertises an invite in its own beacon ring, never in the DM heads a 1.1 peer parses', async () => {
    const view = await alice.groups.create('Beacon invites', [bob.identity.deviceId])
    await alice.writer.bump('event')

    const seen = (await bob.reader.poll()).find((o) => o.content.device === alice.identity.deviceId)!
    const token = dmBetween(bob, alice).slice(3)
    const section = seen.dmSections.get(token)!
    // `heads` is the field a 1.1 client reads and feeds to its own ingest, and
    // it holds 16 names: a `.grp.e1` in there is skipped by that client (its
    // ingest drops a name it cannot parse before the gap check), but it would be
    // sitting in a slot this DM's real `msg` heads need. Own ring, own budget.
    expect(section.heads.some((h) => h.endsWith('.grp.e1'))).toBe(false)
    expect(section.grpHeads?.some((h) => h.endsWith('.grp.e1'))).toBe(true)

    // A 1.2 reader ingests from the new ring and adopts the group with no scan.
    await bob.events.ingestHeads(dmBetween(bob, alice), section.grpHeads!)
    await bob.groups.settle()
    expect(groupIn(bob, view.conv)?.name).toBe('Beacon invites')
  }, 90_000)

  it('round-trips messages and folds a rename by a member', async () => {
    await sendMessage(alice, conv, 'kickoff at 10')
    await bob.events.catchUp(conv)
    expect(textsIn(bob, conv)).toContain('kickoff at 10')

    await bob.groups.rename(conv, '  Release   crew ')
    expect(groupIn(bob, conv)?.name).toBe('Release crew')
    await alice.events.catchUp(conv)
    expect(groupIn(alice, conv)?.name).toBe('Release crew')

    // Everything on the share is encrypted under the group key: the team key
    // that opens channels opens nothing here.
    const token = alice.groups.token(conv)!
    const day = readdirSync(join(root, DIR.groups, token, 'events'))[0]
    const files = readdirSync(join(root, DIR.groups, token, 'events', day))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const buf = readFileSync(join(root, DIR.groups, token, 'events', day, f))
      expect(recordKid(buf)).toMatch(/^grp\/[0-9A-Z]{20}\/e1$/)
    }
  }, 90_000)

  it('adds a member, who then reads the history the epoch-1 key covers', async () => {
    await alice.groups.addMembers(conv, [carol.identity.deviceId])
    expect(groupIn(alice, conv)?.members).toContain(carol.identity.deviceId)

    await syncInvites(carol, alice)
    const carolView = groupIn(carol, conv)
    expect(carolView?.name).toBe('Release crew')
    expect(carolView?.members).toContain(bob.identity.deviceId)
    await carol.events.catchUp(conv)
    expect(textsIn(carol, conv)).toContain('kickoff at 10')

    await bob.events.catchUp(conv)
    expect(groupIn(bob, conv)?.members).toContain(carol.identity.deviceId)
  }, 90_000)

  it('a removal rotates the key: the removed device cannot read what comes next', async () => {
    await alice.groups.removeMember(conv, carol.identity.deviceId)
    expect(groupIn(alice, conv)?.epoch).toBe(2)
    expect(groupIn(alice, conv)?.members).not.toContain(carol.identity.deviceId)

    const postId = await sendMessage(alice, conv, 'only for the two of us')

    // Carol still holds epoch 1, and has not read the DM where the owner tells
    // her what happened. The new records name epoch 2 in their kid, so she
    // parks them (a key might yet arrive) and reads nothing.
    await carol.events.catchUp(conv)
    await carol.groups.settle()
    expect(carol.events.has(conv, postId)).toBe(false)
    expect(carol.events.parkedCount(conv)).toBeGreaterThan(0)
    expect(textsIn(carol, conv)).not.toContain('only for the two of us')
    expect(groupIn(carol, conv)?.epoch).toBe(1)
  }, 90_000)

  it('skips a beacon section sealed by someone who is no longer in the group', async () => {
    // Carol still holds the epoch-1 key and her client still seals a section
    // for the group. Holding a key is not membership: the fold is.
    const id = await sendMessage(carol, conv, 'still shouting into it')
    carol.writer.noteOwnEvent(conv, `${id}.msg.e1`)
    await carol.writer.bump('event')

    const token = alice.groups.token(conv)!
    const seen = (await alice.reader.poll()).find((o) => o.content.device === carol.identity.deviceId)!
    expect(Object.keys(seen.content.grpSealed ?? {})).toContain(token) // she really did seal one
    expect(seen.grpSections?.get(token)).toBeUndefined() // and it is skipped
    expect(alice.events.has(conv, id)).toBe(false)
  }, 90_000)

  it('a remaining member that ingests the post-rotation event first parks it, then reads it', async () => {
    // Bob deliberately reads the group log BEFORE the rekey DM.
    await bob.events.catchUp(conv)
    expect(groupIn(bob, conv)?.epoch).toBe(1)
    expect(bob.events.parkedCount(conv)).toBeGreaterThan(0)
    expect(textsIn(bob, conv)).not.toContain('only for the two of us')

    // A parked head is not a gap: we know exactly which file it is and what it
    // is waiting for, so advertising it again costs no directory listing.
    const parkedHead = `${
      alice.events
        .getEvents(conv)
        .map((e) => e.id)
        .sort()
        .reverse()[0]
    }.msg.e1`
    bob.session.io.resetStats()
    await bob.events.ingestHeads(conv, [parkedHead])
    expect(bob.session.io.stats().byOp.readdir ?? 0).toBe(0)
    // A head that is genuinely missing still falls back to the day scan.
    bob.session.io.resetStats()
    await bob.events.ingestHeads(conv, [`9999999999999-0001-${alice.identity.deviceId.slice(0, 8)}.msg.e1`])
    expect(bob.session.io.stats().byOp.readdir ?? 0).toBeGreaterThan(0)

    // Now the rekey lands: the parked files are replayed, not quarantined.
    await syncInvites(bob, alice)
    expect(groupIn(bob, conv)?.epoch).toBe(2)
    expect(bob.events.parkedCount(conv)).toBe(0)
    expect(textsIn(bob, conv)).toContain('only for the two of us')
    expect(groupIn(bob, conv)?.members).not.toContain(carol.identity.deviceId)

    // And bob can write under the new epoch, which alice reads.
    await sendMessage(bob, conv, 'agreed')
    await alice.events.catchUp(conv)
    expect(textsIn(alice, conv)).toContain('agreed')
  }, 90_000)

  it('ignores a removed member still writing under the retired key', async () => {
    // Carol's client has not read her DM yet, so as far as it knows she is
    // still in the group and writes into it with the epoch-1 key.
    expect(carol.session.convInfo(conv)?.kid).toMatch(/\/e1$/)
    const stale = await sendMessage(carol, conv, 'am I still here?')

    for (const reader of [alice, bob]) {
      await reader.events.catchUp(conv)
      expect(reader.events.has(conv, stale)).toBe(false)
      expect(textsIn(reader, conv)).not.toContain('am I still here?')
    }
    // Her messages from *before* the rotation are still perfectly readable.
    expect(textsIn(alice, conv)).toContain('kickoff at 10')
  }, 90_000)

  it('a back-dated filename does not walk a removed member past the rotation', async () => {
    // The stem is chosen by whoever writes the file, so comparing it against
    // the rotation point is comparing a rule to the thing it is meant to
    // constrain. What decides is when the file actually landed on the share.
    const token = alice.groups.token(conv)!
    const rotatedAt = Number(
      alice.events
        .getEvents(conv)
        .filter((e) => e.type === 'sys' && (e.payload as SysPayload).kind === 'group-member-removed')
        .map((e) => e.id)[0]
        .slice(0, 13),
    )

    const backdated = await publishBackdated(carol, conv, rotatedAt - 2 * 86_400_000, 'back-dated and still out')
    const older = await publishBackdated(carol, conv, rotatedAt - 3 * 86_400_000, 'genuinely from before')
    const olderRel = join(
      root,
      DIR.groups,
      token,
      'events',
      dayShard(rotatedAt - 3 * 86_400_000),
      `${older}.msg.e1`,
    )
    // The second file is what it claims to be: written before the rotation.
    const t = (rotatedAt - 3 * 86_400_000) / 1000
    utimesSync(olderRel, t, t)

    await alice.events.catchUp(conv)
    expect(alice.events.has(conv, backdated)).toBe(false)
    expect(textsIn(alice, conv)).not.toContain('back-dated and still out')
    // History still opens — the rule is about when someone wrote, not who.
    expect(alice.events.has(conv, older)).toBe(true)
    expect(textsIn(alice, conv)).toContain('genuinely from before')
  }, 90_000)

  it('tells the removed device over their DM, and it drops the group locally', async () => {
    // The removal event itself lives under the new key, so this notice is the
    // only thing that can ever reach the device that was removed.
    await syncInvites(carol, alice)
    expect(groupIn(carol, conv)).toBeUndefined()
    expect(carol.groups.views().some((g) => g.conv === conv)).toBe(false)
    expect(carol.session.convInfo(conv)).toBeNull()
    expect(carol.groups.convForToken(alice.groups.token(conv)!)).toBeNull()

    const dm = dmBetween(carol, alice)
    const notice = carol.events.getEvents(dm).find((e) => e.type === 'grp' && (e.payload as GrpPayload).kind === 'group-removed')
    expect(notice).toBeDefined()
    // It carries no key material at all — just enough to drop the group and
    // name it in the DM row.
    const data = (notice!.payload as GrpPayload).data as unknown as Record<string, unknown>
    expect(data.key).toBeUndefined()
    expect(data.key1).toBeUndefined()
    expect(data.name).toBe('Release crew')
    const row = materialize(carol.events.getEvents(dm)).sys.find((r) => r.kind === 'group-removed')
    expect(row?.data.name).toBe('Release crew')
  }, 90_000)

  it('seals group heads in the beacon: members ingest from them, others see a blob', async () => {
    const id = await sendMessage(alice, conv, 'via the beacon')
    alice.writer.noteOwnEvent(conv, `${id}.msg.e1`)
    await alice.writer.bump('event')

    const seen = (await bob.reader.poll()).find((o) => o.content.device === alice.identity.deviceId)!
    expect(seen.verified).toBe(true)
    // The plain heads map never names a group conversation.
    expect(Object.keys(seen.content.heads)).not.toContain(conv)
    const token = alice.groups.token(conv)!
    expect(Object.keys(seen.content.grpSealed ?? {})).toContain(token)
    expect(seen.grpSections?.get(token)?.heads).toContain(`${id}.msg.e1`)
    await bob.events.ingestHeads(conv, seen.grpSections!.get(token)!.heads)
    expect(bob.events.has(conv, id)).toBe(true)

    // Carol reads the same beacon file and gets nothing out of that section.
    const carolSees = (await carol.reader.poll()).find((o) => o.content.device === alice.identity.deviceId)!
    expect(Object.keys(carolSees.content.grpSealed ?? {})).toContain(token)
    expect(carolSees.grpSections?.get(token)).toBeUndefined()
  }, 90_000)

  it('ignores a group-deleted from a non-owner', async () => {
    const view = await alice.groups.create('Doomed', [bob.identity.deviceId])
    await syncInvites(bob, alice)

    // Bob is a member, not the owner: his tombstone counts for nobody.
    await bob.events.publish(view.conv, 'sys', {
      t: 'sys',
      conv: view.conv,
      kind: 'group-deleted',
      data: {},
    } satisfies SysPayload)
    expect(groupIn(bob, view.conv)).toBeDefined()
    await alice.events.catchUp(view.conv)
    expect(groupIn(alice, view.conv)).toBeDefined()
  }, 90_000)

  it('a delete by the owner hides the group everywhere, and the janitor clears the dir after the grace', async () => {
    const doomed = groupNamed(alice, 'Doomed')!.conv
    const token = alice.groups.token(doomed)!
    const dir = join(root, DIR.groups, token)
    expect(existsSync(dir)).toBe(true)

    await alice.groups.remove(doomed)
    expect(groupIn(alice, doomed)).toBeUndefined()
    expect(alice.session.convInfo(doomed)).toBeNull()

    await bob.events.catchUp(doomed)
    expect(groupIn(bob, doomed)).toBeUndefined()

    const janitor = new Janitor(alice.session)
    janitor.deletedConvs = () => alice.groups.deletedDirs()
    await janitor.sweep()
    expect(existsSync(dir)).toBe(true) // still inside the grace period

    // Tombstone aged, directory not: the sweep still waits (the timestamp in a
    // tombstone is its writer's claim, the directory's mtime is the share's).
    const grace = RETENTION.deletedConvGraceDays * 86_400_000
    janitor.deletedConvs = () => alice.groups.deletedDirs().map((d) => ({ ...d, deletedAt: d.deletedAt - grace - 60_000 }))
    await janitor.sweep()
    expect(existsSync(dir)).toBe(true)

    const old = (Date.now() - grace - 3_600_000) / 1000
    utimesSync(dir, old, old)
    await janitor.sweep()
    expect(existsSync(dir)).toBe(false)
  }, 90_000)

  it('leaving drops the keys locally and the membership everywhere', async () => {
    const view = await alice.groups.create('Leavers', [bob.identity.deviceId])
    await syncInvites(bob, alice)

    await bob.groups.leave(view.conv)
    expect(groupIn(bob, view.conv)).toBeUndefined()
    expect(bob.session.convInfo(view.conv)).toBeNull()
    expect(bob.events.getEvents(view.conv)).toHaveLength(0)

    await alice.events.catchUp(view.conv)
    expect(groupIn(alice, view.conv)?.members).toEqual([alice.identity.deviceId])
  }, 90_000)

  // -------------------------------------------------------------------------
  // What a client refuses to believe. Everything below writes a *valid,
  // correctly signed* notice into a real DM log — the attacker here is a
  // teammate in good standing, which is exactly who these rules are about.

  it('never lets an unverified record into a group log, where a channel would show a chip', async () => {
    // A record nobody can verify is a record with no author, and every rule a
    // group has — who may rename, who may remove, whose tombstone counts, whose
    // retired-key write is refused — is a statement about the author. A channel
    // is bounded by the team key and shows the unverified chip instead; a group
    // holder of a leaked epoch key would otherwise get to write as the owner.
    const view = await alice.groups.create('Signatures', [bob.identity.deviceId])
    await syncInvites(bob, alice)
    const ghost = randomBytes(16).toString('hex')
    const stem = `${String(Date.now()).padStart(13, '0')}-0001-${ghost.slice(0, 8)}`

    const forge = async (info: { key: Buffer; eventsDir: string; kid: string; scope: string }): Promise<void> => {
      const rel = `${info.eventsDir}/${dayShard(Date.now())}/${stem}.msg.e1`
      const body: MsgPayload = {
        t: 'msg',
        conv: 'chan:0' as ConvId,
        author: { device: ghost, name: 'Nobody' },
        senderSeq: 1,
        sentWall: Date.now(),
        body: { kind: 'text', text: 'signed by nobody' },
      }
      const signed = { p: body, by: ghost, sig: randomBytes(64).toString('base64') }
      const aad = buildAad(info.scope, rel, stem)
      await alice.session.io.publish(rel, encryptRecord(info.key, info.kid, Buffer.from(JSON.stringify(signed)), aad))
    }

    await forge(alice.session.convInfo(view.conv)!)
    await bob.events.catchUp(view.conv)
    expect(bob.events.has(view.conv, stem)).toBe(false)
    expect(textsIn(bob, view.conv)).not.toContain('signed by nobody')

    // The same record in a channel: ingested, flagged, and rendered with a chip.
    const ch = await alice.session.createChannel('unsigned')
    await forge(alice.session.convInfo(`chan:${ch.channelId}`)!)
    await bob.session.loadChannels()
    await bob.events.catchUp(`chan:${ch.channelId}`)
    const got = bob.events.getEvents(`chan:${ch.channelId}`).find((e) => e.id === stem)
    expect(got).toBeDefined()
    expect(got!.verified).toBe(false)
  }, 90_000)

  it('reports a group whose invites did not all go out, without pretending it failed', async () => {
    // The group is on the share the moment `group-created` lands. Telling the
    // caller "creation failed" would be a lie, and would invite them to make a
    // second group; they are told what is missing and how to finish it.
    const session = alice.session
    const realDmFor = session.dmFor.bind(session)
    session.dmFor = (peer: string) => (peer === carol.identity.deviceId ? null : realDmFor(peer))
    let thrown: unknown = null
    try {
      await alice.groups.create('Half delivered', [bob.identity.deviceId, carol.identity.deviceId])
    } catch (err) {
      thrown = err
    } finally {
      session.dmFor = realDmFor
    }

    expect((thrown as Error | null)?.message).toBe('group created; 1 invite failed — use Add people to retry')
    const made = groupNamed(alice, 'Half delivered')!
    expect(made).toBeDefined()
    expect((thrown as GroupPartialError).view.conv).toBe(made.conv)
    expect((thrown as GroupPartialError).failed).toEqual([carol.identity.deviceId])
    // The people whose invite did go out have the group; the one who missed out
    // gets it from "Add people", which re-sends the current epoch key.
    await syncInvites(bob, alice)
    expect(groupIn(bob, made.conv)).toBeDefined()
    await syncInvites(carol, alice)
    expect(groupIn(carol, made.conv)).toBeUndefined()
    await alice.groups.addMembers(made.conv, [carol.identity.deviceId])
    await syncInvites(carol, alice)
    expect(groupIn(carol, made.conv)?.name).toBe('Half delivered')
  }, 90_000)

  it('lets only the owner add people, in the command and in the fold', async () => {
    // Membership is owner-managed end to end. A member's "Add people" would
    // send an invite the newcomer refuses (adoption requires the owner's
    // signature), so it is refused up front rather than silently going
    // nowhere — and a modified client that publishes the event anyway cannot
    // pad the member list with people who hold no key either.
    const view = await alice.groups.create('Owner managed', [bob.identity.deviceId])
    await syncInvites(bob, alice)
    const target = view.conv

    await expect(bob.groups.addMembers(target, [carol.identity.deviceId])).rejects.toThrow('not-owner')
    expect(groupIn(alice, target)?.members).not.toContain(carol.identity.deviceId)

    // Published by hand, correctly signed, by a member in good standing.
    await bob.events.publish(target, 'sys', {
      t: 'sys',
      conv: target,
      kind: 'group-members-added',
      data: { members: [carol.identity.deviceId] },
    } satisfies SysPayload)
    await alice.events.catchUp(target)
    expect(groupIn(alice, target)?.members).not.toContain(carol.identity.deviceId)
    expect(groupIn(bob, target)?.members).not.toContain(carol.identity.deviceId)

    // The owner doing it works, and the newcomer adopts the group.
    await alice.groups.addMembers(target, [carol.identity.deviceId])
    expect(groupIn(alice, target)?.members).toContain(carol.identity.deviceId)
    await syncInvites(carol, alice)
    expect(groupIn(carol, target)?.name).toBe('Owner managed')
  }, 90_000)

  it('refuses an invite that names a third person as owner', async () => {
    // Nothing on the share proves who owns a group, so the only claim worth
    // anything is a device's claim about itself. Otherwise Bob could hand Carol
    // a "group of Alice's" whose key only he holds.
    await publishGrpNotice(bob, carol, 'group-invite', inviteData({ name: 'Planted', owner: alice.identity.deviceId }))
    await syncInvites(carol, bob)
    expect(groupNamed(carol, 'Planted')).toBeUndefined()
  }, 90_000)

  it('refuses an invite from a sender who is not in the group it describes', async () => {
    // Both rules bite here, and both matter: the sender is not among the
    // members they list, and they are not the owner they name. (An invite whose
    // owner *is* its sender can never omit them — the owner is added to the
    // member list on arrival — which is why this case only exists when the two
    // differ.)
    await publishGrpNotice(
      bob,
      carol,
      'group-invite',
      inviteData({
        name: 'Ownerless',
        owner: alice.identity.deviceId,
        members: [alice.identity.deviceId, carol.identity.deviceId],
      }),
    )
    await syncInvites(carol, bob)
    expect(groupNamed(carol, 'Ownerless')).toBeUndefined()
  }, 90_000)

  it('refuses a rekey from a member who is not the owner, and keeps a member invite as key material only', async () => {
    const view = await alice.groups.create('Rekeys', [bob.identity.deviceId, carol.identity.deviceId])
    await syncInvites(bob, alice)
    await syncInvites(carol, alice)
    const target = view.conv

    // A member announcing a new epoch would strand everyone on a key only they
    // hold. Only the owner rotates.
    await publishGrpNotice(
      bob,
      carol,
      'group-rekey',
      inviteData({
        groupId: view.groupId,
        name: 'Rekeys',
        owner: alice.identity.deviceId,
        members: [alice.identity.deviceId, bob.identity.deviceId, carol.identity.deviceId],
        epoch: 2,
        key: randomBytes(32).toString('base64'),
        key1: keyOf(bob, target),
      }),
    )
    await syncInvites(carol, bob)
    expect(groupIn(carol, target)?.epoch).toBe(1)
    expect(carol.groups.keys(target)).toHaveLength(1)

    // And a member's *invite* — the thing "Add people" sends — hands over the
    // key without handing over the group's membership: a snapshot from someone
    // with no authority over the fold must not re-admit or rename anything.
    await publishGrpNotice(
      bob,
      carol,
      'group-invite',
      inviteData({
        groupId: view.groupId,
        name: 'Bob Was Here',
        owner: alice.identity.deviceId,
        members: [alice.identity.deviceId, bob.identity.deviceId, carol.identity.deviceId, 'f'.repeat(32)],
        epoch: 1,
        key: keyOf(bob, target),
      }),
    )
    await syncInvites(carol, bob)
    const after = groupIn(carol, target)!
    expect(after.name).toBe('Rekeys')
    expect(after.members).not.toContain('f'.repeat(32))
  }, 90_000)

  it('invites a newcomer at a later epoch: key1 finds the directory, the skipped epoch stays shut', async () => {
    const view = await alice.groups.create('Epochs', [bob.identity.deviceId, carol.identity.deviceId])
    const target = view.conv
    await syncInvites(bob, alice)
    await syncInvites(carol, alice)

    await sendMessage(alice, target, 'under epoch one')
    await alice.groups.removeMember(target, bob.identity.deviceId)
    await sendMessage(alice, target, 'under epoch two')
    await alice.groups.removeMember(target, carol.identity.deviceId)
    await sendMessage(alice, target, 'under epoch three')
    expect(groupIn(alice, target)?.epoch).toBe(3)

    // Bob is invited back at epoch 3. His invite carries `key1` as well as the
    // current key — without it he could not even name the directory, since the
    // token is HMAC(key1, …). It does not carry epoch 2.
    await syncInvites(bob, alice) // learns he was removed, drops the group
    expect(groupIn(bob, target)).toBeUndefined()
    await alice.groups.addMembers(target, [bob.identity.deviceId])
    await syncInvites(bob, alice)

    const back = groupIn(bob, target)!
    expect(back.epoch).toBe(3)
    expect(bob.groups.token(target)).toBe(alice.groups.token(target))
    await bob.events.catchUp(target)
    const texts = textsIn(bob, target)
    expect(texts).toContain('under epoch three')
    expect(texts).toContain('under epoch one') // key1 opens the history it covers
    expect(texts).not.toContain('under epoch two') // an epoch he was never given
    // And nothing from that epoch is parked: no key for it is ever coming.
    expect(bob.events.parkedCount(target)).toBe(0)
  }, 90_000)

  it('parks a plausible unknown epoch, refuses an absurd one, and stops at the cap', async () => {
    const view = await alice.groups.create('Parking', [bob.identity.deviceId])
    const target = view.conv
    await syncInvites(bob, alice)
    const token = alice.groups.token(target)!
    const day = dayShard(Date.now())
    const junk = randomBytes(32)

    // A file under an epoch just above ours is a rotation that has not reached
    // us yet: park it. One naming epoch 99 is nobody's rotation.
    const write = async (i: number, epoch: number): Promise<string> => {
      const stem = `${String(1_700_000_000_000 + i).padStart(13, '0')}-0001-${alice.identity.deviceId.slice(0, 8)}`
      const rel = `${DIR.groups}/${token}/events/${day}/${stem}.msg.e1`
      const aad = buildAad('grp', rel, stem)
      await alice.session.io.publish(rel, encryptRecord(junk, KID.grp(token, epoch), Buffer.from('x'), aad))
      return stem
    }
    const absurd = await write(0, 99)
    const plausible: string[] = []
    for (let i = 1; i <= 505; i++) plausible.push(await write(i, 2))

    await bob.events.catchUp(target)
    expect(bob.events.has(target, absurd)).toBe(false)
    // Capped: a peer inventing epochs cannot make this device remember an
    // unbounded list of filenames on its say-so.
    expect(bob.events.parkedCount(target)).toBe(500)
    expect(bob.events.parkedCount(target)).toBeLessThan(plausible.length)
  }, 90_000)

  // -------------------------------------------------------------------------
  // A real restart: a fresh EventStore and a fresh GroupService over the same
  // session and the same secret store, which is what the next launch actually
  // does. Both swap themselves in as the session's `grp:` provider (the
  // GroupService constructor does), so each test here puts the live one back.

  describe('after a restart', () => {
    let restarted: GroupService | null = null
    let owner: Client | null = null

    beforeEach(() => {
      restarted = null
      owner = null
    })

    afterEach(() => {
      // Whichever client the test restarted, hand its session back to the
      // service the rest of the file is using.
      if (owner) owner.session.groups = owner.groups
      restarted = null
      owner = null
    })

    it('brings keys and folded state back from the secret store', () => {
      owner = alice
      restarted = new GroupService(alice.session, {
        events: alice.events,
        noteOwnEvent: () => {},
        pushGroups: () => {},
      })
      const view = restarted.views().find((g) => g.conv === conv)
      expect(view?.name).toBe('Release crew')
      expect(view?.epoch).toBe(2)
      expect(restarted.info(conv)?.kid).toBe(alice.groups.info(conv)?.kid)
    }, 90_000)

    it('replays events parked before the restart once the rekey arrives after it', async () => {
      const view = await alice.groups.create('Restarts', [bob.identity.deviceId, carol.identity.deviceId])
      const target = view.conv
      await syncInvites(bob, alice)
      await syncInvites(carol, alice)

      // The rotation happens while Bob is not running.
      await alice.groups.removeMember(target, carol.identity.deviceId)
      const postId = await sendMessage(alice, target, 'after bob went away')

      // Bob comes back: new EventStore, new GroupService, same session and the
      // same secrets. Nothing is parked yet — the parking is in the store that
      // just went away with the process.
      owner = bob
      const events = new EventStore(bob.session)
      restarted = new GroupService(bob.session, {
        events,
        noteOwnEvent: () => {},
        pushGroups: () => {},
      })
      events.onEvent((c, ev) => restarted!.onEvent(c, ev))
      expect(restarted.views().find((g) => g.conv === target)?.epoch).toBe(1)

      // He reads the group first, so the post-rotation records park.
      await events.catchUp(target)
      expect(events.has(target, postId)).toBe(false)
      expect(events.parkedCount(target)).toBeGreaterThan(0)

      // Then the DM catch-up delivers the rekey, and the parked files replay.
      await events.catchUp(dmBetween(bob, alice))
      await restarted.settle()
      expect(restarted.views().find((g) => g.conv === target)?.epoch).toBe(2)
      expect(events.parkedCount(target)).toBe(0)
      expect(events.has(target, postId)).toBe(true)
      expect(materialize(events.getEvents(target)).messages.map((m) => m.body.text)).toContain('after bob went away')
    }, 90_000)
  })
})

// ---------------------------------------------------------------------------
// Polls over the share (1.3). The protocol question here is not the tally — it
// is the beacon. `heads` is a 16-name ring per conversation, and votes are the
// one event type that arrives in a burst: a poll with a dozen voters would push
// every `msg` filename out of the ring before a 1.2 peer next polls, and that
// peer — which ingests from `heads` and skips the names it cannot parse, gap
// logic untouched — would stop hearing about real messages there and wait for
// its next bounded day scan instead. `heads2` is a field it has never heard of:
// its own budget for votes, and nothing at all for that reader to do.

describe('poll votes over a shared folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'semaphore-polls-'))
  const pass = 'correct horse battery staple'
  let alice: Client
  let bob: Client

  /** Exactly the filename pattern a 1.2 client compiles — no `vot` in it. */
  const EVENT_RE_1_2 = /^(\d{13})-(\d{4})-([0-9a-f]{8})\.(msg|edt|del|rct|pin|sys|prv|cal|prs|grp)\.e1$/

  const poll: PollBody = {
    question: 'Ship on Friday?',
    options: [
      { id: 'yes', text: 'Yes' },
      { id: 'no', text: 'No' },
      { id: 'abstain', text: 'Abstain' },
    ],
    multi: false,
    anonymous: false,
    decision: true,
  }

  async function sendPoll(client: Client, conv: ConvId): Promise<string> {
    const ev = await client.events.publish(conv, 'msg', {
      t: 'msg',
      conv,
      author: { device: client.identity.deviceId, name: client.session.displayName },
      senderSeq: client.session.nextSenderSeq(conv),
      sentWall: Date.now(),
      body: { kind: 'poll', text: pollFallbackText(poll.question), poll },
    } satisfies MsgPayload)
    client.writer.noteOwnEvent(conv, `${ev.id}.msg.e1`)
    return ev.id
  }

  async function vote(client: Client, conv: ConvId, target: string, choice: string[]): Promise<string> {
    const ev = await client.events.publish(conv, 'vot', { t: 'vot', conv, target, choice } satisfies VotPayload)
    client.writer.noteOwnEvent(conv, `${ev.id}.vot.e1`)
    return ev.id
  }

  beforeAll(async () => {
    alice = await makeClient(root, pass, 'Alice')
    bob = await makeClient(root, pass, 'Bob')
    for (const c of [alice, bob]) {
      await c.session.roster.refresh()
      c.session.refreshDms()
    }
  }, 90_000)

  it('rides heads2 in a channel: the poller ingests it with no directory scan', async () => {
    const ch = await alice.session.createChannel('poll-heads')
    const conv: ConvId = `chan:${ch.channelId}`
    const target = await sendPoll(alice, conv)
    await alice.writer.bump('event')

    // Bob is level with the poll itself before the vote, so nothing below can
    // be explained away by a catch-up he owed anyway.
    await bob.session.loadChannels()
    await bob.events.catchUp(conv)
    expect(bob.events.has(conv, target)).toBe(true)

    const voteId = await vote(alice, conv, target, ['yes'])
    await alice.writer.bump('event')

    const obs = (await bob.reader.poll()).find((o) => o.content.device === alice.identity.deviceId)!
    expect(obs.verified).toBe(true)
    expect(obs.content.heads[conv].some((h) => h.endsWith('.vot.e1'))).toBe(false)
    expect(obs.content.heads[conv].every((h) => EVENT_RE_1_2.test(h))).toBe(true)
    expect(obs.content.heads2?.[conv]).toContain(`${voteId}.vot.e1`)

    // The read side, end to end: one beacon observation, no sweep, and the
    // vote is in Bob's log and on his copy of the poll. The point of `heads2` is
    // that this costs a readdir of beacon/ and one file read — so the directory
    // scan `ingestHeads` falls back to on a gap must not happen at all.
    const catchUp = vi.spyOn(bob.events, 'catchUp')
    const poller = new Poller(bob.session, bob.events)
    ;(poller as unknown as { lastSweepAt: number }).lastSweepAt = Date.now()
    await poller.tick()
    expect(catchUp).not.toHaveBeenCalled()
    catchUp.mockRestore()
    expect(bob.events.has(conv, voteId)).toBe(true)
    expect(materialize(bob.events.getEvents(conv)).messages.find((m) => m.id === target)?.votes).toEqual({
      [alice.identity.deviceId]: ['yes'],
    })
  }, 90_000)

  it('rides heads2 inside the sealed DM section too', async () => {
    const conv = dmBetween(alice, bob)
    const target = await sendPoll(alice, conv)
    const voteId = await vote(alice, conv, target, ['no'])
    await alice.writer.bump('event')

    const obs = (await bob.reader.poll()).find((o) => o.content.device === alice.identity.deviceId)!
    const section = obs.dmSections.get(dmBetween(bob, alice).slice(3))!
    // `heads` is the field a 1.1/1.2 peer reads out of *their own* DM section.
    expect(section.heads.some((h) => h.endsWith('.vot.e1'))).toBe(false)
    expect(section.heads.every((h) => EVENT_RE_1_2.test(h))).toBe(true)
    expect(section.heads2).toContain(`${voteId}.vot.e1`)

    await bob.events.ingestHeads(conv, [...section.heads, ...(section.heads2 ?? [])])
    expect(bob.events.has(conv, voteId)).toBe(true)
    expect(materialize(bob.events.getEvents(conv)).messages.find((m) => m.id === target)?.votes).toEqual({
      [alice.identity.deviceId]: ['no'],
    })
  }, 90_000)

  it('never lets a vote into the heads ring an older client reads', async () => {
    const conv = dmBetween(alice, bob)
    const sealed = (alice.writer as unknown as { sealedSections: Map<ConvId, { heads: string[] }> }).sealedSections
    const before = [...(sealed.get(conv)?.heads ?? [])]

    // A message moves the ring a 1.2 peer reads; a vote on it does not.
    const target = await sendPoll(alice, conv)
    expect(sealed.get(conv)!.heads).toEqual([...before, `${target}.msg.e1`])
    const afterMsg = [...sealed.get(conv)!.heads]
    await vote(alice, conv, target, ['yes'])
    expect(sealed.get(conv)!.heads).toEqual(afterMsg)

    // And the whole beacon, as an older reader parses it: every name it finds
    // in `heads` — plain and sealed — still matches the pattern it compiles.
    await alice.writer.bump('event')
    const obs = (await bob.reader.poll()).find((o) => o.content.device === alice.identity.deviceId)!
    expect(obs.verified).toBe(true)
    for (const names of Object.values(obs.content.heads ?? {})) {
      expect(names.every((h) => EVENT_RE_1_2.test(h))).toBe(true)
    }
    for (const section of obs.dmSections.values()) {
      expect(section.heads.every((h) => EVENT_RE_1_2.test(h))).toBe(true)
    }
    // The unknown field itself is the thing an older reader shrugs at — the
    // 1.2 suite pins that shape from the other direction ("reads an unknown
    // field without flinching"); here it is ours, and it is populated.
    expect(Object.keys(obs.content.heads2 ?? {}).length).toBeGreaterThan(0)
  }, 90_000)

  it('a head name a reader cannot parse costs it no catch-up at all', async () => {
    // What a 1.2 client actually does with a `.vot.e1` name in `heads`: nothing.
    // `ingestHeads` skips a filename that does not parse — `if (!parsed)
    // continue`, *before* the gap branch — and 1.2's copy of that method has the
    // same shape, so such a name costs it no day scan and no read. Pinned here
    // with the current reader and a type *it* cannot parse, which takes exactly
    // the path a `.vot.e1` takes one version back. (The reason votes ride
    // `heads2` is the 16-slot ring, not this — see the preamble.)
    const conv = dmBetween(alice, bob)
    const future = `${String(Date.now()).padStart(13, '0')}-0001-${alice.identity.deviceId.slice(0, 8)}.zzz.e1`
    const catchUp = vi.spyOn(bob.events, 'catchUp')
    expect(await bob.events.ingestHeads(conv, [future])).toBe(false)
    expect(catchUp).not.toHaveBeenCalled()

    // And a `.vot.e1` the reader *can* parse: one read the first time, and the
    // second pass finds the stem in the log and returns — still no scan.
    const target = await sendPoll(alice, conv)
    const voteId = await vote(alice, conv, target, ['yes'])
    expect(await bob.events.ingestHeads(conv, [`${voteId}.vot.e1`])).toBe(true)
    expect(await bob.events.ingestHeads(conv, [`${voteId}.vot.e1`])).toBe(false)
    expect(catchUp).not.toHaveBeenCalled()
    catchUp.mockRestore()
  }, 90_000)
})

// ---------------------------------------------------------------------------
// Live boards (1.3): a real-time diagram session carried by the folder, one
// file per participant under boards/<sessionId>/. What matters here is what
// two real clients see of each other — delivery exactly once in seq order, the
// single file a writer ever owns, and every way a frame can be a lie.

describe('live boards over a shared folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'semaphore-boards-'))
  const pass = 'correct horse battery staple'
  let alice: Client
  let bob: Client
  let carol: Client
  let aliceBoards: BoardService
  let bobBoards: BoardService
  const alicePushes: PushMessage[] = []
  const bobPushes: PushMessage[] = []
  // The tier stays 'paused' so the background poll loop never races a
  // hand-driven pollOnce; the cadence itself is tested in boards.test.ts.
  const tier = { value: 'paused' as IoTier }
  let conv: ConvId

  const boardsFor = (c: Client, pushes: PushMessage[]): BoardService =>
    new BoardService(
      c.session,
      { events: c.events, noteOwnEvent: (cv, f) => c.writer.noteOwnEvent(cv, f), tier: () => tier.value },
      (m) => pushes.push(m),
    )

  const scene = (ids: string[]): { elements: unknown[] } => ({
    elements: ids.map((id, i) => ({ id, type: 'rectangle', version: i + 1, versionNonce: i + 7, isDeleted: false })),
  })

  const framesOf = (pushes: PushMessage[], sessionId: string): BoardFrame[] =>
    pushes.flatMap((p) => (p.kind === 'board-frames' && p.sessionId === sessionId ? p.frames : []))

  const endedFor = (pushes: PushMessage[], sessionId: string): number =>
    pushes.filter((p) => p.kind === 'board-ended' && p.sessionId === sessionId).length

  const filesIn = (sessionId: string): string[] => {
    const dir = join(root, DIR.boards, sessionId)
    return existsSync(dir) ? readdirSync(dir).filter((n) => !n.endsWith('.partial')) : []
  }

  /**
   * Write a frame file by hand, so a test can lie in exactly one way: sign it
   * with a device the roster never heard of, park it in someone else's slot, or
   * claim a `device` the signature does not back.
   */
  async function plantFrame(
    writer: Client,
    sessionId: string,
    target: ConvId,
    opts: { identity: DeviceIdentity; slotDevice: string; frameDevice: string; seq: number; frameSeq?: number },
  ): Promise<void> {
    const info = writer.session.convInfo(target)!
    const fileName = beaconFileName(opts.slotDevice, opts.seq)
    const rel = `${DIR.boards}/${sessionId}/${fileName}`
    const frame = {
      sessionId,
      device: opts.frameDevice,
      name: 'Mallory',
      seq: opts.frameSeq ?? opts.seq,
      at: Date.now(),
      elements: [{ id: `planted-${opts.seq}`, type: 'rectangle', version: 1, versionNonce: 1 }],
    }
    const signed = signRecord(opts.identity, DST.record, frame)
    const aad = buildAad('board', rel, fileName)
    await writer.io.publish(
      rel,
      encryptRecord(info.key, KID.board(sessionId, info.kid), Buffer.from(JSON.stringify(signed)), aad),
    )
  }

  /** Junk in someone's slot: a file nothing can decrypt, at a seq of our choosing. */
  async function plantJunk(writer: Client, sessionId: string, slotDevice: string, seq: number): Promise<void> {
    const fileName = beaconFileName(slotDevice, seq)
    await writer.io.publish(`${DIR.boards}/${sessionId}/${fileName}`, randomBytes(256))
  }

  beforeAll(async () => {
    alice = await makeClient(root, pass, 'Alice')
    bob = await makeClient(root, pass, 'Bob')
    carol = await makeClient(root, pass, 'Carol')
    for (const c of [alice, bob, carol]) {
      await c.session.roster.refresh()
      c.session.refreshDms()
    }
    const ch = await alice.session.createChannel('boards')
    conv = `chan:${ch.channelId}`
    await bob.session.loadChannels()
    await carol.session.loadChannels()
    aliceBoards = boardsFor(alice, alicePushes)
    bobBoards = boardsFor(bob, bobPushes)
  }, 120_000)

  afterAll(async () => {
    await aliceBoards?.stop()
    await bobBoards?.stop()
  })

  beforeEach(() => {
    alicePushes.length = 0
    bobPushes.length = 0
  })

  it('delivers each frame exactly once, in seq order, from one file per writer', async () => {
    const { sessionId } = await aliceBoards.start(conv, 'Sprint plan')
    await aliceBoards.write(sessionId, conv, scene(['a', 'b']))
    await aliceBoards.flushWrites()

    // Bob learns the session exists the ordinary way: a sys event in the log.
    await bob.events.catchUp(conv)
    expect(bobBoards.info(conv, sessionId)?.host).toBe(alice.identity.deviceId)

    const joined = await bobBoards.join(sessionId, conv)
    expect(joined.frames).toHaveLength(1)
    expect(joined.frames[0].device).toBe(alice.identity.deviceId)
    expect(joined.frames[0].name).toBe('Alice')
    expect(joined.frames[0].elements).toHaveLength(2)
    // Joining read the whole session; polling again has nothing to say.
    await bobBoards.pollOnce(sessionId)
    expect(framesOf(bobPushes, sessionId)).toHaveLength(0)

    await aliceBoards.write(sessionId, conv, scene(['a', 'b', 'c']))
    await aliceBoards.flushWrites()
    // One file each: Alice's previous seq went with the rename, and Bob has one
    // because joining publishes a frame of its own (that is what puts a watcher
    // in everyone else's pointer list).
    expect(filesIn(sessionId).sort()).toEqual(
      [beaconFileName(alice.identity.deviceId, 1), beaconFileName(bob.identity.deviceId, 0)].sort(),
    )

    await bobBoards.pollOnce(sessionId)
    const delivered = framesOf(bobPushes, sessionId)
    expect(delivered).toHaveLength(1)
    expect(delivered[0].seq).toBe(1)
    expect(delivered[0].elements).toHaveLength(3)
    // Exactly once: the same seq is never delivered a second time.
    await bobBoards.pollOnce(sessionId)
    await bobBoards.pollOnce(sessionId)
    expect(framesOf(bobPushes, sessionId)).toHaveLength(1)

    // Both drawing: one file each, and neither ever reads its own back. Bob's
    // seq continues from his join frame rather than starting over.
    await bobBoards.write(sessionId, conv, scene(['d']))
    await bobBoards.flushWrites()
    expect(filesIn(sessionId).sort()).toEqual(
      [beaconFileName(alice.identity.deviceId, 1), beaconFileName(bob.identity.deviceId, 1)].sort(),
    )
    const aliceJoin = await aliceBoards.join(sessionId, conv)
    expect(aliceJoin.frames.map((f) => f.device)).toEqual([bob.identity.deviceId])

    await aliceBoards.leave(sessionId, conv)
    await bobBoards.leave(sessionId, conv)
  }, 120_000)

  it('keeps a DM board readable by the pair and opaque to everyone else', async () => {
    const dm = dmBetween(alice, bob)
    const { sessionId } = await aliceBoards.start(dm, 'Private sketch')
    await aliceBoards.write(sessionId, dm, scene(['secret']))
    await aliceBoards.flushWrites()

    const fileName = beaconFileName(alice.identity.deviceId, 0)
    const rel = `${DIR.boards}/${sessionId}/${fileName}`
    const raw = readFileSync(join(root, DIR.boards, sessionId, fileName))
    // The conversation's own kid rides in the frame's: for a DM that is the pair
    // token, for a private group the epoch (which is how a reader that has not
    // been handed the new key yet knows to wait for it rather than drop frames).
    expect(recordKid(raw)).toBe(`board/${sessionId}/${alice.session.convInfo(dm)!.kid}`)
    expect(recordKid(raw).startsWith(`board/${sessionId}/dm/`)).toBe(true)

    // Carol is a fully paid-up member of the team — and still holds nothing
    // that opens this frame: the DM key is the only thing that does.
    expect(carol.session.convInfo(dm)).toBeNull()
    const aad = buildAad('board', rel, fileName)
    for (const key of [carol.session.keys.kMeta, carol.session.keys.kPres, carol.session.keys.tmk]) {
      expect(() => decryptRecord(raw, key, aad)).toThrow()
    }

    // The other half of the pair reads it without ceremony.
    await bob.events.catchUp(dm)
    const joined = await bobBoards.join(sessionId, dm)
    expect(joined.frames).toHaveLength(1)
    expect((joined.frames[0].elements[0] as { id: string }).id).toBe('secret')

    await bobBoards.leave(sessionId, dm)
    await aliceBoards.leave(sessionId, dm)
  }, 120_000)

  it('drops a frame nobody signed for and one whose device is a forgery', async () => {
    const { sessionId } = await aliceBoards.start(conv, 'Forgeries')
    await aliceBoards.write(sessionId, conv, scene(['a']))
    await aliceBoards.flushWrites()
    await bob.events.catchUp(conv)
    await bobBoards.join(sessionId, conv)
    bobPushes.length = 0

    // A stranger's signature: the team key let them write the file, the roster
    // is what refuses to call it anyone's frame.
    const stranger = generateIdentity().identity
    await plantFrame(alice, sessionId, conv, {
      identity: stranger,
      slotDevice: stranger.deviceId,
      frameDevice: stranger.deviceId,
      seq: 0,
    })
    // Carol's own signature, in Carol's own slot, claiming to be Alice: the
    // `device` field is what the renderer colours and labels by, so a frame
    // whose signer does not match it is not delivered at all.
    await plantFrame(carol, sessionId, conv, {
      identity: carol.identity,
      slotDevice: carol.identity.deviceId,
      frameDevice: alice.identity.deviceId,
      seq: 0,
    })
    await bobBoards.pollOnce(sessionId)
    expect(framesOf(bobPushes, sessionId)).toHaveLength(0)

    // And an honest frame from the same device still arrives right after —
    // the refusal moved the cursor past the bad file rather than sticking.
    await plantFrame(carol, sessionId, conv, {
      identity: carol.identity,
      slotDevice: carol.identity.deviceId,
      frameDevice: carol.identity.deviceId,
      seq: 1,
    })
    await bobBoards.pollOnce(sessionId)
    const delivered = framesOf(bobPushes, sessionId)
    expect(delivered).toHaveLength(1)
    expect(delivered[0].device).toBe(carol.identity.deviceId)

    // A frame whose own seq disagrees with the slot it is sitting in: the
    // reader's cursor moves by the file name, so delivering this would hand the
    // renderer a frame under a number it never claimed.
    bobPushes.length = 0
    await plantFrame(carol, sessionId, conv, {
      identity: carol.identity,
      slotDevice: carol.identity.deviceId,
      frameDevice: carol.identity.deviceId,
      seq: 2,
      frameSeq: 99,
    })
    await bobBoards.pollOnce(sessionId)
    expect(framesOf(bobPushes, sessionId)).toHaveLength(0)

    await bobBoards.leave(sessionId, conv)
    await aliceBoards.leave(sessionId, conv)
  }, 120_000)

  it('a junk file at a high seq does not mute the device whose slot it is in', async () => {
    const { sessionId } = await aliceBoards.start(conv, 'Junk')
    await aliceBoards.write(sessionId, conv, scene(['a']))
    await aliceBoards.flushWrites()
    await bob.events.catchUp(conv)
    await bobBoards.join(sessionId, conv)
    bobPushes.length = 0

    // Anyone in the team can write a file into the directory — only the
    // conversation key decides what can be *read*. One unreadable file at a seq
    // far above anything real used to silence that participant for the rest of
    // the session: it was the only candidate the reader looked at, and the
    // cursor advanced past it even though the frame was refused.
    await plantJunk(bob, sessionId, alice.identity.deviceId, 500)
    await aliceBoards.write(sessionId, conv, scene(['a', 'b']))
    await aliceBoards.flushWrites()
    await bobBoards.pollOnce(sessionId)
    // The junk is the newest file in Alice's slot; her real frame is under it,
    // and is what gets delivered.
    const first = framesOf(bobPushes, sessionId)
    expect(first).toHaveLength(1)
    expect(first[0].device).toBe(alice.identity.deviceId)
    expect(first[0].seq).toBe(1)
    expect(first[0].elements).toHaveLength(2)

    // And she keeps being heard: every later frame is delivered too, with the
    // junk costing exactly one read, once.
    bobPushes.length = 0
    await aliceBoards.write(sessionId, conv, scene(['a', 'b', 'c']))
    await aliceBoards.flushWrites()
    await bobBoards.pollOnce(sessionId)
    const second = framesOf(bobPushes, sessionId)
    expect(second).toHaveLength(1)
    expect(second[0].seq).toBe(2)
    expect(second[0].elements).toHaveLength(3)

    await bobBoards.leave(sessionId, conv)
    await aliceBoards.leave(sessionId, conv)
  }, 120_000)

  it('keeps a private-group board opaque to a non-member, and readable across a rekey', async () => {
    // Carol is in the group to begin with, and is removed mid-session: that is
    // what rotates the key while a board is running.
    const view = await alice.groups.create('Board crew', [bob.identity.deviceId, carol.identity.deviceId])
    const gconv = view.conv
    await syncInvites(bob, alice)
    await syncInvites(carol, alice)

    const { sessionId } = await aliceBoards.start(gconv, 'Group sketch')
    await aliceBoards.write(sessionId, gconv, scene(['g1']))
    await aliceBoards.flushWrites()

    const fileName = beaconFileName(alice.identity.deviceId, 0)
    const raw = readFileSync(join(root, DIR.boards, sessionId, fileName))
    expect(recordKid(raw)).toBe(`board/${sessionId}/${alice.session.convInfo(gconv)!.kid}`)

    await bob.events.catchUp(gconv)
    const joined = await bobBoards.join(sessionId, gconv)
    expect(joined.frames).toHaveLength(1)
    expect((joined.frames[0].elements[0] as { id: string }).id).toBe('g1')

    // Removing Carol rotates to epoch 2. Alice's next frame is written under the
    // new key; Bob has not been handed it yet (his rekey DM is still sitting in
    // the log), so the frame is PARKED, not refused — a refusal would be
    // permanent and would cost him every frame for the rest of the session.
    await alice.groups.removeMember(gconv, carol.identity.deviceId)
    expect(alice.groups.views().find((g) => g.conv === gconv)?.epoch).toBe(2)
    bobPushes.length = 0
    await aliceBoards.write(sessionId, gconv, scene(['g1', 'g2']))
    await aliceBoards.flushWrites()
    await bobBoards.pollOnce(sessionId)
    expect(framesOf(bobPushes, sessionId)).toHaveLength(0)

    // The rekey arrives, and the same file — untouched on the share — is read on
    // the next poll.
    await syncInvites(bob, alice)
    expect(bob.groups.views().find((g) => g.conv === gconv)?.epoch).toBe(2)
    await bobBoards.pollOnce(sessionId)
    const after = framesOf(bobPushes, sessionId)
    expect(after).toHaveLength(1)
    expect(after[0].elements).toHaveLength(2)

    // Carol was a member a moment ago and still holds the epoch-1 key: the
    // frames written since the rotation are not hers to read, and the group is
    // gone from her client entirely.
    await carol.events.catchUp(dmBetween(carol, alice))
    await carol.groups.settle()
    expect(carol.session.convInfo(gconv)).toBeNull()
    expect(carol.groups.views().find((g) => g.conv === gconv)).toBeUndefined()

    await bobBoards.leave(sessionId, gconv)
    await aliceBoards.end(sessionId, gconv)
  }, 120_000)

  it('ends for everyone when the host says so, and refuses when anyone else does', async () => {
    const { sessionId } = await aliceBoards.start(conv, 'Retro')
    await aliceBoards.write(sessionId, conv, scene(['a']))
    await aliceBoards.flushWrites()
    await bob.events.catchUp(conv)
    await bobBoards.join(sessionId, conv)

    await expect(bobBoards.end(sessionId, conv)).rejects.toThrow('not-host')
    expect(existsSync(join(root, DIR.boards, sessionId))).toBe(true)

    await aliceBoards.end(sessionId, conv)
    expect(existsSync(join(root, DIR.boards, sessionId))).toBe(false)

    // Bob hears it through the log, stops polling, and says so exactly once.
    await bob.events.catchUp(conv)
    expect(endedFor(bobPushes, sessionId)).toBe(1)
    await bobBoards.pollOnce(sessionId)
    expect(endedFor(bobPushes, sessionId)).toBe(1)
  }, 120_000)

  it('ends a joined session when the directory disappears under it', async () => {
    const { sessionId } = await aliceBoards.start(conv, 'Ghost')
    await aliceBoards.write(sessionId, conv, scene(['a']))
    await aliceBoards.flushWrites()
    await bob.events.catchUp(conv)
    await bobBoards.join(sessionId, conv)
    bobPushes.length = 0

    // No `board-ended` reaches Bob at all — the janitor swept a dead session,
    // or the host's machine went away with it.
    aliceBoards.stop()
    await alice.io.delete(`${DIR.boards}/${sessionId}`)
    await bobBoards.pollOnce(sessionId)
    expect(endedFor(bobPushes, sessionId)).toBe(1)
    await bobBoards.pollOnce(sessionId)
    expect(endedFor(bobPushes, sessionId)).toBe(1)
  }, 120_000)
})
