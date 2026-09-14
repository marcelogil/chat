import type { PushMessage } from './bridge'
import type { GrpPayload, PrView, PrsConfig, PrsPayload, PrsRepo, VerifiedEvent } from './types'
import { PRS } from './constants'

// Pure helpers for the pull-request group: the shape of the Azure DevOps JSON
// we consume, the approval/tracking rules, and the LWW merge of the
// 'team:prs' config log. No I/O — the network lives in main/services/ado.ts.

/**
 * The subset of an Azure DevOps 6.0 pull request that this app reads. Anything
 * else in the response is ignored; `isRequired` is absent on some on-prem
 * servers, which reads as "not required".
 */
export interface AdoPullRequest {
  pullRequestId: number
  title: string
  status: string // 'active' | 'completed' | 'abandoned' | …
  isDraft: boolean
  createdBy: { id: string; displayName: string }
  creationDate: string // ISO 8601
  sourceRefName: string // 'refs/heads/feature/x'
  targetRefName: string // 'refs/heads/main'
  repository: { id: string; name: string }
  reviewers: { id: string; displayName: string; vote: number; isRequired?: boolean }[]
  /** The head of the source branch as ADO last merged it — changes on every push (1.4). */
  lastMergeSourceCommit?: { commitId?: string }
}

/**
 * One comment inside a pull-request thread (1.4). `commentType` matters: ADO
 * writes its own bookkeeping ("Ada voted 10", "updated the pull request") as
 * `system` comments in threads that look exactly like human ones, and counting
 * those as review conversation would leave every PR permanently "commented".
 */
export interface AdoThreadComment {
  id?: number
  author?: { id?: string; displayName?: string }
  publishedDate?: string
  commentType?: string // 'text' | 'system' | 'codeChange'
  isDeleted?: boolean
}

/** A pull-request comment thread (1.4). Exists from API 3.0 (TFS 2017). */
export interface AdoThread {
  id: number
  /** 'unknown' | 'active' | 'fixed' | 'wontFix' | 'closed' | 'byDesign' | 'pending' */
  status?: string
  publishedDate?: string
  lastUpdatedDate?: string
  isDeleted?: boolean
  comments?: AdoThreadComment[]
}

/** One pushed revision of a pull request (1.4). Exists from API 3.0. */
export interface AdoIteration {
  id: number
  createdDate?: string
}

const REF_PREFIX = 'refs/heads/'

function stripRef(ref: string): string {
  return typeof ref === 'string' && ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : (ref ?? '')
}

// ---------------------------------------------------------------------------
// Approval / tracking rules

/**
 * ADO votes: 10 approved, 5 approved-with-suggestions, 0 no vote,
 * -5 waiting for author, -10 rejected. A PR counts as approved when somebody
 * actually approved it, nobody is blocking, and every required reviewer signed
 * off — so a required reviewer sitting at 0 keeps it in the list.
 */
export function isApproved(reviewers: PrView['reviewers']): boolean {
  if (!Array.isArray(reviewers) || reviewers.length === 0) return false
  let anyApproval = false
  for (const r of reviewers) {
    const vote = typeof r.vote === 'number' ? r.vote : 0
    if (vote < 0) return false
    if (vote >= 5) anyApproval = true
    else if (r.required) return false
  }
  return anyApproval
}

/**
 * A PR is worth showing while it is open and not a draft.
 *
 * 1.4 keeps approved pull requests in the list ("Ready to complete") — they
 * were the ones that got forgotten, which is the whole point of the waiting
 * states. They never count toward the badge: `PrsStatus.unseen` skips the
 * `approved` state, so the sidebar still means "waiting for someone".
 * (Through 1.3 this also required `!isApproved(reviewers)`.)
 */
export function isTracked(pr: { isDraft: boolean; status: string; reviewers: PrView['reviewers'] }): boolean {
  return pr.status === 'active' && !pr.isDraft
}

// ---------------------------------------------------------------------------
// View projection

