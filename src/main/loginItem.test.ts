import { describe, expect, it } from 'vitest'
import { launchInfoFrom, loginItemOptions, type LoginItemState } from './loginItem'

// Two rules, both invisible until somebody runs a Windows build:
//
//   1. the options handed to `setLoginItemSettings` and the ones handed to
//      `getLoginItemSettings` must describe the same item, or the read reports
//      `openAtLogin: false` about an entry that exists;
//   2. macOS 13+ answers with a `status`, and `requires-approval` means
//      "registered, waiting for a tick in System Settings" — not "off".

const EXE = 'C:\\Users\\gil\\Chat\\Chat.exe'

describe('loginItemOptions', () => {
  it('describes the item the same way for the write and the read', () => {
    // This is the whole bug: `app.setLoginItemSettings({openAtLogin, ...opts})`
    // and `app.getLoginItemSettings(opts)` take their description from one
    // function, so they cannot drift apart again.
    const write = { openAtLogin: true, ...loginItemOptions('win32', EXE) }
    const read = loginItemOptions('win32', EXE)
    expect(read).toEqual({ path: EXE })
    expect(Object.keys(write).filter((k) => k !== 'openAtLogin').sort()).toEqual(Object.keys(read).sort())
    for (const k of Object.keys(read)) expect(write[k as 'path']).toBe(read[k as 'path'])
  })

  it('never writes args — nothing reads the flag they carried', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect('args' in loginItemOptions(platform, EXE)).toBe(false)
    }
  })

  it('takes no path on macOS, where the bundle registers itself', () => {
    expect(loginItemOptions('darwin', EXE)).toEqual({})
  })
})

describe('launchInfoFrom', () => {
  const mac = (over: Partial<LoginItemState> = {}): LoginItemState => ({ openAtLogin: false, ...over })

  it('reads an enabled macOS item as on, and carries the status', () => {
    const info = launchInfoFrom(mac({ openAtLogin: true, status: 'enabled' }), 'darwin')
    expect(info.openAtLogin).toBe(true)
    expect(info.status).toBe('enabled')
    expect(info.openAtLoginSupported).toBe(true)
  })

  it("reads 'requires-approval' as on — the item exists, System Settings just has to allow it", () => {
    const info = launchInfoFrom(mac({ openAtLogin: false, status: 'requires-approval' }), 'darwin')
    expect(info.openAtLogin).toBe(true)
    expect(info.status).toBe('requires-approval')
  })

  it("reads 'not-registered' and 'not-found' as off", () => {
    for (const status of ['not-registered', 'not-found'] as const) {
      // `openAtLogin: true` alongside a negative status is the shape that made
      // the toggle lie in the first place — the status wins.
      expect(launchInfoFrom(mac({ openAtLogin: true, status }), 'darwin').openAtLogin).toBe(false)
    }
  })

  it('falls back to openAtLogin on a macOS build that reports no status', () => {
    expect(launchInfoFrom(mac({ openAtLogin: true }), 'darwin').openAtLogin).toBe(true)
    expect(launchInfoFrom(mac(), 'darwin').openAtLogin).toBe(false)
    expect(launchInfoFrom(mac({ openAtLogin: true }), 'darwin').status).toBeUndefined()
  })

  it('ignores a status on Windows, where SMAppService does not exist', () => {
    const info = launchInfoFrom({ openAtLogin: true, status: 'not-registered' }, 'win32')
    expect(info.openAtLogin).toBe(true)
    expect(info.status).toBeUndefined()
    expect(info.openAtLoginSupported).toBe(true)
  })

  it('only macOS can say this launch came from the login item', () => {
    expect(launchInfoFrom(mac({ wasOpenedAtLogin: true }), 'darwin').openedAtLogin).toBe(true)
    expect(launchInfoFrom({ openAtLogin: true, wasOpenedAtLogin: true }, 'win32').openedAtLogin).toBe(false)
    expect(launchInfoFrom({ openAtLogin: true }, 'linux').openedAtLogin).toBe(false)
  })

  it('offers nothing to ask about where there is no login-item API', () => {
    expect(launchInfoFrom({ openAtLogin: false }, 'linux').openAtLoginSupported).toBe(false)
  })
})
