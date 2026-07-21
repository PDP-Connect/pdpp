# HEB connector — manifest design (2026-07-14)

Replaces the scaffold manifest `packages/polyfill-connectors/manifests/heb.json` and the
SKIP-only collector `packages/polyfill-connectors/connectors/heb/index.ts`. Site facts:
`docs/research/heb-site-knowledge-2026-07-14.md`. Primary in-repo precedent: **Amazon**
(`manifests/amazon.json`, `connectors/amazon/*`) — the repo's best transactional/browser-scraped
connector; secondary precedents: USAA (`parent_detail_accounting` off a parent), YNAB
(relationships/expand), GitHub (coverage-strategy variety).

## Scope decision

Two collected streams — `orders` and `order_items` — from exactly two page types the owner's
session can already reach (order list + order detail). Explicitly excluded, per owner direction
and the north-star honesty/scope bar:

- **USDA nutrition enrichment** and the **per-product page crawl** that feeds it (non-user
  catalog data; also the highest bot-detection-risk surface). Consequence: the scaffold's
  `upc`, `department`, and `nutrition` fields are **removed** — they are unsourceable without
  that crawl and were speculative (the exact "declared fields with no fetch path" anti-pattern).
- **Profile stream**: deferred, not declared in v1. Adding a stream later is cheap; shipping the
  smallest honest surface first.
- **Coupons / lists / points**: never verified reachable (the vana connector never scraped them).
  Not declared, not even as `deferred` — we don't yet know they exist as scrapeable surfaces.
- **In-store purchases**: structurally unreachable on heb.com (only curbside/delivery orders
  appear in account history). Because in-store is likely the *majority* of a typical H-E-B
  customer's spend, silence would create a false impression. Handled two ways:
  1. Prose caveat in both stream descriptions ("curbside/delivery orders only; in-store
     purchases are not available from heb.com") — the pattern the steering docs already praise.
  2. **Recommended, severable:** declare an `in_store_purchases` stream with
     `coverage_policy: "unavailable"`, `required: false`, and a minimal schema, making the gap
     machine-readable (this is exactly what the `unavailable` enum value exists for, and it
     makes HEB a positive exemplar for the bundled-coverage-honesty theme). If the honesty
     tests (presentation-role, search-affordance) fight a never-populated stream, drop it and
     keep the prose caveat only — do not weaken tests to keep it.

## Stream design

### `orders` (parent)
- `semantics: mutable_state` (status transitions after first sight), `incremental: true`,
  `coverage_strategy: checkpoint_window`, `freshness_strategy: manual_as_of`,
  `cursor_field` + `consent_time_field: order_date`.
- `primary_key: id` = H-E-B's native order id (starts with `HEB`; tighten the regex against a
  live capture, Amazon-style shape check).
