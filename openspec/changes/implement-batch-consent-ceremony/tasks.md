## 1. Spec Authoring (this lane — no runtime code)

- [x] 1.1 Author `proposal.md` promoting the Recommended Decision Packet's Option B path into a concrete change scope.
- [x] 1.2 Author `design.md` recording the construction boundary, the encoded O1–O8 owner-default decisions, the boundary map, alternatives, and residual risks.
- [x] 1.3 Author the `agent-consent-bundling` spec delta with normative requirements and scenarios for: staged soft cap + warning; per-source review + per-source confirmation; approve-all suppression; manifest-declared sensitivity; independent source-bounded child grants; `package_id` audit grouping; revoke-package partial-failure visibility; `parent_package_id` incremental linkage; one access mode per package.
- [x] 1.4 Validate strictly: `pnpm exec openspec validate implement-batch-consent-ceremony --strict` and `pnpm exec openspec validate --all --strict`; `git diff --check`.
- [x] 1.5 Record in `design-fast-broad-agent-consent/tasks.md` that this follow-up implementation change has been authored, without marking owner-decision checkboxes complete.

## 2. Implementation Gate (DO NOT START until owner opens an implementation lane against this spec)

These tasks describe the later implementation lane. They are intentionally small enough for one commit each, each with its own acceptance check and tests. No runtime code is changed in the spec-authoring lane above.

### 2.1 Reference contract — relax the staged-entry cap to a soft cap

- [x] 2.1.1 Replace the reference-contract `authorization_details.maxItems = 1` constraint with a soft cap policy constant (default 8) plus a warning-threshold constant (default 6), each carrying exactly one source binding. Regenerate the public reference contract schema.
  - Acceptance: `pnpm --filter @pdpp/reference-contract run verify` and `run check:generated` pass; the generated schema advertises the soft cap, not `maxItems = 1`; a staged request with two source-bounded entries is accepted by the contract validator.
  - Tests: reference-contract generation tests pin the soft-cap and warning-threshold constants.
  - Landed: `packages/reference-contract/src/public/index.ts:32-33` (`BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP = 8`, `..._WARNING_THRESHOLD = 6`); applied to the PAR `authorization_details` schema as advisory `x-pdpp-soft-cap` / `x-pdpp-warning-threshold` metadata with no `maxItems` hard cap. `packages/reference-contract/test/surface.test.js` validates a request above the soft cap and pins the generated OpenAPI metadata.

### 2.2 PAR / staged-request acceptance

- [x] 2.2.1 Update the reference PAR/auth path to accept up to the soft cap of source-bounded `authorization_details[]` entries, flagging (not silently truncating) requests above the soft cap and warning at the threshold; each entry still carries exactly one source binding; AS-side widening stays forbidden.
  - Acceptance: a staged request with N≤soft-cap entries is accepted; N above soft cap is flagged with the affected sources named; the multi-entry rejection test from the single-entry baseline is replaced with multi-entry acceptance + over-cap flagging coverage.
  - Tests: `node --test` over the PAR/auth suite pins acceptance, warning, and over-cap flagging.
  - Landed: multi-entry acceptance + warning at threshold predate this lane (`reference-implementation/server/auth.js` `normalizeStagedGrantRequestBatch` / `initiateStagedGrantBatch`). This lane closed the over-cap honesty gap: over-cap (>soft cap) was previously accepted *silently*. `normalizeStagedGrantRequestBatch` now computes `over_soft_cap` + `over_cap_sources` (the entries past the cap, named), persists them on the pending batch, emits them on the `request.submitted` spine event, and the ceremony renders an "Over the soft cap" warning naming the affected sources. Tests `batch consent gate: a request at the warning threshold surfaces the broad-setup warning` and `... over-soft-cap requests are flagged with affected sources, never silently dropped` in `reference-implementation/test/batch-consent-per-source-gate.test.js`. Soft cap is not a hard reject (design.md rejects a hard cap); over-cap is flagged, not truncated, satisfying the "Staged entry count exceeds the soft cap" spec scenario.

### 2.3 Manifest sensitivity field

