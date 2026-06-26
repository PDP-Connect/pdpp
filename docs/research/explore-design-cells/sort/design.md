# Rich sort — design (execution-ready)

Cell: **rich sort** for Explore. Pinned tip: deploy tree `<deploy-worktree>`, tip
`36d51f49`. Companion: `sort/prior-art.md`. Run through THE-LENS Part 0 + Gates 1-4.

---

## 0. The chosen model (one line, prior-art-justified)

**Single-key sort, not stacked.** A small, labeled, **direction-baked** sort control over the record
feed — the GitHub/Linear consumer-feed pattern — where the ONLY offered keys are the ones the data
DECLARES sortable. Stacked multi-key sort (Airtable/Notion) is rejected for the feed: it is a
power-TABLE affordance, AND the PDPP read server does not implement multi-key sort (it rejects the 2nd
key with `invalid_sort`). See `prior-art.md` §"honest answer to how far" for the cite-backed verdict.

This cell makes the existing `newest`/`oldest` control **honest and complete** (today it is a
client-side reverse of the loaded window — a real defect, §2) and aligns search's relevance/recency
toggle under one consistent sort vocabulary. It does NOT add field sorts the data can't declare.

---

## 1. Re-audit BY CONTENT (verified myself @ 36d51f49)

Live Explore is `apps/console/src/app/dashboard/explore/` (NOT `components/` — the recipe's hint path
was wrong; my first grep there returned empty). Verified file:line:

| What | File:line | Reality |
|---|---|---|
| Feed sort UI | `explore-canvas.tsx:1078-1096` | `newest`/`oldest` `rr-lens` buttons; `onSetOrder`; `order: "newest"\|"oldest"` (`SortOrder`) |
| **Feed "oldest" impl** | `explore-canvas.tsx:2735-2741` | **`if (order === "oldest") list = [...list].reverse()`** — CLIENT reverse of the loaded `visibleFeed` ONLY |
| order is NOT re-queried | `page.tsx:75-77` | comment: *"Display sort order. Consumed by ExploreCanvas only — the live fetch is [not re-run]"* |
| order in URL | `explore-control-state.ts:132-135`, `explore-navigation.ts:184` | `?order=desc\|asc` for stream links; feed uses `order=newest\|oldest`; treated as **same-feed** (not feed-defining) |
| Search sort UI | `explore-canvas.tsx:1175-1196` | `Most relevant`/`Most recent`; `searchSort: "relevance"\|"recent"`; URL `search_sort=recent` (only when non-default) |
| Search sort gated by descriptor | `explore-canvas.tsx:1175` | `relevance_bounded` → no in-set toggle, only a chronological **escape link** |
| **Browse feed sort+page key (the real path)** | `reference-implementation/operations/rs-explore-timeline/index.ts:165-175` | the merged feed is a **server-side keyset merge ordered by `semantic_time` = `COALESCE(NULLIF(semantic_time,''), emitted_at)`**, and that same value IS the keyset cursor key. Contract comment: *"the authoritative display/sort key … display == sort BY CONSTRUCTION."* Display key == pagination key, server-side, single key — **no divergence on browse.** |
| Client feed re-sort (cosmetic) | `explore-data-assembler.ts:1383` | client sorts merged entries by `displayAt` DESC; `displayAt` IS the server's `semantic_time` (lines 661-699), so this is the SAME key the server paged — not an independent re-sort. |
| The `order:"desc"` per-stream fetch is the OVER-TIME data, NOT the feed | `explore-data-assembler.ts:1294-1297` | per-stream `queryRecords({ order:"desc", window:"exact" })` feeds the time-RANGE/window aggregate, not the main merged feed. (Corrected after the Codex HOLD — do not re-plumb this for feed sort.) |
| Server sort enforcement | `reference-implementation/server/records.js:928-972`, `postgres-records.js:150-174` | **only the stream's `cursor_field` is sortable**; any other field → typed `invalid_sort`; **multi-key NOT implemented** (`records.js:942`) |
| Sort param shape | `reference-contract/src/common/canonical.ts:344-359` | `sort` = sign-prefix CSV `-emitted_at,name`; "Sortable fields come from `/v1/schema`" |
| **`field_capabilities` has NO `sortable` flag** | `reference-contract/src/public/index.ts:1197-1268` | per-field caps are `type, role, exact_filter, range_filter, lexical_search, semantic_search, aggregation` — **no `sortable`** |
| `x_pdpp_role` vocab | manifests | only `primary-title`(83) `secondary`(39) `actor`(10) `amount`(8) — **all presentation roles, none is a sort declaration** |

