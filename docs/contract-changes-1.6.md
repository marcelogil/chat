# Contract changes during 1.6 implementation

Message search in the quick switcher — "the search on the top left should
return all the conversations that include that word combination; clicking the
result should take the user to that conversation or channel to that moment in
time."

Nothing here changes the share format, the envelope, the bridge or the main
process. Every entry below is a decision the request did not settle, or a place
where the implementation deliberately reads the acceptance criteria one way
rather than another. Each says what moved, why, and what to check.

---

## Scope: renderer-only, over logs that were already in memory

`src/shared/bridge.ts`, `src/preload/index.ts`, `src/main/**` and the share
layout are **untouched**. The search is a fold over `store.events`, which
`loadTeam()` has prefetched for every channel, DM, private group and team conv
since 1.1 (it needs them for the unread badges). So:

- no new IPC surface, no new file kind on the share, no new poll;
- a search costs zero share I/O and cannot be seen by anyone else;
- it can only ever find what this device can already decrypt — a private group
  you are not in has no log here to search.

New modules, both pure and both unit-tested (vitest is node-only, so no `.tsx`
is imported from either):

- `src/renderer/src/search/messageSearch.ts` — folding, tokenizing, matching,
  ranking, grouping, the cap, the snippet and the relative date.
- `src/renderer/src/search/jump.ts` — the `pendingJump` rules.

---

## What is searchable, and what is deliberately not

`searchableTextOf` (messageSearch.ts) is **not** `snippetOf` (chat/util.ts):

| body kind | indexed as |
| --- | --- |
| `text`, `code` | `body.text`, whitespace collapsed |
| `diagram` | `diagramTitleOf(body.text)` — the title |
| `poll` | `pollQuestionFor(body)` — the question |
| `gif` | nothing |
| deleted | nothing (the message is not indexed at all) |

