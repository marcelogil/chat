import { useCallback, useEffect, useRef } from 'react'
import { create } from 'zustand'
import type { EasterEgg } from '@shared/easterEggs'

// Message easter eggs (1.5), the visible half: one full-window layer that
// draws either a beetle running across the screen or a fall of confetti, and
// then takes itself away.
//
// Z-ladder (documented in full in toasts.tsx): this sits at 50 — above the
// message list and the composer, below the launch nudge (55), the quick
// switcher (60), popovers (70/71) and every dialog (85). A joke never covers
// something the user opened. `pointer-events: none` all the way down, so the
// layer is invisible to the mouse even while a beetle is walking over a button.
//
// Whether an animation may play at all is decided in easterEggQueue.ts; by the
// time anything here runs, that question is settled.

const EGG_Z = 50

/** ~3 s across the window, which reads as a scurry rather than a stroll. */
const BUG_MS = 3_000
/** ~2.5 s of fall, about as long as it takes to look up and smile. */
const CONFETTI_MS = 2_500
/** Pieces in one fall. Enough to feel generous, few enough to stay at 60fps. */
const CONFETTI_PIECES = 150

/** The OS "reduce motion" switch — the feature's hard off. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

interface EggShow {
  /** Monotonic, so a repeat of the same egg still remounts the animation. */
  seq: number
  egg: EasterEgg
  /** Vertical band for the bug, as a fraction of the window height. */
  band: number
  /** 1 = runs left to right, -1 = right to left. */
  dir: 1 | -1
}

let nextSeq = 1

const useEggStore = create<{
  show: EggShow | null
  play(egg: EasterEgg): void
  clear(seq: number): void
}>((set) => ({
  show: null,
  play(egg) {
    set({
      show: {
        seq: nextSeq++,
        egg,
        // Never the very top (the header) or the very bottom (the composer):
        // between a fifth and four fifths down the window.
        band: 0.2 + Math.random() * 0.6,
        dir: Math.random() < 0.5 ? 1 : -1,
      },
    })
  },
  clear(seq) {
    // Only the animation that finished clears the slot — a later one that
    // replaced it keeps running.
    set((s) => (s.show?.seq === seq ? { show: null } : s))
  },
}))

/** Start an animation. The queue has already decided this is allowed. */
export function playEasterEgg(egg: EasterEgg): void {
  useEggStore.getState().play(egg)
}

