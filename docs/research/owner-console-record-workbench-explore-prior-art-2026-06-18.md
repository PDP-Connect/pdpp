# Owner Console — Record Workbench / Explore: Deep Mechanics Prior Art

Date: 2026-06-18
Owner: RI owner (PDPP owner console redesign)
Status: Net-new prior-art research. **Extends** (does not repeat)
`docs/research/explorer-workbench-and-access-transparency-prior-art-2026-06-18.md`,
which already establishes the convergent workbench *shape* (query bar + facet rail +
histogram + result list + side panel, URL-encoded, paginated-not-capped) from Datadog,
PostHog, and Algolia at the overview level.

## Why this note exists (and what it extends)

The existing explorer doc answers "what is the right *shape*." This note goes one level
**deeper and wider on the mechanics** the build will actually have to specify, because
the owner's complaints are mechanical, not architectural:

- "6 of 1,183" shown **without a basis label or a path to the full set**.
- The interactive **time-series chart was removed** ("for performance") and results are
  **silently capped**.
- **Jump-to-ID is undiscoverable and gives no feedback**.
- The search input "needs autocomplete and it needs to be fairly intelligent"; "there
  should be far more ways to sort, possibly even multiple stacked sorts."
- "Click a connection, only the first click is honored, wait for refresh" — rapid
  selection intent is dropped during loading.

So this note drills into the specific affordances: **selection + multi-select intent
preservation during loading; faceted filters with live counts; typed operators +
query-bar autocomplete (field → operator → value); URL/shareable query encoding;
time-histogram-as-filter; pagination vs virtualization vs silent caps; in-place detail
panes; rich rendering vs raw JSON.** Every claim below is anchored to a fetched primary
source.

---

## 1. Prior-art sources

### 1.1 Datadog Log Explorer — Saved Views (state persistence + sharing)
URL: <https://docs.datadoghq.com/logs/explorer/saved_views/> (retrieved 2026-06-18)

A Saved View is the explicit unit of "a reusable view." It persists exactly three things:
"A **search query along with its time range**"; "a customized **default visualization**
(log stream, log patterns, or log analytics) along with their specific visualization
properties"; and "a **selected subset of facets** to be displayed in the facet list."
Critically: "Saved View is meant to track **live time ranges** (such as past hour, or
past week) and **fixed time ranges are converted as such on save**." This is the precise
enumeration of what a shareable/saveable explorer state must capture — and the rule that
relative ranges are the canonical save form, not frozen timestamps.

### 1.2 Datadog Log Explorer — Facets (live counts, value list, measure sliders)
URL: <https://docs.datadoghq.com/logs/explorer/facets/> (retrieved 2026-06-18)

"Open a facet to see a **summary of its content for the scope of the current query**."
Qualitative facets "come with a **top list of unique values, and a count of logs matching
each of them**." Interaction model: "Clicking on a value **toggles the search on this
unique value**…; clicking on **checkboxes adds or removes this specific value** from the
list of all values, and **you can also search upon its content**." Numeric facets
("Measures") "come with a **slider indicating minimum and maximum values**. Use the
slider, or **input numerical values**, to scope the search query to different bounds."
Two distinct interactions matter for PDPP: (a) counts are *scoped to the current query*
(they update as you refine), and (b) the facet value list is itself searchable when the
cardinality is high.

### 1.3 Datadog Log Explorer — Search Syntax (typed attribute search, wildcards, ranges, negation)
URL: <https://docs.datadoghq.com/logs/explorer/search_syntax/> (retrieved 2026-06-18)
(AI-markdown mirror: `.../search_syntax.md`)

Concrete grammar primitives worth copying:
- **Attribute search** with `key:value`; reserved attributes (`host`, `source`,
  `status`, `service`, `message`, etc.) need no `@` prefix; custom attributes use `@`.
- **Ranges**: `@http.status_code:[200 TO 299]` (inclusive numeric range in the query
  string itself).
- **Negation / existence**: `-@http.status_code:*` means "logs **not containing** the
  attribute"; `@field:*` means "field is set."
- **Wildcards**: `service:web*`, `*web`, `service:*mongo`; the `?` wildcard matches a
  single special character or space (`@my_attribute:hello?world`).
