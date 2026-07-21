## Context

The owner report, captured H-E-B research, and current connector establish
five concrete gaps:

1. `orders` has a structured in-page source but is parsed from rendered text.
2. Existing evidence cannot establish whether the authenticated order-items
   GraphQL response contains a direct GTIN/UPC; it contains no operation name
   or response body. The only currently observed item identifier is the
   provider-scoped `product_id` from the order-detail link.
3. A zero-order list page is declared terminal merely because `pageNum > 1`.
4. A mid-run authentication/challenge failure latches and defers every
   remaining detail attempt without one bounded owner-assisted re-probe.
5. The ideal claim requires evidence from a real account, not fixtures alone.

The current runtime already owns browser lifecycle, opt-in fixture capture,
trace checkpoints, `DETAIL_GAP`/`DETAIL_COVERAGE`, and generic browser
assistance. The connector owns H-E-B source parsing, pagination policy, and
detail recovery. This division is retained: no connector protocol plumbing
or H-E-B-specific owner surface is introduced.

`docs/north-star.md` and `docs/research/INDEX.md` were requested but are not
present in this clean worktree. This design relies on the supplied owner
instructions, `openspec/README.md`, the current H-E-B code/fixtures/tests,
`docs/research/heb-*.md`,
`docs/research/product-identity-enrichment-boundary-2026-07-15.md`, and the
original session report. No new web research or live-data access occurred.

## Decision

### 1. Parse source data at the boundary and keep DOM as a compatibility fallback

Add a parser for the embedded, JSON-parseable `__NEXT_DATA__` script and its
`props.pageProps.orders[]` data. It is the preferred source whenever it
parses into valid per-order values. Existing fields keep their current
meaning; the structured source only supplies the same value through a more
reliable path, or an entirely new nullable field. The exact compatibility
mapping, decided against the current schema (`schemas.ts`/`types.ts`) and to
be confirmed against the captured structured shape before implementation:

| Existing/new field | Compatibility decision |
| --- | --- |
| `status` | Keeps its current meaning: the human-readable status message. The structured source's status text (if present) populates this field only if it is a human-readable message equivalent to the current DOM-scraped value; it does not become a machine code. |
| `status_code` (new, nullable) | Added only if the structured source carries a distinct machine-readable status value (for example a short enum-like code) separate from the human-readable message. Never derived from `status` by transformation. |
| `order_date` | Keeps its current meaning: the owner-visible fulfillment/order calendar date (`YYYY-MM-DD`). If the structured source instead supplies a UTC timestamp, it may populate `order_date` only if fixture evidence proves the truncated calendar date is identical to the current DOM-derived value for the same orders; otherwise the DOM-derived value remains authoritative and the timestamp is not used for this field. |
| `fulfillment_method` | Keeps its current `curbside`/`delivery`/`unknown` enum and meaning. A structured fulfillment-type value maps into this enum only through an explicit, evidenced value-to-value mapping table written once the structured values are captured; any unmapped or unrecognized structured value maps to `unknown` rather than being guessed. |
| `timeslot_start`, `timeslot_end` (new, nullable) | Added only if the structured source carries an evidenced delivery/pickup timeslot start and end value with unambiguous meaning. Exact names as given; no alternate spelling. |
| `store_name` (new, nullable) | Added only if the structured source carries an evidenced fulfilling-store name value. |
| `unfulfilled_count` (new, nullable) | Added only if the structured source carries an evidenced count of unfulfilled line items, distinct from `item_count`. |
| `item_count` | Keeps its current meaning: the order's item count. A structured `productCount`-shaped value populates this existing field only if fixture evidence proves it is identical in meaning to the current value; it does not become a second field. No duplicate `product_count` field is added merely because the upstream source spells the value differently. |
| `fulfillment_location` | Keeps its current meaning and value. A structured fulfillment-location value replaces the DOM-scraped value only if fixture evidence proves semantic equivalence; otherwise the DOM-scraped value remains authoritative for this field. |

The actual emitted record remains schema-validated. If the script is absent,
malformed, lacks a usable order array, or an individual structured row cannot
meet the parser's trustworthy shape, the existing DOM parser supplies that
page/row. The fallback is observable in diagnostics/capture labels so it
cannot silently become the normal path. Existing keys, fields, date cursor,
fingerprint behavior, `order_items` composite key, and null semantics remain
unchanged. New fields are nullable and additive in the Zod schema, manifest,
views, and query affordances only when their values and semantics support the
affordance, and only after the semantic-equivalence tests above pass against
the existing DOM-derived values on the same captured orders.

