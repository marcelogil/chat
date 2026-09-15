# Chat 1.5 — admin panel, header renaming, easter eggs, PR header toggles, daily calendar toast

Documented at the level of `docs/features-1.4.md`. Read `CLAUDE.md` first — the
iron rules that matter most here: **one writer per file, ever**, which is why
`protocol.json` is never rewritten and a team rename is a folded event
instead; and **envelope discipline stays wire-invisible where nothing changed
it** — the easter eggs are detected entirely on the reader from `body.text`,
and neither the PR header toggles nor the daily calendar toast write anything
to the share at all.

`docs/contract-changes-1.5.md` records, dated, every place the shipped code
deviated from the contract that was already in the tree when the work
started — the admin gate on team rename is the big one; every entry there is
authoritative and this document states the shipped versions, following it.
Where this doc and that file disagree, the code — and
`contract-changes-1.5.md` — win.

## 1. Admin panel

Settings gained a section, **Admin**, visible to exactly one display name.

### Who is an admin

```ts
// src/shared/constants.ts
export const TEAM_ADMIN_NAMES = ['gil'] as const
```

`isGil` (`src/shared/gilMode.ts`) is the one predicate every surface reads:
trimmed and lower-cased before the comparison, so "Gil", " GIL ", and "gil"
all match, but "Gil Silva" does not — it is not a prefix match. There is no
server to hold a list of admins and `protocol.json` is written once, at team
creation, so "admin" cannot be a grant; it is a display name, and the one
constant above is the only place the rule is written. Three surfaces read it:

1. **The nav.** `navFor()` in `src/renderer/src/app/SettingsModal.tsx` splices
   `{ id: 'admin', label: 'Admin' }` into the left nav only when
   `isGil(self.displayName)`; the section body re-checks `isGil` before
   rendering, so a stale `openSettings('admin')` deep-link on somebody else's
   machine cannot reach it either.
2. **`ChatService.renameTeam`** (`src/main/services/chatService.ts`) throws
   `not-admin` before normalization, before the no-op check, before anything
   else, when `session.displayName` is not an admin name.
3. **The fold** — `foldTeamRenamed`/`renamedName` in
   `src/main/services/teamSettings.ts` — accepts a `team-renamed` event only
   when the author's **roster record** says an admin name *and* the author's
   pin is not `flagged`.

