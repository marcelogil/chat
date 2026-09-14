import { describe, expect, it, vi } from 'vitest'

// The only Electron this file needs is the OS notification the service raises
// (1.4 gave it preferences worth testing); `BrowserWindow` appears in
// ChatService's signature as a type, and is stubbed so the import resolves.
const notifications: { title: string; body: string }[] = []
vi.mock('electron', () => ({
  BrowserWindow: class {},
  Notification: class {
    static isSupported(): boolean {
      return true
    }
    private rec: { title: string; body: string }
    constructor(opts: { title: string; body: string }) {
      this.rec = { title: opts.title, body: opts.body }
    }
    on(): this {
      return this
    }
    show(): void {
      notifications.push(this.rec)
    }
  },
}))

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BodyEntity, CalPayload, CalendarEntry, ConvId, MsgPayload, PollBody, VerifiedEvent } from '@shared/types'
import type { PushMessage, SendDraft, SettingsView } from '@shared/bridge'
import { DIR, TEAM_CONV } from '@shared/constants'
import { materializeCalendar } from '@shared/calendar'
import { materialize } from '@shared/merge'
import { generateIdentity } from '../crypto/identity'
import type { SecretStore } from '../store/secretStore'
import { createOrJoinTeam } from '../transport/bootstrap'
import { EventStore } from '../transport/events'
import { Roster } from '../transport/roster'
import { Session } from '../transport/session'
import { ShareIo } from '../transport/shareIo'
import { ChatService } from './chatService'

// The offline outbox seen from the two places it is easy to get wrong:
// a queued team write must not be reported as a failure (a "could not save"
// invites a retry, and a retried new entry carries a second entry id), and a
// backlog persisted by a previous run must be replayed on the next launch —
// the poller's degraded→reachable edge never fires when the share is healthy
// at startup.

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

const settings = (): SettingsView => ({
  theme: 'system',
  notifyChannels: 'none',
  notifyPreviews: false,
  autoplayGifs: 'never',
  autoAcceptBeams: false,
  quietHours: { enabled: false, from: '22:00', to: '07:00' },
  fontSize: 'M',
})

/** One client against `root`, reusing `store` so a "restart" keeps its secrets. */
async function makeSession(root: string, store: FakeStore, name: string): Promise<Session> {
  const identity = generateIdentity().identity
  const io = new ShareIo(root)
  const result = await createOrJoinTeam(io, 'correct horse battery staple', 'Test Team')
  if ('error' in result) throw new Error(result.error)
  const { proto, teamSalt, tmk } = result.join
  const seed = new Session(io, store, identity, proto, teamSalt, tmk, tmk, new Roster(io, store, tmk, proto.epoch), name)
  const roster = new Roster(io, store, seed.keys.kMeta, proto.epoch)
  roster.loadPins()
  const session = new Session(io, store, identity, proto, teamSalt, tmk, tmk, roster, name)
  await roster.publishSelf(identity, {
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
  await roster.refresh()
  return session
}

function entry(id: string, title: string): CalendarEntry {
  return { id, title, tag: 'Release', color: 1, start: '2026-03-14', end: '2026-03-14', annual: false, notes: '' }
}

function put(e: CalendarEntry): CalPayload {
  return { t: 'cal', conv: TEAM_CONV.calendar, op: 'put', entry: e }
}

/** Make every share write fail, as an unmounted folder does. */
function breakPublish(chat: ChatService): void {
  ;(chat as unknown as { events: EventStore }).events.publish = (() =>
    Promise.reject(new Error('ENOENT: share gone'))) as never
}

async function calendarOnShare(root: string): Promise<CalendarEntry[]> {
  const session = await makeSession(root, new FakeStore(), 'Reader')
  const events = new EventStore(session)
  await events.catchUp(TEAM_CONV.calendar)
  return materializeCalendar(events.getEvents(TEAM_CONV.calendar))
}

describe('team writes with an unreachable share', () => {
  it('resolves as queued instead of rejecting, so one entry stays one entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sem-outbox-queued-'))
    const store = new FakeStore()
    const session = await makeSession(root, store, 'Alice')
    const chat = new ChatService(session, () => null, settings)
    const pushes: PushMessage[] = []
    chat.setPush((m) => pushes.push(m))
    breakPublish(chat)

    await expect(chat.publishTeam(TEAM_CONV.calendar, 'cal', put(entry('a'.repeat(16), 'Release 1.1')))).resolves.toEqual({
      queued: true,
    })
    expect(store.readSecretJson<unknown[]>('outbox')).toHaveLength(1)
    expect(pushes.filter((p) => p.kind === 'outbox')).toHaveLength(1)
  })

  it('still resolves as published when the share is reachable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sem-outbox-live-'))
    const session = await makeSession(root, new FakeStore(), 'Alice')
    const chat = new ChatService(session, () => null, settings)
    await expect(chat.publishTeam(TEAM_CONV.calendar, 'cal', put(entry('b'.repeat(16), 'Offsite')))).resolves.toEqual({
      queued: false,
    })
    expect(await calendarOnShare(root)).toHaveLength(1)
  })
})