**The defect this cell fixes (NEW finding, not in the lens's "PARTIAL" note):** "oldest" is a client
reverse of the loaded window. On a `complete_chronological` feed the loaded window is the most-recent
N (32 + accumulated). Reversing it shows *"the oldest of the recent slice,"* NOT the globally oldest
records — and Load-more keeps fetching *newer-direction* pages, so the true earliest records are never
reached in "oldest." That silently contradicts the descriptor's `exhaustive` claim. **A sort that
cannot page to the bottom of the order it claims is a count==reachability break.**

---

## 2. Canonical-state check (the highest-value step)

Sort overlaps THREE existing representations. The design defines the ONE canonical object each
normalizes into.

**Existing representations:**
1. Feed `order` (`newest`/`oldest`) → URL `order=newest|oldest`, client-reverse.
2. Search `searchSort` (`relevance`/`recent`) → URL `search_sort=recent`.
3. Per-stream list link `?order=desc|asc` (`explore-control-state.ts`).
4. Server canonical `sort=[-]<cursor_field>` (the wire truth; emitted_at-class).

**The canonical object.** There is ONE logical sort, expressed as a **direction over the set's
declared time order**, plus search's orthogonal **rank lens**. They do NOT compose into a stack; they
are two axes the descriptor gates:

- **Feed/browse + filtered-exact:** sort = **time direction** ∈ {`newest`, `oldest`}. This is the
  declared cursor-field order (`emitted_at`-class), surfaced to the owner as the semantic-time display
  order. Canonical URL param: **`order=newest|oldest`** (keep the existing name; `newest` is default
  and OMITTED from the URL).
- **Search (keyword_pageable):** sort = **rank lens** ∈ {`relevance`, `recent`}. Canonical URL param:
  **`search_sort=relevance|recent`** (`relevance` default, omitted). `recent` IS time-direction-newest
  applied to the lexical candidate set (server `order=recent` = emitted_at DESC).
- **Search (relevance_bounded):** sort is **structurally absent** — a ranked bounded sample has no
  honest in-set re-order; the only door is the chronological **escape** (already built).

**Normalization rule (single source of truth):** `order` and `search_sort` are the canonical params;
everything else lifts INTO them. The per-stream `?order=desc|asc` link is the same axis expressed in
wire vocabulary (`desc`≡`newest`, `asc`≡`oldest`) — `buildCompleteStreamHref` already maps
`newest→desc`/`oldest→asc` (`explore-canvas.tsx:241-243`); keep that as the single mapping. We do NOT
introduce a second sort param, a `sort=` field selector, or a sort-stack array. **One axis per set-kind,
one param each, no redundant representation** (Part-0 trap: "same thing two ways").

**Direction must become real, not a client reverse.** `order=oldest` is re-plumbed to the **merged
timeline endpoint** (`rs-explore-timeline`), NOT the per-stream records path: the keyset merge walks
the `semantic_time` order ASCENDING (from the true earliest record forward), with the point-in-time
snapshot bound preserved. Because the timeline's display key == cursor key == `semantic_time` BY
CONSTRUCTION (`rs-explore-timeline/index.ts:165-175`), reversing the direction is a single, honest
flip: display and pagination stay identical in ascending order too — there is no second key to drift.
The Load-more trail then pages forward in time so "oldest" reaches the present from the earliest.
`order` thus becomes a **feed-defining** navigation (resets the cursor trail to page 1, like
query/range), NOT a same-feed display toggle (`explore-navigation.ts:184`+`:267` must move `order`
out of the same-feed branch — verified those are where the same-feed treatment lives).

*(Execution note: the ascending direction must respect the existing past/future `nowCeiling` split —
`rs-explore-timeline` clamps future-dated records out of the main feed. "Oldest" pages ascending from
the earliest PAST record up to the ceiling; it does not surface the future partition into the main
feed. The ASC keyset primitive already exists: the Upcoming/future projection does a forward-
chronological ASC walk to exhaustion over the same `snapshotSeq`+pinned-`nowCeiling` machinery
(`rs-explore-timeline/index.ts:541-550`). "Oldest" reuses that ASC primitive over the PAST partition.
This preserves the existing semantic-time past/future contract; it does not redesign it.)*

*(Implementation-existence proof — checked after the round-3 Codex grep miss: `rs-explore-timeline` IS
the live browse feed and exists on disk — `reference-implementation/operations/rs-explore-timeline/
index.ts` (51KB), `reference-implementation/server/explore-timeline-substrate.ts`, conformance +
regression tests; the assembler treats it as the single source of truth for the recent lens
(`explore-data-assembler.ts:1011`, `:2080-2081`) and renders `rec.semantic_time` as the row timestamp
(`:659-666`). The DataSource exposes a dedicated merged-timeline method, not just `queryRecords`
(`data-source.ts:68`). The browse "display == sort by construction" foundation is implemented, not
aspirational.)*

---

## 3. Honesty semantics (Gate 1 — the hard invariants, in full)

1. **Declared-field-only sort (the cardinal constraint).** A sort key may ONLY be a field the server
   advertises as sortable. Today that is exactly the stream's **declared `cursor_field`** (a time
   field) — enforced server-side (`records.js:960`, `postgres-records.js:162`). Therefore the ONLY
   field-level sort the UI may offer is **time direction**. There is NO "sort by amount / name / sender"
   option, because no connector DECLARES those sortable. `x_pdpp_role: amount` is a **presentation
   role**, not a sort capability (verified: `field_capabilities` has no `sortable` flag) — using it to
   add a money-sort would be name/role-guessing, the cardinal sin (THE-LENS Gate 1). **If, in future, a
   `field_capabilities[].sortable` flag is added, the sort menu MAY surface those declared fields — and
   only those. The UI reads the declaration; it never reads a field name.**

