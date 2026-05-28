# Tasks — Connector Public Listing Honesty

## 1. Spec Delta

- [x] 1.1 Write the spec delta under
      `specs/reference-implementation-architecture/spec.md` covering the
      catalog filter, the mandatory manifest declaration, and the
      hidden+background-safe interlock.
- [x] 1.2 Run `openspec validate add-connector-public-listing-honesty
      --strict`.

## 2. Manifest Declarations

- [x] 2.1 Audit `packages/polyfill-connectors/manifests/*.json` for
      missing `capabilities.public_listing`. The 2026-05-15 audit shows
      14 unproven first-party manifests and 15 proven first-party
      manifests without a declaration. Only `spotify` and `imessage`
      currently declare.
- [x] 2.2 Add `public_listing: { listed: false, status: "unproven" }`
      to each unproven manifest. Do not change `refresh_policy` for
      these manifests; the audit confirms they are already
      `background_safe: false`.
- [x] 2.3 Add `public_listing: { listed: true, status: <maturity> }`
      to each listed manifest so the declaration-mandatory rule applies
      uniformly. Do not change `refresh_policy.background_safe` for
      already-proven manifests. The listed set is `github`, `gmail`,
      `ynab`, `notion`, `pocket`, `strava`, `oura`, `claude_code`,
      `codex`, `chase`, `chatgpt`, `usaa`, `amazon`, `reddit`,
      `slack`.

## 3. Data-Driven Test

- [x] 3.1 Replace the per-connector spot tests in
      `packages/polyfill-connectors/src/public-listing-manifest-honesty.test.ts`
      with a data-driven test that iterates every manifest.
- [x] 3.2 Assertions per manifest:
      - `capabilities.public_listing.listed` is a boolean.
      - if `listed === false`, `status === "unproven"`.
      - if `listed !== true`, `refresh_policy.background_safe !== true`
        (the hidden+background-safe interlock).
      - if `status === "broken_in_current_deployment"`,
        `refresh_policy.background_safe !== true` and
        `refresh_policy.recommended_mode !== "automatic"`
        (the broken+auto-schedule interlock).
      - if `status === "needs_human_auth"`,
        `refresh_policy.background_safe !== true` and
        `refresh_policy.recommended_mode !== "automatic"`
        (the needs-human-auth+auto-schedule interlock — no durable
        no-human unattended auth capability is modeled today).
- [x] 3.3 Keep the local-device sub-check on iMessage as a targeted
      scenario test alongside the data-driven matrix so the
      local-device codepath in the reference catalog stays covered.

## 4. Pocket Deprecated Upstream

- [x] 4.1 `packages/polyfill-connectors/CONNECTORS.md` notes that
      Pocket was shut down by Mozilla on 2025-07-08, yet
      `manifests/pocket.json` declared
      `listed: true, status: "proven", background_safe: true,
      recommended_mode: "automatic"`. The audit on 2026-05-15 picks
      this up as a catalog-honesty contradiction.
- [x] 4.2 Flip `manifests/pocket.json` to
      `listed: false, status: "deprecated_upstream",
      background_safe: false, recommended_mode: "manual"`. Record the
      reason in both `public_listing.rationale` and
      `refresh_policy.rationale`.
- [x] 4.3 Extend the manifest honesty test set with a
      `deprecated_upstream` rule that asserts
      `listed=false`, `background_safe=false`, and
      `recommended_mode!=="automatic"`.

## 5. Catalog Completeness

- [x] 5.1 Extend `reference-implementation/server/polyfill-manifest-reconcile.ts`
      so the not-yet-registered branch auto-registers shipped
      first-party manifests with
      `capabilities.public_listing.listed: true`. Unlisted manifests
      stay skipped. Custom user-authored connectors stay untouched
      because reconciliation only scans the shipped first-party dir.
- [x] 5.2 Surface a new `registered` counter on the reconcile summary
      so the boot log records which listed manifests were seeded.
- [x] 5.3 Pin the contract with a fresh end-to-end test
      (`reference-implementation/test/connector-public-catalog-completeness.test.js`)
      that runs `reconcilePolyfillManifests` against the real shipped
      manifests dir and asserts:
      - every listed=true first-party manifest is visible on
        `listConnectorSummaries()` on a fresh DB
      - every hidden manifest stays invisible
- [x] 5.4 Extend
      `reference-implementation/test/polyfill-manifest-reconcile-invalidation.test.js`
      with positive and negative cases for the listed/unlisted gate.
      Keep the existing "skips unregistered" expectation (now scoped
      to unlisted manifests) so the original safety contract is
      preserved.

## 6. Acceptance Checks

- [x] 6.1 `node --test packages/polyfill-connectors/src/public-listing-manifest-honesty.test.ts`
- [x] 6.2 `node --test reference-implementation/test/ref-connectors-list-operation.test.js`
- [x] 6.3 `node --test reference-implementation/test/polyfill-manifest-reconcile-invalidation.test.js`
- [x] 6.4 `node --test reference-implementation/test/connector-public-catalog-completeness.test.js`
- [x] 6.5 `openspec validate add-connector-public-listing-honesty --strict`
