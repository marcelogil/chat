import { describe, expect, it } from 'vitest'
import { AdoClient, apiAtLeast, type AdoResponse, type FetchLike } from './ado'

// The whole point of the injectable FetchLike: the mapping table in §2.3 is
// testable without a network, an Electron runtime, or an Azure DevOps server.
// The token used everywhere below is long enough to be redactable and is
// asserted absent from every error detail.

const TOKEN = 'pat-abcdefghijklmnopqrstuvwxyz0123456789-SECRET'
const BASE = 'https://dev.azure.com/acme'

interface Call {
  url: string
  headers: Record<string, string>
}

function res(init: {
  status?: number
  body?: string
  headers?: Record<string, string>
}): AdoResponse {
  const h = init.headers ?? {}
  return {
    status: init.status ?? 200,
    headers: { get: (n: string) => h[n.toLowerCase()] ?? null },
    text: async () => init.body ?? '',
  }
}

function json(value: unknown, extra?: { status?: number; headers?: Record<string, string> }): AdoResponse {
  return res({ status: extra?.status ?? 200, body: JSON.stringify(value), headers: extra?.headers })
}

/** A fake fetch that replays a queue of responses (or one repeated response). */
function fake(
  reply: AdoResponse | ((call: Call, n: number) => AdoResponse | Promise<AdoResponse>),
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const call = { url, headers: init.headers }
    calls.push(call)
    return typeof reply === 'function' ? reply(call, calls.length - 1) : reply
  }
  return { fetchImpl, calls }
}

function client(fetchImpl: FetchLike, baseUrl = BASE): AdoClient {
  return new AdoClient(fetchImpl, { baseUrl, token: TOKEN, userAgent: 'Chat/1.0.1' })
}

const ME = { authenticatedUser: { id: 'u-1', providerDisplayName: 'Ada Lovelace' } }

describe('AdoClient — request shape', () => {
  it('sends Basic auth built from ":" + token, Accept and User-Agent', async () => {
    const f = fake(json(ME))
    await client(f.fetchImpl).me()
    const h = f.calls[0].headers
    expect(h.Authorization).toBe(`Basic ${Buffer.from(`:${TOKEN}`, 'utf8').toString('base64')}`)
    expect(h.Accept).toBe('application/json')
    expect(h['User-Agent']).toBe('Chat/1.0.1')
  })

  it('uses api-version 6.0-preview for connectionData and 6.0 elsewhere', async () => {
    const f = fake(json(ME))
    await client(f.fetchImpl).me()
    expect(f.calls[0].url).toBe(`${BASE}/_apis/connectionData?api-version=${encodeURIComponent('6.0-preview')}`)

    const g = fake(json({ value: [] }))
    await client(g.fetchImpl).repos('My Project')
    expect(g.calls[0].url).toBe(`${BASE}/My%20Project/_apis/git/repositories?api-version=6.0`)
  })

  it('builds the active-pull-requests URL with the search criteria and $top', async () => {
    const f = fake(json({ value: [] }))
    await client(f.fetchImpl).activePullRequests('Proj', 'repo-id-1')
    expect(f.calls[0].url).toBe(
      `${BASE}/Proj/_apis/git/repositories/repo-id-1/pullrequests` +
        '?searchCriteria.status=active&$top=200&api-version=6.0',
    )
  })

  it('strips a trailing slash from the base URL', async () => {
    const f = fake(json(ME))
    await client(f.fetchImpl, `${BASE}///`).me()
    expect(f.calls[0].url.startsWith(`${BASE}/_apis/`)).toBe(true)
  })
})