export function EasterEggOverlay() {
  const show = useEggStore((s) => s.show)
  const clear = useEggStore((s) => s.clear)
  const seq = show?.seq ?? 0
  const done = useCallback(() => clear(seq), [clear, seq])

  if (!show) return null
  return (
    <div
      // The E2E drive script watches for exactly this attribute.
      data-easter-egg={show.egg}
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: EGG_Z,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      <style>{EGG_CSS}</style>
      {show.egg === 'bug' ? (
        <BugRunner key={show.seq} band={show.band} dir={show.dir} onDone={done} />
      ) : (
        <ConfettiFall key={show.seq} onDone={done} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

const EGG_CSS = `
@keyframes sem-egg-run { from { transform: translateX(-90px); } to { transform: translateX(calc(100vw + 90px)); } }
@keyframes sem-egg-run-rev { from { transform: translateX(calc(100vw + 90px)); } to { transform: translateX(-90px); } }
@keyframes sem-egg-bob { 0%, 100% { transform: translateY(-2px) rotate(-2deg); } 50% { transform: translateY(2px) rotate(2deg); } }
@keyframes sem-egg-step { 0%, 100% { transform: rotate(-16deg); } 50% { transform: rotate(16deg); } }
@keyframes sem-egg-step-b { 0%, 100% { transform: rotate(16deg); } 50% { transform: rotate(-16deg); } }
.sem-egg-leg { transform-box: view-box; animation: sem-egg-step 220ms ease-in-out infinite; }
.sem-egg-leg-b { animation-name: sem-egg-step-b; }
`

/**
 * The beetle. An SVG rather than an emoji: 🐞 renders as a different animal on
 * every platform and cannot have its legs moved, and the legs are what sell it
 * as running. Six of them, alternating in two phases, under a body that bobs.
 */
function BugRunner({ band, dir, onDone }: { band: number; dir: 1 | -1; onDone: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onDone, BUG_MS + 60)
    return () => window.clearTimeout(t)
  }, [onDone])

  return (
    <div
      style={{
        position: 'absolute',
        top: `${(band * 100).toFixed(2)}%`,
        left: 0,
        willChange: 'transform',
        animation: `${dir === 1 ? 'sem-egg-run' : 'sem-egg-run-rev'} ${BUG_MS}ms linear forwards`,
      }}
    >
      <div style={{ animation: 'sem-egg-bob 220ms ease-in-out infinite' }}>
        {/* Facing: the artwork walks right, so a right-to-left run mirrors it. */}
        <div style={{ transform: dir === 1 ? undefined : 'scaleX(-1)' }}>
          <Beetle />
        </div>
      </div>
    </div>
  )
}

/** Legs: [x at the body, y at the body, foot x, foot y]. */
const LEGS: [number, number, number, number][] = [
  [17, 13, 9, 4],
  [22, 14, 20, 3],
  [27, 13, 33, 5],
  [17, 21, 9, 30],
  [22, 20, 20, 31],
  [27, 21, 33, 29],
]

function Beetle() {
  return (
    <svg width={44} height={34} viewBox="0 0 44 34" role="img" aria-hidden focusable="false">
      {LEGS.map(([x1, y1, x2, y2], i) => (
        <line
          key={i}
          className={i % 2 === 0 ? 'sem-egg-leg' : 'sem-egg-leg sem-egg-leg-b'}
          style={{ transformOrigin: `${x1}px ${y1}px`, animationDelay: `${(i % 3) * 40}ms` }}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke="#2b1b16"
          strokeWidth={1.8}
          strokeLinecap="round"
        />
      ))}
      {/* Antennae */}
      <line x1={33} y1={15} x2={40} y2={9} stroke="#2b1b16" strokeWidth={1.6} strokeLinecap="round" />
      <line x1={33} y1={19} x2={40} y2={24} stroke="#2b1b16" strokeWidth={1.6} strokeLinecap="round" />
      {/* Shell */}
      <ellipse cx={21} cy={17} rx={13} ry={9.5} fill="#d63d34" stroke="#7a1f19" strokeWidth={1.2} />
      <path d="M21 7.6 V26.4" stroke="#7a1f19" strokeWidth={1.2} />
      <circle cx={15} cy={12.5} r={2.1} fill="#2b1b16" />
      <circle cx={15} cy={21.5} r={2.1} fill="#2b1b16" />
      <circle cx={25} cy={13.5} r={1.7} fill="#2b1b16" />
      <circle cx={25} cy={20.5} r={1.7} fill="#2b1b16" />
      {/* Head */}
      <circle cx={32} cy={17} r={5.4} fill="#2b1b16" />
      <circle cx={34.2} cy={14.8} r={1} fill="#fdfdfd" />
      <circle cx={34.2} cy={19.2} r={1} fill="#fdfdfd" />
    </svg>
  )
}

// ---------------------------------------------------------------------------

const CONFETTI_COLORS = ['#f94f6d', '#ffd23f', '#3ddc97', '#4aa8ff', '#b07cff', '#ff8a3d']

interface Piece {
  x: number
  y: number
  vx: number
  vy: number
  w: number
  h: number
  rot: number
  vrot: number
  sway: number
  phase: number
  color: string
}

/**
 * Confetti on a canvas, not 150 DOM nodes: one element, one paint per frame,
 * and no layout work while it falls. Positions are computed from the elapsed
 * time rather than integrated frame by frame, so a dropped frame (or a window
 * that was behind another app) never leaves pieces hanging in mid-air.
 */
function ConfettiFall({ onDone }: { onDone: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  useEffect(() => {
    const cv = ref.current
    const ctx = cv?.getContext('2d')
    if (!cv || !ctx) {
      doneRef.current()
      return
    }
    const w = window.innerWidth
    const h = window.innerHeight
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = Math.max(1, Math.round(w * dpr))
    cv.height = Math.max(1, Math.round(h * dpr))
    ctx.scale(dpr, dpr)

    const pieces: Piece[] = Array.from({ length: CONFETTI_PIECES }, () => ({
      x: Math.random() * w,
      // Staggered above the top edge so they arrive as a shower, not a wall.
      y: -20 - Math.random() * h * 0.7,
      vx: (Math.random() - 0.5) * 70,
      vy: 260 + Math.random() * 320,
      w: 5 + Math.random() * 6,
      h: 8 + Math.random() * 8,
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 9,
      sway: 8 + Math.random() * 22,
      phase: Math.random() * Math.PI * 2,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
    }))

    let raf = 0
    const t0 = performance.now()
    const frame = (now: number): void => {
      const ms = now - t0
      const t = ms / 1000
      ctx.clearRect(0, 0, w, h)
      // Fade the last 400 ms so nothing vanishes mid-screen.
      ctx.globalAlpha = ms > CONFETTI_MS - 400 ? Math.max(0, (CONFETTI_MS - ms) / 400) : 1
      for (const p of pieces) {
        const x = p.x + p.vx * t + Math.sin(t * 3 + p.phase) * p.sway
        const y = p.y + p.vy * t + 90 * t * t
        if (y < -40 || y > h + 40) continue
        ctx.save()
        ctx.translate(x, y)
        ctx.rotate(p.rot + p.vrot * t)
        ctx.fillStyle = p.color
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
        ctx.restore()
      }
      if (ms < CONFETTI_MS) raf = requestAnimationFrame(frame)
      else doneRef.current()
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  return <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
}
