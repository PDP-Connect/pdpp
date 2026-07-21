## 1. Evidence and contract

- [x] 1.1 Re-read the current H-E-B connector, manifest, fixture/test suite,
  H-E-B research, identity-boundary decision, owner report, and this change
  before implementation; preserve this change's no-crawl/no-inference scope.

DEFERRED: the dedicated, opt-in H-E-B order-item network-discovery mode
(`PDPP_HEB_DISCOVER_ORDER_ITEM_NETWORK`) originally planned under this
section — and the downstream GTIN branch-selection work in section 3, which
depends on it — has been removed from this change's active scope. The
standalone module (`connectors/heb/order-item-discovery.ts`), its wiring into
`resolveOrderDetail`/`fetchOrderDetail`, and its dedicated tests were built,
then wired, then deleted without ever running against a live account; no
production H-E-B run ever exercised the flag. The idea is preserved via git/
PR history (see the now-reverted wiring commit) rather than as dead code
gated by an unused flag. Ordinary H-E-B order/order-item collection
(sections 2, 4, 5 below) is unaffected and does not depend on this mode.

## 2. Structured orders with compatible fallback

- [x] 2.1 Add pure `__NEXT_DATA__` order extraction and boundary parsing for
  the captured `pageProps.orders[]` shape; parse unknown source data before
  use and retain row-level diagnostics.
- [x] 2.2 Prefer a valid structured row and fall back to current DOM parsing
  only for absent/malformed/unusable structured data. Keep existing order
  identity, cursor, record fields, and null semantics unchanged.
- [x] 2.3 Apply the exact `design.md` Decision 1 compatibility mapping per
  field, refined against direct inspection of the retained live captures
  (see the final report for the underlying evidence): `status` populated from
  `orderStatusMessageShort` (proven human-readable-message equivalent by
  definition — it literally is that field); `status_code` (nullable) added,
  populated from the distinct machine-readable `status` value (e.g.
  `PAYMENT_RECEIPTED`); `order_date` NOT populated from the structured
  timeslot — no capture pairs a structured row against its own DOM-rendered
  order_date for the same order, so truncation-equivalence is unproven and
  DOM stays authoritative; `fulfillment_method` NOT mapped from structured
  `fulfillmentType` — the only observed value (`CURBSIDE_DELIVERY`) appeared
  on pages whose DOM showed BOTH "Curbside at"/"Delivery to" text, so no
  evidenced value-to-value correspondence exists; `timeslot_start`,
  `timeslot_end`, `store_name`, `unfulfilled_count` added (nullable, exact
  names, evidenced with unambiguous meaning); `item_count` NOT populated from
  `productCount` — no paired DOM+structured capture proves identical meaning;
  `fulfillment_location` NOT replaced — no evidenced correspondence to
  `store.name`/`address.nickname`. Applied across types, schemas, emitted
  records, manifest views, and only evidence-supported query affordances.
- [x] 2.4 Hand-authored a minimal, structurally-faithful synthetic fixture at
  `connectors/heb/__fixtures__/orders-list-nextdata.html` transcribing the
  exact `__NEXT_DATA__` key/nesting shape observed in the retained live
  captures (`heb-live-html/{02,03,05,06,07}-orders-list.html`), with every PII value (orderId, store
  name/lat-long, address nickname, price) replaced by an obviously-synthetic
  placeholder — verified programmatically to contain none of the real
  observed values. Did not run the raw capture through the fixture-scrubber
  pipeline / a raw capture directory per owner mid-task safety steer (no live
  HTML ever staged in the git worktree, even temporarily); a dedicated
  connector scrub-rules.ts was not independently justified for this one
  fixture. Added unit/integration tests for precedence, malformed JSON,
  missing rows, per-row fallback, old DOM fixture compatibility, schema
  validation, and the NOT-populated fields above (each has an explicit test
  asserting the value stays null/DOM-authoritative, functioning as the
  semantic-equivalence gate documentation since no equivalence was provable).

## 3. Item-source and product-identity evidence gate

DEFERRED: this section (owner-attended live discovery run, GTIN Branch A/B
selection, and their fixture tests) depended entirely on the order-item
network-discovery mode removed from section 1, and is deferred along with
it — see section 1's note. `product_id` remains the only item identifier the
connector emits; no `gtin` field exists in schema/manifest/types.

## 4. Coverage and bounded recovery

- [x] 4.1 Change the `maxPage` contract so structured `pages[]`/`page` from
  `__NEXT_DATA__` (`props.pageProps.pages`, `props.pageProps.page`) is the
  primary resolution source — `maxPage` is the maximum `?page=N` found in
  `pages[]` when present and parseable — and the existing DOM `parseMaxPage`
  scrape is used only as a fallback when structured pagination metadata is
  absent or unparseable on that page. The resolver SHALL return one of: a
  resolved `maxPage` (including a genuine single-page `maxPage: 1`,
  affirmatively signaled by `pages: [{to:"?page=1"}]`/`page: 1` or an
  equivalent DOM signal) or an explicit absent/contradictory signal distinct
  from any numeric value — never silently coerced to `1`. Replace
  `pageNum > 1` in `classifyEmptyListPage` with this `maxPage`-bounded
  completion: successfully parsing every list page from page 1 through the
  resolved `maxPage` is normal completion. Do not add a "no more orders"
  sentinel-copy requirement and do not require a speculative `maxPage + 1`
  request or a live-captured empty-terminal-page fixture.
