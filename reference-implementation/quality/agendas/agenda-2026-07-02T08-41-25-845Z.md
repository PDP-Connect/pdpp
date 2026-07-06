# hone agenda — agenda-2026-07-02T08-41-25-845Z

Generated 2026-07-02T08:41:25.845Z by claude/opus (one strong-model call; 49805 bytes of digest context).
Repo sha c018c217fdeb · inventory sha 82bdca52d3c4 · doctrine: /home/tnunamak/code/dotfiles/ai/research/code-quality/THE-PROJECT-QUALITY-PORTFOLIO-MACHINE.md
Citation verifier: 23 sensor citation(s) · 16 reproduced · 7 FAILED. UNVERIFIED items are demoted below every verified item (the model's own order is kept as model_rank).

## Ranked items (consumable order — verified-first)

### 1. Generate mutant-killing tests for server/auth.js (cookie-security, session-expiry, and core token/consent/introspect invariants) to raise the ~60% auth mutation score before any auth refactor.
- id: `auth-mutation-killing-tests-0001` · class: evidence-generation · campaign: b-auth-substrate-policy-split
- why now: auth.js is the second-highest-attention owned file yet is NOGO for autonomous refactor; the doctrine names auth-mutation-killing-tests as the REQUIRED gate that unblocks the auth-substrate-policy-split B campaign. A prior mutation run left cookie-security and session-expiry mutants alive, so the refactor cannot be proven behavior-preserving until these exist. This is evidence-generation (autonomous, no behavior change) that converts the largest blocked B campaign into workable — highest leverage per dollar.
- evidence:
  - [sensor ✓] server/auth.js:attention=41464
  - [sensor ✓] server/auth.js:loc=5926
  - [incident by reference] DOCTRINE:NAMED-TARGETS auth-mutation-killing-tests — 'auth mutation score ~60%; cookie-security and session-expiry mutants survived; add mutant-killing tests BEFORE any auth refactor'
  - [sensor ✓] server/auth.js:cc[requireGrantContractAgainstManifest]=38
- acceptance criteria:
  - Every previously-surviving cookie-security and session-expiry mutant is killed by a by-name test
  - Direct by-name assertions exist for token issue/introspect and grant-consent contract invariants
  - Mutation score on the auth-adjacent set is measured and materially above the ~60% baseline
  - No production behavior changed — tests only
- est cost: $1.5 (prior agenda #1 auth-mutation-killing-tests est $1.5; comparable to landed oracle jobs ($0.51–$2.43)) · predicted gain: Unblocks the auth substrate/policy split (largest blocked B campaign); makes the #2 attention file safe to touch.
- packets: `auth-mutation-tests-0001`

### 2. Advance the runtime/index.js handleMsg (cc=194) decomplection: land the characterization-oracle packets first, then the family-extraction packets into named sub-handlers with explicit state.
- id: `hm-handlemsg-oracle-then-extract-campaign` · class: A2 · campaign: a2-top-attention-hotspots
- why now: handleMsg is the single highest-cc owned function in the repo and a HUMAN-FIXED doctrine anchor (runtime-handleMsg-decomplect). runtime/index.js is the #2 attention file. The packet pool already holds the oracle + 8 hm-*-extract packets scaffolded for exactly this. Cost-actuals show the oracles are expensive and REVISE-prone but eventually PASS (hm-dispatch-guards-oracle landed $5.60), so oracle-first is the correct sequencing to make the extractions provable rather than green-by-reachability.
- evidence:
  - [sensor ✓] runtime/index.js:cc[handleMsg]=194
  - [sensor ✓] runtime/index.js:attention=44206
  - [sensor ✓] runtime/index.js:excess[handleMsg]=189
  - [incident by reference] DOCTRINE:NAMED-TARGETS runtime-handleMsg-decomplect — 'the highest-cc owned function; decomplect into named sub-handlers with explicit state'
  - [incident by reference] COST-ACTUALS hm-dispatch-guards-oracle-0001 landed $5.60 PASS after 3 REVISE cycles; hm-awaited-order-oracle-0002 skipped after $7.28
- acceptance criteria:
  - Characterization oracle pins handleMsg dispatch + awaited-order behavior red-then-green before any extraction lands
  - handleMsg cc materially reduced by extracting named sub-handlers with explicit state (not relocation)
  - Each extraction gated tsc + direct test + different-model judge PASS
  - No observable runtime behavior change vs the real event spine
- est cost: $2.93 (prior agenda #2 est $2.93; but note oracle history $3.51–$10.89 with REVISE — budget for retries) · predicted gain: Retires the largest single cognitive-load concept in the owned core; converts a 194-cc hairball into locally-reasonable named handlers.
- packets: `hm-awaited-order-oracle-0002`, `hm-dispatch-table-coherence-0011`, `hm-done-terminal-extract-0010`, `hm-interaction-lifecycle-extract-0009`, `hm-record-scope-extract-0004`, `hm-state-checkpoint-extract-0005`, `hm-detail-gap-ledger-extract-0008`, `hm-detail-page-coverage-extract-0007`, `hm-assistance-family-extract-0006`, `hm-reporting-family-extract-0003`

### 3. Judged A2 decomplection of server/index.js::startServer (cc=67, T2-async-order) and buildAsApp (cc=43, T2-property) — the two dominant functions in the highest-attention owned file.
- id: `srv-index-startserver-buildasapp-a2-decomplect` · class: A2 · campaign: a2-top-attention-hotspots
- why now: server/index.js has the highest file attention in the repo (70850) and the highest hotspot score (97370), and its mass concentrates in startServer + buildAsApp. This is the top attention-weighted A2 target after handleMsg. The doctrine says sequence by attention; this file leads. server-index-t0 is explicitly NOT the answer here (streetlight trap — the T0 tail is 16.3% of repo mass while startServer/buildAsApp are the real cost).
- evidence:
  - [sensor ✓] server/index.js:attention=70850
  - [sensor ✓] server/index.js:score=97370
  - [sensor ✓] server/index.js:cc[startServer]=67
  - [sensor ✓] server/index.js:cc[buildAsApp]=43
- acceptance criteria:
  - startServer async-ordering decomplected with awaited-order preserved and made explicit
  - buildAsApp property/branching complexity reduced via named seams, not relocation
  - Behavior proven against the real server boot + app-build path (differential/characterization)
  - different-model judge PASS; no route/contract behavior change
- est cost: $2.93 (prior agenda #3 srv-index-startserver-buildasapp est $2.93) · predicted gain: Reduces the single highest-attention file's dominant complexity; the biggest owner-attention win outside runtime.

### 4. B campaign to decide the /_ref/* vs /v1/owner/* near-duplicate control-plane conflation (run/schedule/revoke/reactivate exist under both prefixes with different auth guards).
- id: `b-ref-vs-owner-control-plane-conflation` · class: B · campaign: b-ref-vs-owner-control-plane-conflation (model ranked #5)
- why now: The B-inventory calls this 'the clearest noun-conflation candidate' — 70 of 100 operations are control-plane, split across two prefixes that likely serve overlapping concepts. It's the largest B item in the ratification queue (#2). Behavior-changing → proposal-only, human-ratified; but building the proposal now is exactly the B-minimum work the doctrine says must lead the portfolio.
- evidence:
  - [b-inventory by reference] B-INVENTORY §6.4 — '/_ref and /v1/owner planes are near-duplicate control surfaces ... 70 of 100 operations are control plane ... clearest noun-conflation candidate'
  - [incident by reference] RATIFICATION-QUEUE #2 (SLVP-Q weight low-med, largest conflation, OPEN)
- acceptance criteria:
  - Enumerate every operation duplicated across /_ref/* and /v1/owner/* with its auth guard
  - Decide per pair: genuinely-two-audiences vs one-concept-two-skins, with rationale
  - Emit a proposal packet + ratification-queue update; NOTHING auto-landed
  - Owner ratification recorded before any implementation
- est cost: n/a (no prior B control-plane actual; proposal-generation only, comparable to B inventory passes) · predicted gain: Resolves the biggest public-contract noun-conflation; prevents the control plane doubling in maintenance cost.

### 5. B campaign to unify the two storage contracts: server/postgres-storage.js and the sqlite backend share ZERO exported names — one seam with backends behind it.
- id: `b-storage-backend-contract-unification` · class: B · campaign: b-storage-backend-contract-unification (model ranked #7)
- why now: A HUMAN-FIXED doctrine anchor (storage-backend-contract-unification). Two divergent storage contracts is a decomplection the packet pool does not contain and a public/internal-contract seam (behavior-sensitive across backends → B). postgres-storage.js carries real mass and a DDL-marker transaction hotspot, so the divergence is actively costly. Proposal-first because collapsing two contracts is behavior-affecting.
- evidence:
  - [sensor ✓] server/postgres-storage.js:mass=109
  - [sensor ✓] server/postgres-storage.js:cc[migratePostgresLegacyConnectorInstancesToDefaultAccount]=41
  - [incident by reference] DOCTRINE:NAMED-TARGETS storage-backend-contract-unification — 'share ZERO exported names — two storage contracts where the doctrine requires one seam with backends behind it'
- acceptance criteria:
  - Diff the exported surfaces of postgres-storage.js vs the sqlite backend; enumerate every contract divergence
  - Propose a single storage seam interface with both backends behind it
  - Proposal packet emitted; migration/DDL-affecting behavior queued for owner ratification, not auto-landed
  - Conformance-test plan identified so the unified seam is provable across both backends
- est cost: n/a (prior agenda #11 b-storage-backend-contract-unification, unverified/no actual; proposal generation) · predicted gain: Collapses two divergent storage contracts into one seam — removes a whole class of backend-drift maintenance.

### 6. T1b explicit-context extraction of the transport-shim negotiation logic in server/transport.js, gated on the fastify-transport direct test.
- id: `t1b-transport-shim-negotiation-0002` · class: T1b (model ranked #11)
- why now: server/transport.js is a mid-attention hotspot (score 918, coupling 41) with a paired direct test (test/fastify-transport.test.js). The prior evidence run REVERTED at $1.58 REVISE — a lead worth re-attempting behind the test gate. Lower priority than the streaming T1b because transport is less churned, but it's a clean explicit-context candidate the pool already holds.
- evidence:
  - [sensor ✓] server/transport.js:score=918
  - [sensor ✓] server/transport.js:coupling=41
  - [incident by reference] COST-ACTUALS t1b-transport-shim-negotiation-evidence-0001 reverted $1.58 REVISE
- acceptance criteria:
  - Transport-shim negotiation extracted to a named fn with explicit context (no implicit capture)
  - test/fastify-transport.test.js directly pins negotiation output across shim variants
  - Genuine decomplect (not relocation); tsc + direct test + judge PASS
- est cost: $1.58 (prior agenda #10 / COST-ACTUALS t1b-transport-shim-negotiation reverted $1.58) · predicted gain: Turns transport-shim negotiation into a tested, explicit-context function; reduces a coupled hotspot's implicit env.
- packets: `t1b-transport-shim-negotiation-0002`

### 7. B surface-repair: reconcile the query-cookbook docs / schema-capabilities / OpenAPI advisory for the expand-capabilities reason strings (incl. related_stream_not_granted asymmetry).
- id: `docs-query-cookbook-expand-advisory-0003` · class: B · campaign: b-public-contract-minimum (model ranked #12)
- why now: The packet already exists (surface_repair×judgment_first, autonomous, docs+openapi+one test) and it directly addresses ratification-queue #1 — related_stream_not_granted is a public noun that is only an inert schema reason while its sibling field_not_granted throws. Low SLVP-Q weight but genuinely cheap surface hygiene that closes a documented public-noun/internal-concept mismatch.
- evidence:
  - [b-inventory by reference] B-INVENTORY §6.3 — 'related_stream_not_granted is a public noun that is NOT an error code ... public-noun/internal-concept mismatch candidate'
  - [incident by reference] RATIFICATION-QUEUE #1 (expand_capabilities[].reason, OPEN, weight low)
- acceptance criteria:
  - Docs + schema-capabilities + OpenAPI agree on the advisory reason-string semantics
  - The related_stream_not_granted vs field_not_granted asymmetry is either documented as deliberate or flagged to ratification (no silent behavior change)
  - query-contract.test.js pins the advisory reason contract by name
- est cost: $0.54 (prior agenda #10 docs-query-cookbook-expand-advisory est $0.54) · predicted gain: Closes a documented public-noun/internal-concept mismatch cheaply; tightens B-minimum.
- packets: `docs-query-cookbook-expand-advisory-0003`

### 8. Build the NO-HIGH-COMPLEXITY-ANONYMOUS-CALLBACK lint/CI ratchet blocking new anonymous callbacks above a small cc threshold or capturing >N nonlocal names. — ⚠ UNVERIFIED
- id: `prevention-anon-callback-cc-ratchet` · class: prevention (model ranked #4)
- why now: The doctrine's single highest-leverage upstream fix: 84% of complexity mass is concentrated in anonymous capturing callbacks, and the callback-smells sensor confirms live specimens (cc=120, cc=95, cc=77). A ratchet is cheap prevention that stops the distribution regenerating — worth more than any downstream T0 codemod per §3. It's a named doctrine target (anon-callback-prevention-ratchet) and autonomous.
- evidence:
  - [sensor ✗ FAILED (citation does not match the file:metric=value grammar)] SENSOR:CALLBACK-SMELLS mass by class T2:1121,T1b:323,T1a:252
  - [sensor ✗ FAILED (no flagged function 'semanticIndexBackfillForManifest-anon' in server/search-semantic.js)] server/search-semantic.js:cc[semanticIndexBackfillForManifest-anon]=120
  - [incident by reference] DOCTRINE §3 — 'the callback/closure smell detector + generation ratchet, likely higher value than any codemod'; DOCTRINE:NAMED-TARGETS anon-callback-prevention-ratchet
- acceptance criteria:
  - scripts/code-quality/check-callback-ratchet.mjs (or equivalent CI gate) flags new anon callbacks over the cc threshold / capture-count
  - Existing violations are grandfathered/baselined, not force-failed
  - CI wiring fails the build on a NEW over-threshold anonymous callback
  - Documented threshold + escape hatch (named + explicit context) matching the doctrine generation policy
- est cost: $0.35 (prior agenda #4 prevention-anon-callback-cc-ratchet est $0.35) · predicted gain: Caps future complexity generation at the source — compounding attention savings across all owned subsystems.

### 9. Audit every skipped test (58 static skip markers across 51 files AND runtime-skipped subtests) — each skip gets keep-with-reason, fix, or delete. — ⚠ UNVERIFIED
- id: `skipped-test-audit` · class: evidence-generation (model ranked #6)
- why now: A named doctrine target (skipped-test-audit). Skips are silent coverage holes on owned surfaces; the doctrine's stopping condition requires every imperfection be fixed/justified/quarantined — a skip with no reason is none of those. Cheap, autonomous evidence-generation that also feeds the B and mutation-testing lanes by revealing which contracts are unasserted.
- evidence:
  - [sensor ✗ FAILED (citation does not match the file:metric=value grammar)] SENSOR:TEST-SIGNALS static_skips=58 across 51 files
  - [sensor ✓] test/device-exporter-store.test.js:skips=3
  - [incident by reference] DOCTRINE:NAMED-TARGETS skipped-test-audit — 'each skip gets keep-with-reason, fix, or delete; audit static AND runtime-skipped'
- acceptance criteria:
  - Every static skip marker classified: keep-with-explicit-reason, fix (unskip + make green), or delete
  - Runtime '# skipped' subtests enumerated (totals differ from the static floor) and classified
  - Each 'keep' carries a written justification per the doctrine quarantine rule
- est cost: $0.6 (comparable to landed evidence/oracle jobs $0.39–$0.61) · predicted gain: Closes silent coverage holes and surfaces unasserted contracts feeding the B and mutation lanes.

### 10. T1a clean hoist of server/search-semantic.js::semanticIndexBackfillForManifest anonymous callback (cc=120, non-capturing, free-vars=∅) to a named pure top-level function. — ⚠ UNVERIFIED
- id: `t1a-semantic-backfill-hoist` · class: T1a (model ranked #8)
- why now: The single largest anonymous callback in the repo and the cleanest T1a in the pool: the callback-smells sensor confirms it's non-capturing (free-vars=∅), so the hoist is genuine seam clarification, not relocation, and cheap to prove. A prior semantic-t1a attempt REVERTED (REJECT), so this needs the direct-test gate the doctrine's T1b rule demands — treat the revert as a signal to gate hard, not to skip the target.
- evidence:
  - [sensor ✗ FAILED (no flagged function 'semanticIndexBackfillForManifest-anon' in server/search-semantic.js)] server/search-semantic.js:cc[semanticIndexBackfillForManifest-anon]=120
  - [sensor ✗ FAILED (citation does not match the file:metric=value grammar)] SENSOR:CALLBACK-SMELLS server/search-semantic.js semanticIndexBackfillForManifest T1a non-capturing free-vars=∅
  - [incident by reference] COST-ACTUALS server-search-semantic-t1a-230e24ed reverted $0.59 REJECT — needs a direct output-pinning test before landing
- acceptance criteria:
  - Callback hoisted to a named top-level pure function with explicit params (no capture)
  - A test DIRECTLY pins the hoisted function's output (not green-by-reachability)
  - Enclosing fn cc genuinely reduced, or hoist rejected as relocation per canon R5
  - tsc + direct test + judge PASS
- est cost: $0.51 (prior agenda #7 t1a-semantic-backfill-hoist est $0.51; prior revert was $0.59) · predicted gain: Retires the largest anonymous callback in the repo behind a named, testable pure function.

### 11. Land the deterministic oracle/characterization test for package-rs-client schema-envelope merge, pinning the cc=77 mergeSchemaEnvelopes callback (streamGrant security marker). — ⚠ UNVERIFIED
- id: `df-evidence-package-schema-merge-oracle-0004` · class: evidence-generation (model ranked #9)
- why now: The T1b extraction of this callback (t1b-package-rs-merge-child-rows-0008) was REJECTED by codex ('warning path and partial/meta assembly not preserved') — evidence that the merge is unpinned. Generating the oracle first is the doctrine's answer: it unblocks the T1b extraction by making it provable. The oracle packet already landed once ($2.43 PASS) then shows as pending, so re-confirm and drive the paired extraction.
- evidence:
  - [sensor ✗ FAILED (citation does not match the file:metric=value grammar)] SENSOR:CALLBACK-SMELLS server/package-rs-client.js mergeSchemaEnvelopes cc=77 excess=72 T2 security/DDL/marker:streamGrant
  - [incident by reference] PACKET-POOL t1b-package-rs-merge-child-rows-0008 — codex REJECT confidence 0.84 (warning path + partial/meta assembly not preserved)
  - [incident by reference] COST-ACTUALS df-evidence-package-schema-merge-oracle-0004 landed $2.43 PASS after 1 revision
- acceptance criteria:
  - Oracle pins the schema-envelope merge including warning path and partial/meta assembly the REJECT flagged
  - Red-then-green against a seeded regression on the merge
  - Paired t1b extraction becomes landable OR is documented as genuinely-seam-blocked (T1c)
- est cost: $0.56 (prior agenda #6 df-evidence-package-schema-merge-oracle est $0.56; landed actual $2.43) · predicted gain: Unblocks a rejected T1b extraction by pinning a security-marked cc=77 merge callback.
- packets: `df-evidence-package-schema-merge-oracle-0004`, `t1b-package-rs-merge-child-rows-0008`

### 12. T1b explicit-context extraction of the streaming input-telemetry event builder in server/streaming/routes.js, gated on the input-telemetry direct test. — ⚠ UNVERIFIED
- id: `t1b-streaming-input-telemetry-event-0013` · class: T1b (model ranked #10)
- why now: server/streaming/routes.js is a T1b-rich file (T1b mass 70 per tier-mass) and this packet has a paired direct test (test/run-interaction-stream-input-telemetry.test.js) — the exact 'capturing closure + airtight direct unit test' archetype the doctrine says is the scarce high-value T1b. A prior evidence attempt REVERTED (REVISE), so lead with the test gate. Moderate cost, real hidden-state-made-explicit.
- evidence:
  - [sensor ✓] server/streaming/routes.js:mass=202
  - [sensor ✗ FAILED (citation does not match the file:metric=value grammar)] SENSOR:CALLBACK-SMELLS server/streaming/routes.js registerStreamingRoutes T1b captures(immutable)[streamingSessions,getCompanion,inputTelemetry]
  - [incident by reference] COST-ACTUALS t1b-streaming-input-telemetry-evidence-0012 reverted $3.62 REVISE — gate on the direct test
- acceptance criteria:
  - Input-telemetry event builder extracted to a named fn taking an explicit context object (captures made explicit)
  - test/run-interaction-stream-input-telemetry.test.js directly pins the builder's output over a mixed fixture
  - Genuine capture-surfacing or enclosing-cc reduction — reject if pure relocation
  - tsc + direct test + judge PASS
- est cost: $0.59 (prior agenda #8 t1b-streaming-input-telemetry est $0.59; prior evidence revert $3.62) · predicted gain: Makes implicit streaming-telemetry capture explicit behind a tested named function.
- packets: `t1b-streaming-input-telemetry-event-0013`

## Campaigns (named target + acceptance criteria — NOT packet specs)

- **b-auth-substrate-policy-split** → auth-substrate-policy-split — server/auth.js (~5926 LOC, attention 41464) braids commodity OAuth substrate with product policy; NOGO for autonomous refactor, so it proceeds as a B campaign gated on auth-mutation-killing-tests first.
  - done when: Mutant-killing tests land first (gate)
  - done when: Substrate/policy boundary proposed behind a small interface
  - done when: Split proposed as human-ratified B work — no autonomous auth refactor
  - done when: Behavior preservation provable against the mutation-hardened suite
- **a2-top-attention-hotspots** → runtime-handleMsg-decomplect — handleMsg cc=194 (runtime/index.js attention 44206) and server/index.js startServer/buildAsApp (attention 70850) are the top attention-weighted owned complexity; judged A2 decomplection oracle-first.
  - done when: handleMsg decomplected into named sub-handlers with explicit state, oracle-gated
  - done when: startServer/buildAsApp complexity materially reduced
  - done when: Every land tsc + direct/characterization test + different-model judge PASS
  - done when: No observable behavior change
- **b-ref-vs-owner-control-plane-conflation** → auth-substrate-policy-split (adjacent control-plane surface) — 70 of 100 public operations are control-plane split across /_ref/* and /v1/owner/* with different auth guards — the largest noun-conflation in the B inventory.
  - done when: Every duplicated op + its auth guard enumerated
  - done when: Per-pair decision: two audiences vs one concept
  - done when: Proposal + ratification-queue update; nothing auto-landed
- **b-storage-backend-contract-unification** → storage-backend-contract-unification — postgres-storage.js and the sqlite backend share zero exported names — two storage contracts where the doctrine requires one seam with backends behind it.
  - done when: Both exported surfaces diffed and divergences enumerated
  - done when: Single storage seam interface proposed
  - done when: Migration/DDL-affecting behavior queued for owner ratification
  - done when: Cross-backend conformance-test plan identified
- **b-public-contract-minimum** → B-minimum public-contract catalogue (b-contract-inventory-2026-07-01.md) — The B-minimum inventory is the standing catalogue that keeps A work from becoming blind internal polish; surface-repair items (expand-advisory) draw from it.
  - done when: Inventory kept current as A work emits seam hypotheses
  - done when: Each surfaced mismatch routed to ratification or surface-repair
  - done when: content_ladder + error-model contracts remain by-name covered

## NOT chosen (persisted + aged in quality/agendas/not-chosen.json)

- `server-auth-t0-850ad54c` — T0 certified transform on server/auth.js: auth.js is NOGO in HOTSPOTS (score 68591) and a security surface; doctrine forbids autonomous auth work and requires auth-mutation-killing-tests first. Routed into the b-auth-substrate-policy-split campaign instead (age 2 — not yet at the ≥3 run floor). (age 3)
- `server-index-t0-9b38c77a` — T0 certified transform on server/index.js: Streetlight trap: the T0 tail is 16.3% of repo mass while the file's real cost is startServer/buildAsApp, addressed by srv-index-startserver-buildasapp-a2-decomplect (age 2). (age 3)
- `runtime-index-t0-a9edf2c4` — T0 certified transform on runtime/index.js: Same streetlight trap — clears low-mass T0 while handleMsg (cc=194) is the real target, addressed by hm-handlemsg-oracle-then-extract-campaign (age 2). (age 3)
- `server-records-t1a-35e2deec` — T1a exact-move on server/records.js: records.js mass lives in queryRecords (cc=99, T2-property) and the cross-binding aggregators (cc=73 each, T2-async-order) — T2-in-disguise, not a clean T1a. Route to judged A2 once index/runtime A2 lands (age 2). (age 3)
- `server-db-t0-94a605ef` — T0 certified transform on server/db.js: db.js mass is in the .transaction callbacks (cc=52/39, T2-property, DDL markers CREATE/DROP TABLE) — T2-in-disguise requiring judged proof, not a T0 certified transform (age 2). (age 3)
- `runtime-scheduler-a2` — A2 decomplect of runtime/scheduler.ts: Prior runtime-scheduler-t0 attempt REVERTED at $2.93 with a REJECT judge; lower attention (scheduler mass 30) than the chosen A2 targets — defer (age 2). (age 3)
- `repo-tmp-claims-exhaust-0005` — Delete reference-implementation/tmp-claims.jsonl: owner_ratify gate + a delete against a claims ledger I did not author — deterministic-floor / owner territory; surface, do not proceed (age 2). (age 3)
- `t1b-spine-correlations-annotators-0003` — T1b extraction in lib/spine.ts: BLOCKED per packet-pool/cost-actuals — red baseline; needs the baseline restored before the extraction is provable (age 1). (age 2)
- `b-content-ladder-direct-test-coverage` — Add by-name content_ladder tests: DONE — B-INVENTORY §6.1 shows RESOLVED 2026-07-01 (commit ce8dfc58b, 10 by-name tests at packages/mcp-server/test/content-ladder-contract.test.js). (age 2)

## Deltas from prior

- Kept the prior agenda's top-4 spine (auth-mutation tests → handleMsg A2 → server/index A2 → anon-callback ratchet) — the evidence hasn't moved and these remain the highest attention-weighted, doctrine-named leverage.
- Promoted df-evidence-package-schema-merge-oracle-0004 above the trailing T1b items and paired it explicitly with the REJECTED t1b-package-rs-merge-child-rows-0008 extraction, because the codex REJECT is fresh evidence the merge is unpinned — oracle-first unblocks it.
- Added t1b-streaming-input-telemetry-event-0013 as the archetypal 'capturing closure + direct test' T1b, ahead of the transport shim, since streaming/routes.js carries more T1b mass (70) than transport.
- Demoted docs-query-cookbook-expand-advisory to #12 (cheap surface hygiene, low SLVP-Q) rather than dropping it — it closes ratification-queue #1.
- Re-justified all seven age-2 NOT-CHOSEN items; none has reached the ≥3 run floor, so no forced runs, but each T0/streetlight item is explicitly re-declined against its A2/campaign replacement.

## Human decisions needed

- Ratify or decline collapsing /_ref/* and /v1/owner/* into one control plane (ratification-queue #2) — the largest public-contract noun-conflation; blocks the B control-plane campaign from implementing.
- Ratify the storage-backend contract unification direction: is postgres-storage.js vs the sqlite backend genuinely two contracts, or one seam with two backends? (doctrine-named target — unification is behavior-affecting via migrations/DDL).
- Decide related_stream_not_granted (ratification-queue #1): promote to a thrown error, rename, or keep as advisory-only — determines whether docs-query-cookbook-expand-advisory documents or changes behavior.
- Confirm auth-substrate-policy-split remains a human-ratified B campaign (never autonomous) and that auth-mutation-killing-tests is the accepted unblocking gate before any auth structural change.
- Rule on repo-tmp-claims-exhaust-0005: owner-ratify delete of tmp-claims.jsonl — I decline to auto-proceed on an owner_ratify delete against a ledger I did not author; owner must decide.
