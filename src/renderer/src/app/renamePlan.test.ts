import { describe, expect, it } from 'vitest'
import { CHANNEL_NAME_MAX } from '@shared/channelName'
import { FIXED_CHANNEL_REFUSAL, GROUP_NAME_MAX, convNameMax, normalizeConvName, planRename } from './renamePlan'

// The rename decision behind the sidebar row menus and, since 1.5, the
// conversation header and the right rail. The point of having it in one place
// is that the header cannot offer a rename main would refuse, and cannot
// normalize a name differently from the row that has always done it.

describe('planRename: channels', () => {
  it('normalizes exactly like the channel create/rename field', () => {
    expect(planRename({ kind: 'channel', current: 'design', input: '  Random Stuff ' })).toEqual({
      action: 'rename',
      name: 'random-stuff',
    })
    expect(planRename({ kind: 'channel', current: 'design', input: '#Product' })).toEqual({
      action: 'rename',
      name: 'product',
    })
  })

  it('does nothing for an empty name or the name it already has', () => {
    expect(planRename({ kind: 'channel', current: 'design', input: '   ' })).toEqual({ action: 'none' })
    expect(planRename({ kind: 'channel', current: 'design', input: ' Design ' })).toEqual({ action: 'none' })
  })

  it('refuses the home channel, the way ChatService.renameChannel does', () => {
    expect(planRename({ kind: 'channel', current: 'general', input: 'lobby', fixed: true })).toEqual({
      action: 'refuse',
      reason: FIXED_CHANNEL_REFUSAL,
    })
  })

  it('caps at the shared channel-name limit', () => {
    const long = 'a'.repeat(CHANNEL_NAME_MAX + 10)
    const plan = planRename({ kind: 'channel', current: 'design', input: long })
    expect(plan.action === 'rename' && plan.name).toHaveLength(CHANNEL_NAME_MAX)
    expect(convNameMax('channel')).toBe(CHANNEL_NAME_MAX)
  })
})

describe('planRename: private groups', () => {
  it('keeps case and spaces, trims, and caps at the group limit', () => {
    expect(planRename({ kind: 'group', current: 'Duo', input: '  Ops Crew ' })).toEqual({
      action: 'rename',
      name: 'Ops Crew',
    })
    const plan = planRename({ kind: 'group', current: 'Duo', input: 'g'.repeat(GROUP_NAME_MAX + 5) })
    expect(plan.action === 'rename' && plan.name).toHaveLength(GROUP_NAME_MAX)
    expect(convNameMax('group')).toBe(GROUP_NAME_MAX)
  })

  it('does nothing for an empty or unchanged name — a group is never "fixed"', () => {
    expect(planRename({ kind: 'group', current: 'Duo', input: '' })).toEqual({ action: 'none' })
    expect(planRename({ kind: 'group', current: 'Duo', input: 'Duo' })).toEqual({ action: 'none' })
    expect(planRename({ kind: 'group', current: 'Duo', input: 'Trio', fixed: true })).toEqual({
      action: 'rename',
      name: 'Trio',
    })
  })
})

describe('normalizeConvName', () => {
  it('is the per-kind normalization the plan uses', () => {
    expect(normalizeConvName('channel', ' #Hello World ')).toBe('hello-world')
    expect(normalizeConvName('group', ' Hello World ')).toBe('Hello World')
  })
})

// ---------------------------------------------------------------------------
// One copy, not three. The sidebar rows had their own `normalizeChannelName` +
// "nothing changed" check and their own `trim().slice(0, 60)` long before this
// module existed; a shared module that only the header and the rail call is a
// third copy that happens to agree, not a single decision. This reads the
// source because the rows live in .tsx and vitest here is node-only — it is a
// cheap guard against the exact drift the module was added to end (change
// GROUP_NAME_MAX and the row must follow).

describe('the sidebar rows go through planRename', () => {
  const source = Object.values(
    import.meta.glob('./Sidebar.tsx', { query: '?raw', import: 'default', eager: true }),
  ).join('') as string

  it('imports the shared decision', () => {
    // Guard the guard: an empty read would make every `not.toContain` pass.
    expect(source.length).toBeGreaterThan(5000)
    expect(source).toMatch(/from ["']\.\/renamePlan["']/)
    expect(source).toContain('planRename({')
  })

  it('keeps no second normalization of its own', () => {
    expect(source).not.toContain('normalizeChannelName(renameValue)')
    expect(source).not.toMatch(/renameValue\.trim\(\)/)
    // The group cap is `convNameMax('group')`, never a literal 60.
    expect(source).not.toMatch(/maxLength=\{60\}/)
    expect(source).not.toMatch(/slice\(0,\s*60\)/)
  })
})
