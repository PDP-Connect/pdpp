# PDPP Collection Profile v0.1.0

Status: Draft
Date: 2026-04-11

Companion to the Personal Data Portability Protocol (PDPP) core spec.

---

## Overview

The Collection Profile defines how connectors collect data from source platforms and write it to a PDPP resource server. It is one fulfillment mechanism for the PDPP core protocol; pre-collected data, manual imports, and other ingestion mechanisms are equally valid.

The Collection Profile is architecturally separate from the core protocol. A resource server serving pre-collected data needs no awareness of this profile. A connector runtime implementing this profile needs no awareness of grant semantics beyond what is explicitly passed to it in the START message.

---

## 1. Connector Manifest Extensions

The core manifest (Section 7 of the core spec) defines the consent surface. The Collection Profile adds execution-specific fields.

```json
{
  "protocol_version": "0.1.0",
  "connector_id": "https://registry.pdpp.org/connectors/spotify",
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

- A connector MUST NOT emit INTERACTION while already in `waiting_for_interaction`. A runtime that receives a second INTERACTION in this state MUST terminate the connector process and mark the run as failed.
- A connector that receives INTERACTION_RESPONSE while in `collecting` (no pending INTERACTION) SHOULD treat it as a fatal protocol error, write a diagnostic to stderr, and exit with non-zero status.
- START is exactly-once. It MUST be the first message sent by the runtime. A connector that receives START while in any state other than `initializing` MUST treat it as a fatal protocol error.

**Runtime behavior on failure:** The runtime MUST NOT persist STATE checkpoints from a run that terminates in the `failed` state. State is only persisted after a successful DONE.

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
| `failed` | Collection failed. Runtime does NOT persist STATE. |
| `cancelled` | Collection was cancelled (e.g., user revoked mid-run). Runtime does NOT persist STATE. |

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

### A conformant connector runtime:

1. Performs binding matching before spawning the connector process.
2. Sends START as the first and only START message.
3. Handles INTERACTION messages by prompting the user or agent and sending INTERACTION_RESPONSE.
4. Sends INTERACTION_RESPONSE with `status: "timeout"` if no response arrives within `timeout_seconds`.
5. Persists STATE only after preceding records are durably written.
6. Does NOT persist STATE on `failed` or `cancelled` runs.
7. Uses the connector's global state namespace for proactive runs, the `grant_id`-scoped namespace for `continuous` grant runs, and `state: null` for `single_use` runs.
8. Terminates the connector process on protocol violations.
9. Does not log or persist credential data from INTERACTION_RESPONSE.
10. Sends an explicit non-empty `scope` in START. For grant-driven runs, this scope is a normalized, possibly narrowed projection of the grant and MUST NOT include wildcard stream names.
11. For grant-driven runs, never constructs a `scope` broader than the grant permits.
12. Rejects or discards connector emissions that fall outside the declared `scope` before durable write.

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
      error?: { message: string; retryable: boolean };
    };
```