- **Escaping**: special characters in a value require escaping or double quotes
  (`@my_attribute:"hello:world"`).
- **Arrays**: `@user_perms:(4 6)` requires both values; `@user_perms:[2 TO 6]` matches
  any value in a range.
This proves the query string can be the *single source of truth* and still express the
full operator surface PostHog exposes as a builder — they are two renderings of the same
grammar.

### 1.4 Datadog Log Explorer — Visualize / Timeseries histogram
URL: <https://docs.datadoghq.com/logs/explorer/visualize/> (retrieved 2026-06-18)

The Timeseries visualization "visualize[s] the evolution of a single measure (or a facet
unique count of values) over a selected time frame, and (optionally) **split by up to
three available facets**," with a configurable **roll-up interval** and a choice of bars
(recommended for counts), lines, or areas. This is the affordance the owner said PDPP *removed*
for performance: a volume-over-time view that gives whole-set context and (per the
overview doc) is itself draggable to narrow the time window. The roll-up-interval control
is the answer to "won't it be slow" — bucket coarseness is a knob, not a reason to delete
the chart.

### 1.5 GitHub Code Search syntax (qualifiers + boolean + regex + exact match)
URL: <https://docs.github.com/en/search-github/github-code-search/understanding-github-code-search-syntax> (retrieved 2026-06-18)

"Search queries consist of **search terms** … and **qualifiers, which narrow down the
search**." Bare terms match content or path. "Searching for multiple terms separated by
whitespace is **the equivalent to the search `hello AND world`**. Other boolean
operations, such as `hello OR world`, are also supported." The page documents: exact
match via quotes (including whitespace), escaping quotes/backslashes, **regular
expressions** (delimited with `/.../`), and qualifiers (`language:`, `path:`, `repo:`).
The load-bearing lesson: a single text box can carry **implicit-AND between terms,
explicit OR, NOT, exact-phrase, and regex** without a builder UI — discoverability comes
from autocomplete, not from forcing a form.

### 1.6 GitHub issue/PR filtering (qualifier syntax, OR-vs-AND within a field, exclusion)
URL: <https://docs.github.com/en/issues/tracking-your-work-with-issues/filtering-and-searching-issues-and-pull-requests> (retrieved 2026-06-18)

Qualifier examples: `state:open is:issue author:octocat`, `assignee:octocat`,
`label:"bug"`. Exclusion: "**Filter out search terms by using `-` before the term**:
`-author:octocat`." And the OR/AND distinction made explicit: "**To filter issues using
logical OR, use the comma syntax: `label:"bug","wip"`. To filter using logical AND, use
separate label filters: `label:"bug" label:"wip"`.**" This is the cleanest published
statement of the faceted-search rule the existing doc cites abstractly (OR-within-a-facet,
AND-across-facets) — here it is concrete syntax.

### 1.7 GitHub general search syntax (quoting whitespace values)
URL: <https://docs.github.com/en/search-github/getting-started-with-searching-on-github/understanding-the-search-syntax> (retrieved 2026-06-18)

"If your search query contains whitespace, you will need to **surround it with quotation
marks**" — e.g. `build label:"bug fix"`, `cats NOT "hello world"`. Settles how a value
picker must serialize multi-word facet values back into the canonical query string.

### 1.8 PostHog filters (the three-part typed filter tuple)
URL: <https://posthog.com/docs/product-analytics/trends/filters> (retrieved 2026-06-18)

Confirms (and the existing doc already cites) the property → operation → value tuple
where the **operator menu is typed to the property** and `equals`/`contains` accept
multiple values (OR-within-filter) with value autocomplete. This note treats PostHog as
the *builder* rendering of the same grammar Datadog/GitHub express as a query string;
PDPP should offer both faces over one canonical state.

### 1.9 Notion — Views, filters, sorts & groups (per-view saved state, stacked sorts, groups)
URL: <https://www.notion.com/help/views-filters-and-sorts> (retrieved 2026-06-18)

