import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// PrService reaches Electron for exactly two things: OS notifications and
// net.fetch. Both are replaced here — net.fetch never runs at all, because the
// service takes an injected FetchLike — so the diff/notify/seen logic is
// testable in plain node.
const notifications: { title: string; body: string; clicks: (() => void)[]; shown: boolean }[] = []
vi.mock('electron', () => ({
  net: { fetch: () => Promise.reject(new Error('net.fetch must not be used in tests')) },
  Notification: class {
    static isSupported(): boolean {
      return true
    }
    private rec: (typeof notifications)[number]
    constructor(opts: { title: string; body: string }) {
      this.rec = { title: opts.title, body: opts.body, clicks: [], shown: false }
    }
    on(_evt: string, cb: () => void): this {
      this.rec.clicks.push(cb)
      return this
    }
    show(): void {
      this.rec.shown = true
      notifications.push(this.rec)
    }
  },
}))

import type { BrowserWindow } from 'electron'
import type { PushMessage, SettingsView } from '@shared/bridge'
import type { ConvId, EventPayload, PrsConfig, PrsPayload, VerifiedEvent } from '@shared/types'
import { POLL, PRS, TEAM_CONV } from '@shared/constants'
import type { SecretStore } from '../store/secretStore'
import type { ChatService } from './chatService'
import type { AdoResponse, FetchLike } from './ado'
import { PrService } from './prService'

// ---------------------------------------------------------------------------
// Doubles

class FakeStore implements SecretStore {
  readonly unlocked = true
  readonly data = new Map<string, string>()
  writeSecret(name: string, data: Buffer): void {
    this.data.set(name, data.toString('base64'))
  }
  readSecret(name: string): Buffer | null {
    const v = this.data.get(name)
    return v === undefined ? null : Buffer.from(v, 'base64')
  }
  writeSecretJson(name: string, value: unknown): void {
    this.data.set(name, JSON.stringify(value))
  }
  readSecretJson<T>(name: string): T | null {
    const v = this.data.get(name)
    return v === undefined ? null : (JSON.parse(v) as T)
  }
  deleteSecret(name: string): void {
    this.data.delete(name)
  }
}

/** Just enough ChatService for the team log: a listener list and an append. */
class FakeChat {
  private listeners: ((conv: ConvId, ev: VerifiedEvent) => void)[] = []
  private log: VerifiedEvent[] = []
  private seq = 0
  readonly published: { conv: string; type: string; payload: EventPayload }[] = []

  readonly events = {
    onEvent: (cb: (conv: ConvId, ev: VerifiedEvent) => void): void => {
      this.listeners.push(cb)
    },
  }

  getEvents(conv: ConvId): VerifiedEvent[] {
    return conv === TEAM_CONV.prs ? this.log.slice() : []
  }

  async publishTeam(conv: ConvId, type: 'cal' | 'prs', payload: EventPayload): Promise<VerifiedEvent> {
    this.published.push({ conv, type, payload })
    return this.append(payload as PrsPayload, 'me-device')
  }

  /** Append a config snapshot as if it arrived from the share. */
  append(payload: PrsPayload, author: string, verified = true): VerifiedEvent {
    const ev: VerifiedEvent = {
      id: String(1_700_000_000_000 + this.seq++).padStart(13, '0') + '-0000-aabbccdd',
      type: 'prs',
      payload,
      author,
      verified,
      receivedAt: Date.now(),
    }
    this.log.push(ev)
    for (const cb of this.listeners) cb(TEAM_CONV.prs, ev)
    return ev
  }
}

// ---------------------------------------------------------------------------
// ADO fixtures

interface RawPr {
  pullRequestId: number
  lastMergeSourceCommit?: { commitId: string }
  title: string
  status: string
  isDraft: boolean
  createdBy: { id: string; displayName: string }
  creationDate: string
  sourceRefName: string
  targetRefName: string
  repository: { id: string; name: string }
  reviewers: { id: string; displayName: string; vote: number; isRequired?: boolean }[]
}

function rawPr(over: Partial<RawPr> & { pullRequestId: number }): RawPr {
  return {
    title: `PR ${over.pullRequestId}`,
    status: 'active',
    isDraft: false,
    createdBy: { id: 'author-1', displayName: 'Grace' },
    creationDate: '2026-09-01T10:00:00Z',
    sourceRefName: 'refs/heads/feature/x',
    targetRefName: 'refs/heads/main',
    repository: { id: 'r1', name: 'api' },
    reviewers: [{ id: 'me-1', displayName: 'Ada', vote: 0, isRequired: true }],
    ...over,
  }
}

function jsonRes(value: unknown): AdoResponse {
  return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(value) }
}

const CONFIG: PrsConfig = {
  baseUrl: 'https://dev.azure.com/acme',
  project: 'Proj',
  repos: [{ id: 'r1', name: 'api' }],
  sharedToken: 'shared-token-value',
}

function configEvent(config: Partial<PrsConfig> = {}): PrsPayload {
  return { t: 'prs', conv: TEAM_CONV.prs, config: { ...CONFIG, ...config } }
}

/**
 * The stored shape of 'prs-token': the PAT plus the origin it was entered for.
 * The token is only ever sent to that origin.
 */
function personal(token: string, origin = 'https://dev.azure.com'): { token: string; origin: string } {
  return { token, origin }
}

// ---------------------------------------------------------------------------

interface Harness {
  svc: PrService
  chat: FakeChat
  store: FakeStore
  pushes: PushMessage[]
  urls: string[]
  /** The token each request carried, in order (`Basic base64(':'+token)` decoded). */
  tokens: string[]
  setPrs(list: RawPr[]): void
  failNext(res: AdoResponse | Error): void
  failAlways(res: AdoResponse | Error | null): void
  /** Hold the next pull-request fetches open; the returned function lets them go. */
  holdPrs(): () => void
  focused: { value: boolean }
  /** 1.4 — the device's notification preferences, as the service reads them each poll. */
  settings: SettingsView
  /** 1.4 — the per-PR detail endpoints, and a log of who asked for what. */
  setThreads(prId: number, threads: unknown[]): void
  setIterations(prId: number, iterations: unknown[]): void
  details: { url: string; prId: number; kind: 'threads' | 'iterations' }[]
  /** Answer every request above this REST version with VssVersionOutOfRangeException. */
  capApi(version: string | null): void
  /** Fail only the per-PR detail reads, leaving the list itself healthy. */
  failDetails(res: AdoResponse | null): void
}

