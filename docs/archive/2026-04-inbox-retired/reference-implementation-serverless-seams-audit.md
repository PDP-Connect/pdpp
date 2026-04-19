# Reference Implementation Serverless Seams Audit

Date: 2026-04-16  
Status: Working memo  
Scope: current `reference-implementation/` substrate, with emphasis on serverless-hostile assumptions and missing persistence/state seams

## 1. Current seam map

### A. Already durable and process-independent

These parts are already persisted and are not fundamentally tied to a single process:

- `connectors` manifest registry in SQLite (`reference-implementation/server/db.js`)
- `grants` table in SQLite (`reference-implementation/server/db.js`)
- `tokens` table in SQLite (`reference-implementation/server/db.js`)
- `records`, `record_changes`, and `version_counter` in SQLite (`reference-implementation/server/db.js`)
- connector sync state in `connector_state` (`reference-implementation/server/db.js`)
- token introspection and grant enforcement driven from persisted rows (`reference-implementation/server/auth.js`, `reference-implementation/server/index.js`)
- owner/client query behavior and self-export driven from persisted state (`reference-implementation/server/index.js`, `reference-implementation/server/records.js`)

Implication:

- the AS/RS core is closer to “stateless app instances over durable storage” than it first appears
- most correctness risk is not in the core RS/query path, but in the auth/runtime seams around it

### B. Process-local state that still constrains multi-instance/serverless behavior

These are now the sharpest missing seams:

- scheduler-local `history`, `lastRunTime`, and `exhaustedGrants` in `reference-implementation/runtime/scheduler.js`
  - lost on restart
  - duplicated across instances
- runtime-local message queue, record batches, and `pendingInteraction` in `reference-implementation/runtime/index.js`
  - fine for a single bounded run
  - not durable across runtime restarts

Implication:

- the AS/RS core is no longer fundamentally sticky-session dependent for pending grant approval
- the remaining serverless-hostile seams are concentrated in runtime/orchestration behavior
- the experimental scheduler is still strongly single-process

### C. SQLite and local-disk coupling

Current coupling points:

- global `let db` singleton plus `createDatabase(path)` in `reference-implementation/server/db.js`
- default DB path is `:memory:` or local-file path via `PDPP_DB_PATH` / `DB_PATH` in `reference-implementation/server/index.js`
- blob data is stored inline in SQLite (`blobs.data`)
- `file-import.js` reads archives/files from local disk
- demos/tests read manifests from repo-local disk

Important nuance:

- SQLite itself is not the main problem
- the issue is that the current code assumes a local SQLite file or in-memory DB, not an explicit durable backing-store contract

Implication:

- SQL-first is still the right direction
- local-file and `:memory:` defaults are fine for local dev/tests
- the reference needs one narrow connection/storage seam so production deployments are not forced into host-local disk semantics

### D. Runtime/orchestration assumptions that are worker-shaped, not serverless-shaped

The connector runtime is explicitly process-oriented:

- `spawn(process.execPath, [connectorPath])` in `reference-implementation/runtime/index.js`
- default interaction path reads from runtime stdin/stderr
- scheduler uses `setInterval` and in-process retry/backoff
- webhook adapter opens a raw Node `http` server on a local port

Implication:

- this is not a good fit for typical request-driven serverless execution
- that is acceptable if the runtime/orchestrator is treated as a separate worker tier
- it becomes a problem only if the project implicitly assumes the whole system must be serverless, including connector execution

### E. Host-local and local-topology assumptions

These assumptions are pervasive in demos/tests and some server defaults:

- `localhost` default URLs across server, runtime, adapters, and demo client
- AS and RS default to separate local ports (`7662`, `7663`)
- `verification_uri` derived from `req.protocol + req.get('host')` unless `AS_PUBLIC_URL` is set
- tests allocate ephemeral local ports and start real local servers
- the demo client assumes it can start the server in-process and talk to it over localhost

Important nuance:

