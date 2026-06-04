# Tasks — add-child-manifest-relationship-backlinks

This change documents a shipped, tested operator-console affordance and reconciles it with the companion change `add-record-relationship-navigation`. It introduces no code, manifest, server, or contract changes; the implementation already exists at HEAD. The tasks below confirm the contract against the existing implementation and tests.

## 1. Current-state confirmation

- [x] 1.1 Confirm the operator console reads bundled connector manifests from disk and passes `streams[].relationships[]` through to the record detail page (`apps/console/src/app/dashboard/lib/rs-client.ts` `listConnectorManifests` / `MANIFESTS_DIR`; `apps/console/src/app/dashboard/records/[connector]/[stream]/[recordKey]/page.tsx` resolves `childManifestStream` and calls `childHasOneBackLinksFromManifest`).
- [x] 1.2 Confirm `childHasOneBackLinksFromManifest` (`apps/console/src/app/dashboard/records/lib/relationships.ts`) consumes only `has_one` relationships declared on the child stream, requires non-empty `stream` and `foreign_key`, and links to `/dashboard/records/<conn>/<stream>/<foreign_key_value>` only for non-empty string field values.
- [x] 1.3 Confirm the Chase manifest declares `transactions.relationships[]` with `{ stream: "accounts", cardinality: "has_one", foreign_key: "account_id" }`, and that the `accounts` stream declares no `query.expand[]` (so no parent `expand_capabilities` and no `findParentBackLink` result for a Chase transaction).
- [x] 1.4 Confirm only `gmail.messages`, `github.user`, and `slack.messages` enable `query.expand[]` (the only streams that emit `expand_capabilities`), and that every other declared relationship — including all child-side `has_one` belongs-to edges — is descriptive metadata not served forward by the engine (archived `2026-05-28-expand-first-party-parent-child-relations` audit).

## 2. Spec reconciliation

- [x] 2.1 Add the operator-console requirement for child-declared `has_one` parent back-links to the `reference-implementation-architecture` capability delta, with the Chase proving scenario and the constraint scenarios (has_many ignored, undeclared field plain text, missing/empty value, no reverse expansion, dedup with parent-metadata links).
- [x] 2.2 In `proposal.md`, record the relaxation of the companion change's "exclusively from `expand_capabilities`" wording and the archive-time obligation to fold both child-to-parent requirements into one durable-spec requirement naming both sources.
- [x] 2.3 In `design.md`, capture why a separate additive change (not an in-place amendment of the companion change) is the correct reconciliation, and pin Chase as the proving scenario with the rule stated generically.

## 3. Verification against the existing implementation

- [x] 3.1 Run the console relationship unit tests and confirm the scenarios in 2.1 are already proven: `node --test --import tsx apps/console/src/app/dashboard/records/lib/relationships.test.ts` (18/18 green at HEAD; covers Chase-shaped has_one link, percent-encoding, has_many ignored, undeclared field ignored, missing/empty field, undefined inputs).
- [ ] 3.2 (Owner, optional) Live-verify on the deployed console that a Chase `transactions` detail page renders the related-account back-link. The link is bundled-manifest-derived and deploy-revision-independent, so the unit tests are authoritative for the contract; a live check only confirms the operator-visible rendering. Owner-gated because it needs an instance with Chase data.

## 4. Acceptance checks

- [x] 4.1 `openspec validate add-child-manifest-relationship-backlinks --strict` (valid).
- [x] 4.2 `openspec validate --all --strict` (no regression; baseline was 45 passed / 0 failed before this change).
- [x] 4.3 `git diff --check` (no whitespace errors).
- [x] 4.4 Confirm this change adds no code/manifest/server/contract diffs — spec and documentation only.
