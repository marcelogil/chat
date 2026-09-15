# Contract changes during 1.5 implementation

Deviations from the 1.5 contract that was already in the tree when the work
started (`TEAM_CONV.settings`, `SysPayload` `team-renamed`, the `team` push,
`bridge.team.rename`, `SettingsView.easterEggs`/`alwaysOnline`). Each entry says
what moved, why, and what a reviewer should check.

---

## 2026-09-15 — `SelfView.teamName` is the folded name; `protocol.json` keeps its original

**Team rename (main + renderer).** The bridge contract did not say where the
team name comes from once anyone can change it. It is **not** rewritten on the
share: `ProtocolFile.teamName` stays exactly as the team's creator wrote it,
forever, and `SelfView.teamName` reports

```
foldTeamName(team:settings log) ?? ProtocolFile.teamName
```

Three reasons, all of them load-bearing:

- **One writer per file, ever.** `protocol.json` is written once, at team
  creation. Making every member a potential writer of the one file every client
  reads first — including a client that is mid-`healthCheck` — is the exact
  race the iron rule exists to prevent.
- **Clients cache it.** `readProtocolFile` runs at session start and nothing
  re-reads it; a rewritten file would reach nobody already in the team until
  their next launch. The same reasoning made channel rename a `sys` event in
  1.2 rather than a `channel.json.e1` rewrite.
- **Old clients.** A 1.4 client keeps showing `protocol.json`'s name — which is
  only correct because that file still says what it always said.

  *Corrected 2026-09-15, after review: an earlier draft of this bullet claimed a
  1.4 client "never derives that conv token, never polls `team/<token>/events`,
  and never sees the event". That is false, and a future maintainer adding a
  fourth `team:` conv must not rely on it.* An old client **does** ingest the
  rename: `isTeamConv` is a prefix test (`src/shared/ids.ts`), `Session.convInfo`
  derives a token for **any** `team:` conv it is handed (`teamFor()`,
  `transport/session.ts`), `sys` is in `HEADS_1_2_TYPES` so a rename head rides
  the plain section of the beacon (`transport/beacon.ts`), and the poller
  ingests plain heads for any team conv it does not recognise
  (`if (!isChanConv(conv) && !isTeamConv(conv)) continue` → `ingestHeads`,
  `transport/poller.ts`). So bob-on-1.2 reads, decrypts, verifies and stores the
  event in an in-memory `team:settings` log, and pushes it to his renderer.
  What makes it harmless is that **nothing consumes it there**: 1.2/1.4
  `foldSys` has no `team-renamed` branch, `maybeNotify` returns early for
  `isTeamConv` (so no OS notification), team logs carry no read-cursor
  bookkeeping, and no 1.4 renderer code enumerates the event map's keys, so the
  unknown conv cannot surface as a row or a badge. The compatibility argument is
  "an old client ignores the event", never "an old client never receives it".

Consequence, deliberate: **the onboarding join screen shows the original name.**
`OnboardHealth.existingTeamName` comes from `protocol.json` (there is no session
and no team key at that point, so the log cannot be read), so somebody joining a
renamed team sees the name it was created with until they are in. Renaming does
not migrate the folder, the `Chat/` directory name or the team id either.

Check: `src/main/services/teamSettings.test.ts` → "folds the rename out of the
log, because protocol.json still says the old name".

## 2026-09-15 — an over-long team name is refused, not truncated

**Shared (`src/shared/teamName.ts`).** `normalizeTeamName` trims, collapses
whitespace and strips `\p{C}`, but — unlike `normalizeChannelName`, which slices
to `CHANNEL_NAME_MAX` — it does not truncate. A name over `TEAM_NAME_MAX` (40)
is refused by `isValidTeamName`, which means `ChatService.renameTeam` throws
`invalid-name` and the fold ignores such an event outright.

A channel name is a slug and cutting it is harmless; a team name is prose, and
two clients that disagree about where to cut would disagree about the team's
name. Refusing is the only answer both sides can reach without guessing. The
Settings field caps typing at 40 anyway, so the refusal is only ever reached by
a hand-written event or a future build with a different limit.

Check: `teamSettings.test.ts` → "refuses an empty name and one over the length
limit"; `src/renderer/src/store/teamRename.test.ts` → "stays quiet for anything
the fold would refuse".

