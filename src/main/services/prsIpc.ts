import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { PrsRepo } from '@shared/types'
import type { AppController } from '../appController'

// Pull-request-group IPC slice. Reading the config is not an RPC — it is the
// `team:prs` event log — so everything here is either a projection of the
// service's live state or a write.
//
// The renderer is sandboxed web code and its input is untrusted: base URLs go
// through normalizeBaseUrl (inside PrService, which owns the canonical form),
// tokens are trimmed, repos are rebuilt field by field as {id,name} strings and
// keys are filtered to strings. Nothing reaches the share or the network shaped
// the way the renderer handed it over.

const MAX_STR = 200
const MAX_REPOS = 200
const MAX_KEYS = 2000

function text(v: unknown, max = MAX_STR): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

function repos(v: unknown): PrsRepo[] {
  if (!Array.isArray(v)) return []
  const out: PrsRepo[] = []
  for (const r of v.slice(0, MAX_REPOS)) {
    if (!r || typeof r !== 'object') continue
    const id = text((r as PrsRepo).id)
    const name = text((r as PrsRepo).name)
    if (id && name) out.push({ id, name })
  }
  return out
}

/** A renderer-supplied number, or undefined for anything that is not one (1.4). */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function keys(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.slice(0, MAX_KEYS).filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= MAX_STR)
}

export function registerPrsIpc(controller: AppController, getWindow: () => BrowserWindow | null): void {
  void getWindow // the PR service holds its own window handle (OS notifications)

  const prs = () => {
    const p = controller.prs
    if (!p) throw new Error('not-ready')
    return p
  }

  ipcMain.handle('prs:status', () => prs().status())
  ipcMain.handle('prs:list', () => prs().list())
  ipcMain.handle('prs:refresh', async () => {
    await prs().refresh()
  })
  ipcMain.handle('prs:markSeen', (_e, input: string[]) => {
    prs().markSeen(keys(input))
  })

  ipcMain.handle('prs:testConnection', (_e, input: { baseUrl: string; token: string }) =>
    prs().testConnection({ baseUrl: text(input?.baseUrl, 2048), token: text(input?.token, 1024) }),
  )

  ipcMain.handle('prs:listRepos', (_e, input: { baseUrl: string; token: string; project: string }) =>
    prs().listRepos({
      baseUrl: text(input?.baseUrl, 2048),
      token: text(input?.token, 1024),
      project: text(input?.project),
    }),
  )

  ipcMain.handle(
    'prs:saveConfig',
    async (
      _e,
      input: {
        baseUrl: string
        project: string
        repos: PrsRepo[]
        token: string
        shareToken: boolean
        reviewSlaHours?: number
        staleAfterDays?: number
      },
    ) => {
      await prs().saveConfig({
        baseUrl: text(input?.baseUrl, 2048),
        project: text(input?.project),
        repos: repos(input?.repos),
        token: text(input?.token, 1024),
        shareToken: input?.shareToken === true,
        // Left undefined when absent so the service keeps the team's current
        // value; a present-but-nonsense number is refused there, not coerced.
        reviewSlaHours: num(input?.reviewSlaHours),
        staleAfterDays: num(input?.staleAfterDays),
      })
    },
  )

  ipcMain.handle('prs:setPersonalToken', (_e, token: string | null) => {
    prs().setPersonalToken(typeof token === 'string' ? text(token, 1024) || null : null)
  })

  ipcMain.handle('prs:disconnect', async () => {
    await prs().disconnect()
  })
}
