# Full Compatibility Boundary Audit

**Date:** 2026-04-16  
**Scope:** `e2e/`, website bridge routes, legacy demo surfaces, and test/developer helpers  
**Question:** under the stricter rule that the reference should expose one intentional contract and not preserve old shapes by default, what else should change?

## Bottom line

Yes. The same principle applies well beyond the flat grant-initiation body.

There are three different categories currently being conflated:

- **real realization-specific surfaces**
  - these are not “legacy”; they exist because the polyfill path has real operational seams
- **temporary auth/profile scaffolding**
  - these should exist only until the provider-connect / owner-auth profile is real
- **pure demo/admin helpers**
  - these should stop being public contract immediately and should be deleted once tests/CLI no longer need them

The most important owner rule is:

> keep exactly one external contract per job; do not preserve a second one just because it was convenient during migration

## Classification

### Remove now

These are the places where dual-shape or legacy-preserving behavior no longer adds value.

#### 1. Flat-body support in `POST /grants/initiate`

Files:
- [e2e/server/auth.js](/e2e/server/auth.js:1)
- [e2e/server/index.js](/e2e/server/index.js:184)
- [e2e/test/pdpp.test.js](/e2e/test/pdpp.test.js:1)
- [apps/web/src/app/api/grant/route.ts](/apps/web/src/app/api/grant/route.ts:1)

Recommendation:
- keep the normalized internal object
- remove the flat input form
- require the envelope-shaped body everywhere
- update all callers in the same tranche

Reason:
- the flat form is not a protocol contribution
- it only preserves the old dialect
- the route itself may remain temporarily, but it should accept one shape only

#### 2. Website bridge code that still emits the old flat request

Files:
- [apps/web/src/app/api/grant/route.ts](/apps/web/src/app/api/grant/route.ts:1)

Recommendation:
- either update this route to the envelope shape immediately
- or remove it if the current site no longer needs it

Reason:
- this currently blesses the old request shape from the website layer

#### 3. Legacy Instagram world as an implicit current reference

Files:
- [apps/web/src/app/api/setup/route.ts](/apps/web/src/app/api/setup/route.ts:1)
- [apps/web/src/app/api/grant/approve/route.ts](/apps/web/src/app/api/grant/approve/route.ts:1)
- [e2e/client/demo.js](/e2e/client/demo.js:1)

Recommendation:
- do not keep these in the path of the current reference story
- either archive them under an explicit legacy/demo namespace or delete them once no caller depends on them

Reason:
- they still encode the old Instagram/Audience-Lens world and old auth shortcuts
- they actively teach the wrong topology if left near the primary path

### Keep internal only

These can still exist for implementation reasons, but they should not be treated as public reference contract.

#### 4. `compat.source_shape` on the normalized pending request

Files:
- [e2e/server/auth.js](/e2e/server/auth.js:1)

Recommendation:
- keep only as a short-lived internal migration tag
- delete once flat-body support is removed

Reason:
- it is useful implementation bookkeeping
- it should not become a semi-permanent compatibility layer

#### 5. `connector_id` as an internal storage key for native mode

Files:
- [e2e/server/index.js](/e2e/server/index.js:111)
- [e2e/server/records.js](/e2e/server/records.js:279)

Recommendation:
- keep internal for now
- do not expose it on native owner read/query surfaces

Reason:
- this is implementation detail, not public contract
- changing storage keys right now would be churn without protocol value

#### 6. Public route labels/comments describing transitional seams

Files:
- [e2e/server/index.js](/e2e/server/index.js:165)
- [e2e/server/auth.js](/e2e/server/auth.js:211)

Recommendation:
- keep the labeling while the seams remain
- do not mistake the presence of labels for justification to keep the routes forever

Reason:
- the labels are guardrails, not product features

### Keep as reference-only for a specific reason

These still have real short-term value, but only as explicit reference scaffolding.

#### 7. `POST /connectors` and `GET /connectors/:connectorId`

Files:
- [e2e/server/index.js](/e2e/server/index.js:153)

Recommendation:
- keep for the polyfill/reference-world path
- do not present as universal PDPP surfaces