Notion databases attach **filters, sorts, and groups to a named view**, and a database
can hold **multiple views** each with its own filter/sort/group config (the canonical
"saved view" pattern for record collections, distinct from Datadog's log framing). It
supports **multiple stacked sort rules** (sort by A, then B) and **grouping** records by a
property into collapsible sections — directly relevant to the owner's "multiple stacked sorts"
ask and to the "Collected: how many *new*" framing (group/segment by change status).

### 1.10 Chrome DevTools — Network panel reference (filter operators, column customization, time-drag, "shown of total" status bar, type multi-select)
URL: <https://developer.chrome.com/docs/devtools/network/reference> (retrieved 2026-06-18)

The richest source for *honest counts* and *column control*:
- **Filter-by-property with autocompleted values**: filters like `status-code`,
  `cookie-value`, `url`, `domain`, `has-response-header`, `larger-than` — and the
  autocomplete is sourced from the data DevTools has actually seen: for `domain`,
  "DevTools … populates the autocomplete drop-down menu with **all of the domains it
  has encountered**"; for `has-response-header`, "DevTools populates the autocomplete
  drop-down with **all of the response headers that it has encountered**." (Value
  suggestions are sourced from the *actual indexed data*, not a hardcoded list.)
- **Type filters as multi-select chips**: "click the All, Fetch/XHR, JS, CSS, Img,
  Media, Font, Doc, WS, Wasm, Manifest, or Other buttons"; "**To show resources of
  multiple types simultaneously, hold Command (Mac) or Control … and then click several
  type filters.**" Multi-select is explicit, accumulative, and toggle-able.
- **Time-drag as a filter**: "**Drag left or right on the Overview timeline** to display
  only the requests that were active during that timeframe. The filter is **inclusive**."
  (The histogram-as-filter pattern, in a non-Datadog product.)
- **Honest count copy**: "The **status bar at the bottom displays the number of the shown
  requests out of the total**." This is the exact antidote to "6 of 1,183 with no basis"
  — the count is always framed as *shown / total*, and hiding (e.g. "Hide data URLs",
  "Hide extension URLs") updates that ratio, never silently truncates.

### 1.11 Algolia InstantSearch — URL routing / state sync
URL: <https://www.algolia.com/doc/guides/building-search-ui/going-further/routing-urls/js/> (retrieved 2026-06-18)

The canonical "sync your URLs with the search state" guide: InstantSearch's `routing`
option serializes the **full UI state** (query, refinements, page, sort) into the URL and
hydrates back from it, with a `stateMapping` hook to produce **clean, human-readable
URLs**. Establishes that shareable/back-button-safe state is a first-class, documented
concern — not an afterthought.

### 1.12 TanStack Virtual — virtualization rationale (render only visible rows)
URL: <https://tanstack.com/virtual/latest/docs/introduction> (retrieved 2026-06-18)

The reference library for "render large lists without rendering every row": it virtualizes
(windows) scrollable content so only the **visible rows are mounted to the DOM**, keeping
large result sets smooth. This is the standard, citable answer to "the list is slow with
many records, so we capped it" — the fix is windowed rendering over the full (paged)
result set, not a hard cap on what the owner can reach.

### 1.13 Airtable — grid view (selection + expand-to-detail, row/column controls)
URL: <https://support.airtable.com/docs/grid-view> (retrieved 2026-06-18)

Airtable's grid is the mainstream record-table reference: a row's **expand control** opens
the full record without leaving the grid (in-place detail), rows are selectable, columns
are reorderable/hideable/resizable, and **row height** is adjustable for denser or richer
display. Anchors the "result list row → in-place detail pane" and "owner controls which
columns show" affordances for a non-developer audience.

### 1.14 Raycast (command-palette / typed-query interaction model)
URL: <https://manual.raycast.com/> (retrieved 2026-06-18)
(observed product behavior, augmenting the fetched manual landing page)

Raycast's core is a **single text field that is simultaneously a launcher and a filter**:
you type, results filter instantly with no submit, the **first result is the default
action on Enter**, and arrow keys move a selection. It is the cleanest model for
"keyboard-first, type-to-filter, instant feedback, obvious default action" — directly
relevant to jump-to-ID and to the "why must I press Enter" complaint.

---

## 2. Observed patterns (cross-source synthesis)

