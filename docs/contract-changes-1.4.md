# Contract changes during 1.4 implementation

Deviations from the contract described in §1 of the approved 1.4 plan. Each
entry says what moved, why, and what a reviewer should check.

---

## 2026-09-14 — `PrsStatus` also carries the team's two thresholds

**Stream M (main + shared).** §1 gave `PrsStatus` `overdue` and `stale`. It also
now carries `reviewSlaHours: number` and `staleAfterDays: number`, always
concrete (defaulted from `PRS` when the team config predates them).

Nothing else exposes the shared config to the renderer: `PrsStatus` is the
projection, and the raw `team:prs` payload reaches the renderer only through
`chat.events` with its token redacted. Without these two fields the prefs pane
could not prefill the numbers it is meant to edit, and the pane's stale line
("No activity for 14+ days") would have to guess. Additive and required —
`PrService.status()` is the only thing in the tree that builds a `PrsStatus`.

Check: `prService.test.ts` → "publishes them, defaults them, and keeps them when
saveConfig omits them", "reads a 1.3 config, which carries neither, as the
defaults".

## 2026-09-14 — the `unsupported` detail result is `AdoDetail<T>`, a three-armed union

**Stream M.** §2 asked for "a typed `unsupported` result" without naming the
shape. It is:

```ts
export type AdoDetail<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'unsupported' }
  | { ok: false; reason: 'error'; error: AdoError }
```

discriminated by `reason` rather than by an optional flag, so neither arm can be
read as the other by accident. `AdoResult<T>` is untouched — every 1.1 endpoint
still returns exactly what it returned.

`threads()`/`iterations()` check the negotiated version **twice**: before the
request (no point spending a round trip to be told 400), and again after a
failure, because `get()`'s ladder can step *below* 3.0 while the call is in
flight and the resulting 404 is a fact about the server, not an error worth
showing. `apiAtLeast()` compares component by component, so "10.0" is not "less
than" "3.0".

Check: `ado.test.ts` → "returns 'unsupported' without spending a request below
API 3.0", "a mid-flight negotiation down to 2.0 reads as unsupported, not as an
error", "apiAtLeast compares numerically, not as text".

## 2026-09-14 — the endpoints are spelled `…/pullRequests/{id}/threads`

**Stream M.** The 1.1 list endpoint is `/pullrequests` (all lower case, as the
contract wrote it); the per-PR resources are `/pullRequests/{id}/threads` and
`/pullRequests/{id}/iterations`, which is how Microsoft documents them. Azure
DevOps itself is case-insensitive here, but the fake server in
`scripts/e2e-drive.mjs` matches the documented casing (case-insensitively) and
the two routes cannot be confused with the list route, which anchors at the end
of the path.

## 2026-09-14 — `computePrState` also takes the author's display name

**Stream M.** §2 listed the input as "reviewers with votes and observed vote
times, open/closed threads with last-comment author + dates, lastPushAt,
createdAt, authorId, meId". `PrState.nextNames` has to be renderable for the
three kinds whose next actor is the author, and `PrView.author.name` is the only
place that name exists — so the input carries `authorName` as well. `meId` is
used for one thing only: putting the viewer first in `nextIds`, so a row can
read "Next: you, Bob". The rules themselves are viewer-independent.

`summarizeThreads(AdoThread[]) → PrThreadSummary[]` lives in the same pure
module (the plan did not say where it should live). It drops deleted threads and
comments, and — the part worth reviewing — drops threads whose only comments are
`commentType: 'system'`: Azure DevOps files "Ana voted 10" and "updated the pull
request" as real-looking threads with `status: 'active'`, and counting those
would leave every PR permanently "commented".

Check: `prState.test.ts` → the whole `summarizeThreads` block.

## 2026-09-14 — precedence between the five kinds, and what "a vote since the last push" means

**Stream M.** The plan's state model lists the five kinds but not their order.
Implemented highest-claim-first, first match wins:

