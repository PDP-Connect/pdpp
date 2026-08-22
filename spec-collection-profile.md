# PDPP Collection Profile v0.1.0

Status: Companion profile draft
Date: 2026-08-17

Companion to the Personal Data Portability Protocol (PDPP) core spec.

---

## Overview

The Collection Profile defines how connectors collect data from source platforms and write it to a PDPP resource server. It is one fulfillment mechanism for the PDPP core protocol; pre-collected data, manual imports, and other ingestion mechanisms are equally valid.

The Collection Profile is architecturally separate from the core protocol. A resource server serving pre-collected data needs no awareness of this profile. A connector runtime implementing this profile needs no awareness of grant semantics beyond what is explicitly passed to it in the START message.

### Collection method abstraction

Connectors abstract over the source platform's data access interface. The runtime does not standardize the connector's source-specific collection logic; it standardizes only the runtime contract around bindings, scope, state, and emitted messages. A connector that collects data via browser automation and one that calls a platform's export API both use the same START/RECORD/STATE/DONE protocol, the same binding matching, and the same state management.

This abstraction is intentional. Many platforms do not currently offer structured data portability APIs. The `browser_automation` binding enables connectors that drive a browser to collect data from a platform's web UI. As platforms adopt data portability standards or offer their own APIs, connector implementations can change without changing the consent surface, grant enforcement, or query API.

### Requirements Language

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this profile are to be interpreted as described in the core spec's [Requirements Language](spec-core.md#requirements-language) (BCP 14 [RFC 2119] [RFC 8174]) when, and only when, they appear in all capitals.

---

## 1. Connector Manifest Extensions

The core manifest (Section 7 of the core spec) defines the consent surface. The Collection Profile adds execution-specific fields.

```json
{
  "protocol_version": "0.1.0",
  "connector_id": "https://registry.pdpp.dev/connectors/spotify",
  "version": "2.0.0",
  "display_name": "Spotify",
  "runtime_requirements": {
    "bindings": {
      "network": { "required": true },
      "interactive": { "required": true }
    }
  },
  "capabilities": {
    "human_interaction": ["credentials", "otp"]
  },
  "streams": [
    {
      "name": "top_artists",
      "incremental": true
    }
  ]
}
```

### Collection-specific manifest fields