- [x] 2.3.1 Add `sensitivity: "standard" | "sensitive"` to the connector manifest schema, defaulting absent to `standard`; do not hardcode any source list.
  - Acceptance: a manifest declaring `sensitivity: "sensitive"` validates; an omitting manifest resolves to `standard`; manifest validation tests pin both.
  - Tests: connector manifest schema tests.
  - Landed: `reference-implementation/server/auth.js` `MANIFEST_SENSITIVITY_LEVELS` validation (`:2146-2161`) + `resolveManifestSensitivity` (default `standard`); applied per-card at `:2900`. Exercised by the sensitive-source suppression tests in `batch-consent-per-source-gate.test.js` (registers `{ ...manifest, sensitivity: 'sensitive' }`).

### 2.4 Grouped review ceremony — per-source cards + cumulative-risk header

- [x] 2.4.1 Render one review card per staged source (source, streams, fields/projection, time range, access mode, per-card risk) and a cumulative-risk header (sensitive-source, continuous-access, no-time-bound, no-field-projection, and total-stream counts). Carry the reference-experimental label.
  - Acceptance: a staged multi-source request renders one card per source and a header with the five counts; the experimental label is present.
  - Tests: consent-UI helper tests over the ceremony render output.
  - Landed: `reference-implementation/server/auth.js` `buildBatchConsentCards` / `summarizeBatchCumulativeRisk` (`:2885-2927`, five counts: sensitive/continuous/no-time-bound/no-field-projection/total-streams). Rendered by `reference-implementation/server/routes/as-consent-ui-helpers.ts` `buildBatchSourceCards` + `buildBatchRiskHeader` (the "Reference-experimental batch consent" eyebrow). The gate test asserts `/Reference-experimental batch consent/` and per-source `name="approved_source_indexes"` checkboxes.

### 2.5 Per-source partial approval + narrowing

- [x] 2.5.1 Wire per-source approve / deny / defer / narrow-time / reduce-streams-or-fields; forbid widening beyond the client request; forbid AS-side enrichment.
  - Acceptance: approving a subset issues grants only for the approved sources; narrowing a source binds the issued grant to the narrowed set; widening is not representable.
  - Tests: ceremony unit tests for subset approval, narrowing, and no-widen.
  - Landed: subset approve/deny/defer was already in place via `approved_source_indexes` (`reference-implementation/server/auth.js` `resolveApprovedEntryIndexes` + `approveStagedGrantBatch`). This lane added owner-driven per-source **narrowing** at consent time. The owner can now, per staged source, drop streams, reduce a stream's fields to a subset of the staged field set, and tighten an existing `time_range.since` bound — all validated server-side in `narrowResolvedSelectionForSource` against the staged *resolved baseline* (`resolveGrantSelection(entry.selection, manifest)`), which is the authoritative ceiling of what the client staged. Widening (a stream not staged, a field not in the staged set, an earlier `since`, or adding a bound to an unprojected/untimed stream) throws `invalid_request` **before** any `grant_packages` row, `grant_package_members` row, or child grant is written; the issued child grants reflect the narrowed decision, not the over-broad staged entry. Two wire forms: a structured `source_narrowing` object (agent-friendly JSON branch) and flat `narrow_streams_<i>` / `narrow_fields_<i>__<stream>` / `narrow_since_<i>__<stream>` fields posted by the rendered ceremony's per-source "Narrow this source" controls (`reference-implementation/server/routes/as-consent.ts` `parseBatchApproveSelection` + `as-consent-ui-helpers.ts` `buildSourceNarrowingControls`). The transport prunes field/since directives for streams the owner dropped so an unchecked HTML stream cannot produce a contradictory directive. `opts.sourceNarrowing` threads through `operations/as-consent-decision` and a narrowing keyed to a non-approved source is rejected. Tests in `reference-implementation/test/batch-consent-per-source-gate.test.js`: subset/defer, wildcard→single stream, field subset, time tighten, render-controls, plus no-widen failures (stream widen, field widen, earlier-since, malformed-since, field-narrow-on-unprojected-stream, narrow-a-deferred-source). Narrowing engages only on the batch path (`authorization_details.length > 1`); the single-entry flow is unchanged.

### 2.6 Approve-all gate