| kind | when | next | since |
|---|---|---|---|
| `changes-requested` | a −5/−10 cast after the last push | author | that vote (earliest) |
| `comments-open` | an open thread whose last comment is not the author's | author | that comment (earliest) |
| `author-replied` | open threads, every one last spoken in by the author | reviewers who opened them | the author's earliest such reply |
| `approved` | `isApproved` on votes since the push, and no open thread | author | the approval that completed it |
| `needs-review` | anything else | reviewers without a fresh approving vote | the last push, else creation |

Two consequences worth checking:

- **A vote is only evidence about the code that was there when it was cast.**
  Rather than applying the "since the last push" rule only to `needs-review`, the
  function projects every reviewer to an *effective* vote — the real vote if it
  was observed at or after the last push, otherwise 0 — and runs all five rules
  (including `isApproved`) on that projection. So "approved, then the author
  pushed again" reads as `needs-review`, and a −5 the author has already answered
  with a push does not keep reading as `changes-requested`. Because first sight of
  a vote is floored *at* the push, a cold start still shows an old approval as
  `approved`; only a push we actually observed landing after the vote demotes it.

  **This is a deliberate deviation from what Azure DevOps itself shows.** ADO
  keeps rendering a −5 ("waiting for the author") until the reviewer clears it
  by hand, so a PR can sit red in the browser for a week after the author
  pushed the fix. Chat's pane says the ball is back with the reviewers, and
  names them. The pane and the ADO page will therefore disagree about that PR
  until somebody re-votes — on purpose: the question this pane answers is "who
  should act now", and the answer after a push is the reviewer.
- **`author-replied` when no reviewer opened the open threads** names the
  reviewers who still owe a vote, and — when none do — every reviewer on the
  PR; only a PR with no reviewers at all reads `next: 'nobody'`. The empty
  case is not rare: `summarizeThreads` drops deleted comments, so a thread
  whose *opening* comment was deleted is attributed to whoever spoke next,
  often the author. "Nobody" there would quietly retire a live conversation.

A PR with no reviewers at all is `needs-review` with `next: 'nobody'` — nobody
was asked, so nobody is late, and `overdue` stays false. `overdue` applies only
while `next === 'reviewers'`; both boundaries are inclusive (at exactly 48 h it
*is* overdue).

Check: `prState.test.ts`, every describe block.

## 2026-09-14 — the round-robin budget covers the round robin, not the forced refreshes

**Stream M.** "at most ceil(N / 5) PRs per 60 s poll" is applied to the
time-based refreshes. A PR seen for the first time, and a PR whose
`lastMergeCommit` changed, jump the round-robin queue: a PR with no details has
no state to show at all, and a push invalidates every vote's meaning. In steady
state that is ≈ 2·N/5 extra requests per minute.

**Revised after review:** the forced list has its own cap, `2 × budget` PRs per
poll, remainder next poll. Unbounded, the first poll after a config lands spent
2·N *serial* requests (60 round trips for 30 tracked PRs) before the pane could
show anything, and any burst of pushes did the same; capped, 30 PRs cost 24
detail requests on the first poll and are all covered by the third. For the same
reason `applyConfig` now clears the detail cache only when the base URL or the
project changes — a token edit is the same server's pull requests read with
another credential, not a reason to re-read every detail.

A detail read that *fails* stamps `fetchedAt` but **does not bank the commit**
(`PrDetail.read` stays false), so it stays on the forced list and is retried
once per `PRS.detailRefreshMs` window rather than once per poll. That second
half is also a review fix: banking the new commit on a failed read meant a push
whose threads/iterations 429'd was never re-read at all, and the pane kept
showing the previous push time until something else changed. `unsupported`
counts as answered — a pre-3.0 server has said everything it will ever say. The
poll itself never fails because of any of this: the list is still true, only its
waiting state is a little older (`threadsKnown` stays false).

Check: `prService.test.ts` → "spreads first sight over a few polls instead of
spending 2·N requests at once", "then spreads the round robin over five polls
instead of re-reading everything at once", "caps the first poll instead of
spending 2·N requests before the pane shows anything", "a detail read that fails
is not retried every poll, and never fails the poll", "re-reads a push whose
detail read failed, once per refresh window until it lands", "keeps the cached
details when only the token changed, and drops them when the project moves".