describe('AdoClient — success parsing', () => {
  it('me() reads authenticatedUser.{id,providerDisplayName}', async () => {
    const f = fake(json(ME))
    const r = await client(f.fetchImpl).me()
    expect(r).toEqual({ ok: true, value: { id: 'u-1', name: 'Ada Lovelace' } })
  })

  it('me() treats the anonymous guid as a rejected token', async () => {
    const f = fake(json({ authenticatedUser: { id: '00000000-0000-0000-0000-000000000000' } }))
    const r = await client(f.fetchImpl).me()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('unauthorized')
  })

  it('me() treats the public-access user of an org with public projects as a rejected token', async () => {
    // Exactly what dev.azure.com/dnceng-public answers with no credentials at all.
    const f = fake(
      json({
        authenticatedUser: {
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          descriptor: 'System:PublicAccess;aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          providerDisplayName: 'Anonymous',
        },
      }),
    )
    const r = await client(f.fetchImpl).me()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('unauthorized')
  })

  it('repos() strips refs/heads/ from defaultBranch and drops nameless entries', async () => {
    const f = fake(
      json({
        value: [
          { id: 'r1', name: 'api', defaultBranch: 'refs/heads/main' },
          { id: 'r2', name: 'web' },
          { id: 'r3' },
        ],
      }),
    )
    const r = await client(f.fetchImpl).repos('Proj')
    expect(r).toEqual({
      ok: true,
      value: [
        { id: 'r1', name: 'api', defaultBranch: 'main' },
        { id: 'r2', name: 'web', defaultBranch: '' },
      ],
    })
  })

  it('activePullRequests() keeps only entries with a numeric pullRequestId', async () => {
    const f = fake(json({ value: [{ pullRequestId: 7, title: 'Fix' }, { title: 'junk' }] }))
    const r = await client(f.fetchImpl).activePullRequests('Proj', 'r1')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.map((p) => p.pullRequestId)).toEqual([7])
  })
})

describe('AdoClient — continuation-token paging', () => {
  it('follows x-ms-continuationtoken until it stops coming', async () => {
    const f = fake((_call, n) => {
      if (n === 0) return json({ value: [{ id: 'p1', name: 'One' }] }, { headers: { 'x-ms-continuationtoken': 'ct-2' } })
      if (n === 1) return json({ value: [{ id: 'p2', name: 'Two' }] }, { headers: { 'x-ms-continuationtoken': 'ct-3' } })
      return json({ value: [{ id: 'p3', name: 'Three' }] })
    })
    const r = await client(f.fetchImpl).projects()
    expect(r).toEqual({
      ok: true,
      value: [
        { id: 'p1', name: 'One' },
        { id: 'p2', name: 'Two' },
        { id: 'p3', name: 'Three' },
      ],
    })
    expect(f.calls).toHaveLength(3)
    expect(f.calls[0].url).not.toContain('continuationToken')
    expect(f.calls[1].url).toContain('continuationToken=ct-2')
    expect(f.calls[2].url).toContain('continuationToken=ct-3')
  })

  it('stops at the page cap instead of looping forever on a stuck token', async () => {
    const f = fake(json({ value: [{ id: 'p', name: 'P' }] }, { headers: { 'x-ms-continuationtoken': 'same' } }))
    const r = await client(f.fetchImpl).projects()
    expect(r.ok).toBe(true)
    expect(f.calls).toHaveLength(20)
  })

  it('propagates a mid-paging failure', async () => {
    const f = fake((_c, n) =>
      n === 0 ? json({ value: [{ id: 'p1', name: 'One' }] }, { headers: { 'x-ms-continuationtoken': 'ct' } }) : res({ status: 401 }),
    )
    const r = await client(f.fetchImpl).projects()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('unauthorized')
  })
})

/** Exactly what an on-prem server sends when it is older than the asked-for API. */
function outOfRange(latest: string | null): AdoResponse {
  return json(
    {
      $id: '1',
      innerException: null,
      message: latest
        ? `The requested REST API version of 6.0 is out of range for this server. The latest REST API version this server supports is ${latest}.`
        : 'The requested REST API version of 6.0 is out of range for this server.',
      typeKey: 'VssVersionOutOfRangeException',
      errorCode: 0,
    },
    { status: 400 },
  )
}

const versionOf = (url: string): string => new URL(url).searchParams.get('api-version') ?? ''

