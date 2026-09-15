import { CHANNEL_NAME_MAX, normalizeChannelName } from '@shared/channelName'

// What a submitted rename should do (1.5). The sidebar row menus have always
// decided this inline; the conversation header can now start the same rename,
// so the decision lives here — one normalization, one "nothing changed"
// answer, one refusal for the home channel — instead of a second copy that can
// drift (exactly the drift channelName.ts was created to end).

/** Longest name a private group may take — the sidebar's rename input cap. */
export const GROUP_NAME_MAX = 60

export { CHANNEL_NAME_MAX }

export type RenameKind = 'channel' | 'group'

export type RenamePlan =
  /** Nothing to publish: an empty name, or the name it already has. */
  | { action: 'none' }
  | { action: 'rename'; name: string }
  /** The rule that says this conversation can never be renamed. */
  | { action: 'refuse'; reason: string }

/** The team's home channel can't be renamed or deleted (1.2) — said once, here. */
export const FIXED_CHANNEL_REFUSAL = "Home channel — can't be renamed or deleted."

/** Normalize `input` the way this kind of conversation is normalized. */
export function normalizeConvName(kind: RenameKind, input: string): string {
  return kind === 'channel' ? normalizeChannelName(input) : input.trim().slice(0, GROUP_NAME_MAX)
}

/** The cap a rename input should carry for this kind of conversation. */
export function convNameMax(kind: RenameKind): number {
  return kind === 'channel' ? CHANNEL_NAME_MAX : GROUP_NAME_MAX
}

/**
 * Decide what a submitted rename does. `fixed` is the home-channel flag from
 * `ChannelView`; it is refused here as well as in main, so a header pencil can
 * never offer what `ChatService.renameChannel` would reject.
 */
export function planRename(input: {
  kind: RenameKind
  current: string
  input: string
  fixed?: boolean
}): RenamePlan {
  if (input.kind === 'channel' && input.fixed) return { action: 'refuse', reason: FIXED_CHANNEL_REFUSAL }
  const name = normalizeConvName(input.kind, input.input)
  if (!name || name === input.current) return { action: 'none' }
  return { action: 'rename', name }
}
