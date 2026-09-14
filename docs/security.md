# How Chat is secured

Chat has no server. Its entire backend is a folder — usually an SMB share —
that every member's machine can write to. That single fact decides the whole
design: **the share is not trusted**. Anything that must stay private is
encrypted before it is written, and nothing is protected merely by living in a
directory somebody didn't think to look in.

This document explains what the team passphrase protects, what it deliberately
does *not* unlock, and why "even someone holding the passphrase cannot read your
direct messages" is a statement about key derivation rather than a policy we ask
people to respect. Every claim names the file and function it rests on, so you
can check it rather than take it on faith.

---

## 1. The threat model

### Who we defend against

**Someone with read access to the share but no passphrase.** The most likely
real adversary: a backup system, a storage admin, a curious colleague with the
same network drive mapped, or whoever ends up with a copy of the folder. Every
file except one is encrypted (AES-256-GCM) under keys that exist nowhere on the
share. The one exception is `protocol.json` at the team root — plaintext by
design: it carries the team name, the KDF parameters, the random team salt, and
a 16-byte check value (`createOrJoinTeam` in `src/main/transport/bootstrap.ts`,
`computeCheck` in `src/main/crypto/keys.ts`). That file is what lets a client
tell "wrong passphrase" from "wrong folder" — and it is also an offline oracle
for guessing the passphrase, which is exactly why the KDF is expensive (§2).

**Someone who also has the passphrase.** A teammate, a former teammate who kept
it, or anyone who obtained it. They get the team key space and everything
derived from it (§2). They do **not** get direct messages or private groups
(§3) — not because they are asked not to look, but because those keys are never
derived from the passphrase.

**A lost laptop.** Nothing the app persists locally is plaintext except UI
settings. Device keys, the cached team key, group keys, roster pins, read
cursors and the Azure DevOps token all live in `*.enc` files encrypted under a
random Local Master Key (`LocalStore` in `src/main/store/localStore.ts`). On
Windows that key is sealed with DPAPI and is useless to anyone who is not that
Windows user (`platformKeystore` in `src/main/store/osKeystore.ts`). On macOS it
is wrapped under the team passphrase, and the app asks for it at every launch
(`LocalStore.unlockWithPassphrase`) — see the caveat in §3.4.

**An outsider who steals a copy of the app.** The zip contains no team secret of
any kind. The only key baked into the binary is a *public* Ed25519 release key
(`RELEASE_PUBKEY_B64URL` in `src/main/services/updates.ts`), which can verify
update manifests and decrypt nothing.

### Who we do *not* defend against

- **A compromised machine belonging to a member.** Malware running as that user
  can read the decrypted attachment cache, drive the app, and — on Windows,
  where DPAPI unseals silently for the logged-in user — recover the local key
  and with it that device's DM keys. There is no defence against this and we
  claim none.
- **A malicious member of a channel or group.** Encryption decides *who can
  read*; it says nothing about what a legitimate reader then does with the
  plaintext. Anyone in a conversation can screenshot, copy, or forward it.
  Anyone with write access to the share can also *delete* files: Chat protects
  confidentiality and authenticity, not availability.
- **Metadata.** Encryption hides contents, not the shape of the traffic. Anyone
  who can list the share learns how many conversations exist, how many events
  and attachments each holds, how large they are, exactly when each was written,
  and which 8-hex device prefix wrote it — event filenames are
  `<hlcMs>-<ctr>-<deviceId8>.<type>.e1` (`EVENT_RE` in `src/shared/ids.ts`), so
  even the *kind* of each event (`msg`, `vot`, `sys`, …) is visible without a
  key. §6 spells out what is and isn't leaked.
- **A weak passphrase.** `protocol.json` lets anyone with the folder run an
  offline guessing attack. scrypt at 128 MiB per guess is a cost multiplier, not
  a substitute for a passphrase worth attacking.

---

## 2. What the team passphrase is, and what it unlocks

The passphrase is stretched with **scrypt, N = 2¹⁷, r = 8, p = 1** — 128 MiB of
memory per guess — over a 32-byte random per-team salt, producing the 32-byte
**team master key** (`deriveTmk` in `src/main/crypto/keys.ts`; parameters in
`KDF`, `src/shared/constants.ts`). scrypt rather than Argon2 for a reason stated
in the code: every maintained Argon2 binding is a native addon, which this
project bans outright.

