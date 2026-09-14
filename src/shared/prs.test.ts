import { describe, expect, it } from 'vitest'
import {
  baseUrlOrigin,
  isApproved,
  isTracked,
  materializePrsConfig,
  normalizeBaseUrl,
  redactEventForRenderer,
  redactPushForRenderer,
  toPrView,
  type AdoPullRequest,
} from './prs'
import type { ConvId, GroupInviteData, GrpPayload, PrView, PrsConfig, PrsPayload, VerifiedEvent } from './types'
import { PRS } from './constants'

type Reviewer = PrView['reviewers'][number]

function rev(vote: number, required = false, id = `r${vote}${required ? 'q' : ''}`): Reviewer {
  return { id, name: `Reviewer ${id}`, vote, required }
}

describe('isApproved', () => {
  it('is false when nobody has voted', () => {
    expect(isApproved([])).toBe(false)
    expect(isApproved([rev(0), rev(0, true)])).toBe(false)
  })

  it('is true for a single +10', () => {
    expect(isApproved([rev(10)])).toBe(true)
  })

  it('is true for approved-with-suggestions (+5)', () => {
    expect(isApproved([rev(5)])).toBe(true)
  })

  it('is false when anyone is blocking, even alongside an approval', () => {
    expect(isApproved([rev(5), rev(-5)])).toBe(false)
    expect(isApproved([rev(10), rev(-10)])).toBe(false)
  })

  it('is false while a required reviewer sits at 0 and another approved', () => {
    expect(isApproved([rev(10, false, 'a'), rev(0, true, 'b')])).toBe(false)
  })

  it('is true when the required reviewer is at 5', () => {
    expect(isApproved([rev(5, true, 'b')])).toBe(true)
    expect(isApproved([rev(10, false, 'a'), rev(5, true, 'b')])).toBe(true)
  })

  it('ignores optional reviewers who have not voted', () => {
    expect(isApproved([rev(10, false, 'a'), rev(0, false, 'c')])).toBe(true)
  })
})

describe('isTracked', () => {
  const open = { isDraft: false, status: 'active', reviewers: [rev(0, true)] }

  it('tracks an open, non-draft, unapproved PR', () => {
    expect(isTracked(open)).toBe(true)
  })

  it('drops drafts and non-active states', () => {
    expect(isTracked({ ...open, isDraft: true })).toBe(false)
    expect(isTracked({ ...open, status: 'completed' })).toBe(false)
    expect(isTracked({ ...open, status: 'abandoned' })).toBe(false)
  })

  it('keeps an approved PR (1.4: "Ready to complete", but never in the badge)', () => {
    expect(isTracked({ ...open, reviewers: [rev(10)] })).toBe(true)
  })
})

function raw(over: Partial<AdoPullRequest> = {}): AdoPullRequest {
  return {
    pullRequestId: 4211,
    title: 'Fix the poller backoff',
    status: 'active',
    isDraft: false,
    createdBy: { id: 'user-1', displayName: 'Ana Ruiz' },
    creationDate: '2026-03-09T10:15:00Z',
    sourceRefName: 'refs/heads/feature/backoff',
    targetRefName: 'refs/heads/main',
    repository: { id: 'repo-1', name: 'Core Service' },
    reviewers: [
      { id: 'user-2', displayName: 'Bo Lin', vote: 0, isRequired: true },
      { id: 'user-3', displayName: 'Cy Park', vote: 10 },
    ],
    ...over,
  }
}

describe('toPrView', () => {
  const ctx = {
    baseUrl: 'https://dev.azure.com/acme',
    project: 'Platform Team',
    meId: 'user-2' as string | null,
    seen: new Set<string>(),
  }

  it('strips refs/heads/ from both branches', () => {
    const v = toPrView(raw(), ctx)
    expect(v.sourceBranch).toBe('feature/backoff')
    expect(v.targetBranch).toBe('main')
  })

  it('percent-encodes project and repo names in the web URL', () => {
    const v = toPrView(raw(), ctx)
    expect(v.webUrl).toBe('https://dev.azure.com/acme/Platform%20Team/_git/Core%20Service/pullrequest/4211')
  })

  it('keys by repo and id and reads seen from the set', () => {
    expect(toPrView(raw(), ctx).key).toBe('repo-1:4211')
    expect(toPrView(raw(), ctx).seen).toBe(false)
    expect(toPrView(raw(), { ...ctx, seen: new Set(['repo-1:4211']) }).seen).toBe(true)
  })

  it('derives assignedToMe and myVote from meId', () => {
    const mine = toPrView(raw(), ctx)
    expect(mine.assignedToMe).toBe(true)
    expect(mine.myVote).toBe(0)

    const other = toPrView(raw(), { ...ctx, meId: 'user-3' })
    expect(other.assignedToMe).toBe(true)
    expect(other.myVote).toBe(10)

    const stranger = toPrView(raw(), { ...ctx, meId: 'user-9' })
    expect(stranger.assignedToMe).toBe(false)
    expect(stranger.myVote).toBe(0)

    const anon = toPrView(raw(), { ...ctx, meId: null })
    expect(anon.assignedToMe).toBe(false)
    expect(anon.myVote).toBe(0)
  })

  it('normalizes reviewers, author and creation time', () => {
    const v = toPrView(raw(), ctx)
    expect(v.reviewers).toEqual([
      { id: 'user-2', name: 'Bo Lin', vote: 0, required: true },
      { id: 'user-3', name: 'Cy Park', vote: 10, required: false },
    ])
    expect(v.author).toEqual({ id: 'user-1', name: 'Ana Ruiz' })
    expect(v.createdAt).toBe(Date.parse('2026-03-09T10:15:00Z'))
    expect(v.repoName).toBe('Core Service')
  })

  it('survives an unparseable creation date', () => {
    expect(toPrView(raw({ creationDate: 'not a date' }), ctx).createdAt).toBe(0)
  })
})

