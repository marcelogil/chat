import type { LaunchInfo } from '@shared/bridge'

// The login item (1.4), reduced to two pure functions so the one rule that
// actually bites can be tested without an OS: **`getLoginItemSettings` only
// reports the truth when it is asked with the same `path`/`args` the item was
// registered with.** Electron's Windows implementation looks the entry up in
// the Run key and compares its command line against the options it is handed;
// registering with `args: ['--opened-at-login']` and reading back with no args
// therefore reported `openAtLogin: false` for an item that existed — the
// toggle bounced back off and the nudge kept coming back.
//
// Nothing in the app consumes that argv flag (macOS reports
// `wasOpenedAtLogin` itself, and no code path reads the Windows side), so the
// fix is to stop writing args at all and to route both calls through
// `loginItemOptions` — one description of the item, used to write it and to
// read it.

/**
 * The fields of Electron's `LoginItemSettings` this module reads. Kept
 * structural so `launchInfoFrom` stays a plain-data function: the real object
 * from `app.getLoginItemSettings()` satisfies it.
 */
export interface LoginItemState {
  openAtLogin: boolean
  /** macOS only. */
  wasOpenedAtLogin?: boolean
  /** macOS only (SMAppService); absent on Windows. */
  status?: 'not-registered' | 'enabled' | 'requires-approval' | 'not-found'
}

/** Exactly what `setLoginItemSettings`/`getLoginItemSettings` must agree on. */
export interface LoginItemOptions {
  /** Windows only — Electron compares this against the registered command. */
  path?: string
}

/**
 * How this build describes its own login item. Windows has no installer (the
 * app ships as a zip), so the entry points at wherever this copy happens to
 * live; macOS registers the bundle through SMAppService and takes no path.
 * Never any `args`: see the header.
 */
export function loginItemOptions(platform: NodeJS.Platform, execPath: string = process.execPath): LoginItemOptions {
  return platform === 'win32' ? { path: execPath } : {}
}

/**
 * `LaunchInfo`, minus the one field that needs Electron (`notificationsSupported`).
 *
 * macOS 13+ answers `setLoginItemSettings` with a `status` rather than a plain
 * yes: `requires-approval` means the item *is* registered and the person has
 * to flip it on in System Settings → General → Login Items. Treating that as
 * "off" would show a toggle that refuses to stay on, so both `enabled` and
 * `requires-approval` read as on here and `status` rides along for the two
 * surfaces that say what is left to do about it.
 */
export function launchInfoFrom(
  settings: LoginItemState,
  platform: NodeJS.Platform,
): Omit<LaunchInfo, 'notificationsSupported'> {
  const mac = platform === 'darwin'
  const status = mac ? settings.status : undefined
  return {
    openAtLogin:
      status === undefined ? settings.openAtLogin === true : status === 'enabled' || status === 'requires-approval',
    openAtLoginSupported: mac || platform === 'win32',
    // macOS reports this itself. Windows has no equivalent and nothing in the
    // app consumes it, so it is honestly false rather than inferred from an
    // argv flag this build no longer writes.
    openedAtLogin: mac && settings.wasOpenedAtLogin === true,
    ...(status === undefined ? {} : { status }),
  }
}
