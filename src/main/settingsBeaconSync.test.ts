import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatService } from './services/chatService'

// Settings are read through `() => this.settings` at the point of decision, so
// almost nothing needs telling when they change. The beacon heartbeat is the
// exception: a paused device (locked screen) has stopped publishing, so there
// is no "next beacon" for a freshly flipped always-online (1.5) to take effect
// on. `setSettings` has to say so, or the toggle does nothing until the tier
// moves again.

const paths = vi.hoisted(() => ({ userData: '', temp: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? paths.userData : paths.temp),
    getVersion: () => '1.4.0',
    isPackaged: false,
  },
  BrowserWindow: class {},
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  Notification: class {
    static isSupported(): boolean {
      return false
    }
  },
  net: { fetch: async () => ({ ok: false, status: 0 }) },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {},
}))

vi.mock('./store/osKeystore', () => ({ platformKeystore: () => null }))

const { AppController } = await import('./appController')

const temps: string[] = []
const tmpDir = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `chat-${tag}-`))
  temps.push(d)
  return d
}

beforeEach(() => {
  paths.userData = tmpDir('profile')
  paths.temp = tmpDir('temp')
})

afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('AppController.setSettings — telling the live session', () => {
  it('announces the change to ChatService so a silent beacon can re-decide', () => {
    const c = new AppController(() => null)
    const calls: boolean[] = []
    c.chat = {
      onSettingsChanged: () => calls.push(c.getSettings().alwaysOnline === true),
    } as unknown as ChatService

    c.setSettings({ alwaysOnline: true })
    // Announced *after* the new value is stored, so the pull seam every service
    // reads through already answers with it.
    expect(calls).toEqual([true])

    c.setSettings({ alwaysOnline: false })
    expect(calls).toEqual([true, false])
  })

  it('is harmless before a session exists', () => {
    const c = new AppController(() => null)
    expect(c.chat).toBeNull()
    expect(() => c.setSettings({ alwaysOnline: true })).not.toThrow()
  })
})
