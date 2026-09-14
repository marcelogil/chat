import { describe, expect, it } from 'vitest'
import { PROFILE_ENV, USER_DATA_ENV, resolveUserDataDir } from './userData'

// The rule these pin down, in one line: a packaged build must be able to run
// against a scratch profile, and must never *silently* run against the real
// one. SEMAPHORE_PROFILE did the second half of that job and not the first,
// which is how a packaged verification run onboarded over a real identity.

const DEFAULT = '/Users/gil/Library/Application Support/Chat'
const resolveWith = (env: Record<string, string | undefined>, isPackaged: boolean) =>
  resolveUserDataDir({ defaultDir: DEFAULT, env, isPackaged })

describe('resolveUserDataDir', () => {
  it('honours CHAT_USER_DATA_DIR in a packaged build', () => {
    const r = resolveWith({ [USER_DATA_ENV]: '/tmp/chat-verify' }, true)
    expect(r).toEqual({ dir: '/tmp/chat-verify', source: 'override', rejected: null })
  })

  it('honours it in a dev build too, outranking SEMAPHORE_PROFILE', () => {
    const r = resolveWith({ [USER_DATA_ENV]: '/tmp/chat-verify', [PROFILE_ENV]: 'alice' }, false)
    expect(r.dir).toBe('/tmp/chat-verify')
    expect(r.source).toBe('override')
  })

  it('ignores SEMAPHORE_PROFILE in a packaged build — the whole bug', () => {
    const r = resolveWith({ [PROFILE_ENV]: 'verify' }, true)
    expect(r).toEqual({ dir: DEFAULT, source: 'default', rejected: null })
  })

  it('still gives dev instances their own profile dir', () => {
    const r = resolveWith({ [PROFILE_ENV]: 'alice' }, false)
    expect(r).toEqual({ dir: `${DEFAULT}-alice`, source: 'profile', rejected: null })
  })

  it('rejects a relative path instead of falling back in silence', () => {
    const r = resolveWith({ [USER_DATA_ENV]: 'scratch/profile' }, true)
    expect(r.source).toBe('default')
    expect(r.dir).toBe(DEFAULT)
    expect(r.rejected).toMatch(/absolute/)
  })

  it('rejects the default profile itself, however it is spelled', () => {
    for (const spelling of [DEFAULT, `${DEFAULT}/`, `${DEFAULT}/.`, `${DEFAULT}/x/..`, DEFAULT.toUpperCase()]) {
      const r = resolveWith({ [USER_DATA_ENV]: spelling }, true)
      expect(r.source, spelling).toBe('default')
      expect(r.rejected, spelling).toMatch(/default profile/)
    }
  })

  it('a rejected override still reports the dev profile it fell back to', () => {
    const r = resolveWith({ [USER_DATA_ENV]: './nope', [PROFILE_ENV]: 'alice' }, false)
    expect(r.dir).toBe(`${DEFAULT}-alice`)
    expect(r.source).toBe('profile')
    expect(r.rejected).toMatch(/absolute/)
  })

  it('treats empty / whitespace-only as not set', () => {
    expect(resolveWith({ [USER_DATA_ENV]: '' }, true)).toEqual({ dir: DEFAULT, source: 'default', rejected: null })
    expect(resolveWith({ [USER_DATA_ENV]: '   ' }, true)).toEqual({ dir: DEFAULT, source: 'default', rejected: null })
    expect(resolveWith({}, true)).toEqual({ dir: DEFAULT, source: 'default', rejected: null })
  })

  it('normalizes what it returns (trailing slash, dot segments, padding)', () => {
    expect(resolveWith({ [USER_DATA_ENV]: '  /tmp/scratch/  ' }, true).dir).toBe('/tmp/scratch')
    expect(resolveWith({ [USER_DATA_ENV]: '/tmp/scratch/./a/..' }, true).dir).toBe('/tmp/scratch')
  })
})
