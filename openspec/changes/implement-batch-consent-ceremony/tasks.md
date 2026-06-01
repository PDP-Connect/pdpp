## 1. Spec Authoring (this lane — no runtime code)

- [x] 1.1 Author `proposal.md` promoting the Recommended Decision Packet's Option B path into a concrete change scope.
- [x] 1.2 Author `design.md` recording the construction boundary, the encoded O1–O8 owner-default decisions, the boundary map, alternatives, and residual risks.
- [x] 1.3 Author the `agent-consent-bundling` spec delta with normative requirements and scenarios for: staged soft cap + warning; per-source review + per-source confirmation; approve-all suppression; manifest-declared sensitivity; independent source-bounded child grants; `package_id` audit grouping; revoke-package partial-failure visibility; `parent_package_id` incremental linkage; one access mode per package.
- [x] 1.4 Validate strictly: `pnpm exec openspec validate implement-batch-consent-ceremony --strict` and `pnpm exec openspec validate --all --strict`; `git diff --check`.
- [x] 1.5 Record in `design-fast-broad-agent-consent/tasks.md` that this follow-up implementation change has been authored, without marking owner-decision checkboxes complete.

## 2. Implementation Gate (DO NOT START until owner opens an implementation lane against this spec)

These tasks describe the later implementation lane. They are intentionally small enough for one commit each, each with its own acceptance check and tests. No runtime code is changed in the spec-authoring lane above.

### 2.1 Reference contract — relax the staged-entry cap to a soft cap

- [ ] 2.1.1 Replace the reference-contract `authorization_details.maxItems = 1` constraint with a soft cap policy constant (default 8) plus a warning-threshold constant (default 6), each carrying exactly one source binding. Regenerate the public reference contract schema.
  - Acceptance: `pnpm --filter @pdpp/reference-contract run verify` and `run check:generated` pass; the generated schema advertises the soft cap, not `maxItems = 1`; a staged request with two source-bounded entries is accepted by the contract validator.
  - Tests: reference-contract generation tests pin the soft-cap and warning-threshold constants.

### 2.2 PAR / staged-request acceptance

- [ ] 2.2.1 Update the reference PAR/auth path to accept up to the soft cap of source-bounded `authorization_details[]` entries, flagging (not silently truncating) requests above the soft cap and warning at the threshold; each entry still carries exactly one source binding; AS-side widening stays forbidden.
  - Acceptance: a staged request with N≤soft-cap entries is accepted; N above soft cap is flagged with the affected sources named; the multi-entry rejection test from the single-entry baseline is replaced with multi-entry acceptance + over-cap flagging coverage.
  - Tests: `node --test` over the PAR/auth suite pins acceptance, warning, and over-cap flagging.

### 2.3 Manifest sensitivity field

- [ ] 2.3.1 Add `sensitivity: "standard" | "sensitive"` to the connector manifest schema, defaulting absent to `standard`; do not hardcode any source list.
  - Acceptance: a manifest declaring `sensitivity: "sensitive"` validates; an omitting manifest resolves to `standard`; manifest validation tests pin both.
  - Tests: connector manifest schema tests.

### 2.4 Grouped review ceremony — per-source cards + cumulative-risk header

- [ ] 2.4.1 Render one review card per staged source (source, streams, fields/projection, time range, access mode, per-card risk) and a cumulative-risk header (sensitive-source, continuous-access, no-time-bound, no-field-projection, and total-stream counts). Carry the reference-experimental label.
  - Acceptance: a staged multi-source request renders one card per source and a header with the five counts; the experimental label is present.
  - Tests: consent-UI helper tests over the ceremony render output.

### 2.5 Per-source partial approval + narrowing

- [ ] 2.5.1 Wire per-source approve / deny / defer / narrow-time / reduce-streams-or-fields; forbid widening beyond the client request; forbid AS-side enrichment.
  - Acceptance: approving a subset issues grants only for the approved sources; narrowing a source binds the issued grant to the narrowed set; widening is not representable.
  - Tests: ceremony unit tests for subset approval, narrowing, and no-widen.