## 2026-09-15 — `ChatService.publishTeam` accepts `'sys'`, and the outbox with it

**Main-internal, not the bridge.** `publishTeam(conv, type, payload)` was
`'cal' | 'prs'`; it now also takes `'sys'` with a `SysPayload`, and `OutboxItem`'s
team arm widened to match. A team rename therefore queues and replays exactly
like a calendar entry, and `bridge.team.rename` resolves `{ queued: true }`
instead of rejecting when the folder is unreachable — the same reasoning the
calendar's `put`/`remove` are documented with (a caller told "could not save"
retries, and each press of a retry would be another event).

Note for a downgrade: a 1.4 build reading a `1.5` `outbox` secret would find an
item with `type: 'sys'` and republish it as a sys event into a conv it does not
know — harmless (the write is signed, and the event lands in a log 1.4 ingests
but never folds; see the corrected old-client note above), but worth knowing
about if the outbox shape ever grows a validator.

Check: `teamSettings.test.ts` → "queues the rename when the share is unreachable
instead of failing".

## 2026-09-15 — the rename toast is built from the event, not from the `team` push

**Renderer.** `PushMessage` `{ kind: 'team'; teamName }` carries the new name and
nothing else, and the shapes in `bridge.ts` are frozen — so it cannot say *who*
renamed the team, which the toast needs, nor whether it was us, which decides
whether there is a toast at all.

Both come from the ordinary `event` push for `TEAM_CONV.settings`, which lands
first (main folds inside the same `onEvent` callback that pushed the event):
`teamRenameNotice()` returns the sentence only for a verified `team-renamed`
event, in that conv, from somebody else, carrying a name this build would fold.
The `team` push does one thing — move `SelfView.teamName` — and is the only
thing that does it.

One extra gate, for a trap this design walks into: main replays the whole team
log through the `event` push while it catches up at session start, and on macOS
every launch goes through the unlock screen — i.e. through a session start with
the window already listening. So the toast only fires once
`eventsLoaded[team:settings]` is set (the renderer has pulled the log itself),
which makes it "something just happened" rather than "something happened once".

Check: `store/teamRename.test.ts` → "moves boot.self.teamName on the `team` push
and toasts the event once", "says nothing about a rename replayed before the log
has been pulled".

## 2026-09-15 — renderer-internal additions

- `SettingsSection` (store) gained `'team'` for the new Settings → Team pane —
  later replaced by `'admin'`, see "the team name is admin-only" below.
  Renderer-internal union; the bridge is untouched.
- `src/renderer/src/app/renamePlan.ts` is the one rename decision (normalize per
  kind, "nothing changed", home-channel refusal) now that the conversation
  header and the right rail can start the same rename the sidebar row menus
  always could. The sidebar rows keep their own inline inputs, but as of the
  post-review pass they call `planRename` too (and `convNameMax('group')` for
  the input cap), so there is one copy of the normalization rather than a third
  that happens to agree: `GROUP_NAME_MAX` now moves the row, the header and the
  rail together.
- `src/renderer/src/app/teamPane.ts` answers which pane a `team:` conv shows.
  `AppShell` asked `activeConv === TEAM_CONV.calendar ? <CalendarPane/> :
  <PrsPane/>`, which stopped being exhaustive the moment `TEAM_CONV` gained
  `settings` — a log-only conv would have rendered the pull-request pane.
  `teamPaneFor` returns `null` for a team conv with no pane and `AppShell`
  renders nothing.
- The Settings → Team (now Admin) toast distinguishes a rename from a no-op
  (`teamRenameSaveNotice` in `store/teamRename.ts`): `bridge.team.rename`
  resolves `{ queued: false }` both when it published and when the name was
  already the team's, so the pane compares against the name it had before the
  call instead of reading `queued: false` as "written".
- `IconPencil` was added to `app/icons.tsx`, and in the header it sits *inside*
  the name button rather than beside it — a revealed affordance that does
  nothing when clicked is worse than none. The right rail's equivalent is a real
  `IconButton`.
- Both folds read the decrypted payload defensively (`payload` or `data` being
  `null` is ignored, not a `TypeError`): in main a throw would abort the rest of
  the `onEvent` chain, in the renderer it would take down the `onPush` handler
  for that message. A roster signature says who wrote a file, not that its
  contents are well-formed.

