## Why

The live production deployment runs on Postgres. The reference implementation
already specifies, tests, and ships grant-scoped one-hop parent → child
relationship expansion on the SQLite backend (manifest-declared relations,
child grant projection, `expand_limit[]`, per-parent `has_more`). The
Postgres backend has had no expand handling: the route accepts the
parameter, but the Postgres records backend never honored or rejected it
explicitly. As a result, the live deployment cannot serve expansion even
though the contract surface, parser, and client tooling are wired to it.

The companion change `add-grant-scoped-relationship-expansion` deliberately
deferred this hydration work so the contract boundary could land
independently. Its `design.md §6` calls out this follow-up explicitly:

> `add-postgres-expand-hydration` (out of scope here) becomes a clean
> follow-up: it implements `hydrateExpandedRelations` against Postgres,
> then flips the deployment's `supportsExpand` input to `true`. No adapter
> changes required. That is the test of whether this construction boundary
> is right.

This change implements the same already-specified contract on Postgres.
After this change, the Postgres records backend honors `expand[]` /
`expand_limit[]` end-to-end with parity against the SQLite engine. The
deployment-level capability projection (advertising
`read_capabilities.expand: true`) is **deferred to a separate change**:
current main does not yet have the `projectReadCapabilities` /
`supportsExpand` capability projection foundation those wires depend on.
Flipping it cannot honestly land here without that foundation, so this
slice keeps the hydration honest and leaves the advertisement bit to its
own change.

## What Changes

- Extract the shared parser + projection helpers from `records.js` into a
  new `record-expand-helpers.js` module (`normalizeExpandRequest`,
  `buildEffectiveFilter`, `invalidQueryError`, `parseIntegerValue`,
  `normalizePrimaryKey`, `assertSafeJsonField`, `SAFE_JSON_FIELD`) so the
  SQLite and Postgres backends share one source of truth for expansion
  validation and child grant projection.
- Implement parent → child expansion hydration on the Postgres records
  backend: one batched
  `ROW_NUMBER() OVER (PARTITION BY <fk> ORDER BY <cursor>, <pk>)` query
  per relation per parent page (N+0 hydration), child grant projection
  (`fields`, `time_range`, `resources`), per-parent `expand_limit` with
  `has_more`, `has_one` vs `has_many` cardinality semantics, and
  connector-instance isolation enforced in SQL. Mirrors the SQLite
  engine's behavior on the observable response envelope.
- Preserve the existing strict-error policy: malformed/unauthorized
  expand requests reject with `invalid_expand` / `insufficient_scope`;
  `expand` remains incompatible with `changes_since` on both backends;
  manifest JSON fields that fail the `SAFE_JSON_FIELD` regex are
  rejected before any SQL interpolation.
- Add focused parity tests for the Postgres expand path under the
  `PDPP_TEST_POSTGRES_URL` env gate the existing Postgres conformance
  tests already use.

This change does **not**:

- Introduce reverse / belongs-to expansion.
- Generalize `expand[]` into a select-language.
- Change the public manifest schema, grant semantics, or record envelope.
- Flip a per-deployment `read_capabilities.expand` advertisement — that
  depends on a `projectReadCapabilities` / `supportsExpand` capability
  projection foundation not present on current main. It is a clean
  follow-up once that foundation lands.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Affects `reference-implementation/server/postgres-records.js`
  (expansion hydration implementation),
  `reference-implementation/server/records.js` (extracts shared helpers
  to `record-expand-helpers.js`),
  `reference-implementation/server/record-expand-helpers.js` (new shared
  parser + projection module), and adds a Postgres-targeted parity test
  under `reference-implementation/test/postgres-expand-hydration.test.js`
  gated on `PDPP_TEST_POSTGRES_URL`.
- After this change, Postgres deployments serve `expand` /
  `expand_limit` with parity against the SQLite engine. Advertising the
  capability via `read_capabilities.expand` is deferred to a follow-up
  change that introduces the `projectReadCapabilities` projection.
- No PDPP Core grant semantics, Collection Profile semantics, or
  manifest schema change.
- Strict-error policy preserved: requests that violate the expansion
  contract continue to reject loudly with the same structured codes.
