# Chat 1.1 — splash, team calendar, pull-request group

Design contract for three features. Implementation agents code against the
names here **exactly**; if something here is impossible, change the code, not
the name, and say so in the report.

Read `CLAUDE.md` first. Iron rules that matter here: zero deps, `node:crypto`
only, one writer per file (temp-write + rename), polling only, sign-then-
encrypt with AAD bound to `scope|relPath|objectId`, renderer is sandboxed web
code behind the typed bridge (`src/shared/bridge.ts` → `src/preload/index.ts`
→ `src/main/ipc.ts` / `services/*Ipc.ts`).

---

## 0. Shared plumbing: "team" conversations

Both the calendar and the PR-group config are **event logs on the share**,
reusing the whole channel machinery (EventStore, signing, envelopes, beacon
heads, poller sweep, renderer `events[conv]`). They live under a new
top-level dir so the janitor's 180-day day-dir sweep (channels/, dm/ only)
never touches them — a birthday entered two years ago must survive.

### 0.1 Ids and types (`src/shared/types.ts`, `src/shared/ids.ts`, `src/shared/constants.ts`)

```ts
// types.ts
export type ConvId = `chan:${string}` | `dm:${string}` | `team:${string}`
export type EventType = 'msg' | 'edt' | 'del' | 'rct' | 'pin' | 'sys' | 'prv' | 'cal' | 'prs'

// constants.ts
export const TEAM_CONV = { calendar: 'team:calendar', prs: 'team:prs' } as const satisfies Record<string, ConvId>
export const DIR = { ..., team: 'team', ... }          // <share>/Chat/team/<token>/events/YYYY-MM-DD/
export const POLL = { ..., prsMs: 60_000, prsBackoffMaxMs: 10 * 60_000 }
export const CALENDAR = { hues: 8 }                      // colour = index into --hue-0..7

// ids.ts
const EVENT_RE = /^(\d{13})-(\d{4})-([0-9a-f]{8})\.(msg|edt|del|rct|pin|sys|prv|cal|prs)\.e1$/
export function isTeamConv(conv: string): conv is `team:${string}` { return conv.startsWith('team:') }
export function isChanConv(conv: string): conv is `chan:${string}` { return conv.startsWith('chan:') }
export function isDmConv(conv: string): conv is `dm:${string}` { return conv.startsWith('dm:') }
```

Replace every hand-rolled `startsWith('chan:')` / `startsWith('dm:')` /
`slice(5)` in `session.ts`, `beacon.ts`, `poller.ts`, `chatService.ts`,
`AppShell.tsx`, `ChatPane.tsx`, `MessageList.tsx` with these helpers so a
third kind cannot fall into the wrong branch by accident.

### 0.2 Session (`src/main/transport/session.ts`)

`convInfo(conv)` gets a third branch **before** the DM fallback:

```ts
if (isTeamConv(conv)) {
  const id = conv                                   // 'team:calendar' — the whole ConvId is the key id
  const token = convToken(this.keys.kMeta, id)      // opaque, rotation-stable dir name
  return {
    key: deriveConvKey(this.tmk, this.teamSalt, this.proto.epoch, id),
    eventsDir: `${DIR.team}/${token}/events`,
    kid: KID.conv(this.proto.epoch, token),
    scope: 'team',
  }
}
```

Cache the derived `{key, token}` per id in a `Map` (scrypt is not involved,
HKDF is cheap, but `convInfo` is hot). `bootstrap.ts ensureLayout` creates
`DIR.team`. There is no `channel.json.e1`-style metadata file for team convs;
their existence is implied.

### 0.3 Beacon / poller / catch-up

- `beacon.ts noteOwnEvent` / `primeCursor`: team convs behave like channels
  (plain `heads` / `cursors` sections). Use `isDmConv` for the DM branch.
- `poller.ts processObservation` heads gate: `if (!isChanConv(conv) && !isTeamConv(conv)) continue`; the `loadChannels()` refresh applies to chan only.
- `poller.ts` every-20-tick sweep and `chatService.start()` startup catch-up
  both add `for (const conv of Object.values(TEAM_CONV)) await this.events.catchUp(conv)`.
