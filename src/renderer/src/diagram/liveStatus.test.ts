import { describe, expect, it } from 'vitest'
import { RECONNECT_MS, liveAriaLabel, liveStatusLabel, liveSyncState, type LiveSyncStats } from './liveStatus'

const NOW = 1_700_000_000_000
const base: LiveSyncStats = { sentAt: NOW - 1000, recvAt: NOW - 1000, pendingSince: null, peers: 1, reachable: true }

describe('liveSyncState', () => {
  it('is Synced while frames are moving in either direction', () => {
    expect(liveStatusLabel(base, NOW)).toBe('Synced')
    expect(liveStatusLabel({ ...base, sentAt: 0 }, NOW)).toBe('Synced')
    expect(liveStatusLabel({ ...base, recvAt: NOW - 100, sentAt: 0 }, NOW)).toBe('Synced')
  })

  it('says Sending… while a write is in flight', () => {
    expect(liveStatusLabel({ ...base, pendingSince: NOW - 200 }, NOW)).toBe('Sending…')
  })

  it('says Waiting for teammates when nobody else is on the board', () => {
    expect(liveStatusLabel({ ...base, peers: 0 }, NOW)).toBe('Waiting for teammates')
    // …and an empty room is not "reconnecting" just because no frame has come
    // in: nobody is there to send one.
    expect(liveStatusLabel({ ...base, peers: 0, recvAt: NOW - 10 * RECONNECT_MS }, NOW)).toBe(
      'Waiting for teammates',
    )
  })

  it('says Reconnecting… when the share stops answering', () => {
    expect(liveStatusLabel({ ...base, reachable: false }, NOW)).toBe('Reconnecting…')
    // Unreachable outranks everything, including a pending write.
    expect(liveStatusLabel({ ...base, reachable: false, pendingSince: NOW, peers: 0 }, NOW)).toBe('Reconnecting…')
  })

  it('says Reconnecting… when a peer on the board has gone quiet past the keepalive', () => {
    // Every participant republishes its last frame every 10 s, so 15 s of
    // silence from somebody the roster still lists means the poll is stuck.
    expect(liveStatusLabel({ ...base, recvAt: NOW - RECONNECT_MS - 1 }, NOW)).toBe('Reconnecting…')
    expect(liveStatusLabel({ ...base, recvAt: NOW - RECONNECT_MS + 1 }, NOW)).toBe('Synced')
  })

  it('returns the state, not just the words', () => {
    expect(liveSyncState(base, NOW)).toBe('synced')
    expect(liveSyncState({ ...base, peers: 0 }, NOW)).toBe('waiting')
  })
})

describe('liveAriaLabel', () => {
  it('keeps the "Live board" prefix the E2E and screen readers key off', () => {
    expect(liveAriaLabel(['Bob'], base, NOW).startsWith('Live board')).toBe(true)
    expect(liveAriaLabel([], { ...base, peers: 0 }, NOW).startsWith('Live board')).toBe(true)
  })

  it('names who is drawing and how the sync is going', () => {
    expect(liveAriaLabel(['Bob', 'Dana'], base, NOW)).toBe('Live board, drawing with Bob, Dana, Synced')
    expect(liveAriaLabel([], { ...base, peers: 0 }, NOW)).toBe('Live board, nobody else has joined yet, Waiting for teammates')
  })
})
