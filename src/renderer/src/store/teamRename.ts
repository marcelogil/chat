import { TEAM_CONV } from '@shared/constants'
import { isValidTeamName, normalizeTeamName } from '@shared/teamName'
import type { ConvId, SysPayload, VerifiedEvent } from '@shared/types'

// The in-app notice for a team rename (1.5). The `team` push carries the new
// name but deliberately not who set it — the bridge's PushMessage shapes are
// frozen — so the toast is built from the event itself, which the ordinary
// `event` push delivers into the store first. Pure, so the rule that keeps the
// renamer from toasting themselves is testable without a window.

/**
 * "Ana renamed the team to Ops Crew", or null when this event is not a team
 * rename worth announcing: a different conversation, an unverified file (anyone
 * who can write to the share can drop one in), a name this build refuses, or
 * our own rename — the renamer already sees the new name in the sidebar.
 */
export function teamRenameNotice(input: {
  conv: ConvId
  event: VerifiedEvent
  selfDeviceId: string
  nameOf: (deviceId: string) => string
}): string | null {
  const { conv, event, selfDeviceId, nameOf } = input
  if (conv !== TEAM_CONV.settings) return null
  if (event.type !== 'sys' || !event.verified) return null
  if (event.author === selfDeviceId) return null
  // Same defensive read as the fold in main (services/teamSettings.ts): a
  // payload that is `null`, or whose `data` is, must be ignored rather than
  // throw — this runs inside the store's `onPush` switch, where a throw takes
  // the whole push handler down with it.
  const p = event.payload as unknown as SysPayload | null
  if (!p || p.kind !== 'team-renamed') return null
  const raw = (p.data as { name?: unknown } | null)?.name
  if (typeof raw !== 'string') return null
  const name = normalizeTeamName(raw)
  // Same refusal as the fold in main (services/teamSettings.ts): a name this
  // client would not adopt must not be announced as if it had been.
  if (!isValidTeamName(name)) return null
  return `${nameOf(event.author)} renamed the team to ${name}`
}

/**
 * What Settings → Admin says after `bridge.team.rename` resolves. `{ queued }`
 * is the whole answer the bridge gives (its shape is frozen), and
 * `queued: false` means only "nothing is waiting" — `ChatService.renameTeam`
 * also returns it, without publishing anything, when the requested name is
 * already the team's name. Comparing against the name we had before the call
 * is what separates "renamed" from "was already called that", so a no-op can
 * never report a success that never happened.
 */
export function teamRenameSaveNotice(input: { before: string; name: string; queued: boolean }): {
  text: string
  tone: 'info' | 'success'
} {
  const { before, name, queued } = input
  if (queued) return { text: `The team folder is unreachable — "${name}" will be saved when it is back.`, tone: 'info' }
  if (before === name) return { text: `The team is already called ${name}.`, tone: 'info' }
  return { text: `Team renamed to ${name}`, tone: 'success' }
}

/**
 * What Settings → Admin says when `bridge.team.rename` *rejects*. One error is
 * worth naming: the admin gate (1.5). `ChatService.renameTeam` throws
 * `not-admin` for anybody but Gil, and since the panel is only shown to Gil,
 * seeing it means the display name on this device is not the one the team
 * pinned — "could not rename the team — not-admin" would be a riddle.
 *
 * Matched as a substring because the message arrives through the IPC bridge,
 * which wraps it in its own "Error invoking remote method …" prefix.
 */
export function teamRenameFailureNotice(message: string): string {
  if (message.includes('not-admin')) return 'Only Gil can rename the team'
  return `Could not rename the team — ${message}`
}
