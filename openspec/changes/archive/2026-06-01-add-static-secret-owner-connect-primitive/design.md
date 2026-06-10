## Context

PDPP brings personal data into a resource server through several connection
topologies. Three matter to the owner-agent connection-intent route
(`POST /v1/owner/connections/intents`), which classifies a connector by its
manifest `runtime_requirements.bindings`:

- **Filesystem-backed local collection** (`claude-code`, `codex`): `filesystem`
  binding → `local_collector` modality. Proven; the intent route returns a typed
  `enroll_local_collector` next step.
- **Browser-bound collection** (`amazon`, `chase`, `chatgpt`): `browser` binding →
  `browser_bound` modality. The `browser_collector` enrollment primitive ships
  (`add-browser-collector-enrollment-primitive`); the one-click next step is gated
  on committed live proof.
- **API/network collection** (`gmail`, `github`): `network` binding →
  `api_network` modality. Today this returns `unsupported`. This change designs the
  primitive for it.

The owner-agent control surface (`add-owner-agent-control-surface`, commit
`f319f326`) made the gap visible and honest in `unsupportedReason("api_network")`
and in its design's "Deferred: API/network connection initiation" packet. That
packet established the credential model (verified in tree) and named the missing
primitive. This change promotes the packet to a standalone construction-quality
design so the primitive is reviewable on its own, and reserves the one safe
contract value. It does **not** implement the credential-handling parts (those are
the next lane, and each handles a real provider secret).

### Grounding facts (verified in tree)

- `packages/polyfill-connectors/manifests/gmail.json` and `github.json` declare
  `runtime_requirements.bindings: { network: { required: true } }` — no `browser`,
  no `filesystem`. The intent classifier maps this to `api_network`
  (`owner-connection-intent.ts` `classifyConnectorIntentModality`).
- **Gmail** (`packages/polyfill-connectors/connectors/gmail/index.ts`) connects
  over **IMAP with a Google app password** (`GOOGLE_APP_PASSWORD_PDPP` /
  `GMAIL_APP_PASSWORD`) plus the mailbox address (`GMAIL_ADDRESS` / `GMAIL_USER`),
  resolved from **process env, or — when env is absent — via a local stdin
  `INTERACTION` (`kind: "credentials"`)** that prompts the owner running the
  connector locally (`resolveGmailPasswordFromEnv` / `resolvePassword`,
  index.ts:462-526). No Google OAuth client, consent URL, or redirect exists.
- **GitHub** (`packages/polyfill-connectors/connectors/github/index.ts:5,406-409`)
  authenticates with a **Personal Access Token** (`GITHUB_PERSONAL_ACCESS_TOKEN` /
  `GITHUB_TOKEN`), resolved the same way. No OAuth authorize endpoint.
- **No OAuth client config exists in the repo.** `.env.docker.example` carries only
  the passthrough secrets above. PDPP's own `/oauth/*` endpoints issue PDPP grant
  tokens; they do not connect a third-party mailbox/account as a data *source*.
- **No per-connection encrypted credential store exists.** The device-exporter
  store hashes *device tokens* one-way (`createCredential` →
  `tokenHash`, `device-exporter-store.js:258`); that is a one-way verification
  hash, not recoverable secret storage. Provider static secrets must be
  *recoverable* to inject into a connector subprocess, so a hash is structurally
  insufficient. This is greenfield.
- **Subprocess credential injection is process-global.** `collector-runner.ts`
  `spawnConnector` (≈1928) spawns with `{ ...process.env, ...buildCollectorChildEnv(...), ...connector.env }`;
  `buildCollectorChildEnv` injects only runtime URLs/tokens
  (`PDPP_REFERENCE_BASE_URL`, `PDPP_LOCAL_DEVICE_TOKEN`, `PDPP_RUN_ID`). The
  provider secret must already exist in the parent process env — there is no
  per-`connection_id` scoping.
- The intent next-step enum
  (`packages/reference-contract/src/reference/index.ts`
  `OwnerConnectionIntentNextStepSchema`) reserves `open_url`,
  `complete_browser_assistance`, `upload_file`, `enroll_local_collector`,
  `enroll_browser_collector`, `unsupported`. There is **no**
  `complete_credential_capture` value yet.
- `owner-connection-intent.test.js:312-372` already pins gmail → `api_network` →
  `unsupported` with an extensive honest-reason matrix (static-secret model named,
  `open_url` negated, no dashboard loop). This change extends, not rewrites, that
  pin.

## Goals / Non-Goals

**Goals:**

- Define the per-connection encrypted credential store as instance-scoped durable
  state: encrypted at rest, keyed to one `connection_id`, never returned by any
  read surface, with rotation/revocation/delete semantics distinct from connection
  lifecycle.
