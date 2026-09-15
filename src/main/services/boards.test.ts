import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, existsSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BoardFrameDraft, ConvId, EventPayload, EventType, VerifiedEvent } from '@shared/types'
import type { PushMessage } from '@shared/bridge'
import { BOARD, DIR, RETENTION, TEAM_CONV } from '@shared/constants'
import { buildAad, decryptRecord } from '../crypto/envelope'
import { generateIdentity } from '../crypto/identity'
import type { SecretStore } from '../store/secretStore'
import { createOrJoinTeam } from '../transport/bootstrap'
import type { EventStore } from '../transport/events'
import { Roster } from '../transport/roster'
import { Session } from '../transport/session'
import { ShareIo } from '../transport/shareIo'
import { Janitor } from './janitor'
import type { IoTier } from './ioTier'
import {
  BoardService,
  boardLiveIsFresh,
  boardLiveNotifyLine,
  contentSignature,
  fitFrame,
  pointerSignature,
  type BoardHost,
} from './boards'

// The writer half of live boards, plus the rules that do not need a second
// device: coalescing, the keepalive, the frame budget, who may end a session,
// what happens to a poller when the host does, and the janitor's sweep.
// Two-client frame exchange, verification and the non-member check live in
// transport/integration.test.ts, which already has two real clients.

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

/**
 * Stands in for ChatService's EventStore: the board service only ever
 * publishes two sys events through it and listens for everyone else's, so a
 * stub lets a test hand it an announcement from a device that isn't here.
 */
class StubEvents {
  listeners: ((conv: ConvId, event: VerifiedEvent) => void)[] = []
  log: VerifiedEvent[] = []
  published: { conv: ConvId; type: EventType; payload: EventPayload }[] = []
  private ctr = 0

  constructor(private deviceId: string) {}

  onEvent(cb: (conv: ConvId, event: VerifiedEvent) => void): void {
    this.listeners.push(cb)
  }

  getEvents(): VerifiedEvent[] {
    return [...this.log]
  }

  async publish(conv: ConvId, type: EventType, payload: EventPayload): Promise<VerifiedEvent> {
    this.published.push({ conv, type, payload })
    return this.emit(conv, type, payload, this.deviceId)
  }

  /** Ingest an event as if it had arrived from `author`. */
  emit(conv: ConvId, type: EventType, payload: EventPayload, author: string, verified = true): VerifiedEvent {
    const ev: VerifiedEvent = {
      id: `${String(Date.now()).padStart(13, '0')}-${String(++this.ctr).padStart(4, '0')}-${author.slice(0, 8)}`,
      type,
      payload,
      author,
      verified,
      receivedAt: Date.now(),
    }
    this.log.push(ev)
    for (const l of this.listeners) l(conv, ev)
    return ev
  }
}

interface Harness {
  root: string
  session: Session
  boards: BoardService
  events: StubEvents
  pushes: PushMessage[]
  tier: { value: IoTier }
  conv: ConvId
}

async function makeHarness(prefix: string): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const identity = generateIdentity().identity
  const io = new ShareIo(root)
  const store = new FakeStore()
  const result = await createOrJoinTeam(io, 'correct horse battery staple', 'Test Team')
  if ('error' in result) throw new Error(result.error)
  const { proto, teamSalt, tmk } = result.join
  const seed = new Session(io, store, identity, proto, teamSalt, tmk, tmk, new Roster(io, store, tmk, proto.epoch), 'Ana')
  const roster = new Roster(io, store, seed.keys.kMeta, proto.epoch)
  roster.loadPins()
  const session = new Session(io, store, identity, proto, teamSalt, tmk, tmk, roster, 'Ana')
  await roster.publishSelf(identity, {
    deviceId: identity.deviceId,
    edPub: identity.edPub,
    xPub: identity.xPub,
    displayName: 'Ana',
    hostname: 'ana-host',
    osUser: 'ana',
    platform: 'darwin',
    machineIdHash: null,
    firstSeen: Date.now(),
    recSeq: 1,
  })
  await roster.refresh()
  const ch = await session.createChannel('design')
  const events = new StubEvents(session.deviceId)
  const pushes: PushMessage[] = []
  const tier = { value: 'focused' as IoTier }
  const host: BoardHost = {
    events: events as unknown as EventStore,
    noteOwnEvent: () => {},
    tier: () => tier.value,
  }
  const boards = new BoardService(session, host, (m) => pushes.push(m))
  return { root, session, boards, events, pushes, tier, conv: `chan:${ch.channelId}` }
}

function scene(ids: string[], version = 1): BoardFrameDraft {
  return {
    elements: ids.map((id) => ({ id, type: 'rectangle', version, versionNonce: version * 7, isDeleted: false })),
  }
}

function framesIn(root: string, sessionId: string): string[] {
  const dir = join(root, DIR.boards, sessionId)
  return existsSync(dir) ? readdirSync(dir).filter((n) => !n.endsWith('.partial')) : []
}