This is deliberately a data-shaped parser, not a generic Next.js extraction
framework. The source path is one connector concern; a shared abstraction
would expose a shallow interface over a single provider's nesting choices.

### 2. (Historical, deferred) Discover the authenticated item contract through a dedicated, restricted capture mode

**Status: DEFERRED, not active design.** This decision record exists only as
a historical trace of an idea that was implemented and then removed; it does
not describe current or planned behavior and carries no acceptance
obligation.

- **Date deferred:** 2026-07-15.
- **Purpose (historical):** determine, via a one-shot restricted network
  observer scoped to a single owner-selected order-detail navigation,
  whether H-E-B's authenticated order-item GraphQL response carries a named
  GTIN/UPC/EAN field — and, if so, add a nullable `gtin` field sourced from
  it.
- **Not live-exercised:** the discovery mode was built and unit-tested but
  never wired to run against a real account; no live capture was ever taken,
  so the GTIN branch decision (named field exists vs. does not) was never
  made either way.
- **Provenance:** built in `ae8942b1d`, wired into the real order-detail path
  in `465b74dd4`, then removed in full (module, wiring, and tests) by the
  commit that deferred this work — see `tasks.md` sections 1 and 3 for the
  removal record.
- **Current state:** the connector has no order-item network-discovery code,
  no response observer, and no `gtin` field anywhere in schema, manifest,
  types, or emitted records. `product_id` remains the sole item identifier.

### 3. Make maxPage completion the proof of pagination honesty

Replace `pageNum > 1` in `classifyEmptyListPage` with `maxPage`-bounded
completion as the definition of normal completion: successfully parsing
every list page from page 1 through the source-advertised `maxPage` with at
least one order on every page that is expected to contain orders **is** the
terminal proof. No separate "no more orders" sentinel copy is required or
added — `maxPage` is the source's own advertised bound, and honestly
exhausting it is what "complete" means. A speculative request to
`maxPage + 1` is not required either; the walk is proven complete once it has
honestly consumed every page the source itself advertised.

**`maxPage` is resolved by a structured-primary, DOM-fallback contract, not by
`parseMaxPage` alone.** The structured `__NEXT_DATA__` source carries
`props.pageProps.pages` (a list of page links, e.g.
`[{to:"?page=1"},…,{to:"?page=4"}]`) and `props.pageProps.page` (the current
page). When present and parseable, `maxPage` SHALL be derived as the maximum
`?page=N` found in `pages[]`; this structured value is primary. `parseMaxPage`
(the existing DOM nav scrape) is used only as a fallback when the structured
`pages[]`/`page` metadata is absent or unparseable on that page.

Today's `parseMaxPage` returns `1` for both a genuine single page and a
missing-nav page (`parsers.test.ts:118-119` asserts missing-nav→1), which
cannot satisfy "missing pagination metadata SHALL fail closed" — the two cases
are indistinguishable. The pagination contract SHALL change so that "true
single page" and "metadata absent/contradictory" are distinguishable outcomes
at both the structured and DOM layers: a resolver returns one of (a) a
resolved `maxPage` value (including a genuine `maxPage: 1`, distinguished by
the presence of trustworthy metadata that affirmatively asserts one page —
structured `pages: [{to:"?page=1"}]`/`page: 1`, or an equivalent affirmative
DOM signal), or (b) an explicit "absent/contradictory" signal distinct from
any numeric value, never silently coerced to `1`. Structured `pages[]`
conflicting with structured `page`, or DOM nav conflicting with itself, is
"contradictory," not "single page."

Every empty page encountered at or before `maxPage` is an error, not a
possible terminal signal: it emits diagnostic `SKIP_RESULT` evidence and
fails closed, and it must not advance the cursor or report history complete.
Missing or internally contradictory pagination metadata (for example neither
structured `pages[]`/`page` nor DOM `parseMaxPage` yielding a resolved value,
conflicting max-page links, or no pagination nav on a page whose order count
implies more pages exist) is treated the same way — fail closed with
diagnostic evidence, never a silent single-page default. Tests cover: honest
`maxPage` completion from structured `pages[]`, honest `maxPage` completion
from DOM fallback when structured metadata is absent, a genuine single-page
run correctly resolved as `maxPage: 1` (not conflated with absent metadata),
an empty page before `maxPage` (error), missing pagination metadata at both
layers (error), and contradictory pagination metadata (error) — alongside the
existing auth/Incapsula/selector-drift `classifyEmptyListPage` branches, which
are unchanged.

### 4. Repair once on an owner-started run, then latch; latch-only on unattended runs

