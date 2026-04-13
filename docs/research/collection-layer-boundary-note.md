# Collection Layer Boundary: Design Note

**Date:** 2026-04-08
**Status:** Internal steering document (not normative, not a spec proposal)
**Inputs:** pdpp-status-map.md, collection-profile-prior-art-memo.md, collection-prior-art-deep-dive.md, spec-core.md, spec-collection-profile.md, mock-server.ts

---

## Executive summary

The PDPP collection layer has a clean boundary today: spec-core.md defines shared semantics (RECORD envelope, stream semantics, semantic classes, tombstones, scope enforcement), spec-collection-profile.md defines a single bounded-run fulfillment mechanism, and the reference orchestrator implements runtime concerns (scheduling, retry, credential management) that do not require spec treatment. This note draws that boundary explicitly so that future work -- whether adding new collection modes, growing the reference orchestrator, or building conformance tests -- knows what needs a spec and what does not. The prior art research concluded "keep bounded-run, add thin sibling profiles when demand materializes." This note accepts that conclusion and focuses on where exactly the lines are.

---

## Shared collection semantics

These concepts are defined in spec-core.md but are architecturally cross-cutting. Any future collection profile MUST reuse them without redefinition. They are the stable substrate.

| Concept | Where defined | What it guarantees |
|---------|--------------|-------------------|
| RECORD envelope (`stream`, `key`, `data`, `emitted_at`, `op`) | Core Section 4 | Universal data shape. Every ingestion path produces these. |
| Stream semantics (`append_only`, `mutable_state`) | Core Section 4 | Determines RS version-history obligations and incremental sync behavior. |
| Tombstone format (`object: "record"`, `deleted: true`) | Core Section 4 | Same envelope for deletions regardless of how the deletion was signaled. |
| Scope enforcement (stream membership, `time_range`, `fields`, `resources`) | Core Sections 5-6, 8 | Grant constraints apply identically no matter how data entered the RS. |
| Semantic classes (protocol-enforced, structured policy, attributed claims) | Core Section 5 | Consent surface rendering obligations are collection-method-agnostic. |
| Purpose code registry | Core Appendix A | Same purpose taxonomy regardless of collection mode. |
| State/checkpoint model (opaque cursor per stream) | Core Section 8 (`/v1/state`), Collection Profile Section 3 | Cursor semantics are shared; the Collection Profile adds lifecycle rules (persist only on success). |
| Ingest endpoint (`POST /v1/ingest/{stream}`) | Core Section 8 | NDJSON RECORD ingestion. Any collection mode that writes to the RS uses this. |

The status map identified these as "shared semantics housed in Core." That classification is correct and should not change. A future extraction into a standalone shared-definitions document is possible but not necessary for v0.1.

---

## Current Run Profile invariants

The Collection Profile (spec-collection-profile.md) defines a bounded-run fulfillment mechanism. The following invariants are load-bearing and cannot be relaxed without breaking the profile's audit and consent properties.

**Lifecycle:** Every run transitions through `initializing -> collecting -> succeeded/failed/cancelled`. The START message is exactly-once. The DONE message is terminal. This bounded lifecycle is what makes collection runs auditable -- each run is a discrete consent-scoped event with a clear beginning, end, and outcome.

**State gating on DONE:** The runtime MUST NOT persist STATE checkpoints from a failed or cancelled run. This prevents partial collection from advancing cursors, which would silently skip data on retry. This rule is a direct consequence of the bounded-run model.

**Binding matching:** Before spawning a connector, the runtime checks manifest-declared requirements against its own capabilities. This is a pre-flight safety check that prevents wasted work and unclear failures. It follows the Kubernetes scheduler pattern.

**Scope enforcement (connector-side):** Connectors MUST NOT emit records outside the scope provided in START. This is belt-and-suspenders with RS-side enforcement -- the connector is the first enforcement point, the RS ingest path is the second.