/**
 * A session id the way `start` builds one: the host's `deviceId8` followed by
 * eight random hex. The prefix is load-bearing — a `board-live` whose author
 * does not own the id it announces is a forgery and is ignored — so a test that
 * hands the service someone else's announcement has to build the id their way.
 */
function sidFor(hostDeviceId: string, tail = 'a1b2c3d4'): string {
  return `${hostDeviceId.slice(0, 8)}${tail}`
}

/**
 * A second service on the same session and the same share: what a restart (or a
 * crash followed by a rejoin) looks like from the share's point of view — the
 * seq counter is gone, the files are not.
 */
function restarted(h: Harness): BoardService {
  return new BoardService(
    h.session,
    { events: h.events as unknown as EventStore, noteOwnEvent: () => {}, tier: () => h.tier.value },
    (m) => h.pushes.push(m),
  )
}

/**
 * This device's frame as it actually sits on the share: decrypted under the
 * conversation key with the same AAD a reader binds, then unwrapped from its
 * signature. `collect()` skips our own files, so a test that wants to know what
 * we published has to open it the way a peer would.
 */
async function publishedFrame(
  h: Harness,
  sessionId: string,
): Promise<{ elements: { id: string }[]; files?: Record<string, unknown> }> {
  const [name] = framesIn(h.root, sessionId)
  const rel = `${DIR.boards}/${sessionId}/${name}`
  const plain = decryptRecord(await h.session.io.read(rel), h.session.convInfo(h.conv)!.key, buildAad('board', rel, name))
  return (JSON.parse(plain.toString('utf8')) as { p: { elements: { id: string }[]; files?: Record<string, unknown> } }).p
}

/** The real timer, captured before any test installs a fake clock over it. */
const realSetTimeout = globalThis.setTimeout

/**
 * Fake timers over a real filesystem, made deterministic.
 *
 * The poll loop re-arms itself only *after* the pass it fired has finished
 * (`tick` awaits `pollOnce`), and that pass is a real `readdir` on a real temp
 * directory. `vi.advanceTimersByTimeAsync` yields the real event loop between
 * timers, but only until it reaches the end of the advance: one extra loop turn
 * — measured, a single `setImmediate` is enough — leaves the pass in flight when
 * the advance returns, so the next timer is armed at a *later* fake instant than
 * the tick that armed it and every poll after it slides past the window a
 * cadence assertion measures. Idle, the readdir wins that race; under a full
 * suite run it does not, which is exactly how this test used to fail there and
 * never on its own.
 *
 * `shareQuiet(io)` returns a function that waits — in real time, without moving
 * the fake clock — until the share has nothing in flight and nothing new
 * started during the last turn. Awaiting it after every advance means fake time
 * only ever moves while the service is idle, so every re-arm happens at exactly
 * the fake instant of the tick that scheduled it.
 */
