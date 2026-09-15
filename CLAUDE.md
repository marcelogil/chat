# Chat — agent notes

Electron 44 + React 19 + TS(strict) + Tailwind 4 + zustand. The app's entire
backend is an encrypted shared folder (SMB) — there is no server. Read
`README.md` first; the full reconciled design lives in the approved plan
(`~/.claude/plans/i-want-you-to-compressed-dongarra.md`).

## Iron rules

- **Zero native modules, zero npm crypto deps.** All crypto is `node:crypto`
  (main) / WebCrypto (renderer hot paths). `scripts/check-no-natives.mjs`
  gates every release; `.npmrc` has `ignore-scripts=true`.
- **One writer per file on the share, ever.** Publish = temp-write + rename.
  Never `fs.watch` the share; polling only. Deletes are idempotent.
- **Envelope discipline:** SFC1 records / SFB1 streams with AAD binding to
  `scope|relPath|objectId` — changing a file's path or name breaks decryption
  *by design*. Sign-then-encrypt everywhere (`signRecord`/`verifyRecord`).
- Packaging: `zip` targets only (never `portable` — %TEMP% self-extraction
  reads as malware). macOS keeps explicit ad-hoc `identity: '-'`.
- **Release signing:** `RELEASE_PUBKEY_B64URL` in `services/updates.ts` is baked
  (since 1.1.0) and must never change without a hand-delivered build — clients
  reject manifests signed by anything else. The private half lives only at
  `~/.semaphore-release-key.json`; never commit it, never print it.
- **No macOS Keychain, ever** (`src/main/store/osKeystore.ts`). Keychain
  ACLs bind to the ad-hoc cdhash, so every build re-prompts "Semaphore wants
  to use your confidential information…" and a Deny bricks the profile. On
  macOS the LMK is wrapped under the team passphrase (unlock screen each
  launch); Windows uses DPAPI via `safeStorage` silently.
- Renderer is sandboxed web code; everything crosses the typed bridge in
  `src/shared/bridge.ts` (implemented in `src/preload/index.ts`, handled in
  `src/main/ipc.ts` + `services/*Ipc.ts`).

## Commands

- `npm run typecheck` · `npm test` (unit + two-client protocol integration)
- `npm run dev:a` / `dev:b` — two instances, separate userData profiles
- `node scripts/e2e-drive.mjs` — drives two REAL instances over CDP
  (onboarding → chat → DMs → blobs → beams), needs `npm run build` first
- `npm run dist` — both platform zips; `npm run release` — full gated release

## Machine quirks (this Mac)

- Node 22.11: prefix `NODE_OPTIONS=--experimental-require-module` for vitest
  and `node_modules/electron/install.js` (npm test already does).
- The Claude Code harness exports `ELECTRON_RUN_AS_NODE` — always clear it
  (`env -u ELECTRON_RUN_AS_NODE`) when launching Electron or the packaged app.
- Every macOS launch (dev, E2E, packaged) goes through the passphrase unlock
  screen by design — see the Keychain rule above. Drive it over the bridge
  with `window.bridge.app.unlock(pass)` in scripts.
- BSD `grep` silently matches nothing (empty output, rc 1) on files with
  multibyte characters (`·`, `…`, `→`) under the default locale — use
  `LC_ALL=C grep -an …`.

## Profiles and test runs

**The default profile is a real person's device identity.** On this Mac that is
`~/Library/Application Support/Chat` — `lmk.sealed` plus every `*.enc` secret
under it (identity, roster pins, DM keys, team cache). Nothing on the share can
rebuild it: destroy it and that device is gone, along with every DM ever sent
to it.

- **Any packaged run that is not the user's own MUST set
  `CHAT_USER_DATA_DIR=/abs/scratch/dir`.** It is honoured in *every* build
  (`resolveUserDataDir` in `src/main/userData.ts`, applied in `index.ts` before
  anything reads `userData`), must be absolute, and may not be the default dir
  itself; the app prints one line when it is active, and **refuses to start**
  if it is set but unusable — falling back to the real profile in silence is
  the accident this exists to prevent. `SEMAPHORE_PROFILE` is unchanged and
  still **dev-only** (`npm run dev:a`/`dev:b`); a packaged build ignores it,
  which is exactly how this went wrong.