2. **Sort never changes membership (NN/g; count==reachability).** Changing `order` or `search_sort`
   reorders the SAME set. The descriptor's count, the facet counts, and the reachable record identities
   are invariant under sort. `order` resets the *cursor* (re-pages from the new direction's start) but
   the *set* is identical — Load-more in either direction reaches every record. No sort option may
   shrink/grow a count.

3. **A sort claim never exceeds the descriptor (legal-sort-per-kind matrix).** The control is gated by
   `descriptor.kind`, reusing the existing `descriptorIsTimeOrdered` guard:

   | Descriptor kind | Legal sort surface | Why |
   |---|---|---|
   | `complete_chronological` (browse) | `newest`/`oldest` time direction | `ordering:time, exhaustive`, pages to the end both ways; display key == cursor key (`semantic_time`) by construction |
   | `filtered_exact`, single stream, `cursor_field==consent_time_field` | `newest`/`oldest` time direction | server page key == displayed `semantic_time`; honest sort |
   | `filtered_exact`, single stream, `cursor_field≠consent_time_field` | **NO visible-time sort** — route chronological intent to per-stream merged timeline | server pages by `cursor_field` but displays `semantic_time`; a visible-time sort claim would be unhonorable (§3.5) |
   | `filtered_exact`, multi-stream merged | inherits browse: `newest`/`oldest` via the timeline keyset | the merged surface IS `semantic_time`-keyset-ordered; display == sort |
   | `keyword_pageable` (search, pageable) | `relevance`/`recent` lens | pages to the end; `recent`=time-newest honest |
   | `relevance_bounded` (ranked sample) | **NONE in-set** — escape link only | `bounded_sample`, no sound deep pagination; cannot claim any complete ordering |

   The matrix is enforced by a **switch on `descriptor.kind`**, mirroring `feedHeaderLabel`. A new
   pure helper `legalSortOptions(descriptor)` returns the allowed surface; the canvas renders only what
   it returns. An unrepresentable claim is structurally impossible (same pattern as the existing
   contract), not a runtime check to forget.

4. **Oldest is genuinely oldest (the §1 fix).** "Oldest" must page from the true earliest record, via a
   server ascending query over the cursor field — never a client `.reverse()` of the loaded window. The
   `oldest` label is only shown on descriptors that can page ascending to the present
   (`complete_chronological`, `filtered_exact`); it is never shown on a bounded sample.

5. **Display key == pagination key, per surface (the Codex-HOLD fix — the load-more invariant).** A
   sort that claims "newest/oldest first" is a LIE if the timestamp the owner SEES is a different field
   than the one the server PAGED by — because then a later-displayed record can land on page 2 below an
   earlier-displayed record on page 1 (a row "stuck at the bottom," Gate 2). The rule, made structural
   per surface:
   - **Browse feed (`complete_chronological`):** display key == cursor key == **`semantic_time`** BY
     CONSTRUCTION, server-side (`rs-explore-timeline/index.ts:165-175`:
     `COALESCE(NULLIF(semantic_time,''), emitted_at)` is *both* the display timestamp the client renders
     AND the keyset cursor key). There is **no divergence**: "newest/oldest first" is monotone across
     every page boundary, in both directions. The client must keep rendering exactly this server value
     as the row timestamp (it already does — `displayAt` = `semantic_time`); it must NOT substitute a
     re-derived `consent_time_field` that the server did not page by.
   - **Filtered single-stream (`filtered_exact`):** the server pages this surface by the stream's
     declared **`cursor_field`** (e.g. chatgpt/anthropic `update_time`), but the **canonical row
     timestamp shown everywhere** is `semantic_time`/`displayAt` (consent-first:
     `postgres-records.js:355-360`, `search-record-timestamps.ts:70`). Measured magnitude: **19 of 108
     time-bearing streams (18%) diverge** `cursor_field`≠`consent_time_field` — and they are high-value
     (chatgpt/anthropic conversations, github issues/PRs/repos, gmail threads, notion pages). So the
     naive fix "show cursor-field time on the sorted list" is WRONG: it would make the SAME record show
     `create_time` in Browse but `update_time` in the filtered list — a Part-0 "same record looks
     different in two places" violation (the second-order bug Codex caught in round 2).
     **The honest resolution keeps ONE canonical timestamp per record (always `semantic_time`/
     `displayAt`) AND requires sort-key == displayed-key on any surface that CLAIMS a time sort:**
     - When `cursor_field == consent_time_field` (**89/108 streams**): the server's page key equals the
       canonical display key → a single-stream "newest/oldest first" list is honest. Offer `newest`/
       `oldest`.
     - When `cursor_field ≠ consent_time_field` (**19/108**): the server cannot page the single-stream
       list by the displayed `semantic_time`, so that surface MUST NOT claim a "newest/oldest first"
       ordering of the visible time. The honest, **existing-machinery** move is to route the owner's
       "browse this stream chronologically" intent to the **merged timeline scoped to that one
       connection+stream** — which IS server-keyset-ordered by `semantic_time` (== the displayed key),
       reaches the end, and shows the SAME canonical timestamp. **This scoping is a real, shipped
       capability, not an invented door:** `rs-explore-timeline` takes `ExploreTimelineInput.connectionIds`
       and `streams` positive scopes (`reference-implementation/operations/rs-explore-timeline/index.ts:
       260-263`: *"Optional stream-name scope. Empty/omitted means every visible stream"*) — exactly the
       per-stream timeline this route needs. (Same escape-door pattern the search header already uses:
       a descriptor that can't honor an in-set claim hands off to one that can.)
     This is decided by a DECLARED comparison (`cursor_field` vs `consent_time_field` from the
     manifest) — zero field-name guessing.
   - **Search `keyword_pageable` ordering=time (`recent`):** server `order=recent` = `emitted_at` DESC
     within the lexical candidate set, and the rendered hit time is `emitted_at`-derived — display ==
     sort. ✓
   The owner-facing label stays the meaningful **"newest/oldest"**; we never expose `emitted_at`/
   `semantic_time`/`cursor_field` as machine words. We never claim a global total order over a key the
   cursor can't guarantee — each surface's claim is exactly the key it both shows and pages by.

6. **Mono discipline (Gate 1 typography).** Sort labels are sans prose (`newest`, `oldest`, `Most
   relevant`, `Most recent`) — never mono, never `-emitted_at` wire syntax shown to the owner. The wire
   `sort=`/`order=` vocabulary stays internal.

7. **URL reflects state.** `order` (non-default) and `search_sort` (non-default) appear in the URL;
   defaults are omitted so the canonical default view stays a clean shareable URL. Reload reconstructs
   the exact sort. (The bare-default-view URL bug is a separate cell; sort just must not regress it.)

---

## 4. Exact UI + states

**Placement.** Keep the existing inline sort control (`explore-canvas.tsx:1078`, the `rr-x-sort`
cluster in `.rr-x-searchrow__controls`) — prior art (GitHub sort dropdown, Linear inline ordering)
puts sort beside the list, low-prominence. No new toolbar row; the SLVP single-command-bar recomposition
is preserved.

**Browse / filtered-exact (descriptor time-ordered):**
- Render: `sort` label + two `rr-lens` segmented buttons `newest` (default, `is-on`) / `oldest`.
- `aria-pressed` reflects the active direction (already present, lines 1081/1090).
- Click `oldest` → feed-defining nav: `buildHref({ ...current, order: "oldest" })`, cursor trail reset,
  server re-fetches ascending, feed re-renders from the earliest record; Load-more pages forward in time.
- Click `newest` → back to default (param omitted).
- While the transition is pending, the existing top progress bar + feed dim apply (`isPending`); the
  sort buttons are not individually spun (only Load-more spins, per the loading-states cell).

**Search, keyword_pageable:**
- Render the existing `Most relevant` / `Most recent` segmented pair (lines 1180-1195). `recent` is the
  time lens; selecting it sets `search_sort=recent`, resets the search cursor, pages newest-first.

**Search, relevance_bounded:**
- No in-set sort. Render only the existing chronological escape:
  `Browse matching records, newest first` (line 1176) — which navigates to the keyword_pageable/
  complete door where `oldest`/`newest` then become legal. (Unchanged.)

**Empty / no-time-field streams:** streams without a declared time field are already excluded from the
merged timeline (`explorer-utils.ts:652`). So the feed never contains a record with no sort key — the
Airtable "asc-blanks-first" anti-pattern cannot arise on the browse feed. (For a future
`filtered_exact` single-stream view whose cursor field is sparse, the server's `sortPosition` already
defines a deterministic missing-bucket position — `records.js:1269` — so blanks have a defined, not
silent, position.)

**Mobile (390px):** the sort cluster already shares the compact controls sub-row (`:1069-1072`); two
segmented buttons fit. No change to chrome-row budget.

---

## 5. Executable test matrix

Pure helpers are unit-testable without rendering (the repo pattern: `explore-*.test.ts`). New helper
`legalSortOptions(descriptor)` lives next to `set-descriptor.ts`; navigation/membership covered in
`explore-navigation.test.ts` / `explore-acceptance.test.ts`.

| # | Case | Assertion |
|---|---|---|
| T1 | legal-sort-per-descriptor: `complete_chronological` | `legalSortOptions` = `{axis:"time", options:["newest","oldest"]}` |
| T2 | legal-sort-per-descriptor: `filtered_exact` | = `{axis:"time", options:["newest","oldest"]}` |
| T3 | legal-sort-per-descriptor: `keyword_pageable` | = `{axis:"rank", options:["relevance","recent"]}` |
| T4 | legal-sort-per-descriptor: `relevance_bounded` | = `{axis:"none"}` (escape only); no `newest`/`oldest`/in-set toggle rendered |
| T5 | declared-field-only | the only field-level sort key resolves to the stream cursor field; no option references `amount`/`name`/any `x_pdpp_role`; assert the rendered sort surface contains zero field-name strings |
| T6 | declared-field-only negative control | a synthetic descriptor/manifest with `x_pdpp_role:amount` but no `sortable` cursor change does NOT produce an "amount" sort option |
| T7 | URL roundtrip newest (default) | `buildHref({order:"newest"})` omits `order`; parse of `/dashboard/explore` yields `order:"newest"` |
| T8 | URL roundtrip oldest | `buildHref({order:"oldest"})` sets `order=oldest`; parse yields `order:"oldest"`; reload reconstructs |
| T9 | URL roundtrip search_sort | `recent` sets `search_sort=recent`; `relevance` omits it |
| T10 | order is feed-defining | `isFeedDefiningNavigation({order})` is TRUE → cursor trail resets (assert `order` moved out of the same-feed branch; `cursors` omitted) |
| T11 | membership-unchanged under sort | flipping `order` newest↔oldest leaves descriptor `total`/feed identity set invariant (same record id set reachable); only sequence differs |
| T12 | oldest pages ascending (the §1 fix) | the per-stream fetch sends `order:"asc"` when `order==="oldest"` (assert assembler passes ascending, not a client reverse); first page contains the earliest record, not the reverse of the recent window |
| T13 | oldest never on bounded sample | for `relevance_bounded`, no `oldest` control is reachable (covered by T4 + a render guard) |
| T14 | mono discipline | sort labels carry no mono class and no `-emitted_at`/wire token (static source-regex test) |
| T15 | reverse-removed | the client `[...list].reverse()` at `explore-canvas.tsx:2737-2738` is gone (source-regex forbids it on the browse path) |
| T16 | **browse display==sort (no divergence)** | the browse-feed row timestamp the client renders equals the server's `semantic_time` (the keyset cursor key); a fixture with `semantic_time≠emitted_at` shows `semantic_time`, and the merged order is monotone in `semantic_time` across a simulated page boundary (no later-displayed row below an earlier one) |
| T17 | **oldest pages ascending on the timeline endpoint** | `order==="oldest"` drives the `rs-explore-timeline` keyset merge ASCENDING by `semantic_time` from the earliest past record (assert the endpoint/assembler requests ascending; NOT the per-stream records path, NOT a client reverse); future-partition records do not leak into the main feed |
| T18a | **canonical timestamp is invariant across surfaces** | a record with `cursor_field`≠`consent_time_field` (e.g. chatgpt conversation) renders the SAME `semantic_time`/`displayAt` (consent-first) row timestamp in BOTH the browse feed AND any single-stream list — never cursor-field time in one and consent-field time in the other (no "same record, two timestamps") |
| T18b | **divergent single-stream list does not claim a contradicted time sort** | for a stream where `cursor_field`≠`consent_time_field`, the single-stream `filtered_exact` list does NOT render a `newest`/`oldest`-by-visible-time control; the chronological intent routes to the per-stream merged timeline (keyset-ordered by `semantic_time`). Decided by the DECLARED cursor-vs-consent comparison, not a field name |
| T18c | **non-divergent single-stream list may claim the sort** | for a stream where `cursor_field == consent_time_field`, the single-stream list MAY offer `newest`/`oldest` (server page key == displayed key) |

Acceptance (forbidden strings, repo scanner pattern): the sort surface must not contain a field-name
selector, a multi-key "add sort" affordance, or a `sort=<field>,<field>` shape. The browse path must
not contain a `.reverse()` display hack.

---

## 6. Self-critique vs THE-LENS

**Part 0 (Regret Check):**
- *"What problem, why best solution?"* — Problem: sort is shallow AND "oldest" silently lies (client
  reverse can't reach the true earliest). Solution: single-key direction sort that the server genuinely
  pages, prior-art-justified (GitHub/Linear single-key is the consumer-feed norm; Airtable/Notion
  stacked is power-table-only AND unsupported by the read server). Defensible.
- *"Same thing two ways?"* — Caught and resolved in §2: `order` and `search_sort` are the canonical
  params; per-stream `?order=desc|asc` lifts into the same axis via one existing mapping; no new param.
- *"Control that's broken/useless?"* — The current "oldest" is exactly that (looks like sort, can't
  reach the bottom). This cell fixes it. We refuse to add a stacked-sort UI that would `invalid_sort`.
- *"Meaning guessed from names?"* — Explicitly banned (§3.1): no field-name/role-guessed sort; only the
  declared cursor field. Negative-control test T6.
- *"Verified by living in it?"* — This is a DESIGN cell; execution must include a live desktop+mobile
  walk + a side-by-side vs the GitHub/Linear product-UI shots before "done." Stated, not claimed done.

**Gates:** Gate 1 honesty — all 7 semantics above; declared-only + membership-invariant + descriptor-
gated + **display-key==pagination-key per surface** (§3.5). Gate 2 workbench — "rich sorting … correct
under a filter across load-more" satisfied (order is feed-defining, pages correctly under filters, no
row stuck at the bottom because display==sort). Gate 3 — sort composes with all 4 modes via the matrix.
Gate 4 — inline low-prominence sort matches GitHub/Linear; sans labels; no new toolbar row.

**Adversarial-review trail (Codex gpt-5.5, high effort):** first pass HOLD — caught that my original
§3.5 hand-waved a display-key (`displayAt`/semantic) vs pagination-key (`emitted_at`/cursor) divergence
as a <5% residual when it is a load-more correctness break. Investigating the actual merged-feed path
(`rs-explore-timeline`, NOT the per-stream records path I'd mis-cited) showed the browse feed already
pages by `semantic_time` == its display key BY CONSTRUCTION, so browse has no divergence; the real
exposure is the `filtered_exact` single-stream list where `cursor_field`≠`consent_time_field`. §3.5 +
T16/T17/T18 now make display==sort a per-surface structural invariant. **Round 2 HOLD:** Codex caught
that my first fix (render `cursor_field`-time on the divergent filtered list) traded the load-more bug
for a "same record shows two timestamps in two surfaces" Part-0 bug — measured 19/108 streams (18%)
diverge `cursor_field`≠`consent_time_field`. Final §3.5 keeps ONE canonical timestamp (`semantic_time`)
everywhere and instead GATES the visible-time sort off the divergent single-stream surface (routing its
chronological intent to the `semantic_time`-keyset per-stream timeline). T18 split into T18a/b/c. Two
HOLDs, each making the honesty model strictly more correct — the recipe working as intended.

---

## 7. Bounded residual (<5%, does NOT touch correctness)

- **Exact label wording** of the browse sort (`newest`/`oldest` lowercase chips vs `Newest`/`Oldest`).
  Keep current lowercase to match the prototype's quiet style; trivially adjustable, no honesty impact.
- **Whether `oldest` shows a one-line affordance hint** ("oldest first — pages from your earliest
  record") on first use. Nice-to-have microcopy; omitting it changes nothing about correctness.
- **Future `field_capabilities[].sortable`**: if/when the contract adds a per-field sortable flag, the
  menu MAY surface those declared fields (still declaration-driven, never name-guessed). Designing that
  surface is out of scope until the flag exists — flagged for the protocol team, not this cell.

None of these alter the legal-sort-per-descriptor matrix, the declared-field-only constraint, the
membership invariant, or the oldest-pages-ascending fix.

## DEFINITION OF DONE — pixel gate (mandatory, not the merge)
DONE only when the built sort control is captured live and matches the SLVP single-key norm in:
- `../../slvp-benchmark-2026-06-23/shots/vercel-changelog-deployments-list-desktop.png` and
  `../../slvp-benchmark-2026-06-23/shots/linear-docs-filters-desktop.png` — a quiet single-key sort, no
  spreadsheet multi-key UI; active sort legible. Confirm the control reads as restrained, not a power-
  table affordance. The owner confirms the side-by-side; behavior tests are necessary but not the feel gate.