From that master key, HKDF-SHA256 derives the rest of the team key space
(`deriveTeamKeys`, `deriveConvKey` in `keys.ts`):

| Key | Derivation | Protects |
| --- | --- | --- |
| `kMeta` | HKDF(TMK, salt, `smbchat/v1/meta`) | directory tokens, team config, channel metadata, the device roster |
| `kPres` | HKDF(TMK, salt, `…/presence`) | beacons (presence, typing, cursors) |
| conversation key | HKDF(TMK, salt, `…/conv/<channelId>`) | one channel's or team log's events |

So the passphrase **does** unlock, for anyone holding it:

- **Channel messages**, and everything attached to them. A channel's log lives
  at `channels/<convToken>/events/<day>/…`, where `convToken =
  base32(HMAC(kMeta, "conv:<channelId>"))[0:20]` (`convToken` in `keys.ts`,
  `Session.convInfo` in `src/main/transport/session.ts`).
- **The team calendar and the pull-request configuration.** Both are "team
  conversations" whose `ConvId` *is* the key id — `team:calendar`, `team:prs`
  (`TEAM_CONV` in `constants.ts`, `Session.teamFor`).
  **Warning:** if the team shares one Azure DevOps personal access token, that
  credential lives in the `team:prs` log and is therefore readable by every
  passphrase holder — the code that handles it says so (header comment in
  `src/main/services/prService.ts`). Prefer per-person tokens; if you must share
  one, keep it read-only and short-lived. The main process strips it before the
  event crosses the bridge into renderer memory (`redactEventForRenderer` in
  `src/shared/prs.ts`), but that is defence in depth, not confidentiality from
  teammates.
- **Poll votes in channels.** A vote is an ordinary `vot` event in the channel
  log. `anonymous` hides voter names **in the UI only** — the signed vote, with
  its author, is on the share (`PollBody` docs in `src/shared/types.ts`,
  `normalizePollBody` in `src/shared/poll.ts`).
- **Live boards in channels.** Board frames are signed then encrypted under the
  *conversation's* key (`BoardService` header and `publishFrame` in
  `src/main/services/boards.ts`), so a channel board is exactly as private as
  the channel.
- **The device roster** — display names, hostnames, public keys, first-seen
  times — encrypted under `kMeta` (`Roster.publishSelf` in
  `src/main/transport/roster.ts`).
- **Presence and typing for channels** (§6).

Every one of those records is **signed, then encrypted**: an Ed25519 signature
over canonical JSON with a domain-separation tag goes inside the plaintext
(`signRecord` in `src/main/crypto/identity.ts`; tags in `DST`, `constants.ts`),
and the whole signed blob is sealed in an SFC1 record (`EventStore.publish` in
`src/main/transport/events.ts`).

**The envelope.** SFC1 is AES-256-GCM with a fresh random 16-byte HKDF salt per
file — so every file gets a unique AES key, and the random 96-bit nonce carries
no collision risk at any message volume — plus AAD binding the ciphertext to
`smbchat/v1|<scope>|<relPath>|<objectId>` (`buildAad`, `encryptRecord` in
`src/main/crypto/envelope.ts`). A file that is renamed, moved into another
conversation's directory, or replayed under a new name **fails
authentication**. That is why `CLAUDE.md` says changing a file's path breaks
decryption *by design*.

---

## 3. What the passphrase cannot unlock

### 3.1 Direct messages

Each device generates an Ed25519 signing key and an X25519 agreement key on
first run (`generateIdentity` in `identity.ts`). The private halves never leave
the machine; the public halves are published in the device roster.

A DM key is derived from the X25519 shared secret of the two devices:

```
shared = X25519(myPriv, theirPub)                          identity.ts  dmSharedSecret
dmKey  = HKDF(shared, salt="<idLo>|<idHi>", "smbchat/v1/dm-root")   keys.ts  deriveDmKey
```

The team master key is not an input. Holding the passphrase gives you no term in
that equation — you would need one of the two devices' private keys.

It goes further than "cannot decrypt": a passphrase holder **cannot even tell
whose DM a directory is**. The directory name is derived from the DM key itself
— `dmPairToken = base32(HMAC(dmKey, "dirtoken"))[0:20]` (`dmPairToken` in
`keys.ts`) — and the log lives at `dm/<pairToken>/events/…` (`Session.convInfo`).
Only the two participants can compute that token. A teammate with the passphrase
sees a list of opaque 20-character directory names and can count them. Nothing
in a filename says who is talking to whom.