function harness(): Harness {
  const chat = new FakeChat()
  const store = new FakeStore()
  const pushes: PushMessage[] = []
  const urls: string[] = []
  const tokens: string[] = []
  let prs: RawPr[] = []
  let override: AdoResponse | Error | null = null
  let always: AdoResponse | Error | null = null
  let hold: Promise<void> | null = null
  const focused = { value: false }
  // 1.4 — the device's notification preferences, mutable per test.
  const settings: SettingsView = {
    theme: 'system',
    notifyChannels: 'all',
    notifyPreviews: true,
    autoplayGifs: 'always',
    autoAcceptBeams: false,
    quietHours: { enabled: false, from: '22:00', to: '07:00' },
    fontSize: 'M',
    notifyPrs: 'all',
    notifyDms: true,
    snoozeUntil: null,
  }
  const threads: Record<number, unknown[]> = {}
  const iterations: Record<number, unknown[]> = {}
  const details: Harness['details'] = []
  let apiCap: string | null = null
  let detailFail: AdoResponse | null = null

  const fetchImpl: FetchLike = async (url, init) => {
    urls.push(url)
    const auth = init.headers.Authorization ?? ''
    tokens.push(Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString('utf8').replace(/^:/, ''))
    if (hold && url.includes('/pullrequests')) await hold
    const o = override ?? always
    if (o) {
      override = null
      if (o instanceof Error) throw o
      return o
    }
    if (apiCap !== null) {
      // What a TFS server answers when asked for a REST version it is too old
      // for; the client steps down and remembers.
      const asked = (new URL(url).searchParams.get('api-version') ?? '').replace('-preview', '')
      if (asked !== apiCap) {
        return {
          status: 400,
          headers: { get: () => null },
          text: async () =>
            JSON.stringify({
              message: `The requested REST API version of ${asked} is out of range for this server. The latest REST API version this server supports is ${apiCap}.`,
              typeKey: 'VssVersionOutOfRangeException',
            }),
        }
      }
    }
    const detail = /\/pullRequests\/(\d+)\/(threads|iterations)$/.exec(new URL(url).pathname)
    if (detail) {
      const prId = Number(detail[1])
      const kind = detail[2] as 'threads' | 'iterations'
      details.push({ url, prId, kind })
      if (detailFail) return detailFail
      return jsonRes({ value: (kind === 'threads' ? threads[prId] : iterations[prId]) ?? [] })
    }
    if (url.includes('/_apis/connectionData')) {
      return jsonRes({ authenticatedUser: { id: 'me-1', providerDisplayName: 'Ada' } })
    }
    if (url.includes('/pullrequests')) return jsonRes({ value: prs })
    if (url.includes('/_apis/projects')) return jsonRes({ value: [{ id: 'p1', name: 'Proj' }] })
    if (url.includes('/_apis/git/repositories')) {
      return jsonRes({ value: [{ id: 'r1', name: 'api', defaultBranch: 'refs/heads/main' }] })
    }
    return jsonRes({ value: [] })
  }

  const win = {
    isFocused: () => focused.value,
    show: () => {},
    focus: () => {},
  } as unknown as BrowserWindow

  const svc = new PrService(
    chat as unknown as ChatService,
    store,
    () => win,
    (m) => pushes.push(m),
    () => '1.1.0',
    () => settings,
    fetchImpl,
  )

  return {
    svc,
    chat,
    store,
    pushes,
    urls,
    tokens,
    focused,
    settings,
    details,
    setThreads: (prId, list) => {
      threads[prId] = list
    },
    setIterations: (prId, list) => {
      iterations[prId] = list
    },
    capApi: (version) => {
      apiCap = version
    },
    failDetails: (res) => {
      detailFail = res
    },
    setPrs: (list) => {
      prs = list
    },
    failNext: (res) => {
      override = res
    },
    failAlways: (res) => {
      always = res
    },
    holdPrs: () => {
      let release = (): void => {}
      hold = new Promise<void>((resolve) => {
        release = () => {
          hold = null
          resolve()
        }
      })
      return release
    },
  }
}

/** Run the first scheduled poll (3 s after start) to completion. */
async function firstPoll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(3_000)
}

/** Run the next steady-state poll. */
async function nextPoll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(POLL.prsMs)
}

beforeEach(() => {
  notifications.length = 0
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------

describe('PrService — configuration', () => {
  it('starts unconfigured and never touches the network', async () => {
    const h = harness()
    h.svc.start()
    await firstPoll()
    const s = h.svc.status()
    expect(s.configured).toBe(false)
    expect(s.tokenSource).toBe('none')
    expect(s.error).toBeNull()
    expect(h.urls).toEqual([])
    h.svc.stop()
  })

  it('materializes the config already in the log at start()', () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    const s = h.svc.status()
    expect(s.configured).toBe(true)
    expect(s.baseUrl).toBe('https://dev.azure.com/acme')
    expect(s.project).toBe('Proj')
    expect(s.repos).toEqual([{ id: 'r1', name: 'api' }])
    expect(s.tokenSource).toBe('shared')
    h.svc.stop()
  })

  it('ignores unverified config events', () => {
    const h = harness()
    h.chat.append(configEvent(), 'forger', false)
    h.svc.start()
    expect(h.svc.status().configured).toBe(false)
    h.svc.stop()
  })

  it('a personal token outranks the shared one', () => {
    const h = harness()
    h.store.writeSecretJson('prs-token', personal('my-own-token'))
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    expect(h.svc.status().tokenSource).toBe('personal')
    h.svc.stop()
  })

  it('a config arriving from the share polls immediately instead of waiting', async () => {
    const h = harness()
    h.svc.start()
    await firstPoll()
    expect(h.urls).toEqual([])

    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.chat.append(configEvent(), 'someone')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.svc.list().map((p) => p.id)).toEqual([1])
    h.svc.stop()
  })

  it('a config with no token source polls nothing and reports no error', async () => {
    const h = harness()
    h.chat.append(configEvent({ sharedToken: '' }), 'someone')
    h.svc.start()
    await firstPoll()
    expect(h.svc.status().tokenSource).toBe('none')
    expect(h.svc.status().error).toBeNull()
    expect(h.urls).toEqual([])
    h.svc.stop()
  })
})

describe('PrService — polling and tracking', () => {
  it('keeps only tracked PRs and projects them into PrViews', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([
      rawPr({ pullRequestId: 1 }),
      rawPr({ pullRequestId: 2, isDraft: true }),
      rawPr({ pullRequestId: 3, status: 'completed' }),
      rawPr({
        pullRequestId: 4,
        reviewers: [{ id: 'x', displayName: 'X', vote: 10, isRequired: true }],
      }),
    ])
    h.svc.start()
    await firstPoll()

    // 1.4: the draft and the completed one are gone; the approved #4 stays
    // (newest first, so it sorts alongside #1 by creation date then key).
    const list = h.svc.list()
    expect(list.map((p) => p.id).sort()).toEqual([1, 4])
    const pr = list.find((p) => p.id === 1)!
    expect(pr.key).toBe('r1:1')
    expect(pr.sourceBranch).toBe('feature/x')
    expect(pr.targetBranch).toBe('main')
    expect(pr.webUrl).toBe('https://dev.azure.com/acme/Proj/_git/api/pullrequest/1')
    expect(pr.assignedToMe).toBe(true)
    expect(pr.myVote).toBe(0)
    expect(pr.seen).toBe(false)
    // …and the approved one never counts toward the badge.
    expect(h.svc.status().unseen).toBe(1)
    expect(list.find((p) => p.id === 4)?.state?.kind).toBe('approved')
    expect(h.svc.status().me).toEqual({ id: 'me-1', name: 'Ada' })
    h.svc.stop()
  })

  it('pushes {kind:"prs"} with the list and the status', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()

    const last = [...h.pushes].reverse().find((m) => m.kind === 'prs')
    expect(last).toBeDefined()
    if (last?.kind === 'prs') {
      expect(last.prs.map((p) => p.id)).toEqual([1])
      expect(last.status.polling).toBe(false)
      expect(last.status.lastPollAt).not.toBeNull()
    }
    h.svc.stop()
  })

  it('keeps a PR that becomes approved, as "approved" and out of the badge', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    expect(h.svc.list()).toHaveLength(1)
    expect(h.svc.list()[0].state?.kind).toBe('needs-review')
    expect(h.svc.status().unseen).toBe(1)

    h.setPrs([rawPr({ pullRequestId: 1, reviewers: [{ id: 'me-1', displayName: 'Ada', vote: 10, isRequired: true }] })])
    await nextPoll()
    const list = h.svc.list()
    expect(list).toHaveLength(1)
    expect(list[0].state?.kind).toBe('approved')
    expect(list[0].state?.next).toBe('author')
    expect(h.svc.status().unseen).toBe(0)
    h.svc.stop()
  })

  it('a PR that is completed or abandoned still drops out entirely', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    expect(h.svc.list()).toHaveLength(1)

    h.setPrs([rawPr({ pullRequestId: 1, status: 'completed' })])
    await nextPoll()
    expect(h.svc.list()).toHaveLength(0)
    h.svc.stop()
  })

  it('refresh() polls right away and does not re-enter while one is running', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    const before = h.urls.length

    await Promise.all([h.svc.refresh(), h.svc.refresh()])
    // One extra pullrequests call — connectionData is cached in `me`.
    expect(h.urls.length).toBe(before + 1)
    h.svc.stop()
  })

  it('stop() ends the loop', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    const after = h.urls.length
    h.svc.stop()
    await vi.advanceTimersByTimeAsync(POLL.prsMs * 5)
    expect(h.urls.length).toBe(after)
  })
})