Only (3) is enforcement. A shared folder cannot stop anyone from writing a
file; what stops a rename from a non-admin is that nobody else folds it,
including the writer's own client on replay. The `flagged` half is not
decorative: a second device registering under a name already pinned to
someone else is exactly what TOFU flags (`Roster.ingest`), and it is exactly
what "type Gil in the onboarding box" looks like — without checking it the
gate would be an honour system. A `revoked` pin is deliberately **not**
consulted here (see CLAUDE.md's deferred list).

### The team name field

The panel holds one field, `TeamSettings.tsx`, under a header line "Only Gil
sees this panel.":

- Renaming publishes a `team-renamed` **sys event in `team:settings`**
  (`TEAM_CONV.settings`), not a `protocol.json` rewrite. `protocol.json` is
  written once, at team creation, and every client caches it for the life of
  the session — rewriting the one file every client reads first is the exact
  race the one-writer rule exists to prevent, and a rewrite would reach
  nobody already in the team until their next launch anyway.
- Folding is **last-writer-wins by event id** (`foldTeamRenamed`/
  `foldTeamName`): the id sorts in HLC order, so every client that has seen
  the same events picks the same winner regardless of arrival order. A newer
  event that happens to say the same name still advances the watermark
  without generating a UI notice, so an older rename arriving late can never
  win a comparison it should lose.
- `SelfView.teamName` (what the sidebar and Settings show) is
  `foldTeamName(team:settings log) ?? ProtocolFile.teamName` — a **display
  overlay**. `ProtocolFile.teamName` never changes; `ChatService.teamName()`
  returns the fold if one exists, otherwise the name the team was created
  with.
- **An over-long name is refused, not truncated.** `normalizeTeamName`
  (`src/shared/teamName.ts`) trims, collapses whitespace, and strips `\p{C}`,
  but — unlike `normalizeChannelName`, which slices — does not cut a name
  down to size. A name over `TEAM_NAME_MAX` (40) fails `isValidTeamName`,
  which makes `ChatService.renameTeam` throw `invalid-name` and makes the
  fold ignore such an event outright: two clients that disagreed about where
  to cut would disagree about the team's name, so refusing is the only answer
  both sides can reach without guessing. The Settings input caps typing at 40
  characters anyway.
- `bridge.team.rename(name)` resolves `{ queued: boolean }`. `queued: true`
  means the share was unreachable and the rename went into the outbox
  (`ChatService.publishTeam` now accepts `'sys'` alongside `'cal'`/`'prs'`,
  and the outbox's team arm widened to match) — a rename queues and replays
  like a calendar entry rather than rejecting, the same reasoning the
  calendar's `put`/`remove` use. `queued: false` means only "nothing is
  waiting": it is also what a **no-op** rename returns (asking for the name
  the team already has), so the pane (`teamRenameSaveNotice` in
  `src/renderer/src/store/teamRename.ts`) compares the name it asked for
  against the name it had *before* the call to tell "renamed" apart from
  "already called that" — `queued: false` alone is not proof anything was
  written.
- The failure a caller is actually likely to see is the admin gate:
  `teamRenameFailureNotice` turns a `not-admin` message into "Only Gil can
  rename the team" rather than showing the raw error code.
- **The toast other clients see** ("Ana renamed the team to Ops Crew") is
  built from the ordinary `event` push for `TEAM_CONV.settings`
  (`teamRenameNotice`), not from the `team` push — `PushMessage`'s
  `{ kind: 'team'; teamName }` shape is frozen and cannot say who renamed it,
  or whether it was this device. It fires only from somebody else, only for a
  verified event this build would fold, and — because main replays the whole
  team log at every session start (including behind macOS's unlock screen,
  which is *every* launch) — only once `eventsLoaded['team:settings']` is set,
  so a rename from before this session started never toasts as if it just
  happened. The renamer themselves is never toasted about their own rename;
  they already see the new name in the sidebar.
- Also unenforced but in the same panel because it's Gil's: **"Always look
  online"** (`SettingsView.alwaysOnline`) — see the always-online section
  below.

### What an older client does

**Consequence, deliberate: the onboarding join screen shows the original
name.** `OnboardHealth.existingTeamName` comes from `protocol.json` — there is
no session and no team key yet, so the log cannot be read — so somebody
joining a renamed team sees the name it was created with until they're in.
Renaming never touches the folder name, the `Chat/` directory, or the team id.

What a **1.4 (or 1.1–1.3) client** does with the rename event is more
specific than "it ignores it," and worth getting exactly right for a future
maintainer adding a fourth `team:` conv: an old client **does** ingest it.
`isTeamConv` is a prefix test (`src/shared/ids.ts`), `Session.convInfo`
derives a token for any `team:` conv it is handed at all (`teamFor()`,
`src/main/transport/session.ts`), `sys` is one of `HEADS_1_2_TYPES` so a
rename head rides the plain (unsealed) section of the beacon
(`src/main/transport/beacon.ts`), and the poller ingests plain heads for any
team conv it doesn't specifically recognise
(`if (!isChanConv(conv) && !isTeamConv(conv)) continue` in `ingestHeads`,
`src/main/transport/poller.ts`). So an old client reads, decrypts, verifies,
and stores the event in an in-memory `team:settings` log, and pushes it to
its renderer. What makes that harmless is that **nothing consumes it there**:
old `foldSys` has no `team-renamed` branch, `maybeNotify` returns early for
`isTeamConv` (no OS notification), team logs carry no read-cursor
bookkeeping, and no old renderer code enumerates the event map's keys — so
the unknown conv cannot surface as a row or a badge. The compatibility claim
is "an old client ignores the event," never "an old client never receives
it." (An earlier draft of the contract note made the stronger, false claim;
`docs/contract-changes-1.5.md` records the correction.)

Nothing about `PROTOCOL`/`protocol.json` changed: no version bump, no new
field. A 1.5 team folder is byte-identical to a 1.4 one until somebody
renames the team, and then the only new thing on the share is one more
directory under `team/` — named by a derived token (`convToken`), so its name
does not say what's inside. The janitor's `SWEEP_EVENT_ROOTS` is still
`channels/`, `dm/`, `groups/` — `team/` is never day-swept, so a rename from
years ago still folds on a cold start.

