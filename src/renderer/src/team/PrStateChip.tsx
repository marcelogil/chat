import type { PrState } from '@shared/types'
import { waitLabel, waitTone } from './prsGroups'
import type { PrsThresholds } from './prsGroups'
import { agoPhrase } from './PrsPane'

// Chat 1.4 — the per-row wait chip (spec §2 U). Small enough to stay a leaf
// component: PrsPane.tsx owns the group headers and the "Next: …" line,
// this owns only the coloured chip and the tooltip sentence describing it.
// Mirrors the PrsPane.tsx <-> PrsPrefs.tsx import shape (PrsPrefs already
// imports `errorSentence` back from PrsPane.tsx) — safe because every use on
// both sides is inside a function/component body, never at module-eval time.

const TONE_STYLE: Record<'neutral' | 'warn' | 'danger', { background: string; border: string; color: string }> = {
  neutral: {
    background: 'var(--bg-raised)',
    border: '1px solid var(--border-subtle)',
    color: 'var(--text-2)',
  },
  // No `--warning-soft` token exists (only `--danger-soft` does) — color-mix
  // reproduces the same "soft" look from `--warning` alone, the same trick
  // PrsPrefs.tsx's `Note` component already uses for its warn tone.
  warn: {
    background: 'color-mix(in srgb, var(--warning) 14%, transparent)',
    border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)',
    color: 'var(--warning)',
  },
  danger: {
    background: 'var(--danger-soft)',
    border: '1px solid color-mix(in srgb, var(--danger) 40%, transparent)',
    color: 'var(--danger)',
  },
}

/**
 * "created 3d ago · last push 5h ago · last activity 5h ago · 2 open comments"
 * — the chip's tooltip, and (per spec §2 U accessibility) folded into the
 * row's `aria-label` too, so PrsPane.tsx's PrRow imports this directly rather
 * than re-deriving the same sentence.
 */
export function prStateTooltip(state: PrState, createdAt: number, now = Date.now()): string {
  const created = `created ${agoPhrase(createdAt, now)}`
  const push = state.lastPushAt !== null ? `last push ${agoPhrase(state.lastPushAt, now)}` : 'no pushes known'
  const activity = `last activity ${agoPhrase(state.lastActivityAt, now)}`
  const comments = state.threadsKnown
    ? `${state.openThreads} open comment${state.openThreads === 1 ? '' : 's'}`
    : 'comment status unavailable on this server'
  return [created, push, activity, comments].join(' · ')
}

export function PrStateChip({
  state,
  createdAt,
  thresholds,
  now = Date.now(),
}: {
  state: PrState
  createdAt: number
  thresholds: PrsThresholds
  now?: number
}) {
  const tone = waitTone(state, thresholds, now)
  return (
    <span
      title={prStateTooltip(state, createdAt, now)}
      style={{
        height: 18,
        padding: '0 7px',
        borderRadius: 'var(--r-full)',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.02em',
        display: 'inline-flex',
        alignItems: 'center',
        flexShrink: 0,
        whiteSpace: 'nowrap',
        ...TONE_STYLE[tone],
      }}
    >
      {waitLabel(state, now)}
    </span>
  )
}