describe('PrService — errors and backoff', () => {
  it('surfaces the mapped error and keeps the previous list', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    expect(h.svc.list()).toHaveLength(1)

    h.failNext({ status: 401, headers: { get: () => null }, text: async () => '' })
    await nextPoll()
    expect(h.svc.status().error).toEqual({ code: 'unauthorized', detail: 'Azure DevOps rejected the token' })
    expect(h.svc.list()).toHaveLength(1)
    h.svc.stop()
  })

  it('backs off exponentially and recovers on the next success', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    // Every call fails: the connectionData probe is the first casualty.
    const fail = (): AdoResponse => ({ status: 500, headers: { get: () => null }, text: async () => 'boom' })
    h.failNext(fail())
    await firstPoll()
    expect(h.svc.status().error?.code).toBe('http')

    // Next attempt is 2 × prsMs away, not prsMs.
    const at = h.urls.length
    await vi.advanceTimersByTimeAsync(POLL.prsMs)
    expect(h.urls.length).toBe(at)
    await vi.advanceTimersByTimeAsync(POLL.prsMs)
    expect(h.urls.length).toBeGreaterThan(at)

    // That attempt succeeded, so the cadence is back to prsMs.
    expect(h.svc.status().error).toBeNull()
    const at2 = h.urls.length
    await vi.advanceTimersByTimeAsync(POLL.prsMs)
    expect(h.urls.length).toBeGreaterThan(at2)
    h.svc.stop()
  })

  it('never lets the backoff exceed the ceiling', async () => {
    const h = harness()
    h.failAlways(new Error('net::ERR_CONNECTION_REFUSED'))
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    // 3 s → fail 1, +2×60 s → fail 2, +4×60 s → fail 3, +8×60 s → fail 4.
    await firstPoll()
    await vi.advanceTimersByTimeAsync(2 * POLL.prsMs)
    await vi.advanceTimersByTimeAsync(4 * POLL.prsMs)
    await vi.advanceTimersByTimeAsync(8 * POLL.prsMs)
    expect(h.svc.status().error?.code).toBe('network')

    // 16 × 60 s would be 16 min: the ceiling holds it at 10.
    const at = h.urls.length
    await vi.advanceTimersByTimeAsync(POLL.prsBackoffMaxMs - 1)
    expect(h.urls.length).toBe(at)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.urls.length).toBe(at + 1)

    // …and stays there rather than creeping up.
    const at2 = h.urls.length
    await vi.advanceTimersByTimeAsync(POLL.prsBackoffMaxMs)
    expect(h.urls.length).toBe(at2 + 1)
    h.svc.stop()
  })
})

describe('PrService — notifications', () => {
  it('toasts one new PR with the #id · repo wording', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await firstPoll()

    h.setPrs([rawPr({ pullRequestId: 42, title: 'Fix the thing' })])
    await nextPoll()
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('Pull request #42 · api')
    expect(notifications[0].body).toBe('Fix the thing — Grace')
    h.svc.stop()
  })

  it('toasts N new PRs with the first three titles', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await firstPoll()

    h.setPrs([1, 2, 3, 4].map((n) => rawPr({ pullRequestId: n, title: `T${n}` })))
    await nextPoll()
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('4 new pull requests need review')
    expect(notifications[0].body).toBe('T1\nT2\nT3')
    h.svc.stop()
  })

  it('clicking the toast pushes {kind:"prs-open"}', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await firstPoll()
    h.setPrs([rawPr({ pullRequestId: 7 })])
    await nextPoll()

    notifications[0].clicks.forEach((cb) => cb())
    expect(h.pushes.some((m) => m.kind === 'prs-open')).toBe(true)
    h.svc.stop()
  })

  it('stays quiet while the window is focused', async () => {
    const h = harness()
    h.focused.value = true
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await firstPoll()
    h.setPrs([rawPr({ pullRequestId: 1 })])
    await nextPoll()
    expect(notifications).toHaveLength(0)
    expect(h.svc.list()).toHaveLength(1) // still pushed in-app
    h.svc.stop()
  })

  it('never toasts a PR I authored', async () => {
    const h = harness()
    h.store.writeSecretJson('prs-token', personal('my-own-token'))
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await firstPoll()
    h.setPrs([rawPr({ pullRequestId: 1, createdBy: { id: 'me-1', displayName: 'Ada' } })])
    await nextPoll()
    expect(notifications).toHaveLength(0)
    h.svc.stop()
  })

  // On the team's shared token the polled identity is whoever configured the
  // group, not the reader — suppressing by it would eat the toasts for their
  // pull requests and toast me about my own.
  it('suppresses nothing when the identity is the shared token owner', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await firstPoll()
    expect(h.svc.status().tokenSource).toBe('shared')
    h.setPrs([
      rawPr({ pullRequestId: 1, createdBy: { id: 'me-1', displayName: 'Ada' } }), // the token owner's
      rawPr({ pullRequestId: 2 }),
    ])
    await nextPoll()
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('2 new pull requests need review')
    h.svc.stop()
  })

  it('never toasts the same PR twice', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await firstPoll()
    h.setPrs([rawPr({ pullRequestId: 1 })])
    await nextPoll()
    await nextPoll()
    expect(notifications).toHaveLength(1)
    h.svc.stop()
  })

  it('skips the first poll after I publish a config myself', async () => {
    const h = harness()
    h.svc.start()
    h.setPrs([rawPr({ pullRequestId: 1 })])
    await h.svc.saveConfig({
      baseUrl: 'https://dev.azure.com/acme',
      project: 'Proj',
      repos: [{ id: 'r1', name: 'api' }],
      token: 'tok',
      shareToken: true,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.svc.list()).toHaveLength(1)
    expect(notifications).toHaveLength(0)

    // The suppression is one poll deep, not permanent.
    h.setPrs([rawPr({ pullRequestId: 1 }), rawPr({ pullRequestId: 2 })])
    await nextPoll()
    expect(notifications).toHaveLength(1)
    h.svc.stop()
  })
})

