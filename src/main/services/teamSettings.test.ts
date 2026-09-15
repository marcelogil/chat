import { describe, expect, it, vi } from 'vitest'

// ChatService reaches for Electron's Notification on the chat paths; nothing
// here notifies (team logs never do), so the stub only has to make the import
// resolve in the node test environment.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  Notification: class {
    static isSupported(): boolean {
      return false
    }
    on(): this {
      return this
    }
    show(): void {}
  },
}))

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConvId, SysPayload, TrustState, VerifiedEvent } from '@shared/types'
import type { PushMessage, SettingsView } from '@shared/bridge'
import { TEAM_CONV } from '@shared/constants'
import { TEAM_NAME_MAX } from '@shared/teamName'
import { generateIdentity } from '../crypto/identity'
import type { SecretStore } from '../store/secretStore'
import { createOrJoinTeam } from '../transport/bootstrap'
import { EventStore } from '../transport/events'
import { Roster } from '../transport/roster'
import { Session } from '../transport/session'
import { ShareIo } from '../transport/shareIo'
import { ChatService } from './chatService'
import {
  foldTeamName as foldTeamNameWith,
  foldTeamRenamed as foldTeamRenamedWith,
  teamRenamePayload,
  type AuthorLookup,
  type TeamNameFold,
} from './teamSettings'

// Team rename (1.5). Three things have to hold:
//   - the fold is last-writer-wins by event id and refuses anything it would
//     have to guess about (unverified, empty, over-long, not a string);
//   - renameTeam publishes through the ordinary team path — outbox included —
//     and the new name reaches the renderer as a `team` push;
//   - a client that was switched off for the rename folds it out of the log on
//     the next cold start, because protocol.json still says the old name.

// ---------------------------------------------------------------------------
// The fold, on its own

const PASS = 'correct horse battery staple'
const AUTHOR = 'aaaaaaaa'

function ev(
  id: string,
  name: unknown,
  opts: { verified?: boolean; author?: string; kind?: SysPayload['kind']; conv?: ConvId } = {},
): VerifiedEvent {
  const conv = opts.conv ?? TEAM_CONV.settings
  return {
    id,
    type: 'sys',
    payload: { t: 'sys', conv, kind: opts.kind ?? 'team-renamed', data: { name } } as SysPayload,
    author: opts.author ?? AUTHOR,
    verified: opts.verified !== false,
    receivedAt: 0,
  }
}

const stem = (ms: number) => `${String(ms).padStart(13, '0')}-0000-${AUTHOR}`

// The admin gate (1.5): both fold entry points ask the roster who wrote the
// event. Most of what follows is about the LWW rule rather than the gate, so
// these wrappers default the lookup to "a pinned Gil" and the gate's own tests
// pass a different one.
const pinnedAdmin: AuthorLookup = () => ({ displayName: 'Gil', trust: 'pinned' })
const foldTeamName = (conv: ConvId, events: Iterable<VerifiedEvent>, authorOf: AuthorLookup = pinnedAdmin) =>
  foldTeamNameWith(conv, events, authorOf)
const foldTeamRenamed = (
  current: TeamNameFold | null,
  conv: ConvId,
  event: VerifiedEvent,
  authorOf: AuthorLookup = pinnedAdmin,
) => foldTeamRenamedWith(current, conv, event, authorOf)

