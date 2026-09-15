import { TEAM_ADMIN_NAMES } from './constants'

// The "Just for Gil" gate (1.5) — now also the admin gate.
//
// It started as one joke: `SettingsView.alwaysOnline` is a normal, unenforced
// setting, offered only to the one person it is a joke about. Settings → Admin
// grew out of the same check, so this is now the rule that decides who may
// rename the team as well — and, unlike the toggle, that one is enforced on the
// share side too (`ChatService.renameTeam`, the fold in
// `main/services/teamSettings.ts`). All three read `TEAM_ADMIN_NAMES`.
//
// Pulled out into its own module so it can be tested without rendering
// SettingsModal.tsx (vitest here is node-only, .ts only).

/**
 * Whether `displayName` is an admin — today, exactly Gil. Case- and
 * whitespace-insensitive, but not a prefix match: "Gil Silva" is a different
 * person, not Gil with a surname.
 */
export function isGil(displayName: string | null | undefined): boolean {
  const name = (displayName ?? '').trim().toLowerCase()
  return (TEAM_ADMIN_NAMES as readonly string[]).includes(name)
}
