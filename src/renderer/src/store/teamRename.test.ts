import { describe, expect, it, vi } from 'vitest'
import type { ConvId, PresenceView, SysPayload, VerifiedEvent } from '@shared/types'
import type { PushMessage, SelfView } from '@shared/bridge'
import { TEAM_CONV } from '@shared/constants'
import { TEAM_NAME_MAX } from '@shared/teamName'
import { teamRenameFailureNotice, teamRenameNotice, teamRenameSaveNotice } from './teamRename'

// Who hears about a team rename (1.5). The renamer already sees the new name
// in the sidebar the moment it folds, so the toast is for everyone else — and
// only for events this client would itself adopt.

const SELF = 'me000001'

function ev(
  name: unknown,
  opts: { author?: string; verified?: boolean; kind?: SysPayload['kind']; type?: VerifiedEvent['type'] } = {},
): VerifiedEvent {
  return {
    id: '0000000000001-0000-aaaaaaaa',
    type: opts.type ?? 'sys',
    payload: { t: 'sys', conv: TEAM_CONV.settings, kind: opts.kind ?? 'team-renamed', data: { name } } as SysPayload,
    author: opts.author ?? 'peer0001',
    verified: opts.verified !== false,
    receivedAt: 0,
  }
}

const notice = (event: VerifiedEvent, conv: ConvId = TEAM_CONV.settings) =>
  teamRenameNotice({
    conv,
    event,
    selfDeviceId: SELF,
    nameOf: (d) => (d === 'peer0001' ? 'Ana' : d.slice(0, 8)),
  })

describe('teamRenameNotice', () => {
  it('names the person and the new name', () => {
    expect(notice(ev('  Ops   Crew '))).toBe('Ana renamed the team to Ops Crew')
  })

  it('stays quiet for our own rename', () => {
    expect(notice(ev('Ops Crew', { author: SELF }))).toBeNull()
  })

  it('stays quiet for anything the fold would refuse', () => {
    expect(notice(ev('Ops Crew', { verified: false }))).toBeNull()
    expect(notice(ev(''))).toBeNull()
    expect(notice(ev('x'.repeat(TEAM_NAME_MAX + 1)))).toBeNull()
    expect(notice(ev(42))).toBeNull()
    expect(notice(ev('Ops Crew', { kind: 'channel-renamed' }))).toBeNull()
    expect(notice(ev('Ops Crew', { type: 'msg' }))).toBeNull()
    expect(notice(ev('Ops Crew'), TEAM_CONV.calendar)).toBeNull()
  })

  it('ignores a malformed payload instead of throwing inside the push handler', () => {
    // This runs in the store's `onPush` switch: a TypeError here kills the
    // handler for the message. A payload that is `null`, or whose `data` is,
    // is somebody else's bug (or an insider's file) — it must be ignored.
    const raw = (payload: unknown): VerifiedEvent => ({ ...ev('x'), payload: payload as SysPayload })
    const sys = (data: unknown) => raw({ t: 'sys', conv: TEAM_CONV.settings, kind: 'team-renamed', data })
    expect(() => notice(raw(null))).not.toThrow()
    expect(notice(raw(null))).toBeNull()
    expect(notice(sys(null))).toBeNull()
    expect(notice(sys(undefined))).toBeNull()
    expect(notice(sys('Ops Crew'))).toBeNull()
  })

  it('falls back to a device id when the author is not in the roster yet', () => {
    expect(notice(ev('Ops Crew', { author: 'ffffffff' }))).toBe('ffffffff renamed the team to Ops Crew')
  })
})

describe('teamRenameSaveNotice', () => {
  it('only claims a rename when the name actually moved', () => {
    expect(teamRenameSaveNotice({ before: 'Test Team', name: 'Ops Crew', queued: false })).toEqual({
      text: 'Team renamed to Ops Crew',
      tone: 'success',
    })
    // The bridge answers `{ queued: false }` for a no-op too — renameTeam
    // publishes nothing when the team is already called that — so the pane
    // must not read it as "written".
    expect(teamRenameSaveNotice({ before: 'Ops Crew', name: 'Ops Crew', queued: false })).toEqual({
      text: 'The team is already called Ops Crew.',
      tone: 'info',
    })
  })

  it('says the rename is waiting when the share was unreachable', () => {
    const queued = teamRenameSaveNotice({ before: 'Test Team', name: 'Ops Crew', queued: true })
    expect(queued.tone).toBe('info')
    expect(queued.text).toContain('will be saved when it is back')
    // Even a no-op that somehow queued is reported as queued, not as "already
    // called that" — something is on its way to the share either way.
    expect(teamRenameSaveNotice({ before: 'Ops Crew', name: 'Ops Crew', queued: true }).text).toBe(queued.text)
  })
})