- Fields:
  | field | type | roles/notes |
  |---|---|---|
  | `id` | string | native order id, pattern-checked |
  | `order_date` | string `format: date` | `x_pdpp_role: event-time`; normalized from "July 14, 2026" |
  | `fulfillment_method` | string enum `curbside\|delivery\|unknown` | derived from the "Curbside at"/"Delivery to" prefix; facet |
  | `fulfillment_location` | string, nullable | store/address text after the prefix; `primary-title` (the human-meaningful handle, like Amazon's `recipient_name`) |
  | `status` | string, nullable | raw site status; `secondary` role; facet |
  | `total` | string, nullable | display string |
  | `total_cents` | integer, nullable | canonical money (repo-wide string+cents pattern); `amount` role placement mirrors amazon.json |
  | `item_count` | integer, nullable | |
  | `fetched_at` | string `date-time` | ingest clock; no query affordances, never searched |
- Query: `range_filters` on `order_date`, `total_cents`, `item_count`; `aggregations`
  `count: true`, `sum: [total_cents]`, `group_by: [fulfillment_method, status]`,
  `group_by_time: order_date`; `search.lexical_fields: [fulfillment_location, status]`
  (no semantic fields — nothing is prose); no id/URL fields in search.
- Relationship `items` → `order_items` (`has_many`, `foreign_key: order_id`) with
  `query.expand` (`default_limit`/`max_limit` per a passing has_many example, e.g. YNAB/GitHub).
- Views: `reconciliation` (`id, order_date, total, total_cents, fulfillment_method`) mirroring
  Amazon's bank-matching view (H-E-B charges appear on USAA/YNAB streams — same real use case),
  plus `full`.

### `order_items` (detail child)
- `semantics: mutable_state`, `coverage_strategy: parent_detail_accounting`,
  relationship `order` → `orders` (`has_one`, `foreign_key: order_id`) as in the scaffold.
- `primary_key: id` = composite `${order_id}|${product_id || normalized_name}` (Amazon's
  `itemId` pattern; H-E-B is *better* off than Amazon here because `product_id` comes free from
  the detail-page href).
- Fields:
  | field | type | roles/notes |
  |---|---|---|
  | `id` | string | composite, above |
  | `order_id` | string | FK |
  | `name` | string | `primary-title` |
  | `product_id` | string, nullable | last path segment of the product href |
  | `product_url` | string, nullable | not searchable |
  | `image_url` | string, nullable | `media` role; derived CDN convention (say so in the field description) |
  | `quantity` | number, nullable | null when the free-text capture is non-numeric (weighted items) — verify live |
  | `price` / `price_cents` | string / integer, nullable | **name pending live verification**: the site shows "Price: $Y" and it is unproven whether that is unit price or line total; name it truthfully (`unit_price_*` or `line_total_*`) once proven |
  | `order_date` | string `format: date` | `event-time`; deliberate denormalization from the parent so line items are independently time-queryable ("what did I buy in June", per-month grocery aggregation) — this is where the connector's semantic value lives |
  | `fetched_at` | string `date-time` | |
- Query: `search.lexical_fields: [name]` and `search.semantic_fields: [name]` (product names
  are the archetypal owner-visible natural-language field per the authoring guide; "milk"
  should match "H-E-B Organic 2% Reduced Fat Milk"); `range_filters` on `order_date`,
  `price_cents`, `quantity`; `aggregations` `count: true`, `sum: [price_cents]`,
  `group_by_time: order_date`, `count_distinct: [product_id]`. No department facet — that data
  no longer exists without the product crawl; add it only if the detail page turns out to
  carry it.

## Capabilities / refresh policy

Mirror Amazon, not the scaffold:
- `refresh_policy`: `recommended_mode: manual`, **`background_safe: true`** +
  `assisted_after_owner_auth: true` (the shipped owner-opt-in-schedules change makes this the
  meaningful posture: manual by default, owner may opt in after proving auth),
  `interaction_posture: manual_action_likely` (Incapsula challenges; no OTP flow is known to
  exist — don't claim `otp_likely` speculatively), `bot_detection_sensitivity: high`,
  `minimum_interval_seconds: 7200`, `rationale` naming Incapsula explicitly.
- `human_interaction: ["manual_action"]` (unchanged).
- `public_listing: { listed: false, status: "unproven" }` until live-proven.
- `runtime_requirements.bindings`: `browser.required: true`, `network.required: true` (unchanged).
- `connector_key: "heb"` only (canonical; no `connector_id` needed — and per the PR #7 closeout,
  any id must equal the canonical key).

## Collector plan (for the executor — clone Amazon's shape)

Four-file layout: `index.ts` (orchestration), `parsers.ts` (pure DOM→struct, linkedom-testable),
`schemas.ts` (Zod + cruft regexes catching wrong-node grabs), `types.ts`.

1. **Session probe, two-level.** Keep the cheap cookie probe; add a deep probe that navigates to
   `your-orders` and checks landed URL against `/sign-in|/login|/challenge|/checkpoint` AND for a
   visible password form (URL alone is not trusted — Amazon precedent). Login/repair via headed
   handoff (`manual_action` interaction), then **re-probe ground truth** rather than trusting the
   interaction response.
2. **Block detection = Incapsula empty-shell heuristic** from the research doc (`_Incapsula_Resource`
   is on every page — presence alone must NOT count as blocked). On block: one headed handoff, then
   jittered backoff; a blocked/dead session mid-run latches `owner_repair_required` for all
   remaining detail fetches (blast-radius stop, no per-order hammering).
3. **List-then-detail with coverage accounting.** List pages (`?page=N`, 1.5–2.5 s hydration waits,
   polite inter-page delay) establish the required denominator; every order classifies
   `hydrated | gap | skipped`; gaps emit durable `DETAIL_GAP` with a `heb.order_detail` locator;
   one `DETAIL_COVERAGE` per run; recovery pass drains old gaps before new forward scanning.
   Bounded per-run detail budget. Copy Amazon's exhaustive `DetailFailureKind → RecoveryClass`
   switch shape.
4. **Incremental cursor.** H-E-B's list is globally paginated (not year-partitioned): walk pages
   newest-first, stop once a full page is older than `checkpoint − overlap` (~60 days overlap to
   catch status transitions), with a fingerprint cursor suppressing byte-identical re-emits.
   Expect the order-detail page to need its own parser and possibly layout variants (Amazon needed
   four).
5. **Shape-check before emit, always**; malformed rows become `SKIP_RESULT` with diagnostics.
   Empty-list-page diagnosis distinguishes "no more orders" vs selector drift vs challenge.
6. **Fixtures**: live co-pilot run with `PDPP_CAPTURE_FIXTURES=1` → scrub via the fixture-scrubber
   pipeline → committed `fixtures/heb/scrubbed/<runId>/`; parser unit tests run against fixtures
   for every layout branch.

### Live-verification checklist (co-pilot session, before finalizing schemas)
- [ ] Order-id format beyond the `HEB` prefix (tighten the Zod regex)
- [ ] "Price: $Y" on detail lines — unit price or line total? (names `unit_price_*`/`line_total_*` follow)
- [ ] Quantity free-text values — integers only, or weights/units for produce?
- [ ] Whether the detail page carries any department/category signal (would restore a facet)
- [ ] Status value set (facet cardinality sanity)
- [ ] Image-CDN derivation actually resolves for current product ids
- [ ] Whether login ever demands OTP (would flip `interaction_posture`)

## Landing gate (non-negotiable, per the scaffold post-mortem)

Manifest and working collector land **together**, fixture-proven — never a rich manifest over a
SKIP-only body (the current heb/wholefoods/doordash anti-pattern: honest-looking manifests
invisible to the build-time honesty tests because they declare neither `coverage_policy` nor
`required: false`). Before merge: full manifest-honesty suite (coverage-policy, browser,
search-affordance, presentation-role, query-affordance, schema-validation), then
`pnpm stream-health:audit` against live after deploy. Field-by-field authoring rules:
`docs/reference/connector-authoring-guide.md` (required reading for the executor).