describe('AdoClient — api-version negotiation', () => {
  it('retries at the version the server names, and remembers it', async () => {
    // TFS 2018: tops out at 4.1. The retry must land, and the next call must
    // not repeat the discovery.
    const f = fake((call, n) => (versionOf(call.url).startsWith('6.0') ? outOfRange('4.1') : json(n === 1 ? ME : { value: [] })))
    const c = client(f.fetchImpl)
    const me = await c.me()
    expect(me.ok).toBe(true)
    expect(f.calls.map((x) => versionOf(x.url))).toEqual(['6.0-preview', '4.1-preview'])
    expect(c.apiVersion).toBe('4.1')

    await c.projects()
    expect(versionOf(f.calls[2].url)).toBe('4.1')
  })

  it('starts from a version handed in, skipping the discovery round trip', async () => {
    const f = fake(json(ME))
    const c = new AdoClient(f.fetchImpl, { baseUrl: BASE, token: TOKEN, userAgent: 'ua', apiVersion: '4.1' })
    await c.me()
    expect(f.calls).toHaveLength(1)
    expect(versionOf(f.calls[0].url)).toBe('4.1-preview')
  })

  it('walks down the ladder when the server refuses without naming a version', async () => {
    const f = fake((call) => (versionOf(call.url).startsWith('3.2') ? json(ME) : outOfRange(null)))
    const c = client(f.fetchImpl)
    expect((await c.me()).ok).toBe(true)
    expect(f.calls.map((x) => versionOf(x.url))).toEqual(['6.0-preview', '5.0-preview', '4.1-preview', '3.2-preview'])
  })

  it('gives up with an api-version error once the ladder is exhausted', async () => {
    const f = fake(outOfRange(null))
    const r = await client(f.fetchImpl).me()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('api-version')
      expect(r.error.detail).toContain('6.0')
    }
    // The ladder is finite: no endless retry loop against a hostile server.
    expect(f.calls.length).toBeLessThanOrEqual(8)
  })

  it('never re-offers a version the server already refused', async () => {
    // A server that answers "the latest is 6.0" to a 6.0 request is lying or
    // broken; taking it at its word would loop forever.
    const f = fake(outOfRange('6.0'))
    const r = await client(f.fetchImpl).me()
    expect(r.ok).toBe(false)
    const offered = f.calls.map((x) => versionOf(x.url))
    expect(new Set(offered).size).toBe(offered.length)
  })
})

