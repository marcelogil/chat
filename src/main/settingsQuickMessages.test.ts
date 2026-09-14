import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_QUICK_MESSAGES, QUICK_MESSAGE_LIMITS } from '@shared/quickMessages'

// The main side's half of the quick-reply cap. `setSettings` is a blind spread
// for every other setting — quick messages are the only one that arrives as a
// list, so they are the only one that can arrive over-long (a renderer from an
// older build, a patch assembled anywhere but the Settings editor). What lands
// in settings.json has to be something the chip row can render in one line.

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

function controller(): InstanceType<typeof AppController> {
  const c = new AppController(() => null)
  ;(c as unknown as { startSession: (cfg: unknown) => Promise<void> }).startSession = async () => {}
  return c
}

const persisted = (): { quickMessages?: string[] | null } =>
  JSON.parse(readFileSync(join(paths.userData, 'settings.json'), 'utf8')) as { quickMessages?: string[] | null }

describe('AppController.setSettings — quick messages', () => {
  it('caps an over-long list at maxEntries, in memory and on disk', () => {
    const c = controller()
    const forty = Array.from({ length: 40 }, (_, i) => `msg ${i}`)
    const out = c.setSettings({ quickMessages: forty })
    expect(out.quickMessages).toEqual(['msg 0', 'msg 1', 'msg 2', 'msg 3', 'msg 4'])
    expect(out.quickMessages?.length).toBe(QUICK_MESSAGE_LIMITS.maxEntries)
    expect(persisted().quickMessages).toEqual(out.quickMessages)
    expect(c.getSettings().quickMessages).toEqual(out.quickMessages)
  })

  it('trims, truncates and drops blanks before they can reach the row', () => {
    const c = controller()
    const out = c.setSettings({ quickMessages: ['  Brb  ', '', '   ', 'x'.repeat(400)] })
    expect(out.quickMessages).toEqual(['Brb', 'x'.repeat(QUICK_MESSAGE_LIMITS.maxChars)])
  })

  it('stores a list that cleans away to nothing as null (= the defaults)', () => {
    const c = controller()
    expect(c.setSettings({ quickMessages: ['', '  '] }).quickMessages).toBeNull()
    expect(persisted().quickMessages).toBeNull()
  })

  it('keeps null (reset to defaults) and leaves every other setting a blind spread', () => {
    const c = controller()
    c.setSettings({ quickMessages: DEFAULT_QUICK_MESSAGES })
    const out = c.setSettings({ quickMessages: null, status: 'back at 3' })
    expect(out.quickMessages).toBeNull()
    expect(out.status).toBe('back at 3')
  })

  it('leaves quick messages untouched when the patch does not mention them', () => {
    const c = controller()
    c.setSettings({ quickMessages: ['On it 👀', 'LGTM ✅'] })
    const out = c.setSettings({ fontSize: 'L' })
    expect(out.quickMessages).toEqual(['On it 👀', 'LGTM ✅'])
    expect(out.fontSize).toBe('L')
  })
})