- `chatService.maybeNotify`: `if (isTeamConv(conv)) return` (calendar edits never toast; PR alerts are the PR service's job).
- `chatService.ownCursor`/setCursor on ingest: skip for team convs (no receipts).
- `janitor.ts`: nothing to change — verify with a comment + test that `DIR.team` is not in its sweep list.
- Store `loadTeam` prefetch list becomes `[...channels, ...presence.dmConv, ...Object.values(TEAM_CONV)]`.

### 0.4 Publishing from main (`ChatService`)

```ts
async publishTeam(conv: `team:${string}`, type: 'cal' | 'prs', payload: CalPayload | PrsPayload): Promise<VerifiedEvent>
```
= `events.publish(conv, type, payload)` + `beacon.noteOwnEvent(conv, `${ev.id}.${type}.e1`)`
(copy `mutate()`'s outbox/degraded handling — team writes go through the
same `publishWithOutbox` path so a mounted-later share still gets them).

---

## 1. Team calendar

### 1.1 Payload + materialization (`src/shared/types.ts`, `src/shared/calendar.ts`)

```ts
export interface CalendarEntry {
  id: string           // 16 hex, random, chosen by the creator; stable across edits
  title: string        // ≤ 120 chars
  tag: string          // ≤ 24 chars, e.g. 'Release', 'Freeze', 'Birthday', 'Holiday' — free text, shown as a chip
  color: number        // 0..7 → var(--hue-N)
  start: string        // 'YYYY-MM-DD' (calendar date, no timezone)
  end: string          // 'YYYY-MM-DD' inclusive; === start for single-day
  annual: boolean      // repeats every year on the same month/day (birthdays)
  notes: string        // '' when empty — never undefined (canonical JSON)
}
export type CalPayload =
  | { t: 'cal'; conv: ConvId; op: 'put'; entry: CalendarEntry }
  | { t: 'cal'; conv: ConvId; op: 'del'; id: string }
// add CalPayload to EventPayload
```

`src/shared/calendar.ts` (pure, unit-tested in `calendar.test.ts`):

```ts
export interface CalendarItem extends CalendarEntry { author: string /* deviceId */; updatedId: string /* event id */ }
export function materializeCalendar(events: VerifiedEvent[]): CalendarItem[]
//  - iterate in stem order (events are already sorted by id); skip !verified and p.t !== 'cal'
//  - 'put' overwrites by entry.id (LWW), 'del' tombstones; tombstone wins over an OLDER put only
//  - validate: dates match /^\d{4}-\d{2}-\d{2}$/, end >= start, color 0..7 — drop invalid entries
//  - return sorted by start, then title
export function occurrencesInRange(items: CalendarItem[], fromYmd: string, toYmd: string): Occurrence[]
//  Occurrence = { item: CalendarItem; date: string /* YYYY-MM-DD of this occurrence's start */; end: string }
//  annual entries expand to every year in range with year >= start year (Feb 29 → Feb 28 on non-leap years)
export function upcoming(items: CalendarItem[], todayYmd: string, limit: number): Occurrence[]
export function ymd(d: Date): string; export function addDays(ymd: string, n: number): string; export function daysBetween(a, b): number
export function newEntryId(): string  // 16 hex via crypto.getRandomValues (works in renderer AND node)
```

### 1.2 Bridge (`src/shared/bridge.ts` — additive namespace)

```ts
calendar: {
  /** Publish or overwrite an entry (LWW by id). Throws on validation failure.
   *  An unreachable share is not an error: the write is persisted to the outbox
   *  and resolves with { queued: true }, flushed when the folder comes back. */
  put(entry: CalendarEntry): Promise<{ queued: boolean }>
  remove(id: string): Promise<{ queued: boolean }>
}
```
Reading is via the existing `chat.events(TEAM_CONV.calendar)` + `event`
pushes → `useStore.events['team:calendar']` → `materializeCalendar`. No
`list()` RPC. Handlers in `src/main/ipc.ts`: `calendar:put`, `calendar:remove`
→ `chat().publishTeam(TEAM_CONV.calendar, 'cal', …)`. Main re-validates the
entry (renderer input is untrusted): lengths, date regexes, `color` integer 0–7,
`annual` boolean, strings only.

### 1.3 UI (`src/renderer/src/team/CalendarPane.tsx` + `CalendarDialog.tsx` + `calendar.css` if needed)

Layout (fills the centre column, no ChannelHeader, no right rail):

- Own 52px header: title "Team calendar", month label with ‹ › and "Today",
  view toggle **Month | Upcoming**, primary button "+ Add" (`Button` from
  `ui/atoms`). Everything gets `title` + `aria-label`.
- **Month grid**: 7 columns Mon–Sun (locale-agnostic, start Monday), 5–6
  rows; each cell shows the day number (today ringed with `var(--accent)`),
  and up to 3 chips (`color` hue background at 18% via `color-mix`, hue text,
  tag in caps 10px + title truncated); "+N more" opens the day popover listing
  all. Multi-day entries render a chip on every day they cover (simple —
  no spanning bars). Annual entries show a small "↻" glyph on the chip;
  birthdays (tag matches /birthday/i) get 🎂 before the title.
- **Upcoming list**: next 90 days grouped by date, each row = date column
  (weekday + day), colour bar, tag chip, title, "in N days"/"today", author
  name (resolve `author` deviceId via `presence`, fall back to 8-char id).
- Click a chip/row → edit dialog; click an empty cell → new entry prefilled
  with that date.
- **Dialog** (copy the SettingsModal scrim/dialog pattern; `role="dialog"`
  `aria-modal`; Esc closes): Title, Tag (text with datalist suggestions:
  Release, Feature freeze, Code freeze, Birthday, Holiday, Milestone), Colour
  (8 swatches `--hue-0..7`, `role="radiogroup"`), Start / End (`<input type="date">`
  in `sem-input`), "Repeats every year" `Toggle`, Notes (textarea). Buttons:
  Delete (danger, only when editing) · Cancel · Save. Validation inline;
  Save → `window.bridge.calendar.put(entry)`; errors → `toast(…, 'danger')`.
- Empty state: centred glyph + "No dates yet — add a release, a freeze or a
  birthday." + Add button.
- Store: no new slice — `useStore((s) => s.events[TEAM_CONV.calendar])`,
  `ensureEvents(TEAM_CONV.calendar)` on mount, `useMemo(materializeCalendar)`.
- Sidebar badge for the calendar row: none, but show a small hue dot when
  something occurs **today** (computed in Sidebar from the same events).

---

## 2. Pull-request group (Azure DevOps)

### 2.1 What is shared vs. local

| Data | Where | Why |
|---|---|---|
| Base URL, project, watched repos, optional **shared token** | `team:prs` log (encrypted under the team key, signed) | "available for the entire team" |
| Personal token | local secret `prs-token` (LMK-encrypted, `SecretStore`), stored as `{ token, origin }` | never leaves the machine, and is only ever sent to the origin it was entered for — a teammate publishing a different base URL gets no request |
| Seen PR keys | local secret `prs-seen` (`Record<string, true>`), pruned to tracked keys each poll | per-user |
| Filters (assigned to me, branch, repo, text) | renderer state, remembered in `localStorage`-free zustand slice only (reset on launch) | cheap |

**SSH keys cannot authenticate to the Azure DevOps REST API** — only Git.
The prefs pane says so and links to `{baseUrl}/_usersSettings/tokens`. A
shared token is readable by anyone holding the team passphrase: the pane
must say that in plain words and recommend a read-only PAT (scope
*Code → Read*) with a short expiry. Personal token, when set, wins over the
shared one.

The token still stops at the bridge. Nothing in the renderer reads it (the UI
goes by `PrsStatus.sharedTokenSet`), so both ways a raw event reaches sandboxed
web code — the `chat:events` reply and the live `event` push — run through
`redactEventForRenderer` / `redactPushForRenderer` (`src/main/ipc.ts`).
Main-side readers materializing the config must not, since they need the token
to poll.

### 2.2 Payload + materialization (`src/shared/types.ts`, `src/shared/prs.ts`)

```ts
export interface PrsRepo { id: string; name: string }
export interface PrsConfig {
  baseUrl: string          // 'https://dev.azure.com/org' | 'https://tfs.corp/tfs/DefaultCollection' — no trailing slash
  project: string          // project name (or id)
  repos: PrsRepo[]         // watched repositories; empty = nothing tracked
  sharedToken: string      // '' when the configurer chose not to share
}
export type PrsPayload = { t: 'prs'; conv: ConvId; config: PrsConfig }   // full snapshot, LWW by stem
// add PrsPayload to EventPayload

// prs.ts (pure, unit-tested)
export function materializePrsConfig(events: VerifiedEvent[]): { config: PrsConfig; by: string; id: string } | null
export function normalizeBaseUrl(input: string): string | null   // trims, strips trailing '/', requires http(s), rejects credentials in URL
export interface PrView {
  key: string              // `${repoId}:${pullRequestId}`
  id: number
  title: string
  repoId: string; repoName: string
  author: { id: string; name: string }
  sourceBranch: string; targetBranch: string     // 'refs/heads/' stripped
  createdAt: number        // ms epoch
  isDraft: boolean
  reviewers: { id: string; name: string; vote: number; required: boolean }[]
  assignedToMe: boolean    // I appear in reviewers
  myVote: number           // 0 when not a reviewer
  webUrl: string           // `${baseUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repoName)}/pullrequest/${id}`
  seen: boolean
}
export function isApproved(reviewers: PrView['reviewers']): boolean
//  true when: at least one vote ≥ 5, no vote < 0, and every required reviewer has vote ≥ 5
export function isTracked(pr: { isDraft: boolean; status: string; reviewers: … }): boolean
//  status === 'active' && !isDraft && !isApproved(reviewers)
export function toPrView(raw: AdoPullRequest, ctx: { baseUrl; project; meId: string | null; seen: Set<string> }): PrView
```