describe('AdoClient — threads and iterations (1.4)', () => {
  const THREADS = {
    value: [
      {
        id: 11,
        status: 'active',
        publishedDate: '2026-09-01T02:00:00Z',
        comments: [{ id: 1, author: { id: 'u-2', displayName: 'Bo' }, publishedDate: '2026-09-01T02:00:00Z' }],
      },
      { id: 12, status: 'fixed', comments: [] },
      { notAThread: true },
    ],
  }

  it('builds the threads URL under pullRequests/{id} and keeps only numeric ids', async () => {
    const f = fake(json(THREADS))
    const r = await client(f.fetchImpl).threads('My Project', 'repo 1', 4271)
    expect(f.calls[0].url).toBe(
      `${BASE}/My%20Project/_apis/git/repositories/repo%201/pullRequests/4271/threads?api-version=6.0`,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.map((t) => t.id)).toEqual([11, 12])
  })

  it('builds the iterations URL the same way', async () => {
    const f = fake(json({ value: [{ id: 1, createdDate: '2026-09-01T00:00:00Z' }, { id: 2 }] }))
    const r = await client(f.fetchImpl).iterations('Proj', 'r1', 9)
    expect(f.calls[0].url).toBe(`${BASE}/Proj/_apis/git/repositories/r1/pullRequests/9/iterations?api-version=6.0`)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.map((i) => i.id)).toEqual([1, 2])
  })

  it('returns "unsupported" without spending a request below API 3.0', async () => {
    const f = fake(json(THREADS))
    const c = new AdoClient(f.fetchImpl, { baseUrl: BASE, token: TOKEN, userAgent: 'ua', apiVersion: '2.0' })
    const t = await c.threads('Proj', 'r1', 1)
    const i = await c.iterations('Proj', 'r1', 1)
    expect(t.ok).toBe(false)
    expect(i.ok).toBe(false)
    if (!t.ok) expect(t.reason).toBe('unsupported')
    if (!i.ok) expect(i.reason).toBe('unsupported')
    expect(f.calls).toEqual([])
  })

  it('3.0 itself is supported — that is the version the endpoints arrived in', async () => {
    const f = fake(json(THREADS))
    const c = new AdoClient(f.fetchImpl, { baseUrl: BASE, token: TOKEN, userAgent: 'ua', apiVersion: '3.0' })
    expect((await c.threads('Proj', 'r1', 1)).ok).toBe(true)
    expect(versionOf(f.calls[0].url)).toBe('3.0')
  })

  it('a mid-flight negotiation down to 2.0 reads as unsupported, not as an error', async () => {
    // The server refuses 3.2 and names 2.0; the retry at 2.0 404s the resource.
    const f = fake((call) => (versionOf(call.url) === '3.2' ? outOfRange('2.0') : res({ status: 404, body: '{}' })))
    const c = new AdoClient(f.fetchImpl, { baseUrl: BASE, token: TOKEN, userAgent: 'ua', apiVersion: '3.2' })
    const r = await c.threads('Proj', 'r1', 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('unsupported')
    expect(c.apiVersion).toBe('2.0')
  })

  it('a real failure at a supported version is still an error, with the token redacted', async () => {
    const f = fake(res({ status: 403, body: JSON.stringify({ message: `denied for ${TOKEN}` }) }))
    const r = await client(f.fetchImpl).threads('Proj', 'r1', 1)
    expect(r.ok).toBe(false)
    if (!r.ok && r.reason === 'error') {
      expect(r.error.code).toBe('forbidden')
      expect(r.error.detail).not.toContain(TOKEN)
    } else {
      throw new Error('expected an error result')
    }
  })

  it('apiAtLeast compares numerically, not as text', () => {
    expect(apiAtLeast('3.0', '3.0')).toBe(true)
    expect(apiAtLeast('4.1', '3.0')).toBe(true)
    expect(apiAtLeast('10.0', '3.0')).toBe(true)
    expect(apiAtLeast('2.0', '3.0')).toBe(false)
    expect(apiAtLeast('1.0', '3.0')).toBe(false)
    expect(apiAtLeast('3', '3.0')).toBe(true)
  })
})

describe('AdoClient — status and body mapping', () => {
  it('203 with an HTML sign-in page → unauthorized', async () => {
    const f = fake(res({ status: 203, body: '<!DOCTYPE html><html><body>Sign In</body></html>' }))
    const r = await client(f.fetchImpl).me()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('unauthorized')
  })

  it('an unfollowed 302 to the sign-in page → unauthorized', async () => {
    const f = fake(
      res({
        status: 302,
        body: '<html><head><title>Object moved</title></head></html>',
        headers: { location: 'https://spsprodcus4.vssps.visualstudio.com/_signin?realm=dev.azure.com&reply_to=x' },
      }),
    )
    const r = await client(f.fetchImpl).me()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('unauthorized')
  })

  it('quotes Azure DevOps’s own sentence rather than the raw JSON envelope', async () => {
    const f = fake(
      json({ $id: '1', innerException: null, message: 'TF400813: The user is not authorized.', typeKey: 'X' }, { status: 400 }),
    )
    const r = await client(f.fetchImpl).me()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.detail).toContain('TF400813: The user is not authorized.')
      expect(r.error.detail).not.toContain('innerException')
    }
  })

  it('an unfollowed redirect elsewhere → http, naming the target', async () => {
    const f = fake(res({ status: 307, headers: { location: 'https://proxy.corp/blocked' } }))
    const r = await client(f.fetchImpl).me()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('http')
      expect(r.error.detail).toContain('HTTP 307')
      expect(r.error.detail).toContain('https://proxy.corp/blocked')
    }
  })

  it('200 with a non-JSON body → unauthorized', async () => {
    const f = fake(res({ status: 200, body: '<html>Azure DevOps Services | Sign In</html>' }))
    const r = await client(f.fetchImpl).me()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('unauthorized')
  })

  it('200 with valid JSON that is not an object → unauthorized', async () => {
    const f = fake(res({ status: 200, body: '"nope"' }))
    const r = await client(f.fetchImpl).me()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('unauthorized')
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [407, 'proxy-auth'],
  ] as const)('%i → %s', async (status, code) => {
    const f = fake(res({ status }))
    const r = await client(f.fetchImpl).repos('Proj')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(code)
  })

  it.each([[400], [409], [500], [502]] as const)('%i → http', async (status) => {
    const f = fake(res({ status, body: 'boom' }))
    const r = await client(f.fetchImpl).repos('Proj')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('http')
      expect(r.error.detail).toContain(`HTTP ${status}`)
    }
  })
})

