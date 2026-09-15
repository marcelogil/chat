import { describe, expect, it } from 'vitest'
import { isGil } from './gilMode'

describe('isGil', () => {
  it('matches the exact name, case-insensitively', () => {
    expect(isGil('Gil')).toBe(true)
    expect(isGil('gil')).toBe(true)
    expect(isGil('GIL')).toBe(true)
    expect(isGil('gIl')).toBe(true)
  })

  it('tolerates surrounding whitespace', () => {
    expect(isGil('  Gil  ')).toBe(true)
    expect(isGil('\tgil\n')).toBe(true)
  })

  it('is not fooled by a longer name sharing the prefix', () => {
    expect(isGil('Gil Silva')).toBe(false)
    expect(isGil('Gilbert')).toBe(false)
    expect(isGil('Gil2')).toBe(false)
  })

  it('rejects unrelated, empty, or missing names', () => {
    expect(isGil('Bob')).toBe(false)
    expect(isGil('')).toBe(false)
    expect(isGil('   ')).toBe(false)
    expect(isGil(undefined)).toBe(false)
    expect(isGil(null)).toBe(false)
  })
})