// The quick notification controls (1.4). The preference decides who may
// interrupt; it never touches the list or the unseen count, which are
// information rather than an interruption.
describe('PrService — the notification preference (1.4)', () => {
  it("'none' keeps the list and the badge, and says nothing", async () => {
    const h = harness()
    h.settings.notifyPrs = 'none'
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await firstPoll()

    h.setPrs([rawPr({ pullRequestId: 42 })])
    await nextPoll()
    expect(notifications).toHaveLength(0)
    expect(h.svc.list()).toHaveLength(1)
    expect(h.svc.status().unseen).toBe(1)
    h.svc.stop()
  })

  it("'mine' keeps a review assigned to me and drops one that is not", async () => {
    const h = harness()
    h.settings.notifyPrs = 'mine'
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await firstPoll()

    // Bo's review, nobody waiting on me: tracked, counted, silent.
    h.setPrs([
      rawPr({
        pullRequestId: 1,
        reviewers: [{ id: 'rev-bo', displayName: 'Bo', vote: 0, isRequired: true }],
      }),
    ])
    await nextPoll()
    expect(notifications).toHaveLength(0)
    expect(h.svc.status().unseen).toBe(1)

    // The default fixture lists me-1 as a required reviewer.
    h.setPrs([
      rawPr({ pullRequestId: 1, reviewers: [{ id: 'rev-bo', displayName: 'Bo', vote: 0, isRequired: true }] }),
      rawPr({ pullRequestId: 2, title: 'Mine to review' }),
    ])
    await nextPoll()
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('Pull request #2 · api')
    h.svc.stop()
  })

  it('says nothing during quiet hours, and speaks again once they are over', async () => {
    const h = harness()
    vi.setSystemTime(NOW)
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await firstPoll()

    // Quiet hours are read in the machine's own zone, so the window is built
    // around this clock's local hour rather than written down: an hour either
    // side, so a poll a minute later is still well inside it.
    const hh = (n: number): string => String((n + 24) % 24).padStart(2, '0')
    const hour = new Date(Date.now()).getHours()
    const window = { from: `${hh(hour - 1)}:00`, to: `${hh(hour + 2)}:00` }
    h.settings.quietHours = { enabled: true, ...window }
    h.setPrs([rawPr({ pullRequestId: 1 })])
    await nextPoll()
    expect(notifications).toHaveLength(0)
    expect(h.svc.status().unseen).toBe(1) // the badge still counts it

    h.settings.quietHours = { enabled: false, ...window }
    h.setPrs([rawPr({ pullRequestId: 1 }), rawPr({ pullRequestId: 2 })])
    await nextPoll()
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('Pull request #2 · api')
    h.svc.stop()
  })

  it('says nothing at all while the pause is running, and speaks again once it passes', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await firstPoll()

    h.settings.snoozeUntil = Date.now() + 10 * POLL.prsMs
    h.setPrs([rawPr({ pullRequestId: 1 })])
    await nextPoll()
    expect(notifications).toHaveLength(0)

    h.settings.snoozeUntil = Date.now() - 1
    h.setPrs([rawPr({ pullRequestId: 1 }), rawPr({ pullRequestId: 2 })])
    await nextPoll()
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('Pull request #2 · api')
    h.svc.stop()
  })
})

// Author-side transitions (1.4): what my own pull request does, not what
// arrives. `personal(...)` is what makes `me-1` mean *me* — on a shared token
// the polled identity is whoever configured the group.
describe('PrService — my own pull requests move (1.4)', () => {
  const MINE = { id: 'me-1', displayName: 'Ada' }
  const BO = { id: 'rev-bo', displayName: 'Bo', vote: 0, isRequired: true }

  /** A started service with one pull request of mine, seeded at needs-review. */
  async function mineAtNeedsReview(h: Harness): Promise<void> {
    h.store.writeSecretJson('prs-token', personal('my-own-token'))
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1, title: 'Clamp the refund window', createdBy: MINE, reviewers: [BO] })])
    h.svc.start()
    await firstPoll()
    expect(h.svc.list()[0].state?.kind).toBe('needs-review')
    expect(notifications).toHaveLength(0)
  }

  it('toasts changes-requested once, naming the reviewer who blocked it', async () => {
    const h = harness()
    await mineAtNeedsReview(h)

    h.setPrs([
      rawPr({
        pullRequestId: 1,
        title: 'Clamp the refund window',
        createdBy: MINE,
        reviewers: [{ ...BO, vote: -10 }],
      }),
    ])
    await nextPoll()
    expect(h.svc.list()[0].state?.kind).toBe('changes-requested')
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('Your PR #1 — changes requested by Bo')
    expect(notifications[0].body).toBe('Clamp the refund window · api')

    // The state stays put; the news does not repeat.
    await nextPoll()
    await nextPoll()
    expect(notifications).toHaveLength(1)
    h.svc.stop()
  })

  it('toasts comments-open once when a reviewer leaves the last word', async () => {
    const h = harness()
    await mineAtNeedsReview(h)

    // A push is what forces the detail re-read; the comment rides along.
    h.setThreads(1, [adoThread({ id: 9, comments: [{ by: 'rev-bo', atH: 1 }] })])
    h.setPrs([
      rawPr({
        pullRequestId: 1,
        title: 'Clamp the refund window',
        createdBy: MINE,
        reviewers: [BO],
        lastMergeSourceCommit: { commitId: 'c2' },
      }),
    ])
    await nextPoll()
    expect(h.svc.list()[0].state?.kind).toBe('comments-open')
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('Your PR #1 has 1 open comment')

    await nextPoll()
    expect(notifications).toHaveLength(1)
    h.svc.stop()
  })

  it('toasts approved once, with what to do about it', async () => {
    const h = harness()
    await mineAtNeedsReview(h)

    h.setPrs([
      rawPr({
        pullRequestId: 1,
        title: 'Clamp the refund window',
        createdBy: MINE,
        reviewers: [{ ...BO, vote: 10 }],
      }),
    ])
    await nextPoll()
    expect(h.svc.list()[0].state?.kind).toBe('approved')
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('Your PR #1 is approved — ready to complete')

    await nextPoll()
    expect(notifications).toHaveLength(1)
    h.svc.stop()
  })

  it('says nothing about somebody else\'s pull request moving', async () => {
    const h = harness()
    h.store.writeSecretJson('prs-token', personal('my-own-token'))
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1, reviewers: [BO] })]) // authored by Grace
    h.svc.start()
    await firstPoll()

    h.setPrs([rawPr({ pullRequestId: 1, reviewers: [{ ...BO, vote: -10 }] })])
    await nextPoll()
    expect(h.svc.list()[0].state?.kind).toBe('changes-requested')
    expect(notifications).toHaveLength(0)
    h.svc.stop()
  })

  it('obeys the preference: nothing under "none"', async () => {
    const h = harness()
    h.settings.notifyPrs = 'none'
    await mineAtNeedsReview(h)

    h.setPrs([rawPr({ pullRequestId: 1, createdBy: MINE, reviewers: [{ ...BO, vote: 10 }] })])
    await nextPoll()
    expect(h.svc.list()[0].state?.kind).toBe('approved')
    expect(notifications).toHaveLength(0)
    h.svc.stop()
  })

  it('never fires off the first poll after a config change', async () => {
    const h = harness()
    await mineAtNeedsReview(h)

    // The vote and the config land together: the poll that follows has nothing
    // to compare against, so the move is recorded rather than announced.
    h.setPrs([rawPr({ pullRequestId: 1, createdBy: MINE, reviewers: [{ ...BO, vote: -10 }] })])
    h.chat.append(configEvent({ reviewSlaHours: 24 }), 'someone')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.svc.list()[0].state?.kind).toBe('changes-requested')
    expect(notifications).toHaveLength(0)

    // …and the next move is news again.
    h.setPrs([rawPr({ pullRequestId: 1, createdBy: MINE, reviewers: [{ ...BO, vote: 10 }] })])
    await nextPoll()
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('Your PR #1 is approved — ready to complete')
    h.svc.stop()
  })

  it('stays quiet while the window is focused, like every other toast', async () => {
    const h = harness()
    await mineAtNeedsReview(h)
    h.focused.value = true

    h.setPrs([rawPr({ pullRequestId: 1, createdBy: MINE, reviewers: [{ ...BO, vote: 10 }] })])
    await nextPoll()
    expect(h.svc.list()[0].state?.kind).toBe('approved')
    expect(notifications).toHaveLength(0)
    h.svc.stop()
  })
})