### 2.3 ADO client (`src/main/services/ado.ts` — pure, injectable fetch)

```ts
export type AdoErrorCode = 'unauthorized' | 'forbidden' | 'not-found' | 'proxy-auth' | 'tls' | 'dns' | 'network' | 'timeout' | 'http' | 'bad-url'
export interface AdoError { code: AdoErrorCode; detail: string }   // detail never contains the token
export type AdoResult<T> = { ok: true; value: T } | { ok: false; error: AdoError }
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; headers: { get(n: string): string | null }; text(): Promise<string> }>

export class AdoClient {
  constructor(private fetchImpl: FetchLike, private opts: { baseUrl: string; token: string; userAgent: string; timeoutMs?: number })
  me(): Promise<AdoResult<{ id: string; name: string }>>                       // GET {base}/_apis/connectionData?api-version=6.0-preview → authenticatedUser.{id,providerDisplayName}
  projects(): Promise<AdoResult<{ id: string; name: string }[]>>               // GET {base}/_apis/projects?api-version=6.0&$top=500 (follow x-ms-continuationtoken)
  repos(project: string): Promise<AdoResult<{ id: string; name: string; defaultBranch: string }[]>>   // GET {base}/{project}/_apis/git/repositories?api-version=6.0
  activePullRequests(project: string, repoId: string): Promise<AdoResult<AdoPullRequest[]>>            // GET {base}/{project}/_apis/git/repositories/{repoId}/pullrequests?searchCriteria.status=active&$top=200&api-version=6.0
}
```
Rules: `Authorization: Basic base64(':' + token)`, `Accept: application/json`,
`User-Agent: Chat/<version>`. **`api-version` is negotiated** (1.1.2): 6.0 is
the opening bid; an older on-prem server answers 400
`VssVersionOutOfRangeException` naming the newest version it supports (TFS
2018 → 4.1, 2017 → 3.2) and the client retries there, then reuses that
version for the life of the process, keyed by origin. A refusal that names
nothing walks the ladder `6.0 → 5.0 → 4.1 → 3.2 → 3.0 → 2.0 → 1.0`; a version
already refused is never re-offered, and exhausting the ladder is its own
error code `api-version`. **A 203 status, a non-JSON body, or an unfollowed
redirect to `_signin` means the PAT was rejected (ADO answers with an HTML
sign-in page)** → `unauthorized`; so does a 200 `connectionData` whose
`authenticatedUser` is the anonymous guid or a `System:PublicAccess`
descriptor (an org with public projects answers a bad PAT this way). Map
401→unauthorized, 403→forbidden, 404→not-found, 407→proxy-auth; Chromium
error strings `ERR_CERT_*`→tls, `ERR_NAME_NOT_RESOLVED`→dns, abort→timeout,
other `ERR_*`/TypeError→network, other statuses→http, quoting ADO's own
`message` field rather than the raw body. Never log or echo the token; redact
it from any error detail. Unit tests use a fake `FetchLike`.