`polyfill-runtime` already forbids an automatic browser refresh from opening
manual handoff (`openspec/specs/polyfill-runtime/spec.md`, "Polyfill
manifests MAY declare refresh policy hints": automatic refresh is recommended
only after owner-authenticated browser state exists, and "an owner-started
manual run MAY perform the interactive auth repair path"). The runtime passes
the current run's trigger kind and automation mode to the connector child
process as bounded non-secret metadata for exactly this purpose (same spec,
"Runtime SHALL expose bounded run automation metadata to connector
children"); the ChatGPT connector already reads this via
`PDPP_RUN_TRIGGER_KIND` (`src/auto-login/chatgpt.ts`). H-E-B's mid-run repair
uses the same primitive rather than inventing a connector-specific one.

Extend the existing run flag with explicit recovery state, not an unbounded
retry counter, and branch on trigger kind/automation mode before ever
attempting interactive repair:

- **Unattended run:** on the first detail failure classified as a session
  loss, Incapsula block, or challenge, the connector SHALL NOT open the
  generic browser/manual assistance surface. It latches
  `sessionRepairRequired` immediately and defers the affected and remaining
  details using existing `DETAIL_GAP`/`owner_repair_required` evidence,
  without interaction.
- **Owner-started manual run:** on the first such detail failure, the
  connector MAY spend one shared run-scoped `manualAction` attempt (named
  primitive: `manualAction` from `browser-handoff.ts`) with safe
  provider-specific instructions, then re-use the existing H-E-B session
  probe (`probeHebSession`) after the assistance resolves. If the re-probe
  succeeds, it waits the existing bounded polite jitter and retries only the
  affected detail once, continuing only if that retry succeeds. If
  assistance/probe/retry fails, or a second such failure occurs in the same
  run, it latches `sessionRepairRequired` and defers the affected and
  remaining details the same way the unattended path does.

The repair-attempt state is run-scoped, does not persist a password, does not
alter session enrollment, and does not create an H-E-B dashboard branch. The
same latch applies during old-gap recovery and forward scanning, so the two
paths cannot each spend an independent repair attempt on an owner-started
run — one shared attempt is a reasonable bound; one interactive prompt on
every unattended run is not, and is exactly what this split prevents. This
makes the state/effects explicit and bounds both provider pressure and owner
interruption.

Browser-capacity allocation is not part of this behavior: an unavailable
browser surface is an external prerequisite handled by the separate capacity
lane and is reported through its existing typed lifecycle rather than being
misclassified as an H-E-B challenge.

### 5. Migration compatibility and verification

All changes are additive or fall back to current behavior:

| Surface | Compatibility decision |
| --- | --- |
| Existing order and item fields | Keep names, types, null behavior, primary keys, relationships, cursor, and records unchanged. |
| Added order fields | Nullable and additive; older stored rows/readers remain valid. |
| `product_id` | Never rename, reinterpret, normalize, or replace in this change. |
| Collection runtime | Retain existing RECORD/STATE/SKIP_RESULT/DETAIL_GAP/DETAIL_COVERAGE and generic assistance contracts. |
| Capture | Off by default; diagnostics cannot change run success or provider requests. |

Fixture/unit tests must prove parser precedence and fallback, malformed
structured data, semantic-equivalence of each mapped order field against its
existing DOM-derived value, `maxPage` completion proof, empty-page-before-
`maxPage` fail-closed, missing/contradictory pagination-metadata fail-
closed, unattended-run zero-interaction latch, owner-started-run one-repair
success, owner-started-run one-repair failure/latch, coverage accounting,
manifest schema/affordance honesty, and legacy record validation. A real
owner account then supplies the final acceptance evidence. Browser capacity
is verified by its owning lane, not this change.

## Rejected Alternatives

- **Generic identifier ontology or nested `identifiers` object:** rejected.
  One evidence-gated scalar does not justify a cross-connector query/provenance
  model; nested fields would create undeclared manifest/query behavior.
- **External matcher or `product_id` → GTIN resolver:** rejected. It would
  turn an observed purchase fact into an inference and hide its confidence.
- **Product page/catalog crawl:** rejected. Product pages are non-owner
  catalog enrichment, have higher Incapsula risk, and would conflate catalog
  coverage with order collection.
- **Treat a numeric H-E-B ID as a GTIN:** rejected. Syntax/checksum cannot
  prove identifier semantics or association with the purchased line.
- **GraphQL client/replay before capture:** rejected. Existing evidence has
  no operation name, variables, or response schema; guessing could create an
  unbounded, unauditable request surface.
- **`pageNum > 1` or a generic empty-page heuristic as terminal proof:**
  rejected. It can turn selector drift, auth, or failed navigation into false
  completeness.
- **A speculative `maxPage + 1` request or a live-captured empty-terminal
  fixture as a completeness requirement:** rejected. `maxPage` is the
  source's own advertised bound; honestly parsing through it is the proof.
  Requiring one more request beyond what the source advertises, or requiring
  a live capture of an empty page that may not be reproducible on demand,
  adds provider-request/session risk without adding honesty.
- **Retry/hand off for every failed detail, on every run:** rejected. It
  amplifies bot challenge pressure and owner interruptions, and would open
  interactive assistance even on unattended/scheduled runs — which the
  runtime's refresh-policy contract already forbids. One shared run-scoped
  attempt, gated on owner-started manual-run trigger metadata, followed by
  latch/defer, is the bounded recovery contract.
- **Connector-specific owner UI or new run-assistance primitive:** rejected.
  Existing generic browser/manual assistance and the existing trigger-kind/
  automation-mode metadata are the correct product seams.
- **Browser-capacity work in this change:** rejected. It is external
  infrastructure allocation already owned by another lane.

## Ideal Stop Condition

DEFERRED (2026-07-15): the former item 2 (product-identity/GTIN, which
depended on Decision 2's discovery mode) has been removed from this list, not
merely marked inapplicable — that mode was removed from the connector
entirely; see Decision 2 above and `tasks.md` sections 1 and 3. The list
below is renumbered and is now the complete, current stop condition; it
carries no residual product-identity/GTIN obligation.

G1 alone is insufficient. The connector may be called **ideal only when all
five** of the following hold; this list is the exact stop condition for this
change:

1. **Structured source of truth for BOTH streams.** Orders read from
   `__NEXT_DATA__`/GraphQL (G1). Items read from the authenticated order-items
   GraphQL response (G3/G6), *or* a written, evidence-backed determination
   that DOM scraping is the only available item source and is stable. No
   stream depends on brittle free-text regex where a structured contract
   exists in the same fetch.
2. **Pagination completion honesty (G4a).** `classifyEmptyListPage` no
   longer trusts `pageNum > 1` alone; normal completion is proven by
   successfully parsing every list page from page 1 through the
   source-advertised `maxPage`, and every empty page at or before `maxPage`
   fails closed with diagnostic evidence rather than being treated as
   possibly terminal. Missing or contradictory pagination metadata also
   fails closed rather than silently defaulting to one page. This does not
   require a speculative `maxPage + 1` request or a live-captured
   empty-terminal-page fixture — the source's own advertised bound, honestly
   exhausted, is the proof. This is a coverage-honesty gate, not a nicety —
   without it the connector can under-report and look healthy.
3. **Mid-run recovery meets the design contract for the applicable trigger
   kind, or the gap is a ratified accepted-limit.** On an owner-started
   manual run, the mid-run Incapsula/session-repair path does one shared
   re-probe/retry per the design instead of latch-and-defer-all-remaining. On
   an unattended run, latch-and-defer-all-remaining without interaction is
   the correct behavior, not a gap — the runtime's refresh-policy contract
   forbids automatic browser refresh from opening manual handoff. Either the
   owner-started path is proven, **or** a reduced surface beyond that split
   is explicitly accepted and documented as a known limitation with owner
   sign-off (not left as an unflagged TODO). Ideal ≠ every capability; ideal
   = no *unacknowledged* gap.
4. **Order-status handling is honest about what one account can prove.**
   `status` keeps its current human-readable meaning; a `status_code` field
   (if the structured source evidences one) is an honest bounded or open
   string reflecting the values actually observed — not a closed enum
   asserted from one account's order history. `status_code` is declared a
   closed enum only if a source-provided schema (not observed history alone)
   proves the domain is closed. `group_by[status]` does not require a closed
   enum to be trustworthy; it requires the values it groups to be honestly
   sourced, which #1 and this item establish.
5. **Live end-to-end acceptance on a real account, with gates attributed to
   how they were proven.** The connector distinguishes which of the above are
   live-proven (require a real account: all advertised order pages honestly
   walked, item structured-source verified) from which are
   deterministic-test-proven (fail-closed branches: empty-page-before-
   `maxPage`, missing/contradictory pagination metadata, unattended-run
   zero-interaction, owner-started-run repair failure/latch). A live
   challenge or session failure is never deliberately induced merely to call
   the connector ideal — those branches are proven by deterministic tests
   instead. The full honesty/coverage suite plus `pnpm stream-health:audit`
   passes against the live instance for the live-proven gates — the
   connector's own standard for "proven."