- there is no active current dependency on Docker Compose in the live `reference-implementation/` stack
- but the code still assumes same-host reachability and simple local topology

### F. Token/session storage seams

What is already good:

- owner and client tokens are persisted in SQLite
- introspection is DB-backed, not in-memory
- revocation is persisted and checked on read

What is not yet clean:

- tests and demo helpers can still mint owner tokens through non-portable bootstrap code paths even though the public owner device flow is now primary
- local SQLite defaults still make it easy to run the AS/RS in a non-durable configuration if deployers do not override them explicitly
- the old compat `/grants/initiate` and `/consent/:deviceCode/*` wrappers are gone, so the durable `request_uri` flow is now the only pending-grant entry/approval seam

### G. State-handling seams

Current state model:

- record/change history is durable and good
- connector sync state is durable and now has a grant-scoped sibling table
- the runtime calls `GET/PUT /v1/state/{connectorId}` with optional `grant_id`, which is the right minimal cut

Implication:

- this seam is materially healthier than before
- the remaining risk is mostly clarity: keeping long-lived collection behavior explicitly grant-scoped rather than letting connector-only thinking creep back in

## 2. Risks ordered by severity

### Critical

#### 1. Naive serverless deployment with current DB defaults risks total data loss

Why it matters:

- the current app defaults to `:memory:` or local file path
- serverless/local-ephemeral filesystems make that non-durable
- grants, tokens, records, and sync state would disappear on cold start/redeploy unless the deployer overrides config correctly

This is less about SQLite as a technology and more about unsafe default persistence semantics.

### High

#### 2. Runtime/scheduler state is single-process and would duplicate or lose work across instances

Why it matters:

- `scheduler.js` tracks exhausted single-use grants, run history, and retry state in memory
- multiple scheduler instances would not coordinate
- restarts lose run history and local exhaustion bookkeeping

This is acceptable for an experiment, but not for a production-credible orchestrator/control plane.

#### 3. Connector execution model is not request-driven/serverless friendly

Why it matters:

- the runtime depends on child processes, long-running pipes, batching, and interactive stdin
- many serverless platforms disallow or strongly constrain that model

This is only a risk if the architecture keeps pretending the runtime belongs in the same deployment class as AS/RS. It should instead be treated as a worker tier.

#### 4. Public URL derivation is brittle behind proxies and split deployments

Why it matters:

- the AS builds `verification_uri` from request host unless `AS_PUBLIC_URL` is set
- the stack assumes AS and RS local port reachability
- this is fragile under CDN/proxy/serverless edge fronting

This is not a deep architectural flaw, but it will create confusing breakage early.

### Medium

#### 5. The DB layer is globally singleton-scoped and adapter-poor

Why it matters:

- `let db` in `reference-implementation/server/db.js` makes the storage binding implicit and process-global
- switching from local SQLite to remote/libSQL/Turso-class backends later is possible, but not yet explicit

This is not a reason to build a giant repository abstraction. It is a reason to introduce a minimal connection seam.

#### 6. Connector state is durable but still easy to misread

Why it matters:

- `connector_state` and `grant_connector_state` are both durable, which is good
- but the route shape still centers `connector_id`, which makes it easy to forget the grant-scoped model now exists
- this can reintroduce hidden coupling between collection policy, deployment, and correctness if the seam is not kept explicit

#### 7. Blobs are persisted inline in SQLite without a future store seam

Why it matters:

- for a pure reference this is fine at small scale
- for real production use, large blobs often belong in object storage

This is not urgent unless the reference starts proving non-trivial blob flows.

### Low

#### 8. File-import and demo surfaces assume host-local files and repo layout

Why it matters:

- `file-import.js` and `client/demo.js` read local files and manifests directly
- useful for dev/reference work, but not transportable deployment assumptions

These are acceptable as reference-world tooling if kept clearly non-core.

#### 9. Tests overstate local-host topology as the normative deployment

Why it matters:

- tests start local AS/RS pairs on localhost ports
- this is fine for CI, but it can subtly influence implementation choices if left unquestioned