- Define the owner-mediated capture flow: the owner supplies the static secret
  through an owner-trusted local surface; the agent observes only a typed next step
  and the resulting `connection_id`.
- Define connection-scoped subprocess injection so two static-secret connections
  for the same connector type (two Gmail mailboxes) run as two addressable
  `connection_id`s, escaping the process-global single-account limitation.
- Define the typed next-step shape and reserve `complete_credential_capture` in the
  intent enum as the single safe contract change in this lane.
- Make proof a precondition before any route flips `api_network` off `unsupported`.
- Keep Core / Collection Profile / reference / operator boundaries explicit, and
  keep the agent-never-sees-secrets invariant load-bearing.

**Non-Goals:**

- Do not flip the owner-agent `api_network` intent branch until end-to-end proof
  lands. Implementation tranches may add the store, capture surface, and
  connection-scoped injection only when each tranche preserves the invariant that
  provider static secrets stay owner-mediated and never agent-readable.
- Do not wire Gmail/GitHub to `open_url`. They are not OAuth-backed; there is no
  authorization URL to open. `open_url` becomes emittable only if a genuinely
  OAuth-backed connector is added later (with a provider OAuth app whose secrets
  stay server/owner-side, never with the agent).
- Do not promote credential-store, capture, or `connection_id`-scoped-injection
  vocabulary into PDPP Core. These are reference / Collection Profile
  implementation concerns. Core stays collection-method agnostic.
- Do not add an MCP tool or widen `/mcp`. The capture flow is owner-mediated and
  local; `/mcp` continues to reject owner bearers (`requireClientOrMcpPackage`).
- Do not authorize headless OAuth or agent-held secrets at any step.

## Decisions

### 1. The per-connection credential store is instance-scoped reversible-encrypted state, not a device-token hash

The device-exporter store hashes device tokens one-way because it only ever needs
to *verify* a presented token. A provider static secret is different: the
orchestrator must *recover* it to authenticate to the provider on the connection's
behalf. So the credential store is **reversible encryption at rest**, not a hash.

The durable rule:

- A static-secret credential SHALL be stored encrypted at rest, keyed to exactly
  one `connection_id` (equivalently the `connector_instance_id` that backs the
  connection). It is instance-scoped state, a peer of the instance-scoped storage
  and schedule state `reference-connector-instances` already mandates.
- The plaintext secret SHALL NOT be returned by any REST, MCP, or console read.
  Reads expose only non-secret metadata: which `connection_id` has a credential,
  its kind (`app_password` / `personal_access_token`), capture/rotation timestamps,
  and validity state — never the secret bytes.
- The encryption key is an instance/server secret (owner/operator-held), never an
  agent-held or client-held key. This keeps the secret recoverable by the
  orchestrator and unreadable by an agent that only holds an owner-agent bearer.

No new top-level noun is minted: the credential is attached to the existing
connector-instance identity, the same way schedules and source bindings already
are. A credential becomes first-class only if it needs independent lifecycle beyond
the connection, which it does not — a credential exists for exactly one connection.

### 2. Capture is owner-mediated; the agent never sees the secret

The owner (not the agent) supplies the app-password / PAT through an owner-trusted
surface. Two surfaces are trust-equivalent and both acceptable:

- the existing **local stdin `INTERACTION` (`kind: "credentials"`)** the Gmail /
  GitHub connectors already use when env is absent — the owner types the secret
  into their own local collector process; or
- an **owner-session surface** (cookie-authed `/dashboard`-class route) where the
  owner pastes the secret into their own browser session.

In both, the secret travels owner → owner's environment / owner's session →
encrypted store. It never travels through the agent. The owner-agent bearer surface
exposes only:

- the typed next step `complete_credential_capture` (what the owner must do, and
  where), and
- after capture + first ingest, the resulting addressable `connection_id`.

