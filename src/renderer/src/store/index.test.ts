import { describe, expect, it, vi } from 'vitest'
import type { ChannelView, GroupView, PushMessage } from '@shared/bridge'
import type { ConvId, SysPayload, VerifiedEvent } from '@shared/types'
import { TEAM_CONV } from '@shared/constants'

// The store talks to the preload bridge only through `window.bridge`, so the
// whole push path is testable in the node env with a stub bridge.

// 1.4 — store.init() also reads launchInfo alongside settings now. These
// tests are about push routing, not the launch nudge itself (see
// launchNudgeState.test.ts for that), so a fixed, always-pending stub is
// enough to let init() resolve.
const STUB_LAUNCH_INFO = {
  openAtLogin: false,
  openAtLoginSupported: true,
  openedAtLogin: false,
  notificationsSupported: true,
}

interface Harness {
  push(msg: PushMessage): void
  badges: number[]
  store: typeof import('./index').useStore
}

async function harness(): Promise<Harness> {
  const badges: number[] = []
  let handler: ((msg: PushMessage) => void) | null = null
  const bridge = {
    onPush: (fn: (msg: PushMessage) => void) => {
      handler = fn
    },
    app: {
      getBoot: async () => ({ mode: 'onboarding' as const }),
      setBadge: async (count: number) => {
        badges.push(count)
      },
      launchInfo: async () => STUB_LAUNCH_INFO,
    },
    settings: { get: async () => null },
    chat: { events: async () => [], cursors: async () => ({}) },
  }
  ;(globalThis as unknown as { window: unknown }).window = { bridge }
  const { useStore } = await import('./index')
  await useStore.getState().init()
  return {
    push: (msg) => handler?.(msg),
    badges,
    store: useStore,
  }
}

// --- "channels"/"groups" push wiring (1.2 — the active-conv-vanished toast) ---
// A fuller harness: boot 'ready' (checkConvVanish needs a self device id) with
// controllable channels/groups/events, so a push can be dispatched against a
// specific seeded state instead of just the boot/prs-flag plumbing above.

function chan(conv: string, name: string, fixed = false): ChannelView {
  return { conv: conv as ConvId, channelId: conv.slice(5), name, topic: '', fixed }
}

function grp(conv: string, name: string, owner = 'owner01'): GroupView {
  return { conv: conv as ConvId, groupId: conv.slice(4), name, owner, members: [owner, 'me000001'], epoch: 1, role: 'member' }
}

function sysEvent(conv: string, kind: SysPayload['kind'], author: string, id = '0000000000001-0000-aaaaaaaa'): VerifiedEvent {
  return { id, type: 'sys', payload: { t: 'sys', conv: conv as ConvId, kind, data: {} }, author, verified: true, receivedAt: 0 }
}

interface ReadyHarness {
  push(msg: PushMessage): void
  store: typeof import('./index').useStore
}