Check: `app/renamePlan.test.ts` → "the sidebar rows go through planRename";
`app/teamPane.test.ts`; `store/teamRename.test.ts` → "teamRenameSaveNotice",
"ignores a malformed payload…"; `services/teamSettings.test.ts` → "writes
nothing when the team already has the name that was asked for", "ignores a
malformed payload…".

## 2026-09-15 — the team name is admin-only, and the rule is enforced by the readers

**Shared + main + renderer.** The earlier entries above describe a team name
*any member* could change ("there are no admins on a shared folder"). That is
now wrong, on Gil's instruction: renaming the team is an admin act, and today
the only admin is Gil.

"Admin" cannot be a grant — there is no server to hold the list and
`protocol.json` is written once, at team creation — so it is a **display name**:

```ts
// src/shared/constants.ts
export const TEAM_ADMIN_NAMES = ['gil'] as const
```

compared trimmed and case-insensitively by `isGil` (`src/shared/gilMode.ts`,
which now reads the constant instead of spelling the name itself). That one
constant is the only place the rule is written; three surfaces read it:

1. **The panel is only listed for an admin.** `navFor()` in `SettingsModal.tsx`
   splices Settings → **Admin** in when `isGil(self.displayName)`, and the
   section body re-checks before rendering.
2. **`ChatService.renameTeam` throws `not-admin`** — before normalization, the
   no-op check, everything — when `session.displayName` is not an admin name.
   `team:rename` surfaces the rejection unchanged; the pane turns it into
   "Only Gil can rename the team" (`teamRenameFailureNotice`).
3. **The fold ignores what it must not adopt.** `foldTeamRenamed` /
   `foldTeamName` (`main/services/teamSettings.ts`) now take an
   `AuthorLookup` — `(deviceId) => { displayName, trust } | null`, which
   `ChatService` answers from the roster — and accept a `team-renamed` event
   only when the author's **roster record** says an admin name **and** the
   author's pin is **not `flagged`**.

Only (3) is enforcement. (1) and (2) are code on the writer's own machine, and
a shared folder cannot refuse a write: what stops a rename from anyone else is
that nobody folds it — including the client that wrote it. The `flagged` half
matters as much as the name half. A second device registering under a name
already pinned to somebody else is exactly what `Roster.ingest` TOFU-flags, and
it is exactly what "type Gil in the onboarding box" looks like; without it the
gate would be an honour system. (A `revoked` pin is deliberately *not* part of
the test — no other event path consults revocation, and adding a second trust
axis here only would be a rule nobody could predict. If that changes, it
changes for events generally, not for this one fold.)

Everything else about the rename is unchanged: still LWW by event id, still
signed, still refused when unverified or when the name is empty/over-long,
still queued through the outbox when the share is unreachable, still a display
overlay over `ProtocolFile.teamName`.

*Not* gated: `teamRenameNotice` in the renderer, which builds the "X renamed
the team to Y" toast. It resolves the author through `presence`, which is
beacon-driven and can be a poll behind the event; refusing to toast on a name
that has not arrived yet would silence real renames. A forged event from a
non-admin therefore still toasts once while changing nothing — cosmetic, and
the honest trade against a toast that sometimes goes missing.

Settings moved with the rule. The general **Team** section is gone, and so is
the "Just for Gil 😉" field in Profile; both now live in the one **Admin**
section, under a header line "Only Gil sees this panel.":

- **Team name** — the same field, validation and toasts (`TeamSettings.tsx`,
  kept as the panel's subcomponent since it owns the input's state). Its hint
  says only Gil can change it.
- **Always look online** — unchanged, hint and all. Still an *unenforced*
  personal setting (`SettingsView.alwaysOnline`); it is in the admin panel
  because it is Gil's, not because it is privileged.

`SettingsSection` is now `'admin'` where it was `'team'`. No bridge shape
changed, no protocol change, no new event type — a 1.4 client was already
ignoring all of this.