function shareQuiet(io: ShareIo): () => Promise<void> {
  let started = 0
  let inFlight = 0
  const holder = io as unknown as Record<string, unknown>
  const proto = Object.getPrototypeOf(io) as object
  for (const name of Object.getOwnPropertyNames(proto)) {
    const desc = Object.getOwnPropertyDescriptor(proto, name)
    if (name === 'constructor' || !desc || typeof desc.value !== 'function') continue
    // Read the method off the instance, not the descriptor: a test that has
    // already replaced one has to stay replaced.
    const current = holder[name]
    if (typeof current !== 'function') continue
    const inner = (current as (...a: unknown[]) => unknown).bind(io)
    holder[name] = (...args: unknown[]): unknown => {
      const out = inner(...args)
      if (out instanceof Promise) {
        started += 1
        inFlight += 1
        const done = (): void => {
          inFlight -= 1
        }
        out.then(done, done)
      }
      return out
    }
  }
  return async () => {
    for (let i = 0; i < 1000; i++) {
      const before = started
      // A real macrotask turn. The fake clock owns the timer globals, so this
      // is the only way to let a pending fs completion — and every microtask
      // chained onto it, up to and including the next share call it makes —
      // run without advancing fake time.
      await new Promise((res) => realSetTimeout(res, 0))
      if (inFlight === 0 && started === before) return
    }
    throw new Error('share never went quiet')
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('board frame writing', () => {
  it('coalesces a burst into one frame and keeps exactly one file per writer', async () => {
    const h = await makeHarness('sem-board-write-')
    const { sessionId } = await h.boards.start(h.conv, 'Sprint plan')
    expect(framesIn(h.root, sessionId)).toHaveLength(0)

    // Three edits inside one coalescing window: the newest one wins and the
    // other two never reach the share at all.
    await h.boards.write(sessionId, h.conv, scene(['a']))
    await h.boards.write(sessionId, h.conv, scene(['a', 'b']))
    await h.boards.write(sessionId, h.conv, scene(['a', 'b', 'c']))
    await h.boards.flushWrites()

    const after = framesIn(h.root, sessionId)
    expect(after).toHaveLength(1)
    expect(after[0]).toBe(`${h.session.deviceId8}.00000000`) // seq 0: one publish, not three

    // The next frame replaces the file rather than adding one — a joiner's
    // single readdir must never show two states of the same device.
    await h.boards.write(sessionId, h.conv, scene(['a', 'b', 'c', 'd']))
    await h.boards.flushWrites()
    const second = framesIn(h.root, sessionId)
    expect(second).toHaveLength(1)
    expect(second[0]).toBe(`${h.session.deviceId8}.00000001`)
  }, 60_000)

  it('says nothing when nothing changed, and republishes on the keepalive', async () => {
    const h = await makeHarness('sem-board-keepalive-')
    const { sessionId } = await h.boards.start(h.conv, 'Sprint plan')
    // Fake timers before the first publish: the keepalive is armed by it, and
    // installing them later would simply clear the real timer it created.
    vi.useFakeTimers()
    const drawn = scene(['a'])
    await h.boards.write(sessionId, h.conv, drawn)
    await h.boards.flushWrites()
    expect(framesIn(h.root, sessionId)).toEqual([`${h.session.deviceId8}.00000000`])

    // An identical draft is not news: the keepalive is what keeps this device
    // in everyone's pointer list, so a repeated scene costs zero share I/O.
    await h.boards.write(sessionId, h.conv, scene(['a']))
    await h.boards.flushWrites()
    expect(framesIn(h.root, sessionId)).toEqual([`${h.session.deviceId8}.00000000`])

    await vi.advanceTimersByTimeAsync(BOARD.keepaliveMs + 50)
    await h.boards.flushWrites() // wait out the keepalive's own publish
    expect(framesIn(h.root, sessionId)).toEqual([`${h.session.deviceId8}.00000001`])
    await h.boards.leave(sessionId, h.conv)
  }, 60_000)

  it('drops files before failing, and never writes a partial scene', async () => {
    const h = await makeHarness('sem-board-toolarge-')
    const { sessionId } = await h.boards.start(h.conv, 'Sprint plan')
    const bigFile = 'x'.repeat(BOARD.maxFrameBytes)

    // Over budget because of an image: the shapes still go out, the image
    // doesn't (a peer without it renders every element, just not that fill).
    await h.boards.write(sessionId, h.conv, { ...scene(['a']), files: { f1: { dataURL: bigFile } } })
    await h.boards.flushWrites()
    expect(framesIn(h.root, sessionId)).toHaveLength(1)
    // Read it the way a peer does — decrypted under the conversation key —
    // because "a frame went out" is not the claim: the claim is that the image
    // is the part that was left behind.
    expect((await publishedFrame(h, sessionId)).files).toBeUndefined()

    // Over budget on the shapes alone: loudly refused, and nothing is written.
    const huge = { elements: [{ id: 'a', version: 2, versionNonce: 3, blob: bigFile }] }
    await expect(h.boards.write(sessionId, h.conv, huge)).rejects.toThrow('frame-too-large')
    await h.boards.flushWrites()
    expect(framesIn(h.root, sessionId)).toEqual([`${h.session.deviceId8}.00000000`])
  }, 60_000)

  it('leaving deletes this device’s file and stops the poller', async () => {
    const h = await makeHarness('sem-board-leave-')
    const { sessionId } = await h.boards.start(h.conv, 'Sprint plan')
    await h.boards.write(sessionId, h.conv, scene(['a']))
    await h.boards.flushWrites()
    await h.boards.join(sessionId, h.conv)
    expect(framesIn(h.root, sessionId)).toHaveLength(1)

    await h.boards.leave(sessionId, h.conv)
    expect(framesIn(h.root, sessionId)).toHaveLength(0)
    // The directory itself stays: leaving is not ending.
    expect(existsSync(join(h.root, DIR.boards, sessionId))).toBe(true)
  }, 60_000)
})

describe('board session lifecycle', () => {
  it('refuses to end a session this device did not start', async () => {
    const h = await makeHarness('sem-board-nothost-')
    const other = generateIdentity().identity.deviceId
    const sessionId = sidFor(other)
    h.events.emit(
      h.conv,
      'sys',
      { t: 'sys', conv: h.conv, kind: 'board-live', data: { sessionId, title: 'Theirs', host: other } },
      other,
    )
    expect(h.boards.info(h.conv, sessionId)?.host).toBe(other)
    await expect(h.boards.end(sessionId, h.conv)).rejects.toThrow('not-host')
    await expect(h.boards.end('deadbeefdeadbeef', h.conv)).rejects.toThrow('unknown-session')
  }, 60_000)

  it('ignores a board-ended from anyone but the host', async () => {
    const h = await makeHarness('sem-board-endedforged-')
    const host = generateIdentity().identity.deviceId
    const bystander = generateIdentity().identity.deviceId
    const sessionId = sidFor(host)
    h.events.emit(
      h.conv,
      'sys',
      { t: 'sys', conv: h.conv, kind: 'board-live', data: { sessionId, title: 'Theirs', host } },
      host,
    )
    await h.session.io.ensureDir(`${DIR.boards}/${sessionId}`)
    await h.boards.join(sessionId, h.conv)

    h.events.emit(h.conv, 'sys', { t: 'sys', conv: h.conv, kind: 'board-ended', data: { sessionId } }, bystander)
    expect(h.pushes.filter((p) => p.kind === 'board-ended')).toHaveLength(0)
    expect(h.boards.info(h.conv, sessionId)?.ended).toBe(false)

    h.events.emit(h.conv, 'sys', { t: 'sys', conv: h.conv, kind: 'board-ended', data: { sessionId } }, host)
    expect(h.pushes.filter((p) => p.kind === 'board-ended')).toHaveLength(1)
    expect(h.boards.info(h.conv, sessionId)?.ended).toBe(true)
  }, 60_000)

  it('stops polling when the host ends the session, and again when the dir is gone', async () => {
    const h = await makeHarness('sem-board-pollerstop-')
    const { sessionId } = await h.boards.start(h.conv, 'Sprint plan')
    await h.boards.join(sessionId, h.conv)

    await h.boards.end(sessionId, h.conv)
    expect(h.pushes.filter((p) => p.kind === 'board-ended')).toHaveLength(1)
    expect(existsSync(join(h.root, DIR.boards, sessionId))).toBe(false)
    // The reader is gone: a poll after the fact is a no-op, not a second push.
    await h.boards.pollOnce(sessionId)
    expect(h.pushes.filter((p) => p.kind === 'board-ended')).toHaveLength(1)
    // And the session stays ended for every later call.
    await expect(h.boards.join(sessionId, h.conv)).rejects.toThrow('board-ended')
    await expect(h.boards.write(sessionId, h.conv, scene(['a']))).rejects.toThrow('board-ended')
  }, 60_000)

  it('joining a session whose directory is gone reports it as ended', async () => {
    const h = await makeHarness('sem-board-gone-')
    const other = generateIdentity().identity.deviceId
    const sessionId = sidFor(other)
    h.events.emit(
      h.conv,
      'sys',
      { t: 'sys', conv: h.conv, kind: 'board-live', data: { sessionId, title: 'Gone', host: other } },
      other,
    )
    await expect(h.boards.join(sessionId, h.conv)).rejects.toThrow('board-ended')
  }, 60_000)

  it('polls on the tier cadence and makes no share I/O at all while paused', async () => {
    const h = await makeHarness('sem-board-tier-')
    const { sessionId } = await h.boards.start(h.conv, 'Sprint plan')
    // A poll pass is real fs work the loop awaits before re-arming, so every
    // advance below is followed by `quiet()`: fake time moves only while the
    // service has nothing in flight. Without it this test measures a cadence
    // against a timer armed at whatever fake instant a real readdir happened to
    // land on — see `shareQuiet`.
    const quiet = shareQuiet(h.session.io)
    // The poll loop is armed by join, so the clock has to be fake by then.
    vi.useFakeTimers()
    await h.boards.join(sessionId, h.conv)
    await quiet()

    // 'idle' is the window visible but untouched for minutes. With a live editor
    // open that is still someone watching, so it polls on the *blurred* cadence
    // rather than anything derived from the idle I/O budget.
    h.tier.value = 'idle'
    await vi.advanceTimersByTimeAsync(BOARD.pollFocusedMs) // the focused timer join armed
    await quiet() // that pass re-arms on the blurred cadence before the clock moves on
    h.session.io.resetStats()
    await vi.advanceTimersByTimeAsync(BOARD.pollFocusedMs)
    await quiet()
    expect(h.session.io.stats().total).toBe(0)
    await vi.advanceTimersByTimeAsync(BOARD.pollBlurredMs - BOARD.pollFocusedMs + 50)
    await quiet()
    expect(h.session.io.stats().total).toBeGreaterThan(0)

    h.tier.value = 'paused'
    h.session.io.resetStats()
    await vi.advanceTimersByTimeAsync(BOARD.pollBlurredMs * 3)
    await quiet()
    expect(h.session.io.stats().total).toBe(0)

    // Coming back does not need a re-join: the loop picks itself up. The timer
    // pending when the tier changed was armed on the blurred cadence, so wait
    // out that one plus the focused one it re-arms.
    h.tier.value = 'focused'
    await vi.advanceTimersByTimeAsync(BOARD.pollBlurredMs + BOARD.pollFocusedMs + 50)
    await quiet()
    expect(h.session.io.stats().total).toBeGreaterThan(0)
    await h.boards.leave(sessionId, h.conv)
  }, 60_000)
})

describe('board writer identity across restarts', () => {
  it('picks the seq up from the share instead of starting over at 0', async () => {
    const h = await makeHarness('sem-board-reseq-')
    const { sessionId } = await h.boards.start(h.conv, 'Sprint plan')
    await h.boards.write(sessionId, h.conv, scene(['a']))
    await h.boards.flushWrites()
    expect(framesIn(h.root, sessionId)).toEqual([`${h.session.deviceId8}.00000000`])

    // A crash between the publish and the delete-previous: two files in one
    // slot, which a joiner's single readdir is not supposed to see.
    writeFileSync(join(h.root, DIR.boards, sessionId, `${h.session.deviceId8}.00000005`), 'stale')

    // Same device, new service: the counter died with the old process. Starting
    // at 0 again would publish a seq every peer has already delivered — its
    // frames would be invisible for the rest of the session.
    const back = restarted(h)
    await back.write(sessionId, h.conv, scene(['a', 'b']))
    await back.flushWrites()
    expect(framesIn(h.root, sessionId)).toEqual([`${h.session.deviceId8}.00000006`])
    await back.stop()
  }, 60_000)

  it('stop() leaves every session it is in: timers off, own files gone', async () => {
    const h = await makeHarness('sem-board-stop-')
    const { sessionId } = await h.boards.start(h.conv, 'Sprint plan')
    await h.boards.write(sessionId, h.conv, scene(['a']))
    await h.boards.flushWrites()
    await h.boards.join(sessionId, h.conv)
    expect(framesIn(h.root, sessionId)).toHaveLength(1)

    // The window closed, the team folder changed, or we are quitting — all three
    // go through here (AppController owns it). On macOS the process outlives the
    // window, so these timers used to keep polling and publishing into a session
    // with nobody left to push a frame to.
    await h.boards.stop()
    expect(framesIn(h.root, sessionId)).toHaveLength(0)
    // Leaving is not ending: the directory (and everyone else's frames) stays.
    expect(existsSync(join(h.root, DIR.boards, sessionId))).toBe(true)
    h.session.io.resetStats()
    await h.boards.pollOnce(sessionId)
    expect(h.session.io.stats().total).toBe(0)
  }, 60_000)

  it('publishes one frame on join, so a watcher is in everyone else’s list', async () => {
    const h = await makeHarness('sem-board-watcher-')
    const host = generateIdentity().identity.deviceId
    const sessionId = sidFor(host)
    h.events.emit(
      h.conv,
      'sys',
      { t: 'sys', conv: h.conv, kind: 'board-live', data: { sessionId, title: 'Theirs', host } },
      host,
    )
    await h.session.io.ensureDir(`${DIR.boards}/${sessionId}`)

    // Joining without drawing anything used to leave this device invisible for
    // the whole session: the keepalive is armed by a publish, not by a join.
    await h.boards.join(sessionId, h.conv)
    expect(framesIn(h.root, sessionId)).toEqual([`${h.session.deviceId8}.00000000`])
    await h.boards.leave(sessionId, h.conv)
    expect(framesIn(h.root, sessionId)).toHaveLength(0)
  }, 60_000)
})

describe('board session ids and conversation binding', () => {
  it('refuses a session id that is not 16 hex, at every entry point', async () => {
    const h = await makeHarness('sem-board-badid-')
    // `boards/<sessionId>/…` is a path on the share: this used to walk out of
    // the share root entirely.
    for (const bad of ['../../etc/passwd', '..', '', 'zz'.repeat(8), 'ab'.repeat(10), '/abs/olute']) {
      await expect(h.boards.join(bad, h.conv)).rejects.toThrow('bad-session-id')
      await expect(h.boards.write(bad, h.conv, scene(['a']))).rejects.toThrow('bad-session-id')
      await expect(h.boards.leave(bad, h.conv)).rejects.toThrow('bad-session-id')
      await expect(h.boards.end(bad, h.conv)).rejects.toThrow('bad-session-id')
    }
  }, 60_000)

  it('ignores a board-ended for a session nobody announced, and the board still opens', async () => {
    const h = await makeHarness('sem-board-preblock-')
    const host = generateIdentity().identity.deviceId
    const bystander = generateIdentity().identity.deviceId
    const sessionId = sidFor(host)

    // Minting a session from an ending let any member pre-block an id: the entry
    // existed, `ended`, and the real announcement arriving later found it taken.
    h.events.emit(h.conv, 'sys', { t: 'sys', conv: h.conv, kind: 'board-ended', data: { sessionId } }, bystander)
    expect(h.boards.info(h.conv, sessionId)).toBeNull()

    h.events.emit(
      h.conv,
      'sys',
      { t: 'sys', conv: h.conv, kind: 'board-live', data: { sessionId, title: 'Theirs', host } },
      host,
    )
    expect(h.boards.info(h.conv, sessionId)?.ended).toBe(false)
    await h.session.io.ensureDir(`${DIR.boards}/${sessionId}`)
    await expect(h.boards.join(sessionId, h.conv)).resolves.toBeTruthy()
    await h.boards.leave(sessionId, h.conv)
  }, 60_000)

  it('ignores an unverified board-live, and one announcing an id that is not the author’s', async () => {
    const h = await makeHarness('sem-board-liveforged-')
    const host = generateIdentity().identity.deviceId
    const impostor = generateIdentity().identity.deviceId

    const unverified = sidFor(host, 'deadbeef')
    h.events.emit(
      h.conv,
      'sys',
      { t: 'sys', conv: h.conv, kind: 'board-live', data: { sessionId: unverified, host } },
      host,
      false,
    )
    expect(h.boards.info(h.conv, unverified)).toBeNull()

    // The id's first eight characters are its creator's device. An announcement
    // from anyone else is not an announcement — which is what stopped a
    // duplicate `board-live` from taking the host seat, and with it the right to
    // end the board for everyone.
    const theirs = sidFor(host)
    h.events.emit(h.conv, 'sys', { t: 'sys', conv: h.conv, kind: 'board-live', data: { sessionId: theirs, host } }, host)
    h.events.emit(
      h.conv,
      'sys',
      { t: 'sys', conv: h.conv, kind: 'board-live', data: { sessionId: theirs, host: impostor } },
      impostor,
    )
    expect(h.boards.info(h.conv, theirs)?.host).toBe(host)

    await h.session.io.ensureDir(`${DIR.boards}/${theirs}`)
    await h.boards.join(theirs, h.conv)
    h.events.emit(h.conv, 'sys', { t: 'sys', conv: h.conv, kind: 'board-ended', data: { sessionId: theirs } }, impostor)
    expect(h.pushes.filter((p) => p.kind === 'board-ended')).toHaveLength(0)
    await h.boards.leave(theirs, h.conv)
  }, 60_000)

  it('refuses a board in a team conversation, and a second live one in the same conversation', async () => {
    const h = await makeHarness('sem-board-startcap-')
    // team/ is LWW app state the janitor never sweeps: a board there would be a
    // directory nobody ever cleans up, in a conversation with no collaborators.
    await expect(h.boards.start(TEAM_CONV.calendar, 'Nope')).rejects.toThrow('unsupported-conversation')
    // "Already live" means this device is still in it — which is what an open
    // editor holds: the host joins its own session to see everyone else's
    // frames. A session it has left is the user asking for a new board.
    const { sessionId } = await h.boards.start(h.conv, 'First')
    await h.boards.join(sessionId, h.conv)
    await expect(h.boards.start(h.conv, 'Second')).rejects.toThrow('board-already-live')
    await h.boards.leave(sessionId, h.conv)
    await expect(h.boards.start(h.conv, 'Second')).resolves.toBeTruthy()
    // Another conversation is fine — the cap is per conversation, not global.
    const other = await h.session.createChannel('elsewhere')
    await expect(h.boards.start(`chan:${other.channelId}`, 'Elsewhere')).resolves.toBeTruthy()
  }, 60_000)

  it('refuses a write, leave or end that names a different conversation', async () => {
    const h = await makeHarness('sem-board-convbind-')
    const { sessionId } = await h.boards.start(h.conv, 'Sprint plan')
    const other = `chan:${(await h.session.createChannel('other')).channelId}` as ConvId
    // The frame's key and AAD both come from the conversation: a write under
    // another conv would encrypt this board's scene under a key the people in it
    // do not have — and one that other people do.
    await expect(h.boards.write(sessionId, other, scene(['a']))).rejects.toThrow('conv-mismatch')
    await expect(h.boards.leave(sessionId, other)).rejects.toThrow('conv-mismatch')
    await expect(h.boards.end(sessionId, other)).rejects.toThrow('conv-mismatch')
    await expect(h.boards.join(sessionId, other)).rejects.toThrow('conv-mismatch')
  }, 60_000)

  it('forgets an ended session once the grace has passed', async () => {
    const h = await makeHarness('sem-board-prune-')
    const { sessionId } = await h.boards.start(h.conv, 'Sprint plan')
    await h.boards.end(sessionId, h.conv)
    expect(h.boards.info(h.conv, sessionId)?.ended).toBe(true)

    // Ended sessions used to accumulate for the life of the process. They are
    // kept for a grace period first, because "is this board over?" is asked
    // right after it ends — by a renderer that has not repainted yet.
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 10 * 60_000)
    await h.boards.start(h.conv, 'Next') // any entry point prunes
    expect(h.boards.info(h.conv, sessionId)).toBeNull()
  }, 60_000)

  it('refuses a result stem that is not an event stem', async () => {
    const h = await makeHarness('sem-board-stem-')
    const { sessionId } = await h.boards.start(h.conv, 'Sprint plan')
    await expect(h.boards.end(sessionId, h.conv, '../../../blobs')).rejects.toThrow('bad-result-stem')
    expect(existsSync(join(h.root, DIR.boards, sessionId))).toBe(true)
    await h.boards.end(sessionId, h.conv, `${'1'.repeat(13)}-0001-${h.session.deviceId8}`)
    expect(existsSync(join(h.root, DIR.boards, sessionId))).toBe(false)
  }, 60_000)
})

describe('board writing against a share that moved', () => {
  it('reports the files the budget dropped instead of swallowing them', async () => {
    const h = await makeHarness('sem-board-dropped-')
    const { sessionId } = await h.boards.start(h.conv, 'Sprint plan')
    const big = { ...scene(['a']), files: { f1: { dataURL: 'x'.repeat(BOARD.maxFrameBytes) } } }
    expect((await h.boards.write(sessionId, h.conv, big)).droppedFiles).toEqual(['f1'])
    expect((await h.boards.write(sessionId, h.conv, scene(['a', 'b']))).droppedFiles).toEqual([])
    await h.boards.flushWrites()
  }, 60_000)

  it('treats a vanished session directory as the end, and never recreates it', async () => {
    const h = await makeHarness('sem-board-noresurrect-')
    const { sessionId } = await h.boards.start(h.conv, 'Sprint plan')
    await h.boards.join(sessionId, h.conv)
    // The janitor swept it, or the host's machine went away with it.
    await h.session.io.delete(`${DIR.boards}/${sessionId}`)

    await h.boards.write(sessionId, h.conv, scene(['a']))
    await h.boards.flushWrites()
    // `io.publish` mkdir -p's its way to the file: without the check this left a
    // directory behind with one frame in it and no host who could ever end it.
    expect(existsSync(join(h.root, DIR.boards, sessionId))).toBe(false)
    expect(h.pushes.filter((p) => p.kind === 'board-ended')).toHaveLength(1)
  }, 60_000)

  it('skips the keepalive while paused and re-arms it for when the machine is back', async () => {
    const h = await makeHarness('sem-board-kapaused-')
    const { sessionId } = await h.boards.start(h.conv, 'Sprint plan')
    vi.useFakeTimers()
    await h.boards.write(sessionId, h.conv, scene(['a']))
    await h.boards.flushWrites()
    expect(framesIn(h.root, sessionId)).toEqual([`${h.session.deviceId8}.00000000`])

    // Paused is a locked or suspended machine: no share I/O at all, the same
    // rule the poller follows. A sleeping laptop used to keep publishing one
    // keepalive frame every ten seconds.
    h.tier.value = 'paused'
    await vi.advanceTimersByTimeAsync(BOARD.keepaliveMs * 2 + 50)
    await h.boards.flushWrites()
    expect(framesIn(h.root, sessionId)).toEqual([`${h.session.deviceId8}.00000000`])

    // Re-armed, not abandoned: coming back puts this device in everyone's
    // pointer list again without a re-join.
    h.tier.value = 'focused'
    await vi.advanceTimersByTimeAsync(BOARD.keepaliveMs + 50)
    await h.boards.flushWrites()
    expect(framesIn(h.root, sessionId)).toEqual([`${h.session.deviceId8}.00000001`])
    await h.boards.leave(sessionId, h.conv)
  }, 60_000)
})

describe('the janitor sweeps board sessions', () => {
  it('deletes a dead session, keeps a live one, and always deletes past the hard limit', async () => {
    const h = await makeHarness('sem-board-janitor-')
    const now = Date.now()
    /**
     * One session directory with a frame per age given. The directory's own
     * mtime is deliberately left at "now" unless `dirAgeMs` says otherwise —
     * which is the whole point of this fixture. The old version back-dated the
     * dir after writing the files, a state the share can never produce (every
     * publish and delete inside a live session's dir bumps its mtime), and that
     * lie was the only reason the hard-limit assertion passed.
     */
    const mk = (id: string, fileAgesMs: number[], dirAgeMs?: number): void => {
      const dir = join(h.root, DIR.boards, id)
      mkdirSync(dir, { recursive: true })
      fileAgesMs.forEach((age, i) => {
        const file = join(dir, `${h.session.deviceId8}.0000000${i}`)
        writeFileSync(file, 'frame')
        const at = (now - age) / 1000
        utimesSync(file, at, at)
      })
      if (dirAgeMs !== undefined) {
        const dirAt = (now - dirAgeMs) / 1000
        utimesSync(dir, dirAt, dirAt)
      }
    }
    mk('live0000', [5_000])
    mk('dead0000', [RETENTION.boardsDeadMinutes * 60_000 + 60_000])
    // Still being drawn on (its newest frame is seconds old, and so is the
    // directory) but someone's frame has been sitting there for a day: the hard
    // limit is read off the OLDEST frame, so it fires.
    mk('hard0000', [RETENTION.boardsHardHours * 3_600_000 + 60_000, 5_000])
    // Announced but never drawn on — judged by the directory's own mtime, so a
    // board created seconds ago is not swept out from under its host.
    const fresh = join(h.root, DIR.boards, 'empty000')
    mkdirSync(fresh, { recursive: true })
    // Empty and old: the host announced it and went away. Nothing else can date
    // this one, so the directory's mtime is exactly right here.
    mk('emptyold', [], RETENTION.boardsDeadMinutes * 60_000 + 60_000)

    const counts = await new Janitor(h.session).sweep()
    expect(existsSync(join(h.root, DIR.boards, 'live0000'))).toBe(true)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(join(h.root, DIR.boards, 'dead0000'))).toBe(false)
    expect(existsSync(join(h.root, DIR.boards, 'hard0000'))).toBe(false)
    expect(existsSync(join(h.root, DIR.boards, 'emptyold'))).toBe(false)
    expect(counts.boards).toBe(3)
  }, 60_000)
})

