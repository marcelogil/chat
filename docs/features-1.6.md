# Chat 1.6 — message search in the quick switcher

Documented at the level of `docs/features-1.5.md`. The whole feature is
renderer-only: `src/shared/bridge.ts`, `src/preload/index.ts`, `src/main/**`
and the share layout are untouched. `⌘K`/`Ctrl-K` already opened a fuzzy
switcher over channel/group/team/people names (spec §2.2.2); 1.6 adds a
second kind of result underneath — a search *inside* every conversation this
client already holds, because `loadTeam()` has prefetched every channel, DM,
private group and team-pane log since 1.1 for the unread badges. Finding a
word costs no share I/O, no IPC round trip, and can only ever surface what
this device could already decrypt.

`docs/contract-changes-1.6.md` records, dated, every place the shipped code
reads the request ("the search … should return all the conversations that
include that word combination; clicking the result should take the user to
that conversation … to that moment in time") one way rather than another —
what's searchable, the matching rule, the cap. Where this document and that
one disagree, the code — and `contract-changes-1.6.md` — win.

## 1. Message search

Two new pure modules, both unit-tested, neither importing React or the DOM
(vitest is node-only):

- `src/renderer/src/search/messageSearch.ts` — folding, tokenizing, matching,
  ranking, grouping, the cap, the snippet.
- `src/renderer/src/search/jump.ts` — the `pendingJump` handshake (§2).

### What is searched, and what is not

`searchableTextOf` is deliberately not the same text a row's snippet
(`chat/util.ts`'s `snippetOf`) shows:

| body kind | indexed as |
| --- | --- |
| `text`, `code` | `body.text`, whitespace collapsed |
| `diagram` | `diagramTitleOf(body.text)` — the title, not the pre-1.2 fallback sentence |
| `poll` | `pollQuestionFor(body)` — the question, not the pre-1.3 fallback sentence |
| `gif` | nothing |
| deleted | nothing — the message is skipped while building the index, not indexed as an empty string |

The diagram and poll rows matter because `body.text` there is the sentence
written for an older client that doesn't understand the kind ("📐 Diagram:
X — **update Chat to view it**", "📊 Poll: Y — **update Chat to vote**").
Indexing that verbatim would make every diagram on the share a hit for
"update" and "chat" — the same trap `snippetOf`/`copyTextOf` already avoid.

The **author's display name** is folded into the same haystack as the body:
each typed word may be satisfied by either, so "ana deploy" finds Ana's
message about the deploy even though neither word alone is in her name plus
that message. A match on the name highlights the row's name, never the
snippet.

Not searched, and none of it was asked for: attachment file names, reactions,
link-preview text, `sys` rows, calendar entries, PR config. A message with no
words of its own — a bare GIF, a lone attachment — is still reachable by its
author's name; its row then shows a placeholder ("GIF", the file name, or "N
files") that is display-only and never itself matched.

Excluded conversations, entirely:

- **Team panes** (`isTeamConv` — the calendar, pull requests). Their logs
  carry `cal`/`prs` records that materialize elsewhere and are not chat.
- **Anything the switcher cannot name** — a **deleted channel**, or a **DM
  with a device presence has never heard of**. Both logs still sit in
  `store.events`, but a result row headed by a raw `chan:<token>`, or one
  that navigates into a conversation that's gone, is worse than no row at
  all. `convMeta` in `QuickSwitcher.tsx` is both the naming table and the
  guest list; only a conversation it can label is ever indexed.

### Matching: whole words and word prefixes, never infixes

A term matches at a position in the folded text where the preceding
character is not a word character (`\p{L}\p{N}_`). So `hel` finds "hello",
but `ello` does not — a plain substring search over a whole team's history
matches far too much to be useful.

Terms are **ANDed**: the query is split on everything that isn't a letter,
digit or underscore ("ship it!" is two terms, "c++" is one), folded, and
de-duplicated — every term has to appear somewhere in the body-plus-author
haystack for the message to be a hit.

**Folding is accent- and case-insensitive**, and is exactly the search box's
Unicode-normalize-and-lowercase, applied to both the query and the indexed
text: NFD-decompose, drop combining marks, lowercase. So "parabéns",
"Parabens" and "PARABÉNS" all match each other and all find a message that
used any of those three spellings. Because folding is not length-preserving
(a decomposed "é" becomes two code points before the mark is dropped),
`foldWithMap` folds character-by-character and carries an offset map back
into the original string — otherwise a `<mark>` could land one character off
the word it's supposed to highlight.

Two worked examples:

- Typing `parabéns` or `Parabens` finds a message that reads "Parabéns!" —
  accent- and case-folding make all three the same string before matching
  runs.
- Typing `hel` finds a message containing "hello" (start-of-word prefix
  match); typing `ello` finds nothing — an infix is never a match, however
  long it is.

### Grouping and ordering

- All hits across every indexed conversation are sorted by **event id
  descending**. Event ids are HLC stems, so lexicographic order is
  chronological order — the one ordering every client agrees on regardless
  of clock skew; `hlcMs` rides along only for display (the relative date
  label).
- The **cap is global and applies before grouping**: the newest 200 hits
  (`MAX_HITS`) survive, across the whole team, and *then* get split into
  per-conversation groups. An old, chatty channel can never push this
  morning's message off the list by sheer volume.
- Consequence, deliberate: once the cap has actually thrown something away,
  a conversation's header count is its **kept** hits for this search, not
  its true total — which is why the section note reads "showing the newest
  200" rather than a number that would otherwise be misread as "that's all
  of them." When nothing was thrown away the note just says "N found."
- Conversations appear in the order their newest kept hit fell — which falls
  out of the global sort for free, no separate conversation-ranking step.
- Three hits per conversation (`HITS_PER_CONV`) show up front; a **"N
  more…"** row follows when there are more. That row is a real
  `role="option"`, reachable by arrow keys exactly like every other row —
  pressing it expands the group in place without closing the switcher or
  moving the text cursor.

### Performance

- **Local only, no share I/O.** The whole feature is a fold over
  `store.events`, which every log already sits in from `loadTeam()`'s boot
  prefetch (needed since 1.1 for unread badges). Searching costs nothing on
  the wire and is invisible to every other client.
- **One folded index per conversation, cached on that conversation's event
  count.** `buildConvIndex` folds a whole conversation once; the cache (a
  ref inside `QuickSwitcher`) is keyed on the conversation's current event
  count, which is a sound invalidation key because an edit (`edt`) or a
  delete (`del`) is itself an appended event — the count moves exactly when
  the rendered text can. Nothing is built at all until somebody is actually
  searching.
- **150 ms debounce** (`SEARCH_DEBOUNCE_MS`) after **2 typed characters**
  (`MIN_QUERY_CHARS`) — below that the Messages section stays closed
  entirely, and rebuilding a whole team's folded index between every
  keystroke would make the box feel like a search engine instead of a box.

### Rendering

`snippetAround` returns a line of text plus match ranges, centred on the
first match with a `…` on whichever side got cut; `segmentsOf` turns ranges
into plain/marked runs; the row maps those to `<span>`/`<mark>` **React
children** — there is no `dangerouslySetInnerHTML` anywhere in this feature,
so a message containing `<img onerror=…>` renders as the literal text of a
message containing `<img onerror=…>`, never as markup.

One layout consequence: with message hits in it, the dropdown widens past
the 260 px sidebar (`min(460px, calc(100vw - 300px))`, overhanging the
conversation pane) and scrolls under a `min(62vh, 440px)` cap. Without hits
it's exactly the width it always was.

## 2. Jump to the moment

Opening a message hit doesn't scroll anything itself — the switcher's list
isn't the one that can scroll, and the target conversation's `MessageList`
might not even be mounted yet. The handoff is a new store field:

```ts
pendingJump: { conv: ConvId; id: string } | null
jumpToMessage(conv, id): Promise<void>   // set pendingJump → setActiveConv → ensureEvents
clearPendingJump(): void
```

`jumpToMessage` sets `pendingJump` **before** switching the active
conversation, so searching for a message from inside the conversation you're
already reading still triggers the jump — otherwise the conversation switch
would have been the only thing that could.

`MessageList` is the only thing that consumes it, once per render, via
`resolveJump` (`search/jump.ts`):

| state | outcome |
| --- | --- |
| nothing pending, or pending for a different conversation | `none` — leave it alone |
| this conversation and the id is among the rendered rows | `scroll` (+ clear) — `loaded` is *not* consulted (1.6.1, §7) |
| this conversation, id not rendered, `ensureEvents` hasn't resolved for it yet | `wait` — **does not clear** the request |
| this conversation, loaded, id is not among the rendered rows | `missing` (+ clear) → toast |

The `wait` case is the one worth being careful about: a log that is still
loading says nothing about whether the message exists, so `wait` must never
fall through to `missing` — otherwise the very first jump into a
conversation this client has never opened would always toast "no longer on
the share" before the log even arrived. And `wait` must not clear
`pendingJump` either, or the request would be silently dropped with nothing
to retry it once the log does land.

On `scroll`, `MessageList` highlights the row (`flashId`) and lands on it —
in 1.6.0 with a single `scrollToIndex` an animation frame later, which is
exactly what §7 replaces. The highlight is a CSS animation keyed off
`data-jump-target` (`sem-jump-flash` in `chat/util.ts`'s `CHAT_CSS`) and
lasts `JUMP_FLASH_MS` before the attribute comes off.

On `missing` — the retention case: a channel's day-bundle janitor, or a
group's grace-period sweep, has already removed the message by the time
someone finds it in search — the conversation still opens, and a toast
reads exactly **"That message is no longer on the share"**
(`JUMP_MISSING_TOAST`).

If the conversation isn't loaded yet at all (a cold `ensureEvents` still in
flight), the jump simply waits: `pendingJump` stays set, `MessageList`
re-runs `resolveJump` on every render until `loaded` flips true, and only
then resolves to `scroll` or `missing`.

`pendingJump` is cleared, along with every other team-scoped slice, on the
`boot` → `onboarding` push (a team-folder change) — a pending jump belongs
to the folder that was just left.

### The DOM contract

`MessageRow`'s root carries, only on the flashed row:

```
class="sem-row sem-jump-flash"  data-jump-target="1"  data-conv="<ConvId>"
```

`data-jump-target` is the entire highlight contract — the injected CSS
paints on the attribute and nothing else, and `scripts/e2e-drive.mjs` asserts
on it directly. `data-conv` rides on **every** row, not just the flashed
one — since only the active conversation's rows are ever mounted, it's how a
driving script proves a jump landed in the right conversation without a
`setActiveConv` read-back (there's no bridge surface for that).

## 3. Keyboard

Unchanged from the existing switcher, extended to reach the new rows:

- **⌘K / Ctrl-K** focuses the box from anywhere.
- **2+ characters**, after a **150 ms** pause, opens the Messages section
  underneath the existing channel/team/group/people rows.
- **↑ / ↓** move through one continuous list — conversation-name matches
  first, then the Messages section's header lines are skipped over (they
  aren't rows), landing on message hits and, at the end of a group's shown
  hits, its "N more…" row.
- **Enter** activates whatever's selected: opens a conversation, messages a
  person, jumps to a message hit, or expands a group's "N more…" in place
  (the switcher stays open, the selection stays put, so the next ↓ walks
  straight into what just appeared).
- **Escape** dismisses the switcher and clears the query.
- Hit rows (and the "N more…" row) activate on **`mousedown`**, not `click`,
  matching the existing rows — the input's blur would close the whole list
  before a `click` could land. Anything driving this over CDP has to dispatch
  a bubbling `mousedown`; `el.click()` does nothing.

## 4. Tests

- `src/renderer/src/search/messageSearch.test.ts` — folding and the offset
  map, tokenizing, what each `MsgBody` kind contributes (including the
  diagram/poll fallback-sentence trap and the deleted/gif no-op cases),
  whole-word/prefix matching, the AND across terms, accent-insensitivity,
  author-name matches, grouping and ordering by event id, the cap and its
  "kept vs. total" distinction, the snippet window, and that `segmentsOf`
  never produces markup.
- `src/renderer/src/search/jump.test.ts` — all four `resolveJump` outcomes
  (`none`/`wait`/`scroll`/`missing`) and `shouldClear`'s split between them.
- `scripts/e2e-drive.mjs`, in the re-join block, driving the real switcher
  input (native setter + `input` event, never React's `.value =`) on Bob's
  window:
  - **"two words from alice's first channel message find it from bob's ⌘K
    box"** — typing "hello alice" surfaces a Messages section with a hit in
    `#general`.
  - **"the hit sits under its channel header with the matched words
    marked"** — the hit carries `<mark>` elements for both words and a
    `data-search-conv` header naming "general".
  - **"↓ moves the selection through the Messages section too"** (soft) —
    arrow-key navigation reaches a message hit, not just the name rows above
    it.
  - **"bob presses the message hit"** / **"the hit opens that conversation
    and flashes the message row it pointed at"** — a synthetic `mousedown`
    on the hit lands on `#general` and produces a `[data-jump-target="1"]`
    row containing the original message text within 5 s.
  - **"a phrase only ever written in the private group finds the group"** —
    a phrase from the "Duo" group's own history surfaces a hit headed by
    that group, proving the search reaches every conversation this client
    can decrypt (and, by construction, nothing it can't).
  - **"a word nobody ever wrote shows no Messages section at all"** —
    "zzzqqq" produces no section and no hits.

## 5. Compatibility

Renderer-only, full stop: no envelope change, no new event type, no
`protocol.json` change, no new bridge surface, no new IPC handler, nothing
written to the share. The feature is a read over logs every client since 1.1
already fetches into memory for unread badges, plus a new client-local store
field (`pendingJump`) that never crosses the bridge.

An older client — anything before 1.6 — has no quick-switcher Messages
section and no jump; it is entirely unaffected by construction, since there
is nothing on the wire for it to be affected by. A 1.6 client searching
finds exactly what it could already decrypt and nothing a teammate on an
older build wrote that this device couldn't already read before 1.6 shipped.

## 6. Scoped search from the conversation header (1.6.1)

> "add a search button on the top right of channels and groups and direct
> messages to perform a more focused search."

The ⌘K box answers "where on the share was that". Standing inside a
conversation, the question is usually narrower — "where in *here* did we
decide that" — and the dropdown is the wrong shape for it: it caps each
conversation at `HITS_PER_CONV` (3) hits behind a "N more…" row, and it
closes the moment focus leaves the input. So the same search gets a second
surface, aimed at one conversation and mounted somewhere that stays open.

**Where it lives.** The right rail gains a fifth tab, `search`
(`RailTab` in `app/RightRail.tsx`), appended after Pinned, and
`app/ChannelHeader.tsx` gains a magnifier in the right-hand cluster,
immediately before the pinned-messages button. The button is the rail's
existing `onOpenTab` control, so it toggles the rail shut again when the
rail is already open on that tab — exactly like the pin. Team panes
(calendar, pull requests) never render `ChannelHeader` and have no rail, so
there is nothing to open there; their logs carry `cal`/`prs` records, not
messages, and the ⌘K search already skips them.

**One label, three places.** `searchLabelFor` (`search/convSearch.ts`) builds
`Search in #general` / `Search in Duo` / `Search in this direct message`, and
the header button's `aria-label`, the pane's input `aria-label` and the
results `listbox` all carry that same string: the button and the input it
opens are one control as far as a screen reader is concerned. A DM's label
never names the peer — the pane sits *inside* that conversation, and a label
is read out in places a name shouldn't have to follow.

**The pane** (`app/ConvSearchPane.tsx`, keyed by `conv` in the rail):

- an input that focuses itself on mount (`autoFocus` *and* an effect — a
  freshly shown panel does not reliably win the focus race), with the same
  `SEARCH_DEBOUNCE_MS` pause and `MIN_QUERY_CHARS` floor as the switcher;
- one folded `ConvIndex` for this conversation, cached on its event count
  and not built at all until somebody searches — the same cache rule
  `QuickSwitcher.tsx` uses, with the keying by `conv` doing what the
  switcher's per-conversation map does;
- **every** hit, newest first, capped only by the global `MAX_HITS` (200).
  `HITS_PER_CONV` is the dropdown's cap and has no business here: the whole
  point of the scoped search is that nothing is held back;
- a count line — "12 matches", or "Showing the newest 200 of 837" when the
  cap bites — plus the two empty states, "Type at least 2 characters" and
  "No messages match";
- rows carrying `data-conv-search-hit="1"` and `data-msg-id`, each showing
  the author's name (as signed — a device that has since left the share
  still has to have one), a relative date, and the snippet with `<mark>`
  around the matched spans, rendered as elements rather than a string of
  HTML.

**Keyboard and mouse.** ↑/↓ move the cursor (clamped, not wrapped —
`moveCursor`), Enter jumps to the selected hit, Esc empties the box and,
when it is already empty, closes the rail: the same two-step Esc the
fullscreen editor uses, so a typo never costs the whole panel. Rows activate
on **both** `mousedown` and `click` — `mousedown` so the jump lands before
focus can move off the input, `click` so anything driving the pane
synthetically still works — and the pair a real mouse sends jumps once, not
twice (the row remembers that its own `mousedown` already fired).

**The pane stays open after a jump**, query and all. Walking a result list
is the reason it exists; closing on the first hit would make the second cost
the whole query again. The jump itself is the 1.6 handshake untouched —
`store.jumpToMessage(conv, id)` sets `pendingJump`, `MessageList` resolves it
(`search/jump.ts`), the row flashes.

**Tests.** `src/renderer/src/search/convSearch.test.ts` covers the label
(including that every form starts with `Search in `), `flattenHits`
(one conversation only, newest first, no per-conversation cap, the `MAX_HITS`
slice), `countLine` (both capped shapes and the singular "1 match"), and
`moveCursor` (clamping, the empty list, and pulling a stale cursor back into
a list that shrank under it).

**Compatibility.** Renderer-only, same as the rest of 1.6: no bridge, no
main, no share I/O, no `protocol.json`. Nothing about this feature is on the
wire for an older client to see.

## 7. Landing the jump (1.6.1)

The 1.6.0 jump opened the right conversation and then, in a channel with any
real history, did not arrive: no scroll anyone could see, and no highlight.
Gil reported it on the shipped build. Three things were wrong, and all three
had to be fixed for the jump to land.

**1. The list mounts at the bottom, then tries to scroll.** `ChatPane` renders
`<MessageList key={conv}>`, so a jump into another conversation *remounts* the
list, and Virtuoso reads `initialTopMostItemIndex` exactly once, at mount.
1.6.0 always passed `items.length - 1`: the list was born at the newest
message and had to travel back up through 44 unmeasured rows. It now mounts
**at the target** —

```tsx
initialTopMostItemIndex={{ index, align: 'center' }}
```

— computed synchronously during the render that first mounts the list (a ref
latched past the early returns, because that is the only render the prop is
read on). The target index comes from `items`, not from the store's `loaded`
flag: `loadTeam()` prefetched every log at boot, so a row being *in the list*
is the proof, and `resolveJump` now answers `scroll` for a rendered row even
while `ensureEvents` is still in flight (the `wait` case is now only "not
rendered *and* not loaded").

**2. One `scrollToIndex` is never enough.** Virtuoso measures the rows it has
just been handed over several animation frames, so a scroll issued into a
list that has not finished sizing itself lands short — and the row it aimed
at keeps moving as the rows above it get their real heights. So the list now
*checks*: every frame it compares the flashed row's rect with the scroller's
(`data-virtuoso-scroller`, found from the row upwards), re-asks whenever the
row is outside, and stops only once it has been fully inside on two
consecutive frames. The judgement is pure and unit-tested in
`src/renderer/src/search/landing.ts`:

| export | what it decides |
| --- | --- |
| `isInside(rowRect, scrollerRect, tolerancePx)` | landed? (2 px of sub-pixel slack; a row taller than the viewport counts when it *covers* it) |
| `nextLandingStep(state, insideNow)` → `retry` / `done` / `give-up` | the 2-consecutive-frames rule and the 90-frame (~1.5 s at 60 Hz) budget |

`MessageList` supplies the DOM: the two rects, the frame loop, and one
`scrollToIndex({ index, align: 'center', behavior: 'auto' })` per frame that
missed. The index is **re-derived from the live `items` every retry**, never
carried from the start of the loop: a landing spans many frames, and anything
that folds into the log mid-flight (a peer's message, an edit, a delete)
shifts every index after it. The loop is cancelled by a newer jump and stops
itself once the list's root is disconnected — resetting `jumping` on the way
out, so an early return that empties the rows can never leave `followOutput`
pinned off for the life of the list. It is deliberately *not* torn down from
an effect cleanup, since clearing `pendingJump` re-runs that effect
immediately and the cleanup would cancel the landing it had just asked for;
the one mount-only cleanup there clears the *settle timer* alone, because
React.StrictMode runs that cleanup on its simulated remount and cancelling
the frame loop there would kill every dev-mode jump. Running out of budget is
silent: a jump that half-landed beats a busy loop.

**3. `followOutput` snapped the list back to the bottom.** Virtuoso's
`atBottom` is a debounced stream, and around a jump it is not settled: the
list mounts believing it is at the bottom, and the real answer arrives frames
later. While it is unsettled, **any** change to `items` — a peer's message
landing right behind the jump, an edit folding in — reads to
`followOutput="smooth"` as "new output" and scrolls to the newest row, on top
of whatever the jump just did. This is why the bug reproduced identically when
searching from *inside* the conversation being read. So following is off while
a jump is landing and for `JUMP_SETTLE_MS` (1500 ms) after it lands:

```tsx
followOutput={jumping ? false : 'smooth'}
```

and back to `'smooth'` afterwards, unchanged.

It is **not** the unread divider that changes. That row is derived from the
`anchorRead` prop, and `ChatPane` captures it once when a conversation opens
and holds it stable for as long as it stays open (`anchor.conv !== conv`),
precisely so the NEW divider doesn't chase itself — so marking read during a
session cannot drop that row, change `items.length`, or move anything.
(Earlier drafts of this document, of `landing.ts` and of `CLAUDE.md` all told
that story; it was never true of this code.)

**4. Landing on an old message marked the conversation read.** The same
unsettled `atBottom` has a second consequence, and this one is not cosmetic:
the markRead effect runs at mount with `atBottomRef` still `true`, so a
mount-at-target jump published a read cursor for the **newest** message the
instant it landed on a row 44 messages above it. The sidebar badge went to
zero for messages nobody had seen, and in a DM the peer's client rendered
"Read <time>" under a message nobody had looked at. In 1.6.0 that call was
defensible — the list really did mount at the bottom. Mount-at-target is what
made it wrong, so a landing now suppresses it:

```tsx
const mark = (): void => {
  if (jumpingRef.current || !atBottomRef.current || !document.hasFocus()) return
  useStore.getState().markRead(conv, newestId)
}
```

`jumping` is in that effect's dependency list, so the end of the settle window
re-runs it — and once the person really reaches the bottom it marks read
exactly as before. The jump-to-latest pill goes with it: `startLanding` parks
`leftAtRef` on the jumped-to id, because the `atBottom → false` transition
that follows a landing would otherwise mark it at the *newest* id, and a pill
counting messages newer than the newest never appears at all — stranding the
reader mid-history with no control back to the bottom.

**The highlight now holds.** Gil asked for "a small background color change to
highlight what we are looking for", and a 2 s fade that started on the first
frame was mostly over before the eye found the row. The row holds
`var(--accent-soft)` plus the `inset 3px var(--accent)` bar for
`JUMP_HOLD_MS` (4000 ms), then fades over `JUMP_FADE_MS` (800 ms).
`JUMP_FLASH_MS` — the React timer that drops `flashId`, and with it the
class — is `JUMP_HOLD_MS + JUMP_FADE_MS`, derived rather than typed twice, and
`CHAT_CSS` builds the `@keyframes` percentage out of the same two constants;
a row whose class is pulled mid-fade is exactly what two hand-written numbers
produce. Under `prefers-reduced-motion` there is no animation at all: the same
tint, held for `JUMP_HOLD_MS` by a `step-end` keyframe, then gone.

### What the E2E proves (`scripts/e2e-drive.mjs`, the 1.6.1 block)

A three-message channel cannot fail this way, so the block seeds one: alice
sends 45 messages to `#general`, the first being the needle ("needle xyzzy
one") and the other 44 burying it. Then, for a jump **from another
conversation** (bob sits in his DM with Alice first, so the list really
remounts) and again for a jump **from the conversation search** (bob parked at
the bottom of `#general`), it measures in the page:

- a `[data-jump-target="1"][data-conv=<#general>]` row exists within 5 s,
- its rect is fully inside its scroller's rect,
- its computed `background-color` is not fully transparent (the highlight is
  actually painted),
- and — the regression check for (3) — it is **still** fully inside two
  seconds later.
