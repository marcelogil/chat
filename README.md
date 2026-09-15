# Chat

Encrypted team chat whose entire backend is a shared folder. No servers, no
internet required — built for teams on locked-down corporate networks where
the only thing every machine can reach is an SMB share.

![icon](resources/icon.png)

## What it does

- **Team channels + direct messages** — DMs are end-to-end encrypted
  (X25519); even teammates holding the team passphrase can't read them.
  Channels can be renamed or deleted from their own menu (the team's home
  channel is the one exception) — a deleted channel stays readable for a
  few days before the cleanup removes it for good.
- **Private groups** — quick encrypted group chats for a handful of people,
  separate from channels and DMs. Invites travel as a direct message, so
  nobody else on the team — not even someone holding the team passphrase —
  can see who's in a group or read what's in it.
- **Presence, typing, read receipts** — via per-device beacon files; one
  directory listing per tick tells every client everything that changed.
  The tick follows what you are doing: 1 s focused, 3 s in the background —
  or in a focused window that's gone three minutes without input, which
  slows to 3 s too, never all the way to 15 s — 15 s once a backgrounded
  window has *also* gone that long idle, and nothing at all while the
  screen is locked or the machine is asleep — about 88, 42 and 13 share
  operations a minute for a quiet team of five, and zero when paused.
  Settings → About shows the live rate.
- **Anti-impersonation** — every message is Ed25519-signed. The gray chip
  next to each name (`MBP-ANA·Q7RC`) is the hostname plus a fingerprint of
  the key that actually signed the message. A new device claiming a known
  name gets flagged loudly.
- **File sharing** — drag a file into the chat to share it with everyone
  (inline image/video/GIF previews, streaming video scrub straight off the
  share). Drag a file onto a *person* to beam it directly to them,
  AirDrop-style, with accept/decline.
- **Diagrams** — a FigJam-style whiteboard built into the composer
  (Excalidraw): sketch a diagram and send it inline, export to PNG/SVG/
  `.excalidraw`, or drop a file in to import and keep editing. Opens full
  screen (F11, or ⌃⌘F on macOS) for serious work. Works fully offline,
  bundled shape libraries included.
- **Live boards** — turn any diagram into a real-time session anyone in the
  conversation can join and draw in together, carried entirely by the shared
  folder (no server, ~1–2 s latency) at roughly 7 share operations a second
  per person while a session runs, and zero once it's closed.
- **Polls & quick decisions** — ask a question with 2–10 options (multiple
  choice, and anonymous-in-the-UI if you like), or use the Yes/No/Abstain
  preset for a clean "Decided: Yes (4–1)" once it closes. Every vote is still
  a signed event on the share; anonymous only hides names in the app.
- **Link previews** (Apple-Messages style), **code blocks** with syntax
  highlighting + copy button (22 languages, selectable from a dropdown,
  TypeScript by default), **reactions, pins, edits, mentions**.
- **Screen sharing** — WebRTC peer-to-peer over the LAN when the network
  allows, automatic fallback to ~1 fps encrypted frame relay through the
  folder when it doesn't. Chat always uses its own picker (screens listed
  first, your main display pre-selected) — never an OS system picker — and
  the presenter banner always names what's actually being shared.
- **Self-cleaning** — clients cooperatively delete old media from the share
  (default: files after 7 days, messages after 180). No server needed.
- **Native notifications**, dark/light themes, offline outbox.
- **Splash screen** on launch while the local key unwraps and the share
  connects.
- **Team calendar** — releases, freezes, birthdays, one shared calendar per
  team with colours, tags, and yearly repeats, synced through the same
  encrypted folder as everything else.
- **Daily calendar toast** — once a day, per team folder, a toast sums up
  what the calendar says about today: a birthday first, then any event
  covering today, otherwise a countdown to what's next. Quiet the rest of
  the day, and it steps aside while the calendar pane itself is open.