### Always-online, precisely

`SettingsView.alwaysOnline` is Gil's toggle, offered only because the panel
is his — it is not enforced anywhere, and setting it by hand on someone
else's profile would work exactly as well; the actual gate is which display
name gets to see the toggle at all.

**What the beacon publishes, per tier**
(`src/main/transport/beacon.ts`):

- `publishedPresence` is the presence teammates actually read: the truthful
  state, with the override applied. While `keepingGreen()` is true it reports
  `{ ...presence, state: 'online', idleSec: 0 }` regardless of the real idle
  tier; otherwise it reports the truthful presence untouched.
- `keepingGreen()` is `getAlwaysOnline() && presence.state !== 'offline'` —
  **appear-offline always wins.** Choosing "Appear offline" while
  always-online is on stops the override outright; there is nothing left to
  keep looking online.
- The setting is re-read fresh on every heartbeat decision and every publish
  (the same seam `chatService`/`prService` use elsewhere), so *content*
  follows a toggle flip on the very next beacon by itself.

**The paused-tier heartbeat rule.** Normally a `paused` tier (locked screen,
suspended machine) stops the heartbeat entirely after one goodbye beacon —
`heartbeatPlan()` returns `null`. With always-online on and appear-offline
not chosen, `heartbeatPlan()` instead returns
`{ periodMs: BEACON.idleHeartbeatMs, jitter: false }`: the *schedule* itself
has to change, because a beacon that has stopped beating has no "next beacon"
on which to silently pick up a setting flip, so flipping the toggle calls
`syncHeartbeat()` (`ChatService.onSettingsChanged`) to restart the interval
immediately. This is the one heartbeat schedule that carries **no jitter** —
`BEACON.idleHeartbeatMs` is 45 s, jitter only ever pushes a period *later*,
and 45 s against `PRESENCE.onlineWithinMs` (50 s) already leaves a peer only
~2–5 s of slack before painting a locked-but-green Gil "away" — a solo device
beating behind a lock screen has no team beacon to spread against anyway, and
its phase is already randomized by the moment the screen locked.

This device's own row reads through the same override
(`ChatService.selfPresence` calls `publishedPresence`, not the raw field) —
without that, five idle minutes would turn Gil's own dot amber while every
teammate still saw him green, the one vantage point that could have shown him
the setting wasn't working.

Not covered by the E2E script — see §6 (Tests) — always-online is unit-tested
only, in `src/main/transport/beacon.test.ts`.

## 2. Renaming from the header

Channels and private groups have always been renameable from the sidebar
row's own menu (1.2); 1.5 adds the same rename, started from the
conversation's own header, and (for groups only) from the right rail's About
tab.

- **One decision, three call sites.** `src/renderer/src/app/renamePlan.ts`'s
  `planRename({ kind, current, input, fixed })` is now the single place that
  decides what a submitted rename does — normalize per kind, treat an empty
  or unchanged name as a no-op (`{ action: 'none' }`), refuse the home
  channel (`{ action: 'refuse', reason: FIXED_CHANNEL_REFUSAL }`) — and the
  sidebar rows call it too as of the post-review pass, so there is one copy
  of the normalization instead of a second (or third) that happens to agree.
  `GROUP_NAME_MAX` (60) now moves the sidebar row, the header, and the right
  rail together; `convNameMax(kind)` gives the input its `maxLength`.
- **`ConvRenameInput`** (`src/renderer/src/app/ConvRename.tsx`) is the shared
  inline-edit control: focus + select on mount, Enter or blur submits,
  Escape cancels, a `done` ref stops a double-submit when blur-to-submit
  fires again as the input unmounts behind a dialog. On submit it calls
  `window.bridge.chat.renameChannel` or `window.bridge.groups.rename`
  depending on `kind`; a refusal toasts the reason instead of calling the
  bridge at all.
- **The header** (`src/renderer/src/app/ChannelHeader.tsx`). `HeaderName`
  renders the conversation's name as a button with a pencil (`IconPencil`)
  sitting *inside* it — deliberately, since a revealed affordance that does
  nothing when clicked is worse than no affordance — for both channels and
  groups. **The home channel keeps a plain, non-interactive label**, its
  tooltip carrying `FIXED_CHANNEL_REFUSAL`: `"Home channel — can't be renamed
  or deleted."`
