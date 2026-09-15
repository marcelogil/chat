import { beforeEach, describe, expect, it } from 'vitest'
import { LIVE_EVENT_CAP, arrivedLive, liveEventCount, noteLiveEvent, resetLiveEvents } from './liveEvents'

// The registry that answers "did this land while I had the app open?" for the
// easter eggs. Small, but it is the half of the eligibility rule the pane
// cannot work out for itself once every log is prefetched at boot.

beforeEach(() => resetLiveEvents())

describe('liveEvents', () => {
  it('remembers an event that came over the push, and nothing else', () => {
    noteLiveEvent('1700000000000-0001-aaaaaaaa')
    expect(arrivedLive('1700000000000-0001-aaaaaaaa')).toBe(true)
    expect(arrivedLive('1700000000000-0002-aaaaaaaa')).toBe(false)
  })

  it('ignores an empty id and never double-counts', () => {
    noteLiveEvent('')
    noteLiveEvent('a')
    noteLiveEvent('a')
    expect(arrivedLive('')).toBe(false)
    expect(liveEventCount()).toBe(1)
  })

  it('drops the oldest once the cap is reached', () => {
    for (let i = 0; i < LIVE_EVENT_CAP + 5; i++) noteLiveEvent(`id-${i}`)
    expect(liveEventCount()).toBe(LIVE_EVENT_CAP)
    expect(arrivedLive('id-0')).toBe(false)
    expect(arrivedLive('id-4')).toBe(false)
    expect(arrivedLive('id-5')).toBe(true)
    expect(arrivedLive(`id-${LIVE_EVENT_CAP + 4}`)).toBe(true)
  })

  it('forgets everything on a folder switch', () => {
    noteLiveEvent('a')
    resetLiveEvents()
    expect(arrivedLive('a')).toBe(false)
    expect(liveEventCount()).toBe(0)
  })
})
