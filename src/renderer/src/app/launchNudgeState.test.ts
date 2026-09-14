import { describe, expect, it } from 'vitest'
import type { LaunchInfo, SettingsView } from '@shared/bridge'
import { LOGIN_ITEM_APPROVAL, nudgeRows, shouldShowLaunchNudge } from './launchNudgeState'

// Gil's ask, verbatim: "Each time they open the app, if not accepted yet,
// they should have the suggestion to do so." These two functions are the
// whole decision: shouldShowLaunchNudge says whether the card appears at all;
// nudgeRows says what it shows once it does. Both are pure so the "until both
// are accepted" contract can be pinned without a DOM.

const BASE_SETTINGS: SettingsView = {
  theme: 'system',
  notifyChannels: 'mentions',
  notifyPreviews: true,
  autoplayGifs: 'always',
  autoAcceptBeams: false,
  quietHours: { enabled: false, from: '18:30', to: '09:00' },
  fontSize: 'M',
  suggestAtLaunch: true,
  notificationsAccepted: false,
}

const BASE_INFO: LaunchInfo = {
  openAtLogin: false,
  openAtLoginSupported: true,
  openedAtLogin: false,
  notificationsSupported: true,
}

describe('shouldShowLaunchNudge', () => {
  it('shows when neither has been accepted yet', () => {
    expect(shouldShowLaunchNudge(BASE_SETTINGS, BASE_INFO)).toBe(true)
  })

  it('hides once both are accepted', () => {
    const settings: SettingsView = { ...BASE_SETTINGS, notificationsAccepted: true }
    const info: LaunchInfo = { ...BASE_INFO, openAtLogin: true }
    expect(shouldShowLaunchNudge(settings, info)).toBe(false)
  })

  it('keeps showing with only the login item left', () => {
    const settings: SettingsView = { ...BASE_SETTINGS, notificationsAccepted: true }
    expect(shouldShowLaunchNudge(settings, BASE_INFO)).toBe(true)
  })

  it('keeps showing with only notifications left', () => {
    const info: LaunchInfo = { ...BASE_INFO, openAtLogin: true }
    expect(shouldShowLaunchNudge(BASE_SETTINGS, info)).toBe(true)
  })

  it('respects a deliberate opt-out even with both pending', () => {
    const settings: SettingsView = { ...BASE_SETTINGS, suggestAtLaunch: false }
    expect(shouldShowLaunchNudge(settings, BASE_INFO)).toBe(false)
  })

  it('never shows for facts the OS/build does not support', () => {
    const info: LaunchInfo = {
      openAtLogin: false,
      openAtLoginSupported: false,
      openedAtLogin: false,
      notificationsSupported: false,
    }
    expect(shouldShowLaunchNudge(BASE_SETTINGS, info)).toBe(false)
  })

  it('is false while settings or launchInfo have not loaded yet', () => {
    expect(shouldShowLaunchNudge(null, BASE_INFO)).toBe(false)
    expect(shouldShowLaunchNudge(BASE_SETTINGS, null)).toBe(false)
    expect(shouldShowLaunchNudge(null, null)).toBe(false)
  })
})

describe('nudgeRows', () => {
  it('renders both rows on macOS with the passphrase caveat and the Allow hint', () => {
    const rows = nudgeRows(BASE_SETTINGS, BASE_INFO, 'darwin')
    expect(rows.map((r) => r.id)).toEqual(['openAtLogin', 'notifications'])
    expect(rows[0].label).toBe('Open Chat when you log in')
    expect(rows[0].sub).toBe("You'll still enter the team passphrase after a restart.")
    expect(rows[0].done).toBe(false)
    expect(rows[1].label).toBe('Allow notifications')
    expect(rows[1].sub).toBe('If macOS asks, choose Allow.')
    expect(rows[1].done).toBe(false)
  })

  it('drops the platform-specific caveats on Windows', () => {
    const rows = nudgeRows(BASE_SETTINGS, BASE_INFO, 'win32')
    expect(rows[0].sub).toBeUndefined()
    expect(rows[1].sub).toBeUndefined()
  })

  it('omits the login row entirely where it is not supported', () => {
    const info: LaunchInfo = { ...BASE_INFO, openAtLoginSupported: false }
    const rows = nudgeRows(BASE_SETTINGS, info, 'linux')
    expect(rows.map((r) => r.id)).toEqual(['notifications'])
  })

  it('omits the notifications row entirely where it is not supported', () => {
    const info: LaunchInfo = { ...BASE_INFO, notificationsSupported: false }
    const rows = nudgeRows(BASE_SETTINGS, info, 'darwin')
    expect(rows.map((r) => r.id)).toEqual(['openAtLogin'])
  })

  it("shows the approval hint, done, for macOS's 'requires-approval'", () => {
    // main/loginItem.ts already reads that status as on (the item exists); the
    // row therefore has no button left to press, and swaps the passphrase
    // caveat for the one thing still outstanding.
    const info: LaunchInfo = { ...BASE_INFO, openAtLogin: true, status: 'requires-approval' }
    const rows = nudgeRows(BASE_SETTINGS, info, 'darwin')
    expect(rows[0].done).toBe(true)
    expect(rows[0].sub).toBe(LOGIN_ITEM_APPROVAL)
  })

  it('keeps the passphrase caveat for an ordinary enabled item', () => {
    const info: LaunchInfo = { ...BASE_INFO, openAtLogin: true, status: 'enabled' }
    expect(nudgeRows(BASE_SETTINGS, info, 'darwin')[0].sub).toBe(
      "You'll still enter the team passphrase after a restart.",
    )
  })

  it('marks a row done from live state, independent of the other row', () => {
    const settings: SettingsView = { ...BASE_SETTINGS, notificationsAccepted: true }
    const info: LaunchInfo = { ...BASE_INFO, openAtLogin: true }
    const rows = nudgeRows(settings, info, 'darwin')
    expect(rows.every((r) => r.done)).toBe(true)
  })
})
