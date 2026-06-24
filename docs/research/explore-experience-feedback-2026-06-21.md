# Explore experience feedback (Tim, 2026-06-21) — verbatim + classification

Captured BEFORE any change so nothing is lost. Drives the SLVP-ideal redesign
(builds on the count==reachability + interaction-dynamics work in
explore-feed-interaction-dynamics-prior-art-2026-06-21.md and
explore-upcoming-collapse-interaction-problem-2026-06-21.md).

## Verbatim items
1. "submitting a search only works with a button press, not pressing enter."
2. "the loading animation, on Mobile, is above the fold if you scroll down."
3. "'inspect read request' should be removable given copy view link."
4. "there should not be multiple search inputs."
5. "users shouldn't have to learn operators like has:image (might be fine if they do
   for efficient power use)."
6. "the operators popup runs off the screen."
7. "explore page is missing motion it should have."
8. "what should the numbers in filters mean, and what do they mean? (rhetorical)"
9. "no way to invert source or stream selections."
10. "confused about relation between filters and search operators."
11. "I don't think rows should show view full stream link."
12. "is open button different than clicking row[?] if not it's useless."
13. "how does ui know to show 'message body' for message_bodies? we need to support
    arbitrary connectors."
14. (earlier, same session) "188 but I can only see 32" — count != reachability.
15. (earlier) "the auto grouping/collapse/expand thing doesn't feel good as is" — the
    interaction LOGIC needs prior-art grounding + edge-case coverage.

## Classification

### A. The INPUT / FILTER / SEARCH model is not designed (root cause of #4,#8,#9,#10,#5)
This is the big one — several items are symptoms of one undesigned system:
- #4 multiple search inputs (there are ≥2: the main "Search names, fields, values" and
  a separate "Search all visible records / Go to record ID" — confusing).
- #10 unclear relation between FILTERS (the source/stream facet chips) and SEARCH
  OPERATORS (has:image, stream:x typed into the query). Two parallel filtering systems.
- #8 the numbers next to filters (counts? of what — total records? matches?) are
  ambiguous.
- #9 no INVERT for source/stream selection (can't say "everything except X").
- #5 operators (has:image) require learning; acceptable for power users IF discoverable,
  but shouldn't be the ONLY way to express a common filter.
→ Needs: one coherent query model. Prior art: Linear/GitHub/Stripe/Datadog filter bars
  (chips + typeahead + a single input that unifies facets and free text; invert via
  "is not"; counts that mean one clear thing or are removed). RESEARCH REQUIRED.

### B. Concrete interaction defects (clear fixes)
- #1 Enter must submit search (not button-only). SLVP table stakes.
- #2 mobile loading animation position (must be at the top of the visible feed /
  sticky, not scrolled above the fold). Ties to the loading-states work.
- #6 operators popup overflows the screen (positioning/clamp bug).
- #7 missing motion the page should have (we have motion tokens; Explore underuses them
  vs the design-system bar — earlier Tim feedback too).

### C. Redundant / unclear affordances (remove or differentiate)
- #3 "inspect read request" is redundant given "copy view link" — remove or merge.
- #11 rows showing "view full stream" link — too noisy per-row; the stream door belongs
  at the group/burst level (ties to the drill-in design from the dynamics research).
- #12 "open" vs clicking the row — if identical, the open button is useless; differentiate
  (open = full detail route; row click = peek) or remove one. On mobile the row already
  routes to detail (R4 fix); desktop row = peek, so "open" should mean full route.

### D. ARCHITECTURAL — arbitrary-connector presentation (#13, load-bearing)
"how does the UI know to show 'message body' for message_bodies? we need to support
arbitrary connectors."

**HOW IT WORKS TODAY (traced in code):** a row's fields are chosen in 2 steps:
1. `classifyRecordKind` picks a card KIND (money/message/event/…). Precedence:
   (a) the manifest's DECLARED field types (`x_pdpp_type` on schema.properties →
   `field_capabilities[].type`) mapped to signals (money/geo/activity/person/text/
   temporal) — THE INTENDED PATH; (b) fall back to `connector::stream` name heuristics;
   (c) fall back to field-name regexes (MESSAGE_FIELD_RE, etc.).
2. `buildRecordPreview` fills the slots (title/body/amount/author) by HARDCODED
   field-name lists, first-match: TITLE_FIELDS, BODY_FIELDS (content/text/message/body/
   snippet/memo/purpose/topic), AUTHOR_FIELDS, money heuristics.
3. FeedRow renders: title = preview.title ?? summary; snippet = preview.body ??
   preview.amount ?? summary; role = preview.author.
→ So `message_bodies` shows a body because a field is literally named body/content/text.
   A connector whose body field is `transcript` or title is `headline` gets nothing →
   falls to the generic one-line `summary`. The selection is GUESSED, not declared.

**THE KEY FINDING (the design is mostly built + accepted, but DORMANT):** the
declared-type path ALREADY EXISTS and is shipped+tested+green (openspec archives
`2026-05-31-complete-explorer-slvp-ideal` + `2026-06-01-add-explorer-live-presentation-
types`). The manifest can declare `x_pdpp_type` per field; the server surfaces it; the
Explorer PREFERS it over the heuristic (`record-kind.ts:222-240`). The owner audit
named the gap precisely: "a manifest-typing gap, NOT a UI gap — the design is fully
type-driven; every card kind dispatches from declared schema field types, not connector
branching." It's dormant only because **no first-party manifest declares `x_pdpp_type`**
(grep = 0); the pilot added it to chase + gmail only. Manifests ALSO already carry
stream-level `display.label` / `display.detail` (spec-core.md:806-809, authorship
principle: connector-authored, client MUST NOT override) and `views` (named field sets).

**THE REMAINING SLVP GAP (precise):**
(i) `x_pdpp_type` drives the card KIND (layout), but per-field ROLE selection
    (which `text` field is the title vs the body) STILL uses hardcoded field-name lists
    in record-preview.ts even on the declared path. The manifest needs to declare the
    ROLE (title/body/amount/time/author/thumbnail), or the type vocabulary must
    distinguish them, so buildRecordPreview reads roles instead of guessing names.
(ii) First-party manifests don't declare types → the brittle heuristic is what runs
    live. Feed real manifests (extend the chase/gmail pilot to the live set).
(iii) Per Tim: "not using brittle heuristics is more important than a perfect label."
    The fallback for UNDECLARED fields must be HONEST + generic (record identity + a few
    raw declared fields), NOT a confident field-name guess. Retire/last-resort the
    BODY_FIELDS/stream-name heuristics; a record with no declared roles shows an honest
    generic card, never a wrong guessed one.

DECISION (Tim): reuse the spec's EXISTING display vocabulary (`x_pdpp_type`,
`display.label/detail`, `views`, semantic classes) — extend only at a genuine gap (the
field ROLE), flagged as a proposed spec addition for review, never a unilateral change.
This is the most reference-honest item: it makes the manifest the source of truth for
presentation and the client a faithful renderer + honest-degrader.

## The shape of the work
This is no longer a bug list — it's a coherent Explore redesign with 4 workstreams:
(A) the query/filter/search model, (B) interaction defects, (C) affordance cleanup,
(D) manifest-driven arbitrary-connector presentation, all on top of the
count==reachability + collapse-dynamics design already grounded. SLVP-ideal, no
compromise: each driven by prior art in/added-to the corpus, adversarially checked,
then built + verified live.
