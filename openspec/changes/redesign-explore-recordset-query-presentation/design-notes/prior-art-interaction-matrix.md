# Prior-art interaction matrix — Explore RecordSet / query / presentation

One auditable table per the design's load-bearing interactions. Columns: OBSERVED
pattern (with PRIMARY SOURCE) | the PRODUCT REASON | PDPP TRANSLATION | ANTI-PATTERN |
ACCEPTANCE CHECK. Sources are source-backed, primary product/spec docs where available;
a few rows cite secondary write-ups (9to5Google, Blocksender, a GitHub community thread,
Tom's Guide) as supporting evidence for an observable product behavior, not as the spec of
record (hand-verified; the deep-research harness was rate-limited — see
docs/research/explore-query-filter-ia-prior-art-2026-06-21.md).
PDPP-SPECIFIC INVENTIONS are flagged: `RecordSet`, the `count_kind` enum, and the
manifest role vocabulary.

## A. Query / filter / search

| Interaction | Observed (source) | Why it works | PDPP translation | Anti-pattern | Acceptance check |
|---|---|---|---|---|---|
| One query input | Gmail: one bar = free-text + chips + advanced builder; a pasted/typed term resolves, no separate id box (https://9to5google.com/2020/02/19/gmail-search-chips/). Stripe: one search bar does text+filters+id (https://docs.stripe.com/dashboard/search) | One place to express intent; no "which box?" decision | ONE input; pasted exact id → "jump to record" affordance, not a 2nd box | Two inputs (current: "search values" + "go to id") | Only one query input; Enter submits; pasting an id offers jump |
| Chips vs operators | Gmail chips == the operator behind them ("Has attachment" = `has:attachment`), chips on web+mobile (https://support.google.com/mail/answer/7190). Linear click-to-refine chips, operators in the API only (https://linear.app/docs/filters) | Recognition over recall; novice and power user build the SAME query | Common filters = chips w/ typeahead; operators = optional power path producing the same query | Requiring operator syntax as the only path; mixing typed operators INTO a token field ("text mode vs token mode", https://github.com/community/community/discussions/15655) | Selecting a chip yields the identical query to typing its operator |
| Facets vs query | Datadog: facet panel selections reflect in the query bar + URL — ONE state (https://docs.datadoghq.com/logs/explorer/facets/) | No "do my checkboxes AND my query both apply?" ambiguity | Source/stream facets are part of the ONE query state, in the view link | Two parallel filtering systems (current confusion) | Changing a facet updates the query+link; changing the query updates the facet state |
| Invert / negate | Stripe: leading `-` negates any filter (https://docs.stripe.com/dashboard/search). Gmail: `-term` + the "Doesn't have" form field (https://blocksender.io/using-boolean-and-and-not-operators-in-gmail-search/). Linear: chip "is not" toggle (https://linear.app/docs/filters) | Exclusion is a first-class need; expose it in BOTH UI and syntax | Source/stream invertible via a chip "is not"/exclude toggle AND `-` | No way to invert (current) | "Everything except X" is expressible by chip and by operator |
| Facet counts | Datadog: the number = count in the CURRENT filtered query scope, updates as filters change (https://docs.datadoghq.com/logs/explorer/facets/). Stripe: refuses a total it can't cheaply guarantee — no default list total, search total only to 10,000 (https://docs.stripe.com/api/pagination/search) | A number must mean one clear thing or it misleads | Facet number = exact count in the current filtered set; if not exactly computable → HIDDEN | A number whose meaning is ambiguous (current) | A shown facet number is exact-for-the-current-set; otherwise absent |
| Keyboard | Gmail/Linear: Enter submits; Cmd-K jump | Table stakes; speed | Enter submits; Cmd-K for jump/id; typeahead/escape | Button-only submit (current bug) | Enter submits without a button |
| Mobile | Gmail keeps CHIPS on mobile; advanced panel → a filter button/sheet (https://support.google.com/mail/answer/7190) | Power survives the small screen | Chips on mobile + a filter button → bottom sheet | Losing filtering on mobile, or a panel that overflows | Mobile shows chips + a filter button opening a panel |

## B. Reachability / collapse / load-more (RecordSet)

| Interaction | Observed (source) | Why it works | PDPP translation | Anti-pattern | Acceptance check |
|---|---|---|---|---|---|
| Count == reachability | Stripe: a count is a handle to its exact filtered set via URL state; refuses unreachable totals (https://docs.stripe.com/dashboard/search). Linear: true per-group totals tied to full membership (https://linear.app/docs/filters) | A number is a promise; keep it | Every shown count is exact AND reachable, else hidden; never shrunk | A count promising more than the UI reaches (Google Photos Stacks "promising completeness it does not deliver" — legibility research) | A shown count's set is reachable to its last member |
| Grouped (burst) count | Linear true per-group count (https://linear.app/docs/filters) | Tells the owner the real size | Burst shows the TRUE per-(conn,stream,day) total, not the loaded count | Showing the loaded count (current 32) as if complete | Burst count == true total of its set |
| "Show all" for a group | Google Photos Stacks: inline expand, hard-capped at 100 (https://www.tomsguide.com/...photo-stacks...). Stripe invoice lines: ≤10 inline, >10 a separate paginated endpoint (https://docs.stripe.com/invoicing/preview) | Small = inline; large = drill into the full paginated set | Inline-if-loaded; else "Open all N →" scope-preserving drill-in/paginate | "show all" over a subset it can't complete | "Show all" reveals the full set, or becomes a complete drill-in |
| Load-more in groups | react-virtuoso GroupedVirtuoso: mutate groupCounts in place, adjust firstItemIndex by new-item count; never displace shown (https://virtuoso.dev/react-virtuoso/api-reference/grouped-virtuoso/) | Stable scroll; no disorientation | Merge in place; a singles-day crossing the threshold collapses down; no reorder | "collapse up" / displacing shown rows | Load-more never reorders shown rows; partial day collapses down |
| Future/upcoming section | Things 3 day-sections, mutually-exclusive lists (https://culturedcode.com/things/support/articles/4001304/). Todoist Upcoming = its own week-paged surface (https://todoist.com/help/articles/plan-ahead-with-upcoming-view-KgKpuaGq) | Future is its own thing; one record in one place | Upcoming = own day-sectioned surface w/ own reachability; future records only here | Future riding the main feed's burst+cap | Every upcoming record reachable; none in the main feed |

## C. Record presentation (manifest-authored)

| Interaction | Observed (source) | Why it works | PDPP translation | Anti-pattern | Acceptance check |
|---|---|---|---|---|---|
| Declared title/primary role | Airtable primary field = declared title across views (https://support.airtable.com/docs/the-primary-field). Notion: schema requires exactly one title property (https://developers.notion.com/reference/property-object). schema.org `name`/`mainEntity` | Declared, never guessed; arbitrary schema renders right | Manifest declares the `primary` role; renderer reads it | Guessing the title from a field-name list | A declared-role connector renders the correct title with no client code |
| Type vs role | Airtable: only primary-eligible TYPES can be the title (type gates role, but role is a separate declaration); interface layouts choose title + 2 preview ROLES (https://support.airtable.com/docs/interface-layout-record-review). JSON Schema `title`/`description` are display annotations | A `text` field can be title OR body — type doesn't say which | Two axes: field TYPE (timestamp/currency/text/person/media/url/geo) ≠ presentation ROLE (primary/secondary/event-time/actor/amount/media/supporting) | Treating type as role (two text fields, no way to say which is the title) | The same TYPE can carry different ROLEs; the manifest declares which |
| Honest generic fallback | Datadog: arbitrary logs → generic key/value attribute table; reserved standard attrs special only when present (https://docs.datadoghq.com/logs/explorer/). Google My Activity + GitHub: generic base-schema (header/title/time) + typed-detail renderer (https://www.gharchive.org/) | An honest table beats a confident wrong card | Undeclared record → stream label + declared time + identity + key/value table (humanized labels) | A guessed message/money/photo card from field/stream names | An undeclared stream renders a generic card, never a guessed typed card |
| Humanized labels | JSON Schema `title` annotation = the display label (https://json-schema.org/understanding-json-schema/reference/annotations) | Deterministic, declared | Use the manifest's declared field label where present; mechanical key-format only as a last-resort label | Inferring semantics from a prettified key name | Labels come from manifest annotations; key-format is label-only, never semantic |

## D. Row actions / selection

| Interaction | Observed (source) | Why it works | PDPP translation | Anti-pattern | Acceptance check |
|---|---|---|---|---|---|
| Row click vs Open | Airtable: row = expand/peek; a record has a full detail view (https://support.airtable.com/docs/interface-layout-record-review). Linear: click = peek, full route distinct | Two intents (inspect vs go-to) need two outcomes | Desktop: click = peek; Open = full route. Mobile: tap = full route | Open identical to row click (useless) | Open and row click differ on desktop |
| Drill-in lives at group level | (B) scope-preserving drill-in | Per-row links are noise | Stream door at the group/burst level, not per row | A "view full stream" link on every row | No per-row stream link; group-level drill-in present |

## Search-result-set classes (the deepest seam — pins lexical honesty)

| Class | Definition | Count/reachability | Source/precedent |
|---|---|---|---|
| `relevance_bounded` | A semantic/top-match candidate pool; NOT an exhaustive count of all conceptual matches | count is the POOL SIZE (a bounded sample), `lower_bound` at most, never "all matches"; no "sort newest" affordance implying completeness | Stripe search total only to 10,000 (https://docs.stripe.com/api/pagination/search); existing explore-search-result-set-model-validation research |
| `keyword_pageable` (exhaustive lexical) | A keyword/filter set that can be walked to exhaustion via cursor | `exact` count is provable; fully reachable | Stripe `has_more` walk-to-exhaustion (https://docs.stripe.com/api/pagination) |
| chronological browse | The time-ordered corpus under a scope; no relevance promise | `exact`; fully paginated | the deployed merged-timeline (cursor v4) |

ACCEPTANCE: a `relevance_bounded` set SHALL NOT render as an exhaustive "all matches" set
nor expose "sort newest" implying completeness; "all records matching X" SHALL create/
navigate to an exhaustive pageable set or state the exact set is unavailable.

## PDPP-specific inventions (flagged)
- `RecordSet` (the unit-of-truth object) — synthesized from Stripe URL-scoped sets +
  Linear true-group-counts + the count==reachability bar; no single product names it.
- `count_kind` enum (`exact|lower_bound|not_counted|hidden`) — makes count==reachability
  machine-checkable; not a single product's API.
- The manifest role vocabulary (`primary|secondary|actor|media` + typed timestamp/amount)
  — mirrors Airtable's title+preview roles + schema.org name/description; the EXACT enum
  is PDPP's, owner-gated.
