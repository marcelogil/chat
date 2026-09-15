import { TEAM_CONV } from '@shared/constants'
import { isGil } from '@shared/gilMode'
import { isValidTeamName, normalizeTeamName } from '@shared/teamName'
import type { ConvId, SysPayload, TrustState, VerifiedEvent } from '@shared/types'

// Team-wide settings (1.5). Today there is exactly one: the team's name.
//
// It rides the event log — a `team-renamed` sys event in TEAM_CONV.settings —
// for the same reason a channel rename does: protocol.json is written once, at
// team creation, by whoever created the team, and every client caches it
// forever. Rewriting it would reach nobody who is already in the team and
// would break the one-writer-per-file rule on the one file every client reads
// first. The folded name is therefore a *display overlay* over
// `ProtocolFile.teamName`, which never changes (see docs/contract-changes-1.5.md).
//
// Folding is last-writer-wins by event id — the stem sorts in HLC order, so
// every client picks the same winner regardless of the order files arrive in.
//
// And it is admin-gated (1.5): only a rename written by an admin device counts.
// That test lives in `renamedName` below, and it is the *only* place the rule is
// enforced rather than merely offered — see the note there.

/**
 * What the roster says about the device that wrote an event — the two facts the
 * admin gate needs. `null` when the author is not on the roster at all (which a
 * verified event cannot be: verification is what puts them there).
 */
export interface EventAuthor {
  displayName: string
  trust: TrustState
}

/** Look an event's `author` (deviceId) up in the roster. */
export type AuthorLookup = (deviceId: string) => EventAuthor | null

/** The winning `team-renamed` so far: what it said, and which event said it. */
export interface TeamNameFold {
  name: string
  /** Event id (stem) of the winning rename — the LWW comparison key. */
  stem: string
  /** deviceId that published it, for "Ana renamed the team to …". */
  author: string
}

/**
 * Whether this event is a team rename that counts at all: a verified `sys`
 * event in TEAM_CONV.settings, written by an admin, carrying a name that
 * survives normalization and fits the length limit. Unverified events are
 * ignored outright — anyone who can write to the share can drop a file into
 * `team/<token>/events`, and only a signature from a roster device makes it the
 * team's decision.
 *
 * The admin gate (1.5) is enforced *here*, on the reading side, not only in the
 * Settings pane that offers the field and in `ChatService.renameTeam` that
 * refuses to publish: both of those are code on the writer's own machine, and a
 * shared folder has no way to stop someone from writing a file. What stops them
 * is that nobody else folds it.
 *
 * Two conditions, and both are about the *name*:
 *   - the author's roster record says an admin name (`TEAM_ADMIN_NAMES`);
 *   - the author's pin is not `flagged`. A second device that registers under
 *     a name already pinned to somebody else is TOFU-flagged (`Roster.ingest`)
 *     — which is exactly what someone claiming to be Gil in order to rename the
 *     team would look like. Without this, the gate would be "type Gil in the
 *     onboarding box".
 */
function renamedName(conv: ConvId, event: VerifiedEvent, authorOf: AuthorLookup): string | null {
  if (conv !== TEAM_CONV.settings) return null
  if (event.type !== 'sys' || !event.verified) return null
  const author = authorOf(event.author)
  if (!author || !isGil(author.displayName)) return null
  if (author.trust === 'flagged') return null
  // A decrypted payload is whatever the writer put in the file, and a roster
  // signature only says *who* wrote it: an insider or a future/buggy build can
  // hand us `null`, or a `data` that is not an object. `null.kind` here would
  // throw inside the `onEvent` fan-out and skip every listener queued behind
  // this one, so both hops are read defensively rather than trusted.
  const p = event.payload as unknown as SysPayload | null
  if (!p || p.kind !== 'team-renamed') return null
  const raw = (p.data as { name?: unknown } | null)?.name
  if (typeof raw !== 'string') return null
  const name = normalizeTeamName(raw)
  // Refused, not truncated: a writer that publishes 200 characters disagrees
  // with this build about what a team name is, and guessing at what they meant
  // would leave two clients showing different names for the same event.
  return isValidTeamName(name) ? name : null
}

/**
 * Fold one event into the current team-name state. Returns the new fold when
 * it changed something, or `null` when the event doesn't count or loses the
 * last-writer-wins comparison (the caller then pushes nothing).
 */
export function foldTeamRenamed(
  current: TeamNameFold | null,
  conv: ConvId,
  event: VerifiedEvent,
  authorOf: AuthorLookup,
): TeamNameFold | null {
  const name = renamedName(conv, event, authorOf)
  if (name === null) return null
  // `<=` so a replayed copy of the winning event is not a change either.
  if (current && event.id <= current.stem) return null
  if (current && current.name === name) {
    // A newer event that says the same thing still advances the watermark —
    // otherwise an older rename arriving afterwards could win a comparison it
    // should lose — but there is nothing to tell the UI about.
    current.stem = event.id
    current.author = event.author
    return null
  }
  return { name, stem: event.id, author: event.author }
}

/** Fold a whole log at once (cold start, tests). Null when nobody renamed it. */
export function foldTeamName(
  conv: ConvId,
  events: Iterable<VerifiedEvent>,
  authorOf: AuthorLookup,
): TeamNameFold | null {
  let fold: TeamNameFold | null = null
  for (const ev of events) {
    const next = foldTeamRenamed(fold, conv, ev, authorOf)
    if (next) fold = next
  }
  return fold
}

/** The payload a rename publishes. Built here so main and its tests agree. */
export function teamRenamePayload(name: string): SysPayload {
  return { t: 'sys', conv: TEAM_CONV.settings, kind: 'team-renamed', data: { name } }
}