Check: `services/teamSettings.test.ts` → "the admin gate on the fold" (five
cases: non-admin ignored, TOFU-flagged claimant ignored, unknown author
ignored, admin accepted in any spelling and when hand-`trusted`, and a refused
event that neither wins nor moves the watermark), "refuses a rename from
anybody but an admin, and writes nothing", "ignores a rename a non-admin put on
the share anyway"; `store/teamRename.test.ts` → "teamRenameFailureNotice"; the
E2E's "alice's team.rename is refused — she is not an admin" and the Gil
instance that follows it.

## 2026-09-15 — unchanged, deliberately

- **The janitor.** `SWEEP_EVENT_ROOTS` is still `channels/`, `dm/`, `groups/`:
  `team/` is never day-swept, so a rename from two years ago survives and a cold
  start can still fold it. `team:settings` is LWW-materialized, like the
  calendar and the PR config.
- **`PROTOCOL`/`protocol.json`.** No version bump, no new field, no rewrite. A
  1.5 team folder is byte-identical to a 1.4 one until somebody renames the
  team, and then the only new thing on the share is one more directory under
  `team/` — whose name is a derived token, so it does not say what is in it.
- **Read cursors and notifications.** Team logs still carry neither: no receipt
  bookkeeping, and `maybeNotify` returns early for `isTeamConv`, so a rename is
  an in-app toast and never an OS notification.

## 2026-09-15 — the pull-request "N overdue" / "N stale" hide toggles

**Renderer-only.** Nothing under `src/main`, `src/shared` or `src/preload`
changed for this item: no bridge surface, no event type, no envelope, no write
to the share. A 1.4 client is unaffected by construction.

- **New per-device state, in `localStorage`, not on the share.**
  `sem-prs-hide-overdue` / `sem-prs-hide-stale` (`src/renderer/src/team/prsVisibility.ts`),
  written only as `'1'` and *removed* when un-hidden, so a stale `'0'` can never
  accumulate. This is what one machine's owner chose to stop looking at, not a
  team-wide decision — the same reasoning that keeps the PR *token* per device
  while `prs` config is team-scoped. Anything but `'1'` reads as not-hidden, and
  a `localStorage` that is absent or throws degrades to "everything visible".
- **`prs.markSeen` still receives the pre-hide list.** The pane's 1.5s dwell
  marks `filtered` — every PR the scope/branch/repo/search filters kept —
  *including* rows a toggle is hiding (`seenKeys` in `prsVisibility.ts`).
  This is deliberate and was briefly not the case during implementation:
  `PrsStatus.unseen` counts tracked, non-approved PRs with `seen: false`, and
  that number is the sidebar's red badge (`app/Sidebar.tsx`) and the OS dock
  badge (`team/PrAlert.tsx`). A PR can enter the tracked list *already* overdue
  (added as a required reviewer on a four-day-old PR), so it would be hidden on
  arrival; marking only what is on screen would light a badge with no UI path to
  clear it, and because the toggle persists, that badge would survive every
  restart. Hiding is "stop showing me these", not "stop counting them".
  Check: `prsVisibility.test.ts` → "keeps a hidden PR in the seen list…", and
  the E2E's "the hidden pull request is still marked seen".
- **The header counts stay on `filtered`, not on `visible`.** A count that
  dropped to 0 by being clicked would leave nothing to click back.
- **Note wording — singular at 1.** The criterion's literal text is
  `N overdue pull requests hidden — click the count to show them`; the
  implementation pluralizes, so one hidden PR reads
  `1 overdue pull request hidden — …`. Em dash is U+2014 in the code, the unit
  test and the E2E expectation.
- **A PR that is both overdue and stale produces two note lines.** One row
  disappears, "1 overdue … hidden" and "1 stale … hidden" both appear. Kept on
  purpose: the header pills count that PR twice as well (`1 overdue · 1 stale`),
  and each line names the toggle that has to be clicked to bring it back, so the
  lines answer "what is each of these buttons hiding" rather than "how many rows
  vanished".