### 3.2 Private groups

A private group **is** a random 32-byte key and nothing more (`newGroupKey` in
`keys.ts`, `GroupService.create` in `src/main/services/groups.ts`). Its
properties follow from how that key travels:

- **Delivery.** Each member's copy arrives as a `grp` event **inside the
  owner↔member DM log** — already end-to-end encrypted under the pair key
  (`GroupService.sendInvite`). The team key is never involved, so the invite is
  not readable with the passphrase either.
- **Location.** The log lives at `groups/<HMAC(key₁,"grp-dirtoken")>/events`
  (`groupDirToken` in `keys.ts`). Only someone handed the group's epoch-1 key
  can compute that name, which is why an invite at a later epoch also carries
  `key1`.
- **Removal rotates the key.** `removeMember` mints a new epoch key, hands it to
  everyone *except* the removed device, and publishes the removal event itself
  under the new key — so the removed device cannot even read that it happened.
  It is told separately over the DM, in a notice carrying no key material. Its
  later writes under the retired key are refused rather than merely unreadable
  (`GroupService.staleWriteCut`, enforced on the decrypt path in `events.ts`).
- **Leaving does *not* rotate.** A member who leaves keeps a working copy of the
  current key and can still read anything published under it afterwards if they
  keep the folder (`GroupService.leave`). If someone needs to be cut off, the
  owner must **remove** them.
- **Unverified records never enter a group log at all** — unlike a channel,
  where an unverified record is shown with a warning chip instead
  (`EventStore.ingestFile`).

What a passphrase holder who was never invited can learn: that `groups/`
contains N opaque directories, and the count and size of the files inside them.
Not a name, not a member, not a word of content. (`docs/features-1.2.md` §2 says
the same thing at design level.)

### 3.3 Files beamed to a person

A direct beam ("drop") uses no team key either. The file goes up as an SFB1 blob
under a fresh random key, and the offer carrying that key is an X25519 **sealed
box** addressed to the recipient device's public key (`DropService` layout
comment in `src/main/services/drops.ts`, `sealRecord` in `envelope.ts`). Only
that device can open it.

### 3.4 The one caveat — why "even with the passphrase" has an asterisk on macOS

Chat deliberately stays out of the macOS Keychain. Keychain ACLs bind to the
app's code signature, our builds are ad-hoc signed, and every new build would
therefore re-prompt "…wants to use your confidential information" — with a
*Deny* permanently bricking the profile (`osKeystore.ts` documents the verified
behaviour). The honest trade: on macOS the local key is wrapped under a key
derived from the team passphrase at the **same scrypt cost** as the team key, so
a copied profile is never a cheaper oracle than `protocol.json`
(`KEK_SCRYPT` and `wrapPassphrase` in `localStore.ts`).

But it means exactly this:

> **On a Mac, a copy of a person's profile folder plus the team passphrase is
> that device's identity** — including the X25519 key that decrypts that
> person's DMs, the cached team master key (the `team-cache` secret, written in
> `src/main/appController.ts`), and every private-group key they hold (the
> `groups` secret, `groups.ts`).

The profile folder alone is useless, and the passphrase alone is useless; it
takes both. Keep FileVault on, and treat a Mac's user folder as being as
sensitive as the passphrase itself. On Windows the local key is DPAPI-sealed
instead, so a copied profile is useless even *with* the passphrase — but
anything running as that logged-in Windows user can unseal it silently.

Two related, honest limitations:

- **DMs have no forward secrecy.** The pair key is a static-static X25519
  agreement (`Session.dmFor`), so a device key recovered today decrypts every DM
  with that peer that is still on the share. Prekeys are a listed v2 item in
  `CLAUDE.md`, not something that shipped.
- **There is no in-app passphrase rotation.** The key hierarchy has epoch
  machinery (`deriveTeamKeys` takes an epoch, and directory tokens derive from
  the epoch-1 key so they survive a rotation), but nothing in the app ever bumps
  a team epoch — there is no writer for it anywhere in the tree. Today, a
  departing member means a new team folder with a new passphrase. Also a listed
  v2 item.

---

## 4. Signing and impersonation

Display names are not identity. Keys are.

- **Every record is Ed25519-signed** before it is encrypted, over canonical JSON
  with a domain-separation tag, so a signature from one context can never be
  replayed into another (`signRecord` / `verifyRecord` in `identity.ts`, `DST`
  in `constants.ts`).