## 2026-09-14 — `saveConfig` refuses an out-of-range threshold instead of clamping

**Stream M.** `PRS.reviewSlaHoursRange` / `staleAfterDaysRange` are enforced on
the write path by throwing `invalid-config: …` (the same shape the base URL,
project and repo-list checks already use), because a silent clamp would publish
a number to the whole team that nobody typed. `prsIpc.ts` passes a non-number
through as `undefined` (= keep the team's current value) rather than coercing it,
and `PrsPrefs.tsx` blocks Save and marks the field while it is out of range.

The *read* path is the opposite and deliberately so: `materializePrsConfig`
clamps anything odd it finds on the share, because one strange number in a
snapshot must never cost the team its base URL and repo list. **Revised after
review:** it clamps to *the value already in force*, not to the constant
default, and a snapshot that omits the fields entirely carries the previous
winner's values forward. A 1.3 client cannot see these fields, so its perfectly
ordinary re-publish (renaming a repo, pasting a shared token) used to reset the
whole team to 48 h / 14 d. Only a log in which no snapshot ever carried them
falls through to `PRS`. For the same reason `PrService.disconnect()` now
publishes the thresholds alongside the empty config: disconnecting says nothing
about the SLA the team agreed on.

Check: `prService.test.ts` → "refuses a threshold outside the published range",
"disconnect publishes an empty config, clears prs-seen and keeps the personal
token"; `prs.test.ts` → "carries the team thresholds forward across a snapshot
that does not carry them", "clamps a threshold off the share to the default
rather than dropping the config", "keeps a threshold inside the range exactly as
published"; `prsIpc.test.ts` → "turns anything that is not a number into
undefined — keep the team value, never coerce".

## 2026-09-14 — `stale` means "silent", and only a server that serves threads can say so

**Stream M, revised after review.** §0 defined `stale` as "no activity for
`staleAfterDays`". `computePrState` now also requires `threadsKnown`: on a
pre-3.0 server, and before the first successful detail read, `lastActivityAt`
collapses to creation / last push / observed votes, and a PR that is commented
on daily reads as abandoned purely because it is old. That is not a cheap
mistake — `prsGroups` pulls a stale PR out of *every* other group into "Stale —
abandon or revive?", so on a 2.0 server the whole pane became one stale list,
"Needs your attention" included.

`overdue` is deliberately *not* qualified the same way: it measures the wait
since the last push (or creation) against the review SLA, and both of those are
visible on any server version.

Check: `prState.test.ts` → "is never stale on a server that cannot serve threads
— silence there is not evidence"; `prsGroups.test.ts` → "leaves the stale group
empty on a server that cannot serve threads".

## 2026-09-14 — `LaunchInfo` gains an optional `status`, and the login item stops writing `args`

**Stream N's surface, fixed in review.** `app:setOpenAtLogin` registered the
item with `args: ['--opened-at-login']` on Windows while `app:launchInfo` read
it back with `app.getLoginItemSettings()` — no args. Electron compares the
options it is given against the registered command, so the read answered
`openAtLogin: false` about an item that was really there: the Settings toggle
bounced back off and the nudge kept coming back. Nothing in the tree consumed
that argv flag, so it is gone, and both calls now take their description from
one pure `loginItemOptions(platform)` in `src/main/loginItem.ts`.

`launchInfoFrom(settings, platform)` moved out of the handler with it, and adds
one additive, optional bridge field: `LaunchInfo.status` (macOS only, the
SMAppService status). `requires-approval` means the item *is* registered and is
waiting for a tick in System Settings → General → Login Items, so it reads as
`openAtLogin: true`; the nudge row shows ✓ with that sentence, and the Settings
row says the same under the toggle. `openedAtLogin` is now `wasOpenedAtLogin` on
darwin and `false` everywhere else, because nothing reads it and nothing can
honestly answer it elsewhere.

Check: `loginItem.test.ts` (the whole file); `launchNudgeState.test.ts` → "shows
the approval hint, done, for macOS's 'requires-approval'".

## 2026-09-14 — quiet hours are enforced (they never were), and the nudge leaves the popover lane

**Stream N's surface, fixed in review.** `SettingsView.quietHours` has been
stored, edited and rendered since 1.0 and silenced nothing: no code path ever
read it. `shared/notifyDecision.ts` now owns it —
`inQuietHours(quietHours, now, tz?)` — and both gates (`shouldNotifyChat`,
`shouldNotifyPr`) return false while the window is running, so it covers OS
toasts for messages, live-board invites and pull requests, plus the in-app PR
alert card, without a single call site changing. `alertsSilenced` counts it too,
so the bell wears its slash while the window runs.

Three decisions worth checking: the window is local wall-clock and wraps
(`from > to`, the 22:00–07:00 default shape); `from === to` is the empty window
and reads as off, not as 24 hours of silence; and anything malformed (a bad
time, an unknown zone) reads as off, because this function can only suppress —
it must fail towards letting a notification through. `tz` exists for the tests.

**Beam offers deliberately stay outside it** (`drops.ts` raises its own
notification): somebody is waiting at the other end of a transfer, and an offer
that expires in silence is worse than a chime at 23:00. Badges and unread
counts are untouched — "the app still updates" is what the Settings row says,
and now it is also true of the notifications it claims to silence.

`LaunchNudge` moved from z-index 690 to 55 in the same pass: the sidebar's
notification popover opens bottom-left (left 8, bottom 58) and the nudge sat on
top of it. The ladder in `toasts.tsx` puts popovers and panes under 80; a card
that appeared on its own must not cover something a person deliberately opened.

Check: `notifyDecision.test.ts` → the `inQuietHours` block and "quiet hours
silence the things that interrupt"; `prService.test.ts` → "says nothing during
quiet hours, and speaks again once they are over".

## 2026-09-14 — `prs-history` is team-scoped, and `PrView.lastMergeCommit` is always a string

**Stream M.** `'prs-history'` joins `'prs-seen'` in the team-scoped secret list
cleared by `AppController.changeTeamFolder()` (it is a record about this team's
pull requests), and `disconnect()` clears it alongside `'prs-seen'`.
`'prs-token'` still stays — it is the user's credential, not the team's.

`toPrView` always sets `lastMergeCommit`, using `''` when the server does not
report one. An absent field and an empty string compare equal between polls, so
a server that never reports it simply never triggers a commit-change refresh and
falls back to the round robin.

## 2026-09-14 — an approved PR never raises the in-app alert card

**Stream M**, one line in `src/renderer/src/team/PrAlert.tsx` (which no stream
owns). The card diffs the key set itself rather than reading
`PrsStatus.unseen`, so without this a PR that appears already-approved would pop
"1 pull request needs review" at the very moment nobody needs to review it. Same
rule as the badge: `unseen` and the alert both skip `state.kind === 'approved'`,
and so does the OS notification (`fresh` in `PrService.doPoll`).

The other half of that rule, worth knowing before it looks like a bug: **an
approved PR that later gets a comment lights the badge without announcing
itself.** Its state moves to `comments-open`, so `unseen` counts it again and
the sidebar goes red — but `fresh` only covers PRs that *appeared* since the
last poll, and the author-side transition toasts only fire for pull requests of
my own (`PrService.trackTransitions`, and never at all on a team's shared
token, where `myIdentity()` is empty). So somebody else's approved PR picking up
a comment is information, not an interruption. That is deliberate: the pane and
the badge are the treatment for "something changed over there".

## 2026-09-14 — two E2E checks changed meaning (the count is unchanged)

**Stream M**, `scripts/e2e-drive.mjs`. Both followed the plan's tracked-set
decision:

- "alice lists exactly the unapproved pull request (the approved one is
  filtered)" → "alice lists both pull requests — 1.4 keeps the approved one for
  'Ready to complete'".