describe('outbox replay across a restart', () => {
  it('publishes a backlog left by a previous run even when the share never degrades', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sem-outbox-restart-'))
    const store = new FakeStore() // the local secret store survives the restart

    // Run 1: the share is gone, so the entry only reaches the outbox.
    const first = new ChatService(await makeSession(root, store, 'Alice'), () => null, settings)
    breakPublish(first)
    await first.publishTeam(TEAM_CONV.calendar, 'cal', put(entry('c'.repeat(16), 'Sprint review')))
    expect(store.readSecretJson<unknown[]>('outbox')).toHaveLength(1)

    // Run 2: relaunch onto a healthy share — the poller never degrades here,
    // so start() is the only thing that can drain the backlog.
    const second = new ChatService(await makeSession(root, store, 'Alice'), () => null, settings)
    const pushes: PushMessage[] = []
    second.setPush((m) => pushes.push(m))
    await second.start()
    // start() kicks the flush off without awaiting it (a stalled mount must
    // not hold up launch), so wait for the queue to drain.
    for (let i = 0; i < 200 && (store.readSecretJson<unknown[]>('outbox') ?? []).length > 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    await second.stop()

    const cal = await calendarOnShare(root)
    expect(cal.map((e) => e.title)).toEqual(['Sprint review'])
    expect(store.readSecretJson<unknown[]>('outbox')).toHaveLength(0)
    // The UI hears about the restored backlog and about it draining.
    expect(pushes.filter((p) => p.kind === 'outbox').map((p) => (p as { queued: number }).queued)).toEqual([1, 0])
  })
})

// ---------------------------------------------------------------------------
// Channel management (1.2). The home channel is the one thing here that must
// never move: it is where a client lands when the conversation it was looking
// at disappears, so rename and delete both refuse it.