describe('folding team-renamed events', () => {
  it('takes the newest event id, whatever order the files arrive in', () => {
    const events = [ev(stem(3), 'Third'), ev(stem(1), 'First'), ev(stem(2), 'Second')]
    expect(foldTeamName(TEAM_CONV.settings, events)?.name).toBe('Third')
    expect(foldTeamName(TEAM_CONV.settings, [...events].reverse())?.name).toBe('Third')
  })

  it('ignores an unverified event — anyone can drop a file into the share', () => {
    const fold = foldTeamName(TEAM_CONV.settings, [
      ev(stem(1), 'Signed'),
      ev(stem(9), 'Forged', { verified: false }),
    ])
    expect(fold?.name).toBe('Signed')
  })

  it('refuses an empty name and one over the length limit', () => {
    expect(foldTeamName(TEAM_CONV.settings, [ev(stem(1), '   ')])).toBeNull()
    expect(foldTeamName(TEAM_CONV.settings, [ev(stem(1), 'x'.repeat(TEAM_NAME_MAX + 1))])).toBeNull()
    // …and keeps the last good one rather than falling back to nothing.
    const fold = foldTeamName(TEAM_CONV.settings, [ev(stem(1), 'Ops Crew'), ev(stem(2), '')])
    expect(fold?.name).toBe('Ops Crew')
    expect(foldTeamName(TEAM_CONV.settings, [ev(stem(1), 'x'.repeat(TEAM_NAME_MAX))])?.name).toHaveLength(
      TEAM_NAME_MAX,
    )
  })

  it('ignores anything that is not a team-renamed sys event in team:settings', () => {
    expect(foldTeamName(TEAM_CONV.settings, [ev(stem(1), 42)])).toBeNull()
    expect(foldTeamName(TEAM_CONV.settings, [ev(stem(1), 'Nope', { kind: 'channel-renamed' })])).toBeNull()
    expect(foldTeamName(TEAM_CONV.calendar, [ev(stem(1), 'Nope', { conv: TEAM_CONV.calendar })])).toBeNull()
    expect(foldTeamName(TEAM_CONV.settings, [{ ...ev(stem(1), 'Nope'), type: 'msg' }])).toBeNull()
  })

  it('ignores a malformed payload instead of throwing at the event fan-out', () => {
    // A roster signature says who wrote the file, not that what they wrote is
    // well-formed: an insider or a future build can publish `null`, or a `data`
    // that is not an object. `onEvent` runs its listeners in a chain, so a
    // TypeError here would skip every listener queued behind this one.
    const raw = (payload: unknown): VerifiedEvent => ({ ...ev(stem(1), 'x'), payload: payload as SysPayload })
    const sys = (data: unknown) => raw({ t: 'sys', conv: TEAM_CONV.settings, kind: 'team-renamed', data })
    expect(() => foldTeamName(TEAM_CONV.settings, [raw(null)])).not.toThrow()
    expect(foldTeamName(TEAM_CONV.settings, [raw(null)])).toBeNull()
    expect(foldTeamName(TEAM_CONV.settings, [sys(null)])).toBeNull()
    expect(foldTeamName(TEAM_CONV.settings, [sys(undefined)])).toBeNull()
    expect(foldTeamName(TEAM_CONV.settings, [sys('Ops Crew')])).toBeNull()
    // …and a good event behind the malformed one still wins.
    expect(foldTeamName(TEAM_CONV.settings, [raw(null), sys(null), ev(stem(2), 'Ops Crew')])?.name).toBe('Ops Crew')
  })

  it('normalizes like the Settings field: trimmed, whitespace collapsed', () => {
    expect(foldTeamName(TEAM_CONV.settings, [ev(stem(1), '  Ops   Crew\n')])?.name).toBe('Ops Crew')
  })

  it('reports no change for a replayed winner or an older writer', () => {
    const first = foldTeamRenamed(null, TEAM_CONV.settings, ev(stem(5), 'Ops Crew'))!
    expect(first.name).toBe('Ops Crew')
    expect(foldTeamRenamed(first, TEAM_CONV.settings, ev(stem(5), 'Ops Crew'))).toBeNull()
    expect(foldTeamRenamed(first, TEAM_CONV.settings, ev(stem(4), 'Older'))).toBeNull()
    expect(foldTeamRenamed(first, TEAM_CONV.settings, ev(stem(6), 'Newer'))?.name).toBe('Newer')
  })

  it('advances the watermark for a newer event that says the same thing', () => {
    const first = foldTeamRenamed(null, TEAM_CONV.settings, ev(stem(5), 'Ops Crew'))!
    // Same name, newer id: nothing to push…
    expect(foldTeamRenamed(first, TEAM_CONV.settings, ev(stem(7), 'Ops Crew'))).toBeNull()
    // …but the rename it overtook must not be able to win afterwards.
    expect(foldTeamRenamed(first, TEAM_CONV.settings, ev(stem(6), 'Stale'))).toBeNull()
  })
})

