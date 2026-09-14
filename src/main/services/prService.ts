import { Notification, net } from 'electron'
import type { BrowserWindow } from 'electron'
import type { PushMessage, SettingsView } from '@shared/bridge'
import type {
  AdoError,
  AdoResult,
  ConvId,
  PrState,
  PrStateKind,
  PrsConfig,
  PrsProbe,
  PrsRepo,
  PrsStatus,
  PrView,
} from '@shared/types'
import { POLL, PRS, TEAM_CONV } from '@shared/constants'
import { shouldNotifyPr } from '@shared/notifyDecision'
import { baseUrlOrigin, isTracked, materializePrsConfig, normalizeBaseUrl, toPrView } from '@shared/prs'
import { computePrState, summarizeThreads, type PrThreadSummary, type PrThresholds } from '@shared/prState'
import { prTransitionLine, type PrTransitionKind } from './notifyLine'
import { AdoClient, type AdoRepo, type AdoResponse, type FetchLike } from './ado'
import type { SecretStore } from '../store/secretStore'
import type { ChatService } from './chatService'

// The pull-request group. Three pieces of state with three different homes:
//
//   • the config (base URL, project, watched repos, optional shared token)
//     lives in the `team:prs` event log — encrypted under the team key, so
//     "available for the entire team" is literal;
//   • the personal token lives in the local secret 'prs-token' and never
//     leaves the machine (and is NOT cleared by changeTeamFolder — it is the
//     user's, not the team's). It is stored together with the origin it was
//     entered for and is only ever sent there: the config is a shared,
//     teammate-writable document, so a base URL pointing somewhere else must
//     not be able to redirect this machine's own credential;
//   • the seen set lives in 'prs-seen', pruned to the tracked keys every poll
//     so a merged PR cannot keep a row in it forever.
//
// Polling is a self-rescheduling setTimeout, never setInterval: a slow or
// hanging ADO call must not queue a second poll behind it. Errors back off
// exponentially to POLL.prsBackoffMaxMs so an expired PAT does not hammer a
// corporate proxy once a minute all day.

const TOKEN_SECRET = 'prs-token'
const SEEN_SECRET = 'prs-seen'
const HISTORY_SECRET = 'prs-history'

/** Let the share catch up and the window settle before the first network call. */
const FIRST_POLL_MS = 3_000
const MAX_BACKOFF_STEPS = 8

/**
 * How many PRs the round-robin detail refresh may touch in one poll. Five
 * polls a minute apart cover the whole set inside PRS.detailRefreshMs, so the
 * extra load is ≈ 2·N/5 requests per minute spread evenly rather than 2·N
 * every five minutes in one burst.
 */
const DETAIL_SPREAD_POLLS = 5

const EMPTY_CONFIG: PrsConfig = {
  baseUrl: '',
  project: '',
  repos: [],
  sharedToken: '',
  reviewSlaHours: PRS.reviewSlaHours,
  staleAfterDays: PRS.staleAfterDays,
}

/** The personal PAT plus the `protocol//host` it was entered for. */
interface PersonalToken {
  token: string
  origin: string
}

/**
 * What the two extra reads per PR (threads + iterations) told us last time,
 * kept in memory only — it is a cache of somebody else's server, and a cold
 * start re-reads it in one poll anyway.
 */
interface PrDetail {
  /** ms epoch of the last attempt, successful or not: also the round-robin cursor. */
  fetchedAt: number
  /** The `lastMergeCommit` these details describe; a different one means a push. */
  commit: string
  /**
   * Whether `commit` was actually answered for. A refresh whose two reads both
   * failed leaves this false, so the PR stays on the forced list (rate-limited
   * by `fetchedAt`) instead of banking a commit nobody read anything about.
   */
  read: boolean
  threads: PrThreadSummary[]
  /** False on a pre-3.0 server, or when the last attempt failed and nothing was ever read. */
  threadsKnown: boolean
  lastPushAt: number | null
}

/** One reviewer's vote as this device last saw it, and when it first saw it. */
interface VoteMark {
  v: number
  at: number
}

/**
 * The local, team-scoped vote history ('prs-history'). Azure DevOps does not
 * timestamp votes at all, so "waiting since" would otherwise be unknowable:
 * this remembers the moment a vote *changed* between two polls, and floors a
 * vote it has never seen before at the PR's last push (the earliest moment it
 * could possibly be evidence about the code that is there now). `push` is kept
 * alongside so a restart before the first detail fetch still has that floor.
 */
interface PrHistoryEntry {
  votes: Record<string, VoteMark>
  push?: number
}

type PrHistory = Record<string, PrHistoryEntry>

/**
 * Electron's proxy-aware fetch — never `node:https` or global fetch, which
 * ignore the system proxy and the enterprise trust store that on-prem Azure
 * DevOps usually sits behind.
 */
