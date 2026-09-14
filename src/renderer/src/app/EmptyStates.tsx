import { useState } from 'react'
import type { ConvId } from '@shared/types'
import { useStore, selfOf } from '@/store'
import { Avatar, DeviceChip, identityHue } from '@/ui/atoms'
import { modKey } from './chrome'
import { useDmMap, useGroupMap } from './dm'
import { IconLock } from './icons'
import {
  SAY_HELLO_IDLE,
  pressSayHello,
  sayHelloBusy,
  sayHelloFailed,
  sayHelloSent,
  sayHelloToast,
  sayHelloWasQueued,
} from './sayHelloState'
import { toast } from './toasts'

// Spec §10 — delightful empty states. The channel/DM variant floats over the
// chat pane (pointer-events pass through except the starter chips).

function SemaphoreGlyph({ size = 72 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 72 72" fill="none" aria-hidden="true">
      <circle cx="36" cy="20" r="6" stroke="var(--text-3)" strokeWidth="2.5" />
      <path d="M36 26v22M36 48l-9 14M36 48l9 14" stroke="var(--text-3)" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M36 30 20 20" stroke="var(--text-3)" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M20 20l-9-3 2 10 7-7z" fill="var(--accent)" opacity="0.85" />
      <path d="M36 32l17-6" stroke="var(--text-3)" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M53 26l10-1-5 9-5-8z" fill="var(--flare)" opacity="0.85" />
    </svg>
  )
}

/** Center-pane state when no conversation is selected. */
export function NoConvState() {
  const boot = useStore((s) => s.boot)
  const self = selfOf(boot)
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        color: 'var(--text-3)',
        animation: 'sem-fade var(--t-slow) var(--ease-standard)',
      }}
    >
      <SemaphoreGlyph />
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 22, fontWeight: 600, lineHeight: '28px', color: 'var(--text-1)' }}>
          {self ? self.teamName : 'Chat'}
        </div>
        <div style={{ fontSize: 13, marginTop: 6 }}>
          Pick a channel on the left, or press{' '}
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              background: 'var(--bg-raised)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--r-xs)',
              padding: '1px 5px',
            }}
          >
            {modKey}K
          </span>{' '}
          to jump anywhere.
        </div>
      </div>
    </div>
  )
}

/** Overlay for a conversation with no messages yet. Renders nothing otherwise. */
export function EmptyConvOverlay({ conv }: { conv: ConvId }) {
  const loaded = useStore((s) => s.eventsLoaded[conv])
  const events = useStore((s) => s.events[conv])
  const channels = useStore((s) => s.channels)
  const presence = useStore((s) => s.presence)
  const boot = useStore((s) => s.boot)
  const send = useStore((s) => s.send)
  const dmPeers = useDmMap((s) => s.peers)
  const groupMap = useGroupMap()
  // Keyed by conversation, not just a boolean: this component is never
  // remounted between conversations (AppShell renders it in one fixed slot with
  // no `key`), so a bare flag left standing by a successful hello disabled the
  // button in every empty conversation opened afterwards. It is a set of
  // conversations, not a single slot, so switching to a second conversation
  // while the first send is still in flight cannot evict the first one's latch
  // either. See sayHelloState.ts.
  const [hello, setHello] = useState(SAY_HELLO_IDLE)

  const self = selfOf(boot)
  if (!loaded) return null
  if ((events ?? []).some((e) => e.payload.t === 'msg')) return null

  const channel = channels.find((c) => c.conv === conv)
  const group = groupMap[conv]
  const peer = presence.find((p) => p.deviceId === dmPeers[conv])
  const hue = channel ? identityHue(channel.name) : 'var(--accent)'
  const busy = sayHelloBusy(hello, conv)

  async function sayHello() {
    const press = pressSayHello(hello, conv)
    if (!press.send) return
    setHello(press.state)
    try {
      await send(conv, { text: 'Hello 👋', kind: 'text' })
      setHello((s) => sayHelloSent(s, conv))
    } catch (err) {
      // A queued hello (share unreachable) is a good outcome, not a failure —
      // the latch stays up so a second press before the outbox flushes cannot
      // queue a second "Hello 👋". Anything else really did fail, so the
      // button comes back and the rail says what main said.
      setHello((s) => (sayHelloWasQueued(err) ? sayHelloSent(s, conv) : sayHelloFailed(s, conv)))
      const t = sayHelloToast(err)
      toast(t.text, t.tone)
    }
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: '0 0 120px 0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
        zIndex: 5,
        animation: 'sem-fade var(--t-slow) var(--ease-standard)',
      }}
    >
      <div style={{ position: 'relative', textAlign: 'center', maxWidth: 420, padding: 24 }}>
        {channel && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 260,
              fontWeight: 700,
              lineHeight: 1,
              color: `color-mix(in srgb, ${hue} 8%, transparent)`,
              userSelect: 'none',
              pointerEvents: 'none',
            }}
          >
            #
          </div>
        )}
        {group && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'color-mix(in srgb, var(--accent) 8%, transparent)',
              userSelect: 'none',
              pointerEvents: 'none',
            }}
          >
            <IconLock size={220} />
          </div>
        )}
        <div style={{ position: 'relative' }}>
          {channel ? (
            <>
              <div style={{ fontSize: 22, fontWeight: 600, lineHeight: '28px', color: 'var(--text-1)' }}>
                This is the very beginning of{' '}
                <span style={{ color: hue, filter: 'saturate(0.8)' }}>#{channel.name}</span>
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 8 }}>
                Every message here is encrypted on the shared folder.
              </div>
            </>
          ) : group ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12, color: 'var(--text-2)' }}>
                <IconLock size={32} />
              </div>
              <div style={{ fontSize: 22, fontWeight: 600, lineHeight: '28px', color: 'var(--text-1)' }}>
                {group.name}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 8 }}>
                Only {group.members.length} {group.members.length === 1 ? 'person' : 'people'} can read this. Say hi.
              </div>
            </>
          ) : (
            <>
              {peer && self && (
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
                  <span style={{ display: 'inline-flex' }}>
                    <Avatar name={self.displayName} size={44} />
                    <span style={{ marginLeft: -10 }}>
                      <Avatar name={peer.name} size={44} presence={peer.state} />
                    </span>
                  </span>
                </div>
              )}
              <div style={{ fontSize: 22, fontWeight: 600, lineHeight: '28px', color: 'var(--text-1)' }}>
                {peer ? `Just you and ${peer.name}` : 'Just the two of you'}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 8 }}>
                Messages are end-to-end encrypted; beams go device-to-device.
              </div>
              {peer && self && (
                <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 10 }}>
                  <DeviceChip hostname={self.hostname} fingerprint={self.fingerprint} />
                  <DeviceChip hostname={peer.hostname} fingerprint={peer.fingerprint} warn={peer.trust === 'flagged'} />
                </div>
              )}
            </>
          )}
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 20 }}>
            <button
              className="sem-chip-btn"
              onClick={() => void sayHello()}
              disabled={busy}
              aria-label="Say hello"
              title="Send a hello to get things going"
              style={{ pointerEvents: 'auto', opacity: busy ? 0.6 : 1 }}
            >
              Say hello 👋
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
