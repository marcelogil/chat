import { describe, expect, it, vi } from 'vitest'

// The renderer is sandboxed web code and its input is untrusted; this slice is
// the boundary. The 1.4 thresholds are the interesting part: `undefined` means
// "keep whatever the team already agreed on", so anything that is not a real
// number has to arrive as `undefined` rather than as 0, NaN or a string that
// would sail through `typeof v === 'number'`-free code further in.

const handlers = new Map<string, (event: unknown, ...args: never[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle(channel: string, fn: (event: unknown, ...args: never[]) => unknown) {
      handlers.set(channel, fn)
    },
  },
}))

import type { BrowserWindow } from 'electron'
import type { AppController } from '../appController'
import { registerPrsIpc } from './prsIpc'

type SaveInput = Parameters<NonNullable<AppController['prs']>['saveConfig']>[0]

function rig(): { saved: SaveInput[]; save(input: unknown): Promise<void> } {
  handlers.clear()
  const saved: SaveInput[] = []
  const controller = {
    prs: {
      async saveConfig(input: SaveInput) {
        saved.push(input)
      },
    },
  } as unknown as AppController
  registerPrsIpc(controller, () => null as unknown as BrowserWindow)
  const handler = handlers.get('prs:saveConfig')!
  return {
    saved,
    async save(input: unknown) {
      await (handler(null, input as never) as Promise<void>)
    },
  }
}

const BASE = {
  baseUrl: 'https://dev.azure.com/acme',
  project: 'Proj',
  repos: [{ id: 'r1', name: 'api' }],
  token: '',
  shareToken: false,
}

describe('prsIpc — the thresholds crossing the bridge', () => {
  it('passes a real number straight through', async () => {
    const r = rig()
    await r.save({ ...BASE, reviewSlaHours: 48, staleAfterDays: 3 })
    expect([r.saved[0].reviewSlaHours, r.saved[0].staleAfterDays]).toEqual([48, 3])
  })

  it('turns anything that is not a number into undefined — keep the team value, never coerce', async () => {
    for (const bad of ['48', NaN, null, Infinity, true, {}, []]) {
      const r = rig()
      await r.save({ ...BASE, reviewSlaHours: bad, staleAfterDays: bad })
      expect(r.saved[0].reviewSlaHours).toBeUndefined()
      expect(r.saved[0].staleAfterDays).toBeUndefined()
    }
  })

  it('leaves an absent threshold absent', async () => {
    const r = rig()
    await r.save(BASE)
    expect('reviewSlaHours' in r.saved[0]).toBe(true) // the key is always built…
    expect(r.saved[0].reviewSlaHours).toBeUndefined() // …but carries nothing
  })

  it('still sanitizes the rest of the payload around them', async () => {
    const r = rig()
    await r.save({
      baseUrl: '  https://dev.azure.com/acme  ',
      project: ' Proj ',
      repos: [{ id: 'r1', name: 'api' }, { id: '', name: 'nameless' }, 'junk'],
      token: ' pat ',
      shareToken: 'yes',
      reviewSlaHours: 12,
    })
    expect(r.saved[0]).toMatchObject({
      baseUrl: 'https://dev.azure.com/acme',
      project: 'Proj',
      repos: [{ id: 'r1', name: 'api' }],
      token: 'pat',
      shareToken: false, // only a literal true shares the token
      reviewSlaHours: 12,
    })
  })
})