- [x] 2.6.1 Suppress approve-all whenever (continuous + all streams), (no time bound + sensitive source), or N≥3 sensitive sources; when shown, require one re-asserting confirmation; default to per-source confirmation.
  - Acceptance: each suppression condition hides approve-all; a low-risk batch shows it and requires the re-asserting confirmation.
  - Tests: gate unit tests covering each suppression condition and the shown-path confirmation.
  - Landed: `reference-implementation/server/auth.js` `evaluateBatchApproveAllGate` (`:2943`, three reasons) enforced in `approveStagedGrantBatch` (`:3016-3031`, suppression + `confirm_approve_all` re-assert). Five gate tests in `batch-consent-per-source-gate.test.js` pin all three suppression conditions, the no-silent-approve guard, and the low-risk shown-path re-assert.

### 2.7 Independent source-bounded child-grant issuance

- [x] 2.7.1 Issue one independent source-bounded grant per approved source; no cross-source grant object; RS per-grant enforcement, grant shape, and revocation unchanged.
  - Acceptance: approving two sources creates two independently revocable grants; revoking one stops only that source's reads.
  - Tests: issuance + revocation suite proves independence and persisted per-grant enforcement.
  - Landed: `reference-implementation/server/auth.js` `approveStagedGrantBatch` issues one source-bounded child grant per approved source via `persistChildGrantForPackage` (`:3126`), with `source_bounded_child_grants: true` recorded on the package (`:3091`); no cross-source grant object. End-to-end read-after-revoke-one is proven in `hosted-mcp-oauth.test.js` (`revoke just the spotify child grant`, `:943-958`): after revoking one child, spotify streams are absent from the live `/mcp` fanout while github streams remain — only that source's reads stop. The batch path reuses this same child-grant machinery, so per-grant enforcement/revocation is identical.

### 2.8 Package audit grouping (`package_id`) + timeline/dashboard

- [x] 2.8.1 Record a `package_id` grouping the issued child grants; group by package in the timeline and dashboard; keep per-grant revocation primary; ensure `package_id` carries no source authority.
  - Acceptance: a batch's child grants group under one `package_id` in timeline and dashboard; introspecting a package-bound token authorizes only by active child grants.
  - Tests: timeline/dashboard grouping tests + token-introspection authority test.
  - Landed: `approveStagedGrantBatch` writes one `grant_packages` row + one `grant_package_members` row per child (`reference-implementation/server/auth.js:3096-3145`). `GET /_ref/grants surfaces grant_package_id on package-member child rows and omits it otherwise` (`ref-grant-packages.test.js:361-393`) proves dashboard grouping and that non-package grants omit it. Token authority-by-active-children is proven in `hosted-mcp-oauth.test.js:943-958`: the package token's `/mcp` fanout drops a child the instant its grant is revoked while the package token is unchanged — `package_id` carries no source authority.

### 2.9 Revoke-package convenience with partial-failure visibility

- [x] 2.9.1 Offer a revoke-package convenience that dispatches one revoke per still-active child and surfaces partial failure (names revoked vs not); never replace per-grant revocation; never report success on partial failure.
  - Acceptance: all-success path revokes every child and reports it; a forced single-child failure reports which children were/weren't revoked and does not report overall success.
  - Tests: revoke-package unit tests for all-success and partial-failure paths.
  - Landed: `revokeGrantPackage` now enumerates active package members and calls the existing `revokeGrant` primitive per still-active child grant. Successful child revokes mark the corresponding `grant_package_members` row revoked. If every child revoke succeeds, the package row, package bearer token, remaining member rows, and package refresh tokens are revoked and `POST /_ref/grant-packages/:id/revoke` returns `status: "revoked"` with `revoked_child_grants` and an empty `not_revoked_child_grants`. If any child revoke fails, successful children remain revoked, failed children stay active, the package row stays active, and the route returns HTTP 500 with `status: "partial_failure"`, `revoked_child_grants`, and `not_revoked_child_grants[{grant_id,error}]` so the operator cannot confuse partial failure for success. Dynamic-client deletion now fails closed if a package cascade returns partial failure. Tests in `reference-implementation/test/ref-grant-packages.test.js`: all-success cascade asserts child grants and member rows are revoked, and a malformed-child regression proves one healthy child revokes while the bad child is named under `not_revoked_child_grants` without flipping the package to revoked.

### 2.10 Incremental add-source (`parent_package_id`) + cumulative client view

