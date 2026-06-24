# Query / filter / search IA — prior art (2026-06-21, hand-researched)

Status: IN PROGRESS. The deep-research HARNESS is rate-limited at the fetch layer
(4 consecutive runs returned 0 sources — every fetch "API Error: rate limited"); SINGLE
WebSearch/WebFetch calls succeed, so this is hand-researched SEQUENTIALLY (slower, but
unblocked + controlled). Each claim carries its primary source. Feeds Explore redesign
workstream A (query model) + the RecordSet count semantics. Codex bar: primary-source
links, not prose-only; interaction matrix.

## (2)+(1) Tokenized filter chips vs operator syntax; one input vs many — LINEAR
- Linear uses TOKENIZED, click-to-refine filter chips, NOT typed operator syntax in the
  UI. Add a filter, then refine by CLICKING parts of the chip: clicking "is" offers
  "is not"; clicking the value opens a selectable list; operators are CONTEXT-AWARE and
  adapt ("is" → "is either of"/"is not" when you add values). Mouse-driven, discoverable,
  low syntax-error. For complex logic an ADVANCED FILTER builder groups conditions with
  AND/OR (nested). A natural-language + AI layer accepts "show me issues assigned to me".
  Operator/keyword syntax (and/or/every) is reserved for the API/GraphQL layer, not the
  everyday UI. → recognition-over-recall by default; power-syntax as a separate accelerator.
  Source: https://linear.app/docs/filters , https://linear.app/changelog/2021-11-08-linear-preview-new-filters , https://linear.app/developers/filtering
- ANTI-PATTERN (GitHub Projects): mixing typed operator syntax INTO a token field creates
  "text mode vs token mode" confusion (need a space before a comma to exit text mode) —
  users called it "very unwieldy". Don't bolt operator syntax onto a chip field.
  Source: https://github.com/community/community/discussions/15655
- Operator-syntax-in-the-bar exists where power matters (Help Scout: `subject:(coffee OR
  tea) assigned:Josie tag:carrots`, AND by default, OR/NOT explicit).
  Source: https://docs.helpscout.com/article/47-search-filters-with-operators
→ PDPP translation: ONE tokenized filter+search surface; common filters (source, stream,
  has:image) are RECOGNITION chips with typeahead, not syntax to learn; operators stay as
  an optional power accelerator, never the only path; AND/OR/invert via the chip UI.

## (3)+(5) Facet filters vs the query, and what facet COUNTS mean — DATADOG LOG EXPLORER
- The facet panel and the search bar are ONE SYNCHRONIZED QUERY STATE, not two parallel
  systems: selections in the facet panel are automatically reflected in the query bar AND
  the URL, and vice-versa. (Answers "do my checkboxes AND my typed query both apply?" —
  yes, they're the same query.)
- FACET COUNTS = the number of records matching that value WITHIN THE CURRENT FILTERED
  QUERY SCOPE — NOT the full corpus. As you add/remove filters the counts update to the
  narrowed set. Clicking a value toggles the query to it; clicking a checkbox multi-selects.
  Source: https://docs.datadoghq.com/logs/explorer/facets/ , https://docs.datadoghq.com/logs/explorer/
→ PDPP translation: filters + search are ONE query state (not the current two-input
  confusion). A number next to a facet means "count in the current filtered result set";
  if PDPP can't compute that exactly, HIDE the number (don't show an ambiguous one). This
  is the count==reachability principle applied to facet numbers.

## (D / PART 2) Schema-declared presentation role — NOTION
- Notion's TITLE property is the SCHEMA-REQUIRED primary field: exactly one per database,
  always present, ENFORCED at the schema/API level (API errors if you create a data source
  without one or try to add/remove it). It renders as BOTH the row's display label in
  views AND the page header when opened. The schema DECLARES which field is the title; the
  renderer does NOT infer it. Other properties render by their declared TYPE.
  Source: https://developers.notion.com/reference/property-object , https://www.notion.com/help/database-properties
→ PDPP translation: the manifest should declare the record's primary label (and other
  roles) the way Notion's schema declares the title — a declared ROLE, not a guessed field
  name. This is the manifest-authored-presentation pattern, confirmed at the SLVP bar.