**INTERACTION protocol:** The connector can request human input (credentials, OTP, manual browser action) by emitting INTERACTION and blocking until INTERACTION_RESPONSE arrives. Only one INTERACTION may be pending at a time. This protocol has no analog in any of the 12 prior-art systems examined; it exists because PDPP collects from platforms the user does not control, often via browser automation.

**SKIP_RESULT:** Explicit signaling when a stream or resource is intentionally skipped (rate limit, scope not supported). This prevents silent data loss from being mistaken for successful collection.

**Process boundary:** The connector runs as a child process communicating via stdin/stdout JSONL. This provides process isolation, language-agnostic connector authoring, and a clean termination model.

---

## What is outside the current profile

The following collection modes are explicitly outside the bounded-run Collection Profile. For each, the reason it does not fit is stated.

**Manual file upload / data archive import.** A user has a platform export ZIP (Instagram data download, Google Takeout archive). There is no connector process to spawn, no START/DONE lifecycle, no INTERACTION. The data is already collected; it needs validation, schema mapping, and ingestion. The bounded-run model adds ceremony without value here.

**Regulatory data export (GDPR Article 20, DMA).** Similar to manual import but the data arrives via a platform-provided export mechanism. The user downloads it from the platform and uploads it to their personal server. No connector run is needed.

**Push / webhook delivery.** A cooperating platform sends records to the personal server via HTTP callbacks. There is no bounded run -- events arrive continuously. There is no START or DONE. The lifecycle is subscribe/receive/unsubscribe, not spawn/collect/terminate. The trust model is partially different: the platform is cooperating (it chose to send data), but endpoint authentication and replay protection become concerns.

**Platform event stream (persistent subscription).** A platform offers a real-time event stream (WebSocket, SSE, gRPC stream). This is a long-lived connection, not a bounded run. State management is continuous, not checkpoint-on-DONE. No current PDPP target platform offers this.

**Persistent agent collection.** If connectors evolve into long-running agents that maintain persistent sessions with source platforms, the bounded-run lifecycle breaks down. The agent model requires a different state management approach, different failure semantics, and different resource management. This is a fundamental architecture question, not a profile question.

**Scheduled recurring pull (as a spec concern).** Scheduling -- "run the Spotify connector every 6 hours" -- is an orchestrator concern. The Collection Profile defines one run. How often to run, when to retry, how to coordinate multiple connectors -- these are runtime decisions that do not affect wire-level interoperability.

---

## Collection mode classification

| Collection mode | Fits current profile? | Why / why not | Future profile needed? |
|----------------|----------------------|---------------|----------------------|
| Platform API pull | Yes | This is the primary use case. Connector calls platform API, emits RECORDs, follows START/DONE lifecycle. | No |
| Browser automation pull | Yes | The `browser_automation` binding exists for this. INTERACTION handles credentials/OTP/CAPTCHA. | No |
| Webhook/callback push | No | No bounded run. Events arrive continuously. No START/DONE. Need endpoint auth, replay protection. | Yes -- Push Delivery Profile |
| Platform event stream | No | Long-lived connection, not a bounded process. Continuous state management. | Possibly -- depends on whether platforms offer these. Likely a variant of push. |
| Data archive import | No | No connector process. Data is already collected. Needs validation and schema mapping, not a run lifecycle. | Yes -- Batch Import Profile |
| Manual file upload | No | Same as archive import. User provides a file; the system validates and ingests it. | Same as above (Batch Import Profile covers this) |
| Scheduled recurring pull | Yes (each run) | Each individual run fits the profile perfectly. Scheduling is an orchestrator concern. | No -- orchestrator handles scheduling |
| Real-time CDC-style | No | Requires persistent connection to source DB's WAL. Long-running, not bounded. PDPP does not have access to source DBs. | Unlikely to be relevant -- PDPP collects from platforms, not databases the user controls |

---

## Criteria for a future Push/Subscription Profile

A Push Delivery Profile should be specified only when ALL of the following signals are present:

1. **A cooperating platform offers webhooks or event streams.** At least one real platform that PDPP targets must actually provide a push mechanism. Speculative profiles without a concrete implementation target are waste.

