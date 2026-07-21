# Design — Explore RecordSet, unified query, manifest-authored presentation

Grounded in prior-art research on explore query/filter IA, feed interaction
dynamics, future-dated records, now-boundary pinning, and timeline legibility and
stability. Every design choice cites a prior-art exemplar; PDPP-specific inventions
are flagged. The auditable interaction-by-interaction mapping records, for each
choice, the observed pattern → source → PDPP translation → anti-pattern →
acceptance check.

## 1. RecordSet — the central abstraction

A **RecordSet** is any named collection the UI shows or counts. Every count, pill, day
group, burst group, source/stream facet, search pool, Upcoming (future) subset, "open
all", and copied link IS a RecordSet. A RecordSet declares:

- **identity** — a stable handle (URL query + cursor) that reproduces exactly this set.
- **scope** — the predicate: `{ sources[], streams[], dateRange, temporal: past|future|
  all, query, fieldFilters[], group?: {connection,stream,day} }`.
- **ordering** — `relevance | semantic_time_desc | semantic_time_asc | <field>`.
- **count** — one of: `exact` (server-computed true total), `lower_bound` (≥ N, more
  exist but counting is costly), `not_counted` (set exists, count not computed),
  `hidden` (a count would mislead → show none). NEVER a loaded-window size dressed as a
  total.
- **reachability** — how the owner reaches EVERY member: `inline` (all members are
  loaded/expandable in place), `paginate` (a load-more walks it to exhaustion in place),
  `drill_in` (a navigation to an identically-scoped, fully-paginated view), or
  `disabled{reason}` (genuinely unreachable, stated honestly).

**The invariant (normative): count == reachability.** If a RecordSet shows a count, that
exact count MUST be reachable through its declared reachability handle. A count that
cannot be made reachable MUST be `hidden`, never faked, and the count is NEVER shrunk to
match a smaller reachable window (the forbidden "188 → 32" resolution; owner-confirmed).