Main binds `net.fetch` (Electron, proxy-aware — never `node:https`/global
fetch) with `{ credentials: 'omit', bypassCustomProtocolHandlers: true, signal: AbortSignal.timeout(15_000) }`.

### 2.4 PR service (`src/main/services/prService.ts`)

```ts
export class PrService {
  constructor(chat: ChatService, store: SecretStore, getWindow: () => BrowserWindow | null, push: (m: PushMessage) => void, getVersion: () => string)
  start(): void   // subscribe to chat.events.onEvent for TEAM_CONV.prs (re-materialize config on change), schedule first poll in 3 s, then POLL.prsMs self-rescheduling setTimeout with re-entrancy guard; exponential backoff to POLL.prsBackoffMaxMs on error
  stop(): void
  status(): PrsStatus
  list(): PrView[]
  refresh(): Promise<void>          // immediate poll (used by the pane's ↻ button)
  markSeen(keys: string[]): void    // persist 'prs-seen', recompute unseen, push
  setPersonalToken(token: string | null): void
  testConnection(input: { baseUrl: string; token: string }): Promise<PrsProbe>
  listRepos(input: { baseUrl: string; token: string; project: string }): Promise<AdoResult<{ id; name; defaultBranch }[]>>
  saveConfig(input: { baseUrl: string; project: string; repos: PrsRepo[]; token: string; shareToken: boolean }): Promise<void>
  //   → publishTeam(TEAM_CONV.prs, 'prs', { t:'prs', conv, config: { baseUrl, project, repos, sharedToken: shareToken ? token : '' } })
  //   → always stores `token` locally as the personal token when !shareToken (so the configurer works either way)
}
export interface PrsStatus {
  configured: boolean; baseUrl: string; project: string; repos: PrsRepo[]
  tokenSource: 'personal' | 'shared' | 'none'
  me: { id: string; name: string } | null
  lastPollAt: number | null; polling: boolean
  error: AdoError | null
  unseen: number
}
export type PrsProbe = { ok: true; me: { id: string; name: string }; projects: { id: string; name: string }[] } | { ok: false; error: AdoError }
```

