import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConvId } from '@shared/types'
import { useStore } from '@/store'
import { DRAG, NO_DRAG, overlayChromeInsets } from '@/app/chrome'
import { Button, Spinner } from '@/ui/atoms'
import {
  activeAnnounceIn,
  beginCapture,
  initScreenShare,
  leaveViewing,
  presenterLabel,
  startShare,
  stopShare,
  switchSource,
  useScreenStore,
  viewerStream,
} from './manager'

// Screen-share UI: source picker, macOS permission explainer, presenter
// banner, viewer overlay, and the per-conversation "X is sharing" banner.
// ScreenShareRoot mounts once at the app root; ShareButton goes in the
// channel header; ActiveShareBanner sits above the chat pane.

export function ScreenShareRoot() {
  useEffect(() => initScreenShare(), [])
  return (
    <>
      <SourcePicker />
      <PermissionPanel />
      <PresenterBanner />
      <ViewerOverlay />
    </>
  )
}

// ---------------------------------------------------------------------------

export function ShareButton({ conv }: { conv: ConvId }) {
  const sharing = useScreenStore((s) => s.sharing)
  const isMe = sharing?.conv === conv
  return (
    <button
      title={isMe ? 'Stop sharing your screen' : 'Share your screen'}
      aria-label="Share screen"
      onClick={() => (isMe ? void stopShare() : void startShare(conv))}
      style={{
        width: 28,
        height: 28,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 'none',
        borderRadius: 'var(--r-sm)',
        background: isMe ? 'var(--flare-soft)' : 'transparent',
        color: isMe ? 'var(--flare)' : 'var(--text-2)',
        cursor: 'pointer',
      }}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="4" width="20" height="13" rx="2" />
        <path d="M8 21h8M12 17v4" />
        {isMe && <circle cx="12" cy="10.5" r="2.5" fill="currentColor" stroke="none" />}
      </svg>
    </button>
  )
}

// ---------------------------------------------------------------------------

export function ActiveShareBanner({ conv }: { conv: ConvId }) {
  const events = useStore((s) => s.events[conv])
  const presence = useStore((s) => s.presence)
  const sharing = useScreenStore((s) => s.sharing)
  const viewing = useScreenStore((s) => s.viewing)
  const announce = useMemo(() => activeAnnounceIn(events), [events])

  if (!announce) return null
  if (sharing?.sessionId === announce.sessionId) return null // presenter has own banner
  if (viewing?.sessionId === announce.sessionId) return null // already watching
  const presenter = presence.find((p) => p.deviceId === announce.presenterDevice)
  const name = presenter?.name ?? 'A teammate'
  // A presenter that has gone offline abandons the session
  if (presenter && presenter.state === 'offline') return null

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 16px',
        background: 'var(--accent-soft)',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--danger)' }} />
        <span
          style={{
            position: 'absolute',
            inset: -3,
            borderRadius: '50%',
            border: '1px solid var(--danger)',
            opacity: 0.5,
            animation: 'sem-spin 2s linear infinite', // subtle motion cue
          }}
        />
      </span>
      <span style={{ fontSize: 13, color: 'var(--text-1)' }}>
        <strong>{name}</strong> is sharing their screen
      </span>
      <span style={{ flex: 1 }} />
      <Button onClick={() => void import('./manager').then((m) => m.watchSession(announce, conv))}>Watch</Button>
    </div>
  )
}

// ---------------------------------------------------------------------------