- **`IconEyeOff`** was added to `src/renderer/src/app/icons.tsx` (the hidden
  state's glyph). Renderer-internal, like the rename stream's `IconPencil`.
- **Toggling is a pure reducer.** `toggleOverdue` / `toggleStale` are passed
  straight to `setState` and the write happens in an effect keyed on the
  resulting state, so two clicks dispatched inside one React batch compose (and
  net out to the original) instead of both reading the same render-time flag,
  and `localStorage` always agrees with what was rendered.
  Check: `prsVisibility.test.ts` → "applied twice is the identity…".

## 2026-09-15 — message easter eggs: `easterEggs` is absent from the defaults, and reduced motion outranks it

**Renderer + `src/shared/easterEggs.ts` only.** Nothing under `src/main`,
`src/preload` or the envelope changed for the eggs: no event type, no `MsgBody`
field, nothing written to the share. Detection runs on the reader, from
`body.text` of a `kind: 'text'` message, so a 1.4 client simply shows nothing
and a later build can widen the vocabulary without a format bump. The only
pre-existing bridge surface involved is `SettingsView.easterEggs?: boolean`.

Two decisions that read as deviations from the contract and are deliberate:

- **`easterEggs` is not in main's `DEFAULT_SETTINGS`** (`src/main/appController.ts`).
  The criterion says "default on", and the optional field carries that by being
  absent: every read is `settings?.easterEggs !== false`, so an untouched
  profile, a 1.4 profile and a profile written by a build that never heard of
  the field all mean *on*. Adding `easterEggs: true` to the defaults would make
  the stored file assert a value nobody chose, and a later change of default
  would then have to migrate it. It still persists once someone touches the
  toggle: `setSettings` spreads the patch verbatim and load re-spreads over the
  defaults.
  Check: `src/renderer/src/app/easterEggQueue.test.ts` → "does nothing when the
  setting is off" (the `enabled` arm the component computes with `!== false`).
- **`prefers-reduced-motion` beats the toggle, in both directions.** The OS
  switch is a hard off in `considerEgg` (`env.reducedMotion`), evaluated before
  anything is remembered, so a reduced-motion machine with `easterEggs: true`
  plays nothing *and* spends no ids — turning the OS setting off later leaves
  every message still eligible. The contract only named the setting; the
  accessibility switch outranking a novelty toggle is not negotiable.
  Check: `easterEggQueue.test.ts` → "does nothing when the OS asked for reduced
  motion".

### Eligibility lives in `src/renderer/src/chat/eggEligibility.ts`, not in the .tsx

The trigger rule ("live this session **or** unread when the conversation was
opened") was three expressions inside `EasterEggFeed.tsx`, where the node-only
vitest suite cannot reach them — and both of them were wrong:

- **A conversation with no read cursor reported nothing as unread.** `myReads`
  only gains an entry through `markRead`, so a DM you have never opened — or a
  channel you opened while it was still empty, where there is no newest message
  to mark — reports `''`. The old rule (`read !== '' && id > read`) copied the
  NEW divider, which deliberately refuses to draw on a first visit; that
  silence is a layout choice, not an eligibility one. `''` now means *every*
  message in it was unread, and the 24 h ceiling is what keeps a first visit to
  a chatty channel from throwing a party.
- **"Arrived live" could not be read off the open pane.** `loadTeam` prefetches
  every log at boot, so the baseline captured when a pane opens already
  contains messages that landed while the reader was in another conversation.
  Liveness is now recorded where it is still knowable — at the push, in
  `src/renderer/src/store/liveEvents.ts` (module state, capped at 2000 ids,
  cleared on a folder switch) — and the pane's baseline stays only as the
  answer for a log that has not finished loading.

Together these are the difference between "Carol wished me happy birthday in a
DM I had not opened" playing and being silent forever.
Check: `src/renderer/src/chat/eggEligibility.test.ts`, `store/liveEvents.test.ts`,
and the E2E's "the egg waits for him: confetti plays when he opens the
never-read channel".

### Detection strips five more non-prose shapes

`stripNonProse` now also drops `~~~` fences, inline spans delimited by a *run*
of backticks (` ``bug`` ` used to read as two empty spans with a word between
them), lines indented four spaces or a tab, email addresses, and a host pasted
with neither scheme nor `www.` (`bugs.example.com/42`). The bare-host rule
requires a TLD from a named list on purpose: a general `word.word` rule would
eat a missing space after a full stop ("great work.Congrats everyone") and
silence a real celebration, which is the worse failure of the two.
Check: `src/shared/easterEggs.test.ts` → the five new negative cases and the
two prose cases that must survive them.
