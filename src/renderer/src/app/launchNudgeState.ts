import type { LaunchInfo, SettingsView } from '@shared/bridge'

// The launch nudge's decision logic (1.4), split out from LaunchNudge.tsx so it
// can be unit-tested in the node environment the suite runs in — same split as
// UpdateBanner / updateBannerState.ts.
//
// Unlike the update banner, "Not now" carries no localStorage key here. The
// ask was "each time they open the app, if not accepted yet, they should have
// the suggestion" — so a launch-scoped dismissal (plain component state, gone
// the moment the app restarts) is the intended behaviour, not something to
// fix later. Persisting it would silence the card past the next launch, which
// is exactly what was asked against.

export type LaunchNudgeRowId = 'openAtLogin' | 'notifications'

/**
 * What macOS still wants after `status: 'requires-approval'` — the same
 * sentence LaunchNudge toasts when `setOpenAtLogin` comes back off, kept in
 * one place so the nudge row and Settings say it identically.
 */
export const LOGIN_ITEM_APPROVAL = 'macOS may need you to allow this under System Settings → General → Login Items.'

export interface LaunchNudgeRow {
  id: LaunchNudgeRowId
  label: string
  /** Platform-specific caveat shown under the label; absent where none applies. */
  sub?: string
  done: boolean
}

/**
 * Whether the card has anything left to suggest. Both rows are gated
 * independently by what this OS/build actually supports (`LaunchInfo`'s
 * `*Supported` flags), so e.g. a platform with no login-item API can still
 * show the notifications row alone, and a person who already granted both
 * never sees the card at all.
 */
export function shouldShowLaunchNudge(settings: SettingsView | null, info: LaunchInfo | null): boolean {
  if (!settings || !info) return false
  if (settings.suggestAtLaunch === false) return false
  const loginPending = info.openAtLoginSupported && !info.openAtLogin
  const notifPending = info.notificationsSupported && settings.notificationsAccepted !== true
  return loginPending || notifPending
}

/**
 * The rows to render, each already resolved to this platform's copy and
 * "done" state. A row absent from the returned list means the OS/build has
 * nothing to offer for it (e.g. Linux has no login-item row) — LaunchNudge
 * never shows a disabled or perpetually-pending row for something it cannot
 * actually do anything about.
 */
export function nudgeRows(
  settings: SettingsView,
  info: LaunchInfo,
  platform: 'darwin' | 'win32' | 'linux',
): LaunchNudgeRow[] {
  const rows: LaunchNudgeRow[] = []
  if (info.openAtLoginSupported) {
    rows.push({
      id: 'openAtLogin',
      // macOS 13+ registers the item but can hold it behind an approval
      // (`status === 'requires-approval'`, which reads as on): the row is done
      // — there is nothing left to press here — but it says where the last
      // tick lives instead of the passphrase caveat.
      label: 'Open Chat when you log in',
      // The no-Keychain rule (CLAUDE.md) means an auto-launch never skips the
      // unlock screen — worth saying up front so this doesn't read as a
      // promise to land straight in the app after a restart.
      sub:
        platform !== 'darwin'
          ? undefined
          : info.status === 'requires-approval'
            ? LOGIN_ITEM_APPROVAL
            : "You'll still enter the team passphrase after a restart.",
      done: info.openAtLogin,
    })
  }
  if (info.notificationsSupported) {
    rows.push({
      id: 'notifications',
      label: 'Allow notifications',
      sub: platform === 'darwin' ? 'If macOS asks, choose Allow.' : undefined,
      done: settings.notificationsAccepted === true,
    })
  }
  return rows
}
