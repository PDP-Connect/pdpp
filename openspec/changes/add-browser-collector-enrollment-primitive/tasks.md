## 1. Design (this lane)

- [x] Confirm the gap and grounding facts in tree (enroll route hardcodes
      `local_device`; intent route classifies `browser` → `browser_bound` →
      `unsupported`; Amazon manifest declares `bindings.browser.required`).
- [x] Decide `browser_collector` is a connector-instance source kind, a peer of
      `local_device`, and explicitly not the spine `SourceKind` union.
- [x] Specify binding-aware enrollment gating (manifest-derived, contradiction
      rejection, no defaulting).
- [x] Specify owner-mediated browser-bound initiation reaching a typed next step
      with `connection_active: false`.
- [x] Specify the proof precondition before any route flips Amazon off
      `unsupported`.
- [x] State Core / Collection Profile / reference boundaries and defer the
      `browser` binding-name reconciliation to its design note.
- [x] Write proposal, design, and spec deltas.

## 2. Validation (this lane)

- [x] `pnpm exec openspec validate add-browser-collector-enrollment-primitive --strict` (valid)
- [x] `pnpm exec openspec validate --all --strict` (39 passed, 0 failed)
- [x] `git diff --check` (clean, exit 0)

## 3. Implementation

- [x] Add `browser_collector` to the connector-instance source-kind type and the
      enroll handler's `sourceBinding` construction. (Widened the
      `connector_instances.source_kind` CHECK in sqlite `db.js` + postgres
      `postgres-storage.js`, with forward migrations for already-migrated DBs,
      and the store-level `VALID_SOURCE_KINDS` guard. Enroll handler now writes
      the manifest-derived kind for both `sourceKind` and `sourceBinding.kind`.)
- [x] Add a manifest-derived source-kind resolver shared by the enrollment-code
      and enroll routes; reuse the intent classifier's binding precedence.
      (`server/routes/connector-source-kind.ts`; `filesystem` wins over
      `browser`, matching `classifyConnectorIntentModality`.)
- [x] Reject contradicting / unresolvable source kinds with typed errors; unit
      coverage for filesystem→`local_device`, browser→`browser_collector`,
      contradiction→reject, no-binding→reject. (Unit tests in
      `test/connector-source-kind.test.js`; route-level enroll tests in
      `test/device-exporter-routes.test.js`. The enrollment-code route rejects a
      contradicting/unresolvable kind before minting a code.)
- [x] Surface the already-shipped manual Amazon browser_collector enrollment
      primitive in the operator console without flipping the proof-gated
      owner-agent intent route. (`/dashboard/records` now lists Amazon under a
      manual browser-collector setup path, `/dashboard/device-exporters` accepts
      `?connector=amazon` as a supported prefill, and the enrollment form
      generates monorepo browser-collector enroll/run commands while preserving
      the "not one-click" proof boundary.)
- [ ] Land an Amazon end-to-end proof test that drives enrollment → browser
      session → device-exporter ingest, plus a scrubbed Amazon fixture.
      (STILL OWNER/LIVE-GATED. The deterministic, no-human HALF landed in lane
      `ri-browser-collector-proof-harness-v1`:
      `reference-implementation/test/browser-collector-ingest-proof.test.js`
      drives the real enroll → heartbeat → `ingest-batches` → records-persisted
      path for a `browser_collector` Amazon instance, ingesting records the real
      Amazon connector parsers produce (committed fixture
      `reference-implementation/test/fixtures/amazon-browser-collector-proof-records.json`,
      generated + drift-locked against the live parsers over the scrubbed DOM
      fixture `fixtures/amazon/scrubbed/pilot-real-shape/dom/orders-list-2026.html`
      by `packages/polyfill-connectors/connectors/amazon/proof-ingest-records.test.ts`),
      and proves multi-account isolation. The monorepo runner now registers the
      `amazon` local-device profile (`src/local-device-runtime.ts`) so the
      live run is executable. What remains is the LIVE half — a real,
      owner-logged-in Amazon browser session producing those records, scrubbed
      into a committed `fixtures/amazon/scrubbed/<runId>/` fixture — which cannot
      be produced honestly in a no-human worktree. The owner-run procedure and
      the exact closing artifact are documented in
      `docs/operator/browser-collector-proof-runbook.md`.
      Lane `ri-browser-collector-proof-reduction-v2` further reduced the live
      gate's surface without faking support: (a) the runbook's source-kind
      verification step is now backed by a deterministic test
      (`reference-implementation/test/owner-connections-list.test.js` →
      "owner-agent bearer sees source_kind=browser_collector …") that enrolls
      Amazon through the real binding-aware path and asserts
      `GET /v1/owner/connections` honestly reports `source_kind:
      browser_collector` — so the owner can verify the source-kind half of the
      live run through the owner-agent API, with no SQL; (b) the runbook was
      corrected to be copy-paste executable: it now exports both the distinct
      `connector_instance_id` (verification filter) and `source_instance_id`
      (`run --connection-id`) ids the enroll response returns, and the Step 2
      source-kind check no longer queries `source-instances` — which does NOT
      carry `source_kind` — but the owner-agent listing that does.)
- [ ] Flip the `browser_bound` intent branch to return `enroll_browser_collector`
      only after the proof lands; add `add-owner-agent-control-surface` tasks
      5.3 / 8.5 Amazon second-account acceptance coverage.
      (INTENTIONALLY UNFLIPPED. Left as honest `unsupported` until the LIVE
      proof above lands and is committed — the spec
      (`local-device-exporter-collection`: "Browser-bound connectors SHALL NOT
      advertise a real next step without committed proof") forbids advertising
      the next step without committed proof, and requires the flip and the proof
      to be reviewable as one unit. The flip steps are pre-written in the
      runbook §7.
      Lane `ri-browser-collector-live-proof-tail-v3` removed one no-human
      prerequisite the flip would otherwise have to carry: the published contract
      now RESERVES `enroll_browser_collector` in the
      `POST /v1/owner/connections/intents` `next_step.kind` enum
      (`packages/reference-contract/src/reference/index.ts`
      `OwnerConnectionIntentNextStepSchema`, regenerated into
      `reference-implementation/openapi/reference-full.openapi.json`), alongside
      the other reserved-but-unemitted kinds (`open_url`,
      `complete_browser_assistance`, `upload_file`) — exactly as design Decision 3
      states. Reserving the value does NOT advertise the flow: no route emits it,
      and the runtime `browser_bound` branch still returns `unsupported` (pinned by
      `test/owner-connection-intent.test.js` →
      "owner-agent initiating a browser-bound connector (Amazon) gets a typed
      unsupported"). A new contract test ("owner-agent intent contract reserves
      enroll_browser_collector without emitting it") pins the reservation against
      the generated OpenAPI so a regen/edit can't silently drop it (negative
      control verified). Net effect: the post-proof flip is now a single reviewable
      unit — flip the branch + its tests — with no hidden contract-widening step.)

## Acceptance checks

Reproducible from the worktree root:

1. `pnpm exec openspec validate add-browser-collector-enrollment-primitive --strict`
   exits 0.
2. `pnpm exec openspec validate --all --strict` exits 0.
3. `git diff --check` reports no whitespace errors.
4. The design names: `browser_collector` (distinct from `local_device` and from
   the spine `SourceKind`), binding-aware enrollment, the owner-mediated
   next-step-without-active-connection rule, and the proof-before-flip gate.