- **Pull requests** — watch Azure DevOps repos from inside Chat: a red
  sidebar badge and popup when a PR needs your review, filters (assigned to
  me / mine / by branch), and every pull request shows who it's waiting on
  and for how long — the reviewers, the author, or whoever opened a comment
  thread the author hasn't answered yet. An approved pull request stays
  listed under "Ready to complete" instead of disappearing, and one with no
  activity for 14+ days is called out as stale; both thresholds live in the
  PR settings. The watched repo list can be edited any time — Chat re-checks
  the saved connection on its own, no re-pasting a token. The "N overdue" /
  "N stale" counts above the list are also click-to-hide, per device — they
  keep counting while hidden, so the sidebar badge never gets stuck behind a
  toggle you forgot about.
- **Notification controls** — a bell in the sidebar and in the pull-request
  pane gives quick control over both: pull requests (All / Only mine /
  Paused) and chat (Everything / Only about me / Nothing), plus a one-click
  pause for 1 hour or until 9:00 the next morning. Quiet hours (set in
  Settings) are honoured everywhere this covers — chat, pull requests, and
  the in-app pull-request alert alike; a beam offer still comes through
  regardless, since someone on the other end is waiting for an answer.
- **Admin panel** — Settings → Admin, visible only to whoever is named Gil
  (there's no server to hold a real permissions list, so "admin" is a display
  name). From there: rename the team — every other client folds the change
  within a few seconds, and one still on an older build just keeps seeing the
  original name — and a personal "always look online" toggle, just for him.
- **Message easter eggs** — a beetle scurries across the window for a
  mention of a bug, confetti falls for a congratulations, in English,
  French, German/Swiss German or Portuguese; strictly reader-side (nothing
  rides the wire), once per message, and off entirely when the OS asks for
  reduced motion. Toggle it in Settings → Appearance.

## How messages are secured (even from someone with the passphrase)

Everything written to the share is AES-256-GCM encrypted and bound to its
location — a moved, renamed, or replayed file fails authentication — and every
record is Ed25519-signed, which is what the chip beside a name (`MBP-ANA·Q7RC`)
reports: the hostname plus a fingerprint of the key that actually signed the
message. It can't be typed or chosen, and a new device claiming a known name is
flagged.

The team passphrase (scrypt, 128 MiB) is the only secret to distribute — in
person. It unlocks the team's shared side: channels, the calendar, the
pull-request config (including a *shared* Azure DevOps token, if you use one),
poll votes and live boards in channels. It does **not** unlock direct messages
or private groups — and that isn't a rule anyone has to honour, those keys are
never derived from it. A DM key comes from an X25519 handshake between the two
devices' own keys, and the DM's directory name is derived from that key, so
someone holding the passphrase can neither read a DM nor tell whose it is. A
private group is a random key handed to each member inside their DM, living in a
directory only a member can name; removing someone rotates it.