export function toPrView(
  raw: AdoPullRequest,
  ctx: { baseUrl: string; project: string; meId: string | null; seen: Set<string> },
): PrView {
  const repoId = raw.repository?.id ?? ''
  const repoName = raw.repository?.name ?? ''
  const id = raw.pullRequestId
  const key = `${repoId}:${id}`
  const reviewers = (raw.reviewers ?? []).map((r) => ({
    id: r.id,
    name: r.displayName,
    vote: typeof r.vote === 'number' ? r.vote : 0,
    required: r.isRequired === true,
  }))
  const mine = ctx.meId ? reviewers.find((r) => r.id === ctx.meId) : undefined
  const createdAt = Date.parse(raw.creationDate)
  const lastMergeCommit = typeof raw.lastMergeSourceCommit?.commitId === 'string' ? raw.lastMergeSourceCommit.commitId : ''

  return {
    key,
    id,
    title: raw.title ?? '',
    repoId,
    repoName,
    author: { id: raw.createdBy?.id ?? '', name: raw.createdBy?.displayName ?? '' },
    sourceBranch: stripRef(raw.sourceRefName),
    targetBranch: stripRef(raw.targetRefName),
    createdAt: Number.isNaN(createdAt) ? 0 : createdAt,
    isDraft: raw.isDraft === true,
    reviewers,
    assignedToMe: mine !== undefined,
    myVote: mine ? mine.vote : 0,
    webUrl: `${ctx.baseUrl}/${encodeURIComponent(ctx.project)}/_git/${encodeURIComponent(repoName)}/pullrequest/${id}`,
    seen: ctx.seen.has(key),
    // '' when the server didn't say: an empty string still compares equal
    // between polls, so a server that never reports it simply never triggers a
    // commit-change refresh (the 5-minute round robin still covers it).
    lastMergeCommit,
  }
}

// ---------------------------------------------------------------------------
// Config log

function validRepos(v: unknown): v is PrsRepo[] {
  if (!Array.isArray(v)) return false
  return v.every(
    (r) =>
      !!r && typeof r === 'object' && typeof (r as PrsRepo).id === 'string' && typeof (r as PrsRepo).name === 'string',
  )
}

/**
 * A shared threshold off the share, clamped to the range the prefs pane
 * enforces. Anything else — absent (a 1.3 publisher), not a number, out of
 * range — reads as `fallback` rather than dropping the whole snapshot: an odd
 * number here must never cost the team its base URL. `fallback` is the value
 * already in force (see materializePrsConfig), not the constant default.
 */
function threshold(v: unknown, fallback: number, [lo, hi]: readonly [number, number]): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  const n = Math.round(v)
  return n < lo || n > hi ? fallback : n
}

function validConfig(v: unknown): v is PrsConfig {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return (
    typeof c.baseUrl === 'string' &&
    typeof c.project === 'string' &&
    typeof c.sharedToken === 'string' &&
    validRepos(c.repos)
  )
}

/**
 * Last valid 'prs' snapshot in stem order wins (the payload is a full config,
 * never a patch). Unverified events are ignored; null means nobody has ever
 * configured the group.
 */
