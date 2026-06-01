## 1. Design (this lane)

- [x] Confirm the gap and grounding facts in tree (gmail/github declare
      `network` binding → `api_network` → `unsupported`; both authenticate with a
      static provider secret read from process env or a local stdin `credentials`
      `INTERACTION`; no per-connection encrypted credential store exists;
      `collector-runner.ts` injects credentials process-global).
- [x] Decide the per-connection credential store is reversible-encrypted,
      instance-scoped state with an owner/operator-held key, never a device-token
      hash and never agent-held.
- [x] Specify the no-leakage read contract (never returned via REST/MCP/console;
      only non-secret metadata).
- [x] Specify owner-mediated capture with the agent-never-sees-secret invariant
      and the trust-equivalent capture surfaces (local stdin / owner session).
- [x] Specify connection-scoped subprocess injection with two-mailbox → two
      `connection_id`s as the construction test.
- [x] Justify `complete_credential_capture` as a distinct next-step kind against
      the contract (not `open_url`, not a flag on `enroll_local_collector`).
- [x] Keep rotation / credential-revoke / connection-revoke / delete distinct, no
      implicit resurrection.
- [x] State the relationship to owner tokens, owner sessions, local collectors,
      and `/mcp` owner-bearer rejection.
- [x] Specify the proof-before-flip gate (no-leakage, no-row-before-capture,
      two-account, revoke/delete-durability, live owner proof).
- [x] Write proposal, design, and spec delta.

## 2. Contract reservation (this lane — safe, no provider secret)

- [x] Reserve `complete_credential_capture` in the
      `OwnerConnectionIntentNextStepSchema` `next_step.kind` enum
      (`packages/reference-contract/src/reference/index.ts`), alongside the other
      reserved-but-unemitted kinds, and document in the schema comment that no
      route emits it until the static-secret primitive lands with proof.
- [x] Regenerate contract artifacts (`pnpm --filter @pdpp/reference-contract run
      generate:all`) so `reference-implementation/openapi/reference-full.openapi.json`
      and the generated docs carry the reserved value.
- [x] Pin reserved-but-not-emitted: extend
      `reference-implementation/test/owner-connection-intent.test.js` so the gmail
      `api_network` case asserts `next_step.kind !== 'complete_credential_capture'`
      (it stays `unsupported`), mirroring the `enroll_browser_collector` pin.

## 3. Validation (this lane)

- [x] `pnpm exec openspec validate add-static-secret-owner-connect-primitive --strict`
- [x] `pnpm exec openspec validate --all --strict`
- [x] `pnpm --filter @pdpp/reference-contract run check:generated`
- [x] `node --test reference-implementation/test/owner-connection-intent.test.js`
- [x] `git diff --check`

## 4. Implementation (lane `ri-static-secret-owner-connect-implementation-v1`)

- [x] Build the per-connection encrypted credential store: reversible encryption
      at rest, keyed to one `connection_id`, owner/operator-held key, no-leakage
      read contract.
      (`reference-implementation/server/stores/credential-encryption.js`,
      `connector-instance-credential-store.js`; schema in `db.js` +
      `postgres-storage.js`; SQL artifacts in
      `server/queries/connector-instance-credentials/`. AES-256-GCM under
      `PDPP_CREDENTIAL_ENCRYPTION_KEY`, fail-closed when unconfigured; reads
      project only kind/status/fingerprint/timestamps. 15 tests.)
- [ ] Build the owner-mediated capture surface (local stdin `credentials`
      interaction and/or owner-session route) that writes to the store and never
      exposes the secret to the agent.
      (DEFERRED — needs a real owner-supplied provider secret; out of scope for
      this no-human-secret lane. The store's `capture()` write path is the seam a
      capture surface calls.)
- [x] Implement connection-scoped subprocess injection in
      `packages/polyfill-connectors`, replacing process-global env for
      static-secret connectors.
      (`packages/polyfill-connectors/src/static-secret-injection.ts` +
      runner-barrel export; `reference-implementation/server/stores/static-secret-run-credentials.js`
      ties store recovery to injection. The per-run `connector.env` fragment
      merges LAST over `process.env` at spawn. 9 + 7 tests, incl. a live
      `runCollectorConnector` spawn-path proof that two gmail connections run with
      distinct secrets and override a polluted process-global env.)
- [x] Implement rotation / credential-revoke / connection-revoke / delete with no
      implicit resurrection.
      (Store `capture` rotate / `revoke` / `delete`; FK `ON DELETE CASCADE`
      removes the credential when the connection is deleted; the run seam fails
      closed on revoked/deleted credentials; re-capture is the only resurrection.
      Connection-revoke already fails runs closed via the resolver's active-status
      gate, kept distinct from credential lifecycle per Decision 7.)
- [ ] Land the end-to-end proof: intent → owner-mediated capture → first ingest →
      addressable labeled `connection_id`, with audit asserting no secret leak and
      two mailboxes producing two `connection_id`s; plus revoke/delete durability.
      (PARTIAL — revoke/delete durability, two-mailbox distinctness, and
      no-leakage are proven at the store/seam/injection level with synthetic
      secrets. The intent → owner-capture → first-ingest LIVE leg requires a real
      provider secret and is deferred to a lane that can supply one.)
- [ ] Flip the `api_network` intent branch to return
      `complete_credential_capture` and flip the catalog `initiate_connection`
      descriptor — only after the proof lands, in the same reviewable unit.
      (NOT FLIPPED — gated on the live proof above. The runtime branch stays
      `unsupported`, pinned by `owner-connection-intent.test.js`; the contract
      enum reservation remains in place.)

## Acceptance checks

Reproducible from the worktree root:

1. `pnpm exec openspec validate add-static-secret-owner-connect-primitive --strict`
   exits 0.
2. `pnpm exec openspec validate --all --strict` exits 0.
3. `pnpm --filter @pdpp/reference-contract run check:generated` exits 0 (the
   reserved enum value is consistently present in the generated artifacts).
4. `node --test reference-implementation/test/owner-connection-intent.test.js`
   passes, including the new assertion that the gmail `api_network` case stays
   `unsupported` and is not `complete_credential_capture`.
5. `git diff --check` reports no whitespace errors.
6. The design names: the per-connection encrypted credential store (instance-scoped,
   never returned), owner-mediated capture (agent never sees the secret),
   connection-scoped injection (two mailboxes → two `connection_id`s),
   `complete_credential_capture` justified against the contract, distinct
   credential/connection lifecycle, and the proof-before-flip gate.
