// Whether the composer's inline quick-reply chip row should render. Pure —
// no Electron, no DOM — so Composer.tsx and its tests agree on the same rule
// without mounting React.
//
// Two reasons to hide it: a draft is in progress (the row would otherwise
// shove the textarea up/down mid-typing, right when it matters least), or
// the active conversation cannot be sent to at all. Team conversations
// (`team:` convs — the calendar and PR panes) are the only kind of that
// today, and the shell never even mounts a composer for them (see
// AppShell.tsx's `convKind === 'team'` branch) — but the rule stays
// conv-aware rather than assuming that forever.

import type { ConvId } from './types'
import { isTeamConv } from './ids'

export function showQuickReplies(conv: ConvId, text: string): boolean {
  return text.length === 0 && !isTeamConv(conv)
}