This is the same trust shape the diagnostics and revoke packets used ("build on the
owner-session surface, then share the non-secret projection under the owner
bearer"). As of the owner-session capture tranche, the reference has a
connection-scoped `/_ref` route for existing connections; the owner-agent intent
branch still waits for the end-to-end proof in Decision 6 before it advertises
`complete_credential_capture`.

### 3. The intent does not create a connection; the row materializes on capture + first ingest

This mirrors the established local-collector and browser-collector rule: the intent
is an auditable workflow object, not a mutation. `connection_active` is always
`false` and the intent writes no `connector_instances` row.

- Before proof: the `api_network` branch returns `unsupported` (current behavior).
  The reason names this primitive. No code change flips it early.
- After proof (Decision 6): the branch MAY return
  `next_step.kind: "complete_credential_capture"` carrying the owner-mediated
  capture instruction and endpoint. The response SHALL keep
  `connection_active: false`.

The connection materializes only when the owner completes capture **locally** and
the connector ingests at least one batch for that instance. Initiation continues to
emit `owner_agent.connection.initiate` spine evidence (actor, connector key,
modality, next-step kind, outcome) and SHALL never log the secret, the owner
cookie, or the bearer token.

### 4. `complete_credential_capture` is a distinct reserved next-step kind, justified against the contract

The existing enum reserves unused kinds (`open_url`, `complete_browser_assistance`,
`upload_file`) and recently added `enroll_browser_collector` as a reserved-then-
emitted kind. `complete_credential_capture` joins them under the same discipline:

- **Why a distinct kind, not `open_url`.** `open_url` means "send the owner to a
  provider authorization URL." Gmail/GitHub have no such URL. Reusing `open_url`
  would assert an OAuth flow that does not exist and mislead a future implementer
  into wiring a redirect the connector cannot consume. The intent test already
  negates `open_url` for gmail for exactly this reason.
- **Why a distinct kind, not a flag on `enroll_local_collector`.** Local-collector
  enrollment mints a device enrollment code for a filesystem scan. Static-secret
  capture mints nothing of the sort; it asks the owner to supply a provider secret.
  The collector and the owner need to see "supply a credential" without parsing a
  flag, the same argument that justified a distinct `enroll_browser_collector`.
- **Why reserving it now is safe.** Reserving the value widens an enum that no route
  emits. It touches zero provider secrets and creates no provider-secret surface. It
  keeps the eventual post-proof flip a single reviewable unit (a branch change plus
  proof) rather than a flip plus a contract widening. A test pins that the runtime
  `api_network` branch stays `unsupported`, so the reservation does not advertise
  the flow.

### 5. Connection-scoped subprocess injection replaces process-global env

The process-global env model (`collector-runner.ts` spawn) is the structural reason
the reference is single-account per connector today: one secret in the parent
process means one mailbox. The durable rule for the implementation lane:

- The orchestrator SHALL load the per-`connection_id` secret from the encrypted
  store and inject it into the connector run scoped to that one instance — via the
  existing stdin `credentials` `INTERACTION` channel (the connector already accepts
  it), not by mutating the shared `process.env`.
- Two connections for the same connector type SHALL run with their own secrets, so
  "Gmail personal" and "Gmail work" are two `connection_id`s with two mailboxes, not
  a collision on one global secret.

This keeps the secret out of the process-global environment, narrows its lifetime to
one run, and makes multi-account correct by construction rather than a special case.

### 6. Proof is a precondition, not a follow-up

The acceptance bar from `add-owner-agent-control-surface` is explicit: claiming a
flow the reference does not prove is a faked success and is forbidden. Therefore, no
route SHALL advertise `complete_credential_capture` (or otherwise flip `api_network`
off `unsupported`) until a committed test shows, end to end:

- **intent → owner-mediated capture → first ingest → addressable labeled
  `connection_id`** for a static-secret connector (Gmail or GitHub);
- the intent writes **no `connector_instances` row** before capture + first ingest;
- the agent **never** observes the app-password / PAT / owner cookie at any step
  (audit asserts no secret in `owner_agent.connection.initiate` evidence, and no
  read surface returns the secret);
- **two connections for the same connector** (two mailboxes) materialize as **two
  distinct addressable `connection_id`s**, proving the primitive escaped the
  process-global single-account limitation;
- the credential store survives revoke/delete with the durability semantics in
  Decision 7;
- the catalog `initiate_connection` descriptor flips `unsupported` → the typed step
  only in that same unit.

Until the proof lands, `unsupported` with the named gap is the honest output, and
this change ships only the reserved enum value plus its not-emitted pin.

### 7. Rotation, revocation, and delete are distinct from connection lifecycle

`full-context-refresh` warns against conflating revocation, deletion, retention, and
access validity. The credential store SHALL keep these distinct:

- **Rotation**: replacing the stored secret for a `connection_id` (the owner
  re-captures) SHALL preserve the connection, its `connection_id`, its history, and
  its schedule. Rotation changes only the secret bytes and a rotation timestamp.
- **Credential revocation**: marking a connection's credential invalid SHALL stop
  future runs for that connection without deleting collected records or the
  connection row, and SHALL be reflected as a non-secret validity state in reads.
  This is distinct from *connection* revocation, which flips the connection's
  lifecycle status.
- **Delete**: deleting a connection SHALL delete its stored credential (no orphaned
  secret survives a deleted connection). Deleting a credential SHALL NOT silently
  resurrect on the next ingest — consistent with the revoke-durability guard, a
  deleted/revoked credential requires an explicit owner re-capture, never an
  implicit default-account materialization.

These align with the existing `delete_connection` / `revoke_connection` control
families: credential lifecycle is a sub-aspect of the connection it belongs to,
never a separate resurrection path.

### 8. Relationship to owner tokens, owner sessions, local collectors, and `/mcp`

- **Owner-agent bearer** authorizes the *intent* and the non-secret reads. It never
  carries, captures, or returns the provider secret.
- **Owner session** (cookie) is one acceptable capture surface (Decision 2); it is
  the owner acting in their own browser, not the agent.
- **Local collector** is the other acceptable capture surface and the runtime that
  receives the injected secret (Decision 5); it runs in the owner's environment.
- **`/mcp`** is untouched. Owner bearers are still rejected at `/mcp`
  (`requireClientOrMcpPackage`); advertising `complete_credential_capture` in the
  REST intent response does not widen MCP, and no MCP tool returns a secret.

## Risks / Trade-offs

- **Risk: a reversible credential store is a new high-value secret surface.**
  Mitigation: it is design-only here; the implementation lane owns key management,
  and the no-leakage requirement (never returned by any read) is normative before a
  byte is stored. The agent-bearer surface never touches the store's plaintext.
- **Risk: reserving `complete_credential_capture` reads as advertising the flow.**
  Mitigation: a test pins the `api_network` branch to `unsupported`; the reserved
  value is emitted by no route, exactly as `enroll_browser_collector` was reserved
  before its proof.
- **Risk: a future lane wires Gmail/GitHub to `open_url`.** Mitigation: the design
  and the existing intent test both negate `open_url` for these connectors and name
  the static-secret model; `open_url` is reserved only for a genuinely OAuth-backed
  connector that does not exist yet.
- **Risk: credential lifecycle gets conflated with connection lifecycle.**
  Mitigation: Decision 7 keeps rotation / credential-revoke / connection-revoke /
  delete distinct and forbids implicit resurrection.
- **Risk: process-global injection persists and two mailboxes still collide.**
  Mitigation: the two-account-distinct proof gate (Decision 6) fails unless
  injection is connection-scoped.

## Migration Plan

This change began as design + one safe contract reservation. The migration below
tracks the implementation status without weakening the proof-before-flip gate.

1. (this lane) Reserve `complete_credential_capture` in the intent next-step enum,
   regenerate contract artifacts, and pin the `api_network` branch to
   `unsupported` in `owner-connection-intent.test.js`.
2. Done: build the per-connection encrypted credential store (Decision 1) with the
   no-leakage read contract and rotation/revoke/delete semantics (Decision 7).
3. Done for existing connections: build the owner-mediated owner-session capture
   surface (Decision 2) that writes to the store and never exposes the secret to
   the agent.
4. Done: implement connection-scoped subprocess injection (Decision 5) in
   `collector-runner.ts`, replacing process-global env for static-secret
   connectors.
5. Land the end-to-end proof test + two-mailbox proof (Decision 6).
6. Only then: flip the `api_network` intent branch to return
   `complete_credential_capture`, and flip the catalog `initiate_connection`
   descriptor for the connector — in the same reviewable unit as the proof.

Rollback is route-level: the intent branch reverts to `unsupported`; stored
credentials remain valid instance-scoped state governed by normal retention and
delete rules.

## Open Questions

- Should the local-stdin capture surface also ship, or is the owner-session
  capture route sufficient for the first proof? The owner-session route now covers
  existing connections; local-stdin remains a possible companion because it reuses
  the connector's existing `credentials` `INTERACTION`.
- Does GitHub's PAT (broad repo scope) or Gmail's app-password warrant a
  per-connector capture warning or scope hint at capture time? Flagged for the
  implementation lane; out of scope here.
- Where does the store encryption key live in the Docker reference topology
  (env-provided KMS-style vs. file-backed)? An implementation-lane decision; the
  design only requires it be owner/operator-held and never agent-held.

## Acceptance Checks

- [x] The per-connection encrypted credential store is specified: encrypted at
      rest, keyed to one `connection_id`, never returned by any read, key
      owner/operator-held.
- [x] Owner-mediated capture is specified with the agent-never-sees-secret
      invariant and the trust-equivalent capture surfaces named.
- [x] Connection-scoped subprocess injection is specified, with two mailboxes →
      two `connection_id`s as the construction test.
- [x] The typed next step is specified and `complete_credential_capture` is
      justified against the contract (not `open_url`, not a flag), and reserved
      as the single safe code change.
- [x] Rotation / credential-revoke / connection-revoke / delete are kept distinct,
      with no implicit resurrection.
- [x] The relationship to owner tokens, owner sessions, local collectors, and
      `/mcp` owner-bearer rejection is explicit.
- [x] A proof precondition is specified before any route flips `api_network` off
      `unsupported`, including the no-secret-leakage, no-row-before-capture,
      two-account, and revoke/delete-durability gates.
- [ ] Implementation: credential store, owner-session capture surface,
      connection-scoped injection, and synthetic no-leakage/lifecycle tests have
      landed; the live end-to-end proof and intent-branch flip remain deferred.