// ---------------------------------------------------------------------------

const CONV = 'team:prs' as const

function config(over: Partial<PrsConfig> = {}): PrsConfig {
  return {
    baseUrl: 'https://dev.azure.com/acme',
    project: 'Platform',
    repos: [{ id: 'repo-1', name: 'Core' }],
    sharedToken: '',
    ...over,
  }
}

let n = 0
function prsEvent(payload: PrsPayload, over: Partial<VerifiedEvent> = {}): VerifiedEvent {
  n += 1
  return {
    id: `17000000000${String(n).padStart(2, '0')}-0001-aaaaaaaa`,
    type: 'prs',
    payload,
    author: 'aaaaaaaabbbbbbbb',
    verified: true,
    receivedAt: 0,
    ...over,
  }
}

describe('materializePrsConfig', () => {
  it('returns null with no events', () => {
    expect(materializePrsConfig([])).toBeNull()
  })

  it('returns null when every event is unverified or malformed', () => {
    const forged = prsEvent({ t: 'prs', conv: CONV, config: config() }, { verified: false })
    const junk = prsEvent({ t: 'prs', conv: CONV, config: { baseUrl: 1 } as unknown as PrsConfig })
    expect(materializePrsConfig([forged, junk])).toBeNull()
  })

  it('takes the last valid snapshot in stem order regardless of array order', () => {
    const first = prsEvent({ t: 'prs', conv: CONV, config: config({ project: 'Old' }) })
    const second = prsEvent(
      { t: 'prs', conv: CONV, config: config({ project: 'New', repos: [{ id: 'r2', name: 'Web' }] }) },
      { author: 'ccccccccdddddddd' },
    )
    const got = materializePrsConfig([second, first])!
    expect(got.config.project).toBe('New')
    expect(got.config.repos).toEqual([{ id: 'r2', name: 'Web' }])
    expect(got.by).toBe('ccccccccdddddddd')
    expect(got.id).toBe(second.id)
  })

  it('skips an unverified newer snapshot in favour of the verified older one', () => {
    const good = prsEvent({ t: 'prs', conv: CONV, config: config({ project: 'Real' }) })
    const forged = prsEvent({ t: 'prs', conv: CONV, config: config({ project: 'Forged' }) }, { verified: false })
    expect(materializePrsConfig([good, forged])!.config.project).toBe('Real')
  })

  it('keeps a disconnect snapshot (empty baseUrl) rather than reverting', () => {
    const on = prsEvent({ t: 'prs', conv: CONV, config: config() })
    const off = prsEvent({ t: 'prs', conv: CONV, config: { baseUrl: '', project: '', repos: [], sharedToken: '' } })
    expect(materializePrsConfig([on, off])!.config.baseUrl).toBe('')
  })

  it('normalizes the base URL off the share instead of trusting it verbatim', () => {
    const ev = prsEvent({ t: 'prs', conv: CONV, config: config({ baseUrl: ' https://dev.azure.com/acme/?x=1 ' }) })
    expect(materializePrsConfig([ev])!.config.baseUrl).toBe('https://dev.azure.com/acme')
  })

  it('carries the team thresholds forward across a snapshot that does not carry them', () => {
    // A 1.3 client cannot see these fields, so re-publishing the config (to
    // rename a repo, say) must not read as "go back to 48 h / 14 d" for the
    // whole team. Only a log where nobody ever set them falls through to the
    // defaults.
    const agreed = prsEvent({
      t: 'prs',
      conv: CONV,
      config: config({ reviewSlaHours: 8, staleAfterDays: 3 }),
    })
    const from13 = prsEvent({ t: 'prs', conv: CONV, config: config({ repos: [{ id: 'repo-1', name: 'Renamed' }] }) })
    expect(materializePrsConfig([agreed])!.config.reviewSlaHours).toBe(8)
    const after = materializePrsConfig([agreed, from13])!.config
    expect(after.repos).toEqual([{ id: 'repo-1', name: 'Renamed' }])
    expect([after.reviewSlaHours, after.staleAfterDays]).toEqual([8, 3])
  })

  it('clamps a threshold off the share to the default rather than dropping the config', () => {
    // The read path is deliberately the opposite of saveConfig's: one strange
    // number in a snapshot must never cost the team its base URL and repos.
    for (const reviewSlaHours of [0, 721, '48', 48.4, undefined]) {
      const ev = prsEvent({
        t: 'prs',
        conv: CONV,
        config: config({ reviewSlaHours } as Partial<PrsConfig>),
      })
      const got = materializePrsConfig([ev])!.config
      expect(got.baseUrl).toBe('https://dev.azure.com/acme')
      expect(got.reviewSlaHours).toBe(PRS.reviewSlaHours)
      expect(got.staleAfterDays).toBe(PRS.staleAfterDays)
    }
  })

  it('keeps a threshold inside the range exactly as published', () => {
    const ev = prsEvent({ t: 'prs', conv: CONV, config: config({ staleAfterDays: 3 }) })
    expect(materializePrsConfig([ev])!.config.staleAfterDays).toBe(3)
  })

  it('drops a snapshot whose base URL is not a usable http(s) address', () => {
    // The config decides where every teammate's token is sent, so a published
    // scheme like javascript:/file:, or a URL carrying credentials, is not a
    // config at all — the previous snapshot stands.
    const good = prsEvent({ t: 'prs', conv: CONV, config: config({ project: 'Real' }) })
    for (const baseUrl of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pw@collector.example', 'nope']) {
      const bad = prsEvent({ t: 'prs', conv: CONV, config: config({ baseUrl, project: 'Bad' }) })
      expect(materializePrsConfig([good, bad])!.config.project).toBe('Real')
      expect(materializePrsConfig([bad])).toBeNull()
    }
  })
})