- "an approved pull request drops out of the list" → "a completed pull request
  drops out of the list" (the upstream mutation is now `status: 'completed'`
  instead of a +10 vote). Approval no longer removes a PR from the list, so the
  old assertion could not survive; completion still does, and that is the rule
  worth guarding.

Four checks were added after them (bob's `comments-open` state, the approved
PR's state and its absence from `unseen`, and the numeric `overdue`/`stale` plus
thresholds on `status()`).

## 2026-09-14 — `PresenceView` gains `supersededBy`, and supersession stops waiting for `state`

**Tester fix**, `src/shared/types.ts`, `src/main/transport/poller.ts`,
`src/main/transport/supersede.ts` (new).

`PresenceView.supersededBy?: string` is an additive, IPC-only field (nothing
about it crosses the share) naming the device that replaced this one: the same
person, on the same machine, after a "Reset local data" + re-join. It always
implies `departed`; it exists so a surface can say *why* a row is hidden — a DM
that still holds history is labelled "(previous device)" rather than vanishing
like a teammate who has merely been quiet for three days.

Two behaviour changes come with it, both in `Poller.presenceViews()`:

- The rule is evaluated over the **whole roster, this device's record
  included**. It used to run over the same list the views are built from, which
  has `self` filtered out — so on the one client that always sees this bug
  first (the person who just re-joined), the record doing the superseding was
  the one record excluded, and the ghost stayed listed until
  `PRESENCE.departedAfterMs` (three days) retired it.
