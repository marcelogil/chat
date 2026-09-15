import { create } from 'zustand'
import { IconBolt, IconCheck, IconInfo, IconWarn } from './icons'

// Lightweight in-app toast rail (top-right). Owned by the shell slice; other
// shell modules call toast(text, tone).

export type ToastTone = 'info' | 'success' | 'danger' | 'flare'

interface ToastItem {
  id: number
  text: string
  tone: ToastTone
}

let nextId = 1

const DEFAULT_MS = 5000

const useToastStore = create<{
  list: ToastItem[]
  push(text: string, tone: ToastTone, ms: number): void
  dismiss(id: number): void
}>((set) => ({
  list: [],
  push(text, tone, ms) {
    const id = nextId++
    set((s) => ({ list: [...s.list.slice(-2), { id, text, tone }] }))
    window.setTimeout(() => set((s) => ({ list: s.list.filter((t) => t.id !== id) })), ms)
  },
  dismiss(id) {
    set((s) => ({ list: s.list.filter((t) => t.id !== id) }))
  },
}))

/**
 * `ms` (default 5s) is how long the toast lingers before it auto-dismisses —
 * the calendar digest (team/CalendarDigest.tsx) asks for ~8s since it is a
 * one-line summary read once per day, not an error worth cutting short.
 */
export function toast(text: string, tone: ToastTone = 'info', ms: number = DEFAULT_MS) {
  useToastStore.getState().push(text, tone, ms)
}

const TONE_COLOR: Record<ToastTone, string> = {
  info: 'var(--text-2)',
  success: 'var(--success)',
  danger: 'var(--danger)',
  flare: 'var(--flare)',
}

function ToneIcon({ tone }: { tone: ToastTone }) {
  const style = { color: TONE_COLOR[tone], flexShrink: 0 }
  return (
    <span style={style}>
      {tone === 'success' && <IconCheck size={16} />}
      {tone === 'danger' && <IconWarn size={16} />}
      {tone === 'flare' && <IconBolt size={16} />}
      {tone === 'info' && <IconInfo size={16} />}
    </span>
  )
}

export function Toasts() {
  const list = useToastStore((s) => s.list)
  const dismiss = useToastStore((s) => s.dismiss)
  if (!list.length) return null
  return (
    <div
      style={{
        position: 'fixed',
        top: 52,
        right: 16,
        // Z-ladder, highest first:
        //   1150  this tier: toasts, beam offers (BeamSurface), PR alerts
        //         (team/PrAlert), the presenter banner (screenshare/ShareUi) —
        //         transient things the user must see wherever they are
        //   1100  diagram editor overlay (diagram/DiagramEditor + DiagramRoot)
        //   1000  media lightbox · 990/900/800 update banner, share picker,
        //         remote-share viewer · 85 dialogs · < 80 panes and popovers
        //         (70/71 popovers, 60 quick switcher, 55 the launch nudge —
        //         a suggestion never covers something the user opened)
        // A toast used to sit at 90, i.e. under every one of those.
        zIndex: 1150,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: 280,
      }}
    >
      {list.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          title="Dismiss"
          aria-label={`Dismiss notification: ${t.text}`}
          className="sem-frost"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            borderRadius: 'var(--r-lg)',
            border: '1px solid var(--border-subtle)',
            boxShadow: 'var(--elev-2)',
            color: 'var(--text-1)',
            fontSize: 13,
            fontFamily: 'var(--font-ui)',
            textAlign: 'left',
            cursor: 'pointer',
            animation: 'sem-toast-in var(--t-base) var(--ease-pop)',
          }}
        >
          <ToneIcon tone={t.tone} />
          <span style={{ lineHeight: '17px' }}>{t.text}</span>
        </button>
      ))}
    </div>
  )
}
