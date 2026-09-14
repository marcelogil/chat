# Chat 1.4 — pull-request waiting states, notification controls, launch nudge

Documented at the level of `docs/features-1.3.md`. Read `CLAUDE.md` first —
the iron rules that matter most here: `computePrState` is pure and touches
neither Electron nor the share; every pull request is still computed
per-device from Azure DevOps, never written to the shared folder; every
toast/card decision goes through one gate (`shared/notifyDecision.ts`); the
launch nudge and the Settings toggle it mirrors read the exact same OS state.

This document describes what shipped, not the plan that proposed it — the
plan lives at `~/.claude/plans/chat-1-4.md` and `docs/contract-changes-1.4.md`
records, dated, every place the implementation deviated from that plan. Where
this doc and that file disagree, the code — and `contract-changes-1.4.md` —
win. The state model's exact precedence, the endpoint casing, the
round-robin/forced-refresh budget split, and the quiet-hours semantics were
all sharpened or corrected during the review round; this document states the
shipped versions and says so where it matters.

Almost none of this release lives on the share. Pull-request waiting state is
computed locally by every client from Azure DevOps plus a small local cache;
the only share-visible change is two additive, optional fields on the
existing `team:prs` config payload. §6 covers what that means for a team
mid-upgrade.

## 1. Pull-request waiting states

Gil's ask: in the Pull requests pane, see at a glance how long a PR has been
waiting for review or for comment resolution, who should act now, and which
PRs are old enough to clean up.

### Data and request budget

Two more Azure DevOps reads per tracked PR, added to the one list request per
repo per minute that already existed: **threads**
(`{project}/_apis/git/repositories/{repoId}/pullRequests/{id}/threads`, for
unresolved comments and comment timing) and **iterations**
(`…/pullRequests/{id}/iterations`, for the last push). Note the casing: the
1.1 list endpoint is `/pullrequests`, all lower case, exactly as Azure DevOps
documents it; the two per-PR resources are `/pullRequests/{id}/…`, mixed
case, which is how Microsoft documents *those*. Azure DevOps itself is
case-insensitive, but `scripts/e2e-drive.mjs`'s fake server matches the
documented casing and anchors the list route so it can't be confused with the
per-PR ones.

Both endpoints exist from **REST API 3.0** (TFS 2017 and later). Below that,
`AdoClient.threads()`/`iterations()` return a three-armed discriminated
union rather than folding "not supported" into the existing error type:

```ts
export type AdoDetail<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'unsupported' }
  | { ok: false; reason: 'error'; error: AdoError }
```

`hasDetails()` (`apiAtLeast(negotiatedVersion, '3.0')`) is checked **twice** —
before the request, so a server already known to be too old never spends a
round trip to be told 400; and again after a failure, because the version
ladder (`ado.ts`, unchanged since 1.1) can step *below* 3.0 while the call is
in flight, and that resulting 404 is a fact about the server, not an error
worth showing. `apiAtLeast` compares component by component, so `"10.0"` is
correctly not less than `"3.0"`.

The budget, precisely (`PrService.refreshDetails`, `DETAIL_SPREAD_POLLS = 5`,
`PRS.detailRefreshMs = 5 min`):

- A PR **first seen** (no cached detail at all), and a PR whose
  `lastMergeSourceCommit` **changed** since the last successful read, jump
  the queue as "forced" — there is no state to show for a brand-new PR, and a
  push invalidates every vote's meaning.
- Everything else round-robins, oldest-read-first, at most `ceil(N/5)` PRs
  per poll — with the existing 60-second poll cadence, that walks the whole
  tracked set exactly once per `detailRefreshMs` (5 minutes), roughly `2N/5`
  extra requests a minute in steady state, rather than `2N` every five
  minutes in one burst.
- The **forced** list is separately capped at **2× that same round-robin
  budget** per poll, remainder next poll. Unbounded, the first poll after a
  fresh config (or a burst of pushes) would spend `2N` serial requests before
  the pane could show anything — 60 round trips for 30 tracked PRs. Capped,
  30 freshly-configured PRs cost 24 detail requests (12 PRs × 2 reads) on the
  first poll and the whole set is covered by the third.
- A detail read that **fails** stamps `fetchedAt` but does not bank the new
  commit (`PrDetail.read` stays `false`), so the PR stays on the forced list
  but is retried **once per refresh window**, not once per poll. `unsupported`
  counts as answered — a pre-3.0 server has said everything it will ever say
  about a PR. Either way, the poll itself never fails because of a detail
  read: the list is still true, only its waiting state is a little older
  (`threadsKnown` stays `false` until something actually answers).
- The detail cache is cleared only when the base URL or the project changes
  (`PrService.applyConfig`) — a token edit alone is the same server's pull
  requests read with another credential, not a reason to re-read every
  detail.

### Vote history

Azure DevOps does not timestamp votes at all, so "waiting since" would
otherwise be unknowable. `PrService` keeps a small local, **team-scoped**
history in the `'prs-history'` secret, per device: for every tracked PR key,
per reviewer, `{ v: vote, at: whenFirstObserved }`, plus the PR's last-known
push time as a floor.

- A vote **new to this device** (no prior record for that reviewer on that
  PR) is dated at the **last-push floor** — `max(lastPushAt, createdAt)` —
  the earliest moment it could possibly be evidence about the code that is
  there now. A cold start therefore still shows a genuinely old approval as
  `approved`, not as freshly-minted.
- A vote that **changes** between two polls (a reviewer who already had a
  recorded vote casts a different one) is dated **now**, accurate to within
  one poll interval.
- `'prs-history'` is pruned to the currently-tracked PR keys every poll,
  exactly like `'prs-seen'`, and cleared alongside it on
  `AppController.changeTeamFolder()` and on `PrService.disconnect()` —
  `'prs-token'` (the personal PAT) is the only PR secret that survives
  either, because it belongs to the person, not the team.

### The state model

`src/shared/prState.ts`'s `computePrState(input, now, thresholds)` is pure —
plain data in, a `PrState` out, no clock or I/O of its own — so it runs in a
unit test against a fixed `now`. Two ideas carry the whole file: **a vote is
only evidence about the code that was there when it was cast**, and **a
comment thread belongs to whoever spoke last in it**.

| kind | when | next | since |
|---|---|---|---|
| `changes-requested` | a −5/−10 vote cast after the last push | author | that vote (earliest of them) |
| `comments-open` | an open thread whose last comment isn't the author's | author | that comment (earliest) |
| `author-replied` | open threads, every one last spoken in by the author | reviewers who opened them | the author's earliest such reply |
| `approved` | every required reviewer's *effective* vote is an approval, no open thread | author | the approval that completed it (latest) |
| `needs-review` | anything else | reviewers without a fresh approving vote | the last push, else creation |

**Precedence is highest-claim-first; the first rule that matches wins** — a
plan detail the review round had to make explicit, since the plan named the
five kinds without ordering them. `changes-requested` outranks open comment
threads outright: a blocking vote is a stronger claim on the author's
attention than an unanswered comment.