**`lower_bound` discipline (normative, per the independent reviewer P0).** Default owner-facing numeric totals
— count chips, group totals, burst totals, facet numbers, the Upcoming pill — render ONLY
from a RecordSet whose `count` is `exact`. A `lower_bound` MUST NOT be rendered as a plain
numeric total, MUST NOT produce an "Open all N" action, and MUST NOT be silently shrunk
into the loaded-window count. A `lower_bound` MAY appear ONLY as explicitly-qualified
diagnostic text where the limitation is impossible to miss (e.g. "1,000+ indexed
candidates" on a bounded search diagnostic) — never as a group/facet total. This keeps
"showing at least N" from reading as a promise the UI can't keep.

Prior art: Stripe refuses to show a total it can't cheaply guarantee reaching (no
default list total; search total accurate only to 10,000) and carries filter state in
the URL so a count is a handle to its exact set
(https://docs.stripe.com/dashboard/search). Linear shows a true per-group total tied to
full membership (https://linear.app/docs/filters). Google Photos Stacks is the named
anti-pattern — a group "promising completeness it does not deliver" (the legibility
research). Datadog facet counts = count in the current filtered scope, updated as filters
change (https://docs.datadoghq.com/logs/explorer/facets/).

**This is the abstraction whose absence let "188 but only 32" happen.** It generalizes:
the same latent bug lives in day counts, burst counts, facet numbers, and search-pool
sizes; RecordSet makes the invariant checkable everywhere.

### 1.1 Server/client boundary (per the independent reviewer P0 — keep the contract from bloating)

The reference read surface (`GET /_ref/explore/records`) is the source of truth for exact
membership, `count`, and reachability of the **server-owned** RecordSets: the main merged-
timeline feed, the Upcoming projection, the search result set, any scoped drill-in, AND any
group whose true count/reachability cannot be derived from the loaded window (the burst
case). For such a group the server returns a MINIMAL descriptor — exact count + a drill-in/
pagination handle — and does NOT dictate the full visual grouping state. The **client** may
derive from the loaded records ONLY presentation grouping that asserts no count beyond the
loaded window: the visible day grouping, local burst presentation, and expanded/collapsed
state. This keeps the contract carrying truth (counts/reachability) without coupling it to
every UI grouping choice.

### 1.2 Search-result-set classes (per the independent reviewer P0 — pins lexical honesty)

Every result RecordSet is one of three classes; the class drives how it may be counted and
presented (full matrix: `design-notes/prior-art-interaction-matrix.md`):

- **`relevance_bounded`** — a semantic/top-match candidate pool, NOT an exhaustive set of
  all conceptual matches. It MUST NOT render as an exhaustive "all matches" set, MUST NOT
  expose a "sort newest" affordance implying completeness, and MUST NOT advertise an exact
  total of all matches (`lower_bound` at most, qualified per §1).
- **`keyword_pageable`** — an exhaustive lexical/filter set walkable to exhaustion via
  cursor; `exact` count is provable and fully reachable.
- **chronological browse** — the time-ordered corpus under a scope, no relevance promise,
  fully paginated (the deployed merged-timeline, cursor v4).

When the owner asks for ALL records matching a keyword/filter, the UI creates or navigates
to a `keyword_pageable` (exhaustive) set, OR states the exact set is unavailable — it never
substitutes a `relevance_bounded` pool dressed as the exhaustive set. This is the hard
honesty seam from the lexical/search work, now pinned so implementation can't regress to
"sort the semantic pool by recency."

## 2. Scope-preserving drill-in (the P0 the independent reviewer flagged)

"Open all N in <stream>" is NOT reachability unless the destination is scoped IDENTICALLY
to the RecordSet that showed N. The drill-in MUST carry the full scope (sources, streams,
date range, future/past, query, field filters) so the landed set's size is N. The
existing per-stream records page is the drill-in TARGET, but the current link drops the
future/day/search/source scope — that recreates 188→32 in another route. Fix: the drill-in
URL carries the RecordSet's scope (Stripe's URL-state pattern). For the Upcoming case
specifically, the drill-in must preserve `temporal: future` (and the day, if drilling a
day's burst), landing in a future-scoped paginated view, NOT the whole stream.

PDPP-SPECIFIC NOTE (flagged): PDPP's per-stream records page may not today accept a
`temporal: future`/date-range filter that matches the merged-timeline's semantic-time
clamp. If it cannot, the design's reachability handle for Upcoming is `paginate` (give
the Upcoming section its own load-more to exhaustion) rather than `drill_in`, until the
stream page accepts the scope. EITHER satisfies count==reachability; the choice is a
build-time decision recorded in tasks, not a silent capped head.

## 3. The collapse / expand / load-more state machine (one model)

Three nesting levels (section › day › burst) plus load-more, designed as one machine:

- **Day grouping** — records group by their semantic day (already shipped). Always on.
- **Burst collapse** — a single (connection, stream) within a day at/above the burst
  threshold collapses to ONE burst row showing its TRUE count (a RecordSet with
  `count: exact`), not the loaded count. Below threshold → individual rows.
- **Burst reachability** — if all the burst's members are loaded, "show all" = `inline`
  expand. If the true count exceeds what's loaded (a capped head), the action is "Open
  all N →" = `drill_in` to the identically-scoped paginated view (Stripe ≤10 inline /
  >10 paginated-endpoint; Google Photos Stacks inline but hard-capped at 100). The burst
  NEVER shows "show all" over a subset it can't complete.
- **Load-more (main feed)** — merges newly-loaded older records IN PLACE: they fill
  existing day groups or prepend new ones; a day shown as singles that crosses the burst
  threshold collapses into a burst IN PLACE ("collapse down, not up"); rows already shown
  never reorder or displace. Prior art: react-virtuoso GroupedVirtuoso mutates
  `groupCounts` in place, adjusting firstItemIndex by the new-item count
  (https://virtuoso.dev/react-virtuoso/api-reference/grouped-virtuoso/). Owner phrasing:
  "load more can collapse rows down not up across multiple streams."
- **Upcoming section** — its OWN surface beneath/above-today, day-sectioned soonest-first,
  with its OWN reachability (a load-more to exhaustion OR a scope-preserving drill-in per
  §2) so its pill count (true total) is fully reachable. Future records live ONLY here
  (mutually exclusive with the main feed, already guaranteed by the server's pinned-now
  clamp). Prior art: Things 3 (day-sections, mutually-exclusive lists), Todoist
  (Upcoming is its own surface, week-paged) — the future section is NOT the main feed's
  burst+cap.
- **Expand-state persistence** — keyed by stable group id (`${connectionId}::${stream}`
  / day), NOT by index, so expansions survive load-more.

## 4. Unified query model

ONE query surface (Gmail is the exemplar: https://9to5google.com/2020/02/19/gmail-search-chips/,
https://support.google.com/mail/answer/7190):

- **One input** — free-text + filter chips + an id-jump, not the current two inputs.
  A pasted exact record id is detected and offered as "jump to record" (command-palette
  style), not a second box. (resolves feedback #4)
- **Filter chips** — common filters (source, stream, `has:image`, date) are
  recognition-over-recall chips with typeahead; a chip is the same as the operator behind
  it (`has:attachment` chip == `has:attachment`). Novice clicks; power user types the
  same query. Operators stay as the power accelerator, never the only path. (resolves #5)
- **Facets == query** — source/stream facets are part of the ONE query state (Datadog:
  facet selections reflect in the query + URL). No parallel "do my checkboxes AND my
  query both apply?" ambiguity. (resolves #10)
- **Invert** — a chip toggle ("is not" — Linear) and `-` syntax (Gmail/Stripe), plus a
  form-style "doesn't have" affordance (Gmail). Source/stream selections are invertible.
  (resolves #9)
- **Facet counts** — a number next to a facet means "count in the current filtered set"
  (a RecordSet with `count: exact`); if PDPP can't compute it exactly, it's `hidden`.
  (resolves #8)
- **Keyboard** — Enter submits (feedback #1); typeahead/escape; Cmd-K for jump.
- **Mobile** — chips survive on mobile (Gmail); the facet/advanced panel is a filter
  button → bottom sheet. (addresses #2 loading position + mobile parity)

## 5. Manifest-authored record presentation (workstream D)

### 5.1 The state today (traced)
Card KIND prefers the manifest's declared `x_pdpp_type` (→ `field_capabilities[].type`)
and falls back to stream-name + field-name heuristics; per-field ROLE (which `text`
field is the title vs body) is chosen by HARDCODED field-name lists EVEN on the declared
path. The declared-type path is shipped+tested+green (openspec archives
`complete-explorer-slvp-ideal` + `add-explorer-live-presentation-types`) but DORMANT (no
first-party manifest declares types). Manifests already carry stream-level `display.label`
/`display.detail` (spec-core.md:806-809, connector-authored, client-MUST-NOT-override)
and `views` (named field sets).

### 5.2 Type ≠ Role (the precise gap)
`x_pdpp_type` says a field is `text`/`currency`/`timestamp`/`person` — its TYPE. It does
NOT say whether a `text` field is the title, the body, an actor's display name, a note,
or raw payload — its ROLE. Two text fields where one is the title and one is the body
need ROLE, not just type. Prior art: Airtable's primary field IS the declared title role
(distinct from its type), and interface layouts declare title + up to 2 preview roles
(https://support.airtable.com/docs/the-primary-field); Notion's schema requires exactly
one title property (https://developers.notion.com/reference/property-object); schema.org
declares `name`(title)/`description`(body) and exactly one `mainEntity`; JSON Schema
`title`/`description` are display annotations. Roles are DECLARED, never inferred.

**The two axes, stated precisely (per the independent reviewer P0 — this is the arbitrary-connector contract):**

- **TYPE (data class)** — what the value IS: `timestamp | currency | text | person |
  media/blob | url | geo` (today's `x_pdpp_type` → `field_capabilities[].type`). TYPE drives
  typed affordances (a timestamp renders as a `<Timestamp>`, a currency formats money).
- **ROLE (presentation slot)** — what card slot the field FILLS: `primary-title |
  secondary/body | event-time | actor | amount`.
  ROLE is declared by the manifest (§5.3), never inferred from a field/stream name.

Resolution rules:
- **TYPE ≠ ROLE.** The same TYPE may carry different ROLEs (a `text` field may be the
  primary-title OR the body). A renderer MUST NOT promote a field to a role because of its
  type; with no declared role it goes to the generic key/value table.
- **Multi-role.** A field MAY hold more than one role where the manifest declares it (e.g. a
  title that is also the link target). Conflicts (two fields both declared primary-title)
  resolve to the manifest's declared order; if undeclared, neither is promoted.
- **Paired fields.** `amount`+`currency`, media-blob+alt/title, actor-id+actor-name render
  as ONE composed affordance per the manifest's declared pairing — never as two loose cells.
- **Labels.** Display labels are the manifest's declared field labels where present;
  mechanical key-formatting (humanizing a raw key) is a LABEL fallback only and MUST NOT be
  read as evidence of a field's type, role, or semantics.

### 5.3 Alternatives for declaring ROLE (decision in tasks, not pre-judged)
The minimal role/slot vocabulary: `primary-title`, `secondary/body`, `event-time`, `actor`,
`amount`. Every slot is filled by DECLARATION (or a
declared pairing), NOT by type: TYPE only gates formatting (a timestamp renders as a clock,
a currency formats money) — it never promotes a field into the event-time or amount slot.
A record with several timestamps (created/updated/scheduled) has no event-time slot, and a
record with subtotal/tax/total/refund has no amount slot, until the manifest declares which
field fills it. The one pre-wired mapping the design relies on is the existing semantic-time
manifest binding that already feeds the merged timeline's event-time; any OTHER event-time
or amount slot is a declaration/pairing, never a bare-type promotion. Three options for
expressing the declaration, evaluated before any new vocabulary is added (per the independent reviewer):
- **A. Reuse existing surfaces.** Use `display`/`views` + `field_capabilities[].type`:
  e.g. interpret the first `views[]` entry or a designated view as the card's field set,
  and the `primary_key`/a `text`+`primary`-typed field as the title. Pro: zero new
  vocabulary. Con: `display.detail` is prose (consent-oriented), `views` are matching
  sets not presentation roles, and no existing surface says "this field is the title vs
  the body" — likely insufficient for `primary` vs `secondary`.
- **B. Add a minimal `x_pdpp_role` on `schema.properties[field]`** alongside
  `x_pdpp_type` (mirrors the accepted type extension): slot values `primary-title |
  secondary | actor | event-time | amount` (TYPE still gates formatting,
  but the slot is declared here, not inferred from type — so a stream with several
  timestamps or several currency fields can say WHICH one is the event-time/amount slot;
  `amount` may declare its paired `currency` field). Pro: smallest precise addition, same
  authorship principle, additive/presentation-only. Con: a new (small) vocabulary → a
  proposed spec addition for owner decision.
- **C. A per-stream `display.card` block** declaring `{ title: field, body: field,
  actor: field, media: field }`. Pro: explicit, one place. Con: larger surface; duplicates
  what per-field roles express.
DESIGN LEAN: **B** (smallest precise addition, mirrors the accepted `x_pdpp_type` pattern,
graceful-unknown by construction) — but A is evaluated first in tasks; if A can express
`primary`/`secondary` honestly, no new vocabulary is added. **This is the one place this
change may touch a manifest/protocol surface; it is flagged for owner decision and does
NOT proceed unilaterally.**

### 5.4 The honest generic fallback (first-class, not a failure mode)
When a record's roles are undeclared, the card renders: the manifest-authored stream
label (`display.label`), the declared event time if present, the record's primary key,
and a readable key/value table of the declared fields with humanized labels — NEVER a
guessed message/money/photo card. Prior art: Datadog renders arbitrary structured logs as
a generic key/value attribute table (https://docs.datadoghq.com/logs/explorer/); Google
My Activity + GitHub render heterogeneous items through a generic base-schema +
type-specific-detail renderer (https://www.gharchive.org/). Owner bar: "not using brittle
heuristics is more important than having a perfect label for everything." The brittle
field-name/stream-name heuristics leave the SLVP path (retained only as an explicitly-
labeled last resort, or removed — decided in tasks).

## 6. Selection / row-action contract

- **Desktop:** row click = open the peek panel (in-place inspect); the explicit **Open**
  action = navigate to the full record-detail route. These DIFFER (peek vs full route) —
  if they were identical, Open is useless (feedback #12); the contract makes Open the
  full-route escalation. Keyboard: arrow up/down moves selection; Enter opens peek;
  Cmd/Ctrl-Enter opens the full route; Escape clears.
- **Mobile:** the peek panel is hidden (no room); a row tap navigates to the full
  record-detail route (already fixed — R4). Open and row-tap converge to the same route.
- **Focus/selected state:** machine-readable (`aria-selected`/`data-selected`) +
  visible.
- **Multi-select:** explicitly NOT supported in this change (no bulk action exists to
  justify it); stated so future work doesn't assume it.
- **Per-row "view full stream":** REMOVED from rows — the scope-preserving drill-in lives
  at the group/burst level (§2,§3), not on every row (feedback #11). Removed only after
  the group-level drill-in is proven.
- **"inspect read request"** is redundant given "copy view link" (both surface the read
  request) — merged/removed (feedback #3).

## 7. Edge-case matrix → SLVP behavior (exemplar)

| Case | SLVP behavior | Exemplar |
|---|---|---|
| One stream dominates a day | Burst with TRUE count; inline-if-loaded else drill-in/paginate | Stripe >10; Photos 100-cap |
| Many small streams in a day | Individual rows, no burst | Linear |
| Mixed burst + singles in a day | Singles render; bursting partition collapses; one day header | current shape (keep) |
| Load-more crosses a day boundary | Absorb in place; recollapse if it crosses threshold; no displacement | GroupedVirtuoso |
| All-future first page | Main feed leads with Today; future in Upcoming | Things/Todoist + shipped v4 |
| Empty main feed + non-empty upcoming | Honest empty main ("nothing today; N upcoming") + the Upcoming section | Linear empty-group ethos |
| Expand-state across load-more | Persist by stable group id | GroupedVirtuoso scroll-to-group |
| 3-level collapse nesting | Active level's header sticky/legible | Linear sticky group headers |
| Undeclared-role record | Honest generic key/value card | Datadog log attributes |
| A count that can't be exact | `hidden`, not faked | Stripe (no default total) |

## 8. Acceptance ledger (what "done + SLVP" means; promoted to scenarios in specs)

- Every count shown is exact-and-reachable OR hidden — no capped head behind a true total.
- "188 upcoming" (and every group count) is FULLY reachable; "open all N" lands in a set
  of size N with the identical scope; reproduce-the-bug test: a count whose set exceeds
  the loaded head must be reachable to its last member.
- One query input; Enter submits; chips == operators == the same query; facets are part
  of that query; source/stream selection is invertible; facet numbers are exact-or-hidden.
- A brand-new connector that declares field roles renders a correct typed card with ZERO
  client code; a connector that declares nothing renders the honest generic card, never a
  wrong guessed card; no SLVP-path field-name/stream-name guessing.
- Row click vs Open differ meaningfully on desktop; mobile row opens detail; no useless
  affordances; no per-row stream link.
- Load-more merges in place (collapse down, not up); no row already shown reorders or
  vanishes; expand state persists.
- Motion communicates pending/selection/expansion/load-more continuity on the FINAL
  model (not sprinkled on the churned one); mobile loading sits at the top of the feed.

## 9. Sequencing (vertical slices, reachability first)

1. **Reachability slice** (highest-risk invariant): RecordSet descriptors on the read
   surfaces; burst/Upcoming counts true-or-hidden; "open all N" scope-preserving; 188
   fully reachable. Reproduce-the-bug tests; dual-owner gate on the cursor/contract.
2. **Unified query slice**: one input; Enter; chips↔operators; facets==query; invert;
   facet-count semantics.
3. **Selection / row-action slice**: peek vs Open; mobile; remove redundant affordances
   after replacements proven.
4. **Manifest presentation slice**: role declaration (A-vs-B-vs-C decided here, owner
   gate if new vocabulary); first-party pilot; honest generic fallback; retire SLVP-path
   heuristics.
5. **Polish**: motion on the final model; mobile loading position; operators-popover
   bounds; typography/spacing; live owner-journey walkthrough.

Each slice: reproduce-test → (risky machinery) independent-review gate → deploy → verify live, on the
deployed Explore lineage. Enter-to-submit and operators-popover-bounds are the only safe
leaf fixes shippable independently of the model.

## 10. PDPP-specific inventions (flagged, per the independent reviewer)

- The RecordSet `count`-kind enum (`exact|lower_bound|not_counted|hidden`) as an explicit
  response descriptor — synthesized from Stripe's "don't promise an unreachable total" +
  Linear's true-per-group-count; not a single product's named API. Justified: it makes
  count==reachability machine-checkable, which no single exemplar packages.
- `x_pdpp_role` (if option B wins) — a minimal addition mirroring the accepted
  `x_pdpp_type`; owner-gated.
Everything else maps to a cited exemplar.
