// The person-set status line ("back at 3", "heads-down"), 1.4.
//
// Two things used to be missing and both live here: a status was in-memory
// only (a relaunch dropped it on the floor) and nothing normalized it, so a
// pasted newline could ride into the beacon. `normalizeStatus` is the one
// definition of what a status *is*; main persists the normalized form in
// plaintext settings (`SettingsView.status`) and puts it back into the beacon
// at session start via `restoredBeaconPresence`.

/** Longest status we keep — matches the footer input's `maxLength`. */
export const STATUS_MAX = 80

/**
 * One line, trimmed, bounded. Every whitespace run (a pasted newline
 * included) folds to a single space: the status is rendered as one line under
 * a name, and it rides a JSON beacon whose size is a shared-folder cost.
 */
export function normalizeStatus(text: string | null | undefined): string {
  if (!text) return ''
  return text.replace(/\s+/g, ' ').trim().slice(0, STATUS_MAX).trim()
}

/** The saved status out of plaintext settings — absent, empty and junk all read as "none". */
export function statusFromSettings(settings: { status?: string | null } | null | undefined): string {
  return normalizeStatus(settings?.status)
}

/**
 * The beacon presence a session should start from: whatever the writer was
 * constructed with, carrying the status this device had when it last quit.
 * Pure so the restore is testable without a session.
 */
export function restoredBeaconPresence<T extends { status: string }>(
  current: T,
  savedStatus: string | null | undefined,
): T {
  return { ...current, status: normalizeStatus(savedStatus) }
}