describe('board frame helpers', () => {
  it('a content signature follows element versions, not their order in the array', () => {
    const a = scene(['a', 'b'])
    expect(contentSignature(a)).toBe(contentSignature(scene(['a', 'b'])))
    expect(contentSignature(a)).not.toBe(contentSignature(scene(['a', 'b'], 2)))
    expect(contentSignature(a)).not.toBe(contentSignature(scene(['a', 'b', 'c'])))
    // A newly introduced file is a content change even when no shape moved.
    expect(contentSignature({ ...a, files: { f1: {} } })).not.toBe(contentSignature(a))
  })

  it('a pointer signature covers the pointer and the selection only', () => {
    const base = scene(['a'])
    const p1: BoardFrameDraft = { ...base, pointer: { x: 10, y: 20, tool: 'pointer' }, selectedIds: ['a'] }
    expect(pointerSignature(p1)).toBe(
      pointerSignature({ ...scene(['a'], 9), pointer: { x: 10.4, y: 19.8, tool: 'pointer' }, selectedIds: ['a'] }),
    )
    expect(pointerSignature(p1)).not.toBe(pointerSignature({ ...p1, pointer: { x: 11, y: 20, tool: 'laser' } }))
    expect(pointerSignature(p1)).not.toBe(pointerSignature({ ...p1, selectedIds: [] }))
  })

  it('fitFrame drops files first, says which, and then refuses', () => {
    const small = scene(['a'])
    expect(fitFrame(small).frame).toBe(small)
    expect(fitFrame(small).droppedFiles).toEqual([])
    const withBigFile = { ...small, files: { f1: { dataURL: 'y'.repeat(BOARD.maxFrameBytes) } } }
    expect(fitFrame(withBigFile).frame.files).toBeUndefined()
    expect(fitFrame(withBigFile).frame.elements).toHaveLength(1)
    // The caller has to learn which ids went, or the peer that never got the
    // image has a shape that stays blank for the rest of the session.
    expect(fitFrame(withBigFile).droppedFiles).toEqual(['f1'])
    expect(() => fitFrame({ elements: [{ id: 'a', blob: 'z'.repeat(BOARD.maxFrameBytes) }] })).toThrow(
      'frame-too-large',
    )
  })

  it('refuses a scene over the element cap, so the sender hears about it', () => {
    // The receivers clamp too. Without this the cap was silent: a runaway scene
    // published happily while every peer quietly truncated it.
    const runaway = { elements: Array.from({ length: BOARD.maxElements + 1 }, (_, i) => ({ id: `e${i}`, version: 1 })) }
    expect(() => fitFrame(runaway)).toThrow('frame-too-large')
    const atCap = { elements: runaway.elements.slice(0, BOARD.maxElements) }
    expect(fitFrame(atCap).frame.elements).toHaveLength(BOARD.maxElements)
  })

  it('only toasts a board-live young enough to still be running', () => {
    const now = 1_700_000_000_000
    expect(boardLiveIsFresh(now - 1_000, now)).toBe(true)
    expect(boardLiveIsFresh(now - (RETENTION.boardsDeadMinutes * 60_000 - 1_000), now)).toBe(true)
    // Past the janitor's dead line the directory may already be gone: a toast
    // for it is an invitation to join nothing.
    expect(boardLiveIsFresh(now - (RETENTION.boardsDeadMinutes * 60_000 + 1_000), now)).toBe(false)
    // A `board-live` from a client that omitted startedAt says nothing about
    // when it started, and is not worth waking anyone for.
    expect(boardLiveIsFresh(0, now)).toBe(false)
    expect(boardLiveIsFresh(Number.NaN, now)).toBe(false)
  })

  it('the board-live line names the host and the board, and says nothing when previews are off', () => {
    expect(boardLiveNotifyLine({ who: 'Ana', where: '#design', title: 'Sprint plan', previews: true })).toEqual({
      title: '#design',
      body: 'Ana opened a live board: Sprint plan',
    })
    expect(boardLiveNotifyLine({ who: 'Ana', where: '#design', title: '', previews: true }).body).toBe(
      'Ana opened a live board',
    )
    expect(boardLiveNotifyLine({ who: 'Ana', where: '#design', title: 'Sprint plan', previews: false })).toEqual({
      title: 'Chat',
      body: 'New live board',
    })
  })
})