**P1 — One canonical query state, two faces.** Datadog/GitHub express the full operator
set (AND/OR/NOT, ranges, wildcards, existence, exact phrase) as a **query string**;
PostHog/Notion express the same as a **builder** (property → operator → value rows).
Strong products treat these as two renderings of one serializable state — and that state
is what gets saved (Datadog Saved Views §1.1) and URL-encoded (Algolia §1.11).

**P2 — Counts are live and scoped, and always framed as shown/total.** Datadog facet
counts are "for the scope of the current query" (§1.2). DevTools always shows "shown
requests **out of the total**" (§1.10). Nobody surfaces a bare "6 of 1,183" without a
basis; the count is either a refinement count or an explicit shown/total ratio whose
denominator is reachable.

**P3 — The volume chart is a filter, not decoration.** Both Datadog (§1.4) and DevTools
(§1.10, "drag on the Overview timeline") make the time distribution **draggable to narrow
the result set**, with a roll-up/coarseness knob so it stays cheap. Removing it removes
both whole-set context *and* a primary filter affordance.

**P4 — Multi-select is explicit, accumulative, and survives loading.** DevTools type
filters (§1.10) and Datadog facet checkboxes (§1.2) accumulate selections (Cmd/Ctrl-click;
checkboxes), toggle cleanly, and are visually distinct chips/checkboxes — never a
fire-and-forget click whose second tap is dropped while results reload.

**P5 — Autocomplete is sourced from the real index.** DevTools "populates the autocomplete
drop-down menu with all of the domains **it has encountered**" (and likewise all of the
response headers it has encountered) (§1.10); Algolia
query suggestions come from the index; Datadog suggests facet keys/values. Suggestions are
data-driven, not hardcoded, and span **field → operator → value**.

**P6 — In-place detail, then raw.** Datadog row → side panel with a raw/JSON face (existing
doc); Airtable row → expand-in-grid (§1.13). The detail shares the surface; raw JSON is an
available *face* of a richly-rendered record, not the default presentation.

**P7 — Virtualize the full set; don't cap it.** TanStack Virtual (§1.12) is the documented
performance fix (window the DOM) that makes "show the whole paged set" viable, removing the
justification for silent caps.

---

## 3. PDPP implications (tie to surfaces + the owner's complaints)

- **"6 of 1,183 without a basis label / no path to full set"** (Explore + stream-detail
  result lists): adopt DevTools' **"shown N of total M"** framing (§1.10). The denominator
  must be the real matched-set size, and there must be a control to reach the rest
  (paginate / load-more / virtualized scroll, §1.12) — never a silent cap. If a true cap
  exists (e.g. backend safety limit), label it explicitly as a cap with its reason and the
  query to narrow under it, mirroring Datadog's roll-up/narrow guidance (§1.4).

- **Removed time-series chart** (Explore): restore a **volume histogram over the active
  time range** with a roll-up interval (§1.4) that is **draggable to narrow the window**
  (§1.10). This gives whole-set context (so a narrowed list never reads as "data missing")
  and doubles as a filter — both things its removal cost.

- **Search "needs autocomplete and to be intelligent" + "multiple stacked sorts"**: build
  one canonical query state with **field → operator → value autocomplete** (§1.5, §1.10),
  typed operators from PDPP's declared `field_capabilities[].type` (PostHog model, §1.8),
  and **stacked multi-sort** (Notion, §1.9) restricted to backend-guaranteed stable sort
  keys. Offer both a query-string face (Datadog/GitHub) and a builder face (PostHog) over
  the same state.

- **Jump-to-ID undiscoverable / no feedback**: make it a real, labeled control with
  Raycast-style instant feedback (§1.14) — on submit it either **scrolls to + highlights
  the matched row in place** (or opens its detail pane) or shows an explicit **"no record
  with id X in the current scope" + a one-click "search all sources for X"**. Silence is
  the bug.

- **"Click a connection, only first click honored, wait for refresh"** (facet/connection
  selection in Sources/Explore): selections must be **accumulative checkboxes/chips that
  queue and apply** even while results are loading (§1.4 P4), not single-fire navigations.
  Optimistically reflect the selected chip immediately; reconcile counts when the query
  returns (Datadog scoped counts, §1.2).