describe('redactEventForRenderer', () => {
  it('blanks the shared token and leaves the rest of the config alone', () => {
    const ev = prsEvent({ t: 'prs', conv: CONV, config: config({ sharedToken: 'PAT-abcdefghijklmnop' }) })
    const out = redactEventForRenderer(ev)
    const cfg = (out.payload as PrsPayload).config
    expect(cfg.sharedToken).toBe('')
    expect(cfg.baseUrl).toBe('https://dev.azure.com/acme')
    expect(cfg.repos).toEqual([{ id: 'repo-1', name: 'Core' }])
    expect(out.id).toBe(ev.id)
    expect(JSON.stringify(ev)).toContain('PAT-abcdefghijklmnop') // the original is untouched
  })

  it('passes anything without a token through unchanged', () => {
    const empty = prsEvent({ t: 'prs', conv: CONV, config: config() })
    expect(redactEventForRenderer(empty)).toBe(empty)
    const other = { ...empty, type: 'msg', payload: { t: 'msg' } } as unknown as VerifiedEvent
    expect(redactEventForRenderer(other)).toBe(other)
  })
})

describe('redactPushForRenderer', () => {
  it('strips the token from an event push', () => {
    const ev = prsEvent({ t: 'prs', conv: CONV, config: config({ sharedToken: 'PAT-abcdefghijklmnop' }) })
    const out = redactPushForRenderer({ kind: 'event', conv: CONV, event: ev })
    expect(JSON.stringify(out)).not.toContain('PAT-abcdefghijklmnop')
    expect(out.kind === 'event' && (out.event.payload as PrsPayload).config.sharedToken).toBe('')
    expect(out.kind === 'event' && out.conv).toBe(CONV)
  })

  it('returns every other push identically', () => {
    const ev = prsEvent({ t: 'prs', conv: CONV, config: config() })
    const plain = { kind: 'event', conv: CONV, event: ev } as const
    expect(redactPushForRenderer(plain)).toBe(plain)
    const health = { kind: 'outbox', queued: 3 } as const
    expect(redactPushForRenderer(health)).toBe(health)
  })
})

// Private-group key material rides the same bridge (1.2). A `grp` invite or
// rekey carries the group's raw epoch key — the key *is* the group — and `key1`,
// which derives its directory token. The renderer only ever renders the name, so
// neither may be copied into sandboxed web memory.

const GRP_DM: ConvId = 'dm:AAAABBBBCCCCDDDDEEEE'
const KEY = 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYQ=='
const KEY1 = 'MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEx'