Poll: for each watched repo `activePullRequests` → `toPrView` → filter
`isTracked`. Diff against the previous poll's key set: keys that are new
**and not in `prs-seen`** are "new" →
- always `push({ kind: 'prs', prs, status })`;
- if the window is not focused and `Notification.isSupported()`: one OS
  notification — 1 PR: title `Pull request #<id> · <repo>`, body `<title> — <author>`; N>1: `N new pull requests need review`, body = first 3 titles. Click → show/focus window and push `{ kind: 'prs-open' }` so the renderer navigates to `team:prs`.
- Skip OS notification for PRs authored by me. Skip the very first poll after
  a *fresh config publish by me* (the configurer just saw the list).
Prune `prs-seen` to current keys. A PR that becomes approved / completed /
abandoned / draft disappears from the list on the next poll (that is the
"no longer tracked" rule). `unseen = prs.filter(p => !p.seen).length`.

Lifecycle: constructed in `AppController.startSession()` after `chat.start()`,
stopped in `changeTeamFolder()` and `shutdown()`. Add `'prs-seen'` to the
team-scoped secret delete list in `changeTeamFolder`; **do not** add
`prs-token` (it is the user's, not the team's).

### 2.5 Bridge (`src/shared/bridge.ts`)

```ts
prs: {
  status(): Promise<PrsStatus>
  list(): Promise<PrView[]>
  refresh(): Promise<void>
  markSeen(keys: string[]): Promise<void>
  testConnection(input: { baseUrl: string; token: string }): Promise<PrsProbe>
  listRepos(input: { baseUrl: string; token: string; project: string }): Promise<AdoResult<{ id: string; name: string; defaultBranch: string }[]>>
  saveConfig(input: { baseUrl: string; project: string; repos: PrsRepo[]; token: string; shareToken: boolean }): Promise<void>
  setPersonalToken(token: string | null): Promise<void>
  disconnect(): Promise<void>       // publishes an empty config (baseUrl '') and clears prs-seen; keeps the personal token
}
// PushMessage additions:
| { kind: 'prs'; prs: PrView[]; status: PrsStatus }
| { kind: 'prs-open' }              // OS-notification click → renderer opens team:prs
```
Handlers in `src/main/services/prsIpc.ts` (`registerPrsIpc(controller, getWindow)`
called from `registerIpc`), reading `controller.prs` and throwing
`new Error('not-ready')` when absent. Renderer-supplied URLs go through
`normalizeBaseUrl`; tokens are trimmed; repos are validated as `{id,name}` strings.

