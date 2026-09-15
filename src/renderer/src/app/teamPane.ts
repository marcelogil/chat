import { TEAM_CONV } from '@shared/constants'
import type { ConvId } from '@shared/types'

// Which team pane a `team:` conversation shows (1.5). AppShell used to ask
// `activeConv === TEAM_CONV.calendar ? <CalendarPane/> : <PrsPane/>`, which was
// exhaustive while `TEAM_CONV` had exactly two members. It grew a third
// (`settings`, the team-name log), so that two-way choice silently became
// "calendar, or else pull requests" — `team:settings` would have rendered the
// PR pane. Nothing routes there today (the sidebar and the quick switcher list
// only the two panes), but the next `team:` conv shouldn't have to notice.

export type TeamPane = 'calendar' | 'prs'

/**
 * The pane for a team conv, or `null` for a `team:` conv that has no pane —
 * a log-only conversation like `TEAM_CONV.settings`, or one from a newer build.
 * The caller renders nothing in that case rather than guessing.
 */
export function teamPaneFor(conv: ConvId | null): TeamPane | null {
  if (conv === TEAM_CONV.calendar) return 'calendar'
  if (conv === TEAM_CONV.prs) return 'prs'
  return null
}