describe('PrService — the seen set', () => {
  it('markSeen persists to prs-seen, zeroes unseen and pushes', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    expect(h.svc.status().unseen).toBe(1)

    h.svc.markSeen(['r1:1', 'not-a-tracked-key'])
    expect(h.svc.status().unseen).toBe(0)
    expect(h.svc.list()[0].seen).toBe(true)
    expect(h.store.readSecretJson('prs-seen')).toEqual({ 'r1:1': true })
    h.svc.stop()
  })

  it('the first poll of a session is a silent catch-up, later arrivals toast', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    // Already pending at launch: counted as unseen, never toasted.
    expect(notifications).toHaveLength(0)
    expect(h.svc.status().unseen).toBe(1)

    h.setPrs([rawPr({ pullRequestId: 1 }), rawPr({ pullRequestId: 2 })])
    await nextPoll()
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('Pull request #2 · api')
    h.svc.stop()
  })

  it('a seen PR is not re-announced', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await firstPoll()
    h.setPrs([rawPr({ pullRequestId: 1 })])
    await nextPoll()
    expect(notifications).toHaveLength(1) // the very first appearance only
    h.svc.markSeen(['r1:1'])

    notifications.length = 0
    await nextPoll()
    expect(notifications).toHaveLength(0)
    expect(h.svc.list()[0].seen).toBe(true)
    h.svc.stop()
  })

  it('status reports whether the team config carries a shared token', async () => {
    const h = harness()
    h.chat.append(configEvent({ sharedToken: '' }), 'someone')
    h.svc.start()
    await firstPoll()
    expect(h.svc.status().sharedTokenSet).toBe(false)
    h.chat.append(configEvent(), 'someone')
    await nextPoll()
    expect(h.svc.status().sharedTokenSet).toBe(true)
    h.svc.stop()
  })

  it('prunes prs-seen down to the keys still tracked', async () => {
    const h = harness()
    h.store.writeSecretJson('prs-seen', { 'r1:1': true, 'r1:999': true })
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    expect(h.store.readSecretJson('prs-seen')).toEqual({ 'r1:1': true })
    expect(h.svc.list()[0].seen).toBe(true)
    expect(h.svc.status().unseen).toBe(0)
    h.svc.stop()
  })
})

// ---------------------------------------------------------------------------
// 1.4 — waiting states

const NOW = Date.parse('2026-09-20T12:00:00Z')
const AGO = (h: number): string => new Date(NOW - h * 3_600_000).toISOString()

/** One human comment thread, in the shape Azure DevOps returns it. */
function adoThread(over: { id: number; status?: string; comments: { by: string; atH: number }[] }) {
  return {
    id: over.id,
    status: over.status ?? 'active',
    publishedDate: AGO(over.comments[0]?.atH ?? 1),
    lastUpdatedDate: AGO(over.comments[over.comments.length - 1]?.atH ?? 1),
    comments: over.comments.map((c, i) => ({
      id: i + 1,
      author: { id: c.by, displayName: c.by },
      publishedDate: AGO(c.atH),
      commentType: 'text',
    })),
  }
}

describe('PrService — detail refresh cadence (1.4)', () => {
  it('reads threads and iterations once when a PR is first seen, and not again next poll', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    expect(h.details.map((d) => d.kind)).toEqual(['threads', 'iterations'])

    await nextPoll()
    expect(h.details).toHaveLength(2) // nothing changed: no second read
    h.svc.stop()
  })

  it('re-reads them as soon as lastMergeSourceCommit changes — a push resets everything', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1, lastMergeSourceCommit: { commitId: 'aaa' } })])
    h.svc.start()
    await firstPoll()
    expect(h.details).toHaveLength(2)
    expect(h.svc.list()[0].lastMergeCommit).toBe('aaa')

    h.setPrs([rawPr({ pullRequestId: 1, lastMergeSourceCommit: { commitId: 'bbb' } })])
    await nextPoll()
    expect(h.details).toHaveLength(4)
    h.svc.stop()
  })

  it('spreads first sight over a few polls instead of spending 2·N requests at once', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs(Array.from({ length: 10 }, (_, i) => rawPr({ pullRequestId: i + 1 })))
    h.svc.start()
    await firstPoll()
    // budget = ceil(10 / 5) = 2, and the forced list is capped at 2 × that:
    // four PRs, eight requests — not the twenty a blank pane used to cost.
    expect(h.details).toHaveLength(8)

    // The remainder lands on the polls after it, and nothing is read twice.
    await nextPoll()
    expect(h.details).toHaveLength(16)
    await nextPoll()
    expect(h.details).toHaveLength(20)
    expect(new Set(h.details.map((d) => d.prId)).size).toBe(10)
    h.svc.stop()
  })

  it('then spreads the round robin over five polls instead of re-reading everything at once', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs(Array.from({ length: 10 }, (_, i) => rawPr({ pullRequestId: i + 1 })))
    h.svc.start()
    await firstPoll()
    for (let i = 0; i < 2; i++) await nextPoll() // everything has details by now
    expect(h.details).toHaveLength(20)

    // Two more polls, still inside PRS.detailRefreshMs: nothing is due yet.
    for (let i = 0; i < 2; i++) await nextPoll()
    expect(h.details).toHaveLength(20)

    // Now the oldest four age past the window: at most ceil(10 / 5) = 2 PRs
    // per poll, oldest first.
    const before = h.details.length
    await nextPoll()
    expect(h.details.length - before).toBe(4) // 2 PRs × (threads + iterations)

    // …and five such polls cover the whole set exactly once.
    for (let i = 0; i < 4; i++) await nextPoll()
    const refreshed = new Set(h.details.slice(before).map((d) => d.prId))
    expect(refreshed.size).toBe(10)
    h.svc.stop()
  })

  it('a detail read that fails is not retried every poll, and never fails the poll', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.failDetails({ status: 500, headers: { get: () => null }, text: async () => '{"message":"boom"}' })
    h.svc.start()
    await firstPoll()
    expect(h.svc.status().error).toBeNull()
    expect(h.svc.list()).toHaveLength(1)
    expect(h.svc.list()[0].state?.threadsKnown).toBe(false)

    const after = h.details.length
    await nextPoll()
    expect(h.details).toHaveLength(after)
    h.svc.stop()
  })

  it('caps the first poll instead of spending 2·N requests before the pane shows anything', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs(Array.from({ length: 30 }, (_, i) => rawPr({ pullRequestId: i + 1 })))
    h.svc.start()
    await firstPoll()
    // budget = ceil(30 / 5) = 6; the forced list is capped at 2 × budget, so
    // twelve PRs — 24 serial round trips, not the 60 this used to cost on the
    // very poll somebody is waiting on.
    expect(h.details).toHaveLength(24)
    expect(new Set(h.details.map((d) => d.prId)).size).toBe(12)

    // The remainder rides the next polls, and every PR is covered by the third.
    await nextPoll()
    await nextPoll()
    expect(new Set(h.details.map((d) => d.prId)).size).toBe(30)
    expect(h.details).toHaveLength(60)
    h.svc.stop()
  })

  it('re-reads a push whose detail read failed, once per refresh window until it lands', async () => {
    const h = harness()
    vi.setSystemTime(NOW)
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1, creationDate: AGO(96), lastMergeSourceCommit: { commitId: 'aaa' } })])
    h.setIterations(1, [{ id: 1, createdDate: AGO(96) }])
    h.svc.start()
    await firstPoll()
    expect(h.svc.list()[0].state?.lastPushAt).toBe(NOW - 96 * 3_600_000)

    // The author pushes while the detail routes happen to be rate-limiting.
    h.failDetails({ status: 429, headers: { get: () => null }, text: async () => '{"message":"slow down"}' })
    h.setPrs([rawPr({ pullRequestId: 1, creationDate: AGO(96), lastMergeSourceCommit: { commitId: 'bbb' } })])
    h.setIterations(1, [{ id: 1, createdDate: AGO(96) }, { id: 2, createdDate: AGO(1) }])
    await nextPoll()
    const attempted = h.details.length
    expect(attempted).toBe(4) // it tried, and learned nothing
    expect(h.svc.list()[0].state?.lastPushAt).toBe(NOW - 96 * 3_600_000)

    // Inside the window it is not retried once per poll…
    await nextPoll()
    await nextPoll()
    expect(h.details).toHaveLength(attempted)

    // …but the new commit was never banked, so when the window comes round the
    // push is picked up rather than lost until something else changes.
    h.failDetails(null)
    for (let i = 0; i < 3; i++) await nextPoll()
    expect(h.details.length).toBe(attempted + 2)
    expect(h.svc.list()[0].state?.lastPushAt).toBe(NOW - 1 * 3_600_000)
    h.svc.stop()
  })

  it('keeps the cached details when only the token changed, and drops them when the project moves', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    expect(h.details).toHaveLength(2)

    // A teammate shares a different token: the same server's pull requests,
    // read with another credential. Re-reading 2·N details for that is a burst
    // nobody asked for.
    h.chat.append(configEvent({ sharedToken: 'rotated-token-value' }), 'someone')
    await vi.advanceTimersByTimeAsync(1)
    expect(h.details).toHaveLength(2)
    expect(h.svc.list()[0].state).toBeDefined()

    // A different project is a different set of pull requests.
    h.chat.append(configEvent({ project: 'Other' }), 'someone')
    await vi.advanceTimersByTimeAsync(1)
    expect(h.details).toHaveLength(4)
    h.svc.stop()
  })

  it('asks for nothing at all on a server older than the threads API', async () => {
    const h = harness()
    h.capApi('2.0')
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1, reviewers: [{ id: 'me-1', displayName: 'Ada', vote: 0, isRequired: true }] })])
    h.svc.start()
    await firstPoll()

    expect(h.details).toEqual([])
    const pr = h.svc.list()[0]
    expect(pr.state?.threadsKnown).toBe(false)
    expect(pr.state?.openThreads).toBe(0)
    expect(pr.state?.lastPushAt).toBeNull()
    // Votes alone still produce a usable state.
    expect(pr.state?.kind).toBe('needs-review')
    h.svc.stop()
  })
})

