## ADDED Requirements

### Requirement: Connector registration SHALL reject a required stream with an accepted-coverage policy

`registerConnector()` write-time validation SHALL reject a manifest stream that declares an accepted-coverage `coverage_policy` (`deferred`, `inventory_only`, `unavailable`, or `unsupported`) together with `required` not explicitly `false` (including `required` omitted, which defaults to `true`). This mirrors the existing build-time `coverage-policy-manifest-honesty.test.ts` check at the database write path, so the contradiction cannot be registered merely by skipping that build-time test.

This check is unconditional — it applies identically to new and previously-registered/re-registered connectors. No manifest could have legitimately relied on declaring a stream both load-bearing and accepted-absent; the combination is a logical contradiction regardless of when the manifest was authored.

#### Scenario: Required stream declares an accepted-coverage policy

**WHEN** a manifest stream declares `coverage_policy: "deferred"` (or `inventory_only`/`unavailable`/`unsupported`) and does not declare `required: false`
**THEN** `registerConnector()` SHALL reject the manifest with a contextual error naming the stream and the contradiction

#### Scenario: Accepted-coverage policy paired with required: false

**WHEN** a manifest stream declares an accepted-coverage `coverage_policy` and `required: false`
**THEN** `registerConnector()` SHALL accept the manifest

#### Scenario: Stream with no coverage_policy declared

**WHEN** a manifest stream declares no `coverage_policy` (defaults to `collect`)
**THEN** the required/accepted-coverage contradiction check SHALL NOT apply, regardless of the stream's `required` value

### Requirement: Connector conformance roster SHALL exhaustively partition every manifest connector into disjoint categories

Every connector key with a manifest under `packages/polyfill-connectors/manifests/` SHALL resolve to exactly one of four disjoint conformance-roster categories: publicly-listed production-ready (`PRODUCTION_READY_CONNECTORS`), a real (non-scaffold) collector not yet publicly listed (`REAL_UNLISTED_CONNECTORS`), a known unconditional-`SKIP_RESULT` scaffold (`KNOWN_SCAFFOLD_CONNECTORS`), or a manifest declaring `public_listing.status: "deprecated_upstream"`. `public_listing.listed: false` or absent SHALL NOT itself exempt a connector from every conformance category — it MUST still resolve to `REAL_UNLISTED_CONNECTORS`, `KNOWN_SCAFFOLD_CONNECTORS`, or the deprecated-upstream set.

Category membership SHALL be asserted via explicit, hand-maintained roster entries (`REAL_UNLISTED_CONNECTORS`, `KNOWN_SCAFFOLD_CONNECTORS`) or read directly from the manifest's own `public_listing.status` field (deprecated-upstream) — never inferred from a heuristic over connector source shape (e.g. line count).

#### Scenario: A connector manifest is not publicly listed and not in any roster

**WHEN** a connector manifest exists with `public_listing.listed: false` or absent, and its key appears in none of `PRODUCTION_READY_CONNECTORS`, `REAL_UNLISTED_CONNECTORS`, or `KNOWN_SCAFFOLD_CONNECTORS`, and its manifest does not declare `public_listing.status: "deprecated_upstream"`
**THEN** the conformance test suite SHALL fail, naming the unaccounted-for connector key

#### Scenario: A connector key appears in more than one roster category

**WHEN** a connector key appears in more than one of `PRODUCTION_READY_CONNECTORS`, `REAL_UNLISTED_CONNECTORS`, or `KNOWN_SCAFFOLD_CONNECTORS`, or is claimed by both a hand-maintained roster and the deprecated-upstream manifest status
**THEN** the conformance test suite SHALL fail, naming the connector and its conflicting categories

#### Scenario: A real-unlisted connector is promoted to public listing

**WHEN** a connector in `REAL_UNLISTED_CONNECTORS` has its manifest updated to `public_listing.listed: true`
**THEN** the roster entry MUST move to `PRODUCTION_READY_CONNECTORS` as a deliberate roster edit, or the conformance test suite SHALL fail on the listed/roster mismatch
