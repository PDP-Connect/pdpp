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
- [x] Build the owner-mediated capture surface (local stdin `credentials`
      interaction and/or owner-session route) that writes to the store and never
      exposes the secret to the agent.
      (`POST /_ref/connections/:connectorInstanceId/static-secret-credential`
      is owner-session-only, resolves the connection under the owner subject,
      accepts the static secret only in the request body, writes through the
      encrypted store's `capture()` seam, emits non-secret audit evidence, and
      returns only metadata plus a run-next-step. Owner-agent bearers without the
      owner-session cookie fail closed; the route is for existing connections and
      does not flip `api_network` intent support.)
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
- [x] Wire the injection seam into the actual run path. Prior tranches built the
      `resolveStaticSecretRunEnv` seam + `buildConnectionScopedSecretEnv` but left
      them unreferenced by any run dispatcher — a captured credential was never
      injected into a real run. The controller's `runNow` now resolves the
      connection-scoped fragment via an injected `resolveStaticSecretRunEnv`
      resolver and threads it to `runConnector` as `staticSecretEnv`, merged LAST
      over `process.env` at spawn (`reference-implementation/runtime/controller.ts`,
      `runtime/index.js`, `runtime/index.d.ts`). The reference server wires the
      real resolver (real credential store + real injection helpers) with a
      credential-EXISTENCE gate: no captured credential → legacy process-env
      fallback (backward compatible); a captured credential → inject for active,
      fail closed for revoked/deleted (`server/index.js`
      `buildControllerStaticSecretRunEnvResolver`). Proven by
      `reference-implementation/test/static-secret-controller-run-injection.test.js`
      (5 tests: scoped injection, two mailboxes distinct, no-credential fallback,
      non-static-secret no-op, revoke fails the run closed). This closes the
      build→run gap WITHOUT touching a live provider; the live-ingest leg below is
      still gated.)
- [~] DEFERRED (owner-only live verification — see "Owner-only residual risk"
      below). Land the end-to-end proof: intent → owner-mediated capture → first
      ingest → addressable labeled `connection_id`, with audit asserting no secret
      leak and two mailboxes producing two `connection_id`s; plus revoke/delete
      durability.
      (Every leg that does NOT require a live provider is already proven with
      synthetic secrets: owner-session capture, revoke/delete durability,
      two-mailbox distinctness, no-leakage audit, and connection-scoped injection
      at the route/store/seam/spawn level. The ONLY unproven leg is
      `first ingest` against a real provider — that requires a real Gmail
      app-password / GitHub PAT and a live network call, which an agent cannot
      supply without faking the success the design forbids (Decision 6). It is
      therefore recorded as an owner-only residual risk rather than left
      pseudo-active, per `openspec/README.md` line 60.)
- [~] DEFERRED (gated on the live proof above; same residual risk). Flip the
      `api_network` intent branch to return `complete_credential_capture` and flip
      the catalog `initiate_connection` descriptor — only after the proof lands, in
      the same reviewable unit.
      (NOT FLIPPED — the runtime branch stays `unsupported`, pinned by
      `owner-connection-intent.test.js`; the contract enum reservation remains in
      place. The flip is a one-unit change the owner-proof lane makes alongside the
      committed live test.)

## Owner-only residual risk (live provider proof)

Per `openspec/README.md` line 60, the remaining work is owner-only live
verification and is recorded here as a residual risk so this change can be
archived rather than remain pseudo-active. Everything an agent can prove without
a live provider secret is proven and green (39 focused tests across the four
`static-secret-*` / `owner-connection-intent` suites).

What still needs a human owner with a real provider secret:

1. Configure `PDPP_CREDENTIAL_ENCRYPTION_KEY` (32-byte base64) on the reference
   server.
2. Create a Gmail connection (and a second one) under an owner session; capture a
   real Gmail app-password into each via
   `POST /_ref/connections/:connectorInstanceId/static-secret-credential`
   (owner-session cookie required; the secret travels only in the request body).
3. Run each connection (`runNow`). Confirm a real first ingest persists records
   addressable under that one `connection_id`, and that the two mailboxes
   materialize as two distinct `connection_id`s with no cross-contamination.
4. Inspect the `owner_agent.connection.initiate` / capture audit evidence and the
   stored credential row: confirm NO plaintext secret appears in any audit event,
   REST/MCP/console read surface, or log line.
5. Revoke one credential and confirm the next run fails closed (no stale or
   process-global secret); delete the connection and confirm the credential row is
   cascade-removed and does not resurrect.
6. ONLY after 1–5 are observed green: flip the `api_network` intent branch to
   `complete_credential_capture` and flip the catalog `initiate_connection`
   descriptor in one reviewable unit, replacing the `unsupported` pin in
   `owner-connection-intent.test.js` with the committed live-proof assertion.

Rollback remains route-level: the intent branch reverts to `unsupported`; stored
credentials remain valid instance-scoped state under normal retention/delete
rules.

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
5. `node --test reference-implementation/test/static-secret-owner-capture-route.test.js`
   passes, proving owner-session capture fail-closed behavior, no secret in the
   response/audit, per-connection scoping, rotation, owner scoping, and
   owner-agent bearer rejection.
6. `git diff --check` reports no whitespace errors.
7. The design names: the per-connection encrypted credential store (instance-scoped,
   never returned), owner-mediated capture (agent never sees the secret),
   connection-scoped injection (two mailboxes → two `connection_id`s),
   `complete_credential_capture` justified against the contract, distinct
   credential/connection lifecycle, and the proof-before-flip gate.