### 2.6 Store (`src/renderer/src/store/index.ts`)

```ts
prs: PrView[]; prsStatus: PrsStatus | null
// push 'prs' → set both; push 'prs-open' → setActiveConv(TEAM_CONV.prs)
// loadTeam(): also Promise.all prs.status() + prs.list(); reset both on boot→onboarding
```
`newlyArrived` for the in-app alert is computed in the renderer component
(compare previous `prs` keys with next, unseen only) — not stored.

### 2.7 UI (`src/renderer/src/team/PrsPane.tsx`, `PrsPrefs.tsx`, `PrAlert.tsx`)

**Sidebar row** "Pull requests" (`IconGitPull`): badge = `prsStatus.unseen`,
rendered with `UnreadBadge` but **red** (`var(--danger)` background,
`--on-accent` text — the user asked for red). When `!configured`, the row shows
a subtle "Set up" chip instead of a badge; when `configured` but
`tokenSource === 'none'` it shows the same chip reading "Add token" (that
machine polls nothing, so `unseen` would sit at 0 forever and the row would be
indistinguishable from a quiet, working group). Right-click / gear-on-hover
opens the prefs (also reachable from the pane header).

**Pane** (centre column, own 52px header):
- Header: "Pull requests" + `repo · project` subtitle, count, ↻ refresh
  (spins while `polling`), gear → prefs, and the filter bar:
  `[All | Assigned to me | Mine]` segmented, **Target branch** select (distinct
  `targetBranch` values, "Any branch"), **Repo** select when >1 repo, text
  search (title / author / branch).
- **Whose "me"**: on `tokenSource === 'shared'` the polled identity is the
  configurer's account, not the reader's, so every me-relative label is
  answering for somebody else. The header then carries an "as `<name>`" chip
  (tooltip: signed-in name + what it means), the segments read
  `[All | Assigned to <name> | By <name>]`, and the row chip reads
  "awaiting `<name>`". Main matches it: `notify()` only suppresses "my own PR"
  when the identity really is this viewer's (`tokenSource === 'personal'`) —
  suppressing on a shared token would invert the toasts.
- Rows (`sem-row`-style cards, 56px): unseen dot (`--danger`) + `#id`, title
  (600 weight when unseen), meta line `repo · author · source → target · created N ago`,
  reviewer avatars (Avatar initials) with vote colour ring (≥5 green, <0 red,
  0 grey, required = solid ring) and an "awaiting you" chip when
  `assignedToMe && myVote === 0`. Click → `window.bridge.app.openExternal(webUrl)`.
  Hover actions: Copy link, Open.