describe('PrService — the waiting state itself (1.4)', () => {
  it('turns threads into comments-open, and counts overdue and stale in the status', async () => {
    const h = harness()
    vi.setSystemTime(NOW)
    h.chat.append(configEvent(), 'someone')
    h.setPrs([
      rawPr({
        pullRequestId: 1,
        creationDate: AGO(96),
        reviewers: [{ id: 'rev-bo', displayName: 'Bo', vote: 0, isRequired: true }],
      }),
    ])
    h.setIterations(1, [{ id: 1, createdDate: AGO(96) }, { id: 2, createdDate: AGO(72) }])
    h.setThreads(1, [
      adoThread({ id: 9, comments: [{ by: 'rev-bo', atH: 60 }] }),
      adoThread({ id: 10, status: 'fixed', comments: [{ by: 'rev-bo', atH: 90 }] }),
    ])
    h.svc.start()
    await firstPoll()

    const pr = h.svc.list()[0]
    expect(pr.state?.kind).toBe('comments-open')
    expect(pr.state?.next).toBe('author')
    expect(pr.state?.nextNames).toEqual(['Grace'])
    expect(pr.state?.openThreads).toBe(1)
    expect(pr.state?.threadsKnown).toBe(true)
    expect(pr.state?.lastPushAt).toBe(NOW - 72 * 3_600_000)

    const s = h.svc.status()
    expect(s.overdue).toBe(0) // waiting on the author, not on a reviewer
    expect(s.stale).toBe(0)
    expect(s.reviewSlaHours).toBe(PRS.reviewSlaHours)
    expect(s.staleAfterDays).toBe(PRS.staleAfterDays)
    h.svc.stop()
  })

  it('counts a review that has waited past the team SLA as overdue', async () => {
    const h = harness()
    vi.setSystemTime(NOW)
    h.chat.append(configEvent({ reviewSlaHours: 24 }), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1, creationDate: AGO(50) })])
    h.setIterations(1, [{ id: 1, createdDate: AGO(50) }])
    h.svc.start()
    await firstPoll()

    expect(h.svc.list()[0].state?.overdue).toBe(true)
    expect(h.svc.status().overdue).toBe(1)
    expect(h.svc.status().reviewSlaHours).toBe(24)
    h.svc.stop()
  })

  it('counts a PR nobody has touched in staleAfterDays as stale', async () => {
    const h = harness()
    vi.setSystemTime(NOW)
    h.chat.append(configEvent({ staleAfterDays: 2 }), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1, creationDate: AGO(96) })])
    h.setIterations(1, [{ id: 1, createdDate: AGO(96) }])
    h.svc.start()
    await firstPoll()

    expect(h.svc.list()[0].state?.stale).toBe(true)
    expect(h.svc.status().stale).toBe(1)
    h.svc.stop()
  })

  it('never announces an approved PR, even the first time it appears', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll() // the catch-up poll is silent anyway
    h.setPrs([
      rawPr({ pullRequestId: 1 }),
      rawPr({ pullRequestId: 2, reviewers: [{ id: 'me-1', displayName: 'Ada', vote: 10, isRequired: true }] }),
    ])
    await nextPoll()

    expect(h.svc.list().map((p) => p.state?.kind).sort()).toEqual(['approved', 'needs-review'])
    expect(notifications).toHaveLength(0)
    expect(h.svc.status().unseen).toBe(1)
    h.svc.stop()
  })
})

describe('PrService — the vote history (1.4)', () => {
  it('floors a vote it has never seen at the last push, and dates a change at the moment it saw it', async () => {
    const h = harness()
    vi.setSystemTime(NOW)
    const push = NOW - 72 * 3_600_000
    h.chat.append(configEvent(), 'someone')
    h.setPrs([
      rawPr({
        pullRequestId: 1,
        creationDate: AGO(96),
        reviewers: [{ id: 'rev-bo', displayName: 'Bo', vote: 10, isRequired: true }],
      }),
    ])
    h.setIterations(1, [{ id: 2, createdDate: AGO(72) }])
    h.svc.start()
    await firstPoll()

    const first = h.store.readSecretJson<Record<string, { votes: Record<string, { v: number; at: number }>; push?: number }>>('prs-history')
    expect(first?.['r1:1'].votes['rev-bo']).toEqual({ v: 10, at: push })
    expect(first?.['r1:1'].push).toBe(push)
    // Floored at the push, so it still reads as a judgement about today's code.
    expect(h.svc.list()[0].state?.kind).toBe('approved')

    // The reviewer changes their mind while we are watching.
    h.setPrs([
      rawPr({
        pullRequestId: 1,
        creationDate: AGO(96),
        reviewers: [{ id: 'rev-bo', displayName: 'Bo', vote: -10, isRequired: true }],
      }),
    ])
    await nextPoll()
    const then = h.store.readSecretJson<Record<string, { votes: Record<string, { v: number; at: number }> }>>('prs-history')
    expect(then?.['r1:1'].votes['rev-bo']).toEqual({ v: -10, at: Date.now() })
    const pr = h.svc.list()[0]
    expect(pr.state?.kind).toBe('changes-requested')
    expect(pr.state?.since).toBe(Date.now())
    h.svc.stop()
  })

  it('survives a restart: a vote observed in an earlier session keeps its time', async () => {
    const h = harness()
    vi.setSystemTime(NOW)
    h.store.writeSecretJson('prs-history', {
      'r1:1': { votes: { 'rev-bo': { v: 10, at: NOW - 3_600_000 } }, push: NOW - 7_200_000 },
    })
    h.chat.append(configEvent(), 'someone')
    h.setPrs([
      rawPr({
        pullRequestId: 1,
        creationDate: AGO(9),
        reviewers: [{ id: 'rev-bo', displayName: 'Bo', vote: 10, isRequired: true }],
      }),
    ])
    h.setIterations(1, [{ id: 1, createdDate: AGO(2) }])
    h.svc.start()
    await firstPoll()

    const kept = h.store.readSecretJson<Record<string, { votes: Record<string, { v: number; at: number }> }>>('prs-history')
    expect(kept?.['r1:1'].votes['rev-bo'].at).toBe(NOW - 3_600_000)
    expect(h.svc.list()[0].state?.since).toBe(NOW - 3_600_000)
    h.svc.stop()
  })

  it('prunes prs-history down to the PRs still tracked, and disconnect clears it', async () => {
    const h = harness()
    h.store.writeSecretJson('prs-history', { 'r1:999': { votes: { x: { v: 10, at: 1 } } } })
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    expect(Object.keys(h.store.readSecretJson<Record<string, unknown>>('prs-history') ?? {})).toEqual(['r1:1'])

    await h.svc.disconnect()
    expect(h.store.data.has('prs-history')).toBe(false)
    h.svc.stop()
  })
})