Reason:
- the personal-server/polyfill realization genuinely needs source/manifest registration
- the native provider path should not depend on them publicly

#### 8. HTML consent shell and manual approve/deny

Files:
- [e2e/server/index.js](/e2e/server/index.js:195)

Recommendation:
- keep temporarily as manual visibility/debug surface
- remove once the provider-connect / owner-auth path has a better approval UX or test harness seam

Reason:
- this is not pure demo fluff; it gives a real manual inspection point
- but it is not the long-term auth/profile contract

#### 9. `GET /grants/poll/:deviceCode`

Files:
- [e2e/server/index.js](/e2e/server/index.js:297)

Recommendation:
- keep until the first real owner/device-flow profile exists
- then remove or quarantine

Reason:
- it is part of the current pending-consent compatibility seam
- it is not the final standards-based acquisition path

### Keep only until a real replacement exists, then delete

These are the most dangerous helpers because they can quietly become normalized.

#### 10. `POST /owner-token`

Files:
- [e2e/server/index.js](/e2e/server/index.js:304)
- [e2e/test/pdpp.test.js](/e2e/test/pdpp.test.js:84)
- [e2e/test/collection-profile.test.js](/e2e/test/collection-profile.test.js:395)
- [e2e/test/cli.test.js](/e2e/test/cli.test.js:79)
- [apps/web/src/app/api/setup/route.ts](/apps/web/src/app/api/setup/route.ts:1)

Recommendation:
- keep only until the first real owner token acquisition flow exists
- do not add any new consumer
- plan explicit deletion after device flow or equivalent owner-auth profile lands

Reason:
- it is useful bootstrapping
- it is not remotely the final contract

#### 11. `POST /consent/:deviceCode/approve-api`

Files:
- [e2e/server/index.js](/e2e/server/index.js:284)
- [e2e/test/pdpp.test.js](/e2e/test/pdpp.test.js:112)
- [e2e/test/cli.test.js](/e2e/test/cli.test.js:107)
- [apps/web/src/app/api/grant/approve/route.ts](/apps/web/src/app/api/grant/approve/route.ts:1)

Recommendation:
- keep only until tests and bridges have a cleaner consent/approval seam
- likely replace with a direct harness helper for tests, not another public route

Reason:
- this is a pure automation shortcut
- it should not survive as part of the “real” story

#### 12. `POST /grants/:grantId/tokens`

Files:
- [e2e/server/index.js](/e2e/server/index.js:316)
- [e2e/cli/commands/grant.js](/e2e/cli/commands/grant.js:1)
- [apps/web/src/app/api/grant/[grantId]/token/route.ts](/apps/web/src/app/api/grant/[grantId]/token/route.ts:1)

Recommendation:
- keep only while the `single_use` proof still needs it
- move that proof behind a narrower harness or CLI debug seam later
- remove the website bridge early

Reason:
- it proves a real behavior today
- but it is still an admin/demo helper, not a general surface

## Test debt created by the old helpers

Current tests still normalize the wrong contract because they use:

- `POST /owner-token`
- `POST /grants/initiate`
- `POST /consent/:deviceCode/approve-api`

Files:
- [e2e/test/pdpp.test.js](/e2e/test/pdpp.test.js:1)
- [e2e/test/collection-profile.test.js](/e2e/test/collection-profile.test.js:1)
- [e2e/test/cli.test.js](/e2e/test/cli.test.js:1)

This is acceptable only temporarily. The next test cleanup should follow this order:

1. remove flat `/grants/initiate` input
2. keep envelope request coverage
3. leave `owner-token` and `approve-api` in place only until the real owner/device flow exists
4. once that exists, migrate tests off them quickly

## Owner judgment

The strict rule is:

- **one intentional request shape now**
- **one intentional native owner contract now**
- **zero new consumers of helper routes**
- **existing helpers survive only behind an explicit exit plan**

So the answer to “does that apply to anything else?” is **yes, strongly**:

- it applies to the flat request body immediately
- it applies to the website bridge layer immediately
- it applies to the lingering Instagram/demo world immediately
- it applies to helper token/approval routes as soon as the first real replacement exists
