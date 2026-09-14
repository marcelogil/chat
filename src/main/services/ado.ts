import type { AdoError, AdoErrorCode, AdoResult } from '@shared/types'
import type { AdoIteration, AdoPullRequest, AdoThread } from '@shared/prs'
import { PRS } from '@shared/constants'

// Azure DevOps REST client. Deliberately dependency-free and transport-free:
// every request goes through an injected `FetchLike`, which main binds to
// Electron's proxy-aware `net.fetch` and the unit tests bind to a fake. The
// class itself knows nothing about Electron, so ado.test.ts runs in plain node.
//
// Two rules matter more than the rest:
//   1. `api-version` is NEGOTIATED, not fixed. 6.0 is the opening bid (Azure
//      DevOps Server 2020+ and dev.azure.com both take it), but an older
//      on-prem server answers 400 `VssVersionOutOfRangeException` naming the
//      newest version it does support — TFS 2018 is 4.1, TFS 2017 is 3.2 — and
//      the client retries at that version and remembers it. Every endpoint
//      used here (projects, repositories, pullrequests) exists back to 1.0.
//   2. A rejected PAT does NOT come back as 401. Azure DevOps answers a browser
//      with an HTML sign-in page and status 203 (or a 200 carrying HTML), so a
//      non-JSON body is treated as `unauthorized` rather than a parse bug.
//
// The token is a secret with a long life: it must never reach a log line, a
// renderer payload or an `AdoError.detail`. Everything that becomes a detail
// goes through `redact()` first, belt and braces.

/** The structural subset of `Response` this client reads. */
export interface AdoResponse {
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<AdoResponse>

export interface AdoClientOpts {
  baseUrl: string
  token: string
  userAgent: string
  timeoutMs?: number
  /** Start from a version already negotiated with this server (skips a round trip). */
  apiVersion?: string
}

export interface AdoRepo {
  id: string
  name: string
  defaultBranch: string
}

/**
 * The answer for a resource an older server simply does not have (1.4):
 * threads and iterations arrive in REST 3.0 (TFS 2017), and a 2.0/1.0 server
 * is not broken, it is just old. `unsupported` is its own arm so the pane can
 * say "comment status is unavailable here" instead of painting an error strip
 * the team can do nothing about.
 */
export type AdoDetail<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'unsupported' }
  | { ok: false; reason: 'error'; error: AdoError }

/** "4.1" ≥ "3.0" — numeric per component, never a string compare ("10.0" < "3.0"). */
export function apiAtLeast(version: string, min: string): boolean {
  const a = String(version).split('.')
  const b = String(min).split('.')
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = Number.parseInt(a[i] ?? '0', 10) || 0
    const y = Number.parseInt(b[i] ?? '0', 10) || 0
    if (x !== y) return x > y
  }
  return true
}

const DEFAULT_TIMEOUT_MS = 15_000
/** Paging guard: 500 projects a page is already far past any real collection. */
const MAX_PAGES = 20
const MAX_DETAIL = 200

/**
 * Opening bid, then the fallbacks, newest first. A server that rejects one
 * names the version it wants, so the ladder is only the safety net for a
 * server whose refusal we can't parse. `connectionData` is a preview resource
 * at every version — hence the `-preview` suffix, which Azure DevOps reads as
 * "latest preview of that version".
 */
const API_LADDER = ['6.0', '5.0', '4.1', '3.2', '3.0', '2.0', '1.0'] as const
const API_DEFAULT = API_LADDER[0]

// ---------------------------------------------------------------------------
// Token hygiene

/**
 * Replaces the token (raw, base64-of-`:token` as it appears in the auth header,
 * and percent-encoded) with `***` anywhere it shows up. Short tokens are left
 * alone — a 3-character needle would shred unrelated text — but a real PAT is
 * 52 characters.
 */
function makeRedactor(token: string): (s: string) => string {
  const needles = new Set<string>()
  const add = (s: string): void => {
    if (s.length >= 8) needles.add(s)
  }
  if (typeof token === 'string' && token) {
    add(token)
    add(Buffer.from(`:${token}`, 'utf8').toString('base64'))
    add(Buffer.from(token, 'utf8').toString('base64'))
    add(encodeURIComponent(token))
  }
  return (s: string): string => {
    let out = s
    for (const n of needles) out = out.split(n).join('***')
    return out
  }
}

