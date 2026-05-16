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
- [x] 2.3 Add `public_listing: { listed: true, status: "proven" }` to
      each proven manifest so the declaration-mandatory rule applies
      uniformly. Do not change `refresh_policy.background_safe` for
      any proven manifest. The proven set is `github`, `gmail`, `ynab`,
      `notion`, `pocket`, `strava`, `oura`, `claude_code`, `codex`,
      `chase`, `chatgpt`, `usaa`, `amazon`, `reddit`, `slack`.

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
- [x] 3.3 Keep the local-device sub-check on iMessage as a targeted
      scenario test alongside the data-driven matrix so the
      local-device codepath in the reference catalog stays covered.

## 4. Acceptance Checks

- [x] 4.1 `node --test packages/polyfill-connectors/src/public-listing-manifest-honesty.test.ts`
- [x] 4.2 `node --test reference-implementation/test/ref-connectors-list-operation.test.js`
- [x] 4.3 `openspec validate add-connector-public-listing-honesty --strict`