describe('renaming and deleting channels', () => {
  it('refuses the home channel, normalizes names, and hides a deleted one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sem-channels-'))
    const session = await makeSession(root, new FakeStore(), 'Alice')
    const chat = new ChatService(session, () => null, settings)
    const pushes: PushMessage[] = []
    chat.setPush((m) => pushes.push(m))
    await chat.start() // bootstraps `general` with fixed: true

    const home = chat.channelViews().find((v) => v.fixed)!
    expect(home.name).toBe('general')
    await expect(chat.renameChannel(home.conv, 'lobby')).rejects.toThrow('fixed-channel')
    await expect(chat.deleteChannel(home.conv)).rejects.toThrow('fixed-channel')

    const other = await chat.createChannel('random')
    expect(other.fixed).toBe(false)
    await expect(chat.renameChannel(other.conv, '   ')).rejects.toThrow('invalid-name')

    const before = pushes.filter((p) => p.kind === 'channels').length
    await chat.renameChannel(other.conv, '  Random Stuff ')
    expect(chat.channelViews().find((v) => v.channelId === other.channelId)?.name).toBe('random-stuff')
    expect(pushes.filter((p) => p.kind === 'channels').length).toBeGreaterThan(before)

    await chat.deleteChannel(other.conv)
    expect(chat.channelViews().some((v) => v.channelId === other.channelId)).toBe(false)
    expect(chat.deletedConvDirs().map((d) => d.rel)).toContain(`${DIR.channels}/${session.channels.get(other.channelId)!.token}`)
    // A send into a conversation that no longer exists fails outright rather
    // than sitting in the outbox forever.
    await expect(chat.send(other.conv, { kind: 'text', text: 'hello?' })).rejects.toThrow(/unknown conversation/)
    expect(session.store.readSecretJson<unknown[]>('outbox') ?? []).toHaveLength(0)

    await chat.stop()
  }, 60_000)

  it('refuses a tombstone for the home channel of a team that predates the flag', async () => {
    // A team created before 1.2 carries `fixed` nowhere, so the home channel is
    // whatever the fold computes: oldest, ties by lowest channelId. Every
    // client computes the same answer, so every client can refuse a tombstone
    // for it — otherwise one stale (or hostile) writer empties the sidebar and
    // there is nowhere left to land.
    const root = mkdtempSync(join(tmpdir(), 'sem-channels-legacy-'))
    const session = await makeSession(root, new FakeStore(), 'Alice')
    await session.createChannel('general') // no `fixed` flag anywhere
    await session.createChannel('random')
    const chat = new ChatService(session, () => null, settings)
    chat.setPush(() => {})
    await chat.start() // channels already exist, so no bootstrap `general`

    // Which of the two is home is the fold's answer (oldest, ties by lowest
    // channelId) — the test asks it rather than assuming, because two channels
    // created in the same millisecond are decided by a random id.
    const home = chat.channelViews().find((v) => v.fixed)!
    const other = chat.channelViews().find((v) => !v.fixed)!
    expect(home).toBeDefined()
    await expect(chat.deleteChannel(home.conv)).rejects.toThrow('fixed-channel')

    // Published by hand, as a client that thinks a different channel is home
    // would: the fold on this client refuses it.
    await chat.events.publish(home.conv, 'sys', { t: 'sys', conv: home.conv, kind: 'channel-deleted', data: {} })
    expect(session.channels.get(home.channelId)!.deletedAt).toBeUndefined()
    expect(chat.channelViews().some((v) => v.channelId === home.channelId)).toBe(true)
    expect(chat.deletedConvDirs()).toHaveLength(0)

    // The same event for any other channel still tombstones it.
    await chat.events.publish(other.conv, 'sys', { t: 'sys', conv: other.conv, kind: 'channel-deleted', data: {} })
    expect(session.channels.get(other.channelId)!.deletedAt).toBeGreaterThan(0)
    expect(chat.channelViews().some((v) => v.channelId === other.channelId)).toBe(false)

    await chat.stop()
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Polls (1.3). The interesting half is main's refusals: the renderer's dialog
// can be bypassed (every argument here crosses the bridge from sandboxed web
// code), so the option ids, `multi`, the closed state and "only the author
// closes it" are all decided here, against the poll as it currently stands.

function pollDraft(over: Partial<PollBody> = {}): SendDraft {
  const poll: PollBody = {
    question: 'Ship on Friday?',
    options: [
      { id: '', text: 'Yes, ship it' },
      { id: '', text: 'Wait for Monday' },
    ],
    multi: false,
    anonymous: false,
    ...over,
  }
  return { kind: 'poll', text: poll.question, poll }
}

/** The poll message as the log currently reads it (edits applied). */
function pollIn(chat: ChatService, conv: ConvId, id: string) {
  return materialize(chat.getEvents(conv)).messages.find((m) => m.id === id)!
}

describe('polls', () => {
  it('sends with a pre-1.3 fallback line, generated option ids, and a calibrated deadline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sem-poll-send-'))
    const session = await makeSession(root, new FakeStore(), 'Alice')
    const chat = new ChatService(session, () => null, settings)
    const conv: ConvId = `chan:${(await session.createChannel('polls')).channelId}`

    const { id } = await chat.send(conv, pollDraft({ closesAt: Date.now() + 4 * 3600_000 }))
    const body = pollIn(chat, conv, id).body
    expect(body.kind).toBe('poll')
    // What a 1.1/1.2 client prints in place of the tile — it cannot vote at all
    // (its filename regex rejects `.vot.e1`), so the line has to say so.
    expect(body.text).toBe('📊 Poll: Ship on Friday? — update Chat to vote')
    expect(body.poll?.options.map((o) => o.id)).toEqual(['o1', 'o2'])
    expect(body.poll?.closedAt).toBeUndefined()
    // Slack at both ends: the span is measured from `Date.now()` inside `send`
    // and read back against a `calibratedNow()` taken here, and a recalibration
    // between the two can move the share clock a few ms either way. The point of
    // the assertion is "four hours, on the share clock", not the millisecond.
    const closesIn = (body.poll!.closesAt ?? 0) - session.io.calibratedNow()
    expect(closesIn).toBeGreaterThan(3.5 * 3600_000)
    expect(closesIn).toBeLessThanOrEqual(4 * 3600_000 + 1000)
  }, 60_000)

  it('refuses a draft the limits do not allow', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sem-poll-limits-'))
    const session = await makeSession(root, new FakeStore(), 'Alice')
    const chat = new ChatService(session, () => null, settings)
    const conv: ConvId = `chan:${(await session.createChannel('polls')).channelId}`

    await expect(chat.send(conv, { kind: 'poll', text: 'x' })).rejects.toThrow('poll-missing')
    await expect(chat.send(conv, pollDraft({ question: '   ' }))).rejects.toThrow('poll-question-empty')
    await expect(chat.send(conv, pollDraft({ options: [{ id: '', text: 'Only one' }] }))).rejects.toThrow(
      'poll-too-few-options',
    )
    await expect(
      chat.send(
        conv,
        pollDraft({ options: Array.from({ length: 11 }, (_, i) => ({ id: '', text: `option ${i}` })) }),
      ),
    ).rejects.toThrow('poll-too-many-options')
    // Two rows that read the same: the renderer's dialog says so too, but main
    // runs the same validator because renderer input is untrusted — and a
    // duplicate is the one draft problem that still *works*, quietly splitting
    // one answer in two.
    await expect(
      chat.send(conv, pollDraft({ options: [{ id: '', text: 'Friday' }, { id: '', text: ' friday ' }] })),
    ).rejects.toThrow('poll-duplicate-option')
    expect(chat.getEvents(conv)).toHaveLength(0)
  }, 60_000)

  it('records a vote, replaces it, and takes it back', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sem-poll-vote-'))
    const session = await makeSession(root, new FakeStore(), 'Alice')
    const chat = new ChatService(session, () => null, settings)
    const conv: ConvId = `chan:${(await session.createChannel('polls')).channelId}`
    const { id } = await chat.send(conv, pollDraft())

    await chat.vote(conv, id, ['o1'])
    expect(pollIn(chat, conv, id).votes).toEqual({ [session.deviceId]: ['o1'] })
    await chat.vote(conv, id, ['o2'])
    expect(pollIn(chat, conv, id).votes).toEqual({ [session.deviceId]: ['o2'] })
    await chat.vote(conv, id, [])
    expect(pollIn(chat, conv, id).votes).toEqual({})
    // Three votes, three events — LWW per voter, nothing deleted or rewritten.
    expect(chat.getEvents(conv).filter((e) => e.type === 'vot')).toHaveLength(3)
  }, 60_000)

  it('refuses an unknown option, a second pick on a single-choice poll, and a vote on nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sem-poll-invalid-'))
    const session = await makeSession(root, new FakeStore(), 'Alice')
    const chat = new ChatService(session, () => null, settings)
    const conv: ConvId = `chan:${(await session.createChannel('polls')).channelId}`
    const { id } = await chat.send(conv, pollDraft())
    const multi = await chat.send(conv, pollDraft({ multi: true }))
    const plain = await chat.send(conv, { kind: 'text', text: 'not a poll' })

    await expect(chat.vote(conv, id, ['nope'])).rejects.toThrow('unknown-option')
    await expect(chat.vote(conv, id, ['o1', 'o2'])).rejects.toThrow('single-choice')
    await expect(chat.vote(conv, plain.id, ['o1'])).rejects.toThrow('not-a-poll')
    await expect(chat.vote(conv, 'nosuchevent', ['o1'])).rejects.toThrow('unknown-poll')
    // The same two picks are fine once the poll says they are.
    await chat.vote(conv, multi.id, ['o1', 'o2'])
    expect(pollIn(chat, conv, multi.id).votes).toEqual({ [session.deviceId]: ['o1', 'o2'] })
    expect(chat.getEvents(conv).filter((e) => e.type === 'vot')).toHaveLength(1)
  }, 60_000)

  it('closes by the author only, and a closed poll takes no more votes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sem-poll-close-'))
    const session = await makeSession(root, new FakeStore(), 'Alice')
    const chat = new ChatService(session, () => null, settings)
    const conv: ConvId = `chan:${(await session.createChannel('polls')).channelId}`
    const { id } = await chat.send(conv, pollDraft())
    await chat.vote(conv, id, ['o1'])

    await chat.closePoll(conv, id)
    const closed = pollIn(chat, conv, id)
    expect(closed.body.poll?.closedAt).toBeGreaterThan(0)
    // Closing is an ordinary author `edt` — so it travels, and it merges, by
    // the rules every client already has.
    expect(chat.getEvents(conv).filter((e) => e.type === 'edt')).toHaveLength(1)
    expect(closed.votes).toEqual({ [session.deviceId]: ['o1'] })
    await expect(chat.vote(conv, id, ['o2'])).rejects.toThrow('poll-closed')
    // Idempotent: closing again writes nothing.
    await chat.closePoll(conv, id)
    expect(chat.getEvents(conv).filter((e) => e.type === 'edt')).toHaveLength(1)
  }, 60_000)

  it('refuses a vote once the poll’s own deadline has passed, with no event needed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sem-poll-deadline-'))
    const session = await makeSession(root, new FakeStore(), 'Alice')
    const chat = new ChatService(session, () => null, settings)
    const conv: ConvId = `chan:${(await session.createChannel('polls')).channelId}`
    const { id } = await chat.send(conv, pollDraft({ closesAt: Date.now() + 3600_000 }))
    await chat.vote(conv, id, ['o1'])

    // The share clock moves past the deadline; nobody publishes anything.
    const closesAt = pollIn(chat, conv, id).body.poll!.closesAt!
    const realNow = session.io.calibratedNow.bind(session.io)
    session.io.calibratedNow = () => closesAt + 1000
    try {
      await expect(chat.vote(conv, id, ['o2'])).rejects.toThrow('poll-closed')
    } finally {
      session.io.calibratedNow = realNow
    }
    expect(pollIn(chat, conv, id).votes).toEqual({ [session.deviceId]: ['o1'] })
  }, 60_000)

  it('refuses a close from anyone but the author', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sem-poll-author-'))
    const alice = await makeSession(root, new FakeStore(), 'Alice')
    const chatA = new ChatService(alice, () => null, settings)
    const conv: ConvId = `chan:${(await alice.createChannel('polls')).channelId}`
    const { id } = await chatA.send(conv, pollDraft())

    const bob = await makeSession(root, new FakeStore(), 'Bob')
    await bob.roster.refresh()
    const chatB = new ChatService(bob, () => null, settings)
    await bob.loadChannels()
    await chatB.events.catchUp(conv)
    await expect(chatB.closePoll(conv, id)).rejects.toThrow('not-poll-author')
    // Bob can still vote in it — being someone else's poll is the point.
    await chatB.vote(conv, id, ['o1'])
    expect(pollIn(chatB, conv, id).votes).toEqual({ [bob.deviceId]: ['o1'] })
  }, 60_000)

  it('advertises a vote in heads2, never in the heads a 1.2 peer parses', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sem-poll-heads2-'))
    const session = await makeSession(root, new FakeStore(), 'Alice')
    const chat = new ChatService(session, () => null, settings)
    const conv: ConvId = `chan:${(await session.createChannel('polls')).channelId}`
    const { id } = await chat.send(conv, pollDraft())
    await chat.vote(conv, id, ['o1'])

    const beacon = chat.beacon as unknown as {
      heads: Map<string, string[]>
      heads2: Map<string, string[]>
    }
    expect((beacon.heads.get(conv) ?? []).some((h) => h.endsWith('.vot.e1'))).toBe(false)
    expect((beacon.heads.get(conv) ?? []).some((h) => h.endsWith('.msg.e1'))).toBe(true)
    expect((beacon.heads2.get(conv) ?? []).some((h) => h.endsWith('.vot.e1'))).toBe(true)
  }, 60_000)
})