- It is no longer gated on the derived `state === 'offline'`, which tolerates
  two minutes of silence. It carries its own, stricter liveness test instead
  (`Poller.beaconLive`): a heartbeat fresher than `PRESENCE.onlineWithinMs`
  that does not say `offline`. A device destroyed by a reset can never produce
  one; a second live instance on the same machine produces one every heartbeat,
  which is what keeps two same-named dev profiles from eating each other.

`supersede.ts` deliberately does **not** compare a beacon stamp against a
record's `firstSeen`: beacon stamps are share-calibrated and `firstSeen` is the
writer's own wall clock, so on a share whose clock is minutes out that
comparison decides the wrong way. The caller answers "is it live" in share time
and passes a boolean.

E2E (`scripts/e2e-drive.mjs`): seven checks (plus a screenshot) added at the end
of the run, driven by a third instance (`e2e-alice2`, port 9335) that joins with
Alice's display name after her instance is killed — a fresh profile on the same
machine *is* the post-reset state.

## 2026-09-14 — TOFU stops flagging a person for coming back

**Review follow-up**, `src/main/transport/roster.ts`,
`src/main/transport/supersede.ts`.

Local behaviour only: pins live in the `pins` secret and nothing about this
crosses the share or the bridge. `DevicePin` is unchanged.

`Roster.ingest` used to flag any new device whose `displayName` was already
pinned to a different, non-revoked device. A "Reset local data" + re-join is
that by definition, so the fix that hid the leftover registration left the
person's real device pinned `flagged` — the loud red device chip, in the
sidebar DM row, the members rail and the group dialog, for good, on every
teammate's screen. The collision test now skips a pin that is the *provably*
same machine: `provenSameMachine(a, b)` (new, exported beside `sameMachine`)
requires equal, present `machineIdHash` values on top of the name and
sanitized-hostname match. A missing fingerprint is **not** a match here — the
one asymmetry with the hiding rule, which can afford `null` because it also
demands the predecessor be provably silent.

`Roster.healFlags()` runs at the end of every `refresh()` and relaxes
`flagged` → `pinned` for any pin whose collision no longer stands. It exists
because `ingest` can only judge against the records read before it and the
device directory lists in key-hash order (so "was the new record read first?"
is a coin flip that lands the same way every launch), and because a client that
flagged a re-joined device under 1.3 would otherwise never take it back.
`revoked` and a hand-set `trusted` are never touched.

`Poller.departed()` also stops answering `supersededBy` ahead of its
`!this.polled` guard, and `presenceViews()` withholds `supersededBy` itself
until the first beacon listing: the rule's only veto is a live predecessor's
heartbeat, so before any beacons are read every device on the share looks dead,
and the renderer's `loadTeam` asks for `presence:list` in exactly that window.