- **The right rail** (`src/renderer/src/app/RightRail.tsx`) offers the same
  inline rename only for a **group**, in its About tab, behind a real
  `IconButton` (not text-embedded like the header's); the channel side of
  that tab is read-only — it shows the topic and the plain `#name`, with no
  rename affordance at all. Any member may rename a private group; there is
  no owner-only gate on this, unlike adding or removing members.

## 3. Easter eggs

A message containing certain words plays a full-window animation for anyone
who actually sees it: a beetle scurries across the screen for a mention of a
bug, confetti falls for a congratulation. Nothing about this rides the wire —
detection runs entirely on the reader, against the plain `body.text` of a
`kind: 'text'` message — so a pre-1.5 client shows nothing, and the
vocabulary can grow later without any format bump.

### Detection (`src/shared/easterEggs.ts`, pure)

The team writes in English, French, German/Swiss German, and Portuguese, so
both word lists cover all four:

- **Bugs:** `bug(s)` (English, and the word French/German/Portuguese
  developers actually use in practice), `bogue(s)` (French proper), `kafer`/
  `chafer` after folding (German `Käfer`, Swiss `Chäfer`, plus the
  `ae`-spelled forms a Swiss keyboard-less phone produces).
- **Confetti:** `congrats`/`congratulations`, `happy birthday`; French
  `felicitation(s)`, `bravo(s)`, `joyeux/bon/bonne anniversaire`; German
  `gratulation(en)`, `gratuliere`, `gluckwunsch(e)`, `alles gu(e)te zum
  geburtstag`; Portuguese `parabens`, `felicidades`, `feliz aniversario`.
  Confetti wins a tie against a bug in the same message.
- **Accent-insensitive and case-insensitive.** `foldForMatch` runs Unicode
  NFD normalization and strips combining marks before lower-casing, so
  "Félicitations", "FELICITATIONS", and a plain-ASCII typing all match, and
  Swiss-typed "Chaefer" lands next to "Chäfer".
- **Negatives, matched with `\b` boundaries so neither list fires inside a
  longer word** ("debugging", "buggy", "bugle", "bogueado" all carry the
  letters and are not a report): fenced code blocks (```` ``` ```` and
  `~~~`, including an unterminated fence still being typed), inline code
  spans delimited by a matching *run* of backticks (so `` ``bug`` `` reads as
  one span rather than two empty ones around a live word), lines indented
  like code (four spaces or a tab), email addresses, URLs (including app
  schemes like `sfgif://` and bare `www.` domains), and a bare host pasted
  with neither scheme nor `www.` (`bugs.example.com/42`) — restricted to a
  named list of TLDs on purpose, since a general "word.word" rule would eat a
  missing space after a full stop ("great work.Congrats everyone") and
  silence a real celebration, a worse failure than letting one tracker host
  through.

### Eligibility (`src/renderer/src/chat/eggEligibility.ts`, pure)

A message qualifies only when the reader could plausibly have just seen it:

- **it's mine** — the sender always gets their own animation, immediately;
- **it arrived live** this session (recorded at the push, in
  `src/renderer/src/store/liveEvents.ts` — capped at 2000 ids, cleared on a
  folder switch — because `loadTeam` prefetches every log at boot, so a
  pane's own baseline when it opens is not a reliable "did this just
  arrive"); or
- **it was already unread when the conversation was opened** — comparing
  against the read cursor as it stood at open time, where a conversation with
  **no** read cursor (never opened, or opened while still empty) reports `''`
  and that is read as *everything in it is unread*, not nothing — deliberately
  different from the NEW-divider's own refusal to draw in that case, which is
  a layout choice, not an eligibility one.

Scrolling back through old history never plays anything, however these two
facts happen to line up.

### The queue (`src/renderer/src/app/easterEggQueue.ts`, pure + a localStorage mirror)

- **Once per message id, ever.** Played (or collapsed) ids are kept in
  `localStorage` under `easter-eggs-seen`, capped at 500 (oldest dropped),
  so re-opening a channel tomorrow replays nothing.
- **24-hour ceiling.** A message older than `EGG_MAX_AGE_MS` (24 h) never
  plays, however it arrived — a cold start that ingests a week of backlog
  must not throw a party.
- **Throttle:** at most one animation every `EGG_MIN_GAP_MS` (8 s — longer
  than the longest animation, the bug's 3 s run, which is what makes "never
  two on screen at once" fall out for free). A qualifying message inside that
  window is *collapsed* — marked seen and dropped, not queued — so a burst of
  five "congrats" in a row is one confetti fall, not forty seconds of them.
- **`prefers-reduced-motion` is a hard off, in both directions**, checked
  before anything is remembered: a reduced-motion machine with the setting on
  plays nothing and spends no ids, and turning the OS setting off later still
  finds every message eligible.
- **The setting itself is absent from `DEFAULT_SETTINGS`** — every read is
  `settings?.easterEggs !== false`, so an untouched profile, a pre-1.5
  profile, and a build that has never heard of the field all mean *on*. It
  still persists normally once someone actually touches the toggle.

### The animation (`src/renderer/src/app/EasterEggOverlay.tsx`)

One full-window layer at z-index 50 (above the message list and composer,
below the launch nudge and everything modal), `pointer-events: none`
throughout so a beetle walking over a button never swallows the click. The
bug is an inline SVG (not an emoji, which renders as different animals on
different platforms and can't have its legs animated) that runs ~3 s
left-to-right or right-to-left; confetti is ~2.5 s of ~150 pieces animated on
a single `<canvas>` from elapsed time (not integrated frame-by-frame), so a
dropped frame or a backgrounded window never leaves pieces hanging mid-air.
The layer carries `data-easter-egg="bug"` / `"confetti"` while showing, which
is what the E2E script watches for.

### The toggle

**Settings → Appearance** — not Admin; this one is everybody's —
"Message easter eggs", on by default, with a sub-line naming the
reduced-motion override. `SettingsView.easterEggs?: boolean` is the only
bridge surface this feature touches.

When the OS is actually asking for reduced motion, a second, additive toggle
appears underneath — "Play them anyway" (`SettingsView.easterEggsIgnoreReducedMotion?: boolean`, default false) — the explicit way to see the eggs without turning Reduce motion off system-wide; see `docs/contract-changes-1.5.md`.

## 4. Pull-request header toggles

Two per-device switches on the pull-requests pane header, next to the
existing "N overdue" / "N stale" counts: click a count to hide every PR that
count describes, click again to bring them back. **Renderer-only** — no
bridge surface, no event type, no share write; a pre-1.5 client is unaffected
by construction.

- **State lives in `localStorage`, not on the share**
  (`src/renderer/src/team/prsVisibility.ts`): `sem-prs-hide-overdue` /
  `sem-prs-hide-stale`, written only as `'1'` and *removed* (not set to `'0'`)
  when un-hidden. This is one machine's owner choosing what to stop looking
  at, the same reasoning that keeps the PR token per-device while the `prs`
  config itself is team-scoped. Missing or unparseable storage degrades to
  "everything visible."
- **Applied after the pane's scope/branch/repo/search filters, before
  grouping**: `applyVisibility(filtered, visibility)` produces `visible`,
  which is what actually renders. A PR that is both overdue and stale is
  hidden by either toggle alone.
- **The header's own counts stay on `filtered`, not `visible`** — a count
  that dropped to 0 by being clicked would leave nothing left to click to
  bring it back.
- **`prs.markSeen` still receives the pre-hide (`filtered`) list, hidden
  rows included** (`seenKeys`). `PrsStatus.unseen` — the sidebar's red badge
  and the OS dock badge — counts tracked, non-approved PRs with `seen:
  false`; since the hide toggle persists across restarts, a PR that arrives
  *already* overdue (e.g. added as a required reviewer on a four-day-old PR)
  would otherwise be permanently unseen with no UI path to clear it. Hiding
  means "stop showing me these," not "stop counting them."
- **The note under the header** reads (singular handled):
  `N overdue pull request(s) hidden — click the count to show them`, one line
  per active toggle that is actually hiding something right now, counted off
  the pre-hide list — so a PR that's both overdue and stale produces two
  lines and both header pills count it, on purpose: each line names exactly
  the button that clears it.
- **Toggling is a pure reducer** (`toggleOverdue`/`toggleStale`), applied
  straight to `setState`, with the `localStorage` write in an effect keyed on
  the resulting state — so two toggle clicks dispatched inside one React
  batch compose correctly (net out to the original) instead of both reading
  the same stale render-time flag.
- **`IconEyeOff`** (`src/renderer/src/app/icons.tsx`) is the hidden-state
  glyph; the toggle button itself carries `aria-pressed` and swaps its title
  between "Hide … pull requests" and "Show … pull requests again".

## 5. Daily calendar toast

Once per calendar day per team folder, Chat summarizes what the team calendar
says about *today* in a toast — mounted once, in `AppShell`, as
`CalendarDigest`; renders nothing itself.

### The line (`src/renderer/src/team/dailyDigest.ts`, pure)

Strict priority, one line ever:

1. **A birthday today** beats everything — `🎂 Today: {name}'s birthday`, or
   `🎂 Today: {a, b and c}` for more than one. The **birthday tag rule**:
   `isBirthdayTag` matches the entry's *tag* (not its title) against
   `birthday`/`aniversario`/`anniversaire`/`geburtstag`, accent- and
   case-insensitive; `birthdayName` strips a trailing possessive suffix
   ("Ana's birthday" → "Ana") in any of those languages but passes a
   bare-name or free-form title through unchanged. An annual entry expands by
   month/day regardless of the year it was originally entered on.
2. **Otherwise, the ordinary event(s) whose span covers today** —
   `📅 {title} — until {end date}` for one, or `📅 {a, b and c} today` for
   several covering it at once.
3. **Otherwise, a countdown** to the next upcoming entry within the next
   year (guaranteeing a hit for any annual entry, worst case 365 days out):
   `📅 {title(s)} in N day(s)`, joining any that tie on the same date.

`joinNames` never uses an Oxford comma (`a`, `a and b`, `a, b and c`), and
nothing is shown at all when the calendar has literally nothing today or
upcoming within the window.

### Once per day per share (`shouldShowDigest`)

`lastShown` is keyed in `localStorage` as `chat.calendarDigest.lastShown.
{sharePath}` — **per team folder**, not global — and the gate fires only the
first time a given `today` is checked, or once `today` has moved *forward*
from the stored day. A clock stepping backward (DST, a manual change) does
not reopen the gate.

### Triggers and the focus rollover

Exactly two triggers, both funneled through the same `attempt()` (so there is
one code path to get right, not two):

1. **Boot** — once `boot.mode === 'ready'` *and* the team calendar log has
   actually been read (`ensureEvents(TEAM_CONV.calendar)` has resolved, not
   merely "the array is empty," which would otherwise look identical to "not
   fetched yet" on a quiet team and never fire again).
2. **Window focus**, gated by `shouldShowDigest` to a later calendar day —
   so a dozen focus events on the same quiet afternoon compute nothing after
   the first.

**Suppressed on the calendar pane, without spending the day's attempt.**
`attempt()` checks `shouldShowDigest` *before* checking whether
`activeConv === TEAM_CONV.calendar`; if the calendar pane is open, the
function returns without writing `lastShown` — so the day's chance to show
the digest is preserved for the next trigger (a later focus event, or
tomorrow's boot), rather than being burned by a visit to the very pane the
toast is redundant with.

Once a message is chosen (or found to be null — nothing to say), `lastShown`
moves to today either way; the toast itself displays for 8 s.

## 6. Tests

**Shared:** `src/shared/gilMode.test.ts` — exact/trimmed/case-insensitive
matching, and that a longer name sharing the prefix ("Gil Silva") is not
Gil. `src/shared/easterEggs.test.ts` — bugs and celebrations in all four
languages, the precedence tie (confetti wins), and every negative case
(word-boundary safety, fenced/tilde/backtick-run code, indented code, email
addresses, bare hosts, URLs) alongside the prose that must survive them;
`foldForMatch`/`stripNonProse` directly.

**Main:** `src/main/services/teamSettings.test.ts` — folding
(newest-event-wins regardless of arrival order, ignoring unverified events, a
name over the length limit or empty, ignoring anything that isn't a
`team-renamed` sys event in `team:settings`, a malformed payload handled
without throwing, normalization matching the Settings field, no-op detection
for a replayed or older event, watermark-advance for a same-name newer
event); the admin gate on the fold specifically (non-admin ignored,
TOFU-flagged claimant ignored, unresolvable author ignored, an admin accepted
however the roster spells the name or however it's pinned, a refused event
never winning or even moving the watermark); `ChatService.renameTeam`
(publish+fold+push+refuse-invalid, the no-op write-nothing case, queuing
through the outbox when unreachable, `not-admin` for anyone else, ignoring an
event a non-admin published anyway); and cold start folding the rename out of
the log while `protocol.json` still shows the old name.
`src/main/transport/beacon.test.ts` — always-online: keeping the heartbeat
alive through a pause carrying online/idleSec-0, reporting idleSec 0 on the
idle tier too, no behavior change with the setting off, still losing to
appear-offline; the schedule reacting live to the setting flipping (or
appear-offline being chosen) behind an already-locked screen, beating at
exactly `BEACON.idleHeartbeatMs` with no jitter, and this device's own row
reading the published (not truthful) presence.

**Renderer:** `src/renderer/src/store/teamRename.test.ts` —
`teamRenameNotice` (names the renamer, stays quiet for our own rename or
anything the fold would refuse, tolerates a malformed payload, falls back to
a device id absent a roster hit), `teamRenameSaveNotice` (only claims success
when the name actually moved, names the "will save when back" case),
`teamRenameFailureNotice` (translates `not-admin`, passes other errors
through), and the store-level "moves `boot.self.teamName` on the `team` push
and toasts the event once" / "says nothing about a rename replayed before the
log has been pulled." `src/renderer/src/app/renamePlan.test.ts` — per-kind
normalization and caps for channels and groups, the no-op case, the
home-channel refusal, and that the sidebar rows import and use `planRename`
rather than keeping a second copy. `src/renderer/src/app/teamPane.test.ts` —
`teamPaneFor` naming a pane per conv (`null` for the log-only `team:settings`
conv, so it does not fall back to rendering the pull-request pane) and
covering every `TEAM_CONV` member deliberately.
`src/renderer/src/app/easterEggQueue.test.ts` — eligibility (live, mine,
unread-at-open, silence for old scrolled-back history, the 24 h edge and a
share clock running slightly ahead), both off-switches (setting off, reduced
motion), once-per-id, the throttle and burst-collapsing, `rememberSeen`'s cap,
and the persisted half surviving a restart / a corrupt value / no storage at
all. `src/renderer/src/chat/eggEligibility.test.ts` — `mine` before/after
boot is known, `live` trusting the push registry over the pane baseline (and
treating a still-loading log as all-new), `unreadAtOpen`'s `''`-means-everyone
rule, and the two originally-broken scenarios named in the contract doc: an
egg playing in a never-opened DM, and in a never-read channel's first
message. `src/renderer/src/store/liveEvents.test.ts` — remembering exactly
what arrived over the push, the id cap, and forgetting everything on a folder
switch. `src/renderer/src/team/prsVisibility.test.ts` — `applyVisibility`
(each toggle alone, both together, the overdue+stale overlap, a legacy PR
with no state never hidden), `visibilityNotes` (empty when nothing matches,
singular at exactly one, both lines in header order), `seenKeys` (keeps
hidden PRs in the seen list — the regression this feature could have
introduced), the reducers' pure-and-idempotent-pair behavior, and per-device
persistence (defaults, independence of the two flags, surviving a re-read,
no-storage safety). `src/renderer/src/team/dailyDigest.test.ts` —
`isBirthdayTag` across locales, `joinNames`, every branch of `dailyDigest`'s
priority order (including a birthday outranking a same-day event, an annual
birthday matching across years, ties on both same-day events and the
countdown), and `shouldShowDigest`'s day-rollover/no-backward-reopen/malformed
-input rules.

**E2E (`scripts/e2e-drive.mjs`).** **Team rename**: alice (an ordinary
member) is refused with `not-admin` and nothing about her `teamName` moves; a
fourth, short-lived instance joins the same team calling itself "Gil" on
**port 9337** specifically because the admin check is a display name, and
from it: an untrimmed/spaced name normalizes and is accepted
(`queued: false`), an all-whitespace and a 41-character name are both
refused (`invalid-name`), the renamer's own `getBoot().self.teamName` updates
without a self-toast, renaming to the identical name again resolves
`queued: false` without a second event, and alice picks up the fold — her
`SelfView.teamName`, her sidebar header title, and a toast naming Gil and the
new name. **Easter eggs**: both alice and bob open #general so the trigger is
"visible," a recorder polls for `[data-easter-egg]` and its computed
`pointer-events`/`z-index`; "debugging all morning, no luck" plays nothing
(checked first, while nothing could be hiding behind the throttle), "we found
a bug in prod" plays for both the reader (bob) and the sender (alice), and
the overlay never intercepts the mouse (`pointer-events: none` verified via
`getComputedStyle`). Both eggs are skipped (as `soft`, not `check`) when the
driving machine itself has `prefers-reduced-motion` on, since the feature is
correctly silent there. **PR header toggles**: a PR made overdue is hidden by
clicking its "N overdue" pill (row disappears, aria-pressed flips, the
"hidden — click to show" note appears with correct pluralization), restored
by clicking again, and — the regression pin — a *second* PR that arrives
already overdue while the toggle is still on is hidden on arrival yet still
gets marked seen once the pane has focus (simulated via CDP
`Emulation.setFocusEmulationEnabled`), proving the unseen/dock badge can
still clear. **Calendar digest**: a fifth instance joins fresh as "Carol" on
**port 9336**, purely because alice's and bob's own once-per-day boot checks
already ran long before "Gil's birthday" was published to the share and
1.5's rule deliberately does not re-show mid-day — Carol's `getBoot()`
reaching `ready` is checked, then a toast mentioning "birthday" is awaited
within 20 s.

Not covered by the E2E: **always-online** has no live-app check at all (unit
tests only, `beacon.test.ts`); the **Admin nav's** `isGil`-gated visibility
(hiding "Admin" from a non-Gil display name) is never driven through the
actual Settings UI in either the E2E or a component test — `navFor`'s
predicate is unit-tested via `gilMode.test.ts`'s coverage of `isGil` itself,
but nothing renders `SettingsModal.tsx` to confirm the nav item is actually
absent for someone else. Both are architecturally low-risk (the same `isGil`
call gates the nav and the two enforced paths; the beacon's always-online
math is fully covered at the unit level with a fake clock) but are
UI/live-app gaps a future maintainer should know about rather than assume
covered.

## 7. Compatibility

Nothing in 1.5 changes the envelope format, key derivation, or `protocol.json`
itself — no version bump, no new field, no rewrite.

- **Team rename** adds one new fixed conv, `team:settings`
  (`TEAM_CONV.settings`), riding the existing `sys` event type — the same
  envelope shape channel/group renames already use. A **1.4 (or earlier)
  client does receive and store these events** (see §1's corrected note) but
  never folds or surfaces them: no UI change, no notification, no crash. The
  one wire-visible footprint of a rename is one more directory under `team/`,
  named by a derived token that reveals nothing about its contents.
  `ChatService.publishTeam` widening to accept `type: 'sys'` also widens the
  `outbox` secret's team arm; a 1.4 build reading a 1.5-written `outbox` with
  a queued `type: 'sys'` item republishes it as a sys event into a conv it
  doesn't recognise — harmless, for the same reason.
- **Easter eggs** touch no event type, no `MsgBody` field, and nothing
  written to the share — detection is 100% reader-side against plain text
  that was already there. A pre-1.5 client shows nothing for a "congrats" or
  a "bug," exactly as it always has.
- **The PR header toggles** touch nothing under `src/main`, `src/shared`, or
  `src/preload` — no bridge surface, no event type, no share write. A
  pre-1.5 client is unaffected by construction; there is nothing to be
  compatible *with*.
- **The daily calendar toast** reads the existing `team:calendar` log through
  the existing `materializeCalendar` and writes only to this device's
  `localStorage`. A pre-1.5 client's calendar entries (including a birthday
  tag in any of the four supported languages) are exactly what a 1.5 client
  summarizes; nothing about the calendar's own wire format moved.
- **Always-online** is a beacon-content decision made entirely by the
  publishing device; every reader — 1.1 through 1.5 alike — already derives
  online/away/offline from `state`/`idleSec` on the beacon, so an older
  client simply sees Gil as online without knowing why, the same as it would
  for a device that is genuinely active.