function tidy(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL - 1)}…` : flat
}

// ---------------------------------------------------------------------------
// Failure classification

/** Chromium surfaces network trouble as `ERR_*` inside the thrown message. */
function classifyThrown(err: unknown): AdoErrorCode {
  const name = typeof err === 'object' && err !== null ? String((err as { name?: unknown }).name ?? '') : ''
  const msg = err instanceof Error ? err.message : String(err)
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout'
  if (/ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|\baborted\b/i.test(msg)) return 'timeout'
  if (/ERR_CERT|ERR_SSL|ERR_BAD_SSL|CERT_|self[- ]signed certificate|UNABLE_TO_VERIFY/i.test(msg)) return 'tls'
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return 'dns'
  if (/ERR_PROXY_AUTH_REQUESTED/i.test(msg)) return 'proxy-auth'
  return 'network'
}

/**
 * Azure DevOps reports failures as `{ message, typeKey, … }`. The message is
 * the sentence a human needs ("…the latest REST API version this server
 * supports is 4.1"); the raw body around it is noise that crowds out the
 * 200-character detail budget.
 */
function adoFault(text: string): { message: string; typeKey: string } | null {
  try {
    const body = JSON.parse(text) as { message?: unknown; typeKey?: unknown }
    if (!body || typeof body !== 'object' || typeof body.message !== 'string') return null
    return { message: body.message, typeKey: typeof body.typeKey === 'string' ? body.typeKey : '' }
  } catch {
    return null
  }
}

/**
 * `null` when the failure is not about the API version; otherwise the version
 * the server asked for, or `''` when it refused without naming one.
 */
function versionRefusal(status: number, text: string): string | null {
  if (status !== 400) return null
  const fault = adoFault(text)
  if (!fault) return null
  const isRange = fault.typeKey === 'VssVersionOutOfRangeException' || /out of range for this server/i.test(fault.message)
  if (!isRange) return null
  return /version this server supports is\s+([0-9]+(?:\.[0-9]+)?)/i.exec(fault.message)?.[1] ?? ''
}

/** The next rung strictly below `current` that hasn't been tried yet. */
function lowerVersion(current: string, tried: ReadonlySet<string>): string | null {
  const at = API_LADDER.indexOf(current as (typeof API_LADDER)[number])
  const from = at === -1 ? 0 : at + 1
  for (let i = from; i < API_LADDER.length; i++) {
    if (!tried.has(API_LADDER[i])) return API_LADDER[i]
  }
  return null
}

const SENTENCE: Record<AdoErrorCode, string> = {
  unauthorized: 'Azure DevOps rejected the token',
  forbidden: 'The token does not have access to this resource',
  'not-found': 'Azure DevOps returned 404 for this address',
  'proxy-auth': 'The proxy wants credentials',
  tls: "The server's certificate isn't trusted by this machine",
  dns: 'The server name could not be resolved',
  network: 'Could not reach the server',
  timeout: 'The request timed out',
  http: 'Azure DevOps returned an unexpected status',
  'bad-url': 'That is not a usable Azure DevOps collection URL',
  'api-version': 'This Azure DevOps server is older than any API version Chat can speak',
}

// ---------------------------------------------------------------------------

interface Page {
  body: unknown
  continuation: string | null
}

export class AdoClient {
  private readonly base: string
  private readonly timeoutMs: number
  private readonly redact: (s: string) => string
  private version: string

  constructor(
    private fetchImpl: FetchLike,
    private opts: AdoClientOpts,
  ) {
    this.base = String(opts.baseUrl ?? '')
      .trim()
      .replace(/\/+$/, '')
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.redact = makeRedactor(opts.token)
    this.version = opts.apiVersion || API_DEFAULT
  }

  /** The version this server accepted — worth carrying into the next client. */
  get apiVersion(): string {
    return this.version
  }

  // -------------------------------------------------------------------------
  // Endpoints

  /** `authenticatedUser` from connectionData — the cheapest "is this PAT good" probe. */
  async me(): Promise<AdoResult<{ id: string; name: string }>> {
    const page = await this.get('/_apis/connectionData', {}, { preview: true })
    if (!page.ok) return page
    const user = (
      page.value.body as {
        authenticatedUser?: { id?: unknown; providerDisplayName?: unknown; descriptor?: unknown }
      } | null
    )?.authenticatedUser
    // An anonymous answer is a rejected PAT wearing a 200: no id, the all-zero
    // guid, or — on an organization with public projects — the all-`a` guid
    // with a `System:PublicAccess;…` descriptor (verified against
    // dev.azure.com/dnceng-public without any credentials).
    const id = typeof user?.id === 'string' ? user.id : ''
    const descriptor = typeof user?.descriptor === 'string' ? user.descriptor : ''
    if (!id || /^[0a]{8}-[0a]{4}-[0a]{4}-[0a]{4}-[0a]{12}$/.test(id) || descriptor.startsWith('System:PublicAccess')) {
      return this.fail('unauthorized', 'Azure DevOps answered without an authenticated user')
    }
    return { ok: true, value: { id, name: typeof user?.providerDisplayName === 'string' ? user.providerDisplayName : id } }
  }

  async projects(): Promise<AdoResult<{ id: string; name: string }[]>> {
    const out: { id: string; name: string }[] = []
    let continuation: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const params: Record<string, string> = { $top: '500' }
      if (continuation) params.continuationToken = continuation
      const res: AdoResult<Page> = await this.get('/_apis/projects', params)
      if (!res.ok) return res
      for (const p of listOf(res.value.body)) {
        const id = str(p.id)
        const name = str(p.name)
        if (id && name) out.push({ id, name })
      }
      continuation = res.value.continuation
      if (!continuation) break
    }
    return { ok: true, value: out }
  }

  async repos(project: string): Promise<AdoResult<AdoRepo[]>> {
    const res = await this.get(`/${encodeURIComponent(project)}/_apis/git/repositories`, {})
    if (!res.ok) return res
    const out: AdoRepo[] = []
    for (const r of listOf(res.value.body)) {
      const id = str(r.id)
      const name = str(r.name)
      if (!id || !name) continue
      out.push({ id, name, defaultBranch: stripRef(str(r.defaultBranch)) })
    }
    return { ok: true, value: out }
  }

  async activePullRequests(project: string, repoId: string): Promise<AdoResult<AdoPullRequest[]>> {
    const res = await this.get(
      `/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repoId)}/pullrequests`,
      { 'searchCriteria.status': 'active', $top: '200' },
    )
    if (!res.ok) return res
    const out: AdoPullRequest[] = []
    for (const raw of listOf(res.value.body)) {
      if (typeof raw.pullRequestId !== 'number') continue
      out.push(raw as unknown as AdoPullRequest)
    }
    return { ok: true, value: out }
  }

  /**
   * True while the negotiated version still has threads/iterations. Checked
   * before the request (no point spending a round trip to be told 400) and
   * again after a failure, because the ladder can step *below* 3.0 while a
   * call is in flight — that refusal is a fact about the server, not an error.
   */
  private hasDetails(): boolean {
    return apiAtLeast(this.version, PRS.minApiForThreads)
  }

  /** Comment threads of one pull request (1.4). */
  async threads(project: string, repoId: string, prId: number): Promise<AdoDetail<AdoThread[]>> {
    return this.detail(
      `/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repoId)}/pullRequests/${encodeURIComponent(String(prId))}/threads`,
      (raw) => (typeof raw.id === 'number' ? (raw as unknown as AdoThread) : null),
    )
  }

  /** Pushed revisions of one pull request; the newest is the last push (1.4). */
  async iterations(project: string, repoId: string, prId: number): Promise<AdoDetail<AdoIteration[]>> {
    return this.detail(
      `/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repoId)}/pullRequests/${encodeURIComponent(String(prId))}/iterations`,
      (raw) => (typeof raw.id === 'number' ? (raw as unknown as AdoIteration) : null),
    )
  }

  private async detail<T>(path: string, pick: (raw: Record<string, unknown>) => T | null): Promise<AdoDetail<T[]>> {
    if (!this.hasDetails()) return { ok: false, reason: 'unsupported' }
    const res = await this.get(path, {})
    if (!res.ok) {
      if (!this.hasDetails()) return { ok: false, reason: 'unsupported' }
      return { ok: false, reason: 'error', error: res.error }
    }
    const out: T[] = []
    for (const raw of listOf(res.value.body)) {
      const v = pick(raw)
      if (v !== null) out.push(v)
    }
    return { ok: true, value: out }
  }

  // -------------------------------------------------------------------------
  // Transport

  private fail(code: AdoErrorCode, detail: string): { ok: false; error: AdoError } {
    return { ok: false, error: { code, detail: tidy(this.redact(detail)) } }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(`:${this.opts.token}`, 'utf8').toString('base64')}`,
      Accept: 'application/json',
      'User-Agent': this.opts.userAgent,
    }
  }

  private url(path: string, params: Record<string, string>): string {
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&')
    return `${this.base}${path}${qs ? `?${qs}` : ''}`
  }

  /**
   * One request, retried down the version ladder while the server keeps
   * saying "that API version is too new for me". The negotiated version
   * sticks, so a poll costs one extra round trip per process at worst.
   */
  private async get(
    path: string,
    params: Record<string, string>,
    opts?: { preview?: boolean },
  ): Promise<AdoResult<Page>> {
    if (!/^https?:\/\/[^/]+/i.test(this.base)) {
      return this.fail('bad-url', `${SENTENCE['bad-url']}: ${this.base || '(empty)'}`)
    }

    const tried = new Set<string>()
    for (;;) {
      tried.add(this.version)
      this.refusal = null
      const version = opts?.preview ? `${this.version}-preview` : this.version
      const result = await this.once(path, { ...params, 'api-version': version })
      const refusal = this.refusal
      if (refusal === null) return result

      // The server named a version, or we step down a rung. Either way, never
      // re-try one we've already burned — that is how this loop terminates.
      const next = refusal && !tried.has(refusal) ? refusal : lowerVersion(this.version, tried)
      if (!next) return this.fail('api-version', `${SENTENCE['api-version']} (tried ${[...tried].join(', ')})`)
      this.version = next
    }
  }

  /** Set by `once` when the server rejected the api-version; `''` = unnamed. */
  private refusal: string | null = null

  private async once(path: string, params: Record<string, string>): Promise<AdoResult<Page>> {
    let res: AdoResponse
    try {
      res = await this.fetchImpl(this.url(path, params), {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (err) {
      const code = classifyThrown(err)
      return this.fail(code, `${SENTENCE[code]} (${err instanceof Error ? err.message : String(err)})`)
    }

    let text: string
    try {
      text = await res.text()
    } catch (err) {
      const code = classifyThrown(err)
      return this.fail(code, `${SENTENCE[code]} while reading the response`)
    }

    switch (res.status) {
      case 401:
        return this.fail('unauthorized', SENTENCE.unauthorized)
      case 403:
        return this.fail('forbidden', SENTENCE.forbidden)
      case 404:
        return this.fail('not-found', `${SENTENCE['not-found']}: ${path}`)
      case 407:
        return this.fail('proxy-auth', SENTENCE['proxy-auth'])
      case 203:
        // The sign-in page. This is what a bad or expired PAT actually looks like.
        return this.fail('unauthorized', `${SENTENCE.unauthorized} (sign-in page returned)`)
      default:
        break
    }
    if (res.status >= 300 && res.status < 400) {
      // A redirect the transport did not follow. Azure DevOps sends unauthenticated
      // API calls to `…vssps.visualstudio.com/_signin` (curl sees this where a
      // browser-shaped client sees 203) — that is a rejected token, not a
      // mystery status.
      const location = res.headers.get('location') ?? ''
      if (/_signin|login\.microsoftonline\.com/i.test(location)) {
        return this.fail('unauthorized', `${SENTENCE.unauthorized} (redirected to sign in)`)
      }
      return this.fail('http', `${SENTENCE.http}: HTTP ${res.status} redirect to ${location || '(no location)'}`)
    }
    if (res.status < 200 || res.status >= 300) {
      const refused = versionRefusal(res.status, text)
      if (refused !== null) {
        // Not a failure yet — `get` retries at a version this server admits to.
        this.refusal = refused
        return this.fail('api-version', adoFault(text)?.message ?? SENTENCE['api-version'])
      }
      // Prefer Azure DevOps's own sentence; a raw body is mostly boilerplate.
      const said = adoFault(text)?.message ?? text
      return this.fail('http', `${SENTENCE.http}: HTTP ${res.status} ${said.slice(0, MAX_DETAIL)}`)
    }

    let body: unknown
    try {
      body = JSON.parse(text) as unknown
    } catch {
      // 200 + HTML: same sign-in page, different status.
      return this.fail('unauthorized', `${SENTENCE.unauthorized} (the server answered with a page, not JSON)`)
    }
    if (body === null || typeof body !== 'object') {
      return this.fail('unauthorized', `${SENTENCE.unauthorized} (the server answered with a page, not JSON)`)
    }

    return {
      ok: true,
      value: { body, continuation: res.headers.get('x-ms-continuationtoken') || null },
    }
  }
}

// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function stripRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

/** `{ count, value: [...] }` is the shape of every ADO list response. */
function listOf(body: unknown): Record<string, unknown>[] {
  const v = (body as { value?: unknown } | null)?.value
  if (!Array.isArray(v)) return []
  return v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
}