**Effective votes, and the deliberate deviation from Azure DevOps's own UI.**
Rather than only special-casing `needs-review`, `computePrState` first
projects every reviewer to an *effective* vote — their real vote if it was
observed at or after the last push, otherwise `0` — and runs every rule,
`approved` included, against that projection. Two consequences:

- "Approved, then the author pushed again" reads as `needs-review`, not
  `approved` — the approval no longer counts as evidence about the code that
  is there now.
- A `−5` the author has already answered with a push **clears**: the PR
  reads `needs-review` (or whatever the fresh votes/threads actually show),
  not `changes-requested`. Azure DevOps's own page does the opposite — it
  keeps a PR red, "waiting for the author," until the reviewer manually
  clears the vote by hand, so a PR can sit red in the browser for a week
  after the fix landed. **This is intentional**: the question this pane
  answers is "who should act right now," and the answer after a push is the
  reviewer. The pane and the Azure DevOps page will disagree about that PR
  until somebody re-votes — on purpose.

Because first sight of a vote is floored *at* the push rather than dated to
whenever this device happened to first poll it, a cold start still shows a
genuinely old, still-valid approval as `approved`; only a push this device
actually *observed* landing after the vote demotes it.

**`author-replied`'s fallback chain.** When every open thread's last word is
the author's, the natural target is whoever opened those threads — but that
set is empty more often than it looks, because `summarizeThreads` (below)
drops deleted comments, and a thread whose *opening* comment was deleted is
attributed to whoever spoke next, often the author. So the rule falls back:
openers who aren't the author, else the reviewers who still owe a vote, else
every reviewer on the PR. Only a PR with **no reviewers at all** ever
resolves to `next: 'nobody'` here — treating an empty opener set as "nobody
is owed a reply" would quietly retire a live conversation.

**`stale` requires `threadsKnown`.** The plan defined `stale` simply as "no
activity for `staleAfterDays`," but `computePrState` also requires that
threads were actually readable this session. On a pre-3.0 server, or before
the first successful detail fetch, `lastActivityAt` collapses to
creation/push/observed-votes alone, and a PR that is in fact commented on
daily would read as abandoned purely because it is old — and `prsGroups`
pulls a stale PR out of *every* other bucket to say so, "Needs your
attention" included. `overdue` is deliberately **not** qualified the same
way: it only measures the wait since the last push (or creation) against the
review SLA, and both of those are visible on any server version.

**`overdue`** applies only while `next === 'reviewers'` — a wait on the
author is never "overdue" in this sense, it's just a wait. Both boundaries
are inclusive: at exactly the SLA (default 48 h) a review *is* overdue, and
a PR with no reviewers at all is `needs-review`/`next: 'nobody'` — nobody was
asked, so nobody is late.

