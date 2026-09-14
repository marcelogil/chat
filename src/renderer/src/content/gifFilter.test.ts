import { describe, expect, it } from 'vitest'
import { filterPack, packCategories, type GifItem } from './gifFilter'

const pack: GifItem[] = [
  { url: 'sfgif://pack/1f44d.gif', w: 512, h: 512, packId: '1f44d', category: 'Nice' },
  { url: 'sfgif://pack/2705.gif', w: 512, h: 512, packId: '2705', category: 'Nice' },
  { url: 'sfgif://pack/1f680.gif', w: 512, h: 512, packId: '1f680', category: 'Ship it' },
  { url: 'sfgif://pack/1f389.gif', w: 512, h: 512, packId: '1f389', category: 'Ship it' },
]

describe('filterPack', () => {
  it('matches a selected category case-insensitively and ignores query text', () => {
    expect(filterPack(pack, '', 'nice')).toEqual([pack[0], pack[1]])
    expect(filterPack(pack, 'this text is irrelevant', 'SHIP IT')).toEqual([pack[2], pack[3]])
  })

  it('with no category, matches a typed query against packId or url', () => {
    expect(filterPack(pack, '1f680', null)).toEqual([pack[2]])
  })

  it('with no category, also matches a typed query against the category name', () => {
    expect(filterPack(pack, 'ship', null)).toEqual([pack[2], pack[3]])
  })

  it('a category with no items in the pack yields an empty grid', () => {
    expect(filterPack(pack, '', 'facepalm')).toEqual([])
  })

  it('with no category and no query, returns the whole pack', () => {
    expect(filterPack(pack, '', null)).toEqual(pack)
  })

  it('a blank/whitespace-only query behaves like no query', () => {
    expect(filterPack(pack, '   ', null)).toEqual(pack)
  })
})

describe('packCategories', () => {
  it('collects each item category, lowercased, into a set', () => {
    expect(packCategories(pack)).toEqual(new Set(['nice', 'ship it']))
  })

  it('a category absent from the pack is not in the set, so its chip stays hidden', () => {
    expect(packCategories(pack).has('facepalm')).toBe(false)
  })

  it('ignores items with no category (online search results)', () => {
    expect(packCategories([{ url: 'https://example.com/x.gif', w: 1, h: 1 }])).toEqual(new Set())
  })
})