Local data is encrypted too — DPAPI on Windows, wrapped under the team
passphrase on macOS, where Chat deliberately stays out of the Keychain
(ad-hoc-signed builds would trigger a "wants to use your confidential
information" prompt on every update). The trade on a Mac: a copy of the profile
folder *plus* the passphrase is that device's identity, including its DM key —
keep FileVault on. Passphrase rotation is a v2 item; today, someone leaving the
team means a new team folder with a new passphrase.

The threat model, the caveats, and a table of who can read what:
[`docs/security.md`](docs/security.md).

## Developing

```bash
npm install
node --experimental-require-module node_modules/electron/install.js  # once
npm run dev            # one instance
npm run dev:a          # or two instances side by side…
npm run dev:b          # …against the same local folder
npm test               # unit + protocol integration tests
node scripts/e2e-drive.mjs   # live two-instance E2E (build first)
```

Node ≥ 22.12 recommended (on 22.11 the repo's scripts set
`--experimental-require-module` where needed).

## Azure DevOps setup

The pull-request feature needs a **Personal Access Token** with scope
**Code → Read** — SSH keys only authenticate `git` operations, not the REST
API Chat polls. Create one at `{org url}/_usersSettings/tokens` (e.g.
`https://dev.azure.com/yourorg/_usersSettings/tokens`); on-prem **Azure
DevOps Server and TFS** work the same way against a collection URL (e.g.
`https://tfs.internal/DefaultCollection`) — Chat negotiates the REST API
version down to whatever the server speaks, back to TFS 2015, and shows the
one it settled on next to "Signed in as…".

A token can be kept personal or shared with the team. A shared token is
readable by anyone holding the team passphrase — prefer per-person tokens
where you can, and when you do share one, keep it short-expiry and
read-only. Chat polls every 60 seconds and goes through the system proxy,
so no firewall changes are needed beyond what already lets a browser reach
Azure DevOps.

## Building & releasing

```bash
npm run dist                              # mac + windows zips into dist/
SHARE_PATH=/Volumes/TeamShare npm run release   # + publish to the share
```

`SHARE_PATH` may be either the share that holds the team folder or the team
folder itself (`/Volumes/TeamShare/Chat` — the path Settings shows); the
script resolves the team root the same way the app does and refuses to
publish into a folder with no `protocol.json`, since no client would poll it.

Both zips are produced from macOS — no Windows machine, no wine (electron-
builder ≥ 26 patches the exe with pure-JS resedit).

**The release key.** `apps/version.json` is signed with an Ed25519 key the
release script generated on first run at `~/.semaphore-release-key.json`
(outside the repo — never commit it). Its public half is baked into
`src/main/services/updates.ts` (`RELEASE_PUBKEY_B64URL`) as of 1.1.0, so a
client shows an update banner only for a manifest signed by that key — write
access to the share is no longer enough to raise one. **Back that file up.**
If it is lost, releases can still be built, but every existing client will
ignore them until you bake a new public key and hand-deliver that build once.
1.0.x clients shipped with the constant empty and accept any manifest, so they
still see the 1.1.0 banner.

Since 1.2, a teammate who's already running a newer build makes every other
1.2+ client show an update banner right away, even before you've published a
zip for it — it names them and says so as a claim, not a fact ("Ana says
they're on Chat 1.2.0 — no signed build in the apps folder yet.") and points
at the apps folder, then upgrades itself into the normal "copy to my machine"
banner the moment the signed manifest actually lands.

Users install by copying a zip from `<share>/Chat/apps/`, extracting,
and double-clicking. No installers, no scripts. `README-INSTALL.txt` is
published alongside with the Gatekeeper/SmartScreen notes.

The first time Chat opens — and every time after, until both are accepted —
it suggests opening at login and allowing notifications (turn the suggestion
off for good in Settings → Notifications). On a Mac, turning on "open at
login" does not skip the unlock screen: the team passphrase is still asked
for after every restart, login item or not (see the Keychain rule above).

## Before first deployment (de-risk checklist)

1. `node scripts/share-conformance.mjs <path-on-real-share>` from one Mac
   **and** one Windows box (with clocks deliberately skewed ±10 min once) —
   verifies rename atomicity, exclusive create, and most importantly whether
   file mtimes come from the server clock (the janitor and clock calibration
   assume so).
2. Copy the win zip to the most locked-down Windows machine available and
   double-click. If AppLocker/WDAC blocks unsigned exes, ask IT for a path
   rule (e.g. `%LOCALAPPDATA%\Chat\*`) — no packaging trick beats
   allowlisting policy.
3. Chat always uses its own picker (screens listed first, your main display
   pre-selected) — there's no OS system picker involved on any macOS
   version. On macOS, if Screen Recording isn't granted yet, Chat shows an
   explainer instead of a picker full of misleading thumbnails; after
   granting it in System Settings → Privacy & Security → Screen Recording,
   restart Chat. Expect a re-grant after app updates — that's normal for
   ad-hoc-signed internal builds. On macOS 15 (Sequoia) and later, the OS
   may also show a periodic "Chat can record this screen" reminder while
   sharing; that's Apple's own nudge, not an error.

## Layout

```
src/shared/     protocol types, envelope constants, canonical JSON, HLC, merge logic
src/main/       Electron main: crypto, transport (share I/O, beacons, events),
                services (blobs, beams, signaling, frames, janitor, updates), IPC
src/preload/    the single typed bridge surface
src/renderer/   React app: shell, onboarding, chat, rich content, screen share
scripts/        release, icons, no-natives gate, share conformance, live E2E
```