| Field | Description |
|-------|-------------|
| `runtime_requirements.bindings` | Declared bindings the connector requires from the runtime. Keys are binding names; values are objects with `required: boolean` and optional binding-specific fields. Standard bindings are listed below. Extension bindings use namespaced identifiers (e.g., `nvidia.com/gpu`). Unqualified binding names are reserved for the spec-defined registry. |
| `capabilities.human_interaction` | Interaction kinds this connector may request: `credentials`, `otp`, `manual_action`. |
| `streams[].incremental` | Whether this stream supports cursor-based incremental sync. |
| `streams[].state_stream` | Optional. Names exactly one other declared stream whose committed checkpoint governs this stream. Requires `streams[].coverage_strategy: "checkpoint_window"` on the same stream. See [Checkpoint dependency](#checkpoint-dependency) below. |
| `streams[].parent_streams` | Optional. Names one or more other declared streams whose checkpoints this stream's detail evidence can independently satisfy. Requires `streams[].coverage_strategy: "parent_detail_accounting"` on the same stream. See [Checkpoint dependency](#checkpoint-dependency) below. |
| `streams[].coverage_strategy` | Optional. Declares how a stream's coverage is accounted. This profile constrains only the two values that interact with checkpoint dependency, `checkpoint_window` and `parent_detail_accounting`; other values a runtime may define are outside this profile's normative scope. |

A stream declaration MUST NOT set both `state_stream` and `parent_streams`. A stream with neither field is its own checkpoint parent (self-mapped): its own `STATE` messages govern its own commit eligibility, exactly as in a manifest that predates this section.

### Checkpoint dependency

Some streams do not carry their own cursor. A stream that rides another stream's checkpoint (for example, a reactions or attachment-metadata stream co-emitted alongside the messages that reference it) declares that relationship in the manifest so the runtime can compute which staged `STATE` commits are safe to persist when a run ends in a certified stream-scoped failure (see [DONE](#done)) or reports incomplete detail coverage (see [DETAIL_COVERAGE](#detail_coverage)).

There are two declaration shapes, and a stream MUST use at most one. Each shape REQUIRES a specific `coverage_strategy` value on the same stream; a runtime MUST reject a manifest declaring `state_stream` or `parent_streams` with any other (or absent) `coverage_strategy` value on that stream (see [Validation](#validation) rule 7 below):

- **`state_stream` (single parent).** `streams[].state_stream` is a string naming exactly one other declared stream, and REQUIRES `coverage_strategy: "checkpoint_window"` on the declaring stream. It declares a static one-to-one mapping: this stream is always covered by that one parent's checkpoint, and the connector never emits `DETAIL_COVERAGE` for it — the runtime projects its checkpoint status from the parent's commit outcome directly, with no run-time override. A runtime MUST reject any `DETAIL_COVERAGE` message naming a `state_stream`-declared stream as its `stream` field, as a protocol violation (fail closed), regardless of what `state_stream` value that message reports. Use this shape for a stream that has no independent hydration lane of its own.
- **`parent_streams` (one or many parents).** `streams[].parent_streams` is a non-empty array naming one or more other declared streams, and REQUIRES `coverage_strategy: "parent_detail_accounting"` on the declaring stream. It declares that this stream runs its own list+detail hydration lane and emits one `DETAIL_COVERAGE` message per parent boundary per run (see [DETAIL_COVERAGE](#detail_coverage)); each declared parent's checkpoint is gated independently by its own coverage report and gap accounting, and a runtime MUST reject any `DETAIL_COVERAGE` message whose `state_stream` value is not a member of this declared set, as a protocol violation (see [Precedence between manifest and run-time evidence](#precedence-between-manifest-and-run-time-evidence)). Use this shape for a detail stream that can be fed by more than one independently checkpointed list stream in the same run, or that proves its own coverage rather than inheriting a parent's outcome unconditionally.

#### Validation

A conformant runtime MUST validate every stream's checkpoint-dependency declaration before spawning the connector, and MUST reject the manifest (fail closed, run not started) if any of the following holds:

1. **Self-reference.** `state_stream` equals the declaring stream's own `name`, or `parent_streams` contains the declaring stream's own `name`.
2. **Unknown stream.** `state_stream`, or any entry of `parent_streams`, names a stream not present in `manifest.streams`.
3. **Duplicate parent.** `parent_streams` contains the same stream name more than once.
4. **Both fields present.** A stream declares both `state_stream` and `parent_streams`. A runtime MUST enforce this directly (as its own explicit check) rather than relying solely on `state_stream` and `parent_streams` being gated to mutually exclusive `coverage_strategy` values as an incidental side effect — the two fields being individually valid only under different `coverage_strategy` values does not excuse a runtime from also rejecting a manifest that sets both.
5. **Empty `parent_streams`.** `parent_streams` is present but has zero entries. (Omit the field entirely for a self-mapped stream.)
6. **Cycle.** Following `state_stream`/`parent_streams` edges from any stream, by any path, returns to that same stream. A cycle makes the dependency graph unresolvable to a topological commit order and MUST be rejected at manifest validation, not discovered at run time. This holds even for a runtime that resolves only direct, one-level parent declarations: two or more direct edges can still form a cycle (for example `A.state_stream = B` and `B.state_stream = A`, or a longer chain through direct edges only), so a runtime MUST implement genuine cycle detection over the declared dependency graph — see non-normative notes below.
7. **`coverage_strategy` mismatch.** A stream declares `state_stream` without `coverage_strategy: "checkpoint_window"` on that stream, or declares `parent_streams` without `coverage_strategy: "parent_detail_accounting"` on that stream.

A manifest that passes this validation MUST have every stream's checkpoint-dependency edges forming a directed acyclic graph, terminating in one or more streams that are self-mapped (own checkpoint parent).

**Non-normative notes:**

- These are direct, single-level declarations — a stream names its parent(s) directly, not through a transitive chain it expects the runtime to resolve. A runtime MAY additionally reject a manifest whose declared edges are more than one level deep (e.g., stream C names parent B, and B itself names parent A) if its implementation does not resolve transitive chains; the reference implementation validates exactly one level and does not resolve chains beyond it.
- Rule 6 (cycle rejection) is a genuine, implemented check, not a consequence that falls out of rules 1–5 for free. A prior draft of this section claimed a one-level-only resolver made cycle rejection "vacuously true" through rules 1–5 alone; that claim was false — two or more direct edges can still form a cycle (`A.state_stream = B` and `B.state_stream = A`, or a longer chain through direct edges only) that no single-stream rule can see, since rules 1–5 each inspect one stream's own declared edges in isolation. The reference implementation performs real cycle detection (a depth-first search with a visiting/visited coloring) over the complete declared dependency graph — every `state_stream` and `parent_streams` edge across every stream — before spawning the connector, and has conformance tests proving rejection of a 2-cycle, a 3-cycle, and a mixed `state_stream`/`parent_streams` cycle, alongside a non-regression case proving two streams legitimately sharing one parent is not a false-positive cycle. This detection is provider-neutral: it operates purely on the manifest's declared graph, with no connector-specific logic.

### Standard bindings

| Binding | Descriptor | Meaning |
|---------|-----------|---------|
| `browser_automation` | `{ interface: "cdp", ws_url: string, headed_supported?: boolean }` | Runtime provides a CDP WebSocket to a managed browser. |
| `browser_profile` | `{ profile_path: string }` | Runtime provides a persistent browser profile directory. |
| `filesystem` | `{}` | Presence indicates local filesystem access. |
| `network` | `{}` | Presence indicates outbound network access. |
| `interactive` | `{}` | Presence indicates INTERACTION messages will be handled. |
| `loopback_listen` | `{}` | Presence indicates the connector may bind to local ports. |

---

## 2. Connector Run Protocol

Connectors communicate with the runtime via newline-delimited JSON (JSONL) over stdin/stdout. Each message is a single JSON object followed by a newline.

### Runtime binding matching

Before spawning a connector, the runtime checks the manifest's `runtime_requirements.bindings` against its own capabilities. If the runtime cannot satisfy a required binding, the run MUST fail with a clear error before the connector process is spawned. This follows the Kubernetes scheduler pattern: connectors declare requirements, runtimes advertise capabilities.

### Connector process state machine

The connector process transitions through the following states:

| State | Description |
|-------|-------------|
| `initializing` | Before START is received on stdin. |
| `collecting` | Emitting RECORD, STATE, SKIP_RESULT, PROGRESS messages. |
| `waiting_for_interaction` | Emitted INTERACTION; blocked waiting for INTERACTION_RESPONSE on stdin. |
| `succeeded` | Emitted DONE with `status: "succeeded"`. Terminal. |
| `failed` | Emitted DONE with `status: "failed"`, or exited with non-zero status. Terminal. |

**State transition table:**

| Current State | Event | Action | Next State |
|--------------|-------|--------|-----------|
| `initializing` | START received | Initialize collection | `collecting` |
| `collecting` | Emit INTERACTION | Write to stdout; block on stdin | `waiting_for_interaction` |
| `collecting` | Emit DONE (succeeded) | Write to stdout; exit 0 | `succeeded` |
| `collecting` | Emit DONE (failed) | Write to stdout; exit non-zero | `failed` |
| `collecting` | Fatal error | Write to stderr; exit non-zero | `failed` |
| `collecting` | INTERACTION_RESPONSE received | Protocol violation (see below) | `failed` |
| `waiting_for_interaction` | INTERACTION_RESPONSE received | Unblock; process response | `collecting` |
| `waiting_for_interaction` | Emit INTERACTION | Protocol violation (see below) | `failed` |
| `waiting_for_interaction` | Fatal error | Write to stderr; exit non-zero | `failed` |
| Any | Runtime terminates process | (external) | `failed` |

**Protocol violations:**

- A connector MUST NOT emit INTERACTION while already in `waiting_for_interaction`. A runtime that receives a second INTERACTION in this state MUST terminate the connector process and mark the run as failed. **Note (non-normative):** Runtimes that process connector messages sequentially via a single-threaded message queue may make this violation unrepresentable in practice, because the queue serializes INTERACTION processing. The protocol rule remains valid for correct connector behavior and for runtime architectures that dispatch messages concurrently.
- A connector that receives INTERACTION_RESPONSE while in `collecting` (no pending INTERACTION) SHOULD treat it as a fatal protocol error, write a diagnostic to stderr, and exit with non-zero status.
- START is exactly-once. It MUST be the first message sent by the runtime. A connector that receives START while in any state other than `initializing` MUST treat it as a fatal protocol error.

**Runtime behavior on failure:** The runtime MUST NOT persist STATE checkpoints from a run that terminates in the `failed` state, except for the certified stream-scoped failure described under [DONE](#done) or the restart-abandonment exception described under [Restart abandonment](#restart-abandonment). State is otherwise persisted only after a successful DONE.

SKIP_RESULT is a message emitted while in the `collecting` state. It does not cause a state transition.

---

## 3. Messages

### Runtime to Connector

#### START

Initializes a collection run.

```json
{
  "type": "START",
  "run_id": "run_abc123",
  "collection_mode": "incremental",
  "scope": {
    "streams": [
      {
        "name": "top_artists",
        "time_range": {
          "since": "2025-10-11T00:00:00Z"
        },
        "fields": [
          "id",
          "name",
          "genres",
          "popularity",
          "source_updated_at"
        ]
      }
    ]
  },
  "state": {
    "top_artists": { "last_updated": "2026-03-01T00:00:00Z" }
  },
  "bindings": {
    "browser_automation": {
      "interface": "cdp",
      "ws_url": "ws://127.0.0.1:39011/devtools/browser/abc"
    },
    "network": {}
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `run_id` | string | Unique identifier for this run. |
| `collection_mode` | enum | `full_refresh` or `incremental`. Derived from stream capabilities and runtime policy; not from the grant. |
| `scope` | object | Portable collection target for this run. Derived from a grant and local policy for grant-driven runs, or from user preferences and local policy for proactive runs. See `scope` fields below. |
| `state` | object or null | Map of stream names to cursor objects from previous STATE messages. For proactive runs this comes from the connector's global state namespace; for `continuous` grant runs it comes from the `grant_id`-scoped namespace; null on first run or `single_use` runs. |
| `bindings` | object | Map of binding names to descriptors for bindings provided to this run. |

The START message does not include the raw grant or access token. It carries a normalized `scope` object instead. `scope` is not itself a grant and has no authorization force; it is the collection target for this run. For grant-driven runs, the runtime MUST derive `scope` from the grant, MUST NOT construct a scope broader than the grant permits, and MAY narrow it further according to local fulfillment policy (for example, collecting only the stale streams needed to satisfy the current request). For proactive runs, the runtime derives `scope` from user preferences or local policy.

### `scope` fields

| Field | Type | Description |
|-------|------|-------------|
| `streams` | CollectionStream[] | Explicit stream targets for this run. MUST be non-empty. Wildcards are not allowed in `START`; the runtime resolves them before spawning the connector. |

### CollectionStream fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Stream name to collect. |
| `resources` | string[] | Optional canonical key strings limiting the run to specific records within the stream. Same encoding as `resources` in the core grant model. |
| `time_range` | object | Optional temporal collection window with `since` / `until`, using the same semantics as the core grant model. |
| `fields` | string[] | Optional top-level emitted-field set for this run. When present, the runtime MUST include any schema-required fields and any additional top-level fields required for valid RECORD emission or RS ingest validation for that stream. |

`START.scope` carries normalized collection targets only. It does not include issuance-time concepts such as `necessity` or unresolved `view` names; the runtime resolves those before spawning the connector.

Connector obligations for `scope`:

- A connector MUST NOT emit RECORD messages for streams absent from `scope.streams`.
- If `resources` or `time_range` is present for a stream, the connector MUST apply those constraints before emitting RECORD messages for that stream.
- If `fields` is present for a stream, the connector MUST NOT emit additional top-level fields in RECORD `data` for that stream, except that it MAY include schema-required or ingest-required top-level fields if the runtime omitted them accidentally.
- A connector that cannot honor a declared `resources`, `time_range`, or `fields` constraint for a stream MUST either emit `SKIP_RESULT` with `reason: "scope_not_supported"` and omit records for the skipped target, or fail the run. It MUST NOT silently broaden or ignore the constraint.
- A connector MAY retrieve broader source-side data transiently when the source platform cannot filter precisely, but it MUST still emit RECORD messages consistent with `scope`.

Connector compliance is not the only enforcement backstop. The runtime and downstream write path MUST reject or discard emissions that fall outside the declared `scope`.

**State management:** State is maintained at two levels:

- **Global state:** Used and advanced only by proactive runs (no grant). Represents archival completeness for the user's data store.
- **Grant-scoped state:** Used and advanced by `continuous` grant runs, keyed by `grant_id`. The runtime reads and writes this namespace through `GET/PUT /v1/state/{connector_id}?grant_id={grant_id}`. It ensures recurring app syncs are incremental without interfering with global archival cursors.
- **Single-use runs:** Receive `state: null`. STATE messages emitted during single-use runs are not persisted.

`bindings` contains a descriptor for every binding declared `required: true` in the manifest. For every required binding, the runtime MUST include a valid descriptor. Connectors MUST treat a missing required binding as a fatal protocol error. Connectors MUST ignore unknown binding keys.

#### INTERACTION_RESPONSE

Reply to an INTERACTION request.

```json
{
  "type": "INTERACTION_RESPONSE",
  "request_id": "req_001",
  "status": "success",
  "data": { "email": "user@example.com", "password": "..." }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `request_id` | string | Matches the `request_id` from the INTERACTION being answered. |
| `status` | enum | `success`, `cancelled`, or `timeout`. |
| `data` | object | Response data. Present only when `status` is `success`. |

On `timeout`, the runtime MUST send a response with `status: "timeout"` rather than leaving the connector blocked indefinitely.

---

### Connector to Runtime

#### RECORD

A single data record. Same envelope as the core spec (Section 4).

```json
{
  "type": "RECORD",
  "stream": "top_artists",
  "key": "4Z8W4fKeB5",
  "data": {
    "id": "4Z8W4fKeB5",
    "name": "Radiohead",
    "genres": ["alternative rock"],
    "popularity": 82,
    "source_updated_at": "2026-03-28T00:00:00Z"
  },
  "emitted_at": "2026-04-06T15:01:00Z"
}
```

The `op` field (`upsert` or `delete`) is a directive to the resource server and is not stored as part of the record data.

#### STATE

Checkpoint for incremental sync.

```json
{
  "type": "STATE",
  "stream": "top_artists",
  "cursor": { "last_updated": "2026-03-28T00:00:00Z" }
}
```

The runtime persists STATE only after preceding records are durably written to the resource server. Connectors SHOULD emit STATE periodically (e.g., every 1000 records) rather than only at the end of a stream.

`stream` names the checkpoint (`state_stream`), which can differ from the data stream(s) it covers. A stream is its own checkpoint unless the manifest declares `state_stream` or `parent_streams` for it (see [Checkpoint dependency](#checkpoint-dependency)). Every `STATE` message's `stream` MUST be a checkpoint stream: either a data stream with no declared parent (self-mapped), or a stream named as another stream's `state_stream`/`parent_streams` target. A checkpoint stream's commit eligibility depends on the coverage and failure evidence of every data stream mapped to it — see [Eligible-checkpoint algorithm](#eligible-checkpoint-algorithm).

The cursor object is opaque to the runtime and the resource server: its structure is defined by the connector and interpreted only by the connector on the next run.

#### INTERACTION

Request input from a user or agent. The connector blocks (does not emit further messages) until INTERACTION_RESPONSE arrives on stdin.

```json
{
  "type": "INTERACTION",
  "request_id": "req_001",
  "kind": "credentials",
  "message": "Log in to Spotify",
  "schema": {
    "type": "object",
    "properties": {
      "email": { "type": "string" },
      "password": { "type": "string", "format": "password" }
    },
    "required": ["email", "password"]
  },
  "timeout_seconds": 300
}
```

| Kind | When to use |
|------|------------|
| `credentials` | Username/password login form. |
| `otp` | Two-factor authentication or verification code. |
| `manual_action` | An action the user must take in a headed browser (login, CAPTCHA, confirmation). |

#### SKIP_RESULT

Signals that a stream or resource was intentionally skipped. Does not cause a state transition.

```json
{
  "type": "SKIP_RESULT",
  "stream": "playlists",
  "reason": "rate_limited",
  "message": "Skipped playlists: rate limit reached"
}
```

`SKIP_RESULT` MAY also be used when a connector cannot honor a declared scope element for a stream or resource. In that case the `reason` MUST be `scope_not_supported`.

`SKIP_RESULT` MAY carry an optional `recovery_hint`. See [Recovery hints](#recovery-hints) below for its shape and validation rules — the same rules apply here as for `DONE.error.recovery_hint`.

`SKIP_RESULT` MAY carry an optional typed `continuation` fact when a bounded
page completed and the runtime owns the next page. It MUST contain
`boundary`, `slice_start`, `slice_end`, `considered`, `covered`,
`remaining: true`, and `owner: "runtime"`. The counts bind the continuation to
the exact proven page; a runtime MUST NOT treat an ordinary retryable skip as a
healthy continuation merely because its separate coverage denominator is full.
The fact proves only that slice. It MUST NOT imply complete history.

#### DETAIL_COVERAGE

Reports how completely a connector hydrated per-record detail for one checkpoint-parent boundary in a list+detail collection lane (a lane that fetches a list of records and then fetches per-record detail for at least a subset of them). Does not cause a state transition.

```json
{
  "type": "DETAIL_COVERAGE",
  "reference_only": true,
  "stream": "message_attachments",
  "state_stream": "messages",
  "required_keys": ["msg_1", "msg_2", "msg_3"],
  "hydrated_keys": ["msg_1", "msg_2"],
  "gap_keys": ["msg_3"]
}
```

| Field | Type | Description |
|-------|------|--------------|
| `reference_only` | `true` | MUST be present and `true`. Marks this message as evidence about a run, not itself durable data. |
| `stream` | string | The detail stream this report covers. MUST be present in `scope.streams`. |
| `state_stream` | string | The checkpoint-parent stream this report's evidence gates. MUST be present in `scope.streams`. |
| `required_keys` | (string \| number)[] | The full set of record keys considered for detail under this parent boundary in this run. |
| `hydrated_keys` | (string \| number)[] | The subset of `required_keys` successfully fetched and emitted as `RECORD`. |
| `gap_keys` | (string \| number)[] | Optional. Keys for which a `DETAIL_GAP` was emitted this run. |

A connector with a list+detail lane MUST emit one `DETAIL_COVERAGE` message per distinct `state_stream` boundary after that boundary's detail work for the run settles, and MUST place it after the last `RECORD` or `DETAIL_GAP` it emits for that detail stream and boundary in the run. A connector exempt from a per-record detail fetch (flat streams only) is not required to emit `DETAIL_COVERAGE`.

**Non-normative note:** this ordering rule is a conformance obligation on the connector; the reference implementation does not currently enforce message sequence/ordering for `DETAIL_COVERAGE` at the runtime level (it accepts the message whenever it arrives and evaluates coverage as of terminal DONE). A runtime MAY choose to validate ordering explicitly; the eligible-checkpoint algorithm's correctness in the reference implementation does not depend on runtime-side ordering enforcement, only on the connector honestly reporting complete state by the time DONE is evaluated.

**Key-set validation.** Within one portable v0.1 `DETAIL_COVERAGE` message:

- `required_keys`, `hydrated_keys`, and `gap_keys` MUST each contain no duplicate key.
- Every key in `hydrated_keys` or `gap_keys` MUST also appear in `required_keys`.
- A key in `required_keys` that appears in neither outcome set is an unaccounted key: its parent boundary's coverage is incomplete (see [Eligible-checkpoint algorithm](#eligible-checkpoint-algorithm)).

**Multi-parent streams.** A detail stream declared with manifest `parent_streams` (see [Checkpoint dependency](#checkpoint-dependency)) MAY emit more than one `DETAIL_COVERAGE` message in the same run — one per parent boundary that settled. The runtime MUST evaluate and gate each declared parent's checkpoint independently from the others' coverage; it MUST NOT reject two `DETAIL_COVERAGE` messages solely because they share the same `stream` while their `state_stream` values differ. Every `state_stream` value reported MUST be a member of the stream's manifest-declared `parent_streams` set — a runtime MUST reject a `DETAIL_COVERAGE` naming a `state_stream` outside that set as a protocol violation (see [Precedence between manifest and run-time evidence](#precedence-between-manifest-and-run-time-evidence)).

**Reference-implementation extension: `optional_skip_keys`.** The reference implementation accepts an additional `optional_skip_keys` outcome set as a non-portable extension. It MUST NOT be used to claim portable v0.1 conformance: an independent v0.1 runtime may reject the extension or treat those keys as unaccounted, and the v0.1 checkpoint algorithm below does not credit it. A runtime and connector that explicitly opt into the reference extension MAY credit a key only when the connector has affirmative, provider-authored evidence of a terminal, record-specific absence. Operator or deployment configuration alone is never sufficient. An HTTP status code alone, response age alone, transport failure, retry exhaustion, or generic access denial MUST leave the key unaccounted and therefore retryable. A future profile revision MUST standardize the manifest declaration and value vocabulary before accepted absence becomes a portable checkpoint outcome.

#### DETAIL_GAP

Reports a durable, retryable per-record detail failure within a list+detail lane. Does not cause a state transition.

```json
{
  "type": "DETAIL_GAP",
  "stream": "message_attachments",
  "parent_stream": "messages",
  "record_key": "msg_3",
  "reason": "temporary_unavailable",
  "retryable": true,
  "detail_locator": { "message_id": "msg_3" }
}
```

| Field | Type | Description |
|-------|------|--------------|
| `stream` | string | The detail stream the failing record belongs to. MUST be present in `scope.streams`. |
| `parent_stream` | string | Optional. The checkpoint-parent boundary this gap is scoped to. MUST match a `DETAIL_COVERAGE.state_stream` value the connector reports for this `stream` in the same run when the detail stream has more than one declared parent (see below). |
| `record_key` | string \| number | Optional. The detail record's key within `stream`. |
| `reason` | string | Optional. Connector-defined failure reason. |
| `retryable` | boolean | Optional. Whether the connector considers this gap retryable. |
| `detail_locator` | object | Optional. Connector-opaque data sufficient to retry this detail fetch independently on a future run. MUST NOT contain secrets. |
| `list_cursor`, `last_error` | object | Optional connector-opaque diagnostic objects. |
| `gap_id`, `lease_id` | string | Optional. Identify a durable, runtime-served gap-recovery lease when the runtime's out-of-band gap-recovery mechanism is in use. Reference-implementation-specific; not required for profile conformance. |

**Parent scoping and key collision.** A `DETAIL_GAP` names the checkpoint boundary it accounts for via `parent_stream`. For a `stream` with exactly one declared parent (`state_stream`, or a single-entry `parent_streams`), `parent_stream` MAY be omitted; the runtime MUST treat the omission as naming that one parent. For a `stream` with more than one declared parent, the runtime MUST treat a `DETAIL_GAP` with no `parent_stream`, or with a `parent_stream` not matching the coverage report being evaluated, as **not** accounting for that report's required key — even when the `stream` and `record_key` match exactly. The same detail key can be legitimately gapped under one parent while hydrated or covered under a different parent in the same run; a gap recorded against one parent MUST NOT satisfy another parent's coverage. A `DETAIL_GAP` emitted before this section's parent-scoping rule existed (no `parent_stream`) satisfies coverage only for a `stream` that has exactly one declared parent; it MUST NOT be treated as satisfying any one parent of a stream with more than one declared parent.

A `gap_keys` entry in `DETAIL_COVERAGE` is not by itself proof of a durable retry obligation. The runtime MUST additionally confirm a matching `DETAIL_GAP` exists for the same `stream` and parent boundary before crediting that key as accounted; an unmatched `gap_keys` entry leaves the key unaccounted for coverage purposes, with the same fail-closed effect as a key omitted from every outcome set.

#### PROGRESS

Optional progress update for display in runtime UIs.

```json
{
  "type": "PROGRESS",
  "stream": "messages",
  "message": "Downloaded 500 of 2196 messages",
  "count": 500,
  "total": 2196
}
```

#### DONE

Signals completion. Must be the final message emitted by the connector.

```json
{
  "type": "DONE",
  "status": "succeeded",
  "records_emitted": 2196
}
```

On failure:

```json
{
  "type": "DONE",
  "status": "failed",
  "records_emitted": 0,
  "error": { "message": "Authentication failed", "retryable": true }
}
```

| Status | Meaning |
|--------|---------|
| `succeeded` | Collection completed. Runtime persists final STATE. |
| `failed` | Collection failed. Runtime does not persist STATE unless the messages certify a stream-scoped failure as described below. |
| `cancelled` | Collection was cancelled (e.g., user revoked mid-run). Runtime does NOT persist STATE. |

A failed run certifies a **stream-scoped failure** only when both of these conditions hold:

1. `DONE.error.code` is `stream_collection_failed`.
2. The run previously emitted at least one in-scope `SKIP_RESULT` with `reason: "stream_collection_failed"` and a non-empty `stream` naming each failed data stream.

A runtime MUST verify condition 2 structurally (a named, in-scope `SKIP_RESULT` was actually observed this run) and MUST NOT treat `DONE.error.code` alone as certification. If condition 1 holds but no in-scope `SKIP_RESULT{reason: "stream_collection_failed"}` was observed, the run is an ordinary uncertified failure and the default fail-closed rule applies: no staged STATE is persisted.

**Cancellation precedence.** If the runtime has recorded an owner-initiated cancellation for the run (for example, a mid-run revocation), the runtime MUST resolve the run as `cancelled` and MUST NOT evaluate or apply the stream-scoped-failure exception, even if the connector emitted a structurally certified `DONE{status: "failed", error.code: "stream_collection_failed"}` before the runtime observed the cancellation. Cancellation is checked, and takes precedence, before a terminal DONE is evaluated for certification.

##### Eligible-checkpoint algorithm

For a certified stream-scoped failure, the runtime MAY persist staged STATE for checkpoint streams that do not cover any named failed data stream. A runtime that implements this exception MUST compute eligibility as follows, run against the run's complete staged `STATE` map (every checkpoint stream for which a `STATE` message was received this run):

1. **Resolve each failed data stream to its checkpoint stream(s).** For each data stream named by an in-scope `SKIP_RESULT{reason: "stream_collection_failed"}`, compute its set of checkpoint parents using the manifest's static declaration, per [Precedence between manifest and run-time evidence](#precedence-between-manifest-and-run-time-evidence): the manifest's `state_stream` (single parent), or the manifest's full declared `parent_streams` set (every declared parent, whether or not it received a live `DETAIL_COVERAGE` report this run — a failed stream's live evidence is inherently incomplete, so every declared parent is a candidate to withhold); if neither is declared, the stream is self-mapped (its own name is its one checkpoint parent).
2. **Union every failed data stream's checkpoint parents** into one set of ineligible checkpoint streams.
3. **Compute detail-coverage shortfalls independently of the failure.** For every staged checkpoint stream, evaluate every `DETAIL_COVERAGE` report gating it: a report is incomplete if any `required_keys` entry is unaccounted (present in neither `hydrated_keys` nor a `gap_keys` entry backed by a matching `DETAIL_GAP` for the same stream and parent boundary — see [DETAIL_GAP](#detail_gap)), or if a manifest-declared parent relationship for an in-scope detail stream has no `DETAIL_COVERAGE` report at all this run. Add every checkpoint stream with an incomplete report to the ineligible set. A reference-implementation extension MAY additionally credit its explicitly opted-in `optional_skip_keys`, but that is not portable v0.1 behavior.
4. **Commit every staged checkpoint stream not in the ineligible set.** The runtime MUST NOT persist STATE for any checkpoint stream in the ineligible set (from step 2 or step 3).
5. **Partial checkpoint-store failure.** If persisting an individual eligible checkpoint stream's STATE fails after the eligibility set is computed (for example, a resource-server write error), the runtime MUST fail the run as a runtime error. A partial commit failure MUST NOT be reported as `succeeded`, and any checkpoint stream not yet committed at the point of failure remains eligible for retry on the next run. The runtime MUST make the following observable, though not necessarily from a single field or object: the total count of checkpoint streams staged and the total count durably committed before the failure (a bounded numeric summary; this MAY be all a single terminal-result field exposes), the identity of the specific checkpoint stream whose persistence attempt failed (for example, in a diagnostic message or a dedicated failure event), and the identity of each checkpoint stream that was durably committed before the failure (for example, via a per-stream commit event emitted at the time of that commit, or by reading back the durably persisted state after the run). A runtime is not required to expose a single response field naming every staged-and-committed stream together; it MUST NOT expose only bounded counts with no path at all to recovering which specific streams committed.

The run's own status remains `failed` regardless of how many checkpoint streams commit under this exception; every named failed data stream, and every checkpoint stream withheld under steps 2–3, remains unproven and eligible for retry on the next run.

A missing or mismatched terminal code, a missing or untargeted skip, an out-of-scope stream, a protocol violation, an invalid terminal count or exit code, a process exit without valid DONE, or cancellation MUST preserve the default fail-closed rule and persist no staged STATE.

<a id="restart-abandonment"></a>
**Restart abandonment.** A process exit without valid DONE caused by the CONTROLLER being replaced or restarted -- not by the connector failing -- MAY persist a staged STATE checkpoint for a checkpoint stream that satisfies ALL of the following, and MUST persist none otherwise:

1. The run's terminal reason is a controller-lifecycle reason (the controller died; the connector did not report failure).
2. The checkpoint stream is not a declared detail-coverage parent in the connector's manifest, so it can never face a DONE-time coverage verdict. Eligibility is derived from the MANIFEST alone; a connector MUST NOT be able to declare its own eligibility.
3. The stream has no pending detail gap and no unproven coverage for the completed prefix.

This exception exists because a walk longer than the interval between controller restarts can otherwise never converge -- it is a completeness failure, not a slowness one. It does not weaken the invariant that a cursor MUST NOT advance past records whose coverage was not proven: a stream that could face such a verdict is excluded by condition 2, and unproven coverage is excluded by condition 3. The run's status remains failed/abandoned and every withheld stream stays eligible for retry.

`error` MAY carry `code` and/or `recovery_hint`, in addition to the required `message` and `retryable`:

- `code` is a stable, connector-defined **cause identity** (e.g. distinguishing one failure mode from another). It is a bounded `snake_case` identifier (a lowercase letter followed by up to 63 lowercase letters, digits, or underscores), an identity rather than an instruction — the runtime MUST NOT treat `code` as, or derive, an owner-facing recovery action from it.
- `recovery_hint` is the connector's declaration of the owner-facing **recovery action**. It uses the exact same bounded shape and vocabulary as `SKIP_RESULT.recovery_hint` — see [Recovery hints](#recovery-hints).

`code` and `recovery_hint` answer different questions (what went wrong vs. what to do about it) and MUST be validated and consumed independently; a runtime MUST NOT infer one from the other.

#### Precedence between manifest and run-time evidence

A data stream's checkpoint parent(s) are declared statically in the manifest (`state_stream` or `parent_streams`). The manifest is authoritative: it declares the permitted parent shape, and the connector's own `DETAIL_COVERAGE` messages (`state_stream` field, per message) may only select or report evidence within that declared shape for a given run — they MUST NOT introduce a parent the manifest did not declare, and MUST NOT override a static single-parent declaration. A runtime MUST resolve a data stream's checkpoint parent(s), and validate live evidence against that resolution, as follows:

1. **`state_stream` (static single parent).** The stream's checkpoint parent is always the manifest's declared `state_stream`, for every run, with no run-time override. The connector MUST NOT emit `DETAIL_COVERAGE` naming this stream as `stream` at all; a runtime MUST reject any such message as a protocol violation (fail closed), regardless of what `state_stream` value it reports.
2. **`parent_streams` (declared parent set).** The stream's checkpoint parents are the manifest's declared set. A runtime MUST reject any `DETAIL_COVERAGE` message naming this stream as `stream` whose `state_stream` value is not a member of the declared set, as a protocol violation (fail closed). For a declared parent that HAS a live `DETAIL_COVERAGE` report this run, that report's own coverage/gap accounting gates its checkpoint (see [Eligible-checkpoint algorithm](#eligible-checkpoint-algorithm)). For a declared parent with NO live report this run, where the data stream is in-scope and has staged state, the runtime MUST treat that parent boundary as unproven and withhold it — the same fail-closed treatment as an incomplete coverage report — rather than silently dropping it from the dependency set or silently treating it as satisfied.
3. **Self-mapping is the default.** If the stream declares neither `state_stream` nor `parent_streams`, its own name is its one checkpoint parent, and it is unaffected by any of the above.

This is a manifest-is-authoritative model: live evidence for a run can select or report within the manifest's declared shape, but can never contradict, widen, or override it. There is a conflict-rejection case for manifest vs. run-time evidence, unlike prior drafts of this section: a `state_stream`-declared stream that emits any `DETAIL_COVERAGE` is rejected outright, and a `parent_streams`-declared stream's `DETAIL_COVERAGE` naming a parent outside its declared set is rejected outright. A manifest declaring `parent_streams: ["a", "b"]` MAY see the connector's live evidence for a given run name only `"a"` (for example, if `"b"`'s boundary produced no detail this run); the runtime withholds `"b"`'s checkpoint as unproven for this run rather than treating the narrower live report as redefining the declared dependency.

#### Recovery hints

`SKIP_RESULT.recovery_hint` and `DONE.error.recovery_hint` share one bounded, provider-neutral shape and vocabulary:

- `recovery_hint` is either a bare string from the closed action vocabulary below, or an object `{ action: string, retryable?: boolean }` where `action` MUST be present and from that vocabulary, and `retryable`, if present, MUST be a boolean.
- An empty object `{}` or an object with only `retryable` field is a **protocol violation**: if a connector supplies a recovery hint as an object, the `action` field is mandatory.
- Action vocabulary: `retry_by_runtime`, `retry_on_connector_upgrade`, `refresh_credentials`, `manual_action_required`, `update_selector`, `upstream_unblock`, `not_retriable`, `unknown`.
- A connector requests a specific owner-facing recovery action **only** through `recovery_hint`. A present, valid `recovery_hint` is authoritative: a runtime MUST NOT override it, and MUST NOT treat `code`, `message`, or any other connector-authored free-form text as the connector's requested action.
- A runtime MUST treat an absent `recovery_hint` as "no hint declared," and MAY fall through to its own generic, connector-neutral policy for choosing a default action — for example from the `retryable` flag, or from bounded, provider-neutral classification of the error text (such as recognizing generic authentication or browser-infrastructure failures). That fallback MUST NOT infer provider-specific intent, and MUST NOT be, or become, a connector-specific text/identity heuristic.
- A `recovery_hint` that is present but does not match the shape or vocabulary above is a **protocol violation**: the runtime MUST reject the enclosing message (fail closed), not silently drop the field or substitute a guessed action.

---

## 4. Connector Conformance

A conformant connector:

1. Reads START from stdin before emitting any messages.
2. Emits only valid JSONL messages as defined in this profile.
3. Emits DONE as the final message in all cases (including failures where possible).
4. Emits STATE periodically for streams that support incremental sync.
5. Does not store secrets (credentials, OTP codes) in STATE.
6. Does not emit INTERACTION while in `waiting_for_interaction`.
7. Treats missing required bindings as fatal errors.
8. Exits with status 0 on `succeeded`, non-zero on `failed` or `cancelled`.
9. Emits RECORD messages only within the `scope` provided in START: no undeclared streams, no records outside declared `resources` or `time_range`, and no extra top-level fields when `fields` is present.
10. If it cannot honor a declared `resources`, `time_range`, or `fields` constraint, emits an explicit `SKIP_RESULT` or fails the run; it never silently broadens scope.
11. If it runs a list+detail lane, emits `DETAIL_COVERAGE` per checkpoint-parent boundary per run, with every required key accounted in `hydrated_keys` or `gap_keys` backed by a matching `DETAIL_GAP` (see [DETAIL_COVERAGE](#detail_coverage)). The reference implementation's `optional_skip_keys` extension is not required for portable v0.1 conformance.
12. Scopes every `DETAIL_GAP` to the checkpoint-parent boundary it accounts for via `parent_stream` whenever the affected detail stream has more than one declared parent.

### A conformant connector runtime:

1. Performs binding matching before spawning the connector process.
2. Sends START as the first and only START message.
3. Handles INTERACTION messages by prompting the user or agent and sending INTERACTION_RESPONSE.
4. Sends INTERACTION_RESPONSE with `status: "timeout"` if no response arrives within `timeout_seconds`.
5. Persists STATE only after preceding records are durably written.
6. Does NOT persist STATE on `cancelled` runs or uncertified `failed` runs; for a certified stream-scoped failure, persists only staged checkpoint streams computed eligible under the [Eligible-checkpoint algorithm](#eligible-checkpoint-algorithm). Checks for and honors an owner-initiated cancellation before evaluating a terminal DONE for stream-scoped-failure certification.
7. Uses the connector's global state namespace for proactive runs, the `grant_id`-scoped namespace for `continuous` grant runs, and `state: null` for `single_use` runs.
8. Terminates the connector process on protocol violations.
9. Does not log or persist credential data from INTERACTION_RESPONSE.
10. Sends an explicit non-empty `scope` in START. For grant-driven runs, this scope is a normalized, possibly narrowed projection of the grant and MUST NOT include wildcard stream names.
11. For grant-driven runs, never constructs a `scope` broader than the grant permits.
12. Rejects or discards connector emissions that fall outside the declared `scope` before durable write.
13. Terminates an active grant-driven run as soon as practical after learning that the grant was revoked.
14. Validates every stream's checkpoint-dependency declaration (`state_stream`/`parent_streams`) before spawning the connector, and fails closed (does not start the run) on self-reference, an unknown parent, a duplicate parent, both fields present on one stream, an empty `parent_streams`, or a cycle of any length in the declared dependency graph (see [Checkpoint dependency: Validation](#validation)). Cycle detection (rule 6) is implemented and tested as a genuine check over the complete declared graph — not satisfied vacuously by the other checks — because two or more direct edges can form a cycle that a single-stream check cannot see (see the non-normative notes under [Validation](#validation)).
15. Resolves a data stream's checkpoint parent(s) for a run from the manifest's static declaration only (`state_stream` or the full declared `parent_streams` set), and validates any live `DETAIL_COVERAGE` evidence against that declared shape: rejects a `state_stream`-declared stream's DETAIL_COVERAGE outright, rejects a `parent_streams`-declared stream's DETAIL_COVERAGE naming an undeclared parent, and withholds a declared parent that received no live report this run rather than dropping it or treating it as satisfied (see [Precedence between manifest and run-time evidence](#precedence-between-manifest-and-run-time-evidence)).
16. Fails the run as a runtime error, without reporting `succeeded`, if persisting an eligible checkpoint's STATE fails partway through committing multiple staged checkpoints; makes the staged/committed counts, the failing checkpoint stream's identity, and each committed checkpoint stream's identity observable (not necessarily from one field — see [Eligible-checkpoint algorithm](#eligible-checkpoint-algorithm) step 5).

---

## 5. TypeScript Types

```typescript
type InteractionKind = 'credentials' | 'otp' | 'manual_action';
type StreamState = Record<string, Record<string, unknown>>;
type TimeRange = { since?: string; until?: string };
type CollectionStream = {
  name: string;
  resources?: string[];
  time_range?: TimeRange;
  fields?: string[];
};
type CollectionScope = {
  streams: CollectionStream[];
};

type ManifestStream = {
  name: string;
  incremental?: boolean;
  // A stream MUST declare at most one of state_stream / parent_streams.
  // Neither present means the stream is its own checkpoint (self-mapped).
  state_stream?: string;
  parent_streams?: string[]; // non-empty when present
  [key: string]: unknown;
};

type RuntimeMessage =
  | {
      type: 'START';
      run_id: string;
      collection_mode: 'full_refresh' | 'incremental';
      scope: CollectionScope;
      state: StreamState | null;
      bindings: Record<string, Record<string, unknown>>;
    }
  | {
      type: 'INTERACTION_RESPONSE';
      request_id: string;
      status: 'success' | 'cancelled' | 'timeout';
      data?: Record<string, unknown>;
    };

type ConnectorMessage =
  | {
      type: 'RECORD';
      stream: string;
      key: string | string[];
      data: Record<string, unknown>;
      emitted_at: string;
      op?: 'upsert' | 'delete';
    }
  | {
      type: 'STATE';
      stream: string;
      cursor: Record<string, unknown>;
    }
  | {
      type: 'INTERACTION';
      request_id: string;
      kind: InteractionKind;
      message: string;
      schema?: Record<string, unknown>;
      timeout_seconds?: number;
    }
  | {
      type: 'SKIP_RESULT';
      stream?: string;
      reason?: string;
      message?: string;
      recovery_hint?: RecoveryHint;
    }
  | {
      type: 'DETAIL_COVERAGE';
      reference_only: true;
      stream: string;
      state_stream: string;
      required_keys: (string | number)[];
      hydrated_keys: (string | number)[];
      gap_keys?: (string | number)[];
    }
  | {
      type: 'DETAIL_GAP';
      stream: string;
      parent_stream?: string;
      record_key?: string | number;
      reason?: string;
      retryable?: boolean;
      detail_locator?: Record<string, unknown>;
      list_cursor?: Record<string, unknown>;
      last_error?: Record<string, unknown>;
      gap_id?: string;
      lease_id?: string;
    }
  | {
      type: 'PROGRESS';
      stream?: string;
      message: string;
      count?: number;
      total?: number;
    }
  | {
      type: 'DONE';
      status: 'succeeded' | 'failed' | 'cancelled';
      records_emitted: number;
      error?: { code?: string; message: string; recovery_hint?: RecoveryHint; retryable: boolean };
    };

type RecoveryAction =
  | 'retry_by_runtime'
  | 'retry_on_connector_upgrade'
  | 'refresh_credentials'
  | 'manual_action_required'
  | 'update_selector'
  | 'upstream_unblock'
  | 'not_retriable'
  | 'unknown';

type RecoveryHint = RecoveryAction | { action: RecoveryAction; retryable?: boolean };
```