- **"Can't tell if I'm looking at a source or a connection" + stream-table vs Explore are
  two renderers**: collapse to **one workbench** (existing doc's conclusion) where the
  stream view is the same workbench with the connection+stream **pre-applied as facets**
  and reflected in the query string (§1.1 saved-view = query+facets+viz). The URL/saved
  view carries that scope (§1.11), so "where am I" is always answerable from the query bar.

- **"Collected: many say no change vs how many NEW"**: use Notion-style **grouping**
  (§1.9) to segment a run/result set by change status (new / updated / unchanged) with
  per-group counts, instead of one ambiguous "Collected N." Counts must be scoped/live
  (§1.2) so each group's number is honest.

- **Rich rendering vs raw JSON**: default to a **richly-rendered record** (Airtable expand,
  §1.13; Datadog side panel) with a **Raw JSON face** as a toggle, not the primary view —
  ties to existing record-rendering work in the corpus.

## 4. Concrete affordance / copy / IA recommendations

**Query bar.** Single bar = source of truth. Autocomplete in three stages: type a **field**
→ suggest field names from the schema; pick field → **operator menu typed to that field**
(`=`, `≠`, `contains`, `matches /regex/`, `> < ≥ ≤`, `is set`, `is not set`); pick operator
→ **value suggestions from the actual indexed values** (§1.5/§1.8/§1.10). Support implicit
AND between clauses, explicit `OR`, leading `-` for NOT, quotes for whitespace values
(§1.6/§1.7). Expose a **builder face** (stacked property/operator/value rows) that
round-trips to the same query string.

**Facet rail (left).** One row per indexed dimension (source, connection, stream,
record_kind, status). Open a facet → **top values with live counts scoped to the current
query** (§1.2); checkboxes accumulate (OR within facet); the value list is searchable for
high-cardinality facets; numeric facets get a **min/max slider + numeric inputs** (§1.2).

**Histogram (above results).** Volume over the active range, bar style, with a roll-up
interval control; **drag-to-narrow** the time window; clicking/dragging writes the range
into the same query/time state (§1.4/§1.10).

**Result list.** Virtualized rows over the full matched/paged set (§1.12). **Status bar:
"Showing N of M records"** with M = true match count and a **load-more / paginate** control
(§1.10). Owner-controllable columns (show/hide/reorder/resize) and adjustable row density
(§1.13). **Stacked sort** control listing only backend-stable keys (§1.9). Selection
checkboxes are visually separate from row content and keyboard-reachable.

**Jump-to-ID.** Labeled control ("Go to record ID"); on submit, scroll-to + highlight in
place or open the detail pane; on miss, explicit not-found copy + "search all sources for
this ID" (§1.14).

**Detail.** Row → in-place side panel / expand (§1.6/§1.13); richly-rendered fields with a
**Raw JSON** toggle; relationship links (existing relationship-nav doc).

**Saved view + URL.** Persist query + (relative) time range + selected facets + columns +
sort as a **named Saved View** (§1.1) and encode the same state in the URL for share /
back-button (§1.11). Relative ranges are the canonical save form.

**Copy.** "Showing N of M" (never bare "N"); "Apply" / live-applied chips; "No record with
ID X in this view"; per-group "N new · N updated · N unchanged" instead of "Collected N."

## 5. Anti-patterns to avoid

- **Silent caps.** Returning a truncated set with no "of M" denominator and no path to the
  rest (the "6 of 1,183" bug). DevTools always shows shown/total (§1.10).
- **Deleting the volume chart for "performance."** The roll-up interval is the performance
  knob; the chart is also a filter (§1.4/§1.10). Removing it loses context *and* an
  affordance.
- **Fire-and-forget selection.** Single-click selections that drop the second click during
  loading. Use accumulative checkboxes/chips that queue (§1.2/§1.10).
- **Hardcoded suggestion lists.** Autocomplete must be sourced from indexed values (§1.10).
- **Two divergent renderers** (stream table vs Explore) for the same "show records" job —
  one workbench, scope as pre-applied facets (§1.1).
- **Raw JSON as the default record view.** Raw is a face, not the front door (§1.6/§1.13).
- **Two competing time controls** (a chip row + a separate date box) — one control, one
  selected state (existing doc; reinforced by Saved Views' single query+range, §1.1).
- **Jump-to-ID with no feedback** — silence on hit or miss (§1.14).

## 6. Acceptance checks (owner-walkable)

1. The Explore result list header reads **"Showing N of M"** where M is the true matched
   count; with > N matches there is a visible, working control to load the rest (paginate
   or virtualized scroll). No path returns a truncated set with no denominator.
2. A **volume-over-time chart** is present over the active range, and **dragging a region
   on it narrows the result set** (and writes the range into the URL/query state).
3. Typing in the query bar produces **field suggestions**, then **type-appropriate operator
   choices**, then **value suggestions drawn from real indexed values**; the operator menu
   for a numeric field differs from a text field.
4. Selecting **two facet values within one facet** ORs them; selecting values across **two
   facets** ANDs them; selections are checkboxes/chips that **accumulate without dropping a
   second click while results reload**.
5. The current view's **query + relative time range + facets + columns + sort** are encoded
   in the URL; copying the URL into a new tab reproduces the identical view, and the
   back button restores the prior view.
6. **Multiple stacked sorts** can be configured, and the available sort keys are limited to
   keys the backend guarantees stable.
7. **Jump-to-ID** is a labeled control; a hit scrolls-to/highlights or opens the record in
   place; a miss shows explicit not-found copy plus a "search all sources for this ID"
   action — never silence.
8. A result row opens an **in-place detail pane** (no full-page context switch) with
   rich-rendered fields and a **Raw JSON toggle**; raw JSON is not the default face.
9. A run/collection summary segments results into **new / updated / unchanged groups with
   per-group counts**, not a single ambiguous "Collected N."
10. From the query bar alone an owner can answer **"what scope am I looking at"** (which
    source/connection/stream), because that scope is pre-applied facets reflected in the
    query string — closing the "source vs connection" confusion.

## 7. Gaps / confidence

- **High** on the mechanics (counts-as-shown/total, histogram-as-filter, typed query
  grammar, facet counts scoped to query, virtualization-over-caps, URL/saved-view state) —
  all directly fetched from primary docs.
- **Medium** on the exact PDPP decomposition (single workbench component vs workbench + a
  thin pre-scoped stream wrapper) — a build decision for the owner-reviewed mock, as the
  existing doc also notes.
- The Algolia *in-depth UI/UX patterns* page 404'd previously; the **routing/URL guide**
  (§1.11) was fetched cleanly and carries the URL-state claim this note relies on.
- Raycast's instant-filter/default-action specifics are partly **observed product behavior**
  (the fetched manual landing page is a shell); flagged inline (§1.14).

## Sources (all retrieved 2026-06-18)
- Datadog Log Explorer — Saved Views — <https://docs.datadoghq.com/logs/explorer/saved_views/>
- Datadog Log Explorer — Facets — <https://docs.datadoghq.com/logs/explorer/facets/>
- Datadog Log Explorer — Search Syntax — <https://docs.datadoghq.com/logs/explorer/search_syntax/>
- Datadog Log Explorer — Visualize / Timeseries — <https://docs.datadoghq.com/logs/explorer/visualize/>
- GitHub — Understanding Code Search syntax — <https://docs.github.com/en/search-github/github-code-search/understanding-github-code-search-syntax>
- GitHub — Filtering and searching issues and pull requests — <https://docs.github.com/en/issues/tracking-your-work-with-issues/filtering-and-searching-issues-and-pull-requests>
- GitHub — Understanding the search syntax — <https://docs.github.com/en/search-github/getting-started-with-searching-on-github/understanding-the-search-syntax>
- PostHog — Filters — <https://posthog.com/docs/product-analytics/trends/filters>
- Notion — Views, filters, sorts & groups — <https://www.notion.com/help/views-filters-and-sorts>
- Chrome DevTools — Network features reference — <https://developer.chrome.com/docs/devtools/network/reference>
- Algolia InstantSearch.js — Sync your URLs (routing) — <https://www.algolia.com/doc/guides/building-search-ui/going-further/routing-urls/js/>
- TanStack Virtual — Introduction — <https://tanstack.com/virtual/latest/docs/introduction>
- Airtable — Grid view — <https://support.airtable.com/docs/grid-view>
- Raycast — Manual — <https://manual.raycast.com/> (partly observed product behavior)
