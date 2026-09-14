// Quick-reply suggestions for the composer's inline chip row: canned
// dev-status phrases, at most five of them. Pure — no Electron, no DOM — so
// the row (src/renderer/src/chat/QuickRepliesRow.tsx) and the Settings →
// Quick messages editor (SettingsModal.tsx) agree on the same shape, and the
// limits are exercised without a browser.
//
// SettingsView.quickMessages is additive (bridge.ts is FROZEN): absent or
// null means "use the defaults below"; a non-empty array means the person
// customized the list. The row is a single line of chips — five is the most
// that fits without wrapping or scrolling on a normal-width window — so both
// the defaults and a custom list are capped at `maxEntries`.

export const QUICK_MESSAGE_LIMITS = {
  maxEntries: 5,
  maxChars: 120,
} as const

/** The row's starting point before anyone customizes the list — exactly `maxEntries` messages. */
export const DEFAULT_QUICK_MESSAGES: string[] = [
  'On it 👀',
  'LGTM ✅',
  'Can someone review my PR? 🙏',
  'In a meeting, back in 15',
  'Done ✅',
]

/**
 * What the chip row actually renders: the defaults, unless settings carry a
 * non-empty custom list.
 *
 * The custom list goes through `normalizeQuickMessages` on the way out, not
 * just on the way in — a settings file written by an older build (the 1.4
 * draft allowed 40 entries), by a hand edit, or by any writer that skipped
 * the editor would otherwise put a scrolling strip of chips, an untruncated
 * line, or a zero-width dead chip above the composer. A list that normalizes
 * away to nothing reads as "not customized", exactly like null or [].
 */
export function effectiveQuickMessages(settings: { quickMessages?: string[] | null } | null | undefined): string[] {
  const custom = settings?.quickMessages
  if (!custom || custom.length === 0) return DEFAULT_QUICK_MESSAGES
  const clean = normalizeQuickMessages(custom)
  return clean.length > 0 ? clean : DEFAULT_QUICK_MESSAGES
}

/**
 * Clean up the settings editor's rows before persisting: trim, drop blanks,
 * cap each line at maxChars and the whole list at maxEntries. Order is kept —
 * dropping/truncating never reorders what survives.
 */
export function normalizeQuickMessages(lines: string[]): string[] {
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    out.push(line.length > QUICK_MESSAGE_LIMITS.maxChars ? line.slice(0, QUICK_MESSAGE_LIMITS.maxChars) : line)
    if (out.length >= QUICK_MESSAGE_LIMITS.maxEntries) break
  }
  return out
}