describe('AdoClient — thrown-error mapping', () => {
  async function codeFor(err: unknown): Promise<string> {
    const f = fake(() => Promise.reject(err))
    const r = await client(f.fetchImpl).me()
    return r.ok ? 'ok' : r.error.code
  }

  it('an abort → timeout', async () => {
    const abort = new Error('The user aborted a request.')
    abort.name = 'AbortError'
    expect(await codeFor(abort)).toBe('timeout')
  })

  it('AbortSignal.timeout style TimeoutError → timeout', async () => {
    const to = new Error('signal timed out')
    to.name = 'TimeoutError'
    expect(await codeFor(to)).toBe('timeout')
  })

  it('ERR_CERT_AUTHORITY_INVALID → tls', async () => {
    expect(await codeFor(new Error('net::ERR_CERT_AUTHORITY_INVALID'))).toBe('tls')
  })

  it('ERR_NAME_NOT_RESOLVED → dns', async () => {
    expect(await codeFor(new Error('net::ERR_NAME_NOT_RESOLVED'))).toBe('dns')
  })

  it('ERR_PROXY_AUTH_REQUESTED → proxy-auth', async () => {
    expect(await codeFor(new Error('net::ERR_PROXY_AUTH_REQUESTED'))).toBe('proxy-auth')
  })

  it('any other ERR_* or TypeError → network', async () => {
    expect(await codeFor(new Error('net::ERR_CONNECTION_REFUSED'))).toBe('network')
    expect(await codeFor(new TypeError('Failed to fetch'))).toBe('network')
  })

  it('a throwing body reader is mapped too', async () => {
    const f = fake({
      status: 200,
      headers: { get: () => null },
      text: () => Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED')),
    })
    const r = await client(f.fetchImpl).me()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('dns')
  })
})

describe('AdoClient — bad URLs', () => {
  it.each(['', '   ', 'dev.azure.com/acme', 'ftp://dev.azure.com/acme'])('%j → bad-url without a request', async (base) => {
    const f = fake(json(ME))
    const r = await client(f.fetchImpl, base).me()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('bad-url')
    expect(f.calls).toHaveLength(0)
  })
})

describe('AdoClient — the token never leaks', () => {
  const leaky = [
    res({ status: 500, body: `sign-in failed for token ${TOKEN} at /_apis` }),
    res({ status: 203, body: `<html>${TOKEN}</html>` }),
    res({ status: 200, body: `<html>${Buffer.from(`:${TOKEN}`, 'utf8').toString('base64')}</html>` }),
  ]

  it('is absent from every error detail, even when the server echoes it', async () => {
    for (const reply of leaky) {
      const f = fake(reply)
      const r = await client(f.fetchImpl).me()
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error.detail).not.toContain(TOKEN)
        expect(r.error.detail).not.toContain(Buffer.from(`:${TOKEN}`, 'utf8').toString('base64'))
      }
    }
  })

  it('is absent when a thrown error message carries it (a URL-embedded PAT)', async () => {
    const f = fake(() => Promise.reject(new Error(`net::ERR_CONNECTION_REFUSED https://:${TOKEN}@host/`)))
    const r = await client(f.fetchImpl).me()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.detail).not.toContain(TOKEN)
      expect(r.error.detail).toContain('***')
    }
  })

  it('keeps every detail short and single-line', async () => {
    const f = fake(res({ status: 500, body: `${'x'.repeat(4000)}\n\nmore` }))
    const r = await client(f.fetchImpl).me()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.detail.length).toBeLessThanOrEqual(200)
      expect(r.error.detail).not.toContain('\n')
    }
  })
})