- **A device id is the hash of its own signing key** — `deviceId =
  hex(SHA-256(edPub)[0:16])` (`identityFromStored` in `identity.ts`) — so it
  cannot be chosen or forged. A registration is self-certifying, and
  `Roster.ingest` re-checks both halves: the embedded key must hash to the id in
  the filename, and the signature must verify against that key.
- **The gray chip** next to a name (`MBP-ANA·Q7RC`) is the sanitized hostname
  plus the first 40 bits of SHA-256 of the key that actually signed the message
  (`formatFingerprint` / `sanitizeHostname` in `src/shared/ids.ts`, `DeviceChip`
  in `src/renderer/src/ui/atoms.tsx`). Its tooltip says it plainly: *"This label
  is derived from the key that signed the message — it cannot be typed or
  chosen."*
- **Trust on first use.** The first time a device id is seen it is pinned
  locally, in the encrypted store. If a *new* device appears claiming a display
  name already pinned to a different device, it is pinned as `flagged` instead
  (`Roster.ingest`) and drawn with a warning chip everywhere that person appears
  — sidebar, chat header, message rows, and the beam prompt, which spells it
  out: *"This device is new for its display name — verify with the sender in
  person before accepting."* (`src/renderer/src/app/BeamSurface.tsx`).

**If you see that flag**, the safe reading is: *someone is publishing under a
name I already know, from a key I have never seen.* That is what a new laptop
looks like, and it is also what impersonation looks like. Confirm the
fingerprint out of band — over the phone, or in person — before you accept a
file, click a link, or act on the message. One current limit, stated honestly:
the app surfaces the flag but has no button to clear it. The trust call exists
on the bridge (`roster.trust` in `src/shared/bridge.ts` → the `roster:trust`
handler in `src/main/ipc.ts`) and no renderer code calls it today, so a flagged
device keeps its warning chip until local data is reset.

Someone holding the passphrase **can** register a new device and appear in the
team. What they cannot do is write anything attributable to *your* key: a forged
record fails `verifyRecord`, and in a private group an unverified record is
dropped outright.

---

## 5. File attachments

- Each attachment is encrypted as an **SFB1 stream** under a **fresh random
  32-byte key** generated for that one file (`BlobService.uploadOne` in
  `src/main/services/blobs.ts`).
- SFB1 chunks the file (1 MiB, `BLOB.chunkBytes`) with per-chunk nonces carrying
  the chunk index plus a final-chunk marker, so truncation, reordering, and
  chunk-swapping all fail authentication (`src/main/crypto/blobstream.ts`).
  Fixed-size chunks are also what lets encrypted video scrub straight off the
  share.
- **The blob key travels inside the message**, in the `Attachment` record — so
  an attachment is exactly as private as the conversation carrying it. A file
  dropped in a channel is readable by passphrase holders; a file sent in a DM or
  a private group is not.
- **Retention: 7 days for attachments, 180 days for messages** by default
  (`RETENTION.blobDays` / `RETENTION.eventDays` in `constants.ts`), swept
  cooperatively by whichever client wins the janitor claim
  (`src/main/services/janitor.ts`). Team config can override both.
- One deliberate local trade-off, recorded in the code: the decrypted attachment
  cache under `userData/blob-cache` holds **plaintext** (capped at 2 GB, LRU),
  on the grounds that it is the same trust domain as the files the user dragged
  in (`blobs.ts` header). It is deleted when the profile is wiped or the team
  folder changes (`LocalStore.clearDerivedData`).

---

## 6. Presence and metadata

Presence rides one **beacon** file per device, rewritten with its sequence
number in the filename so a single directory listing tells every client what
changed (`BeaconWriter` in `src/main/transport/beacon.ts`). The beacon is signed
and then encrypted under `kPres`, so its *contents* need the passphrase.

Inside, for a passphrase holder: display name, device id, online/away state,
status text, idle seconds, typing, the filenames of recent channel events, read
cursors, transfer progress, LAN IPs and the app version (`BeaconContent` in
`beacon.ts` / `types.ts`).

**Not** inside, for anyone but the participants: who DMs whom, and who is in
which group. Every private conversation's heads, cursor and typing state go into
a per-conversation *sealed* section — `dmSealed`, keyed by DM pair token and
encrypted under the pair key, and `grpSealed`, keyed by group token and
encrypted under that group's current epoch key (`BeaconWriter.writeBeacon`). A
reader that doesn't hold the key skips the section; the code comment on that
branch is literally `// not our pair — unreadable by design`
(`BeaconReader.readOne`). Everyone else sees an opaque token and a blob.