function electronFetch(): FetchLike {
  return (url, init) =>
    net.fetch(url, {
      headers: init.headers,
      signal: init.signal,
      credentials: 'omit',
      bypassCustomProtocolHandlers: true,
    }) as unknown as Promise<AdoResponse>
}

function sameConfig(a: PrsConfig, b: PrsConfig): boolean {
  return (
    a.baseUrl === b.baseUrl &&
    a.project === b.project &&
    a.sharedToken === b.sharedToken &&
    a.reviewSlaHours === b.reviewSlaHours &&
    a.staleAfterDays === b.staleAfterDays &&
    a.repos.length === b.repos.length &&
    a.repos.every((r, i) => r.id === b.repos[i].id && r.name === b.repos[i].name)
  )
}

/**
 * A threshold the renderer handed over. Absent keeps whatever the team already
 * agreed on; anything else must be a whole number inside the published range —
 * this is the write path for a value every teammate then reads.
 */
function checkThreshold(v: unknown, current: number, [lo, hi]: readonly [number, number], what: string): number {
  if (v === undefined || v === null) return current
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < lo || v > hi) {
    throw new Error(`invalid-config: ${what} must be a whole number between ${lo} and ${hi}`)
  }
  return v
}

export class PrService {
  private stopped = true
  private timer: NodeJS.Timeout | null = null
  /** Re-entrancy guard: refresh() and the timer can land together. */
  private running = false
  private failures = 0

  private config: PrsConfig = EMPTY_CONFIG
  private personal: PersonalToken | null = null
  private seen: Record<string, true> = {}
  /** Threads + last push per PR key (1.4). Memory only. */
  private details = new Map<string, PrDetail>()
  /** Observed vote times per PR key (1.4). Persisted in 'prs-history'. */
  private history: PrHistory = {}
  /**
   * Bumped whenever the credential or the collection changes. A poll snapshots
   * it before its round-trips and disowns its results if it moved: those
   * answers came from the previous identity, and `me` may already be null
   * under them.
   */
  private configGen = 0

  private prs: PrView[] = []
  private prevKeys = new Set<string>()
  private me: { id: string; name: string } | null = null
  private lastPollAt: number | null = null
  private polling = false
  private error: PrsStatus['error'] = null
  /** Set by saveConfig: the configurer just looked at the list, don't toast it back. */
  private skipNotifyOnce = false
  /**
   * The first successful poll of a session is a catch-up, not news: a machine
   * woken with the app in the background must not toast every PR that was
   * already pending. The badge/unseen count still reflect them.
   */
  private caughtUp = false
  /**
   * The waiting state each tracked PR was last *seen* in, per PR key (1.4).
   * Author-side transitions ("changes requested", "approved") fire on a change
   * of this value, so a state that flaps between two polls costs one
   * notification per change rather than one per poll — and a PR seen for the
   * first time, in whatever state, is only ever recorded. Memory only, and
   * cleared whenever the config changes: a different collection's PR ids say
   * nothing about this one's.
   */
  private lastKind = new Map<string, PrStateKind>()

  private readonly fetchImpl: FetchLike

  /**
   * The REST API version a server accepted, once negotiated — carried into
   * every later client so an old on-prem server costs one extra round trip per
   * process, not one per poll. Keyed by origin: negotiation only ever steps
   * *down*, so handing server B the version server A settled on would pin B
   * lower than it deserves for the life of the process.
   */
  private apiVersions = new Map<string, string>()

  private apiVersionFor(baseUrl: string): string | undefined {
    const origin = baseUrlOrigin(baseUrl)
    return origin ? this.apiVersions.get(origin) : undefined
  }

  private rememberApiVersion(baseUrl: string, version: string): void {
    const origin = baseUrlOrigin(baseUrl)
    if (origin) this.apiVersions.set(origin, version)
  }