describe('teamRenameFailureNotice', () => {
  it('names the admin gate instead of showing its error code', () => {
    // The panel is only ever shown to Gil, so this rejection means the display
    // name on this device is not the one the team pinned — a sentence, not a
    // riddle. The bridge wraps the message, so the match is a substring one.
    expect(teamRenameFailureNotice('not-admin')).toBe('Only Gil can rename the team')
    expect(teamRenameFailureNotice("Error invoking remote method 'team:rename': Error: not-admin")).toBe(
      'Only Gil can rename the team',
    )
  })

  it('passes anything else through, so a real failure is still readable', () => {
    expect(teamRenameFailureNotice('invalid-name')).toBe('Could not rename the team — invalid-name')
    expect(teamRenameFailureNotice('EACCES')).toBe('Could not rename the team — EACCES')
  })
})

// ---------------------------------------------------------------------------
// The store wiring: the `team` push is what moves the name every surface reads.

const toasted = vi.hoisted(() => ({ list: [] as string[] }))
vi.mock('@/app/toasts', () => ({
  toast: (text: string) => {
    toasted.list.push(text)
  },
}))

const SELF_VIEW: SelfView = {
  deviceId: SELF,
  displayName: 'Me',
  hostname: 'my-mac',
  fingerprint: 'AAAA-0000',
  teamName: 'Test Team',
  sharePath: '/share',
  platform: 'darwin',
}

const ANA: PresenceView = {
  deviceId: 'peer0001',
  name: 'Ana',
  hostname: 'ana-mac',
  fingerprint: 'BBBB-1111',
  state: 'online',
  status: '',
  lastSeenMs: null,
  trust: 'trusted',
  dmConv: 'dm:token' as ConvId,
  departed: false,
}

async function harness(): Promise<{ push(msg: PushMessage): void; store: typeof import('./index').useStore }> {
  let handler: ((msg: PushMessage) => void) | null = null
  const bridge = {
    onPush: (fn: (msg: PushMessage) => void) => {
      handler = fn
    },
    app: {
      getBoot: async () => ({ mode: 'ready' as const, self: SELF_VIEW }),
      setBadge: async () => {},
      launchInfo: async () => ({
        openAtLogin: false,
        openAtLoginSupported: true,
        openedAtLogin: false,
        notificationsSupported: true,
      }),
    },
    settings: { get: async () => null },
    chat: { channels: async () => [], events: async () => [], cursors: async () => ({}), myReads: async () => ({}) },
    presence: { list: async () => [ANA] },
    groups: { list: async () => [] },
    prs: {
      status: async () => {
        throw new Error('not-ready')
      },
      list: async () => [],
    },
  }
  ;(globalThis as unknown as { window: unknown }).window = { bridge, setTimeout: globalThis.setTimeout.bind(globalThis) }
  const { useStore } = await import('./index')
  await useStore.getState().init()
  return { push: (msg) => handler?.(msg), store: useStore }
}

describe('store: a team rename lands in SelfView and toasts everyone else', () => {
  it('moves boot.self.teamName on the `team` push and toasts the event once', async () => {
    const h = await harness()
    expect(h.store.getState().boot).toMatchObject({ self: { teamName: 'Test Team' } })
    // loadTeam prefetches every team log; the toast waits for that, so the
    // backlog main replays at session start cannot toast a month-old rename.
    await vi.waitFor(() => {
      if (!h.store.getState().eventsLoaded[TEAM_CONV.settings]) throw new Error('team log not loaded yet')
    })

    h.push({ kind: 'event', conv: TEAM_CONV.settings, event: ev('Ops Crew') })
    h.push({ kind: 'team', teamName: 'Ops Crew' })

    const boot = h.store.getState().boot
    expect(boot?.mode === 'ready' && boot.self.teamName).toBe('Ops Crew')
    expect(toasted.list).toEqual(['Ana renamed the team to Ops Crew'])

    // Our own rename: the name still moves, but nothing is announced.
    h.push({ kind: 'event', conv: TEAM_CONV.settings, event: ev('Ops Crew 2', { author: SELF }) })
    h.push({ kind: 'team', teamName: 'Ops Crew 2' })
    const after = h.store.getState().boot
    expect(after?.mode === 'ready' && after.self.teamName).toBe('Ops Crew 2')
    expect(toasted.list).toEqual(['Ana renamed the team to Ops Crew'])
  })

  it('says nothing about a rename replayed before the log has been pulled', async () => {
    toasted.list.length = 0
    const h = await harness()
    h.store.setState({ eventsLoaded: {} }) // as it is during a session start
    h.push({ kind: 'event', conv: TEAM_CONV.settings, event: ev('Ops Crew') })
    h.push({ kind: 'team', teamName: 'Ops Crew' })
    const boot = h.store.getState().boot
    expect(boot?.mode === 'ready' && boot.self.teamName).toBe('Ops Crew')
    expect(toasted.list).toEqual([])
  })
})
