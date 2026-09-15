// Single source of truth for team-name normalization (1.5) — the Settings
// field, the main-side IPC guard and the fold that decides which
// `team-renamed` event wins all call these, the way channelName.ts is shared
// between the sidebar's rename input and services/channels.ts.

/** Longest name a team may fold to. */
export const TEAM_NAME_MAX = 40

/**
 * Trimmed, whitespace-collapsed, control-stripped team name.
 *
 * Unlike a channel name this keeps case and spaces — "Ops Crew" is a team
 * name, not a slug — and, deliberately, it does **not** truncate: an
 * over-long name is *refused* (by {@link isValidTeamName}) rather than
 * silently cut, so what the person typed is either what the team gets or an
 * error they can see. `\p{C}` (Unicode "Other": control, format, private-use,
 * surrogate, unassigned) becomes a space before the collapse, so a bidi
 * override can't make a name render as something it isn't.
 */
export function normalizeTeamName(input: string): string {
  return input
    .replace(/\p{C}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Whether a normalized name may be published/folded: 1–40 characters. */
export function isValidTeamName(name: string): boolean {
  return name.length > 0 && name.length <= TEAM_NAME_MAX
}