describe('PrService — the shared thresholds (1.4)', () => {
  it('publishes them, defaults them, and keeps them when saveConfig omits them', async () => {
    const h = harness()
    h.svc.start()
    const base = { baseUrl: 'https://dev.azure.com/acme', project: 'Proj', repos: [{ id: 'r1', name: 'api' }], token: 't', shareToken: false }

    await h.svc.saveConfig({ ...base, reviewSlaHours: 12, staleAfterDays: 30 })
    let config = (h.chat.published[0].payload as PrsPayload).config
    expect(config.reviewSlaHours).toBe(12)
    expect(config.staleAfterDays).toBe(30)
    expect(h.svc.status().reviewSlaHours).toBe(12)

    await h.svc.saveConfig(base)
    config = (h.chat.published[1].payload as PrsPayload).config
    expect(config.reviewSlaHours).toBe(12)
    expect(config.staleAfterDays).toBe(30)
    h.svc.stop()
  })

  it('refuses a threshold outside the published range', async () => {
    const h = harness()
    const base = { baseUrl: 'https://dev.azure.com/acme', project: 'Proj', repos: [{ id: 'r1', name: 'api' }], token: 't', shareToken: false }
    await expect(h.svc.saveConfig({ ...base, reviewSlaHours: 0 })).rejects.toThrow(/invalid-config/)
    await expect(h.svc.saveConfig({ ...base, reviewSlaHours: 721 })).rejects.toThrow(/invalid-config/)
    await expect(h.svc.saveConfig({ ...base, staleAfterDays: 366 })).rejects.toThrow(/invalid-config/)
    await expect(h.svc.saveConfig({ ...base, staleAfterDays: 1.5 })).rejects.toThrow(/invalid-config/)
    expect(h.chat.published).toHaveLength(0)
  })

  it('reads a 1.3 config, which carries neither, as the defaults', () => {
    const h = harness()
    h.chat.append({ t: 'prs', conv: TEAM_CONV.prs, config: { ...CONFIG } }, 'someone')
    h.svc.start()
    expect(h.svc.status().reviewSlaHours).toBe(PRS.reviewSlaHours)
    expect(h.svc.status().staleAfterDays).toBe(PRS.staleAfterDays)
    h.svc.stop()
  })

  it('a threshold change from the share is picked up like any other config change', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    expect(h.svc.status().reviewSlaHours).toBe(PRS.reviewSlaHours)

    h.chat.append(configEvent({ reviewSlaHours: 6 }), 'someone')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.svc.status().reviewSlaHours).toBe(6)
    h.svc.stop()
  })
})

describe('PrService — prefs RPCs', () => {
  it('testConnection returns the user and the projects', async () => {
    const h = harness()
    const probe = await h.svc.testConnection({ baseUrl: 'https://dev.azure.com/acme/', token: ' tok ' })
    expect(probe).toEqual({
      ok: true,
      me: { id: 'me-1', name: 'Ada' },
      projects: [{ id: 'p1', name: 'Proj' }],
      apiVersion: '6.0',
    })
  })

  it('testConnection rejects a URL that carries credentials or is not http(s)', async () => {
    const h = harness()
    for (const baseUrl of ['ssh://git@dev.azure.com/acme', 'https://user:pw@dev.azure.com/acme', 'nonsense']) {
      const probe = await h.svc.testConnection({ baseUrl, token: 'tok' })
      expect(probe.ok).toBe(false)
      if (!probe.ok) expect(probe.error.code).toBe('bad-url')
    }
    expect(h.urls).toEqual([])
  })

  it('listRepos strips refs/heads/ from the default branch', async () => {
    const h = harness()
    const res = await h.svc.listRepos({ baseUrl: 'https://dev.azure.com/acme', token: 'tok', project: 'Proj' })
    expect(res).toEqual({ ok: true, value: [{ id: 'r1', name: 'api', defaultBranch: 'main' }] })
  })

  it('testConnection prefills the personal token only for the server it belongs to', async () => {
    const h = harness()
    h.store.writeSecretJson('prs-token', personal('PERSONAL-PAT'))
    h.chat.append(configEvent({ sharedToken: '' }), 'someone')
    h.svc.start()

    const elsewhere = await h.svc.testConnection({ baseUrl: 'https://tfs.corp/tfs', token: '' })
    expect(elsewhere.ok).toBe(false)
    if (!elsewhere.ok) expect(elsewhere.error.code).toBe('unauthorized')
    expect(h.urls).toEqual([]) // nothing was sent to that host

    const here = await h.svc.testConnection({ baseUrl: 'https://dev.azure.com/acme', token: '' })
    expect(here.ok).toBe(true)
    expect(h.tokens).toEqual(['PERSONAL-PAT', 'PERSONAL-PAT']) // connectionData + projects
    h.svc.stop()
  })

  it('setPersonalToken writes the secret against the configured server, then deletes it', () => {
    const h = harness()
    h.chat.append(configEvent({ sharedToken: '' }), 'someone')
    h.svc.start()
    h.svc.setPersonalToken('  personal  ')
    expect(h.store.readSecretJson('prs-token')).toEqual(personal('personal'))
    expect(h.svc.status().tokenSource).toBe('personal')
    h.svc.setPersonalToken(null)
    expect(h.store.data.has('prs-token')).toBe(false)
    expect(h.svc.status().tokenSource).toBe('none')
    h.svc.stop()
  })

  it('a token entered before anything is configured has no server to belong to and is not kept', () => {
    const h = harness()
    h.svc.start()
    h.svc.setPersonalToken('personal')
    expect(h.store.data.has('prs-token')).toBe(false)
    expect(h.svc.status().tokenSource).toBe('none')
    h.svc.stop()
  })
})