- States: not configured → set-up card explaining the feature with a
  "Connect Azure DevOps" button (anyone can; the config is shared);
  configured but `tokenSource === 'none'` → "Enter your Azure DevOps token"
  inline form (personal token); `error` → `HealthBanner`-style strip with
  the mapped sentence (`unauthorized` → "Azure DevOps rejected the token —
  it may have expired", `proxy-auth` → "The proxy wants credentials", `tls` →
  "The server's certificate isn't trusted by this machine", …) and a Retry;
  empty (configured, no PRs) → "Nothing waiting for review 🎉".
- **Seen marking**: an effect like `MessageList`'s — when the pane is
  mounted **and** `document.hasFocus()`, after 1.5 s dwell, call
  `prs.markSeen(visibleKeys)` (all currently listed after filters); re-run on
  window `focus` and when the list changes.
- **PrAlert** (mounted once in AppShell like `BeamSurface`, z-index lane 850,
  fixed top-right): when a `prs` push brings unseen PRs that were not in the
  previous list and `activeConv !== TEAM_CONV.prs`, show a red-accented card
  ("New pull request" / "N new pull requests", up to 3 titles, `Review` →
  `setActiveConv(TEAM_CONV.prs)`, `Dismiss`), auto-dismiss after 12 s. This is
  the "red popup"; OS notifications cover the unfocused case (main side).
- **Prefs modal** (`PrsPrefs.tsx`, SettingsModal scrim/dialog pattern, 640px):
  1. *Connect*: Base URL (`sem-input`, placeholder `https://dev.azure.com/your-org`),
     Token (password input, "Create one at {base}/_usersSettings/tokens · scope Code → Read"),
     note "SSH keys only work for Git; the REST API needs a token.",
     **Test connection** → `prs.testConnection` → shows "Signed in as <name>" + project picker (select) or the error sentence.
  2. *Repositories*: after a project is chosen, `prs.listRepos` → checkbox list with search; "Select all / none".
  3. *Sharing*: Toggle "Share this token with the team" (off by default) with
     the plain-words warning; when off: "Teammates will enter their own token."
  4. Footer: Disconnect (danger, when configured) · Cancel · **Save** (disabled
     until a test succeeded and ≥1 repo is checked) → `prs.saveConfig`.
  Prefill from `prsStatus` when already configured (token field empty; saving
  with an empty token keeps the existing token source).

Icons to add in `src/renderer/src/app/icons.tsx` (24-grid, stroke 1.7):
`IconCalendar`, `IconGitPull`, `IconGitBranch`, `IconRefresh`, `IconFilter`,
`IconChevronLeft`, `IconChevronRight`, `IconExternal`.

---

## 3. Shell routing (`AppShell.tsx`, `Sidebar.tsx`, `QuickSwitcher.tsx`)

- `activeConv` stays `ConvId | null` (now includes `team:`); `setActiveConv(TEAM_CONV.calendar)` compiles.
- `AppShell`: `convKind = none | dm | chan | team`; for `team` → `railOpen=false`, render
  `activeConv === TEAM_CONV.calendar ? <CalendarPane/> : <PrsPane/>` instead of
  ChannelHeader/HealthBanner/ChatPane/EmptyConvOverlay (keep `<HealthBanner/>` above the pane).
- `Sidebar`: new section **Team** as the first block inside the scroll body
  (SectionLabel "Team", no + button) with two `SpecialRow`s (copy `ChannelRow`:
  height 30, 14px glyph slot, active rail, `UnreadBadge`): "Calendar" and
  "Pull requests". Export `UnreadBadge` (add `tone?: 'accent' | 'danger'`).
- `QuickSwitcher`: items `kind: 'team'` for "Calendar" and "Pull requests" (score like channels).
- `loadTeam` first-launch auto-select stays `channels[0]`.

---

## 4. Splash screen (`src/main/index.ts`, `resources/splash.html`)