**`summarizeThreads(threads: AdoThread[]) → PrThreadSummary[]`** lives in the
same pure module (the plan didn't say where it should live). It drops
deleted threads and deleted comments outright, and — the part most worth
reviewing — drops threads whose only comments are `commentType: 'system'`:
Azure DevOps files its own "Ana voted 10" and "updated the pull request"
notes as real-looking threads with `status: 'active'`, and counting those
would leave every PR permanently "commented."

**The input carries `authorName` and `meId`**, beyond what the plan's own
description named. `PrState.nextNames` has to be renderable for the three
kinds whose next actor is the author, and `PrView.author.name` is the only
place that name exists. `meId` is used for exactly one thing: putting the
viewer first in `nextIds` so a row can read "Next: you, Bob" — the rules
themselves are otherwise viewer-independent.

### Tracked set and thresholds

`isTracked` no longer excludes approved PRs (through 1.3 it required
`!isApproved(reviewers)` too) — an approved-but-uncompleted PR now **stays in
the list**, under "Ready to complete," because those were exactly the PRs
that used to get forgotten the moment they dropped off. It never counts
toward the badge, though: `PrsStatus.unseen` explicitly skips
`state.kind === 'approved'`, the in-app alert card (`PrAlert.tsx`) diffs its
own key set with the same exclusion, and the OS "new pull request"
notification (`PrService.doPoll`'s `fresh` filter) skips it too — nobody
needs to review an approved PR, so its first appearance is not news. Only a
PR moving to `completed`/`abandoned`/draft still drops out of the list
entirely.

One asymmetry worth knowing before it looks like a bug: **an already-approved
PR that later picks up a new comment lights the badge without announcing
itself.** Its state moves to `comments-open`, so `unseen` counts it again and
the sidebar goes red — but the "new PR" alert only covers PRs that *appeared*
since the last poll, and the only toast that fires on a state change
(`PrService.trackTransitions`, §3) is scoped to pull requests **you
authored**. So somebody else's approved PR growing a comment is information
you'll see next time you open the pane, not an interruption.

**Thresholds** — `PrsConfig.reviewSlaHours` (default 48) and
`staleAfterDays` (default 14) — are additive fields on the existing
`team:prs` payload, edited from the PR prefs pane
(`PrsPrefs.tsx`, "Waiting thresholds," ranges 1–720 h / 1–365 d from
`PRS.reviewSlaHoursRange`/`staleAfterDaysRange`). Two rules protect them
across a mixed-version team:

- **The write path refuses, never clamps.** `PrService.saveConfig` throws
  `invalid-config: …` for a non-integer or out-of-range value (the same
  shape the base-URL/project/repo-list checks already use) — a silent clamp
  would publish a number to the whole team that nobody typed.
  `PrsPrefs.tsx` blocks Save and marks the field while it's out of range;
  `prsIpc.ts` turns a non-number into `undefined` (= keep the team's current
  value) rather than coercing it.
- **The read path clamps to what's already in force, not to the constant
  default.** `materializePrsConfig` walks the sorted event log keeping a
  running "value in force" for each threshold, replacing it only when a
  snapshot carries a number inside the published range. A snapshot that
  **omits** the fields entirely — which is exactly what an ordinary
  **1.3 client's** re-publish looks like, since 1.3 has no idea these fields
  exist — carries the previous winner's values forward rather than reverting
  to 48 h/14 d. Only a log in which *no* snapshot ever carried them falls
  through to the `PRS` constants. `PrService.disconnect()` publishes the
  team's thresholds alongside the empty config for the same reason:
  disconnecting says nothing about the SLA the team agreed on.

`PrsStatus` carries `reviewSlaHours`/`staleAfterDays` as always-concrete
fields (defaulted from `PRS` when the team's config predates them) — this is
what lets the prefs pane prefill the two number fields and the pane's stale
line quote the real number, without either guessing.

**What a 1.3 client sees.** Because everything described in this section is
computed **locally**, per device, from Azure DevOps — never from the share —
a 1.3 build and a 1.4 build genuinely disagree about the same PR, the same
way any earlier client-computed feature does: a 1.3 client still runs its
own (older) `isTracked`, which excludes an approved PR outright, so that
teammate's own list simply never shows it, while a 1.4 teammate sees it under
"Ready to complete." On the wire, a 1.3 client reads and writes `PrsConfig`
without the two threshold fields at all; nothing crashes and nothing is lost
— see the read-path rule above for exactly what a 1.4 client does with a
snapshot like that.

## 2. The pane

`src/renderer/src/team/prsGroups.ts` is a pure module (`groupPrs`,
`waitLabel`, `waitTone`, `nextLine`) that PrsPane.tsx and PrStateChip.tsx both
depend on; none of it touches React or IPC, so it's unit-tested independent
of everything else.

**Groups**, in order, headers omitted for empty ones:

| key | header |
|---|---|
| `attention` | Needs your attention |
| `review` | Waiting for review |
| `author` | Waiting on the author |
| `replied` | Author replied — reviewers to resolve |
| `complete` | Ready to complete |
| `stale` | Stale |
| *(none — renders with no header, exactly like the pre-1.4 pane)* | *(a `PrView` with no `state` yet — a defensive fallback; main always attaches one, so this should be unreachable in practice)* |

A PR lands in **`attention`** when the viewer is personally named in
`state.nextIds`, or the PR is the viewer's own and `state.next === 'author'`
— being *a* reviewer is not enough; you have to be one of the people actually
being waited on right now. Everything else buckets by `state.kind`
(`needs-review`→review, `changes-requested`/`comments-open`→author,
`author-replied`→replied, `approved`→complete). **`stale` is pulled out of
whichever bucket a PR would otherwise land in — `attention` included**: a PR
that's dead for two weeks needs "abandon or revive?", not to sit disguised
among this week's urgent asks.

Within a group, PRs sort by `state.since` ascending (longest wait first),
ties broken by key; the header-less fallback bucket instead sorts newest
`createdAt` first, the same rule the pane has always used.

**The wait chip** (`PrStateChip.tsx`, using `waitLabel`/`waitTone`):

| kind | label |
|---|---|
| `needs-review` | `Review · {duration}` |
| `changes-requested` | `Author · {duration}` |
| `comments-open` | `Author · {n} comment(s) · {duration}` |
| `author-replied` | `Reviewers · replied {duration} ago` |
| `approved` | `Complete · {duration}` |
| *(any, when `state.stale`)* | `Stale · {duration}` — measured from `lastActivityAt`, not `since`, and this overrides every other label |

`{duration}` is compact and never negative — `45 m` under an hour, `4 h`
under a day, `21 d` beyond that. Tone is `neutral` under the team's review
SLA, `warn` at it, `danger` at 2×; a stale PR is always `danger` regardless
of how fresh its *current* wait happens to look. No new colour literals —
neutral uses the existing panel/border/text tokens, warn and danger use
`color-mix(… var(--warning) …)`/`var(--danger-soft)` because no
`--warning-soft` token exists.

The chip's **tooltip** (`prStateTooltip`) reads all four facts in one
sentence: `created {x} ago · last push {y} ago` (or `no pushes known`) `·
last activity {z} ago · {n} open comment(s)` (or `comment status unavailable
on this server` when `!threadsKnown`). The same sentence — plus the chip's
own label and the **next line** — is folded into the row's `aria-label`, so
a screen-reader user gets the same "how long, and who now" a sighted user
gets from the chip, not just the bare title. The **next line**
(`nextLine`) reads `Next: Ana, Bob` or, when the wait is on the author,
`Next: Carlos (author)`; it's empty when nobody is named.

**Header counts.** The pill next to "Pull requests" counts the *filtered*
list (tooltip: "N shown of M tracked"), and so do the overdue/stale counts
next to it — deliberately, since that chip sits directly above the rows it
describes, and a team-wide number there would misdescribe what's on screen.
`PrsStatus.overdue`/`stale` stay the team-wide numbers; the sidebar row's "·
N overdue" suffix (`Sidebar.tsx`'s `TeamSection`) uses those, not the pane's
filtered count.

**Filters are unchanged**: the `All / Assigned to me / Mine` segmented
control, a target-branch select, a repo select (shown only with more than
one watched repo), and a text search over title/author/branch/repo/`#id`.
On the team's shared token, every "me"-relative label and filter answers for
whoever configured the group, not the reader — the header's "as `<name>`"
chip and the segmented control's relabelled options are unchanged from 1.1.

**Accessibility**: group headers are real `<h3>` elements (spec requirement,
not just styled text); each row is a keyboard-reachable `role="button"` with
Enter/Space activation (unchanged); the row's `aria-label` carries the full
state sentence described above.

## 3. Notification controls

One popover (`src/renderer/src/app/NotificationsPopover.tsx`), opened from a
bell in **two places** — the sidebar footer, next to the gear, and the
pull-request pane's header, next to *its* gear — both rendering the exact
same component against the exact same `SettingsView` fields. There is no
parallel state: whichever surface you change a setting from, the other
already shows it, because both are shortcuts into `settings.set`. The bell
itself (`NotificationsBell`) swaps to a slashed icon, dimmed, whenever
`alertsSilenced()` is true — the pause is running, quiet hours are running,
or both selectors sit at their quietest setting simultaneously.

**The popover**, top to bottom: a **Pull requests** row (`All` / `Only mine`
/ `Paused`, with a one-line hint under each choice); a **Chat** row
(`Everything` / `Only about me` / `Nothing`, plus a fourth **Custom** segment
that appears only while the two underlying switches sit in a combination
none of the three presets can write — picking `Custom` is impossible, it's
purely a readout); a **Pause everything** row (`Off` / `1 hour` / `Until
9:00 tomorrow`); a quiet-hours status line, shown only when quiet hours are
turned on, naming either "silenced until `{to}`" (running now) or the window
itself (scheduled for later); and a link to the full Settings window,
opening it straight to the Notifications section. The Settings modal's own
copy of the pause control offers only `Off` / `For 1 hour` — it has no
"until 9:00 tomorrow" choice, a real difference between the two surfaces for
the same underlying setting.

**Setting → what still notifies:**

| Setting | Value | What still interrupts |
|---|---|---|
| Pull requests | All | Every tracked PR, on arrival, plus your own PR's transitions (below) |
| | Only mine | Only a PR you're currently being waited on for (`state.nextIds`), assigned to you, or authored by you |
| | Paused | Nothing — the badge and the pane still update |
| Chat | Everything | Every channel message, every DM, every private-group message |
| | Only about me | @mentions/@here in channels, **plus every DM and private-group message** — those ignore the channel setting entirely, since you were invited into them personally |
| | Nothing | Nothing — unread counts still add up |
| Pause everything | 1 h / until 9:00 | Nothing chat- or PR-related, OS or in-app — **beam offers are exempt**, they still come through |
| Quiet hours | on, in-window | Same coverage as the pause (chat, pull requests, the in-app PR card) — **beam offers exempt here too** |

Badges, unread counts and the pane/pull-request list itself are never
filtered by any of the above — "the app still updates" is literal.

**Author-side transition alerts.** Separate from the "new pull request"
alert, `PrService.trackTransitions`/`notifyTransitions` watch **your own**
pull requests for three specific moves — `changes-requested`,
`comments-open` (including a previously-approved PR that grows a new
comment — see §1's asymmetry note), and `approved` — and toast once per
actual change, not once per poll:

> "Your PR #42 — changes requested by Ana" · "Your PR #42 has 2 open
> comments" · "Your PR #42 is approved — ready to complete"

Deduplication is per PR key (`lastKind`, memory-only): a state that flaps
between two polls still costs one notification per real change, a PR seen
for the first time is only ever recorded (nothing to have moved *from*), and
a config change clears the map outright so the very next poll never toasts
off of it. `myIdentity()` — and with it every one of these toasts — is
**empty on the team's shared token**, since `this.me` there is whoever
configured the group, not the reader; transition alerts only exist for a
personal token. Like every other toast, these are silent while the window
is focused, and gated by the same `shouldNotifyPr` preference/pause/quiet-
hours check as an arriving PR. There is currently no in-app card for these
— only the OS toast (see CLAUDE.md's deferred list).

**Snooze.** `snoozeChoices(now)` computes "an hour from now" and "9:00
tomorrow" in **local** time — always the *next* calendar day, so a pause set
at 2 a.m. doesn't quietly expire seven hours later the same morning.
`snoozeUntil` is a plain ms-epoch; a null or already-past deadline reads as
off.

**Quiet hours are now enforced — say plainly that before 1.4 they were only
stored.** `SettingsView.quietHours` has been editable and rendered in
Settings for longer than that, but no code path ever read it; `shouldNotifyChat`
and `shouldNotifyPr` both gate on `inQuietHours()` as of 1.4, covering OS
toasts for messages, live-board invites and pull requests, plus the in-app PR
alert card, without a single call site changing. The window is local
wall-clock and wraps past midnight (`from > to`, matching the 22:00–07:00
default shape); `from === to` is the *empty* window and reads as off, not as
24 hours of silence; and anything malformed — a bad time string, an unknown
zone — reads as off too, because the function can only ever suppress a
notification and must fail toward letting one through. Beam offers are
exempt from quiet hours for the identical reason they're exempt from the
pause.

## 4. Launch nudge

A small card, bottom-left (`LaunchNudge.tsx`, "Get the most out of Chat"),
suggesting two things until both are accepted: opening Chat at login, and
allowing OS notifications. Gil's ask, verbatim: "each time they open the
app, if not accepted yet, they should have the suggestion to do so" — so
dismissing it ("Not now") lives in plain in-memory store state
(`launchNudgeDismissed`), not `localStorage`. That state survives an
`AppShell` remount within the same run (an unlock, a folder-change screen),
but nothing persists it to disk, so a genuine relaunch brings the card back
on its own — exactly the "each launch" behavior asked for, and deliberately
different from the update banner's own "remind me later," which *is* meant
to stick. The card only ever appears once `boot.mode === 'ready'` (past the
unlock screen), sits at z-index 55 — under the sidebar's own notification
popover and the quick switcher, above ordinary pane content — specifically
because it used to sit at 690 and cover that same popover.

**Each row** (`nudgeRows`) is offered only when this OS/build actually
supports it, and marked done independently of the other:

- **"Open Chat when you log in"** — shown when `openAtLoginSupported`
  (macOS or Windows; not Linux). Done once `LaunchInfo.openAtLogin` is true.
- **"Allow notifications"** — shown when `notificationsSupported`. Done once
  `settings.notificationsAccepted` is true.

**`status: 'requires-approval'` on macOS 13+.** SMAppService can register
the login item and still hold it behind a manual approval in System
Settings → General → Login Items. Chat treats that as **on**
(`openAtLogin: true` everywhere it's read) — the row shows its done
checkmark, not a "Turn on" button — but its sub-text still says where the
last step lives: *"macOS may need you to allow this under System Settings →
General → Login Items."* The identical sentence appears in three places:
this row's caveat, the toast `LaunchNudge` shows if `setOpenAtLogin(true)`
comes back with `openAtLogin: false` on a Mac, and the matching row in
Settings.

**The Windows `execPath` caveat.** Windows has no installer — Chat ships as
a zip — so `loginItemOptions('win32')` registers the login item against
`process.execPath`, wherever *this* copy happens to be running from right
now; macOS takes no path at all, since the app bundle registers itself
through SMAppService. If that folder is later moved, Windows can no longer
find the target and the entry quietly goes stale. Nothing detects this
specially: `app:launchInfo` always re-reads live OS state on demand, so
`openAtLogin` simply reports `false` again on the next launch and the nudge
reappears by itself. This caveat has no dedicated user-facing copy today —
it's documented as an engineering note in `src/main/ipc.ts`, not surfaced in
the nudge or Settings.

**The passphrase caveat.** Because Chat never touches the macOS Keychain
(see CLAUDE.md's iron rules), an auto-launch from the login item does not
skip the unlock screen — the row's sub-text says so on macOS specifically:
*"You'll still enter the team passphrase after a restart."* Windows has no
equivalent line, because DPAPI/`safeStorage` unlocks silently there.

**Settings toggles** mirror the nudge, in a "Launch" group inside
Settings → Notifications (rendered only when at least one capability
exists): the same "Open Chat when I log in" toggle with the same
platform-specific caveat text, a "Notifications" row with a **Send a test
notification** button, and a **"Suggest these at launch"** toggle
(`suggestAtLaunch`, on by default) — turning it off is a deliberate, sticky
opt-out that `shouldShowLaunchNudge` honours immediately, unlike the
per-launch "Not now."

**"Asked on this device."** — the exact line shown under the Notifications
row once `settings.notificationsAccepted` is true. It is a best-effort flag,
not a real read of the OS permission: neither Electron nor the OS hands back
whether someone actually clicked *Allow*, so this only ever records that
Chat's own button was pressed and a notification was actually shown
(`app:testNotification`, guarded by `Notification.isSupported()` the same
way every other notification path in the app is).

**The write/read mismatch, fixed.** `app:setOpenAtLogin` used to register
the Windows login item with `args: ['--opened-at-login']` while
`app:launchInfo` read it back with none; Electron's
`getLoginItemSettings` only reports truthfully when queried with the exact
options the item was registered with, so the read always answered
`openAtLogin: false` about an item that genuinely existed — the Settings
toggle would visibly bounce back off, and the nudge would never stop coming
back. Nothing in the app ever consumed that argv flag, so the fix removes it
entirely and routes both the write and the read through one shared
`loginItemOptions(platform)` in `src/main/loginItem.ts`.

## 5. Tests

**Shared/state:** `src/shared/prState.test.ts` — every `PrStateKind`
(`needs-review`, `changes-requested`, `comments-open`/`author-replied`,
`approved`), the `since` rule per kind, overdue/stale boundaries (inclusive
at exactly the SLA/2×SLA/`staleAfterDays`), threads-unknown behavior, votes
observed before/at/after a push, required vs. optional reviewers, and the
whole `summarizeThreads` block (opener/last-speaker/times, open-status
filtering, deleted threads and comments, Azure DevOps's own system threads,
missing dates/authors/comment arrays). `src/shared/prs.test.ts` —
`isApproved`; `isTracked` now keeping an approved PR; `toPrView` including
`lastMergeCommit`; `materializePrsConfig`'s threshold carry-forward,
clamping-to-current-not-default, and in-range preservation; the token/key
redaction helpers; `normalizeBaseUrl`/`baseUrlOrigin`. `src/shared/
notifyDecision.test.ts` — a pre-1.4 profile behaving exactly as 1.3 did;
`shouldNotifyChat`/`shouldNotifyPr` including the "mine" test (`nextIds`,
`assignedToMe`, authorship) and a view with no `state` yet; the popover
presets including `custom`; `snoozeChoices`; `alertsSilenced`; `inQuietHours`
(midnight wraparound on both sides, inclusive/exclusive boundaries, an empty
window reading as off, malformed input failing open, the machine's own zone
by default); "quiet hours silence the things that interrupt" across chat,
mentions, private groups, live-board invites, and the PR toast and card
alike.

**Main:** `src/main/services/prService.test.ts` — configuration and
materialization; polling and tracking (an approved PR kept but excluded
from the badge, a completed/abandoned PR still dropping out entirely);
errors and exponential backoff; arrival notifications (focus suppression,
never toasting your own PR, the shared-token exception, never repeating,
skipping the first poll after your own config save); the 1.4 preference
gate including quiet hours and the pause; author-side transitions (dedupe,
naming the blocking reviewer, never on someone else's PR, obeying "none",
never on the first poll after a config change); the seen set; detail
refresh cadence (first sight, commit-change, spreading first sight and the
round robin over several polls, the forced-list cap, retrying a failed read
once per window without ever failing the poll, clearing the cache on a
project move but not a token change, asking nothing below the threads API);
the waiting state itself feeding `status()`'s overdue/stale counts; the vote
history (flooring at the push, surviving a restart, pruning); the shared
thresholds (defaulting, refusing an out-of-range write, reading a 1.3
config as the defaults, a share-driven change taking effect); the prefs
RPCs and the personal-token-per-server binding; races between a poll in
flight and a token/config change or a `markSeen`; and the team-log writes,
including `disconnect` clearing `prs-seen`/`prs-history` while keeping the
personal token. `src/main/services/ado.test.ts` — request shape; success
parsing; continuation-token paging; API-version negotiation (naming a
version, walking the ladder, never re-offering a burned rung); the new
`threads`/`iterations` endpoints (URL shape, `unsupported` below 3.0, 3.0
itself supported, a mid-flight downgrade reading as `unsupported` rather
than an error, `apiAtLeast`'s numeric comparison); status/body mapping (203,
an unfollowed redirect, non-JSON, a non-object JSON body); thrown-error
mapping; bad URLs; and the token never leaking into any error detail.
`src/main/loginItem.test.ts` — `loginItemOptions` describing the item
identically for the write and the read, never writing `args`, no path on
macOS; `launchInfoFrom` mapping `enabled`/`requires-approval`/
`not-registered`/`not-found` to on/off, falling back when a macOS build
reports no status, ignoring status on Windows, and only macOS ever
answering `wasOpenedAtLogin`.

**Renderer:** `src/renderer/src/app/launchNudgeState.test.ts` —
`shouldShowLaunchNudge` (both pending, both accepted, one left, the
deliberate opt-out, unsupported facts, settings/launchInfo not loaded yet);
`nudgeRows` (macOS copy and caveats, Windows dropping them, a row omitted
entirely where unsupported, the `requires-approval` hint shown as done, the
passphrase caveat on an ordinary enabled item, each row's done state
resolved independently). `src/renderer/src/team/prsGroups.test.ts` —
`groupPrs`'s attention rule (a blocking reviewer, an author whose PR is
next, *not* being "next" merely for authoring a PR waiting on reviewers),
per-kind bucketing, stale pulled out of `attention` and `complete` alike, an
empty stale group on a server that can't serve threads, `meId === null`,
group order and omission of empty groups, sort-by-`since` with a key
tie-break, and the header-less legacy fallback sorting newest-first;
`GROUP_LABELS` matching the spec strings exactly; `waitLabel` per kind
including the stale override; `waitTone`'s boundaries including a custom
SLA; `nextLine`'s reviewer list, author suffix, and empty cases.
`src/renderer/src/team/PrStateChip.test.ts` — the leaf-first module load
against `PrsPane.tsx`'s own import of `errorSentence`/`agoPhrase` (so
neither side of that cycle can be half-built), and `prStateTooltip`'s four-
fact sentence including "comment status unavailable," "no pushes known,"
comment-count pluralization, and an honestly-reported unknown creation date.

**E2E (`scripts/e2e-drive.mjs`).** The fake Azure DevOps server gains
`/pullRequests/{id}/threads` and `/pullRequests/{id}/iterations` routes,
matched case-insensitively and anchored so they can't be confused with the
`/pullrequests` list route. Two PRs carry detail: #4271 has one open thread
whose last human comment is the reviewer's (driving `comments-open`, waiting
on the author), one resolved thread, one thread that is pure
Azure-DevOps-system-comment noise, and one iteration; #4288 is fully
approved with no threads or iterations at all. Checks: alice now lists
**both** pull requests (the approved one kept for "Ready to complete," where
1.1–1.3's E2E asserted it was filtered out); `status()` carries numeric
`overdue`/`stale` counts and the team's `reviewSlaHours`/`staleAfterDays`;
bob — reading the same PRs independently, over the team's shared token —
computes `comments-open`/`next: 'author'`/`openThreads: 1`/
`threadsKnown: true` for #4271 purely from his own two extra reads; the
approved PR reads `kind: 'approved'`/`next: 'author'` and is excluded from
`unseen`; marking it seen drops `unseen` to 0; moving a PR to
`status: 'completed'` upstream still drops it out of the list entirely
(only completion does that now, not approval); and, driven through the
**real** bell button in bob's sidebar (a DOM click, not a store poke),
pausing pull-request alerts there both updates `settings.notifyPrs` and
silences a brand-new PR's alert card for 8 seconds, and switching back to
"All" the same way restores the alert-card check that follows it. The
script does **not** exercise a genuinely stale PR (its fixture PRs are hours
old, never 14 days) or the launch nudge at all — both are unit-tested only;
see the discrepancies section below.

## 6. Compatibility

Nothing in 1.4 changes the envelope format, key derivation, or any existing
on-share file's shape, and unlike 1.2/1.3 it adds no new event type or
directory at all — the two new Azure DevOps endpoints are pure reads against
an external server, and the vote-observation history lives only in a local,
per-device secret. The one wire-visible change is additive: `PrsConfig`
gains two optional numeric fields (`reviewSlaHours`, `staleAfterDays`) on
the same `team:prs` payload every version already reads and writes.

- **A 1.3 (or 1.1/1.2) client** reads and writes `PrsConfig` exactly as
  before — it has no idea the two threshold fields exist, so it never writes
  them and silently ignores them on read. §1 covers precisely what a 1.4
  client does when it sees a snapshot missing them (carries the team's
  current thresholds forward rather than reverting to the constants).
- **Older and newer clients can disagree about the same PR**, and always
  could: none of this is share truth, it's every device's own read of Azure
  DevOps. A 1.3 build still runs its own `isTracked` (which excludes an
  approved PR outright), so that teammate's list simply never shows it,
  while a 1.4 teammate sees it under "Ready to complete." Nothing forces the
  two to agree, the same as any other client-computed feature.
- **A server older than REST API 3.0** (pre-TFS-2017) leaves every 1.4
  client with `threadsKnown: false` for that PR forever: `comments-open` and
  `author-replied` are unreachable (both require threads), the chip's
  tooltip says comment status is unavailable, and the PR can never be marked
  `stale` there — only `needs-review`/`changes-requested`/`approved` and
  `overdue` are still computed, since those need only votes, pushes and
  creation time, all visible on any server version.
- The notification popover, the launch nudge, and the login-item fix are
  entirely local to the machine running them; none of it has any
  share-visible footprint.

## 7. Tester fixes — the diagram editor

Gil tested the packaged macOS build and reported that in diagram mode none of
the buttons along the top were clickable, that the diagram's name sat under
the window's minimize buttons, that there was no way to leave the mode or to
tell whether a board was live for anyone else, and that the default drawing
style looked hand-drawn rather than finished. All four have one structural
cause and three cosmetic ones.

**The header is now the drag strip.** The main window is frameless
(`titleBarStyle: 'hiddenInset'` on macOS, `hidden` + a 44 px `titleBarOverlay`
on Windows — `src/main/index.ts`), and `AppShell` paints a 36/32 px
`-webkit-app-region: drag` strip across the top. Chromium computes draggable
regions from the DOM regardless of z-order, so that strip stayed draggable
*underneath* the editor's `position: fixed; inset: 0` overlay: every press in
the editor header's top 36 px was consumed by the window server as the start of
a window drag and never reached the button. The E2E never caught it because a
CDP-dispatched click is delivered into the DOM, below the level at which the OS
steals the press — and for the same reason no automated check can prove the fix.
What the run asserts instead is the computed region the OS reads: the header
container reports `drag`, all seven of its controls report `no-drag`, and the
title input starts at x = 129 on macOS. `overlayChromeInsets(platform,
fullscreen)` (`src/renderer/src/app/overlayChrome.ts`, pure and unit-tested)
supplies the padding that keeps the content clear of the OS's own buttons:

| Platform | Windowed | Fullscreen | Why |
| --- | --- | --- | --- |
| macOS | `left: 90` | none | Traffic lights measured at ≈25–82 px from the window's left edge; 90 leaves a gap after the green one. |
| Windows | `right: 150` | none | Three ~46 px caption buttons in a 44 px-tall overlay, which fits inside the 52 px header — one padding is enough. |
| Other | none | none | The shell draws its decorations outside the web contents. |

The same rule was applied to every other full-window overlay whose controls
reach that band — the media lightbox's chrome strip, the screen-share viewer's
header — and `NO_DRAG` was added to the modal backdrops (`ConfirmDialog`,
`LiveCloseDialog`, the screen-share dialogs), where a click-away in the top
36 px used to drag the window instead of dismissing.

**Escape escalates.** It used to be Excalidraw's unconditionally inside the
canvas, so an idle canvas swallowed it and the (unclickable) Close button was
the only way out. `escapeAction(state, fullscreen)`
(`src/renderer/src/diagram/escape.ts`) now hands it to Excalidraw only while
Excalidraw has something of its own to cancel — a text edit, a dialog, a menu
or popover, a linear/crop edit, a selection, or an armed tool — then leaves
fullscreen, then closes the editor behind the existing dirty confirm. Close is
also a labelled button ("Close" beside the ×) rather than a bare icon; its
`aria-label` is unchanged.

**The Live pill says what is happening.** "Start live session" is now **Go
live** with a tooltip that explains what it does, and going live shows a
one-time dismissable hint under the header naming the conversation teammates
join from. The pill itself carries a pulsing dot, LIVE, the participants, and a
sync state — **Synced**, **Sending…**, **Waiting for teammates**,
**Reconnecting…** — derived by the pure `liveStatusLabel`
(`src/renderer/src/diagram/liveStatus.ts`) from timestamps `useLiveBoard` now
exposes through `syncStats()`: when a write of ours was last accepted, when a
peer's frame last landed, whether a write is in flight, how many peers are on
the board, and `health.reachable`. Silence longer than 15 s from a peer the
roster still lists means the poll is stuck, because every participant
republishes its last frame every `BOARD.keepaliveMs` (10 s). The stats are read
on a one-second tick inside the pill rather than pushed through React state, so
a board being drawn on several times a second does not re-render the header at
that rate. The `[role="status"][aria-label^="Live board"]` contract the E2E
reads is unchanged.

**New diagrams start clean.** `CLEAN_APP_STATE`
(`src/renderer/src/diagram/style.ts`) seeds a fresh canvas with
`currentItemRoughness: 0`, `currentItemStrokeWidth: 1`, Nunito
(`FONT_FAMILY.Nunito` = 6; its woff2 faces are among the bundled fonts,
Xiaolai's deliberately are not), round joins, `#1e1e1e` strokes, a transparent
background, solid fill, a white page and no grid. `initialAppState` merges a
scene's own `appState` over the top, key by key, so a rough diagram someone
sent still opens exactly as they drew it and nothing already on a canvas is
restyled.

## Claims not confirmed in code, and discrepancies from the plan

- **`PrsPane.tsx`'s empty-state copy still describes the pre-1.4 rule.**
  When there are no tracked pull requests at all, the pane shows "Nothing
  waiting for review 🎉" followed by *"Approved, completed and draft pull
  requests drop off this list automatically."* That second sentence
  contradicts this release's own tracked-set decision — an approved PR no
  longer drops off, it moves to "Ready to complete" — and appears to be
  leftover copy nobody updated once §1's rule changed. Not called out in
  `contract-changes-1.4.md`.
- **The "Pause everything" control differs between the two surfaces that
  edit the same setting.** The notification popover offers `Off` / `1 hour`
  / `Until 9:00 tomorrow`; the Settings modal's copy of the same control
  offers only `Off` / `For 1 hour`, with no "until tomorrow" choice. Neither
  the plan nor the contract-changes doc mentions this asymmetry; it reads as
  an oversight rather than a deliberate design choice, but nothing in the
  code says either way.
- **No dedicated test covers the sidebar's new "· N overdue" subtitle.**
  The plan called this out explicitly as "the smallest edit" to
  `Sidebar.tsx`; there is no `Sidebar.test.tsx` in the tree, so the only
  coverage is incidental (the E2E's general pull-request checks never
  assert on the sidebar row's text). Not a contradiction, just an
  unconfirmed corner.
- **The E2E script does not exercise a genuinely stale PR or the launch
  nudge**, despite both being named 1.4 deliverables. The fixture PRs are
  hours old (never near `staleAfterDays`), so the "Stale" bucket and its
  pane copy have no live-app coverage beyond `prState.test.ts`/
  `prsGroups.test.ts`; the launch nudge has no E2E coverage at all — only
  `launchNudgeState.test.ts`'s pure-function tests. Everything else named in
  the plan's E2E ask (§M's work-stream description) was found and matches.
- Everything else checked against the plan and `docs/contract-changes-1.4.md`
  — the endpoint casing, the `AdoDetail<T>` shape, the precedence table, the
  round-robin/forced-refresh split, the threshold carry-forward/clamp rule,
  quiet-hours enforcement and its beam-offer exemption, and the login-item
  write/read fix — matches the code exactly, including the two places the
  contract doc itself records a mid-review correction (the forced-list cap,
  and clamping to the value already in force rather than to the constant
  default).

## 8. Tester fixes — the rest of the first-build feedback

- **GIF category chips did nothing.** The chips set the search query to their
  label, and the pack filter only matched ids and URLs. `content/gifFilter.ts`
  now filters by the pack's real `category` (the eight chips match the eight
  categories in `resources/gifs-starter/manifest.json`); a chip whose category
  has no items is hidden; typing clears the chip; the query also matches
  category names.
- **Footer status was truncated to "S…".** The sidebar footer is two lines:
  the display name, then the status in full width ("Set a status" when unset).
  The device chip moved into the status popover and the button's tooltip.
- **Prefs icon.** `IconGear` is Feather's cog (MIT) instead of an asterisk.
- **Quick messages.** *(Reworked after the first round: the ⚡ popover is gone
  — a picker for five phrases was one click too many.)* The composer renders
  them inline, as a single row of chips directly above the textarea
  (`renderer/src/chat/QuickRepliesRow.tsx`). Five defaults, flat, no groups
  ("On it 👀", "LGTM ✅", "Can someone review my PR? 🙏", "In a meeting, back
  in 15", "Done ✅" — `src/shared/quickMessages.ts`). A plain click **sends**
  the chip immediately as a normal text message in the active conversation;
  ⌥/Alt-click inserts it at the caret instead (title `Send “…” (⌥-click to
  insert)`, aria-label `Send quick reply: …`). The row hides while the draft
  has any text and in conversations nothing can be sent to (`team:` panes) —
  the pure rule in `src/shared/quickReplyVisibility.ts`. A rejected send is
  never mislabelled: `shared/quickSendFeedback.ts` splits the outbox's
  `queued` (footer chip, info toast) from a real failure such as a deleted
  channel (danger toast naming the message — the chip's text never passed
  through the textarea, so there is nothing left on screen to retry from).
  Settings → Quick messages edits the list (`SettingsView.quickMessages`,
  `null` = defaults; **5 entries × 120 chars**, enforced on save
  (`normalizeQuickMessages`), on the way to the screen
  (`effectiveQuickMessages`, so a list customized under the 40-entry draft
  cannot still render 40 chips) and in `appController.setSettings`). E2E: bob
  opens #general, the row shows exactly the five defaults, he clicks the first
  chip and alice receives "On it 👀" as a normal message.
- **Status didn't survive a relaunch, and nobody could see their own row.**
  `SettingsView.status` persists the status line in plaintext settings (it is
  already public in every beacon this device writes), and `restoredBeaconPresence`
  puts it back into the beacon before the first one goes out on the next launch
  — `statusFromSettings` is the one place that decides what "no status" means
  (absent, empty and whitespace-only all read as none), and `appController.ts`
  now routes through it instead of reading `this.settings.status` directly.
  `presence.self()` gives the footer this device's own row (`presence.list()`
  is deliberately everyone *else*), and the handler now resolves `null` instead
  of rejecting with `not-ready` before a session exists, matching what the
  bridge always promised. Every person row (sidebar, members rail, group
  dialogs) is two lines now — name, then status — with the hostname·fingerprint
  identity chip parked invisible and out of the accessibility tree and tab
  order until the row is hovered or focused (`PersonLines.tsx`,
  `.sem-chip-reveal`); a flagged chip is the one exception that never hides.
- **Say hello could double-send while the share was offline, and could also
  just do nothing.** `ChatService.send` resolving with a queued outcome
  (`publishWithOutbox` hands the message to the outbox when the share is
  unreachable) was being treated as a rejection: the latch dropped and
  re-enabled the button, so a second press queued a second "Hello 👋" once the
  folder came back. A queued send now counts as success — the latch stays up
  and the toast still says "queued — will send when the folder is back"
  (`sayHelloWasQueued`, `EmptyStates.tsx`). The latch itself is also no longer
  a single `{ conv, phase }` slot: it is a per-conversation set
  (`sayHelloState.ts`), so switching to a second empty conversation while the
  first hello is still in flight can no longer evict — and later re-enable —
  the first one's latch. And a send into a channel this session only knew by
  id (`EventStore.publish`'s on-demand `ensureChannel` load, the exact window
  the original "Say hello does nothing" report lived in) now pushes `channels`
  immediately instead of leaving the sidebar nameless until an unrelated push
  happened by — the same nudge the poller's own on-demand load path
  (`onNewDevice`) already had.
- **A same-machine re-join looked like impersonation, and the ghost lingered
  for days.** Full story in §9 — the short version: `Poller.presenceViews()`
  now runs its supersession rule over the whole roster including this device's
  own record, so the one client that used to never see it (the person who just
  re-joined, looking at their own sidebar) is no longer stuck for
  `PRESENCE.departedAfterMs` (three days). `PresenceView.supersededBy` carries
  the winner's device id to the loser's row; every people-listing surface hides
  that row except the group dialogs, which label it "(previous device)"
  (`memberRowSuffix`) instead — a group membership list has to stay reachable
  for the owner to remove it, so both the "Current members" list and the
  add-people candidates show and can act on that label rather than the same
  name doubled with no explanation. `Roster.nameCollision` also stopped
  flagging the survivor: a pin that is *provably* the same machine (same name,
  same hostname, same `machineIdHash`) no longer trips the TOFU check that used
  to leave the person's own device wearing a red flagged chip permanently.

## 9. "The password is wrong, and now there are two of me"

One report, two halves. They are connected only by the order they happened in.

### The passphrase that stopped working

Nothing was wrong with the passphrase. On 2026-09-14 a packaged verification
script called `bridge.onboarding.submit({ … passphrase: 'correct horse battery
staple' … })` against the **default** profile while it sat on the unlock
screen. `SEMAPHORE_PROFILE` is dev-only and a packaged build ignores it, so
"the temp profile" was the real one; `onboardSubmit` saw a locked store and
called `createPassphraseLmk`, which sealed a *new* LMK over the existing one.
From that moment the real passphrase could not open `lmk.sealed` — it is the
right key for a lock that was replaced — and every `*.enc` beside it (identity,
roster pins, DM keys) was unreadable too. See CLAUDE.md's "Profiles and test
runs" for the full post-mortem and the rules it produced.

1.4 makes that call impossible: `onboarding.submit` answers `{ ok: false, error:
'locked-profile' }` when `store.hasSealedData() && !store.unlocked`, before it
touches the share, and sends the person to the unlock screen with that sentence
(`unlockNotice`). `LocalStore.createPassphraseLmk` throws over any existing seal
as the floor under every caller, and `CHAT_USER_DATA_DIR` is honoured by every
build so a verification run can never land on the real profile by accident.

Recovery is what the reporter found on their own: **Reset local data**, from the
unlock screen, then re-join the same folder with the same passphrase. Everything
on the share comes back — it was never touched. What does not come back is the
device identity, and that is the second half.

### Why that left two of the same person

A device registration is never deleted from the share: its signature is what
keeps every message that device ever sent verifiable. Re-joining therefore
*adds* a record rather than replacing one, and both records name the same
person, on the same machine. Every roster surface then shows them twice.

`src/main/transport/supersede.ts` (pure, unit-tested) decides which of two
registrations is the ghost: same display name (trimmed, whitespace-collapsed,
case-insensitive), same sanitized hostname, machine fingerprints equal or
unavailable on either side, later `firstSeen` on the survivor — and the
predecessor not beaconing right now. That last guard is what tells a reset apart
from two live instances on one machine under one name: a destroyed identity can
never write another heartbeat, and it is asked entirely in share time
(`Poller.beaconLive`), never by comparing a beacon stamp against a `firstSeen`
written on someone else's wall clock.

`Poller.presenceViews()` runs that rule over the **whole roster, including this
device's own record**, and marks the loser `departed` with `supersededBy` set.
Both details matter:

- Including `self` is the actual fix for the report. The rule already existed,
  but it ran over the list the views are built from, which has the local device
  filtered out — so the one client where the superseding record *is* the local
  one (the person who just re-joined, looking at their own sidebar) could never
  see it. That client waited out `PRESENCE.departedAfterMs`: three days.
- Not gating on `state === 'offline'` costs the other clients the two minutes it
  takes a leftover beacon to go stale.

Every surface that lists people already filtered `departed` — the members rail,
the group add-member picker, the mention picker, the quick switcher, the channel
member count, the outdated-build count — so they all came right at once. Three
did not, and were fixed:

- **The sidebar's direct messages** (`app/peopleRows.ts`, pure): a superseded
  device is listed only when that DM holds history, and then as "Gil (previous
  device)". It is stickier than an ordinary departed row (which goes as soon as
  its unread count reaches zero) because that history can never move anywhere
  else — the old identity's DM is a different conversation, under a different
  key, from the new one's.
- **The group members rail** (`groupMemberRows`), which listed members by id and
  so showed the ghost even though presence knew perfectly well nobody was
  behind it.
- **The composer's mention roster**, the quiet one. `detectEntities` binds
  "@Gil" to the first roster row with that name and stops, so a stale
  registration sharing a name could swallow every mention of that person — the
  notification would be addressed to a device nobody is on, and the person who
  was actually there would never be told.

Names still resolve everywhere they must: the roster entry stays, so old
messages, poll voters, calendar authors and board frames all keep their name and
still verify. This is a hide, not a delete — and if that device ever did come
back, the row would be back with it.

Three more things the report's own story runs into, each fixed after review:

- **The survivor was being flagged as an impersonator.** TOFU flags a new
  device that claims a display name already pinned to a different device — and
  a re-join is exactly that, so the person's *real* device came back
  `trust: 'flagged'` and wore the red `MBP-GIL·Q7RC` chip in the sidebar, the
  members rail and the group dialog, permanently, on every teammate's screen.
  Hiding the ghost made that worse, not better: the one row left standing was
  the accusing one. `Roster.nameCollision` now skips a pin that is the
  *provably* same machine (`provenSameMachine`: same name, same sanitized
  hostname, and the same `machineIdHash` — a hash of the hardware UUID on
  macOS and Windows, which no amount of local wiping changes). Unlike the
  hiding rule, this one refuses to accept a missing fingerprint as a match:
  hiding a row also needs the predecessor to be provably silent, and dropping
  an impersonation warning has no such second half. A namesake from another
  machine is still flagged, loudly. `Roster.healFlags()` re-asks the question
  for every flagged pin at the end of each `refresh()`, which is what clears a
  flag pinned before this rule existed — and what keeps the answer from
  depending on whether the device directory happened to list the new record
  before the old one.
- **The group dialog's "Current members" keeps the ghost, on purpose.** A
  group's membership is a list of device ids, and the superseded id is still
  on it, still holding a group key that still decrypts: the owner has to be
  able to see that row to remove it. This is the one people-listing surface
  that does not drop a superseded device — so it labels it instead
  (`memberRowSuffix`): "Gil (previous device)", with the status line's "No
  longer on the share" under it and a Remove button that says
  "Remove Gil (previous device)". The members rail, which exists only to say
  who is around, still hides it.
- **The window nobody can close.** Everything above is immediate because the
  previous run wrote a goodbye beacon on its way out, or because its last
  heartbeat is already stale. Kill it hard instead — force quit, crash, power
  cut — and for up to `PRESENCE.onlineWithinMs` (50 s) its last heartbeat is
  still fresh, so the rule refuses to hide it and both registrations are
  listed. That bound cannot be tightened: a second live instance on the same
  machine may sit at the idle tier and beacon only every
  `BEACON.idleHeartbeatMs` (45 s), so anything quicker would hide a device
  that is right there. What *is* fixed is what happens inside those seconds:
  every surface that turns a name into one device — the mention roster and
  picker, the quick switcher, the group add-member picker — runs its list
  through `app/twinDevices.ts` first, and of two registrations that look like
  the same person on the same machine the one that beaconed most recently
  wins. That is always the survivor (the ghost's beacon is frozen at the
  moment it died), so "@Gil" cannot be bound to a device nobody is on. The
  sidebar still shows both rows for those seconds, and then one of them goes.

Two smaller consequences of keeping the "(previous device)" row reachable: the
quick switcher lists it on the same terms the sidebar does (it used to filter
`departed` and so was the one way *not* to reach a conversation the sidebar
deliberately keeps), and it is no longer a beam target — dropping a file on it
says so rather than offering it to a machine that can never answer
(`useBeamTarget(…, canReceive)`).

Nothing is judged before the first beacon listing, supersession included
(`Poller.departed`). A successor record looks like evidence on its own, but the
rule that reads it is only sound because a live predecessor can veto it, and
that veto is a beacon — so answering early would label a perfectly live second
instance somebody's "(previous device)" on the very first `presence:list` the
renderer asks for in `loadTeam`. The cost of waiting is one poll (1 s focused)
on the client that just re-joined.

Tests: `transport/supersede.test.ts` (the rule, and the stricter TOFU variant),
`transport/rejoin.test.ts` (three in-process clients — the reset device, its
replacement and Bob watching; it fails on the pre-fix code at the "on the
re-joined client itself" assertion, and covers the trust pin, the flag an older
client left behind, the namesake from another machine, the pre-first-listing
silence, and the hard-kill window opening and closing),
`app/peopleRows.test.ts` and `app/groupMembers.test.ts` (the sidebar/rail/
dialog helpers), `app/twinDevices.test.ts` (the freshest-beacon tie-break).
E2E: a third instance joins as "Alice" on the same machine after Alice's is
killed, and both the other clients and the re-joined one are checked, sidebar
rows and the impersonation chip included.