### 2.6 Approve-all gate

- [ ] 2.6.1 Suppress approve-all whenever (continuous + all streams), (no time bound + sensitive source), or N≥3 sensitive sources; when shown, require one re-asserting confirmation; default to per-source confirmation.
  - Acceptance: each suppression condition hides approve-all; a low-risk batch shows it and requires the re-asserting confirmation.
  - Tests: gate unit tests covering each suppression condition and the shown-path confirmation.

### 2.7 Independent source-bounded child-grant issuance

- [ ] 2.7.1 Issue one independent source-bounded grant per approved source; no cross-source grant object; RS per-grant enforcement, grant shape, and revocation unchanged.
  - Acceptance: approving two sources creates two independently revocable grants; revoking one stops only that source's reads.
  - Tests: issuance + revocation suite proves independence and persisted per-grant enforcement.

### 2.8 Package audit grouping (`package_id`) + timeline/dashboard

- [ ] 2.8.1 Record a `package_id` grouping the issued child grants; group by package in the timeline and dashboard; keep per-grant revocation primary; ensure `package_id` carries no source authority.
  - Acceptance: a batch's child grants group under one `package_id` in timeline and dashboard; introspecting a package-bound token authorizes only by active child grants.
  - Tests: timeline/dashboard grouping tests + token-introspection authority test.

### 2.9 Revoke-package convenience with partial-failure visibility

- [ ] 2.9.1 Offer a revoke-package convenience that dispatches one revoke per still-active child and surfaces partial failure (names revoked vs not); never replace per-grant revocation; never report success on partial failure.
  - Acceptance: all-success path revokes every child and reports it; a forced single-child failure reports which children were/weren't revoked and does not report overall success.
  - Tests: revoke-package unit tests for all-success and partial-failure paths.

### 2.10 Incremental add-source (`parent_package_id`) + cumulative client view

- [ ] 2.10.1 A later same-client ceremony creates a new package linked via `parent_package_id`, issues independent grants for the added sources without re-issuing prior grants, and the dashboard renders a cumulative per-client view across linked packages.
  - Acceptance: adding one source creates a `parent_package_id`-linked package and one new grant; the dashboard shows the cumulative per-client picture; prior grants are unchanged.
  - Tests: linkage + cumulative-view tests.

### 2.11 One access mode per package (tranche scope guard)

- [ ] 2.11.1 Apply a single `access_mode` to every child grant in a package; do not offer per-source access-mode mixing in this tranche.
  - Acceptance: a package applies one access mode to all children; no per-source access-mode control is offered within the package.
  - Tests: package access-mode unit test.

### 2.12 Skill / docs guidance (gated to UI landing)

- [ ] 2.12.1 Update `docs/agent-skills/pdpp-data-access/**` to describe batched setup only after the reference ceremony ships behind the experimental label; not before.
  - Acceptance: skill guidance references batched setup only once the experimental UI exists; the reference-experimental label is reflected in the guidance.

## 3. Implementation-lane validation

- [ ] 3.1 `pnpm exec openspec validate implement-batch-consent-ceremony --strict`
- [ ] 3.2 `pnpm exec openspec validate --all --strict`
- [ ] 3.3 `pnpm --dir reference-implementation run test` (note any owner-approved baseline failures by exact name)
- [ ] 3.4 `pnpm --filter @pdpp/reference-contract run verify` and `run check:generated`
- [ ] 3.5 Every requirement above pinned by at least one passing spec scenario and one regression test before any code is claimed complete.

## Acceptance checks (spec-authoring lane)

- [x] `pnpm exec openspec validate implement-batch-consent-ceremony --strict` passes.
- [x] `pnpm exec openspec validate --all --strict` passes.
- [x] `git diff --check` is clean.
- [x] No runtime, contract, consent-UI, consent-storage, PAR, or grant-issuance code changed in this lane.