- [ ] 2.10.1 A later same-client ceremony creates a new package linked via `parent_package_id`, issues independent grants for the added sources without re-issuing prior grants, and the dashboard renders a cumulative per-client view across linked packages.
  - Acceptance: adding one source creates a `parent_package_id`-linked package and one new grant; the dashboard shows the cumulative per-client picture; prior grants are unchanged.
  - Tests: linkage + cumulative-view tests.
  - Not attempted (left unchecked): `parent_package_id` does not exist anywhere — not in the `grant_packages` schema, the package envelope, the `/_ref/grant-packages` surface, or any test. Blocker: this is a net-new schema column + linkage write + a cumulative cross-package dashboard view; it is a feature add requiring a migration and dashboard work, out of scope for a runtime reconcile. Deferred to its own implementation lane.

### 2.11 One access mode per package (tranche scope guard)

- [x] 2.11.1 Apply a single `access_mode` to every child grant in a package; do not offer per-source access-mode mixing in this tranche.
  - Acceptance: a package applies one access mode to all children; no per-source access-mode control is offered within the package.
  - Tests: package access-mode unit test.
  - Landed: `approveStagedGrantBatch` now enforces a tranche scope guard immediately after resolving the approved entries (`reference-implementation/server/auth.js`, right after the `ai_training` guard): if the approved staged entries declare more than one distinct `selection.access_mode`, the approval is rejected with `invalid_request` / `param: access_mode` (message names the mixed modes and points the owner to "run a separate ceremony per access mode") **before** any `grant_packages` row, `grant_package_members` row, or child grant is written. The spec's "every child grant SHALL carry the chosen access mode" is satisfied by making mixed-mode packages non-representable, and "SHALL run separate ceremonies" is the resolution the spec itself prescribes — so reject (not silent collapse) is the spec-aligned semantics, not an open design call. The consent form already offered no per-source access-mode control (the prior note confirmed this), so no UI change was needed; the gap was purely the missing API-side guard against a client staging mixed modes. Tests in `reference-implementation/test/batch-consent-per-source-gate.test.js`: `... a package mixing access modes across approved sources is rejected, not issued` (asserts 400 + zero grants/packages/members written) and `... a uniform-access-mode package issues all children under one access mode` (asserts every child grant in the package carries the one declared mode).

### 2.12 Skill / docs guidance (gated to UI landing)

- [ ] 2.12.1 Update `docs/agent-skills/pdpp-data-access/**` to describe batched setup only after the reference ceremony ships behind the experimental label; not before.
  - Acceptance: skill guidance references batched setup only once the experimental UI exists; the reference-experimental label is reflected in the guidance.
  - Intentionally not attempted (left unchecked): this task is explicitly gated — skill/docs guidance lands only after the reference ceremony ships behind the experimental label, "not before." The ceremony renders behind a `Reference-experimental batch consent` label but has not been promoted/shipped as owner-facing setup UX, so updating the skill now would violate the gate. Correctly deferred until the UI lands.

## 3. Implementation-lane validation

- [x] 3.1 `pnpm exec openspec validate implement-batch-consent-ceremony --strict`
  - Evidence: passed on 2026-06-01 during validation closeout.
- [x] 3.2 `pnpm exec openspec validate --all --strict`
  - Evidence: passed on 2026-06-01 during validation closeout.
- [x] 3.3 `pnpm --dir reference-implementation run test` (note any owner-approved baseline failures by exact name)
  - Evidence: passed on 2026-06-01 with no baseline failures.
- [x] 3.4 `pnpm --filter @pdpp/reference-contract run verify` and `run check:generated`
  - Evidence: both passed on 2026-06-01.
- [ ] 3.5 Every requirement above pinned by at least one passing spec scenario and one regression test before any code is claimed complete.
  - Left open because 2.10 incremental `parent_package_id` and 2.12 gated skill docs remain intentionally unchecked. (2.5 owner-driven narrowing and 2.9 partial revoke-package failure visibility are now landed and regression-tested.)

## Acceptance checks (spec-authoring lane)

- [x] `pnpm exec openspec validate implement-batch-consent-ceremony --strict` passes.
- [x] `pnpm exec openspec validate --all --strict` passes.
- [x] `git diff --check` is clean.
- [x] No runtime, contract, consent-UI, consent-storage, PAR, or grant-issuance code changed in this lane.
