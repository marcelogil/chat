import { describe, expect, it } from 'vitest'
import { navFor } from './settingsNav'

// The rendered gate is covered by the E2E ("Admin" present on gil's instance,
// absent on alice's); this is the pure rule it is built from.

describe('navFor', () => {
  it('lists Admin for Gil', () => {
    expect(navFor('Gil').map((n) => n.id)).toContain('admin')
  })

  it('is case- and whitespace-insensitive, like isGil', () => {
    expect(navFor(' gil ').map((n) => n.id)).toContain('admin')
  })

  it('does not treat "Gil Silva" as Gil — a different person, not Gil with a surname', () => {
    expect(navFor('Gil Silva').map((n) => n.id)).not.toContain('admin')
  })

  it('has no Admin entry for nobody in particular', () => {
    expect(navFor(undefined).map((n) => n.id)).not.toContain('admin')
  })

  it('keeps the rest of the nav, in order, for everyone', () => {
    expect(navFor(undefined).map((n) => n.id)).toEqual([
      'profile',
      'appearance',
      'notifications',
      'privacy',
      'quickMessages',
      'storage',
      'about',
    ])
    expect(navFor('Gil').map((n) => n.id)).toEqual([
      'profile',
      'admin',
      'appearance',
      'notifications',
      'privacy',
      'quickMessages',
      'storage',
      'about',
    ])
  })
})
