// What an OS notification says, as a pure function of the conversation kind and
// the preview setting. Extracted from ChatService.maybeNotify (1.2) because
// this is the part with the interesting matrix — three conversation kinds times
// previews on/off — and none of it needs a window, a roster, or Electron.
//
// Everything the caller cannot supply from the payload alone (the display name,
// the channel or group name, the body preview) arrives as a string, so this file
// never has to know how a message body turns into one line.

export type NotifyConvKind = 'chan' | 'dm' | 'grp'

export interface NotifyLineInput {
  kind: NotifyConvKind
  /** Display name of the author, already resolved (or a fallback like "Someone"). */
  who: string
  /** Channel or group name. Unused for a DM, and optional everywhere. */
  convName?: string | null
  /** `SettingsView.notifyPreviews` — off means no content leaves the app. */
  previews: boolean
  /** One line of the message body. Only ever used when `previews` is on. */
  snippet: string
}

export interface NotifyLine {
  title: string
  body: string
}

/**
 * With previews off, nothing about the message — not the author, not the
 * conversation, not a word of the text — reaches the notification: the title is
 * the app's name and the body says only that something arrived. A DM says so
 * because "someone messaged you directly" is the one thing that changes whether
 * people reach for the machine; a private group deliberately does not say
 * "direct message", because it isn't one.
 */
export function notifyLineFor(input: NotifyLineInput): NotifyLine {
  const { kind, who, convName, previews, snippet } = input
  if (!previews) {
    return { title: 'Chat', body: kind === 'dm' ? 'New direct message' : 'New message' }
  }
  const title =
    kind === 'grp'
      ? `${who} in 🔒 ${convName || 'private group'}`
      : kind === 'dm'
        ? who
        : `${who} in #${convName || 'channel'}`
  return { title, body: snippet }
}

// ---------------------------------------------------------------------------
// Pull requests (1.4)

/** The three moves on *my own* pull request that are worth interrupting me for. */
export type PrTransitionKind = 'changes-requested' | 'comments-open' | 'approved'

export interface PrTransitionInput {
  kind: PrTransitionKind
  /** The pull-request number, as Azure DevOps shows it. */
  id: number
  /** The pull request's own title, and the repository it sits in — the body line. */
  title: string
  repoName: string
  /** Display names of the reviewers who requested the changes. Only read for 'changes-requested'. */
  by: string[]
  /** Unresolved threads. Only read for 'comments-open'. */
  openThreads: number
}

/** "Ana" · "Ana and Bob" · "Ana and 2 others" — never a comma salad in a toast title. */
function nameList(names: string[]): string {
  const list = names.filter((n) => n.trim() !== '')
  if (list.length === 0) return ''
  if (list.length === 1) return list[0]
  if (list.length === 2) return `${list[0]} and ${list[1]}`
  return `${list[0]} and ${list.length - 1} others`
}

/**
 * What the app says when one of my own pull requests moves: someone blocked it,
 * someone left comments on it, or it is finally ready to complete. The title
 * carries the news and the body identifies the pull request, which is the other
 * way round from an arriving PR ("Pull request #42 · api" / "title — author")
 * — for my own work the *change* is the surprising part, not which PR it is.
 *
 * Unlike a message, nothing here is a preview of someone's writing: it is the
 * state of my own pull request, so `notifyPreviews` does not apply.
 */
export function prTransitionLine(input: PrTransitionInput): NotifyLine {
  const body = `${input.title} · ${input.repoName}`
  if (input.kind === 'approved') {
    return { title: `Your PR #${input.id} is approved — ready to complete`, body }
  }
  if (input.kind === 'comments-open') {
    const n = Math.max(1, input.openThreads)
    return { title: `Your PR #${input.id} has ${n} open comment${n === 1 ? '' : 's'}`, body }
  }
  const who = nameList(input.by)
  return { title: `Your PR #${input.id} — changes requested${who ? ` by ${who}` : ''}`, body }
}