The diagram and poll cases are the load-bearing ones. `body.text` there is the
sentence written for pre-1.2 / pre-1.3 clients ("📐 Diagram: X — **update Chat
to view it**", "📊 Poll: Y — **update Chat to vote**"), so indexing it verbatim
would make every diagram on the share a hit for "update" and "chat". Same trap
`snippetOf` and `copyTextOf` already document.

The **author display name** is part of the same haystack: each typed term may be
satisfied by the body *or* by the author's name, so "ana deploy" finds Ana's
message about the deploy. Author matches are highlighted on the row's name, not
in the snippet.

Deliberately **not** searched (and none of it was asked for): attachment file
names, reactions, link-preview text, `sys` rows, calendar entries and PR
config. A wordless message (a GIF, a bare attachment) is still reachable by its
author's name, and its row then shows a placeholder — "GIF", the file name, or
"N files" — which is display-only and never matched against.

## Conversations that are searched

Every conv in `store.events` except:

- **team panes** (`isTeamConv` — calendar, pull requests). Their logs carry
  `cal`/`prs` records that materialize elsewhere entirely and are not chat.
- **anything the switcher cannot name**: a channel no longer in `channels` (it
  was deleted), a DM with a device presence has never heard of. The store keeps
  those logs in memory, and a result row headed by a raw `chan:<token>` — or
  worse, a row that navigates into a conversation that is gone — is worse than
  no row. `convMeta` in QuickSwitcher.tsx is both the naming table and the guest
  list.

## Matching: whole words and word prefixes, never infixes

"typed words ... on whole words and word prefixes" is implemented as: a term
matches at a position where the previous folded character is not a word
character (`\p{L}\p{N}_`). So `hel` finds "hello", `ello` does not. Substring
matching over a whole team's history matches far too much to be a feature.

Terms are ANDed; the query is split on everything that is not a word character
(so `ship it!` is two terms and `c++` is one), folded, and de-duplicated.

Folding is NFD → drop `\p{M}` → lowercase, and is applied **per source
character** with an offset map (`foldWithMap`), because folding is not
length-preserving (`é` decomposed, `İ`) and a highlight that is off by one
character is worse than no highlight. The map is what lets a `<mark>` land on
the right characters of the *original* text.

## Ranking, grouping and the cap

- All hits across all indexes are sorted by **event id descending**. Event ids
  are HLC stems, so lexicographic order is chronological order and is the only
  order every client agrees on. `hlcMs` is carried for display only.
- The **cap is global and takes the newest 200** (`MAX_HITS`), then grouping
  happens. An old, chatty conversation therefore cannot push this morning's
  message off the list. Consequence, deliberate: a conversation's header count
  is its **kept** hits, not its true total, whenever the cap bit — the section
  note says "showing the newest 200" so the number is not read as a total.
- Conversations come out in the order their newest kept hit fell, which falls
  out of the sort for free.
- Three hits per conversation (`HITS_PER_CONV`), then a **"N more…" row**. That
  row is a real `role="option"`: it is keyboard-reachable and expands its group
  in place (the switcher stays open, the cursor stays put) rather than being a
  mouse-only affordance.

## Performance: a folded index per conversation, keyed on event count

`buildConvIndex` folds a whole conversation once. The cache (a ref in
QuickSwitcher) is keyed on **that conversation's event count**, which is a sound
invalidation key because an edit (`edt`) and a delete (`del`) are themselves
appended events — the count moves whenever the rendered text can. Nothing is
built at all until somebody is actually searching, and the search itself runs on
a 150 ms debounce (`SEARCH_DEBOUNCE_MS`) after 2 typed characters
(`MIN_QUERY_CHARS`).

## Rendering: `<mark>` elements, never a string of HTML

`snippetAround` returns text plus ranges; `segmentsOf` turns that into
plain/marked runs; the row maps them to `<span>` / `<mark>` **React children**.
There is no `dangerouslySetInnerHTML` anywhere in this feature, so a message
containing `<img onerror=…>` stays a message containing `<img onerror=…>`.

One layout consequence: **with message hits in it the dropdown widens past the
260 px sidebar** (`min(460px, calc(100vw - 300px))`, overhanging the
conversation pane). `overflow-y: auto` and the `min(62vh, 440px)` height cap are
unconditional — the dropdown always scrolls under that cap, hits or not — only
the width depends on message hits. A one-line snippet centred on its match is
useless if the match is past the ellipsis; without hits the panel is exactly
the width it always was.

---

## `pendingJump`: a one-shot store field, cleared by the list that consumes it

New store field and two actions (`src/renderer/src/store/index.ts`):

```ts
pendingJump: { conv, id } | null
jumpToMessage(conv, id): Promise<void>   // set → setActiveConv → ensureEvents
clearPendingJump(): void
```

The field is the handoff between two components that cannot talk: the quick
switcher cannot scroll a list that is not mounted yet, and `MessageList` cannot
know a jump was requested. `jumpToMessage` sets the field **before** switching
conversations, so searching from inside the conversation you are already reading
still fires (the switch would otherwise be the only trigger).

`resolveJump` (search/jump.ts) has exactly four outcomes, and the interesting
one is the third:

| state | outcome |
| --- | --- |
| nothing pending, or pending for another conv | `none` — leave the request alone |
| this conv, id in the rendered rows | `scroll` (+ clear) — since 1.6.1 this wins over `eventsLoaded` |
| this conv, id not rendered, `eventsLoaded` still false | `wait` — **do not clear** |
| this conv, loaded, id not there | `missing` (+ clear) → toast |

A log that is still loading says nothing about whether the message exists, so
`wait` must not fall through to `missing` — otherwise the first jump into a
conversation this client has never opened always toasts. And `wait` must not
clear, or the jump silently does nothing. Both are covered in `jump.test.ts`.

`missing` is the retention case the request named: the conversation still opens,
and the toast says **"That message is no longer on the share"**.

The store field is also cleared on the `boot` → `onboarding` push, alongside
every other team-scoped slice: a pending jump belongs to a folder we just left.

## New DOM contract on a message row

`MessageRow`'s root now carries, when it is the jump target:

```
class="sem-row sem-jump-flash"  data-jump-target="1"  data-conv="<ConvId>"
```

`data-jump-target` is the highlight's whole contract — the injected pane CSS
(`CHAT_CSS` in chat/util.ts) paints on the attribute, and `scripts/e2e-drive.mjs`
asserts on it. `data-conv` is on **every** row, not just the flashed one: only
the active conversation's rows are ever in the DOM, so it is how the E2E proves
the jump landed in the right conversation without a `setActiveConv` read-back
(there is no bridge surface for renderer state). The highlight lasts
`JUMP_FLASH_MS` and then the attribute is removed; the scroll is
`scrollToIndex({ align: 'center' })` one animation frame after the rows are
handed to virtuoso, because scrolling into a list that has not laid out yet
lands short. (Both halves of that last sentence turned out to be the 1.6.0
bug — see the 1.6.1 entry at the end of this file: one frame is not enough,
and `JUMP_FLASH_MS` is no longer 2 s.)

---

## Two notes for a reviewer

- **The acceptance criteria mention "the existing conversation/people/file
  results".** There are no file results in this tree and never have been — the
  quick switcher has always listed channels, team panes, groups and people. No
  file search was added; "below the existing results" is implemented as "below
  all of them".
- **Hit rows activate on `mousedown`, not `click`** — the same pattern the
  existing rows use, because the input's blur would close the list before a
  click could land. Anything driving this from CDP must dispatch a bubbling
  `mousedown`; `el.click()` does nothing. `scripts/e2e-drive.mjs` says so at the
  call site.

## Checks

- `src/renderer/src/search/messageSearch.test.ts` — folding and the offset map,
  tokenizing, what each body kind contributes, whole-word/prefix matching, AND,
  accents, author-name matches, grouping and ordering, the cap, the snippet
  window, and that markup comes back as text.
- `src/renderer/src/search/jump.test.ts` — all four outcomes plus what clears.
- `scripts/e2e-drive.mjs` — after the re-join block: two words from Alice's
  first channel message find it from Bob's ⌘K box, the hit is marked and headed
  by `#general`, ↓ walks into the Messages section (soft), pressing the hit
  opens that conversation and flashes the row, a phrase only ever written in the
  private group finds the group, and "zzzqqq" shows no Messages section at all.

---

## 2026-09-15 — a scoped search from the conversation header (1.6.1)

"add a search button on the top right of channels and groups and direct
messages to perform a more focused search."

Still renderer-only, still zero share I/O: the pane folds the same
`store.events` the ⌘K box does, through the same `buildConvIndex` /
`searchMessages`, with one conversation in the array instead of all of them.
`src/shared/bridge.ts`, `src/preload/**`, `src/main/**` and `protocol.json`
are untouched. What the request did not settle, and how it was read:

- **Where the results go.** Into the right rail as a fifth tab (`search`,
  after Pinned) rather than a popover or an overlay — the rail is already the
  per-conversation surface, it survives focus leaving the input (a dropdown
  does not, which is why ⌘K's hits die on blur), and the results can be walked
  while the conversation itself stays on screen and scrolls to each hit.
- **The header button is the rail's own toggle.** `onOpenTab('search')`, the
  same call the pin makes, so a second press on an already-open Search tab
  closes the rail. No second toggling rule to keep in sync.
- **No per-conversation cap.** The dropdown's `HITS_PER_CONV` (3, then "N
  more…") exists to keep one talkative channel from burying every other
  conversation. Scoped to one conversation there is nothing to protect, so
  every hit shows; only the global `MAX_HITS` (200) still bites, and the count
  line says so when it does ("Showing the newest 200 of 837") instead of
  quietly showing fewer.
- **The honest total.** To be able to say "of 837" the pane hands
  `searchMessages` a `max` of `SCAN_ALL` and lets `flattenHits` apply
  `MAX_HITS` itself — `SearchResult.total` is the *kept* count, so a result
  the search truncated can no longer say how many it dropped. `countLine`
  still handles that shape ("Showing the newest 200", no total) for any caller
  that passes the default cap.
- **The author's name is the one the message was signed with** (`Hit.authorName`,
  straight off the event), not a presence lookup — a `Hit` carries no device
  id, and a message from a device that has left the share still has to render
  a name. Same as the switcher's hit rows.
- **Esc is a two-step**: it empties the box, and only closes the rail when the
  box is already empty. The same shape the fullscreen editor's Esc already
  has, and it keeps a typo from costing the whole panel.
- **Rows activate on `mousedown` *and* `click`.** The switcher's rows are
  `mousedown`-only because its dropdown dies on blur; the rail's does not, so
  the pane accepts both and de-duplicates the pair a real mouse sends (the row
  remembers its own `mousedown` and lets that one `click` through as a no-op).
  Anything driving this over CDP can dispatch either.
- **A jump does not close the pane** — the query and the result list stay put,
  which is what makes walking a result list possible at all.

New DOM contract, for the E2E and for anyone else driving it:

| selector | what it is |
| --- | --- |
| `[aria-label^="Search in "]` | the header button and the pane's input (and its listbox) |
| `[aria-label="Search tab"]` | the rail's Search tab button (`role="tab"`, `aria-selected`) |
| `[data-conv-search-hit="1"]` | one hit row (`role="option"`, `aria-selected` for the cursor) |
| `[data-msg-id]` on that row | the message id the row jumps to |
| `[data-conv-search-count]` | the count line, carrying the match total as its value |

Checks: `src/renderer/src/search/convSearch.test.ts` (label forms, newest-first
flattening and the `MAX_HITS` slice, both capped count lines and the singular
"1 match", cursor clamping).

Three details a review pass fixed before this shipped, all of them in the rail:

- **The fifth tab has to fit 320 px.** About/Members/Files/Pinned/Search
  measure ~191 px of text; at the old `padding: '0 10px'` and `gap: 2` the
  five buttons alone filled the strip's entire 304 px content box, pushing
  the rail's own "Close details" **x** past the window edge, where
  `AppShell`'s `overflow: hidden` clipped it. Single-word labels cannot
  shrink (`min-width: auto` is their min-content width), so the padding gave
  instead — `'0 6px'`, no gap — and the close button is wrapped in a
  `flexShrink: 0` span so it can never be what gives.
- **The cursor-into-view effect is keyed on `[sel, hits.length]`**, not on
  `hits`: that array gets a new identity on every event that lands in the
  conversation, and `scrollIntoView` on a teammate's message would yank the
  result list out from under someone reading the older matches.
- **A row's `mousedown` claim on the following `click` is time-bounded**
  (`MOUSEDOWN_CLAIM_MS`, 300 ms). A mousedown that never produces a click
  (press, drag off the row, release) used to leave a sticky flag that
  swallowed the next click-only activation of that same row — Enter on a
  focused row, or a synthetic `row.click()`.

---

## 2026-09-15 — the jump had to actually land, and be seen (1.6.1)

Reported by Gil against the shipped 1.6.0: choosing a search result switches
to the right conversation, but the list does not scroll to the message and no
highlight is visible. Three separate causes, all of them in the renderer, none
of them visible in a channel with three messages in it.

**1. The list mounts at the bottom.** `ChatPane` renders `<MessageList
key={conv}>`, so a jump into another conversation remounts the list, and
virtuoso reads `initialTopMostItemIndex` **once**, at mount. 1.6.0 always
passed `items.length - 1`. It now mounts at the target when there is one —
`initialTopMostItemIndex={{ index, align: 'center' }}` — computed
synchronously during the render that first mounts the list (a ref latched
below the early returns; any later render is too late).

**`resolveJump` no longer waits for `loaded` when the row is already
rendered.** This is the one behavioural change to a 1.6.0 rule: the table now
reads *rendered → `scroll`*, *not rendered and not loaded → `wait`*, *not
rendered and loaded → `missing`*. `loaded` only says whether **this pane's**
`ensureEvents` has come back; `loadTeam()` has usually had the log in memory
since boot, so waiting for the flag cost the jump the only render that can
mount it at the target. `shouldClear` is unchanged, and `wait` still never
clears the request.

**2. One `scrollToIndex` is not a landing.** Virtuoso measures rows over
several animation frames; a scroll issued into a list that is still sizing
itself lands short, and the row it aimed at keeps moving. The list now
verifies, frame by frame, and re-asks until it is satisfied. The rules are
pure, in a new module — `src/renderer/src/search/landing.ts`
(+ `landing.test.ts`):

- `isInside(rowRect, scrollerRect, tolerancePx = LANDING_TOLERANCE_PX)` — 2 px
  of sub-pixel slack, and a row taller than the viewport counts as landed once
  it *covers* the viewport (otherwise one tall diagram tile burns the budget
  and reports a failure that is not one).
- `nextLandingStep(state, insideNow) → { state, action: 'retry' | 'done' |
  'give-up' }` — `LANDING_INSIDE_FRAMES` (2) consecutive inside frames before
  it believes it, `LANDING_MAX_FRAMES` (90, ~1.5 s at 60 Hz) before it gives
  up. The budget is counted in **frames, not milliseconds**: frames are the
  unit the loop gets to measure in.

`MessageList` only wires DOM to it. The scroller is found from the flashed row
upwards (`closest('[data-virtuoso-scroller="true"]')`, which react-virtuoso
4.18 sets on its scrolling element; the fallback is the first descendant that
actually overflows, so a library bump degrades into a slower query rather than
into jumps that never land). The row index is **re-derived from the live
`items` on every retry**, because a landing spans many frames and anything
that folds into the log mid-flight shifts every index after it. The loop is
cancelled by a newer jump and stops itself when the list root is disconnected
— clearing `jumping` on the way out, so an early return that empties the rows
cannot leave `followOutput` pinned off forever. It is deliberately not
cancelled from an effect cleanup, because clearing `pendingJump` re-runs that
effect immediately and the cleanup would cancel the landing it had just asked
for; the one mount-only cleanup clears the **settle timer** only, since
React.StrictMode runs that cleanup on its simulated remount and cancelling
the frame loop there would kill every dev-mode jump (`isDuplicateInvocation`
then refuses to restart it). Exhausting the budget is silent — no toast, no
log.

**3. `followOutput` snapped the list back to the bottom.** Virtuoso's
`atBottom` is a debounced stream that is **not** settled around a jump: the
list mounts believing it is at the bottom and the real answer arrives frames
later. While it is unsettled, any change to `items` — a peer's message landing
right behind the jump, an edit folding in — reads to `followOutput="smooth"`
as "new output, scroll to the end". That is why the same bug reproduced when
searching from inside the conversation being read, where nothing remounts. So
`followOutput={jumping ? false : 'smooth'}`, off while a jump is landing and
for `JUMP_SETTLE_MS` (1500 ms, `landing.ts`) after it lands, then exactly as
before.

It is **not** the unread divider that changes, and earlier drafts of this
entry (and of `landing.ts`, `features-1.6.md` and `CLAUDE.md`) were wrong to
say so: that row comes from the `anchorRead` prop, which `ChatPane` captures
once per conversation and holds stable while it is open, so marking read
mid-session cannot add or remove it.

**4. Landing on an old message marked the conversation read.** The same
unsettled `atBottom`, with a consequence that is not cosmetic: the markRead
effect runs at mount with `atBottomRef` still `true`, so a mount-at-target
jump published a read cursor for the **newest** message while the reader was
parked 44 messages above it — the sidebar badge cleared for messages nobody
had seen, and a DM peer shown "Read <time>" under one nobody looked at. In
1.6.0 that call was defensible because the list really did mount at the
bottom; mount-at-target is what made it wrong. `mark()` now returns early
while `jumpingRef.current` is set, and `jumping` is in the effect's
dependency list so the end of the settle window re-runs it — **once the
person really reaches the bottom it marks read exactly as before**, and the
`focus` listener is registered unconditionally as it always was.
`startLanding` also parks `leftAtRef` on the jumped-to id: the `atBottom →
false` transition that follows a landing would otherwise mark it at the newest
id, and a "N new messages" pill counting messages newer than the newest never
renders, leaving the reader mid-history with no way back down.

**The highlight now holds before it fades.** Gil asked for "a small background
color change to highlight what we are looking for"; a 2 s fade that began on
the first frame was usually over before the eye arrived. `JUMP_HOLD_MS` = 4000
(full `var(--accent-soft)` + the `inset 3px var(--accent)` bar), then
`JUMP_FADE_MS` = 800 to transparent, and `JUMP_FLASH_MS` — the React timer
that drops `flashId` and with it the class — is now **derived**
(`JUMP_HOLD_MS + JUMP_FADE_MS` = 4800 ms), never typed twice. `CHAT_CSS` is a
template string, so it imports both constants and computes the `@keyframes`
percentage from them; the previous shape (a `2s` literal in the CSS and a
`2000` in the module) is exactly how a class gets pulled mid-fade. Under
`prefers-reduced-motion` the row gets no animation at all — the same tint held
for `JUMP_HOLD_MS` by a `step-end` keyframe (`sem-jump-hold`), then gone.

No new bridge surface, no IPC, no share I/O, no `protocol.json` change: an
older client is unaffected by construction, exactly as in 1.6.0.

Checks: `src/renderer/src/search/landing.test.ts` (both rules, the budget, the
streak reset, the tall-row case), `src/renderer/src/search/jump.test.ts` (the
new rendered-but-not-loaded row, and `JUMP_FLASH_MS === JUMP_HOLD_MS +
JUMP_FADE_MS`), and the `1.6.1 jump landing + scoped search` block in
`scripts/e2e-drive.mjs`, which seeds 45 messages into `#general` so the target
is 44 rows above the bottom and then measures — from another conversation and
from the conversation search — that the flashed row is fully inside its
scroller within 5 s, is painted (computed `background-color` not fully
transparent), and is **still** inside two seconds later.

---

## 2026-09-15 — a burst larger than the beacon's `heads` ring (1.6.1)

Found by the 1.6.1 E2E, not by a report: `alice seeds 45 messages into
#general, the needle first` passed, and `bob holds the whole overflow` then
timed out after 120 s. Bob was holding exactly **16** of the 45 — `BEACON.headsRingSize`.

**What actually happens.** A beacon advertises the last `headsRingSize` (16)
filenames per conversation. A writer that publishes 45 events between two of a
reader's polls — the seed above took *1.1 s* on the share
(`1789487320000…` → `1789487321031…`, 45 files, one device) while a reader at
the idle tier polls every `POLL.idleMs` (15 s) — pushes the first 29 out of the
ring before anybody reads it. They are never advertised to anyone, ever. The
reader then reads a ring of 16 names that all resolve perfectly, so
`ingestHeads`'s missing-head rule ("an advertised head we could not read means
older un-advertised events may exist") never fires, and the reader concludes it
is level. The 29 older events — including, in a paste storm, the first line of
whatever was pasted — wait for the next blanket sweep: 1, 3 or **10 minutes**
depending on the I/O tier. Nothing is lost and nothing is wrong on the share;
the reader is simply, silently, 29 events behind in a conversation someone may
be looking at.

This is not new in 1.6 and has nothing to do with the re-joined device the E2E
happens to seed from (`src/main/transport/rejoin.test.ts` now proves a
re-joined device's channel message reaches a peer that pinned its predecessor
on the beacon path, in one tick). It has been true of every ring since `heads`
existed; 45 messages in a second is just not something a person does by hand.

**The fix, reader-side only.** `EventStore.ingestHeads` now also treats a ring
that is *at capacity* and in which it recognized **nothing** as a possible gap,
and falls back to the same bounded day scan. The ring is the only evidence a
beacon offers about a conversation's recent past; a full ring with no name in
common with what we hold cannot prove continuity — in the steady state a reader
already holds all but the newest name or two. "Recognized" counts both events
already ingested and files *parked* awaiting a group key, so a rekey storm
still costs no scan (the 1.2 rule this sits next to).

Because a ring's capacity is what makes "full" meaningful, `ingestHeads` takes
it as an argument and `Poller.processObservation` passes the right one per
ring: `BEACON.headsRingSize` for `heads` and a sealed section's `heads`,
`GRP_HEADS_RING` (4) for `grpHeads`, `HEADS2_RING` (8) for `heads2` — the plain
`heads`/`heads2` pair is therefore no longer merged into one array before
ingestion, or 8 vote names would be judged against a 16-name budget.

**Not a wire change.** No new field, no new event type, no `protocol.json`
change; `heads`, `heads2` and `grpHeads` mean exactly what a 1.2/1.3 client
already thinks they mean, and rings are written exactly as before. A writer
cannot fix this from its side — a reader only ever sees the *current* beacon
file, so publishing more of them mid-burst changes nothing — which is why the
rule lives in the reader.

**I/O cost: none measured.** The steady-state budget harness
(`src/main/transport/poller.test.ts`, "share I/O budget", team of 5) reports
byte-identical `readdir`/`read` counts with the rule on and off — focused
710/120, blurred 247/120, idle 51/54 — because a reader that is level
recognizes the ring. The new scan fires on an overflow and on first contact
with a conversation that already has ≥ 16 events, where it is the work that was
needed anyway.

Checks: `a burst larger than the heads ring still arrives in full, from the
beacon alone` in `src/main/transport/integration.test.ts` (45 messages, one
beacon, blanket sweep pinned shut — and a second assertion that the *next*
message after the fallback costs no scan at all, so this stays one-shot rather
than a per-poll tax), and `delivers the re-joined device's channel messages on
the beacon path` in `src/main/transport/rejoin.test.ts`.