What is unavoidably visible to anyone who can list the share, with or without a
key:

- the number of conversations of each kind, and their opaque directory names;
- per event: the day directory, the writing device's 8-hex prefix, the event
  *type*, the size, and the timestamp in the filename (`EVENT_RE` in `ids.ts`);
- which devices are in a live board session — the frame filenames name them, and
  the `BoardService` header comment calls this out as accepted metadata, because
  that is what makes one directory listing enough to drive the session;
- the number of attachments and their sizes;
- device ids in the `devices/` and `beacon/` filenames (the contents are
  encrypted).

---

## 7. Local data on your machine

Everything the app persists is encrypted under a random **Local Master Key**,
which is itself sealed one of two ways (`LocalStore` header in
`localStore.ts`):

| Platform | How the local key is sealed | What it means |
| --- | --- | --- |
| Windows | DPAPI via Electron `safeStorage` | silent, per-Windows-user, survives app updates (`platformKeystore`) |
| macOS | scrypt(team passphrase) + AES-256-GCM | unlock screen at every launch; **no Keychain, ever** (`osKeystore.ts`, `wrapPassphrase`) |

Under that key: the device identity, the cached team key, group keys and
membership, roster pins, read cursors, the outbox, and the Azure DevOps token.
Only UI settings (theme, notification preferences) are stored in plaintext
(`LocalStore.readSettings` / `writeSettings`).

Because the local key is random and the passphrase only *wraps* it, changing the
passphrase re-writes one small file and never touches the encrypted secrets
(`LocalStore.rewrapPassphrase`). Creating a new local key over an existing seal
would destroy that device's identity permanently, so the store refuses to do it
outside an explicit, user-confirmed reset (`LocalStore.createPassphraseLmk`).

Leaving a team folder clears team-scoped secrets (group keys, PR "seen" state,
caches) and the decrypted attachment cache, while keeping what is personal —
your identity, and your own Azure DevOps token (`AppController.changeTeamFolder`
in `src/main/appController.ts`).

---

## 8. Updates

Write access to the share is not authority to ship code. The update manifest
`apps/version.json` is Ed25519-signed, and clients verify it against a public
key **baked into the binary** (`RELEASE_PUBKEY_B64URL` and `UpdateService.verify`
in `src/main/services/updates.ts`), under its own domain-separation tag
(`DST.release`). Someone who can write to the share can put a zip there; they
cannot make a client raise an update banner for it.

Nothing self-replaces: the banner copies a zip to the machine and verifies its
SHA-256; a human extracts and runs it.

The matching private key lives outside the repo, on one machine, and is never
committed. If it is lost, releases can still be built but existing clients will
ignore them until a build carrying a new public key is hand-delivered once.

---

## 9. Who can read what

| | Teammate **with** the passphrase | Share admin, **no** passphrase | Outsider with a stolen app zip | The author's own device |
| --- | --- | --- | --- | --- |
| **Channel message** | Yes | No — ciphertext; filename metadata only | No | Yes |
| **Direct message** | **No** — unless they are one of the two devices | No | No | Yes |
| **Private group message** | **No** — unless invited; a removed member loses everything written after the rotation | No | No | Yes |
| **Poll vote in a channel** | Yes — including "anonymous" ones; names are hidden in the UI only | No | No | Yes |
| **Live board** | Same as the conversation it rides in: yes in a channel, no in a DM or group. Participant device ids are visible to anyone who can list `boards/` | No (contents) | No | Yes |
| **File in a channel** | Yes — the blob key is inside the channel message | No | No | Yes |
| **File in a DM, or a beam** | **No** — the key is inside the end-to-end message, or sealed to the recipient's device key | No | No | Yes |
| **Presence / typing / read cursors** | Yes for channels and team logs; DM and group sections stay sealed | No — only filenames, sizes and timings | No | Yes |

"No" in the first column means *cryptographically cannot*, not *is asked not
to* — with the macOS profile-copy caveat in §3.4 as the single exception, and
the standing assumption that the reader's own machine is not compromised.

---

## 10. Reporting a problem

If you find a flaw in any of the above, open an issue describing the observed
behaviour — and please do not put a real team's passphrase, share path, or
access token in it.
