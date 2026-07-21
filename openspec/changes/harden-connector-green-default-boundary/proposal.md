## Why

A prior read-only audit (`tmp/workstreams/connector-green-default-audit-0715.md`)
found that every fail-closed derivation in the coverage/health projection is
sound, but the *construction* boundary around it is not: the only tests that
catch a new scaffolded/dishonest connector
(`connector-conformance.test.ts`, `coverage-policy-manifest-honesty.test.ts`,
`stream-evidence-strategy-manifest.test.ts`) run in
`.github/workflows/polyfill-connectors.yml`, which is explicitly non-blocking
by its own file header, and are never reached by the local
`ci:signoff`/`ci:mode:local` merge-gate path documented in
`docs/reference/ci-mode.md`. Separately, the conformance roster's
exhaustiveness check only proved that roster keys resolve to real manifests,
not that every manifest resolves to a roster bucket — an unlisted connector
(`public_listing.listed: false`/absent) escaped every conformance check.

Hosted GitHub Actions are intentionally disabled for this repo (local-CI mode
is the active posture); this change does not re-enable or depend on any
hosted workflow. It closes the local-signoff gate instead.

An unconditional write-time presence requirement for
`coverage_strategy`/`freshness_strategy` was evaluated and rejected: it broke
registration for 80+ existing minimal test/legacy connector manifests that
never declared those fields (see Design Notes below) — the wrong boundary
for a developer-time authoring gate. Presence stays a build-time-only
guardrail, now reachable from `ci:signoff`.

## What Changes

- `scripts/ci-mode.mjs signoff` now runs the connector-conformance test
  files (`stream-evidence-strategy-manifest.test.ts`,
  `coverage-policy-manifest-honesty.test.ts`, `connector-conformance.test.ts`)
  before posting a success status, whenever the diff against `--base`
  (default `origin/main`) touches `packages/polyfill-connectors/`,
  `reference-implementation/manifests/`, or the gate's own implementation.
  The suite reads both manifest roots, so a reference-manifest-only change
  must not bypass its coverage/freshness declaration check. There is no
  bypass flag: an undeterminable diff fails signoff outright, a
  dirty/unpushed worktree fails signoff outright (no `--force`), and `--sha`
  must equal `HEAD`.
- The same local-signoff path now runs the source-derived
  `stream-evidence:check` when either shipped manifest root changes, or when
  the inventory producer/artifact changes. This prevents a reference-manifest
  `required`/policy edit from posting the required local status while the
  committed inventory still describes the old evidence contract.
- Signoff reads changed paths through `git diff --no-renames --name-only -z`,
  not Git's display-oriented quoted text output, so Unicode and
  embedded-newline names below either protected root cannot evade the prefix
  boundary and a rename out of either root still reports the protected
  deletion.
- A change to the gate's own files (`scripts/ci-mode.mjs`,
  `scripts/ci-mode.test.mjs`, `package.json`, or any of the three pinned
  connector-conformance test paths) also runs `ci:mode:test` — the gate
  cannot weaken itself without exercising its own tests.
- Write-time manifest validation (`connector-manifest-validation.ts`,
  reached from `registerConnector()`) now rejects a stream that declares an
  accepted-coverage `coverage_policy` (`deferred`/`inventory_only`/
  `unavailable`/`unsupported`) together with `required` not explicitly
  `false` — mirroring the existing build-time
  `coverage-policy-manifest-honesty.test.ts` check at the DB write path.
  This is unconditional and safe for legacy/third-party manifests: no
  manifest could ever have legitimately depended on that contradiction.
  `coverage_strategy`/`freshness_strategy` presence is intentionally NOT
  added to this write path (see Why).
- `connector-conformance-roster.ts` gains two new roster categories,
  independent of `public_listing.listed`: `REAL_UNLISTED_CONNECTORS` (a real,
  non-scaffold collector with a real behavioral-oracle test file, not yet
  publicly listed — apple_health, google_takeout, ical, imessage, spotify,
  twitter_archive) and a manifest-derived `DEPRECATED_UPSTREAM_STATUS` set
  (pocket — upstream shut down, real code, can never collect or be listed
  again). `connector-conformance.test.ts`'s exhaustiveness test now asserts
  every one of the 33 manifest connector keys resolves to exactly one of the
  four disjoint categories (`PRODUCTION_READY_CONNECTORS`,
  `REAL_UNLISTED_CONNECTORS`, `KNOWN_SCAFFOLD_CONNECTORS`, or
  deprecated-upstream) — closing the `listed: false` silent-opt-out gap.
- Audited all `parent_detail_accounting` connectors with real collectors
  (amazon, chase, chatgpt, heb, usaa, whatsapp) for the served-detail-gap
  consumption defect class fixed only in Gmail (#324/#325). All six are
  CLEAN or structurally not-applicable — no code change required. See
  `tmp/workstreams/connector-green-default-impl-0715.md` for per-connector
  evidence.
- Docs (`docs/reference/ci-mode.md`) updated to describe the new signoff
  gate mechanics, and the generated stream-evidence inventory is refreshed
  after the Slack optional-stream requiredness correction.

## Design Notes: rejected approaches

**Unconditional write-time `coverage_strategy`/`freshness_strategy`
presence.** Threading a `priorStreamNames`/`skipPresenceCheckForLegacyRead`
compatibility boundary through `registerConnector()` was attempted and
reverted after the full reference-implementation test suite showed 80+
failures across ~217 test contexts (minimal test manifests, `POST
/connectors`-reachable third-party manifests, and `getConnectorManifest`'s
own read-path re-validation) — this check belongs at build-time authoring
only (already enforced, 100% clean today), reachable from the merge gate via
`ci:signoff`, not as a runtime registration gate that would retroactively
break every already-installed connector lacking these fields.

**Unconditional `required` presence at write time.** Same rejection
reasoning: `required` defaults to `true` by established semantics: omission
is not itself a defect, and a build-time-only ratchet
(`coverage-policy-manifest-honesty.test.ts`'s `KNOWN_MISSING_REQUIRED`
grandfather map) already exists for exactly this. No new write-time
enforcement was added for `required` presence.

**Heuristic scaffold detection (source line count).** A `hasOnlyUnconditionalSkipResult`
line-count/text heuristic to auto-verify `REAL_UNLISTED_CONNECTORS` entries
was written and removed — a heuristic is not a semantic gate, and category
membership must be an explicit, reviewable roster edit, not inferred from
source shape (which also produced conflicting line-count estimates across
independent checks in this session).

## Capabilities

- Modified: `polyfill-runtime` — two independent requirements added:
  1. write-time registration validation rejects the accepted-policy/`required`
     contradiction (a `registerConnector()` behavior change);
  2. the connector-conformance roster becomes exhaustive over all manifest
     keys (a build-time test-suite change; no registration/runtime behavior
     change). `coverage_strategy`/`freshness_strategy` presence is NOT
     enforced at registration — see Design Notes.
- Modified: `reference-implementation-governance` (local signoff gate runs connector-conformance suite + self-tests on gate changes)

## Impact

- `scripts/ci-mode.mjs`, `scripts/ci-mode.test.mjs`,
  `docs/reference/ci-mode.md`.
- `reference-implementation/server/connector-manifest-validation.ts`,
  `reference-implementation/test/connector-manifest-validation.test.js`.
- `packages/polyfill-connectors/src/connector-conformance-roster.ts`,
  `packages/polyfill-connectors/src/connector-conformance.test.ts`.
- No protocol, manifest schema, or connector runtime behavior changes. No
  hosted CI/workflow changes. No live deploy or data migration.