export function materializePrsConfig(events: VerifiedEvent[]): { config: PrsConfig; by: string; id: string } | null {
  const sorted = [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  let winner: { config: PrsConfig; by: string; id: string } | null = null
  // 1.4 — the thresholds in force so far, carried across snapshots that do not
  // mention them. A 1.3 client cannot see these fields, so its perfectly
  // ordinary re-publish (renaming a repo, pasting a token) must not read as
  // "the team decided to go back to 48 h / 14 d". They start at the constants
  // and only a value inside the published range replaces them.
  let reviewSlaHours: number = PRS.reviewSlaHours
  let staleAfterDays: number = PRS.staleAfterDays

  for (const ev of sorted) {
    if (!ev.verified) continue
    const p = ev.payload as PrsPayload
    if (!p || p.t !== 'prs') continue
    if (!validConfig(p.config)) continue
    // A config off the share is as untrusted as renderer input — it decides
    // which host every teammate's token is sent to — so its base URL goes
    // through the same normalizer. '' is the disconnect snapshot; anything
    // that does not normalize is dropped and the previous winner stands.
    const baseUrl = p.config.baseUrl === '' ? '' : normalizeBaseUrl(p.config.baseUrl)
    if (baseUrl === null) continue
    reviewSlaHours = threshold(p.config.reviewSlaHours, reviewSlaHours, PRS.reviewSlaHoursRange)
    staleAfterDays = threshold(p.config.staleAfterDays, staleAfterDays, PRS.staleAfterDaysRange)
    winner = {
      config: {
        baseUrl,
        project: p.config.project,
        repos: p.config.repos.map((r) => ({ id: r.id, name: r.name })),
        sharedToken: p.config.sharedToken,
        // Always concrete after materialization, so nothing downstream has to
        // re-apply the defaults (1.4).
        reviewSlaHours,
        staleAfterDays,
      },
      by: ev.author,
      id: ev.id,
    }
  }

  return winner
}

/**
 * An event as the renderer may see it. Two payloads carry secrets that no
 * sandboxed web code has any use for, and both are stripped here rather than
 * copied into renderer memory:
 *
 * - a `team:prs` config, which carries the team's Azure DevOps PAT (a
 *   credential for a system outside this app; `PrsStatus` deliberately narrows
 *   it to `sharedTokenSet: boolean`);
 * - a `grp` invite/rekey (1.2), whose `data` carries the group's raw epoch key
 *   and `key1` — the key *is* the group, and `key1` is what derives its
 *   directory token. The renderer only ever renders the name.
 *
 * Main-side readers (PrService materializing the config, GroupService adopting
 * key material) must not go through this — they need what it removes.
 */
export function redactEventForRenderer(ev: VerifiedEvent): VerifiedEvent {
  const g = ev.payload as GrpPayload
  if (g && g.t === 'grp') {
    const data = g.data as unknown as Record<string, unknown>
    if (!data || typeof data !== 'object') return ev
    if (typeof data.key !== 'string' && typeof data.key1 !== 'string') return ev
    const clean = { ...data }
    if (typeof clean.key === 'string') clean.key = ''
    if (typeof clean.key1 === 'string') clean.key1 = ''
    return { ...ev, payload: { ...g, data: clean as unknown as GrpPayload['data'] } }
  }
  const p = ev.payload as PrsPayload
  if (!p || p.t !== 'prs' || !validConfig(p.config) || p.config.sharedToken === '') return ev
  return { ...ev, payload: { ...p, config: { ...p.config, sharedToken: '' } } }
}

/**
 * The same strip, applied to the live `event` push — the other way a raw event
 * reaches the renderer (`chat:events` is the first). Every other push kind is
 * returned untouched and identical, so this is safe to put on the whole channel.
 */
export function redactPushForRenderer(msg: PushMessage): PushMessage {
  if (msg.kind !== 'event') return msg
  const event = redactEventForRenderer(msg.event)
  return event === msg.event ? msg : { ...msg, event }
}

function parseBaseUrl(input: string): URL | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed) return null
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username !== '' || u.password !== '') return null
  if (!u.host) return null
  return u
}

/**
 * Canonical form of a collection/organization URL: trimmed, no trailing slash,
 * no query/fragment, http(s) only, and never carrying credentials (a
 * `user:pass@` URL would put a secret into every log line and share write).
 */
export function normalizeBaseUrl(input: string): string | null {
  const u = parseBaseUrl(input)
  if (!u) return null
  const path = u.pathname.replace(/\/+$/, '')
  return `${u.protocol}//${u.host}${path}`
}

/**
 * Just the `protocol//host` of a base URL — the boundary that matters for a
 * credential. A personal token is entered for one server and must never be
 * sent to another, whatever collection path a later config carries.
 */
export function baseUrlOrigin(input: string): string | null {
  const u = parseBaseUrl(input)
  return u ? `${u.protocol}//${u.host}` : null
}