function SourcePicker() {
  const conv = useScreenStore((s) => s.pickerOpen)
  const [sources, setSources] = useState<Awaited<ReturnType<typeof window.bridge.screen.sources>>['sources']>([])
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    if (!conv) return
    let alive = true
    let preselected = false
    setSelected(null) // clear any previous session's pick before this one loads
    const load = () =>
      void window.bridge.screen.sources().then((r) => {
        if (!alive) return
        setSources(r.sources)
        // Pre-select the primary display (falling back to the first screen)
        // so "Start sharing" works with one click — the picker used to start
        // with nothing selected, which was half of why people ended up
        // sharing only the Chat window itself. Only latch once a screen has
        // actually shown up: a windows-only first poll (screens enumerate
        // slower on some setups) must not lock the pick onto a window forever.
        if (!preselected) {
          const def = r.sources.find((s) => s.primary) ?? r.sources.find((s) => s.kind === 'screen')
          if (def) {
            preselected = true
            setSelected(def.id)
          }
        }
      })
    load()
    const t = setInterval(load, 2000) // live-ish thumbnails
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [conv])

  if (!conv) return null
  const close = () => useScreenStore.setState({ pickerOpen: null })
  const screens = sources.filter((s) => s.kind === 'screen')
  const windows = sources.filter((s) => s.kind === 'window')

  return (
    <div
      role="dialog"
      aria-label="Share your screen"
      onClick={close}
      // The backdrop covers the shell's drag strip; without NO_DRAG a
      // click-away in the top ~36 px dragged the window instead of closing
      // (1.4 — see app/overlayChrome.ts).
      style={{ ...NO_DRAG, position: 'fixed', inset: 0, zIndex: 900, background: 'var(--bg-overlay)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 720, maxHeight: '80vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-panel)', borderRadius: 'var(--r-xl)', border: '1px solid var(--border-strong)', boxShadow: 'var(--elev-3)' }}
      >
        <div style={{ padding: '16px 20px 8px', fontSize: 17, fontWeight: 600 }}>Share your screen</div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 20px' }}>
          {[
            ['Screens', screens],
            ['Windows', windows],
          ].map(([label, list]) =>
            (list as typeof sources).length ? (
              <div key={label as string} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--text-3)', margin: '8px 0' }}>
                  {(label as string).toUpperCase()}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                  {(list as typeof sources).map((s) => (
                    <button
                      key={s.id}
                      onClick={() => setSelected(s.id)}
                      title={s.name}
                      style={{
                        padding: 0,
                        border: selected === s.id ? '2px solid var(--accent)' : '2px solid var(--border-subtle)',
                        borderRadius: 'var(--r-md)',
                        overflow: 'hidden',
                        cursor: 'pointer',
                        background: 'var(--bg-raised)',
                        textAlign: 'left',
                      }}
                    >
                      <img src={s.thumbnailDataUrl} alt={s.name} style={{ width: '100%', height: 120, objectFit: 'cover', display: 'block' }} />
                      <div style={{ padding: '6px 8px', fontSize: 12, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                        {s.primary && (
                          <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 600, color: 'var(--text-3)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-full)', padding: '1px 6px' }}>
                            Primary
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null,
          )}
          {sources.length === 0 && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
              <Spinner size={24} />
            </div>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 20px 16px' }}>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            // `!selected` alone stayed enabled on a stale pick — a source
            // that closed (or was never in this poll's list) still looked
            // selected, and the click below was a silent no-op.
            disabled={!sources.some((s) => s.id === selected)}
            onClick={() => {
              const source = sources.find((s) => s.id === selected)
              if (source) void beginCapture(conv, source)
            }}
          >
            Start sharing
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function PermissionPanel() {
  const open = useScreenStore((s) => s.permissionPanel)
  const [status, setStatus] = useState<string>('denied')

  useEffect(() => {
    if (!open) return
    const t = setInterval(() => {
      void window.bridge.screen.permission().then(setStatus)
    }, 2000)
    return () => clearInterval(t)
  }, [open])

  if (!open) return null
  const close = () => useScreenStore.setState({ permissionPanel: false })

  return (
    <div role="dialog" aria-label="Screen recording permission" onClick={close} style={{ ...NO_DRAG, position: 'fixed', inset: 0, zIndex: 900, background: 'var(--bg-overlay)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 440, background: 'var(--bg-panel)', borderRadius: 'var(--r-xl)', border: '1px solid var(--border-strong)', boxShadow: 'var(--elev-3)', padding: 24 }}>
        <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>Screen Recording permission needed</div>
        <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: '19px' }}>
          Allow Chat under{' '}
          <strong style={{ color: 'var(--text-1)' }}>System Settings → Privacy &amp; Security → Screen Recording</strong>, then
          restart the app.
        </p>
        <p style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: '17px' }}>
          Look for <strong style={{ color: 'var(--text-2)' }}>Screen&nbsp;Recording</strong> specifically — not Microphone or
          Camera. Chat never records audio. After updating Chat, macOS may ask for this again — that's normal for
          internally built apps.
        </p>
        <p style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: '17px' }}>
          On macOS 15 (Sequoia) and later, the OS also shows a periodic "Chat can record this screen" reminder while
          you're sharing — that's Apple's own nudge, not a sign anything's wrong.
        </p>
        {status === 'granted' && (
          <p style={{ fontSize: 13, color: 'var(--success)', fontWeight: 600 }}>✓ Granted — restart Chat to finish.</p>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button variant="ghost" onClick={close}>
            Later
          </Button>
          {status === 'granted' ? (
            <Button onClick={() => void window.bridge.app.relaunch()}>Restart Chat</Button>
          ) : (
            <Button onClick={() => void window.bridge.screen.openPermissionSettings()}>Open System Settings</Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function PresenterBanner() {
  const sharing = useScreenStore((s) => s.sharing)
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(0)

  useEffect(() => {
    if (!sharing) return
    startRef.current = Date.now()
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000)
    return () => clearInterval(t)
  }, [sharing?.sessionId])

  if (!sharing) return null
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')

  return (
    <div
      style={{
        position: 'fixed',
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        // Above every full-window overlay (diagram editor 1100, lightbox 1000):
        // "you are sharing your screen" must never be the thing that is hidden.
        // See the ladder in app/toasts.tsx.
        zIndex: 1150,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 12px',
        background: 'var(--flare-soft)',
        border: '1px solid var(--flare)',
        borderRadius: 'var(--r-full)',
        boxShadow: 'var(--elev-2)',
        backdropFilter: 'blur(12px)',
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--danger)', animation: 'sem-pulse 1.6s ease-in-out infinite' }} />
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-1)' }} title={sharing.sourceName}>
        {presenterLabel(sharing.sourceName, sharing.sourceKind)} · {mm}:{ss}
      </span>
      <span style={{ fontSize: 12, color: 'var(--text-2)' }} title="live P2P viewers + relay viewers">
        👀 {sharing.viewers}
      </span>
      <button
        onClick={() => void switchSource()}
        style={{ border: '1px solid var(--border-strong)', color: 'var(--text-1)', background: 'transparent', borderRadius: 'var(--r-sm)', fontSize: 12, fontWeight: 600, padding: '3px 10px', cursor: 'pointer' }}
      >
        Switch source
      </button>
      <button
        onClick={() => void stopShare()}
        style={{ border: '1px solid var(--danger)', color: 'var(--danger)', background: 'transparent', borderRadius: 'var(--r-sm)', fontSize: 12, fontWeight: 600, padding: '3px 10px', cursor: 'pointer' }}
      >
        Stop
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------

function ViewerOverlay() {
  const viewing = useScreenStore((s) => s.viewing)
  const presence = useStore((s) => s.presence)
  const fullscreen = useStore((s) => s.fullscreen)
  const viewerInsets = overlayChromeInsets(window.bridge.platform, fullscreen)
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (viewing?.mode === 'p2p' && videoRef.current && viewerStream) {
      videoRef.current.srcObject = viewerStream
      void videoRef.current.play().catch(() => {})
    }
  }, [viewing?.streamId, viewing?.mode])

  if (!viewing) return null
  const presenter = presence.find((p) => p.deviceId === viewing.presenterDevice)

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 800, background: '#000', display: 'flex', flexDirection: 'column' }}>
      {/* The viewer's strip sits over the shell's drag region, which Chromium
          derives from the DOM regardless of z-order — so before 1.4 **Leave**
          was unclickable with a real mouse (CDP clicks go straight to the DOM,
          which is why the E2E never saw it). The strip takes the region, its
          controls opt out, and the content dodges the OS window buttons.
          See app/overlayChrome.ts. */}
      <div
        style={{
          ...DRAG,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          // ≥ 36 px tall so it covers the shell strip it is taking over.
          minHeight: 44,
          paddingTop: 10,
          paddingBottom: 10,
          paddingLeft: 16 + viewerInsets.left,
          paddingRight: 16 + viewerInsets.right,
          background: 'rgba(0,0,0,0.6)',
          userSelect: 'none',
        }}
      >
        <span style={{ ...NO_DRAG, fontSize: 13, fontWeight: 600, color: '#fff' }}>
          {presenter?.name ?? 'Teammate'}'s screen
        </span>
        <ModeChip mode={viewing.mode} />
        <span style={{ flex: 1 }} />
        <button
          onClick={() => void leaveViewing()}
          style={{ ...NO_DRAG, border: '1px solid rgba(255,255,255,0.3)', color: '#fff', background: 'rgba(255,255,255,0.08)', borderRadius: 'var(--r-sm)', fontSize: 12, fontWeight: 600, padding: '4px 12px', cursor: 'pointer' }}
        >
          Leave
        </button>
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0 }}>
        {viewing.mode === 'p2p' ? (
          <video ref={videoRef} autoPlay muted style={{ maxWidth: '100%', maxHeight: '100%' }} />
        ) : viewing.mode === 'relay' && viewing.frameUrl ? (
          <img src={viewing.frameUrl} alt="Shared screen" style={{ maxWidth: '100%', maxHeight: '100%', transition: 'opacity 200ms' }} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, color: 'rgba(255,255,255,0.7)' }}>
            <Spinner size={28} />
            <span style={{ fontSize: 13 }}>Connecting…</span>
          </div>
        )}
      </div>
    </div>
  )
}

function ModeChip({ mode }: { mode: 'connecting' | 'p2p' | 'relay' }) {
  const map = {
    connecting: { label: '◌ Connecting…', color: 'var(--warning)', tip: 'Negotiating a direct connection' },
    p2p: { label: '● Live · P2P', color: 'var(--success)', tip: 'Direct connection — smooth video' },
    relay: {
      label: '▮ Relay mode · ~1 fps',
      color: 'var(--warning)',
      tip: "Direct connection unavailable. You're seeing encrypted snapshots relayed through the team folder — roughly one frame per second.",
    },
  }[mode]
  return (
    <span title={map.tip} style={{ fontSize: 11, fontWeight: 600, color: map.color, border: `1px solid ${map.color}`, borderRadius: 'var(--r-full)', padding: '2px 8px' }}>
      {map.label}
    </span>
  )
}
