import { PRESENCE } from '@shared/constants'
import type { ConvId, PresenceStateKind, PresenceView } from '@shared/types'

// This device's own presence row (1.4).
//
// `Poller.presenceViews()` is built from the roster minus the local device —
// deliberately, because every list in the renderer that walks it is a list of
// *other people* (DM rows, mention candidates, beam targets, the DM-log
// prefetch). The footer still needs a row for itself, so it gets one here:
// same shape, derived from the local beacon instead of an observation, and
// delivered on its own channel (`presence.self()` / the 'self-presence' push)
// so nothing that iterates `presence` suddenly meets itself.

export interface SelfPresenceInput {
  deviceId: string
  name: string
  /** Already sanitized, like every other row's. */
  hostname: string
  fingerprint: string
  /** The live BeaconWriter presence — what teammates are about to read. */
  presence: { state: PresenceStateKind; status: string; idleSec: number }
  /** Share clock, for `lastSeenMs` (this device is being seen right now). */
  nowMs: number
  app?: string
}

/**
 * The local device as a PresenceView. `state` follows the same rule the poller
 * applies to everyone else — "appear offline" wins, otherwise the OS idle
 * counter decides online vs away — so the footer dot and a teammate's row for
 * us say the same thing.
 */
export function selfPresenceView(input: SelfPresenceInput): PresenceView {
  const state: PresenceStateKind =
    input.presence.state === 'offline'
      ? 'offline'
      : input.presence.idleSec >= PRESENCE.awayIdleSec
        ? 'away'
        : 'online'
  return {
    deviceId: input.deviceId,
    name: input.name,
    hostname: input.hostname,
    fingerprint: input.fingerprint,
    state,
    status: input.presence.status ?? '',
    lastSeenMs: input.nowMs,
    trust: 'trusted',
    // There is no DM with yourself; the empty token is deliberately not a
    // conversation anything can open, and no caller of this row opens one.
    dmConv: 'dm:' as ConvId,
    ...(input.app ? { app: input.app } : {}),
    departed: false,
  }
}