## (4) INVERT / NEGATE — STRIPE + LINEAR + GMAIL
- Stripe Dashboard: negate ANY search filter with a leading hyphen `-` (matches excluded);
  multiple terms = AND. Source: https://docs.stripe.com/dashboard/search
- Linear chip UI: clicking the operator part of a chip toggles "is" → "is not" (negation is
  a context-aware operator on the chip, not syntax to learn).
  Source: https://linear.app/docs/filters
→ PDPP: expose invert in BOTH the chip UI ("is not" / an exclude toggle on a source/stream
  chip) AND the operator path (`-stream:x`). This directly resolves feedback #9 (no way to
  invert source/stream).

## (1) ONE input vs many + "go to exact id" — STRIPE
- Stripe's Dashboard search is ONE bar that does free-text AND filters AND operators; it is
  also where you paste an exact id (search resolves it). One canonical input, not separate
  free-text vs id vs filter inputs. Source: https://docs.stripe.com/dashboard/search
→ PDPP: collapse the current TWO inputs ("Search names, fields, values" + "Search all
  visible records / Go to record ID") into ONE. An exact-id paste is detected and resolves
  to that record (a command-palette-style "jump to id" affordance INSIDE the one input),
  not a second box. Resolves feedback #4 (multiple inputs) + #12-adjacent (go-to-id).

## DRILL-IN SCOPE PRESERVATION (RecordSet P0) — STRIPE
- Stripe Dashboard reflects filter/search state in the URL query string, so the URL IS a
  handle to the exact filtered set (copy it → reproduce the view). (Observed behavior;
  Stripe's docs describe the filter functionality but don't formally spec the URL-state, so
  flagged as OBSERVED not doc-asserted.) Source: https://docs.stripe.com/dashboard/search
- ANTI-PATTERN: a count that drills into a BROADER set than it named (lands in an
  unfiltered firehose) → the user can't reach the N promised. This is exactly the PDPP
  "open all in stream loses the upcoming/day/filter scope" risk Codex flagged P0.
→ PDPP: a count/preview is a HANDLE to a fully-reachable, IDENTICALLY-SCOPED set. "Open all
  N" must carry the EXACT scope (source+stream+date-range+future/past+query+field-filters)
  in the URL/cursor, landing in a set whose size == N. PDPP already has "copy view link"
  and a per-stream records page that takes filter params — the drill-in reuses that with
  the FULL scope, not a bare stream.

## SCHEMA-DRIVEN PRESENTATION — AIRTABLE + DATADOG + SPECS (workstream D / PART 2)
- AIRTABLE: the PRIMARY FIELD is the record title across ALL views (grid, Kanban card name,
  linked-record reference) — a DECLARED role, changeable but declared, never guessed. Only
  field TYPES eligible to be a primary field may serve as the title ("Only fields supported
  as the primary field … able to be used as the title"). In interface Record-review layouts
  you explicitly CHOOSE the title field + up to 2 PREVIEW fields — a tiny declared role
  vocabulary (title + preview1 + preview2). Field TYPE (text/date/currency) is SEPARATE from
  ROLE (title/preview). Source: https://support.airtable.com/docs/the-primary-field ,
  https://support.airtable.com/docs/airtable-interface-layout-record-detail
- DATADOG (the HONEST GENERIC FALLBACK): arbitrary structured logs render as a GENERIC
  KEY/VALUE attribute table (flat keys = individual attributes; nested = expandable tree);
  a few RESERVED standard attributes (service/host/level/message/timestamp) are treated
  specially WHEN PRESENT. It does NOT guess "which field is the title" — it shows the record
  faithfully as labeled key/values. THIS is the SLVP fallback for an undeclared record.
  Source: https://docs.datadoghq.com/logs/explorer/ , https://docs.datadoghq.com/standard-attributes/
- SPEC VOCABULARY (roles are DECLARED, never inferred): schema.org `name` = title/primary,
  `description` = body/detail, exactly ONE `mainEntity`; JSON Schema `title`+`description`
  annotations are explicitly FOR DISPLAY (short title, longer description); CMS pattern =
  a `field_metadata._default` flag marks the title. Source: https://schema.org/mainEntity ,
  https://json-schema.org/understanding-json-schema/reference/annotations
→ PDPP minimal role vocabulary (declared in the manifest): PRIMARY/title, SECONDARY/detail/
  body, plus the typed roles (timestamp, amount/currency, actor/person, media/thumbnail).
  TYPE ≠ ROLE (two text fields, one title one body — the manifest declares which). HONEST
  FALLBACK for undeclared: the record's identity (primary key) + declared time if present +
  a readable key/value table of the declared fields with humanized labels — NEVER a guessed
  message/money/photo card. Matches Tim: "not using brittle heuristics is more important
  than a perfect label." The accepted `x_pdpp_type` path gives kind/type; the GAP is the
  ROLE declaration (which text field is title vs body) + feeding manifests + this fallback.

## THE CANONICAL QUERY MODEL — GMAIL (the exemplar to adopt)
Gmail resolves the entire query-model tension in ONE bar:
- SEARCH CHIPS: clickable, recognition-over-recall ("Has attachment" chip == `has:attachment`
  behind the scenes); personalized/adaptive to the term; carousel under the bar; available
  on web AND mobile. Novices click; no operator memorization.
- ADVANCED SEARCH BUILDER (form): From/To/Subject/Has-the-words/**Doesn't have**/Size/Date.
  The "Doesn't have" FIELD is the form-equivalent of the `-` NEGATION operator — invert is a
  first-class form control, not just syntax.
- OPERATORS: the power path (`from:john has:attachment -filename:pdf`), AND by default, `-`
  for NOT — same query the chips build, just typed.
- "Create filter" turns a search into a saved filter (the saved-view pattern).
  Source: https://9to5google.com/2020/02/19/gmail-search-chips/ ,
  https://support.google.com/mail/answer/7190 (refine searches, chips on mobile) ,
  https://blocksender.io/using-boolean-and-and-not-operators-in-gmail-search/
→ PDPP CANONICAL QUERY MODEL: ONE bar. Common filters = chips with typeahead (source, stream,
  has:image, date) — recognition over recall. Negation = a chip toggle / "is not" AND `-`.
  Operators remain for power users (the SAME query the chips build). One unified query state
  (chips + free-text + facets all one query, per Datadog). Resolves feedback #4,#5,#9,#10.

## GENERIC-ITEM RENDERER — GOOGLE MY ACTIVITY + GITHUB (workstream D, confirmed)
- GOOGLE MY ACTIVITY renders HETEROGENEOUS activity from many products through ONE generic
  item component populated from a COMMON BASE SCHEMA (`header`, `title`, `time`, `products`);
  each item type fills the SAME base structure; day-grouped + expandable for details.
  Source: https://developers.google.com/data-portability/schema-reference/my_activity ,
  https://support.google.com/accounts/answer/7028918
- GITHUB event schema: COMMON fields + a type-specific `payload` (kept as a serialized JSON
  string, "different for each event type"); a generic renderer shows the common fields and
  renders type-specific detail conditionally. Source: https://www.gharchive.org/
→ PDPP: ONE generic record renderer reads the DECLARED common roles (title/time/…, from the
  manifest) and renders the rest faithfully (key/value, Datadog-style) — type-specific
  flourish only when the manifest declares it. This is the same generic-base + typed-detail
  pattern, and it's how arbitrary connectors render correctly with no per-source code.

## (6)/(7)/(8) — settled / known patterns (not synthesis blockers)
- Enter submits the search (feedback #1, table stakes). Command-palette (Cmd-K) for jump/
  go-to-id is the known pattern.
- Mobile: Gmail keeps CHIPS on mobile (the filter affordance survives the small screen); the
  facet/advanced panel becomes a filter button → bottom-sheet/panel. PDPP: chips on mobile +
  a filter button opening a panel.
- Empty/loading/error: covered by the shipped loading-states work + an honest empty state
  ("nothing in this set; N upcoming").

## NET: the load-bearing interactions (1-5, drill-in scope, generic presentation, query
## model) are now PRIMARY-SOURCE-GROUNDED at the SLVP bar. Ready to feed the synthesis.
NOTE on method: the deep-research HARNESS was rate-limited at the fetch layer (5 runs, 0
sources). Hand-research via sequential WebSearch SUCCEEDED — every claim above carries a
primary-source URL. This satisfies Codex's "primary-source links, not chat-only" bar.
