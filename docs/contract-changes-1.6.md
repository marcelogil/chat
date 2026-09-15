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
| this conv, `eventsLoaded` still false | `wait` — **do not clear** |
| this conv, loaded, id in the rendered rows | `scroll` (+ clear) |
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
`JUMP_FLASH_MS` = 2 s and then the attribute is removed; the scroll is
`scrollToIndex({ align: 'center' })` one animation frame after the rows are
handed to virtuoso, because scrolling into a list that has not laid out yet
lands short.

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