- **`onboarding.submit` refuses over a locked profile.** `onboardSubmit`
  answers `{ ok: false, error: 'locked-profile', message }` when
  `store.hasSealedData() && !store.unlocked` — before it touches the share —
  and the renderer sends the person to the unlock screen with that sentence
  (`store.showUnlockScreen`, `unlockNotice`, `UnlockScreen`'s `notice`).
  `LocalStore.createPassphraseLmk` throws over any existing seal as the floor
  under every caller.
- **`app.resetLocalData()` is the only key-destroying path** — user-confirmed,
  reachable only from the unlock screen, and it `wipe()`s the seal before any
  new LMK exists. Nothing else may discard a sealed LMK.
- **What happened (2026-09-14):** a packaged verification script called
  `bridge.onboarding.submit({ sharePath: <temp>, passphrase: 'correct horse
  battery staple', … })` against the default profile while it sat on the unlock
  screen. `SEMAPHORE_PROFILE` did nothing in a packaged build, so it was the
  real profile; `onboardSubmit` saw `!unlocked` and called
  `createPassphraseLmk`, sealing a *new* LMK over the existing one. The old
  `identity.enc`/`pins.enc`/caches became unreadable, a fresh identity was
  generated, and the device was destroyed. Tests:
  `src/main/appController.test.ts`, `src/main/userData.test.ts`, the
  "a sealed profile is not overwritable" block in `store/localStore.test.ts`.

## Known deferred items (v2 candidates)

In-app passphrase rotation (new epoch + LMK re-wrap; until
then a departing member means a new team folder) · message-content search ·
screen-share audio · blob dedup ·
DM forward-secrecy prekeys · day-bundle compaction for multi-month cold starts
· beam transfers over RTCDataChannel (currently folder-only) · online GIF
search (needs a Giphy/Tenor key; the bundled pack is the offline path) · a
member who *leaves* a group keeps a working current key (only a removal by the
owner rotates — see `GroupService.leave`) · P2P fast path for live boards
(RTCDataChannel instead of the folder relay that ships in 1.3 — the folder
gives ~1–2 s latency, which is fine for a whiteboard today) · per-person,
not per-device, poll votes (1.3 counts one vote per device — a roster record
*is* a device, and nothing on the share binds two devices to one human; a
"one vote per person" poll needs an identity layer Chat deliberately doesn't
have) · an in-app card for author-side PR transitions (1.4's
`PrService.trackTransitions`/`notifyTransitions` only ever raise an OS
notification for "your PR was blocked / commented on / approved" — there is
no in-app equivalent of `PrAlert` for these, so a focused window sees
nothing until the pane itself is opened) · revoked pins are not consulted by
the team-rename fold (`services/teamSettings.ts` checks only `trust !==
'flagged'`; if a second trust axis is ever wired into an event fold, it
should be decided for event folds generally, not patched into this one).

## GIF pack

`node scripts/fetch-gif-pack.mjs` refreshes `resources/gifs-starter/` from
Google's Noto Animated Emoji (CC BY 4.0, committed so builds work offline).
Files over 1.2 MB are skipped — they render at ~160px. The renderer loads them
over the `sfgif://pack/<id>.gif` protocol (`src/main/services/gifProtocol.ts`);
a pack GIF is sent as its `packId`, so it costs zero shared-folder I/O.

## Team conversations (1.1)

`team:` is a third `ConvId` kind alongside `chan:`/`dm:` (guards in
`src/shared/ids.ts`: `isTeamConv`/`isChanConv`/`isDmConv` — use these, never
hand-rolled `startsWith`). Logs live under `<share>/Chat/team/<opaque
token>/events`, one dir per fixed conv (`TEAM_CONV.calendar`,
`TEAM_CONV.prs`); the token is derived (`convToken`), not the conv id, so
`team/` never reveals what's inside from the filename. The janitor never
sweeps `team/` by construction (`SWEEP_EVENT_ROOTS` in
`services/janitor.ts`) — team logs are LWW-materialized, not
compaction-pruned. Event types `cal` (calendar entries) and `prs` (PR
config) ride the same signed/encrypted envelope as chat events but skip
read-cursor bookkeeping. Full design: `docs/features-1.1.md`.

## Splash window (1.1)

`createSplash()` runs in `whenReady` *before* `await controller.init()` and
is never assigned to `mainWindow` — it's a separate `BrowserWindow` torn
down from the main window's `ready-to-show` (after a minimum linger) and
from `before-quit`/a failed `init()`. `scripts/e2e-drive.mjs`'s `connect()`
filters the splash target out by page shape (`typeof window.bridge ===
'object'`), not by title — the splash sets no bridge.

## PR service (1.1)

`prService.ts` talks to Azure DevOps only over Electron's `net.fetch`
(`src/main/services/ado.ts`) — no added deps. The PAT is never logged;
every `AdoError.detail` is redacted (raw token, its base64 form, and its
percent-encoding all scrubbed) before it can reach a toast or a report.
Two secrets keys: `prs-token` (per-device, personal PAT) and `prs-seen`
(team-scoped, pruned to the currently tracked PR keys — cleared along with
the rest of team-scoped secrets on `changeTeamFolder`).

## macOS screen-recording permission

Never check `getMediaAccessStatus('screen')` *before* attempting a capture:
macOS only lists an app under Privacy → Screen Recording once it has tried,
so checking-then-bailing sends people to a pane where Chat isn't listed.
`scripts/after-pack.mjs` strips electron-builder's boilerplate Camera /
Microphone / Audio / Bluetooth usage strings for the same reason — they made
the app show up under Microphone and nowhere else.

## Private groups (1.2)

`grp:` is a fourth `ConvId` kind (`isGrpConv()` in `src/shared/ids.ts`). A
group is just a random 32-byte key; it is never discoverable from the share.
The key is delivered as a `group-invite` notice **inside the owner↔member
DM log** (already E2E, already polled — zero new share I/O, no membership
leak in any filename), and the group's own log lives at an opaque
`groups/<token>/events/`, where `token = base32(HMAC(key1,
HKDF_INFO.grpDirToken))[0:20]` — computable only by someone who already holds
the epoch-1 key, which is why every invite/rekey above epoch 1 carries `key1`
too (see `docs/contract-changes-1.2.md` for why that's wider than the
original contract comment said). Removing a member always rotates the key to
a new epoch (`GroupService.removeMember` in `src/main/services/groups.ts`);
the removal event itself is published *under the new key*, so the removed
device can't read that it happened — which is why the owner also sends it a
`grp` `group-removed` notice over their DM (1.2 review fix), on which that
device drops the group locally. `grp` is a fourth event type carrying the
invite/rekey/removed notices that ride a DM log: they used to be `sys` events,
and a shipped 1.1 client renders an unknown sys kind as a *blank row* in that
DM (its `sysLine` has no default), while a `.grp.e1` filename it cannot parse
is skipped in silence. `noteOwnEvent` also keeps those filenames out of the DM
beacon section's `heads` and in their own `grpHeads` ring — not because an
unparseable name costs a 1.1 reader anything by itself (`ingestHeads` skips a
name it can't parse before the gap check, so it never reads as a missing head),
but because `heads` holds only `BEACON.headsRingSize` names per conversation,
and a burst of invites/rekeys would evict the real `msg` filenames a 1.1 reader
ingests from it, sending it to a full day-scan `catchUp` instead of the cheap
beacon path. A second, unknown-to-1.1 field costs it nothing. Same argument one
version later for 1.3's `heads2` (below). A record from a retired epoch,
written by someone no longer in the fold, after the point that epoch was
retired, is refused (`GroupService.staleWriteCut`, called from
`transport/events.ts`'s decrypt path) — history from before the rotation
still opens for everyone, including the removed member's own old messages.
Records under an epoch a reader doesn't hold yet are parked
(`pendingByEpoch`), never quarantined, and replayed once the key arrives.
Roles: the **owner** renames, adds, removes and deletes; a **member** renames
and leaves. Membership is owner-managed end to end because a newcomer's client
only adopts an invite signed by the owner (nothing on the share proves who owns
a group), so both `addMembers` and the `group-members-added` fold refuse a
non-owner. `SWEEP_EVENT_ROOTS` (`services/janitor.ts`) includes `DIR.groups`, so a
deleted group's directory is removed after `RETENTION.deletedConvGraceDays`
exactly like a deleted channel. A team-passphrase holder with no invite sees
only an opaque `groups/<token>` directory and file counts inside it —
nothing about names, members, or content. Full design:
`docs/features-1.2.md` §2.

## Channel rename/delete (1.2)

Both ride the channel's own event log as `sys` events — `channel-renamed`
(`data: { name }`) and `channel-deleted` (`data: {}`) — folded LWW by event
id in `src/main/services/channels.ts` (`foldChannelSys`); `channel.json.e1`
is never rewritten (clients cache it once, forever). A rename after a
delete still folds but can never resurrect the channel: `channelViews()`
omits anything with `deletedAt` set regardless of its folded name. Exactly
one channel per team is fixed (`ChannelMeta.fixed`, set by the bootstrap
`general` channel; teams predating 1.2 fall back to the oldest channel,
ties broken by the lowest `channelId`) and can be neither renamed nor
deleted. The janitor removes a deleted channel's (or group's) directory only
after `RETENTION.deletedConvGraceDays` (3 days) have passed since its
tombstone — the delay is what lets an offline client come back, read the
tombstone, and hide the conversation for itself before the directory is
gone. `channel-renamed` happens to already render correctly on a shipped
1.1.2 client (that literal was already in its `SysPayload.kind` union and
`sysLine()`, just never published by anything in 1.1) — but 1.1.2 has no
fold logic for either kind, so the channel itself never actually renames or
disappears in a 1.1 sidebar.

## Diagrams (1.2)

`@excalidraw/excalidraw@0.18.1` (MIT; chosen over tldraw specifically
because tldraw's license requires a watermark). `scripts/sync-excalidraw-
assets.mjs` copies the dependency's font files into
`src/renderer/public/excalidraw-assets/` (gitignored, derived) so the editor
is fully self-hosted — Excalidraw falls back to an `esm.sh` CDN the CSP
blocks when its asset path is unset. Because `.npmrc` sets
`ignore-scripts=true`, npm's `pre*`/`post*` hooks never run, so this script
is chained **explicitly** into `dev`/`dev:a`/`dev:b`/`build` in
`package.json` (`npm run sync:assets` runs it standalone) — do not rely on a
`preinstall`/`predev` hook to do this, it won't fire.
`src/renderer/src/diagram/assets.ts` sets `window.EXCALIDRAW_ASSET_PATH` to
an absolute URL resolved against `location.href` (not `location.origin`,
which is the literal string `"file://"` in a packaged build) and monkey-
patches the global `FontFace` constructor to strip Excalidraw's hardcoded
`esm.sh` fallback out of every font's `src` list — the library appends that
CDN URL after whatever the asset path yields no matter what, and without the
patch every font issues a second, CSP-blocked network request per glyph
(~230 console errors per editor open, measured). CSP additions in
`src/renderer/index.html`: `worker-src 'self' blob:` and `font-src 'self'
data:` — nothing else was loosened. Bundled `.excalidrawlib` shape libraries
under `src/renderer/src/diagram/libraries/` are verbatim copies from the
official `excalidraw/excalidraw-libraries` GitHub repo, MIT-licensed under
that repo's own `LICENSE`; see `ATTRIBUTION.md` there for the per-file
author/source table. A scene compresses to ≤ `DIAGRAM.maxInlineBytes`
(120 KB) rides inline in the message (180-day retention, same as any
message); larger scenes go to the blob store instead (7-day media
retention — the tile says so). A pre-1.2 client has no `'diagram'`
`MsgBody.kind`, so it just renders `MsgBody.text`, which is why every
diagram message's text is the fallback line
(`diagramFallbackText` in `src/shared/diagram.ts`).

## Renderer navigation guard (1.2)

`src/main/navGuard.ts`'s `lockNavigation()` is attached to both the main
window and the splash window's `WebContents` and blocks `will-navigate` off
the app's own document — an `http(s)` target goes to the OS browser via
`shell.openExternal`, anything else is just dropped. Closes a real hole, not
a hypothetical one: Excalidraw's SVG export wraps a linked shape in a bare
`<a href>` with no `target`, and the diagram tile inserts that markup into
the page, so a peer's diagram could otherwise navigate this window — bridge
still attached — to a URL of their choosing on one click. Paired with
`src/renderer/src/diagram/sanitize.ts`, which strips `link` from every
element on the render path before it ever reaches the DOM.

## Share I/O tiers (1.2)

Cadence lives in three places: `POLL`/`BEACON`/`IO_BUDGET` in
`src/shared/constants.ts` (the numbers), `src/main/services/ioTier.ts`
(`IoTierManager` — derives `focused`/`blurred`/`idle`/`paused` from window
focus/visibility, `powerMonitor.getSystemIdleTime()`, and lock/suspend; pure,
so it takes fake timers in tests without a real Electron `app`), and
`src/main/transport/beacon.ts` (`BeaconWriter.setTier` — heartbeat cadence,
`presence.idleSec`, and a single goodbye beacon before going silent while
paused). `IO_BUDGET` (`focusedOpsPerMin: 96`, `blurredOpsPerMin: 48`,
`idleOpsPerMin: 16`) is asserted by a fake-timer, multi-peer test in
`src/main/transport/poller.test.ts` ("share I/O budget" describe block) —
read `docs/contract-changes-1.2.md` before touching any of these three
numbers, since two of them were already raised once (12→16, 42→48) after
this same harness proved the originals sat *below* the arithmetic floor of
the cadences the contract itself specifies.

**`git stash` is forbidden in this tree while agents work in parallel.**
Several people's uncommitted edits can be live in the working copy at once
during a multi-stream release like this one; a stash silently rewinds files
another agent is mid-edit on, and unstashing later does not put everyone
back where they were. Commit or leave changes in place instead. Say it
plainly: this cost real work during 1.2.

## Screen share picker (1.2)

One path, every platform, every macOS version: `listSources()`
(`src/main/services/capture.ts`) always enumerates through
`desktopCapturer`; `orderSources` (pure, unit-tested) puts screens first,
primary display first among them, windows after, and the picker pre-selects
the primary screen. The macOS 15+ native system picker
(`useSystemPicker`/`usesSystemPicker()`) is gone — it defaulted to windows
and gave no in-app cue, and combined with the older custom picker starting
with nothing selected, both produced the same bug report: "screen share only
shares the Chat window." **This was never an Apple entitlement/notarization
issue** — no special right is needed for screen capture; it was Chat's own
defaults. The permission check still runs only *after* an attempted capture,
never before (see the screen-recording section above) — now also covering
the case where permission reads granted but every screen thumbnail is
suspiciously uniform (`allScreensLookBlank` in
`src/renderer/src/screenshare/manager.ts`), which reads the same as no grant
at all and shows the same explainer.

## Polls (1.3)

`MsgBody.kind += 'poll'` (`PollBody`); a vote is its own event type, `vot`
(`.vot.e1`), never folded into `sys`. Invariants an agent must keep:

- **One vote per device, not per person.** `MessageView.votes` is keyed by
  deviceId — a roster record *is* a device, and nothing on the share binds two
  devices to one human. LWW by event id, exactly like a reaction; `[]` retracts.
- **`vot` (and every event type introduced after 1.2) rides `heads2`, never
  `heads`.** `heads` holds a fixed ring (`BEACON.headsRingSize`, 16) of
  filenames a 1.2 reader actually ingests from; votes arrive in bursts (one
  poll, a dozen voters) and would evict real `msg` heads from that ring before
  an older reader next polls. `heads2` (and the sealed-section equivalent) is a
  field a 1.2 reader has never heard of, so it costs that reader nothing — not
  because the filename itself would be unparseable-and-therefore-costly
  (`ingestHeads` skips an unparseable name before the gap check either way and
  that alone costs nothing), but because losing a ring slot does. Same rule
  `grpHeads` has followed since 1.2 (see the corrected note above) — a future
  event type gets this by default via an explicit allow-list of the types a
  1.2 filename regex can parse (`HEADS_1_2_TYPES` in `beacon.ts`), not by
  someone remembering to add a case.
- **Closing is the author's own `edt`** carrying `poll.closedAt`, and `edt` is
  keyed by target *and* author in `merge.ts` — only the message's own author's
  edit is ever applied, so a stranger's later `edt` cannot shadow it and
  silently re-open a closed poll.
- **`closesAt` is share-calibrated ms.** The renderer only knows the author's
  wall clock; `ChatService.send` restates the chosen interval on the share
  clock (`calibrateClosesAt`) before publishing. Never trust a renderer-sent
  `closesAt` as-is.
- **A closed poll's result is final.** A vote (including a retraction) whose
  HLC lands more than a 5 s grace past the close (`closedAt`, or `closesAt` if
  earlier) is not counted, even if it verifies fine — see `VOTE_GRACE_MS` in
  `shared/merge.ts`.
- `validatePollDraft` rejects duplicate options (normalized: trimmed,
  whitespace-collapsed, case-insensitive) — main re-validates renderer input,
  never trusts it.
- `anonymous` hides voter names in the UI only; every vote is still a signed,
  fully readable event on the share — the dialog says so, don't build a mode
  that actually hides it cheaper by skipping the signature.

## Live boards (1.3)

A real-time diagram session carried by the shared folder, not the event log:
`boards/<sessionId>/<deviceId8>.<seq base36>`. Invariants an agent must keep:

- **One writer per file, ever, and the seq rides in the filename.** The writer
  deletes its own previous file right after the rename; nobody else ever
  writes or deletes another device's file.
- **A session id is `deviceId8` (8 hex) + 4 random bytes = 16 hex, and the
  first 8 characters bind it to its host's device** (`SESSION_ID_RE` in
  `boards.ts`). A `board-live` (or `board-ended`) whose id doesn't start with
  its *signer's* own device id is refused outright — nobody can claim a seat
  in someone else's session id space. The host is whoever **signed**
  `board-live`, never `data.host` (a field any member could write); only that
  device's `board-ended` counts.
- **Never advance a reader's per-device seq cursor on anything but a verified,
  self-consistent frame.** `collect`/`readFrame` in `boards.ts` walk a
  device's candidate files newest-seq-first and only `verdict: 'ok'` moves the
  cursor — `'gone'` (mid-poll delete) and `'pending'` (a group rekey not yet
  held) leave it alone for a retry, and `'refused'` is remembered per file so
  it costs one read, not one per poll, but still never moves the cursor. A
  junk file planted at a high seq must not mute the rest of that device's
  session.
- **`ShareIo.abs()` rejects `..`, `.`, empty segments, and any backslash in
  every path segment** — the floor under every bridge-supplied id that becomes
  part of a share path (a board session id, a screen-share session id).
  Validate the id's own shape at the IPC boundary too (`assertBoardSessionId`)
  — `abs()` is the last line of defense, not the only one.
- A frame's `kid` carries the *conversation's* kid (`KID.board(sessionId,
  convKid)`), because for a private group that names the epoch — a reader that
  hasn't been handed a rekey yet has to be able to tell "park and retry" from
  "this is junk," and only the kid says which.
- `start` refuses a `team:` conversation (no members to collaborate with, and
  the janitor never sweeps `team/`) and a second session this device is still
  live in (reading or writing) in the same conversation.
- Janitor: a session directory is dead when its **newest** frame's mtime is
  past `RETENTION.boardsDeadMinutes`, and hard-removed once its **oldest**
  frame's mtime is past `RETENTION.boardsHardHours` — read the oldest/newest
  frame, never the directory's own mtime, which every publish and delete
  bumps constantly while anyone is drawing.

## Fullscreen editor (1.3)

`app.setFullScreen`/`isFullScreen` — real OS fullscreen, not a CSS overlay —
toggled from the diagram editor's header by F11 (Windows/Linux) or ⌃⌘F
(macOS, which reserves F11 for Show Desktop); `isFullScreenToggleKey` in
`diagram/fullscreenKey.ts` is the pure chord check, tested without mounting
Excalidraw. The header collapses to a 36 px strip in fullscreen. Esc leaves
fullscreen first — a second Esc then closes the editor, the same two-step
already used for the close-confirm dialog swallowing the first Esc — except
inside `.excalidraw` while it's mid-text-edit or holding its own dialog open,
which still owns Esc for itself. Whether closing the editor takes the window
back out of fullscreen follows the editor's own *intent* ref (`weWentFs` in
`DiagramEditor.tsx`), never the store's `fullscreen` flag: the flag is a push
from main that lands a beat after the request (so closing mid-transition would
otherwise misjudge it), and it's equally true of a window the user had already
put fullscreen before ever opening a diagram — that one isn't the editor's to
undo either.

## PR waiting states (1.4)

`src/shared/prState.ts` (`computePrState`) decides who a pull request is
waiting on and since when. Invariants an agent must keep:

- **Pure, and no share I/O.** `computePrState` takes plain data and a
  passed-in `now` — no Electron, no store, no clock of its own — so it runs
  in a unit test with a fixed clock. The threads/iterations it reasons about
  are two more per-PR Azure DevOps reads (`src/main/services/ado.ts`),
  computed independently by every client from its own token; nothing about a
  PR's waiting state is ever written to the share.
- **Detail budget.** First sight of a PR and a changed
  `lastMergeSourceCommit` jump the queue but are capped at `2 × ceil(N/5)`
  PRs per poll; everything else round-robins at `ceil(N/5)` PRs per poll so
  the whole tracked set refreshes within `PRS.detailRefreshMs` (5 min) —
  never `2·N` serial requests in one poll (`PrService.refreshDetails`). A
  failed detail read is retried once per refresh window, not every poll, and
  never fails the poll itself; `unsupported` (server below REST 3.0) counts
  as answered.
- **`'prs-history'` is team-scoped.** Per-PR vote-observation times, pruned
  to the tracked keys every poll, cleared alongside `'prs-seen'` on
  `changeTeamFolder()` and `disconnect()`. `'prs-token'` (the personal PAT)
  is the only PR secret that survives either.
- **Thresholds carry forward.** `PrsConfig.reviewSlaHours`/`staleAfterDays`
  are team-shared, additive fields; a snapshot that omits them (an ordinary
  re-publish from a 1.3 client) keeps whatever is already in force rather
  than reverting to the `PRS` constants — see `materializePrsConfig`. The
  write path (`saveConfig`) refuses an out-of-range or non-integer value
  instead of clamping it; only the read path off the share clamps, and it
  clamps to the value already in force, not to the constant default.

## Notification controls (1.4)

- **Every toast/card decision goes through `shared/notifyDecision.ts`.**
  `shouldNotifyChat`/`shouldNotifyPr` are the only gates
  `ChatService.maybeNotify`, `PrService` and the renderer's `PrAlert` card
  use — never re-derive "should this interrupt" locally, or the OS toast and
  the in-app surface will disagree.
- **Quiet hours are enforced there, and only there.** `inQuietHours()`
  covers OS toasts for messages, live-board invites and pull requests, plus
  the in-app PR alert card, without a single call site changing — it was
  stored and rendered since earlier versions but silenced nothing before
  1.4. It fails toward *not* silencing (a bad time or an unknown zone reads
  as off), since the function can only ever suppress.
- **Beam offers are exempt, on purpose** (`drops.ts` raises its own
  `Notification` directly, outside this gate) — someone is waiting at the
  other end of a transfer, and a silent expiry is worse than a chime during
  quiet hours or a pause.

## Launch nudge (1.4)

- **Login item options must be identical on write and read.**
  `setLoginItemSettings`/`getLoginItemSettings` only agree when called with
  the same options; `app:setOpenAtLogin` and `app:launchInfo` both route
  through the one `loginItemOptions(platform)` in `src/main/loginItem.ts` —
  never add an `args`/`path` to one side without the other, or the toggle
  silently reads back off (exactly the bug this shape fixes: the item was
  registered with an argv flag nothing consumed, and read back with none).
- **`requires-approval` counts as on.** macOS 13+ can register the login
  item and still gate it behind System Settings → General → Login Items;
  `launchInfoFrom` reads that status as `openAtLogin: true` (there is
  nothing left to turn on), and both `LaunchNudge` and Settings show the
  approval hint instead of a "Turn on" button.

## Superseded devices (1.4)

A roster record is never deleted (its signature keeps everything that device
signed verifiable), so "Reset local data" + re-join leaves **two** records for
one person on one machine. `src/main/transport/supersede.ts` decides which is
the ghost — same normalized display name, same `sanitizeHostname`, machine
fingerprints equal or absent, later `firstSeen`, predecessor not beaconing —
and `Poller.presenceViews()` marks it `departed` with `PresenceView.supersededBy`.

- **Feed the rule the whole roster, `self` included.** It used to run over the
  list the views are built from, which filters `self` out — so on the client
  that just re-joined, the record doing the superseding was the one record
  excluded, and the person saw two of themselves for `PRESENCE.departedAfterMs`
  (three days). That was the bug report.
- **Never compare a beacon stamp with a `firstSeen`.** Beacon stamps are
  share-calibrated; `firstSeen` is the writer's own wall clock. `supersede.ts`
  takes a `live` boolean the poller answers in share time (`beaconLive`) —
  a fresh heartbeat that isn't a goodbye. That guard is the only thing keeping
  two same-named dev instances on one machine from hiding each other.
- Every surface that lists people filters `departed`; new ones must too. The
  sidebar goes further (`app/peopleRows.ts`): a superseded device is listed
  only when its DM holds history, labelled "(previous device)", because that
  history lives under a different pair key and can never move to the new
  device's DM. Name-resolution maps (ChatPane, PollTile, calendar, boards)
  must keep reading the *unfiltered* list — old messages still need a name.
- **Never judge before the first beacon listing.** `Poller.departed()` and the
  `supersededBy` it reports both sit behind `!this.polled`: the rule's one veto
  is a live predecessor's heartbeat, and until a listing is read every device
  looks dead. The renderer asks for `presence:list` in `loadTeam`, inside that
  window.
- **A re-join is not impersonation.** TOFU flags a new device that claims a
  pinned display name, which is what a re-join *is*, so the person's real
  device used to come back `trust: 'flagged'` — the loud red chip, everywhere,
  for good. `Roster.nameCollision` skips a pin that is the provably same
  machine (`provenSameMachine`: equal, **present** `machineIdHash`; a missing
  fingerprint keeps the warning), and `Roster.healFlags()` re-asks at the end
  of every `refresh()` so load order and pre-1.4 pins can't leave one standing.
  Only `flagged` is ever relaxed.
- **The group dialog keeps the ghost on purpose** — a membership is a list of
  device ids, the old one still holds a key, and the owner has to be able to
  remove it. It labels the row instead (`memberRowSuffix` →
  "Gil (previous device)", Remove button included). It is the only people-list
  that doesn't hide a superseded device; the members rail still does.
- **The ≤50 s window is load-bearing, not a bug.** A predecessor killed without
  a goodbye beacon stays "live" until its heartbeat passes
  `PRESENCE.onlineWithinMs`, and that can't be tightened — an idle live
  instance beacons only every `BEACON.idleHeartbeatMs` (45 s). Anything that
  turns a *name* into one device (mention roster + picker, quick switcher,
  group add-member picker) must therefore run through
  `app/twinDevices.ts::preferFreshestTwin` first: freshest beacon wins, and
  rows already carrying `supersededBy` pass through untouched.

## Admin panel (1.5)

Settings → **Admin** is the one panel not everybody has: the **team name**
(team-wide) and **Always look online** (personal, unenforced). There is no
server to grant a role and `protocol.json` is written once, so "admin" is a
**display name** — `TEAM_ADMIN_NAMES` in `src/shared/constants.ts` (today
`['gil']`), compared trimmed and case-insensitively by `isGil`
(`src/shared/gilMode.ts`). **That constant is the only place to change the
rule**; everything else reads it.

Three gates, and only the third is enforcement:

- `navFor()` in `SettingsModal.tsx` lists the section for an admin only (the
  body re-checks, so a stale `openSettings('admin')` can't reach it).
- `ChatService.renameTeam` throws `not-admin` before it looks at the name;
  the pane says "Only Gil can rename the team" (`teamRenameFailureNotice`).
- **The fold ignores it** — `foldTeamRenamed`/`foldTeamName`
  (`services/teamSettings.ts`) take an `AuthorLookup` and accept a
  `team-renamed` event only when the author's *roster record* says an admin
  name **and** the author's pin is not `'flagged'`. The first two gates are
  code on the writer's own machine and a shared folder cannot refuse a write;
  what stops a rename is that nobody folds it, the writer included.

The `flagged` half is the point: a second device registering under a name
already pinned to someone else is what `Roster.ingest` TOFU-flags, and it is
exactly what "type Gil in the onboarding box" looks like. A `revoked` pin is
deliberately not part of the test — no other event path consults revocation.

The E2E can't drive this from alice: `scripts/e2e-drive.mjs` asserts her
`team.rename` rejects `not-admin`, then launches a fourth short-lived instance
(`e2e-gil`, port 9337) that joins as "Gil" to do the rename.

## Message easter eggs (1.5)

Detection is reader-side, in `src/shared/easterEggs.ts` — a message's
`body.text` is matched against a bug/celebration vocabulary on every client
independently; nothing rides the wire, so an older build just shows no
animation, forever. Eligibility (`chat/eggEligibility.ts`) and the
once-per-id/throttle queue (`app/easterEggQueue.ts`) are separate pure
modules on purpose — see `docs/features-1.5.md` §3 for the full shape.

## Pull-request header toggles (1.5)

Per-device, `localStorage`-only: `sem-prs-hide-overdue` / `sem-prs-hide-stale`
(`src/renderer/src/team/prsVisibility.ts`), each written as `'1'` and
*removed* (never `'0'`) when un-hidden. Hiding a PR from the pane never stops
it counting toward `PrsStatus.unseen` (the sidebar/dock badge) — `prs.markSeen`
is always called with the pre-hide list.

## Daily calendar toast (1.5)

Once per calendar day, per **team folder** — keyed in `localStorage` as
`chat.calendarDigest.lastShown.<sharePath>`, not globally
(`src/renderer/src/team/CalendarDigest.tsx`). Priority is birthday > an event
covering today > a countdown; opening the calendar pane suppresses the toast
without spending the day's attempt.

## Message search (1.6)

Entirely renderer-only — `src/shared/bridge.ts`, `src/preload/index.ts`,
`src/main/**` and the share are untouched. The quick switcher's ⌘K box
searches inside every log `loadTeam()` already prefetched for the unread
badges (`store.events`), so a search is a pure in-memory fold, not a new
read: zero share I/O, invisible to every other client, and reaches only
what this device can already decrypt.

- **Where the pure modules live.** `src/renderer/src/search/messageSearch.ts`
  (folding with an offset map so a `<mark>` never lands off by one character,
  tokenizing, whole-word/prefix AND matching, the global newest-200 cap
  applied *before* grouping, the snippet) and
  `src/renderer/src/search/jump.ts` (the `pendingJump` state machine). Both
  are pure — no React, no DOM, no bridge — and unit-tested without mounting
  anything.
- **The `pendingJump` handshake with `MessageList`.** The quick switcher
  can't scroll a list that isn't mounted yet; `store.jumpToMessage(conv, id)`
  sets `pendingJump` *before* switching `activeConv`, so jumping from inside
  the conversation you're already reading still fires. `MessageList` is the
  only consumer: `resolveJump` (`search/jump.ts`) yields `none`/`wait`/
  `scroll`/`missing` — `wait` (log not loaded yet) deliberately does **not**
  clear the request, or the first jump into a never-opened conversation would
  race the log and misfire as `missing`. `scroll` highlights the row
  (`data-jump-target="1"` on `MessageRow`, `sem-jump-flash` in
  `chat/util.ts`'s `CHAT_CSS`, `JUMP_FLASH_MS` = 2 s) and scrolls to it one
  animation frame later (virtuoso needs to lay the rows out first). `missing`
  — the row was swept by retention before anyone searched for it — toasts
  "That message is no longer on the share" instead of failing silently.
  `pendingJump` is cleared on a team-folder change like every other
  team-scoped slice.
- **Search never touches the share.** No new event type, no new bridge
  surface, no new IPC handler, no `protocol.json` change — an older client
  is unaffected by construction, since nothing about this feature is on the
  wire for it to see. Full design: `docs/features-1.6.md`.