describe('the admin gate on the fold', () => {
  // The rule that actually holds the panel up. Hiding Settings → Admin and
  // refusing in ChatService.renameTeam are both code on the writer's own
  // machine; a shared folder cannot refuse a write, so what stops a rename
  // from anybody but Gil is that no other client folds it.
  const author = (displayName: string, trust: TrustState): AuthorLookup => () => ({ displayName, trust })

  it('ignores a rename from somebody who is not an admin', () => {
    expect(foldTeamName(TEAM_CONV.settings, [ev(stem(1), 'Bob Crew')], author('Bob', 'pinned'))).toBeNull()
  })

  it('ignores a TOFU-flagged device claiming the admin name', () => {
    // A second device registering as "Gil" is exactly what Roster.ingest flags,
    // and it is exactly the attack the gate has to survive — otherwise being an
    // admin is "type Gil in the onboarding box".
    expect(foldTeamName(TEAM_CONV.settings, [ev(stem(1), 'Impostor Crew')], author('Gil', 'flagged'))).toBeNull()
  })

  it('ignores an author the roster cannot resolve at all', () => {
    expect(foldTeamName(TEAM_CONV.settings, [ev(stem(1), 'Ghost Crew')], () => null)).toBeNull()
  })

  it('accepts an admin however the roster spells the name, pinned or hand-trusted', () => {
    for (const name of ['Gil', 'gil', 'GIL', '  Gil  ']) {
      expect(foldTeamName(TEAM_CONV.settings, [ev(stem(1), 'Ops Crew')], author(name, 'pinned'))?.name).toBe('Ops Crew')
    }
    expect(foldTeamName(TEAM_CONV.settings, [ev(stem(1), 'Ops Crew')], author('Gil', 'trusted'))?.name).toBe('Ops Crew')
  })

  it('does not let a refused rename win — or even move the watermark', () => {
    const lookup: AuthorLookup = (deviceId) =>
      deviceId === 'gilgilgi' ? { displayName: 'Gil', trust: 'pinned' } : { displayName: 'Mallory', trust: 'pinned' }
    const gil = ev(stem(1), 'Ops Crew', { author: 'gilgilgi' })
    const hijack = ev(stem(9), 'Mallory Crew', { author: 'mallory1' })
    expect(foldTeamName(TEAM_CONV.settings, [gil, hijack], lookup)?.name).toBe('Ops Crew')
    expect(foldTeamName(TEAM_CONV.settings, [hijack, gil], lookup)?.name).toBe('Ops Crew')
    // The refused event is not a watermark either: an admin rename older than
    // it still lands.
    const fold = foldTeamRenamed(null, TEAM_CONV.settings, hijack, lookup)
    expect(fold).toBeNull()
    expect(foldTeamRenamed(null, TEAM_CONV.settings, gil, lookup)?.name).toBe('Ops Crew')
  })
})

// ---------------------------------------------------------------------------
// The live service

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