This is manageable with clearer seam discipline in code and docs.

## 3. Minimal refactor recommendations

The goal here is not to add a generic “storage abstraction layer.” The goal is to cut only the seams that matter.

### 1. Keep pending consent durable and request-URI-based

The reference now persists pending grant requests behind SQLite-backed helpers.

The next requirement is not a new store seam. It is to keep future auth/profile work on top of that durable `request_uri` path instead of reintroducing in-process consent state or device-code-only coupling.

### 2. Replace implicit global DB binding with explicit initialization, not a repository layer

Keep SQL and tables as the source of truth, but make the storage binding more explicit:

- one initialization path that receives a DB adapter/connection factory
- keep current SQL modules and schema largely intact
- do not introduce a generic ORM or domain repository system

This preserves purity while making future remote-SQLite/libSQL deployment realistic.

### 3. Treat AS/RS and runtime as separate deployment classes

Do not try to make the connector runtime itself serverless-friendly.

Instead:

- keep AS/RS on the path to stateless/serverless deployment
- treat `reference-implementation/runtime` and scheduler/webhook/import as worker/orchestrator processes
- keep the contract between them explicit and network-based

This is the highest-leverage architectural clarification in the whole audit.

### 4. Keep grant-scoped state explicit and durable

The current state endpoint now supports grant-scoped state.

The next requirement is to keep that seam visible in the contract and in deployment thinking:

- do not regress back to connector-only keys for long-lived runs
- keep SQLite first
- keep the current `get/put` semantics, just preserve the sharpened key

### 5. Make public base URLs explicit config, not inferred truth

Prefer explicit config such as:

- `AS_PUBLIC_URL`
- `RS_PUBLIC_URL`

and use request-host inference only as a development fallback.

This is a small change that removes a surprising amount of deployment fragility.

### 6. Keep scheduler durability optional and narrow

Do not build a full orchestration platform yet.

If the scheduler stays active:

- add one narrow store seam for run lease/history only if needed
- otherwise keep it clearly experimental and non-normative

The important thing is not to let in-memory scheduler state silently masquerade as production behavior.

### 7. Keep demo/admin shortcuts, but quarantine them

Owner-token bootstrap helpers and similar shortcuts can stay temporarily for tests and demos, but:

- label them explicitly as demo/admin
- do not let CLI or control-plane design depend on them as the final contract

## 4. What can stay SQLite-first

SQLite-first is still a good default for much of this system. The key is to keep it intentional and explicit.

### Safe to keep SQLite-first now

- grants
- tokens
- connector manifests
- records
- record change history
- version counters
- connector/global sync state
- grant-scoped sync state
- pending consent and owner device authorization state

Why:

- these are relational, transactional, and relatively bounded
- the current implementation already uses SQL directly and well
- SQLite keeps the reference understandable and forkable

### Probably fine to keep SQLite-first for a while

- small blob fixtures
- local run metadata if a control plane needs minimal persistence

Condition:

- only if blob sizes and write volume stay modest
- once the reference proves real blob-heavy flows, add an explicit blob-store seam

### Should not be forced into SQLite just because it is convenient

- long-running scheduler coordination
- distributed run leases
- browser session artifacts for automation
- local archive/import source files

Those are not “bad because not SQLite.” They are just different concerns and should not be collapsed into the AS/RS database without a clear reason.

## Bottom line

The current `reference-implementation/` substrate is not broadly hostile to serverless deployment. The AS/RS core is actually quite close to a good stateless-app-over-durable-storage model.

The sharp problems are narrower:

- one unsafe default persistence story (`:memory:` / local-file SQLite as the implicit default)
- one worker-style runtime/orchestration layer that should stay separate rather than be forced into serverless
- one remaining clarity challenge around keeping grant-scoped runtime state explicit in the public/reference model

If those seams are handled cleanly, the reference can remain SQLite-first, pure, and understandable without baking in Docker- or host-local requirements as the normative model.