2. **Multiple implementers need interoperability for push delivery.** If only one personal server implementation receives webhooks from one platform, a profile is not needed -- the implementer can solve it locally. The profile becomes necessary when independently-built personal servers need to receive push events from independently-built webhook senders using a common contract.

3. **The bounded-run model cannot adapt push-to-pull without unacceptable latency.** Kafka Connect and Airbyte both handle push sources by writing to an intermediate store and pulling from it. If PDPP can do the same (webhook receiver writes to RS, then a standard collection run reconciles), a Push Profile adds no value. The profile is needed only when the push-to-pull adaptation introduces latency or complexity that users will not accept.

Until all three signals are present, push delivery is an orchestrator/runtime concern, not a spec concern.

---

## Orchestrator vs profile: clean layer split

The test for whether something needs spec treatment: **does it affect wire-level interoperability between independently-built implementations?**

- If yes: it needs a profile or spec amendment.
- If no: it is an orchestrator/runtime concern and can grow freely in the reference implementation.

### What the orchestrator can grow to support (no spec needed)

| Capability | Why it is runtime-only |
|-----------|----------------------|
| **Scheduling** (run Spotify every 6h, run GitHub on grant fulfillment) | Does not change the START/RECORD/STATE/DONE wire format. Two independently-built runtimes scheduling differently still produce the same connector runs. |
| **Retry with backoff** (re-run failed connectors with exponential backoff) | A failed run is a failed run per the profile. How the runtime decides to retry is local policy. |
| **Multi-connector coordination** (run Instagram, then Spotify, then GitHub in sequence or parallel) | Ordering and parallelism are orchestration concerns. Each individual run follows the profile. |
| **Credential management** (store platform credentials, rotate tokens, manage OAuth refresh) | The profile defines INTERACTION for credential input. How the runtime stores and manages credentials between runs is implementation detail. |
| **Run queuing and prioritization** (grant-driven runs take priority over proactive archival) | Priority is local policy. The connector sees the same START message either way. |
| **Health monitoring** (track connector success rates, alert on repeated failures) | Operational concern. Does not affect the wire protocol. |
| **Intermediate buffering** (receive webhook into a staging table, then run a connector to reconcile) | This is the push-to-pull adaptation pattern from Kafka Connect. It uses the existing profile for the pull leg. The webhook receiver is runtime code, not a profile. |
| **Browser lifecycle management** (launch/reuse/recycle browser instances for CDP connectors) | The profile says the runtime provides a `browser_automation` binding with a CDP WebSocket URL. How the runtime manages the underlying browser is implementation detail. |
| **Proactive archival scheduling** (maintain global state by running connectors periodically without a grant trigger) | The profile already supports this via `state: null` for proactive runs. When and why to trigger proactive runs is orchestrator policy. |

### What needs spec treatment (wire-level interoperability)

| Concern | Why it needs a spec |
|---------|-------------------|
| **Push delivery endpoint contract** | If a platform sends webhooks to the personal server, the endpoint URL, authentication mechanism, payload format, and replay protection must be standardized for independently-built senders and receivers to interoperate. |
| **Batch import validation contract** | If a data archive format is standardized (schema mapping rules, validation requirements, error reporting), independently-built import tools and personal servers need a shared contract. |
| **New message types in the JSONL protocol** | Any new message type that a connector emits or a runtime sends must be in the profile so all implementations agree on semantics. |
| **New binding types** | Adding a binding to the standard registry (beyond the current six) affects manifest authoring and runtime capability advertisement. |

---

## What the reference mock server implements vs. what the spec requires

The mock server (`apps/web/src/lib/mock-server.ts`) implements Core RS query-side semantics:

- Grant issuance, revocation, status checking
- Field projection on every query
- Incremental sync via `changes_since` with cursor management
- Self-export (owner token path, no projection)
- Stream membership enforcement

It does NOT implement:

- The Collection Profile run protocol (no START/RECORD/STATE/DONE)
- Ingest endpoint (`POST /v1/ingest/{stream}`)
- Sync state management (`GET/PUT /v1/state/{connector_id}`)
- Binding matching
- INTERACTION protocol
- Time-range filtering
- `resources` filtering
- Tombstone generation
- Blob access
- Expansion (`expand[]`)
- Token introspection