  constructor(
    private chat: ChatService,
    private store: SecretStore,
    private getWindow: () => BrowserWindow | null,
    private push: (m: PushMessage) => void,
    private getVersion: () => string,
    /** The device's notification preferences (1.4) — read per poll, never cached. */
    private getSettings: () => SettingsView,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? electronFetch()
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.caughtUp = false
    this.personal = this.readToken()
    this.seen = this.readSeen()
    this.history = this.readHistory()
    this.chat.events.onEvent((conv: ConvId) => {
      if (this.stopped || conv !== TEAM_CONV.prs) return
      this.applyConfig(false)
    })
    this.applyConfig(true)
    this.schedule(FIRST_POLL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  // -------------------------------------------------------------------------
  // Reads

  status(): PrsStatus {
    return {
      configured: this.configured(),
      baseUrl: this.config.baseUrl,
      project: this.config.project,
      repos: this.config.repos.map((r) => ({ id: r.id, name: r.name })),
      tokenSource: this.tokenSource(),
      sharedTokenSet: this.config.sharedToken !== '',
      me: this.me ? { id: this.me.id, name: this.me.name } : null,
      lastPollAt: this.lastPollAt,
      polling: this.polling,
      error: this.error,
      // An approved PR still sits in the list ("Ready to complete") but never
      // lights the badge: nobody is waiting for a review on it (1.4).
      unseen: this.prs.reduce((n, p) => n + (p.seen || p.state?.kind === 'approved' ? 0 : 1), 0),
      overdue: this.prs.reduce((n, p) => n + (p.state?.overdue ? 1 : 0), 0),
      stale: this.prs.reduce((n, p) => n + (p.state?.stale ? 1 : 0), 0),
      ...this.thresholds(),
    }
  }

  /** The team's waiting thresholds, defaulted (a 1.3 config carries neither). */
  private thresholds(): PrThresholds {
    return {
      reviewSlaHours: this.config.reviewSlaHours ?? PRS.reviewSlaHours,
      staleAfterDays: this.config.staleAfterDays ?? PRS.staleAfterDays,
    }
  }

  list(): PrView[] {
    return this.prs.slice()
  }

  private configured(): boolean {
    // materializePrsConfig returns the disconnect snapshot (baseUrl '') rather
    // than null, so "configured" is a property of the config, not of its
    // presence.
    return this.config.baseUrl !== '' && this.config.repos.length > 0
  }

  private tokenSource(): PrsStatus['tokenSource'] {
    if (this.personalTokenHere()) return 'personal'
    if (this.config.sharedToken) return 'shared'
    return 'none'
  }

  private token(): string {
    return this.personalTokenHere() ?? this.config.sharedToken ?? ''
  }

  /**
   * The personal token, but only for the server it was entered for. Anyone
   * holding the team passphrase can publish a config, so an unbound personal
   * token would let a single `prs` event point every teammate's PAT at a host
   * of the author's choosing. A base URL this machine has not approved falls
   * back to the shared token, or to the pane's "enter your token" state.
   */
  private personalTokenHere(): string | null {
    if (!this.personal) return null
    const origin = baseUrlOrigin(this.config.baseUrl)
    return origin !== null && origin === this.personal.origin ? this.personal.token : null
  }

  private ua(): string {
    return `Chat/${this.getVersion()}`
  }

  // -------------------------------------------------------------------------
  // Config log

  private applyConfig(initial: boolean): void {
    const mat = materializePrsConfig(this.chat.getEvents(TEAM_CONV.prs))
    const next = mat ? mat.config : EMPTY_CONFIG
    if (sameConfig(next, this.config)) return
    const rebind = next.baseUrl !== this.config.baseUrl || next.sharedToken !== this.config.sharedToken
    // A different collection or project is a different set of pull requests,
    // so the cached details mean nothing. A *token* change is not: it is the
    // same server's PRs read with another credential, and dropping the cache
    // for it would spend 2·N requests on the very next poll every time
    // somebody edits a PAT or shares one with the team.
    const moved = next.baseUrl !== this.config.baseUrl || next.project !== this.config.project
    this.config = next
    this.configGen += 1 // a poll in flight is answering for the old config
    // Whatever the new config lists is news to the author-side transitions:
    // the next poll re-seeds them, and nothing toasts off that poll (1.4).
    this.lastKind.clear()
    if (rebind) this.me = null // a different collection or credential: re-identify
    if (moved) this.details.clear() // …and a different server's PR ids mean nothing here
    this.error = null
    if (initial) return
    this.pushState()
    this.schedule(0) // a config change is worth an immediate poll
  }

  // -------------------------------------------------------------------------
  // Polling

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.poll()
    }, ms)
    this.timer.unref?.()
  }

  private nextDelayMs(): number {
    if (this.failures === 0) return POLL.prsMs
    const steps = Math.min(this.failures, MAX_BACKOFF_STEPS)
    return Math.min(POLL.prsMs * 2 ** steps, POLL.prsBackoffMaxMs)
  }

  /** Immediate poll (the pane's ↻ button). Never throws. */
  async refresh(): Promise<void> {
    await this.poll()
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.running) return
    const gen = this.configGen
    this.running = true
    this.polling = true
    this.pushState()
    try {
      const ok = await this.doPoll(gen)
      // null: the config or the credential changed under the poll. Its answers
      // are not evidence about the new one, so neither the error nor the
      // backoff counter may be touched — and the immediate poll the change
      // asked for was swallowed by the re-entrancy guard, so the finally
      // below runs it now.
      if (ok !== null) this.failures = ok ? 0 : this.failures + 1
    } catch {
      // Nothing here should throw — a bug in the diff must not kill the loop.
      // The thrown message is a JS error, not a diagnosis: it never gets dressed
      // up as one, and no unvetted string rides out to the pane.
      this.failures += 1
      this.error = { code: 'network', detail: 'The pull-request poll failed unexpectedly' }
    } finally {
      this.running = false
      this.polling = false
      this.schedule(this.configGen === gen ? this.nextDelayMs() : 0)
      this.pushState()
    }
  }

  /**
   * Returns false when the poll failed (so the caller can back off), null when
   * the config or the credential changed while it was in flight.
   */
  private async doPoll(gen: number): Promise<boolean | null> {
    if (!this.configured() || !this.token()) {
      // Not set up, or nobody has supplied a token yet: both are UI states in
      // the pane, not error strips.
      this.prs = []
      this.prevKeys = new Set()
      this.error = null
      return true
    }

    const client = new AdoClient(this.fetchImpl, {
      baseUrl: this.config.baseUrl,
      token: this.token(),
      userAgent: this.ua(),
      apiVersion: this.apiVersionFor(this.config.baseUrl),
    })

    if (!this.me) {
      const who = await client.me()
      this.rememberApiVersion(this.config.baseUrl, client.apiVersion)
      if (gen !== this.configGen) return null
      if (!who.ok) {
        this.error = who.error
        return false
      }
      this.me = who.value
    }

    // Snapshot the identity: `this.me` can be nulled from outside (a token
    // change, a disconnect, a teammate's config landing) across the awaits
    // below, and TypeScript keeps the narrowing right over them.
    const meId = this.me.id
    const seenSet = new Set(Object.keys(this.seen))
    const views: PrView[] = []
    for (const repo of this.config.repos) {
      const res = await client.activePullRequests(this.config.project, repo.id)
      if (gen !== this.configGen) return null
      if (!res.ok) {
        this.error = res.error
        return false // keep the previous list on screen rather than blanking it
      }
      for (const raw of res.value) {
        const view = toPrView(raw, {
          baseUrl: this.config.baseUrl,
          project: this.config.project,
          meId,
          seen: seenSet,
        })
        if (isTracked({ isDraft: view.isDraft, status: raw.status, reviewers: view.reviewers })) views.push(view)
      }
    }
    views.sort((a, b) => b.createdAt - a.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

    const keys = new Set(views.map((v) => v.key))
    this.pruneSeen(keys)
    for (const k of this.details.keys()) if (!keys.has(k)) this.details.delete(k)

    // The two extra reads per PR. Best-effort by construction: a threads or
    // iterations failure never fails the poll — the list is still true, only
    // its waiting state is a little older.
    if ((await this.refreshDetails(client, views, gen)) === null) return null

    const now = Date.now()
    this.observeVotes(views, now)

    // The seen flags come from the live set, not from `seenSet`: a markSeen()
    // that landed during the round-trips above is already in `this.seen`, and
    // installing the pre-fetch snapshot over it would flip those rows back to
    // unseen with no way left to correct them (a repeat markSeen with the same
    // keys is a no-op, and the pane only re-arms when the key set changes).
    const list = views.map((v) => ({
      ...v,
      seen: this.seen[v.key] === true || v.seen,
      state: this.stateFor(v, now),
    }))

    // "New" = appeared since the last poll AND never marked seen. A PR that
    // goes completed/abandoned/draft simply stops being tracked and drops out
    // of the list on the next poll; an approved one stays, but it is nobody's
    // review to do, so it never announces itself (1.4).
    const fresh = list.filter((v) => !v.seen && !this.prevKeys.has(v.key) && v.state?.kind !== 'approved')

    this.prs = list
    this.prevKeys = keys
    this.lastPollAt = Date.now()
    this.error = null

    const skip = this.skipNotifyOnce || !this.caughtUp
    this.skipNotifyOnce = false
    this.caughtUp = true
    // Seeded on every poll, including the skipped ones, so "what changed" is
    // always measured against a poll this process actually saw (1.4).
    const moved = this.trackTransitions(list, skip)
    if (fresh.length && !skip) this.notify(fresh)
    if (moved.length) this.notifyTransitions(moved)
    return true
  }

  /**
   * The identity behind the poll, but only when it really is *mine*. On the
   * team's shared token `this.me` is whoever configured the group, so treating
   * their id as mine would invert every "is this mine" test in this file.
   */
  private myIdentity(): string {
    return this.tokenSource() === 'personal' ? (this.me?.id ?? '') : ''
  }

  private notify(fresh: PrView[]): void {
    const win = this.getWindow()
    if (win?.isFocused()) return // the in-app PrAlert covers the focused case
    // Never toast my own PR (see myIdentity above for the shared-token case),
    // and let the device's preference decide the rest: 'mine' keeps only the
    // pull requests waiting on me, 'none' keeps nothing. The unseen count is
    // information rather than an interruption, so it is not filtered.
    const mine = this.myIdentity()
    const settings = this.getSettings()
    const now = Date.now()
    const others = (mine === '' ? fresh : fresh.filter((p) => p.author.id !== mine)).filter((view) =>
      shouldNotifyPr({ view, meId: this.me?.id ?? null, settings, now }),
    )
    if (!others.length) return
    if (!Notification.isSupported()) return

    const one = others[0]
    const title =
      others.length === 1
        ? `Pull request #${one.id} · ${one.repoName}`
        : `${others.length} new pull requests need review`
    const body =
      others.length === 1
        ? `${one.title} — ${one.author.name}`
        : others
            .slice(0, 3)
            .map((p) => p.title)
            .join('\n')

    const n = new Notification({ title, body, silent: false })
    n.on('click', () => {
      const w = this.getWindow()
      w?.show()
      w?.focus()
      this.push({ kind: 'prs-open' })
    })
    n.show()
  }

  /**
   * Record the waiting state of every tracked PR, and answer with the moves on
   * *my own* pull requests that are worth interrupting me for (1.4).
   *
   * The bookkeeping happens on every poll, the notifying only when the poll is
   * news: recording during a skipped poll is exactly what makes "the state was
   * already like that when I opened the app" silent, and pruning to this poll's
   * keys is what stops a merged PR from keeping a row forever. A PR seen for
   * the first time has nothing to have moved *from*, so it never fires either.
   */
  private trackTransitions(list: PrView[], skip: boolean): { view: PrView; kind: PrTransitionKind }[] {
    const mine = this.myIdentity()
    const next = new Map<string, PrStateKind>()
    const moved: { view: PrView; kind: PrTransitionKind }[] = []
    for (const view of list) {
      const kind = view.state?.kind
      if (kind === undefined) continue
      const before = this.lastKind.get(view.key)
      next.set(view.key, kind)
      if (skip || before === undefined || before === kind) continue
      if (mine === '' || view.author.id !== mine) continue
      if (kind === 'changes-requested' || kind === 'comments-open' || kind === 'approved') moved.push({ view, kind })
    }
    this.lastKind = next
    return moved
  }

  /**
   * "Your PR #123 — changes requested by Ana". One notification per move, not
   * per poll — `trackTransitions` has already decided that something changed.
   * The window being focused suppresses these exactly as it does every other
   * toast in the app; the pane itself is the in-app treatment.
   */
  private notifyTransitions(moved: { view: PrView; kind: PrTransitionKind }[]): void {
    const win = this.getWindow()
    if (win?.isFocused()) return
    if (!Notification.isSupported()) return
    const settings = this.getSettings()
    const now = Date.now()
    for (const { view, kind } of moved) {
      if (!shouldNotifyPr({ view, meId: this.me?.id ?? null, settings, now })) continue
      const { title, body } = prTransitionLine({
        kind,
        id: view.id,
        title: view.title,
        repoName: view.repoName,
        by: view.reviewers.filter((r) => r.vote < 0).map((r) => r.name),
        openThreads: view.state?.openThreads ?? 0,
      })
      const n = new Notification({ title, body, silent: false })
      n.on('click', () => {
        const w = this.getWindow()
        w?.show()
        w?.focus()
        this.push({ kind: 'prs-open' })
      })
      n.show()
    }
  }

  // -------------------------------------------------------------------------
  // Waiting state (1.4): threads, iterations, and the local vote history

  /**
   * Refresh the per-PR details for the PRs that need it, and only those.
   *
   *   • **first sight** and **a new `lastMergeCommit`** are refreshed at once:
   *     a PR nobody has details for has no state to show, and a push resets
   *     every vote's meaning, so both are worth the two requests immediately;
   *   • everything else is refreshed **round-robin**, oldest first, at most
   *     ceil(N / DETAIL_SPREAD_POLLS) PRs per poll. With a 60 s poll and a
   *     5-minute PRS.detailRefreshMs that walks the whole set exactly once per
   *     refresh window, without ever spending 2·N requests in a single minute.
   *
   * Returns null when the config changed underneath (the caller disowns the
   * whole poll), true otherwise — a failed detail read is not a failed poll.
   */
  private async refreshDetails(client: AdoClient, views: PrView[], gen: number): Promise<true | null> {
    if (views.length === 0) return true
    const now = Date.now()
    const forced: PrView[] = []
    const due: PrView[] = []
    for (const v of views) {
      const cached = this.details.get(v.key)
      if (!cached) {
        forced.push(v) // no details at all: there is no state to show yet
      } else if (!cached.read) {
        // The last attempt answered nothing and banked nothing, so this PR is
        // still forced — but a failing endpoint is retried once per refresh
        // window rather than once per poll. (Before 1.4's review this branch
        // did not exist: a failed read stamped the new commit anyway, and a
        // push whose detail read 429'd was never picked up again.)
        if (now - cached.fetchedAt >= PRS.detailRefreshMs) forced.push(v)
      } else if (cached.commit !== (v.lastMergeCommit ?? '')) {
        forced.push(v) // a push: every vote's meaning just changed
      } else if (now - cached.fetchedAt >= PRS.detailRefreshMs) {
        due.push(v)
      }
    }
    due.sort((a, b) => (this.details.get(a.key)?.fetchedAt ?? 0) - (this.details.get(b.key)?.fetchedAt ?? 0))
    const budget = Math.ceil(views.length / DETAIL_SPREAD_POLLS)

    // The forced list is capped too (twice the round-robin budget, remainder
    // next poll). Without it the first poll after a config lands spends 2·N
    // serial requests before the pane shows anything — 60 round trips for 30
    // tracked PRs — and any burst of pushes does the same.
    for (const v of [...forced.slice(0, budget * 2), ...due.slice(0, budget)]) {
      const prev = this.details.get(v.key)
      const next: PrDetail = {
        fetchedAt: Date.now(),
        // Only banked once something actually answered, below.
        commit: prev?.commit ?? '',
        read: false,
        threads: prev?.threads ?? [],
        threadsKnown: prev?.threadsKnown === true,
        lastPushAt: prev?.lastPushAt ?? null,
      }

      const threads = await client.threads(this.config.project, v.repoId, v.id)
      if (gen !== this.configGen) return null
      if (threads.ok) {
        next.threads = summarizeThreads(threads.value)
        next.threadsKnown = true
      } else if (threads.reason === 'unsupported') {
        // A pre-3.0 server. Not an error and not worth retrying differently:
        // the pane says comment status is unavailable and the state is
        // computed from votes alone.
        next.threads = []
        next.threadsKnown = false
      }

      const iterations = await client.iterations(this.config.project, v.repoId, v.id)
      if (gen !== this.configGen) return null
      if (iterations.ok) {
        // The newest iteration is the last push; iteration 1 is the PR itself.
        let latest = 0
        for (const it of iterations.value) {
          const at = Date.parse(String(it.createdDate ?? ''))
          if (!Number.isNaN(at) && at > latest) latest = at
        }
        next.lastPushAt = latest > 0 ? latest : null
      } else if (iterations.reason === 'unsupported') {
        next.lastPushAt = null
      }

      // "Answered" includes `unsupported` — a pre-3.0 server has told us
      // everything it ever will about this PR. Only when *both* reads failed
      // does the commit stay unbanked, so the next window tries again instead
      // of believing a 429 meant "these details describe that push".
      if (threads.ok || threads.reason === 'unsupported' || iterations.ok || iterations.reason === 'unsupported') {
        next.commit = v.lastMergeCommit ?? ''
        next.read = true
      }

      // Whatever happened, the attempt counts (`fetchedAt`): a server that
      // 404s this PR's threads must not be re-asked on every single poll.
      this.details.set(v.key, next)
    }
    return true
  }

  /**
   * Fold this poll's votes into the observation history. A vote that is new to
   * this device is dated at the PR's last push (or its creation) — the
   * earliest moment it could be a judgement about today's code; a vote that
   * *changed* between two polls is dated now, which is accurate to within one
   * poll interval. Pruned to the tracked keys, exactly like 'prs-seen'.
   */
  private observeVotes(views: PrView[], now: number): void {
    const next: PrHistory = {}
    let changed = Object.keys(this.history).length !== views.length
    for (const v of views) {
      const prev = this.history[v.key]
      const push = this.details.get(v.key)?.lastPushAt ?? prev?.push ?? null
      const floor = Math.max(push ?? 0, v.createdAt)
      const votes: Record<string, VoteMark> = {}
      for (const r of v.reviewers) {
        const before = prev?.votes[r.id]
        if (before && before.v === r.vote) votes[r.id] = before
        else {
          votes[r.id] = { v: r.vote, at: before ? now : floor }
          changed = true
        }
      }
      if (!prev || prev.push !== (push ?? undefined) || Object.keys(prev.votes).length !== Object.keys(votes).length) {
        changed = true
      }
      next[v.key] = push === null ? { votes } : { votes, push }
    }
    this.history = next
    if (changed) this.store.writeSecretJson(HISTORY_SECRET, next)
  }

  /** The waiting state of one PR, from its votes, its threads and the history. */
  private stateFor(v: PrView, now: number): PrState {
    const detail = this.details.get(v.key)
    const hist = this.history[v.key]
    return computePrState(
      {
        createdAt: v.createdAt,
        authorId: v.author.id,
        authorName: v.author.name,
        meId: this.me?.id ?? null,
        reviewers: v.reviewers.map((r) => ({ ...r, votedAt: hist?.votes[r.id]?.at ?? null })),
        threads: detail?.threads ?? [],
        threadsKnown: detail?.threadsKnown === true,
        lastPushAt: detail?.lastPushAt ?? hist?.push ?? null,
      },
      now,
      this.thresholds(),
    )
  }

  private readHistory(): PrHistory {
    const raw = this.store.readSecretJson<Record<string, unknown>>(HISTORY_SECRET)
    if (!raw || typeof raw !== 'object') return {}
    const out: PrHistory = {}
    for (const [key, value] of Object.entries(raw)) {
      if (!key || !value || typeof value !== 'object') continue
      const rec = value as { votes?: unknown; push?: unknown }
      const votes: Record<string, VoteMark> = {}
      for (const [id, mark] of Object.entries((rec.votes ?? {}) as Record<string, unknown>)) {
        const m = mark as { v?: unknown; at?: unknown }
        if (typeof m?.v !== 'number' || typeof m?.at !== 'number') continue
        votes[id] = { v: m.v, at: m.at }
      }
      out[key] = typeof rec.push === 'number' ? { votes, push: rec.push } : { votes }
    }
    return out
  }

  // -------------------------------------------------------------------------
  // Seen set

  private readSeen(): Record<string, true> {
    const raw = this.store.readSecretJson<Record<string, unknown>>(SEEN_SECRET)
    if (!raw || typeof raw !== 'object') return {}
    const out: Record<string, true> = {}
    for (const k of Object.keys(raw)) if (typeof k === 'string' && k) out[k] = true
    return out
  }

  private pruneSeen(keys: Set<string>): void {
    let changed = false
    for (const k of Object.keys(this.seen)) {
      if (!keys.has(k)) {
        delete this.seen[k]
        changed = true
      }
    }
    if (changed) this.store.writeSecretJson(SEEN_SECRET, this.seen)
  }

  markSeen(keys: string[]): void {
    const tracked = new Set(this.prs.map((p) => p.key))
    let changed = false
    for (const k of Array.isArray(keys) ? keys : []) {
      if (typeof k !== 'string' || !tracked.has(k) || this.seen[k]) continue
      this.seen[k] = true
      changed = true
    }
    if (changed) this.store.writeSecretJson(SEEN_SECRET, this.seen)
    // Reconcile against `this.seen` rather than against `changed`, so a row
    // whose flag disagrees with the persisted set is repaired even when this
    // call added nothing.
    const list = this.prs.map((p) => (this.seen[p.key] && !p.seen ? { ...p, seen: true } : p))
    if (!changed && list.every((p, i) => p === this.prs[i])) return
    this.prs = list
    this.pushState()
  }

  // -------------------------------------------------------------------------
  // Token

  private readToken(): PersonalToken | null {
    const raw = this.store.readSecretJson<unknown>(TOKEN_SECRET)
    if (!raw || typeof raw !== 'object') return null
    const rec = raw as { token?: unknown; origin?: unknown }
    const token = typeof rec.token === 'string' ? rec.token.trim() : ''
    const origin = typeof rec.origin === 'string' ? baseUrlOrigin(rec.origin) : null
    return token && origin ? { token, origin } : null
  }

  /**
   * Store the token against a base URL the *user* supplied — the one typed in
   * the prefs pane, or the one the pane was showing when they pasted a token
   * for a group somebody else set up. It is never re-bound from the log.
   */
  private writeToken(token: string, baseUrl: string): void {
    const origin = baseUrlOrigin(baseUrl)
    this.personal = origin ? { token, origin } : null
    if (this.personal) this.store.writeSecretJson(TOKEN_SECRET, this.personal)
    else this.store.deleteSecret(TOKEN_SECRET)
  }

  setPersonalToken(token: string | null): void {
    const t = typeof token === 'string' ? token.trim() : ''
    if (t) this.writeToken(t, this.config.baseUrl)
    else {
      this.personal = null
      this.store.deleteSecret(TOKEN_SECRET)
    }
    this.me = null
    this.configGen += 1
    this.error = null
    this.pushState()
    this.schedule(0)
  }

  // -------------------------------------------------------------------------
  // Prefs-pane RPCs (throwaway clients — none of this touches the poll state)

  /**
   * An empty token falls back to the effective one, so "Test" works on a
   * prefill — but the personal token falls back only for the server it belongs
   * to, exactly as in a poll. Probing a different host takes a typed token.
   */
  private probeToken(input: { token?: unknown }, baseUrl: string): string {
    const given = typeof input?.token === 'string' ? input.token.trim() : ''
    if (given) return given
    const origin = baseUrlOrigin(baseUrl)
    if (this.personal && origin !== null && origin === this.personal.origin) return this.personal.token
    return this.config.sharedToken ?? ''
  }

  async testConnection(input: { baseUrl: string; token: string }): Promise<PrsProbe> {
    const baseUrl = normalizeBaseUrl(String(input?.baseUrl ?? ''))
    if (!baseUrl) {
      return { ok: false, error: { code: 'bad-url', detail: 'Enter a URL like https://dev.azure.com/your-org' } }
    }
    const token = this.probeToken(input, baseUrl)
    if (!token) {
      return { ok: false, error: { code: 'unauthorized', detail: 'Enter an Azure DevOps personal access token' } }
    }
    const client = new AdoClient(this.fetchImpl, {
      baseUrl,
      token,
      userAgent: this.ua(),
      apiVersion: this.apiVersionFor(baseUrl),
    })
    const me = await client.me()
    this.rememberApiVersion(baseUrl, client.apiVersion)
    if (!me.ok) return this.probeFailed('connectionData', baseUrl, me.error)
    const projects = await client.projects()
    this.rememberApiVersion(baseUrl, client.apiVersion)
    if (!projects.ok) return this.probeFailed('projects', baseUrl, projects.error)
    return { ok: true, me: me.value, projects: projects.value, apiVersion: client.apiVersion }
  }

  /** `detail` is already redacted by AdoClient; the token itself never gets here. */
  private probeFailed(step: string, baseUrl: string, error: AdoError): PrsProbe {
    console.warn(`[prs] test connection failed at ${step} for ${baseUrl}: ${error.code} — ${error.detail}`)
    return { ok: false, error }
  }

  async listRepos(input: { baseUrl: string; token: string; project: string }): Promise<AdoResult<AdoRepo[]>> {
    const baseUrl = normalizeBaseUrl(String(input?.baseUrl ?? ''))
    if (!baseUrl) {
      return { ok: false, error: { code: 'bad-url', detail: 'Enter a URL like https://dev.azure.com/your-org' } }
    }
    const project = String(input?.project ?? '').trim()
    if (!project) return { ok: false, error: { code: 'not-found', detail: 'Choose a project first' } }
    const token = this.probeToken(input, baseUrl)
    if (!token) {
      return { ok: false, error: { code: 'unauthorized', detail: 'Enter an Azure DevOps personal access token' } }
    }
    const client = new AdoClient(this.fetchImpl, { baseUrl, token, userAgent: this.ua(), apiVersion: this.apiVersionFor(baseUrl) })
    const res = await client.repos(project)
    this.rememberApiVersion(baseUrl, client.apiVersion)
    return res
  }

  // -------------------------------------------------------------------------
  // Writes to the team log

  async saveConfig(input: {
    baseUrl: string
    project: string
    repos: PrsRepo[]
    token: string
    shareToken: boolean
    reviewSlaHours?: number
    staleAfterDays?: number
  }): Promise<void> {
    const baseUrl = normalizeBaseUrl(String(input?.baseUrl ?? ''))
    if (!baseUrl) throw new Error('invalid-config: base URL must be http(s) and carry no credentials')
    const project = String(input?.project ?? '').trim()
    if (!project) throw new Error('invalid-config: project is required')
    const repos = (Array.isArray(input?.repos) ? input.repos : [])
      .map((r) => ({ id: String(r?.id ?? '').trim(), name: String(r?.name ?? '').trim() }))
      .filter((r) => r.id !== '' && r.name !== '')
    if (repos.length === 0) throw new Error('invalid-config: pick at least one repository')

    const current = this.thresholds()
    const reviewSlaHours = checkThreshold(
      input?.reviewSlaHours,
      current.reviewSlaHours,
      PRS.reviewSlaHoursRange,
      'the review SLA',
    )
    const staleAfterDays = checkThreshold(
      input?.staleAfterDays,
      current.staleAfterDays,
      PRS.staleAfterDaysRange,
      'the stale threshold',
    )

    const token = typeof input?.token === 'string' ? input.token.trim() : ''
    const shareToken = input?.shareToken === true
    const config: PrsConfig = {
      baseUrl,
      project,
      repos,
      // Saving with an empty token keeps whatever the team already shares.
      sharedToken: shareToken ? token || this.config.sharedToken : '',
      reviewSlaHours,
      staleAfterDays,
    }

    // Keep a personal copy even when sharing: un-sharing later must not lock
    // the person who set it up out of their own group.
    if (token) {
      this.writeToken(token, baseUrl)
      this.me = null
      this.configGen += 1
    }

    this.skipNotifyOnce = true
    try {
      await this.chat.publishTeam(TEAM_CONV.prs, 'prs', { t: 'prs', conv: TEAM_CONV.prs, config })
    } catch (err) {
      this.skipNotifyOnce = false
      throw err
    }
  }

  /** Publish an empty config and clear the seen set; the personal token stays. */
  async disconnect(): Promise<void> {
    await this.chat.publishTeam(TEAM_CONV.prs, 'prs', {
      t: 'prs',
      conv: TEAM_CONV.prs,
      // The thresholds ride along: a disconnect is "we are not pointing at a
      // server", not "the team never agreed on an SLA". Without them the
      // snapshot would be the one payload that silently resets both for
      // everyone (materializePrsConfig carries them forward, but only for
      // payloads that omit the fields entirely — say so here rather than lean
      // on that).
      config: { baseUrl: '', project: '', repos: [], sharedToken: '', ...this.thresholds() },
    })
    this.seen = {}
    this.store.deleteSecret(SEEN_SECRET)
    this.history = {}
    this.store.deleteSecret(HISTORY_SECRET)
    this.details.clear()
    this.prs = []
    this.prevKeys = new Set()
    this.me = null
    this.configGen += 1
    this.error = null
    this.pushState()
  }

  // -------------------------------------------------------------------------

  private pushState(): void {
    this.push({ kind: 'prs', prs: this.list(), status: this.status() })
  }
}