async function makeSession(root: string, name: string): Promise<Session> {
  const store = new FakeStore()
  const identity = generateIdentity().identity
  const io = new ShareIo(root)
  const result = await createOrJoinTeam(io, PASS, 'Test Team')
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

/** A started ChatService on `root`, with protocol.json's name as its base. */
async function clientOn(root: string, name: string): Promise<{ chat: ChatService; pushes: PushMessage[]; folded: string[] }> {
  const chat = new ChatService(await makeSession(root, name), () => null, settings)
  chat.teamNameBase = 'Test Team'
  const pushes: PushMessage[] = []
  const folded: string[] = []
  chat.setPush((m) => pushes.push(m))
  await chat.start()
  // AppController wires this after start(), to keep BootMode.self in step.
  chat.teamNameHandler = (n) => folded.push(n)
  return { chat, pushes, folded }
}

const teamPushes = (pushes: PushMessage[]): string[] =>
  pushes.filter((p): p is Extract<PushMessage, { kind: 'team' }> => p.kind === 'team').map((p) => p.teamName)

describe('ChatService.renameTeam', () => {
  it('publishes, folds, pushes the new name and refuses a name it would not fold', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sem-team-rename-'))
    const { chat, pushes, folded } = await clientOn(root, 'Gil')
    expect(chat.teamName()).toBe('Test Team')

    await expect(chat.renameTeam('  Ops   Crew ')).resolves.toEqual({ queued: false })
    expect(chat.teamName()).toBe('Ops Crew')
    expect(teamPushes(pushes)).toEqual(['Ops Crew'])
    expect(folded).toEqual(['Ops Crew'])

    // The same name again is not a second event, and not a second push.
    await expect(chat.renameTeam('Ops Crew')).resolves.toEqual({ queued: false })
    expect(teamPushes(pushes)).toEqual(['Ops Crew'])

    await expect(chat.renameTeam('   ')).rejects.toThrow('invalid-name')
    await expect(chat.renameTeam('x'.repeat(TEAM_NAME_MAX + 1))).rejects.toThrow('invalid-name')
    expect(chat.teamName()).toBe('Ops Crew')

    // It really is on the share, as a signed event in the team settings log.
    const reader = new EventStore(await makeSession(root, 'Reader'))
    await reader.catchUp(TEAM_CONV.settings)
    const events = reader.getEvents(TEAM_CONV.settings)
    expect(events).toHaveLength(1)
    expect(events[0].verified).toBe(true)
    expect((events[0].payload as SysPayload).kind).toBe('team-renamed')
    expect(foldTeamName(TEAM_CONV.settings, events)?.name).toBe('Ops Crew')

    await chat.stop()
  })

  it('writes nothing when the team already has the name that was asked for', async () => {
    // `{ queued: false }` from this path means "nothing is waiting", not "an
    // event was written" — the Settings pane tells the two apart by comparing
    // against the name it had (teamRenameSaveNotice), so the toast can't claim
    // a rename that never happened.
    const root = mkdtempSync(join(tmpdir(), 'sem-team-rename-noop-'))
    const { chat, pushes, folded } = await clientOn(root, 'Gil')
    await chat.renameTeam('Ops Crew')
    const publish = vi.spyOn((chat as unknown as { events: EventStore }).events, 'publish')

    await expect(chat.renameTeam('  Ops   Crew ')).resolves.toEqual({ queued: false })
    expect(publish).not.toHaveBeenCalled()
    expect(teamPushes(pushes)).toEqual(['Ops Crew'])
    expect(folded).toEqual(['Ops Crew'])

    publish.mockRestore()
    await chat.stop()
  })

  it('queues the rename when the share is unreachable instead of failing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sem-team-rename-offline-'))
    const { chat, pushes } = await clientOn(root, 'Gil')
    ;(chat as unknown as { events: EventStore }).events.publish = (() =>
      Promise.reject(new Error('ENOENT: share gone'))) as never

    await expect(chat.renameTeam('Ops Crew')).resolves.toEqual({ queued: true })
    // Nothing folded — the name only changes when the event actually lands.
    expect(chat.teamName()).toBe('Test Team')
    expect(teamPushes(pushes)).toEqual([])
    expect(pushes.filter((p) => p.kind === 'outbox')).toHaveLength(1)

    await chat.stop()
  })

  it('refuses a rename from anybody but an admin, and writes nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sem-team-rename-not-admin-'))
    const { chat, pushes, folded } = await clientOn(root, 'Alice')
    const publish = vi.spyOn((chat as unknown as { events: EventStore }).events, 'publish')

    await expect(chat.renameTeam('Ops Crew')).rejects.toThrow('not-admin')
    // Refused before the name is even looked at, and before anything reaches
    // the share: no event for the rest of the team to fold away.
    await expect(chat.renameTeam('   ')).rejects.toThrow('not-admin')
    expect(publish).not.toHaveBeenCalled()
    expect(chat.teamName()).toBe('Test Team')
    expect(teamPushes(pushes)).toEqual([])
    expect(folded).toEqual([])

    publish.mockRestore()
    await chat.stop()
  })

  it('ignores a rename a non-admin put on the share anyway', async () => {
    // The refusal above is code on the writer's own machine, so this is the
    // case that matters: a signed, verified `team-renamed` in the right log,
    // from a device the roster knows — and not an admin. Nobody folds it, not
    // even the client that wrote it.
    const root = mkdtempSync(join(tmpdir(), 'sem-team-rename-insider-'))
    const mallory = await clientOn(root, 'Mallory')
    await mallory.chat.publishTeam(TEAM_CONV.settings, 'sys', teamRenamePayload('Mallory Crew'))
    expect(mallory.chat.teamName()).toBe('Test Team')
    expect(teamPushes(mallory.pushes)).toEqual([])
    await mallory.chat.stop()

    const bob = await clientOn(root, 'Bob')
    expect(bob.chat.teamName()).toBe('Test Team')
    expect(teamPushes(bob.pushes)).toEqual([])
    await bob.chat.stop()
  })
})

describe('cold start', () => {
  it('folds the rename out of the log, because protocol.json still says the old name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sem-team-rename-cold-'))
    const gil = await clientOn(root, 'Gil')
    await gil.chat.renameTeam('Ops Crew')
    await gil.chat.stop()

    // A different device, its own store, launching for the first time: the
    // only place the new name exists is team/<token>/events.
    const bob = await clientOn(root, 'Bob')
    expect(bob.chat.teamName()).toBe('Ops Crew')
    expect(teamPushes(bob.pushes)).toEqual(['Ops Crew'])
    await bob.chat.stop()
  })
})