describe('PrService — the personal token belongs to one server', () => {
  it('is not sent to a base URL somebody else published', async () => {
    const h = harness()
    h.store.writeSecretJson('prs-token', personal('PERSONAL-PAT'))
    h.chat.append(configEvent({ sharedToken: '' }), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    expect(h.tokens).toContain('PERSONAL-PAT') // the server it was entered for

    // Anyone holding the team passphrase can publish a config. Pointing it at
    // another host must not hand them this machine's credential.
    const before = h.urls.length
    h.chat.append(configEvent({ baseUrl: 'http://collector.attacker.tld', sharedToken: '' }), 'someone-else')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.urls.slice(before)).toEqual([])
    expect(h.svc.status().tokenSource).toBe('none') // the pane asks for a token instead
    expect(h.svc.status().error).toBeNull()

    // …and a token typed for that server is stored for that server only.
    h.svc.setPersonalToken('NEW-PAT')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.store.readSecretJson('prs-token')).toEqual(personal('NEW-PAT', 'http://collector.attacker.tld'))
    expect(h.urls.slice(before).every((u) => u.startsWith('http://collector.attacker.tld/'))).toBe(true)
    expect(h.tokens.slice(before)).not.toContain('PERSONAL-PAT')
    h.svc.stop()
  })

  it('falls back to the shared token when the config points somewhere else', async () => {
    const h = harness()
    h.store.writeSecretJson('prs-token', personal('PERSONAL-PAT'))
    h.chat.append(configEvent({ baseUrl: 'https://tfs.corp/tfs' }), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    expect(h.svc.status().tokenSource).toBe('shared')
    expect(h.tokens).toContain('shared-token-value')
    expect(h.tokens).not.toContain('PERSONAL-PAT')
    h.svc.stop()
  })

  it('saveConfig binds the token to the base URL the user typed', async () => {
    const h = harness()
    h.svc.start()
    await h.svc.saveConfig({
      baseUrl: 'https://tfs.corp:8080/tfs/DefaultCollection/',
      project: 'Proj',
      repos: [{ id: 'r1', name: 'api' }],
      token: 'tok',
      shareToken: false,
    })
    expect(h.store.readSecretJson('prs-token')).toEqual(personal('tok', 'https://tfs.corp:8080'))
    expect(h.svc.status().tokenSource).toBe('personal')
    h.svc.stop()
  })
})

describe('PrService — state changing under a poll in flight', () => {
  it('a token change mid-poll is dropped, not reported as a network failure', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()

    const release = h.holdPrs()
    const inFlight = h.svc.refresh()
    await vi.advanceTimersByTimeAsync(0)
    h.svc.setPersonalToken('fresh-token')
    release()
    await inFlight
    expect(h.svc.status().error).toBeNull()

    // The immediate poll the token change asked for is not swallowed by the
    // re-entrancy guard, and it goes out with the new token.
    await vi.advanceTimersByTimeAsync(0)
    expect(h.tokens.at(-1)).toBe('fresh-token')
    expect(h.svc.status().error).toBeNull()
    expect(h.svc.list().map((p) => p.id)).toEqual([1])
    h.svc.stop()
  })

  it('a disconnect mid-poll neither resurrects the list nor invents an error', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()

    const release = h.holdPrs()
    const inFlight = h.svc.refresh()
    await vi.advanceTimersByTimeAsync(0)
    await h.svc.disconnect()
    release()
    await inFlight
    expect(h.svc.status().error).toBeNull()
    expect(h.svc.list()).toEqual([])

    await vi.advanceTimersByTimeAsync(0)
    expect(h.svc.status().configured).toBe(false)
    expect(h.svc.status().error).toBeNull()
    h.svc.stop()
  })

  it('a markSeen during a poll survives the poll installing its list', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    expect(h.svc.status().unseen).toBe(1)

    const release = h.holdPrs()
    const inFlight = h.svc.refresh()
    await vi.advanceTimersByTimeAsync(0)
    h.svc.markSeen(['r1:1'])
    expect(h.svc.status().unseen).toBe(0)
    release()
    await inFlight

    expect(h.svc.status().unseen).toBe(0)
    expect(h.svc.list()[0].seen).toBe(true)
    expect(h.store.readSecretJson('prs-seen')).toEqual({ 'r1:1': true })
    h.svc.stop()
  })
})

describe('PrService — writes to the team log', () => {
  it('saveConfig publishes the full snapshot and keeps a personal copy of the token', async () => {
    const h = harness()
    h.svc.start()
    await h.svc.saveConfig({
      baseUrl: 'https://dev.azure.com/acme/',
      project: ' Proj ',
      repos: [
        { id: 'r1', name: 'api' },
        { id: '', name: 'nameless' },
      ],
      token: ' tok ',
      shareToken: true,
    })
    expect(h.chat.published).toHaveLength(1)
    expect(h.chat.published[0].conv).toBe(TEAM_CONV.prs)
    expect(h.chat.published[0].type).toBe('prs')
    expect(h.chat.published[0].payload).toEqual({
      t: 'prs',
      conv: TEAM_CONV.prs,
      config: {
        baseUrl: 'https://dev.azure.com/acme',
        project: 'Proj',
        repos: [{ id: 'r1', name: 'api' }],
        sharedToken: 'tok',
        // 1.4 — omitted by the caller, so the defaults ride along.
        reviewSlaHours: PRS.reviewSlaHours,
        staleAfterDays: PRS.staleAfterDays,
      },
    })
    // Even when shared: un-sharing later must not lock the configurer out.
    expect(h.store.readSecretJson('prs-token')).toEqual(personal('tok'))
    h.svc.stop()
  })

  it('saveConfig with shareToken false publishes an empty sharedToken', async () => {
    const h = harness()
    h.svc.start()
    await h.svc.saveConfig({
      baseUrl: 'https://dev.azure.com/acme',
      project: 'Proj',
      repos: [{ id: 'r1', name: 'api' }],
      token: 'tok',
      shareToken: false,
    })
    const payload = h.chat.published[0].payload as PrsPayload
    expect(payload.config.sharedToken).toBe('')
    expect(h.svc.status().tokenSource).toBe('personal')
    h.svc.stop()
  })

  it('saveConfig with an empty token keeps the token the team already shares', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await h.svc.saveConfig({
      baseUrl: 'https://dev.azure.com/acme',
      project: 'Proj',
      repos: [{ id: 'r1', name: 'api' }],
      token: '',
      shareToken: true,
    })
    const payload = h.chat.published[0].payload as PrsPayload
    expect(payload.config.sharedToken).toBe('shared-token-value')
    expect(h.store.data.has('prs-token')).toBe(false)
    h.svc.stop()
  })

  it('saveConfig refuses an unusable config', async () => {
    const h = harness()
    const base = { baseUrl: 'https://dev.azure.com/acme', project: 'Proj', repos: [{ id: 'r1', name: 'api' }], token: 't', shareToken: false }
    await expect(h.svc.saveConfig({ ...base, baseUrl: 'not a url' })).rejects.toThrow(/invalid-config/)
    await expect(h.svc.saveConfig({ ...base, project: '  ' })).rejects.toThrow(/invalid-config/)
    await expect(h.svc.saveConfig({ ...base, repos: [] })).rejects.toThrow(/invalid-config/)
    expect(h.chat.published).toHaveLength(0)
  })

  it('disconnect publishes an empty config, clears prs-seen and keeps the personal token', async () => {
    const h = harness()
    h.store.writeSecretJson('prs-token', personal('mine'))
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    h.svc.markSeen(['r1:1'])
    expect(h.store.data.has('prs-seen')).toBe(true)

    await h.svc.disconnect()
    const payload = h.chat.published[0].payload as PrsPayload
    // The thresholds ride along: disconnecting says nothing about the SLA the
    // team agreed on, and this snapshot is the one everybody materializes next.
    expect(payload.config).toEqual({
      baseUrl: '',
      project: '',
      repos: [],
      sharedToken: '',
      reviewSlaHours: PRS.reviewSlaHours,
      staleAfterDays: PRS.staleAfterDays,
    })
    expect(h.store.data.has('prs-seen')).toBe(false)
    expect(h.store.readSecretJson('prs-token')).toEqual(personal('mine'))
    expect(h.svc.list()).toEqual([])
    expect(h.svc.status().configured).toBe(false)
    h.svc.stop()
  })
})