- `resources/splash.html`: self-contained (inline CSS, no script), dark
  `#0E0F13` background, `<img src="icon.png">` (the existing
  `resources/icon.png`; since 1.6 the PNG carries its own squircle silhouette,
  so the box is 140px with no `border-radius`, and the depth is a `drop-shadow`
  chain that follows the artwork's alpha — hairline rim, cast shadow, glow),
  wordmark "Chat"
  (600 weight, 28px, `-apple-system, "Segoe UI", system-ui`), a subtle
  "Encrypted team chat" line, a 3-dot pulsing loader, and an empty
  `<div id="v"></div>` for the version. CSP meta:
  `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'`.
  Resolved at runtime with the existing pattern
  `app.isPackaged ? join(process.resourcesPath, 'splash.html') : join(process.cwd(), 'resources', 'splash.html')`
  (extract a `resourcePath(name)` helper next to `packDir()` and reuse it).
- Window: `new BrowserWindow({ width: 420, height: 300, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, show: false, center: true, backgroundColor: '#0E0F13', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })`
  — no preload, no `titleBarStyle`. Created in `whenReady` **before**
  `await controller.init()`; `loadFile`; on `ready-to-show` → `show()`; after
  `did-finish-load` → `webContents.executeJavaScript` to set `#v` to `v${app.getVersion()}`
  (wrapped in try/catch — cosmetic).
- Hand-off: in the main window's `ready-to-show`, `show()` main, then destroy
  the splash after `max(0, 1200ms − timeSinceSplashShown)` so it never
  flickers. Also destroy it in `before-quit`, in `second-instance` (focus
  whichever exists), and never assign it to `mainWindow`.
- `app.on('activate')` uses `if (!mainWindow) createWindow()` instead of the
  window count.
- `scripts/e2e-drive.mjs`: `connect()` picks
  `t.type === 'page' && !t.url.startsWith('devtools') && !t.url.includes('splash.html')`
  and verifies `typeof window.bridge === 'object'` (retry otherwise); add
  `ws.on('close')` rejection to `Cdp` pending sends; add a check
  "alice shows the splash window" by polling `/json` every 100 ms for ≤ 8 s
  for a `splash.html` target right after spawn.

---

## 5. Tests & verification

- Unit: `src/shared/calendar.test.ts` (LWW, tombstones, invalid drop, annual
  expansion incl. Feb 29, range/upcoming), `src/shared/prs.test.ts`
  (`isApproved` truth table, `isTracked`, `toPrView` branch stripping /
  webUrl / assignedToMe, `materializePrsConfig` LWW + unverified skipped,
  `normalizeBaseUrl`), `src/main/services/ado.test.ts` (fake fetch: 200 JSON,
  203 HTML → unauthorized, 401/403/404/407, abort → timeout, ERR_CERT → tls,
  continuation token paging, token never in error detail).
- Integration (`src/main/transport/integration.test.ts`): "calendar entry
  round-trips A → B" — alice `events.publish(TEAM_CONV.calendar, 'cal', put)`,
  bob `catchUp(TEAM_CONV.calendar)`, `materializeCalendar` shows it verified;
  a later `del` from bob hides it on alice after catch-up; the log lives under
  `team/` on disk (assert the dir exists and `channels/` has no new token).
- E2E (`scripts/e2e-drive.mjs`): splash target seen; calendar entry A → B via
  `window.bridge.calendar.put` + `chat.events(TEAM_CONV.calendar)` poll (≥ 25 s
  budget); PR group: start a fake ADO `node:http` server in the script
  (routes: `_apis/connectionData`, `_apis/projects`, `{project}/_apis/git/repositories`,
  `.../repositories/{id}/pullrequests` returning one active PR with an
  unapproved required reviewer and one approved PR), alice `prs.testConnection`
  → `listRepos` → `saveConfig({shareToken:true})`, then `until` bob's
  `prs.list()` has exactly the unapproved PR and `prs.status().tokenSource === 'shared'`;
  alice `prs.markSeen` → `status().unseen === 0`. Screenshots of both panes
  (`setActiveConv` is renderer state — drive via `window.__store` if exposed,
  otherwise skip pane screenshots and keep bridge-level checks).
- Gates: `npm run typecheck`, `npm test`, `npm run build`,
  `env -u ELECTRON_RUN_AS_NODE node scripts/e2e-drive.mjs`,
  `node scripts/check-no-natives.mjs`.