async function readyHarness(opts: { channels: ChannelView[]; groups?: GroupView[] }): Promise<ReadyHarness> {
  let handler: ((msg: PushMessage) => void) | null = null
  const self = {
    deviceId: 'me000001',
    displayName: 'Me',
    hostname: 'my-mac',
    fingerprint: 'AAAA-0000',
    teamName: 'Team',
    sharePath: '/share',
    platform: 'darwin' as const,
  }
  const bridge = {
    onPush: (fn: (msg: PushMessage) => void) => {
      handler = fn
    },
    app: { getBoot: async () => ({ mode: 'ready' as const, self }), setBadge: async () => {}, launchInfo: async () => STUB_LAUNCH_INFO },
    settings: { get: async () => null },
    chat: {
      channels: async () => opts.channels,
      events: async () => [],
      cursors: async () => ({}),
      myReads: async () => ({}),
    },
    presence: { list: async () => [] },
    groups: { list: async () => opts.groups ?? [] },
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

describe('store: channels/groups push lands the vanished active conv on the fixed channel', () => {
  it('moves off a deleted channel', async () => {
    const home = chan('chan:home', 'general', true)
    const proj = chan('chan:proj', 'project')
    const h = await readyHarness({ channels: [home, proj] })
    h.store.getState().setActiveConv('chan:proj')
    await vi.waitFor(() => {
      if (!h.store.getState().eventsLoaded['chan:proj']) throw new Error('events not loaded yet')
    })
    h.store.setState({
      events: { ...h.store.getState().events, 'chan:proj': [sysEvent('chan:proj', 'channel-deleted', 'owner01')] },
    })

    h.push({ kind: 'channels', channels: [home] })

    expect(h.store.getState().activeConv).toBe('chan:home')
  })

  it('moves off a deleted group, same as a deleted channel', async () => {
    const home = chan('chan:home', 'general', true)
    const g = grp('grp:x', 'Firefly')
    const h = await readyHarness({ channels: [home], groups: [g] })
    h.store.getState().setActiveConv('grp:x')
    await vi.waitFor(() => {
      if (!h.store.getState().eventsLoaded['grp:x']) throw new Error('events not loaded yet')
    })
    h.store.setState({
      events: { ...h.store.getState().events, 'grp:x': [sysEvent('grp:x', 'group-deleted', 'owner01')] },
    })

    h.push({ kind: 'groups', groups: [] })

    expect(h.store.getState().activeConv).toBe('chan:home')
  })

  it('moves off a group removed from under the user, with the reason cached only in the owner DM', async () => {
    // `group-removed` travels as a `grp` event over the owner's DM, never in
    // the group's own log — checkConvVanish has to find it in a different
    // conv's cache than the one that's active.
    const home = chan('chan:home', 'general', true)
    const g = grp('grp:x', 'Firefly')
    const h = await readyHarness({ channels: [home], groups: [g] })
    h.store.getState().setActiveConv('grp:x')
    await vi.waitFor(() => {
      if (!h.store.getState().eventsLoaded['grp:x']) throw new Error('events not loaded yet')
    })
    h.store.setState({
      events: {
        ...h.store.getState().events,
        'dm:owner-me': [
          {
            id: '0000000000001-0000-aaaaaaaa',
            type: 'grp',
            payload: { t: 'grp', conv: 'dm:owner-me' as ConvId, kind: 'group-removed', data: { groupId: 'x', epoch: 2 } },
            author: 'owner01',
            verified: true,
            receivedAt: 0,
          },
        ],
      },
    })

    h.push({ kind: 'groups', groups: [] })

    expect(h.store.getState().activeConv).toBe('chan:home')
  })

  it('leaves the active conv alone when the push still contains it', async () => {
    const home = chan('chan:home', 'general', true)
    const proj = chan('chan:proj', 'project')
    const h = await readyHarness({ channels: [home, proj] })
    h.store.getState().setActiveConv('chan:proj')

    h.push({ kind: 'channels', channels: [home, proj] })

    expect(h.store.getState().activeConv).toBe('chan:proj')
  })
})

describe('store: boot push', () => {
  it('clears the dock badge and team state when the team folder is disconnected', async () => {
    const h = await harness()
    h.store.setState({ prs: [{ key: 'r/1' }] as never, prsStatus: { unseen: 3 } as never })
    h.badges.length = 0

    h.push({ kind: 'boot', boot: { mode: 'onboarding' } } as PushMessage)

    // PrAlert unmounts on this very render, so the store must send the 0 itself.
    expect(h.badges).toEqual([0])
    expect(h.store.getState().prs).toEqual([])
    expect(h.store.getState().prsStatus).toBeNull()
  })
})

describe('store: prs prefs flag', () => {
  it('drops the prefs flag when the active conversation leaves the PR group', async () => {
    const h = await harness()

    h.store.getState().setPrsPrefsOpen(true)
    expect(h.store.getState().activeConv).toBe(TEAM_CONV.prs)
    expect(h.store.getState().prsPrefsOpen).toBe(true)

    // The modal unmounts with PrsPane, so the flag must not survive the move.
    h.store.getState().setActiveConv('chan:general')
    expect(h.store.getState().prsPrefsOpen).toBe(false)

    // Coming back shows the list, not the settings dialog.
    h.store.getState().setActiveConv(TEAM_CONV.prs)
    expect(h.store.getState().prsPrefsOpen).toBe(false)
  })

  it('keeps the flag when navigating to the PR group itself', async () => {
    const h = await harness()

    h.store.getState().setPrsPrefsOpen(true)
    h.store.getState().setActiveConv(TEAM_CONV.prs)
    expect(h.store.getState().prsPrefsOpen).toBe(true)
  })
})

describe('store: fullscreen push', () => {
  it('mirrors the main window’s OS fullscreen state', async () => {
    const h = await harness()
    expect(h.store.getState().fullscreen).toBe(false)

    // The flag is only ever set from this push: main owns the window state, and
    // the editor's own toggle asks for it rather than assuming it happened (the
    // OS can refuse, and a user can leave fullscreen from the green button or
    // Mission Control, where nothing in the renderer is involved at all).
    h.push({ kind: 'fullscreen', on: true })
    expect(h.store.getState().fullscreen).toBe(true)

    h.push({ kind: 'fullscreen', on: false })
    expect(h.store.getState().fullscreen).toBe(false)
  })
})

// --- ensureEvents and a folder switch mid-read (1.3) ---
// Every log is read across an await and none of those reads is cancellable, so
// the answer can come back after the team folder it was asked of is gone. The
// guard is `teamSeq`, the same shape channelsSeq/groupsSeq have had since 1.2.

describe('store: ensureEvents', () => {
  async function deferredHarness(): Promise<{
    push(msg: PushMessage): void
    release(list: VerifiedEvent[]): void
    store: typeof import('./index').useStore
  }> {
    let handler: ((msg: PushMessage) => void) | null = null
    let release: (list: VerifiedEvent[]) => void = () => {}
    const events = new Promise<VerifiedEvent[]>((res) => {
      release = res
    })
    const bridge = {
      onPush: (fn: (msg: PushMessage) => void) => {
        handler = fn
      },
      app: { getBoot: async () => ({ mode: 'onboarding' as const }), setBadge: async () => {}, launchInfo: async () => STUB_LAUNCH_INFO },
      settings: { get: async () => null },
      chat: { events: () => events, cursors: async () => ({}) },
    }
    ;(globalThis as unknown as { window: unknown }).window = { bridge }
    const { useStore } = await import('./index')
    await useStore.getState().init()
    return { push: (msg) => handler?.(msg), release, store: useStore }
  }

  it('drops a read that lands after the team folder changed', async () => {
    const h = await deferredHarness()
    const boardLive: VerifiedEvent = {
      id: '1700000000009-0001-aaaaaaaa',
      type: 'sys',
      payload: {
        t: 'sys',
        conv: 'chan:gone' as ConvId,
        kind: 'board-live',
        data: { sessionId: 'ghost', title: 'Old board', startedAt: 1 },
      },
      author: 'owner01',
      verified: true,
      receivedAt: 0,
    }

    const inFlight = h.store.getState().ensureEvents('chan:gone' as ConvId)
    // The folder goes while the read is in flight: this clears every cached log.
    h.push({ kind: 'boot', boot: { mode: 'onboarding' } } as PushMessage)
    h.release([boardLive])
    await inFlight

    // Nothing from the share we left — not the events, not the "loaded" flag,
    // and above all not a Join button for a board in a folder we cannot reach.
    expect(h.store.getState().events['chan:gone']).toBeUndefined()
    expect(h.store.getState().eventsLoaded['chan:gone']).toBeUndefined()
    expect(h.store.getState().liveBoards.ghost).toBeUndefined()
  })

  it('keeps the read when the folder stayed put', async () => {
    const h = await deferredHarness()
    const inFlight = h.store.getState().ensureEvents('chan:here' as ConvId)
    h.release([])
    await inFlight
    expect(h.store.getState().eventsLoaded['chan:here']).toBe(true)
  })
})

describe('store: health push', () => {
  it('keeps the last known share-clock offset when a push arrives without one', async () => {
    const h = await harness()
    h.store.setState({ health: { reachable: true, latencyMs: null } })

    // Main calibrated against the folder: polls now close on share time.
    h.push({ kind: 'health', health: { reachable: true, latencyMs: 12, offsetMs: 90_000 } } as PushMessage)
    expect(h.store.getState().health.offsetMs).toBe(90_000)

    // The share going away does not make the two clocks agree again, and the
    // offline push carries no offset — so the last one stands.
    h.push({ kind: 'health', health: { reachable: false, latencyMs: null } } as PushMessage)
    expect(h.store.getState().health).toMatchObject({ reachable: false, offsetMs: 90_000 })

    // A fresh measurement replaces it, including back to zero.
    h.push({ kind: 'health', health: { reachable: true, latencyMs: 8, offsetMs: 0 } } as PushMessage)
    expect(h.store.getState().health.offsetMs).toBe(0)
  })
})

// --- onboarding refused: this machine is already somebody's device (1.4.1) ---
// AppController.onboardSubmit answers 'locked-profile' rather than re-key a
// profile it cannot open. The renderer's job is to put the person where the
// two honest choices live — the unlock screen — and say why.

describe('store: locked-profile hand-off', () => {
  const bridgeApp = () =>
    (globalThis as unknown as { window: { bridge: { app: Record<string, unknown> } } }).window.bridge.app

  it('lands on the unlock card main names, carrying the sentence', async () => {
    const h = await harness()
    bridgeApp().getBoot = async () => ({ mode: 'locked', reason: 'unrecoverable' })

    await h.store.getState().showUnlockScreen('This Mac already holds Chat data.')

    expect(h.store.getState().boot).toEqual({ mode: 'locked', reason: 'unrecoverable' })
    expect(h.store.getState().unlockNotice).toBe('This Mac already holds Chat data.')
  })

  it('still leaves onboarding when getBoot cannot be reached', async () => {
    const h = await harness()
    bridgeApp().getBoot = async () => {
      throw new Error('not-ready')
    }

    await h.store.getState().showUnlockScreen('already holds Chat data')

    // Being refused at all means the profile is sealed and locked; the
    // passphrase card is the safe card to guess, never onboarding again.
    expect(h.store.getState().boot).toEqual({ mode: 'locked', reason: 'passphrase' })
    expect(h.store.getState().unlockNotice).toBe('already holds Chat data')
  })

  it('drops the notice once the boot mode moves on', async () => {
    const h = await harness()
    h.store.setState({ unlockNotice: 'stale' })

    h.push({ kind: 'boot', boot: { mode: 'onboarding' } } as PushMessage)

    expect(h.store.getState().unlockNotice).toBeNull()
  })
})