// Who may interrupt (1.4). The rules themselves are exhaustively tested in
// shared/notifyDecision.test.ts; what matters here is that the service asks —
// with the right conversation kind, against the live settings, every time.
describe('maybeNotify and the notification preferences (1.4)', () => {
  const OTHER = 'other-device'

  function msg(conv: ConvId, over: { text?: string; mention?: boolean } = {}): VerifiedEvent {
    const entities: BodyEntity[] | undefined = over.mention
      ? [{ type: 'mention', special: 'here', start: 0, end: 5 }]
      : undefined
    const payload: MsgPayload = {
      t: 'msg',
      conv,
      author: { device: OTHER, name: 'Bob' },
      senderSeq: 1,
      sentWall: Date.now(),
      body: { kind: 'text', text: over.text ?? 'hello', entities },
    }
    return { id: '1700000000000-0000-aabbccdd', type: 'msg', payload, author: OTHER, verified: true, receivedAt: Date.now() }
  }

  it('gates channels, DMs, private groups and the pause off one set of settings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sem-notify-gate-'))
    const session = await makeSession(root, new FakeStore(), 'Alice')
    const prefs: SettingsView = { ...settings(), notifyChannels: 'all', notifyPreviews: true, notifyDms: true }
    // No window at all reads as "not focused", which is the only case that
    // reaches the preference check.
    const chat = new ChatService(session, () => null, () => prefs)
    const chan: ConvId = `chan:${(await session.createChannel('general')).channelId}`
    const dm: ConvId = 'dm:00112233445566778899aabb'
    const grp: ConvId = 'grp:00112233445566778899aabb'
    const fire = (conv: ConvId, over?: { mention?: boolean }): number => {
      notifications.length = 0
      ;(chat as unknown as { maybeNotify(c: ConvId, e: VerifiedEvent): void }).maybeNotify(conv, msg(conv, over))
      return notifications.length
    }

    // Out of the box everything talks.
    expect(fire(chan)).toBe(1)
    expect(fire(dm)).toBe(1)
    expect(fire(grp)).toBe(1)

    // notifyDms covers both conversations you were invited into personally,
    // and leaves the channel preference alone.
    prefs.notifyDms = false
    expect(fire(dm)).toBe(0)
    expect(fire(grp)).toBe(0)
    expect(fire(chan)).toBe(1)

    // …and the channel preference still leaves those two alone.
    prefs.notifyDms = true
    prefs.notifyChannels = 'mentions'
    expect(fire(chan)).toBe(0)
    expect(fire(chan, { mention: true })).toBe(1)
    expect(fire(dm)).toBe(1)

    // The pause outranks all of it, and expires by itself.
    prefs.notifyChannels = 'all'
    prefs.snoozeUntil = Date.now() + 3_600_000
    expect(fire(chan, { mention: true })).toBe(0)
    expect(fire(dm)).toBe(0)
    expect(fire(grp)).toBe(0)
    prefs.snoozeUntil = Date.now() - 1
    expect(fire(dm)).toBe(1)
    expect(fire(chan)).toBe(1)
  }, 60_000)
})