- [x] 4.2 Make every empty page at or before `maxPage` an error: emit
  diagnostic `SKIP_RESULT` evidence and fail closed without advancing the
  cursor or reporting history complete. Make an absent/contradictory `maxPage`
  resolution (from either the structured or DOM layer, per 4.1) fail closed
  the same way rather than silently defaulting to a single page. Add
  regressions for: honest `maxPage` completion from structured `pages[]`,
  honest `maxPage` completion from DOM fallback when structured metadata is
  absent, a genuine single-page run correctly resolved as `maxPage: 1` (not
  conflated with absent metadata), empty page before `maxPage`, missing
  pagination metadata at both layers, contradictory pagination metadata,
  selector drift, Incapsula, login/challenge, and failed navigation; only
  honest `maxPage` completion may stop pagination without an error/
  diagnostic.
- [x] 4.3 Read the runtime's trigger-kind/automation-mode metadata (the same
  primitive `PDPP_RUN_TRIGGER_KIND` the ChatGPT connector reads) to
  distinguish an owner-started manual run from an unattended run before any
  interactive repair decision.
- [x] 4.4 Unattended-run path: on the first detail failure classified as
  session loss, Incapsula block, or challenge, do NOT open generic browser
  assistance. Latch `sessionRepairRequired` immediately and emit existing
  `owner_repair_required` detail-gap evidence for the affected and remaining
  details without interaction.
- [x] 4.5 Owner-started-manual-run path: implement one shared run-scoped
  `manualAction` attempt through existing generic browser assistance,
  `probeHebSession` re-probe, bounded polite delay, and one retry of the
  affected detail. Share and latch this attempt's state across detail-gap
  recovery and forward scanning so the two paths cannot each spend an
  independent attempt. After failed/consumed repair or a second challenge,
  emit existing `owner_repair_required` detail-gap evidence and defer
  remaining details without further browser attempts.
- [x] 4.6 Add deterministic tests for: unattended run — zero interaction,
  immediate latch, correct deferred-gap evidence; owner-started run — repair
  success, failed re-probe, retry failure, second challenge, old-gap/forward
  shared budget, coverage counts; and, for both paths, no owner credential
  persistence and no connector-specific UI branch.

## 5. Status, manifest, and verification

- [x] 5.1 Parse `status`/`status_code` from the values actually observed in
  live structured source evidence. Keep the schema an honest bounded/open
  string reflecting observed values; declare a closed enum only if a
  source-provided schema (not observed account history alone) proves the
  domain is closed. Do not claim or implement a full/closed order-status
  value set from one account's history. `group_by[status]` correctness
  follows from honest sourcing, not from enum closure.
- [x] 5.2 Update manifest version/copy, views, schema, role, and query
  assertions for every additive field and the selected identity branch;
  retain all migration compatibility documented in `design.md`.
- [x] 5.3 Run focused H-E-B parser/schema/manifest/integration/auto-login and
  fixture-capture tests, then package typecheck/check/test, manifest-honesty
  and coverage/stream-health tests. Inspect the actual diff and read every
  touched file. (`pnpm stream-health:audit` itself requires a live instance —
  out of scope this pass, see 5.4.)
- [ ] 5.4 Run the owner-only live end-to-end acceptance and keep its scope
  honest about what it live-proves versus what deterministic tests already
  prove: (a) live-attended — walk all source-advertised order-list pages
  including honest `maxPage` completion, verify the structured orders lane,
  verify one owner-started bounded repair only where it occurs naturally
  during the walk (never deliberately induce a challenge to trigger it), and
  run `pnpm stream-health:audit` against the live instance; (b)
  deterministic-only — empty-page-before-`maxPage` fail-closed, missing/
  contradictory pagination metadata, unattended-run zero-interaction latch,
  and owner-started-run repair-failure latch are proven by the tests in
  sections 1-4, not by live reproduction. Do not call the connector ideal
  unless all applicable stop-condition items in `design.md` are evidenced,
  each attributed to (a) or (b); the order-item network-discovery/GTIN stop-
  condition item no longer applies — see section 1 and 3's deferral notes.
- [x] 5.5 Before closeout, grep all touched files for stale `pageNum > 1`,
  old terminal-inference comments, product-ID-as-GTIN claims, and obsolete
  latch-only (non-trigger-gated) recovery wording; record residuals honestly.
  (Clean — no stale residuals found; see final report for the exact grep
  output.)

## 6. OpenSpec validation

- [x] 6.1 Run `openspec validate complete-heb-structured-collection --strict`.
- [x] 6.2 Run `openspec validate --all --strict`.