function grpEvent(kind: GrpPayload['kind'], data: GrpPayload['data']): VerifiedEvent {
  return {
    id: '1700000000099-0001-aaaaaaaa',
    type: 'grp',
    payload: { t: 'grp', conv: GRP_DM, kind, data },
    author: 'aaaaaaaabbbbbbbb',
    verified: true,
    receivedAt: 0,
  }
}

const invite = (): GroupInviteData => ({
  groupId: '0a1b2c3d',
  name: 'Ops crew',
  owner: 'a'.repeat(32),
  members: ['a'.repeat(32), 'b'.repeat(32)],
  epoch: 2,
  key: KEY,
  key1: KEY1,
  createdAt: 1700000000000,
})

describe('redacting private-group key material', () => {
  it('blanks key and key1 on an invite and leaves the name alone', () => {
    const ev = grpEvent('group-invite', invite())
    const out = redactEventForRenderer(ev)
    const data = (out.payload as GrpPayload).data as GroupInviteData
    expect(data.key).toBe('')
    expect(data.key1).toBe('')
    expect(data.name).toBe('Ops crew')
    expect(data.epoch).toBe(2)
    expect(JSON.stringify(out)).not.toContain(KEY)
    expect(JSON.stringify(out)).not.toContain(KEY1)
    expect(JSON.stringify(ev)).toContain(KEY) // the original is untouched
  })

  it('blanks a rekey the same way, through the push path', () => {
    const ev = grpEvent('group-rekey', invite())
    const out = redactPushForRenderer({ kind: 'event', conv: GRP_DM, event: ev })
    expect(JSON.stringify(out)).not.toContain(KEY)
    expect(JSON.stringify(out)).not.toContain(KEY1)
  })

  it('passes a notice that carries no key material through unchanged', () => {
    const ev = grpEvent('group-removed', { groupId: '0a1b2c3d', epoch: 3, name: 'Ops crew' })
    expect(redactEventForRenderer(ev)).toBe(ev)
  })
})

describe('baseUrlOrigin', () => {
  it('keeps protocol and host and drops the collection path', () => {
    expect(baseUrlOrigin('https://dev.azure.com/acme/')).toBe('https://dev.azure.com')
    expect(baseUrlOrigin('http://tfs.corp:8080/tfs/DefaultCollection')).toBe('http://tfs.corp:8080')
  })

  it('separates hosts, ports and schemes', () => {
    expect(baseUrlOrigin('http://tfs.corp/tfs')).not.toBe(baseUrlOrigin('https://tfs.corp/tfs'))
    expect(baseUrlOrigin('https://tfs.corp:8080/tfs')).not.toBe(baseUrlOrigin('https://tfs.corp/tfs'))
  })

  it('is null for anything normalizeBaseUrl rejects', () => {
    expect(baseUrlOrigin('')).toBeNull()
    expect(baseUrlOrigin('ftp://tfs.corp')).toBeNull()
    expect(baseUrlOrigin('https://user:pw@tfs.corp')).toBeNull()
  })
})

describe('normalizeBaseUrl', () => {
  it('trims whitespace and strips trailing slashes', () => {
    expect(normalizeBaseUrl('  https://dev.azure.com/acme/  ')).toBe('https://dev.azure.com/acme')
    expect(normalizeBaseUrl('https://dev.azure.com/acme///')).toBe('https://dev.azure.com/acme')
    expect(normalizeBaseUrl('https://dev.azure.com/')).toBe('https://dev.azure.com')
  })

  it('accepts http for on-prem collections', () => {
    expect(normalizeBaseUrl('http://tfs.corp/tfs/DefaultCollection')).toBe('http://tfs.corp/tfs/DefaultCollection')
  })

  it('drops query and fragment', () => {
    expect(normalizeBaseUrl('https://dev.azure.com/acme?x=1#y')).toBe('https://dev.azure.com/acme')
  })

  it('rejects non-http(s) schemes', () => {
    expect(normalizeBaseUrl('ftp://tfs.corp/tfs')).toBeNull()
    expect(normalizeBaseUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeBaseUrl('javascript:alert(1)')).toBeNull()
  })

  it('rejects URLs carrying credentials', () => {
    expect(normalizeBaseUrl('https://user:pass@dev.azure.com/acme')).toBeNull()
    expect(normalizeBaseUrl('https://user@dev.azure.com/acme')).toBeNull()
  })

  it('rejects empty and unparseable input', () => {
    expect(normalizeBaseUrl('')).toBeNull()
    expect(normalizeBaseUrl('   ')).toBeNull()
    expect(normalizeBaseUrl('dev.azure.com/acme')).toBeNull()
  })
})
