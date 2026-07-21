## 1. Completed OpenSpec authoring slice

- [x] 1.1 Reconcile the H-E-B/Reddit success evidence, ChatGPT process-loss and
  exact-probe evidence, active browser-health/retention/repair changes, current
  allocator/manager behavior, and durable capability specs.
- [x] 1.2 Add the focused runtime-health, allocator-observation, receipt,
  replacement-ledger, and continuity-overlay deltas.
- [x] 1.3 Amend the active retention change so genuine process loss is not an
  immediate owner-repair assertion.
- [x] 1.4 Correct the owner audit findings: installed-stop-reason-aligned enum
  spelling, the complete closed replacement-cause set, two-phase receipts, typed
  provider proof, current-generation selection, and honest `listSurfaces()`
  network-repair wording. Luna's provisional six-literal fixture is explicitly
  non-authoritative.

## 2. In-scope implementation and deterministic verification

- [x] 2.1 Implement `EphemeralBrowserRuntimeProjection` with the exact
  `connection_kind`, `surface_mode`, `allocator_observation`, `demand`,
  `active_lease`, `current_compatible_idle_surfaces`, `credential_continuity`,
  `last_successful_runtime_receipt`, `current_replacement_receipt`, and
  `health_eligible` handoff names. Keep runtime eligibility separate from the
  connection-health collectability/headline projection.
- [x] 2.2 Implement one shared `listSurfaces()` observation per dynamic allocator
  scope and full refresh. Expiry is `status: "unknown", reason: "expired"`; it
  cannot serve stale green. Assert the health path never calls `ensureSurface`,
  creates, stops, restarts, or leases a surface, while allowing only the
  allocator's bounded idempotent existing-container network-attachment repair.
- [x] 2.3 Implement `LastSuccessfulRuntimeReceipt` as the exact bounded
  `ready -> succeeded -> released` chain. Parameterize H-E-B and Reddit and reject
  age, connection, profile, run, surface-subject, surface, lease, generation,
  timestamp, and order mismatches without granting headline authority.
- [x] 2.4 Implement the append-only non-secret replacement ledger and current
  receipt selection. Its exact closed causes are `capacity_pressure`, `idle_ttl`,
  `operator_requested`, `restart_reconcile`, `readiness_invalidated`,
  `allocator_internal_ensure_surface`, `same_container_browser_generation_change`,
  and `external_or_host_loss`; update Luna's provisional six-literal acceptance
  fixture to this eight-cause enum. Test `started -> completed` and truthful terminal outcomes, deterministic
  idempotency/replay rejection, generation-hash redaction, current-generation
  selection, existing RI allocator metadata/projection integration, SQLite/Postgres
  parity, and two isolated connections without changing the remote-surface package.
- [x] 2.5 Implement the process-bound continuity overlay. Pending, false, and
  indeterminate replacement states are non-green diagnostics with no owner action.
  Require the typed, connection-bound `ProviderInvalidationProof`; reject arbitrary
  strings, replacement receipts, false/indeterminate exact probes, and DOM/URL/
  profile heuristics; deduplicate to at most one repair per connection and proof.
- [x] 2.6 Prove dynamic allocator available + no demand + zero idle is eligible;
  allocator unavailable/unknown/expired and active unhealthy/missing lease fail
  closed; static absence is unavailable; unmanaged/non-browser/local-device uses
  `surface_mode: "none"` and is not degraded by managed-runtime evidence.

## 3. OPEN cross-boundary handoff — not completed by this change

- [ ] 3.1 Obtain separate authorization for an encrypted connection-scoped
  secret-session store. Do not infer its schema, crypto, retention, or transport
  from this change.
- [ ] 3.2 Implement the three authorized owners only after that approval:
  `packages/polyfill-connectors` provider adapter and exact probe;
  `reference-implementation/runtime` fencing/checkpoint/replace/restore/probe
  orchestrator; and the separately authorized encrypted connection-scoped store.
- [ ] 3.3 Run the mandatory two-isolated-connection forced process/container
  replacement gate using each connector's exact authenticated-session probe. For
  ChatGPT, HTTP 200 with no `user` is false. Prove no DOM/URL/profile heuristic,
  cross-connection state, or false owner action can pass the gate. Keep it marked
  OPEN / UNSATISFIED until independent success.

## 4. OpenSpec validation

- [x] 4.1 Run focused implementation checks once implementation exists.
- [x] 4.2 Run `openspec validate separate-ephemeral-browser-runtime-health --strict`.
- [x] 4.3 Run `openspec validate --all --strict` and `git diff --check`.