The e2e implementation (`e2e/`) covers the Collection Profile runtime (START/RECORD/STATE/DONE), ingest, and sync state. Between the two reference implementations, the Collection Profile wire protocol is demonstrated but not the orchestrator capabilities listed above.

---

## Recommended next implementation experiments

Build these in the reference implementation to learn, without committing to spec. Each experiment has a specific learning goal.

1. **Proactive archival scheduler.** Build a simple cron-style scheduler in the e2e runtime that runs connectors periodically using global state. Learning goal: understand the scheduling/state interaction patterns that will inform whether any scheduling semantics need spec treatment. Hypothesis: they do not.

2. **Webhook-to-pull adapter.** Build a simple HTTP endpoint in the e2e server that receives a webhook payload, validates it, writes RECORDs to the ingest endpoint, and optionally triggers a reconciliation collection run. Learning goal: determine whether the push-to-pull adaptation is sufficient or whether a separate Push Profile is needed. Hypothesis: it is sufficient for v0.1 targets.

3. **File import CLI tool.** Build a CLI that reads a platform export ZIP (start with Instagram data download format), maps it to PDPP streams, validates against a manifest, and ingests via `POST /v1/ingest/{stream}`. Learning goal: understand the validation and schema-mapping requirements that would inform a Batch Import Profile. Hypothesis: the shared RECORD format and ingest endpoint are sufficient; the import tool is runtime code.

4. **Multi-connector orchestration.** Build a simple orchestrator that coordinates multiple connector runs (e.g., "refresh all stale connectors for this user") with basic retry. Learning goal: confirm that orchestration is purely a runtime concern. Hypothesis: confirmed.

---

## Recommended "not yet" list

Explicitly defer. Do not spec, do not build in the reference, do not allocate design time.

| Item | Why defer |
|------|----------|
| Push Delivery Profile | No current PDPP target platform offers webhooks for personal data export. Specifying without an implementation target produces bad specs. |
| Batch Import Profile | Useful but lower priority than completing the bounded-run Collection Profile's conformance test suite. Build the file-import experiment first. |
| Persistent agent collection model | Fundamental architecture question. The bounded-run model is working. Revisit only if a concrete use case demands persistent agents. |
| Connector SDK / multi-profile support | SDK design follows protocol design, not the reverse. The protocol needs to be stable before investing in SDK ergonomics. |
| Shared semantics extraction | The status map correctly identifies shared semantics as housed in Core. Extracting them into a separate document is an editorial task, not a design task. Do it when a second profile is actually being written, not before. |
| Real-time CDC-style streaming | PDPP collects from platforms the user does not control. CDC requires WAL access, which requires database control. Not relevant. |
| Canonical view naming vocabulary | Deferred per spec-core.md Section 11. Wait for implementation experience. |

---

## Final recommendation

The collection layer boundary is already in the right place. The current split is:

- **Spec-core.md** owns the shared semantics (RECORD, streams, scope, tombstones, semantic classes, ingest endpoint, state endpoint).
- **Spec-collection-profile.md** owns the bounded-run fulfillment mechanism (START/RECORD/STATE/DONE, bindings, INTERACTION, connector conformance, runtime conformance).
- **The reference orchestrator** owns everything else (scheduling, retry, credential management, multi-connector coordination, push-to-pull adaptation).

Do not dissolve the Collection Profile into a generalized platform. Do not spec the orchestrator. Do not draft a Push Profile until the three criteria above are met.

The most productive next steps are:

1. Build the implementation experiments (especially webhook-to-pull and file import) to validate that the current boundary holds under real workloads.
2. Write the conformance test suite for the existing Collection Profile. This is higher priority than any new profile.
3. Keep the "not yet" list honest. When someone proposes a new collection mode, check it against the classification table above. If it fits the current profile, use the current profile. If it does not, check whether the three criteria for a new profile are met before specifying one.
