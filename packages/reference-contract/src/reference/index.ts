// Reference-only /_ref route manifests.
//
// These are reference-designated operator/control surfaces. They belong in
// the full OpenAPI artifact and in reference-implementation docs, but NOT in
// the public PDPP contract surface.

import { ErrorObjectSchema, FreshnessSchema } from "../common/index.ts";

const ConnectorSummarySchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    connector_id: { type: "string" },
    display_name: { type: "string" },
    manifest_version: { type: "string" },
    streams: { type: "array", items: { type: "string" } },
    total_records: { type: "integer" },
    freshness: FreshnessSchema,
    schedule: {
      type: ["object", "null"],
      additionalProperties: true,
      properties: {
        interval_seconds: { type: "integer" },
        jitter_seconds: { type: "integer" },
        enabled: { type: "boolean" },
        next_due_at: { type: ["string", "null"] },
      },
    },
    last_run: {
      type: ["object", "null"],
      additionalProperties: true,
      properties: {
        run_id: { type: "string" },
        status: { type: "string" },
        started_at: { type: "string" },
        finished_at: { type: ["string", "null"] },
        first_at: { type: "string" },
        last_at: { type: "string" },
        event_count: { type: "integer" },
        failure_reason: { type: ["string", "null"] },
      },
    },
    last_successful_run: {
      type: ["object", "null"],
      additionalProperties: true,
      properties: {
        run_id: { type: "string" },
        status: { type: "string" },
        started_at: { type: "string" },
        finished_at: { type: ["string", "null"] },
        first_at: { type: "string" },
        last_at: { type: "string" },
        event_count: { type: "integer" },
        failure_reason: { type: ["string", "null"] },
      },
    },
  },
  required: ["connector_id"],
};

const ConnectorListResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "list" },
    data: { type: "array", items: ConnectorSummarySchema },
  },
  required: ["object", "data"],
};

const ScheduleUpsertBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    interval_seconds: { type: "integer", minimum: 1 },
    jitter_seconds: { type: "integer", minimum: 0 },
    enabled: { type: "boolean" },
  },
  required: ["interval_seconds"],
};

const RunStartResponseSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    run_id: { type: "string" },
    trace_id: { type: "string" },
  },
  required: ["run_id"],
};

const ConnectorInstanceIdParamSchema = {
  type: "object",
  additionalProperties: false,
  properties: { connectorInstanceId: { type: "string", minLength: 1 } },
  required: ["connectorInstanceId"],
};

// Owner-agent control surface standardizes on `connection_id` as the stable
// selector (see `OwnerConnectionSchema`), so its path params use
// `{connectionId}` rather than the deprecated `{connectorInstanceId}` alias the
// `/_ref/*` surface carries.
const ConnectionIdParamSchema = {
  type: "object",
  additionalProperties: false,
  properties: { connectionId: { type: "string", minLength: 1 } },
  required: ["connectionId"],
};

const ConnectionQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    connector_id: { type: "string" },
    status: { type: "string", enum: ["active", "paused", "revoked"] },
  },
};

const RefConnectionSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    object: { const: "ref_connection" },
    connector_instance_id: { type: "string" },
    connector_id: { type: "string" },
    display_name: { type: ["string", "null"] },
    status: { type: "string" },
    source_kind: { type: ["string", "null"] },
    source_binding: { type: ["object", "null"], additionalProperties: true },
    created_at: { type: "string" },
    updated_at: { type: "string" },
    revoked_at: { type: ["string", "null"] },
    schedule: { type: ["object", "null"], additionalProperties: true },
  },
  required: [
    "object",
    "connector_instance_id",
    "connector_id",
    "display_name",
    "status",
    "source_kind",
    "source_binding",
    "created_at",
    "updated_at",
    "revoked_at",
    "schedule",
  ],
};

const ConnectionListResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "list" },
    data: { type: "array", items: RefConnectionSchema },
  },
  required: ["object", "data"],
};

// One owner-agent control action descriptor. Shared by the control entrypoint
// document (`GET /v1/owner/control`) and the per-connection `supported_actions`
// array, so the two surfaces describe an action the same way. `status` is the
// stable selector: `supported` carries a `method` + absolute `url`; everything
// else carries `null` for both so an agent does not probe a route this build
// does not serve. Defined before `OwnerConnectionSchema` because that schema
// references it for its `supported_actions` items.
const OwnerControlActionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    family: { type: "string" },
    status: { type: "string", enum: ["supported", "owner_mediated", "unsupported"] },
    method: { type: ["string", "null"] },
    url: { type: ["string", "null"] },
    reason: { type: "string" },
  },
  required: ["family", "status", "method", "url", "reason"],
};

// Owner-agent control-surface projection of a configured connection. The
// bearer-authed `/v1/owner/connections` sibling of `/_ref/connections`
// standardizes on `connection_id` as the stable selector (keeping
// `connector_instance_id` as a deprecated alias), exposes both
// `connector_id` and the canonical `connector_key`, and adds `label_status`
// so an owner agent can tell an owner-chosen label from a storage-layer
// fallback (label-needed) without re-deriving the placeholder rules.
const OwnerConnectionSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    object: { const: "owner_connection" },
    connection_id: { type: "string" },
    connector_instance_id: { type: "string" },
    connector_id: { type: "string" },
    connector_key: { type: "string" },
    display_name: { type: ["string", "null"] },
    label_status: { type: "string", enum: ["owner_set", "fallback"] },
    status: { type: ["string", "null"] },
    source_kind: { type: ["string", "null"] },
    source_binding: { type: ["object", "null"], additionalProperties: true },
    created_at: { type: ["string", "null"] },
    updated_at: { type: ["string", "null"] },
    revoked_at: { type: ["string", "null"] },
    schedule: { type: ["object", "null"], additionalProperties: true },
    // Capability-advertised, instance-scoped control actions for this exact
    // connection (`rename_connection`, `run_connection`, `manage_schedule`,
    // `inspect_diagnostics`, `delete_connection`, `revoke_connection`).
    // Projected from the same control catalog `GET /v1/owner/control` reads, so
    // a row can never claim a supported action the control document calls
    // unsupported. Supported actions carry this connection's concrete URL;
    // unavailable actions are marked `owner_mediated`/`unsupported` with a typed
    // reason rather than omitted, so an agent never probes a 404.
    supported_actions: { type: "array", items: OwnerControlActionSchema },
  },
  required: [
    "object",
    "connection_id",
    "connector_instance_id",
    "connector_id",
    "connector_key",
    "display_name",
    "label_status",
    "status",
    "source_kind",
    "source_binding",
    "created_at",
    "updated_at",
    "revoked_at",
    "schedule",
    "supported_actions",
  ],
};

const OwnerConnectionListResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "list" },
    data: { type: "array", items: OwnerConnectionSchema },
  },
  required: ["object", "data"],
};

const OwnerConnectionSummarySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "owner_connection_summary" },
    connection_id: { type: "string" },
    connector_instance_id: { type: "string" },
    connector_id: { type: "string" },
    connector_key: { type: "string" },
    display_name: { type: ["string", "null"] },
    label_status: { type: "string", enum: ["owner_set", "fallback"] },
    status: { type: ["string", "null"] },
    source_kind: { type: ["string", "null"] },
    created_at: { type: ["string", "null"] },
    updated_at: { type: ["string", "null"] },
    revoked_at: { type: ["string", "null"] },
  },
  required: [
    "object",
    "connection_id",
    "connector_instance_id",
    "connector_id",
    "connector_key",
    "display_name",
    "label_status",
    "status",
    "source_kind",
    "created_at",
    "updated_at",
    "revoked_at",
  ],
};

const OwnerConnectorTemplateSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "owner_connector_template" },
    connector_id: { type: "string" },
    connector_key: { type: "string" },
    display_name: { type: "string" },
    version: { type: ["string", "null"] },
    connector_modality: {
      type: "string",
      enum: ["local_collector", "browser_bound", "api_network", "unknown"],
    },
    stream_count: { type: "integer", minimum: 0 },
    connection_count: { type: "integer", minimum: 0 },
    connections: { type: "array", items: OwnerConnectionSummarySchema },
    supported_actions: { type: "array", items: OwnerControlActionSchema },
  },
  required: [
    "object",
    "connector_id",
    "connector_key",
    "display_name",
    "version",
    "connector_modality",
    "stream_count",
    "connection_count",
    "connections",
    "supported_actions",
  ],
};

const OwnerConnectorTemplateListResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "list" },
    data: { type: "array", items: OwnerConnectorTemplateSchema },
  },
  required: ["object", "data"],
};

// Owner-agent control entrypoint capability document returned by
// `GET /v1/owner/control`. A trusted owner agent reads this to discover which
// owner-agent control action families exist, which are supported in this build
// (with method + absolute URL), and which remain owner-mediated or unsupported.
// The catalog is honest by construction: unsupported/owner-mediated families
// are named with a typed `status` and reason rather than silently omitted. Its
// action items use `OwnerControlActionSchema` (defined above, before
// `OwnerConnectionSchema`). See openspec/changes/add-owner-agent-control-surface.
const OwnerControlSurfaceResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "owner_agent_control_surface" },
    entrypoint: { type: "string" },
    scope: { const: "reference_implementation" },
    mcp_owner_bearer_rejected: { const: true },
    actions: { type: "array", items: OwnerControlActionSchema },
  },
  required: ["object", "entrypoint", "scope", "mcp_owner_bearer_rejected", "actions"],
};

// One run summary inside the connection-scoped diagnostics read. Carries only
// the non-secret status/timing/run-id fields; gap arrays and event counts stay
// in the richer connector-summary surface.
const OwnerConnectionDiagnosticsRunSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    run_id: { type: ["string", "null"] },
    status: { type: "string" },
    started_at: { type: ["string", "null"] },
    finished_at: { type: ["string", "null"] },
    failure_reason: { type: ["string", "null"] },
  },
  required: ["run_id", "status", "started_at", "finished_at", "failure_reason"],
};

// The typed connection-health classification inside the diagnostics read. `state`
// is the canonical connection-health taxonomy the connector-health-surface
// research captured; `axes` and `badges` are orthogonal diagnostic detail. The
// shape mirrors the runtime `ConnectionHealthSnapshot` subset the diagnostics
// projection surfaces, so it stays permissive (`additionalProperties: true`) on
// the nested axes/badges objects to avoid a contract break when an axis is added.
const OwnerConnectionDiagnosticsHealthSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    state: {
      type: "string",
      enum: ["blocked", "cooling_off", "degraded", "healthy", "idle", "needs_attention", "unknown"],
    },
    reason_code: { type: ["string", "null"] },
    last_success_at: { type: ["string", "null"] },
    next_attempt_at: { type: ["string", "null"] },
    axes: { type: "object", additionalProperties: true },
    badges: { type: "object", additionalProperties: true },
  },
  required: ["state", "reason_code", "last_success_at", "next_attempt_at", "axes", "badges"],
};

// Owner-agent connection-scoped diagnostics read returned by
// `GET /v1/owner/connections/{connectionId}/diagnostics`. Connection-scoped by
// construction: every field describes exactly the one configured connection the
// `connection_id` addresses — last run status, last successful run, last
// successful ingest time, current schedule state, freshness, and the typed
// health classification. It carries NO device-exporter subsystem state and NO
// sibling-connection state, which is the boundary that lets it ship under the
// owner-bearer adapter where device-rooted diagnostics cannot. See
// openspec/changes/add-owner-agent-control-surface.
const OwnerConnectionDiagnosticsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "owner_connection_diagnostics" },
    connection_id: { type: "string" },
    connector_id: { type: "string" },
    connector_key: { type: "string" },
    display_name: { type: ["string", "null"] },
    health: OwnerConnectionDiagnosticsHealthSchema,
    last_run: { oneOf: [OwnerConnectionDiagnosticsRunSchema, { type: "null" }] },
    last_successful_run: { oneOf: [OwnerConnectionDiagnosticsRunSchema, { type: "null" }] },
    last_ingest_at: { type: ["string", "null"] },
    schedule: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            interval_seconds: { type: ["integer", "null"] },
          },
          required: ["enabled", "interval_seconds"],
        },
        { type: "null" },
      ],
    },
    freshness: { type: "object", additionalProperties: true },
  },
  required: [
    "object",
    "connection_id",
    "connector_id",
    "connector_key",
    "display_name",
    "health",
    "last_run",
    "last_successful_run",
    "last_ingest_at",
    "schedule",
    "freshness",
  ],
};

// Owner-agent connection-revoke result: the soft-flipped connection. Revoke is
// zero-cascade (records, spine, device rows, and sibling connections are
// untouched) and durable, so the response only confirms the connection's new
// `revoked` status and the `revoked_at` stamp — there is nothing else to report.
const OwnerConnectionRevokeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "owner_connection_revoke" },
    connection_id: { type: "string" },
    connector_id: { type: "string" },
    connector_key: { type: "string" },
    status: { const: "revoked" },
    revoked_at: { type: ["string", "null"] },
  },
  required: ["object", "connection_id", "connector_id", "connector_key", "status", "revoked_at"],
};

// Non-secret deletion summary returned by the owner-agent connection-DELETE
// routes. Carries counts + stable identifiers only — never record contents,
// secrets, or per-record detail. `deleted_record_count` /
// `deleted_stream_count` report what the cascade erased; `schedule_deleted`
// reflects whether a schedule row existed; `device_refs_cleared` is the count
// of device source-instance back-references set to null.
const OwnerConnectionDeleteSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "owner_connection_delete" },
    connection_id: { type: "string" },
    connector_id: { type: "string" },
    connector_key: { type: "string" },
    deleted: { const: true },
    deleted_record_count: { type: "integer" },
    deleted_stream_count: { type: "integer" },
    schedule_deleted: { type: "boolean" },
    device_refs_cleared: { type: "integer" },
  },
  required: [
    "object",
    "connection_id",
    "connector_id",
    "connector_key",
    "deleted",
    "deleted_record_count",
    "deleted_stream_count",
    "schedule_deleted",
    "device_refs_cleared",
  ],
};

// Owner-agent connection-intent request: a trusted owner agent names the
// connector type it wants to add a connection for. `connector_id` accepts the
// canonical key (`amazon`) or a registry URL; the route canonicalizes it. An
// optional `display_name` is a label hint carried through to the materialized
// connection where the next step supports one (e.g. local-collector enroll).
const OwnerConnectionIntentRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    connector_id: { type: "string", minLength: 1 },
    display_name: { type: "string", minLength: 1, maxLength: 200 },
  },
  required: ["connector_id"],
};

// Typed next step a connection intent returns. `kind` is the stable selector an
// agent branches on. The reference build emits `enroll_local_collector` for
// proven local-collector connectors and `unsupported` for browser-bound,
// API/network-only, and unknown connectors; `open_url`, `complete_browser_assistance`,
// `upload_file`, `enroll_browser_collector`, and `complete_credential_capture` are
// reserved for future primitives so a later lane can emit them without a contract
// break. `enroll_browser_collector` is the kind the `browser_bound` branch will
// emit once the `add-browser-collector-enrollment-primitive` live proof gate is
// satisfied (design Decision 3). `complete_credential_capture` is the kind the
// `api_network` branch will emit for static-secret connectors (gmail/github) once
// the `add-static-secret-owner-connect-primitive` proof gate is satisfied (that
// change's design Decision 4): it directs the OWNER — never the agent — to supply
// the provider static secret (app password / PAT) through an owner-trusted local
// surface; the agent only ever observes the typed step and the resulting
// `connection_id`. Reserving these values does NOT advertise the flow — no route
// emits them until each proof lands, and `owner-connection-intent.test.js` pins
// that the runtime `browser_bound` and `api_network` branches stay `unsupported`.
// Secret material (enrollment codes excepted — they are single-use, owner-scoped,
// and short-lived) is never carried here; in particular `complete_credential_capture`
// never carries the provider secret.
const OwnerConnectionIntentNextStepSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    kind: {
      type: "string",
      enum: [
        "open_url",
        "complete_browser_assistance",
        "upload_file",
        "enroll_local_collector",
        "enroll_browser_collector",
        "complete_credential_capture",
        "unsupported",
      ],
    },
    reason: { type: ["string", "null"] },
    url: { type: "string" },
    enrollment_code: { type: "string" },
    enroll_endpoint: { type: "string" },
    local_binding_name: { type: "string" },
    expires_at: { type: "string" },
  },
  required: ["kind"],
};

// Owner-agent connection-intent response. The intent is an auditable workflow
// object, NOT a created connection: `connection_active` is always `false` and no
// `connector_instances` row is written by the intent itself. `connector_modality`
// classifies the connector by its manifest `runtime_requirements.bindings`
// (`local_collector` | `browser_bound` | `api_network` | `unknown`) so an agent
// can explain why a given `next_step.kind` was returned.
const OwnerConnectionIntentResponseSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    object: { const: "owner_connection_intent" },
    connector_id: { type: "string" },
    connector_key: { type: "string" },
    connector_modality: {
      type: "string",
      enum: ["local_collector", "browser_bound", "api_network", "unknown"],
    },
    connection_active: { const: false },
    next_step: OwnerConnectionIntentNextStepSchema,
  },
  required: ["object", "connector_id", "connector_key", "connector_modality", "connection_active", "next_step"],
};

const ApprovalItemSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    object: { const: "approval" },
    approval_id: { type: "string" },
    kind: { type: "string", enum: ["consent", "owner_device"] },
    client_id: { type: ["string", "null"] },
    grant_preview: { type: "object" },
    created_at: { type: "string" },
  },
  required: ["object", "approval_id", "kind"],
};

const RefSearchRecordSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    connector_id: { type: "string" },
    stream: { type: "string" },
    id: { type: "string" },
    emitted_at: { type: "string" },
    data: { type: ["object", "null"] },
    matched_field: { type: ["string", "null"] },
    snippet: { type: ["string", "null"] },
    native_timestamp: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        field: { type: "string" },
        value: { type: "string" },
      },
      required: ["field", "value"],
    },
  },
  required: ["connector_id", "stream", "id", "emitted_at"],
};

const RecordPageSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer" },
    offset: { type: "integer" },
    returned: { type: "integer" },
    total: { type: "integer" },
    has_more: { type: "boolean" },
    next_cursor: { type: ["string", "null"] },
    prev_cursor: { type: ["string", "null"] },
    sort: { type: "string", enum: ["native", "ingested"] },
    order: { type: "string", enum: ["asc", "desc"] },
    filters: {
      type: "object",
      additionalProperties: false,
      properties: {
        connector_id: { type: ["string", "null"] },
        stream: { type: ["string", "null"] },
      },
      required: ["connector_id", "stream"],
    },
  },
  required: [
    "limit",
    "offset",
    "returned",
    "total",
    "has_more",
    "next_cursor",
    "prev_cursor",
    "sort",
    "order",
    "filters",
  ],
};

const DatasetSummaryResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "dataset_summary" },
    connector_count: { type: "integer", minimum: 0 },
    stream_count: { type: "integer", minimum: 0 },
    record_count: { type: "integer", minimum: 0 },
    record_json_bytes: { type: "integer", minimum: 0 },
    record_changes_json_bytes: { type: "integer", minimum: 0 },
    blob_bytes: { type: "integer", minimum: 0 },
    total_retained_bytes: { type: "integer", minimum: 0 },
    earliest_record_time: { type: ["string", "null"] },
    latest_record_time: { type: ["string", "null"] },
    earliest_ingested_at: { type: ["string", "null"] },
    latest_ingested_at: { type: ["string", "null"] },
    top_connectors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          object: { const: "dataset_connector_summary" },
          connector_id: { type: "string" },
          record_count: { type: "integer", minimum: 0 },
        },
        required: ["object", "connector_id", "record_count"],
      },
    },
    projection: {
      type: "object",
      additionalProperties: false,
      properties: {
        computed_at: { type: ["string", "null"] },
        state: {
          enum: ["fresh", "refreshing", "stale", "rebuilding", "failed"],
        },
        stale_since: { type: ["string", "null"] },
        rebuild_status: { enum: ["idle", "running", "failed"] },
        last_error: { type: ["string", "null"] },
        source_high_watermark: { type: ["string", "null"] },
      },
      required: ["computed_at", "state", "stale_since", "rebuild_status", "last_error"],
    },
  },
  required: [
    "object",
    "connector_count",
    "stream_count",
    "record_count",
    "record_json_bytes",
    "record_changes_json_bytes",
    "blob_bytes",
    "total_retained_bytes",
    "earliest_record_time",
    "latest_record_time",
    "earliest_ingested_at",
    "latest_ingested_at",
    "top_connectors",
    "projection",
  ],
};

const DatasetSummaryStreamsResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "dataset_summary_streams" },
    streams: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          connector_id: { type: "string" },
          stream: { type: "string" },
          record_count: { type: "integer", minimum: 0 },
          record_json_bytes: { type: "integer", minimum: 0 },
          earliest_ingested_at: { type: ["string", "null"] },
          latest_ingested_at: { type: ["string", "null"] },
          earliest_record_time: { type: ["string", "null"] },
          latest_record_time: { type: ["string", "null"] },
          consent_time_field: { type: ["string", "null"] },
          dirty_record_time_bounds: { type: "boolean" },
          computed_at: { type: ["string", "null"] },
        },
        required: [
          "connector_id",
          "stream",
          "record_count",
          "record_json_bytes",
          "earliest_ingested_at",
          "latest_ingested_at",
          "earliest_record_time",
          "latest_record_time",
          "consent_time_field",
          "dirty_record_time_bounds",
          "computed_at",
        ],
      },
    },
    filters: {
      type: "object",
      additionalProperties: false,
      properties: {
        connector_id: { type: ["string", "null"] },
      },
      required: ["connector_id"],
    },
    projection: {
      type: "object",
      additionalProperties: false,
      properties: {
        computed_at: { type: ["string", "null"] },
        state: {
          enum: ["fresh", "refreshing", "stale", "rebuilding", "failed"],
        },
        stale_since: { type: ["string", "null"] },
        rebuild_status: { enum: ["idle", "running", "failed"] },
        last_error: { type: ["string", "null"] },
        source_high_watermark: { type: ["string", "null"] },
      },
      required: ["computed_at", "state", "stale_since", "rebuild_status", "last_error"],
    },
  },
  required: ["object", "streams", "filters", "projection"],
};

const RetainedSizeProjectionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    computed_at: { type: ["string", "null"] },
    dirty: { type: "boolean" },
    metadata: { type: ["object", "null"], additionalProperties: true },
  },
  required: ["computed_at", "dirty", "metadata"],
};

const RetainedSizeRowSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    grain: { type: "string" },
    connector_instance_id: { type: ["string", "null"] },
    connector_id: { type: ["string", "null"] },
    stream: { type: ["string", "null"] },
    record_family: { type: ["string", "null"] },
    current_record_json_bytes: { type: "integer", minimum: 0 },
    record_history_json_bytes: { type: "integer", minimum: 0 },
    blob_bytes: { type: "integer", minimum: 0 },
    total_retained_bytes: { type: "integer", minimum: 0 },
    record_count: { type: "integer", minimum: 0 },
    record_history_count: { type: "integer", minimum: 0 },
    blob_count: { type: "integer", minimum: 0 },
    dirty: { type: "boolean" },
    computed_at: { type: ["string", "null"] },
    metadata: { type: ["object", "null"], additionalProperties: true },
  },
  required: [
    "grain",
    "current_record_json_bytes",
    "record_history_json_bytes",
    "blob_bytes",
    "total_retained_bytes",
    "record_count",
    "record_history_count",
    "blob_count",
    "dirty",
    "computed_at",
  ],
};

const RetainedSizeTopRowSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...RetainedSizeRowSchema.properties,
    scope: { type: "string" },
    measure: { type: "string" },
    rank: { type: "integer", minimum: 1 },
    grain_key: { type: "string" },
    record_key: { type: ["string", "null"] },
    blob_id: { type: ["string", "null"] },
  },
  required: [...RetainedSizeRowSchema.required, "scope", "measure", "rank", "grain_key", "record_key", "blob_id"],
};

const RetainedSizeResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "ref_dataset_size" },
    grain: { type: "string" },
    rows: { type: "array", items: RetainedSizeRowSchema },
    projection: RetainedSizeProjectionSchema,
  },
  required: ["object", "grain", "rows", "projection"],
};

const RetainedSizeTopResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "ref_dataset_top" },
    scope: { type: "string" },
    measure: { type: "string" },
    rows: { type: "array", items: RetainedSizeTopRowSchema },
    projection: RetainedSizeProjectionSchema,
  },
  required: ["object", "scope", "measure", "rows", "projection"],
};

const RecordVersionStatsRowSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    connector_id: { type: ["string", "null"] },
    connector_instance_id: { type: "string" },
    display_name: { type: ["string", "null"] },
    stream: { type: "string" },
    current_record_count: { type: "integer", minimum: 0 },
    record_history_count: { type: "integer", minimum: 0 },
    record_key_count: { type: ["integer", "null"], minimum: 0 },
    versions_per_record: { type: "number", minimum: 0 },
    last_current_at: { type: ["string", "null"] },
    last_history_at: { type: ["string", "null"] },
    projection_dirty: { type: "boolean" },
    projection_missing: { type: "boolean" },
    projection_authority: { type: "string", enum: ["record_changes_ground_truth", "retained_size_projection"] },
    risk_level: { type: "string", enum: ["normal", "watch", "high"] },
    risk_reasons: { type: "array", items: { type: "string" } },
  },
  required: [
    "connector_id",
    "connector_instance_id",
    "display_name",
    "stream",
    "current_record_count",
    "record_history_count",
    "record_key_count",
    "versions_per_record",
    "last_current_at",
    "last_history_at",
    "projection_dirty",
    "projection_missing",
    "projection_authority",
    "risk_level",
    "risk_reasons",
  ],
};

const RecordVersionStatsResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "ref_record_version_stats" },
    data: { type: "array", items: RecordVersionStatsRowSchema },
    meta: {
      type: "object",
      additionalProperties: false,
      properties: {
        returned: { type: "integer", minimum: 0 },
        total_matching: { type: "integer", minimum: 0 },
        has_more: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        filters: {
          type: "object",
          additionalProperties: false,
          properties: {
            connector_instance_id: { type: ["string", "null"] },
            stream: { type: ["string", "null"] },
            risk: { type: ["string", "null"], enum: ["normal", "watch", "high", null] },
          },
          required: ["connector_instance_id", "stream", "risk"],
        },
        source: { const: "retained_size_projection_with_record_changes_ground_truth" },
        risk_thresholds: {
          type: "object",
          additionalProperties: false,
          properties: {
            watch_versions_per_record: { type: "number" },
            high_versions_per_record: { type: "number" },
            high_history_count: { type: "integer" },
            high_history_versions_per_record: { type: "number" },
          },
          required: [
            "watch_versions_per_record",
            "high_versions_per_record",
            "high_history_count",
            "high_history_versions_per_record",
          ],
        },
      },
      required: ["returned", "total_matching", "has_more", "limit", "filters", "source", "risk_thresholds"],
    },
    projection: RetainedSizeProjectionSchema,
  },
  required: ["object", "data", "meta", "projection"],
};

const TimelineEntrySchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    object: { const: "timeline_entry" },
    connector_id: { type: "string" },
    stream: { type: "string" },
    id: { type: "string" },
    emitted_at: { type: "string" },
    version: { type: ["integer", "string", "null"] },
    data: { type: ["object", "null"] },
    semantic_timestamp: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        field: { type: "string" },
        value: { type: "string" },
      },
      required: ["field", "value"],
    },
    display_timestamp: { type: "string" },
  },
  required: [
    "object",
    "connector_id",
    "stream",
    "id",
    "emitted_at",
    "version",
    "data",
    "semantic_timestamp",
    "display_timestamp",
  ],
};

const CommonErrors = {
  400: { schema: ErrorObjectSchema, description: "Invalid request" },
  404: { schema: ErrorObjectSchema, description: "Not found" },
  409: { schema: ErrorObjectSchema, description: "Conflict (e.g. run_already_active)" },
};

const DeviceExporterErrors = {
  ...CommonErrors,
  401: { schema: ErrorObjectSchema, description: "Authentication required" },
  403: { schema: ErrorObjectSchema, description: "Permission denied" },
};

const ConnectorIdParamSchema = {
  type: "object",
  additionalProperties: false,
  properties: { connectorId: { type: "string", minLength: 1 } },
  required: ["connectorId"],
};

const DeviceIdParamSchema = {
  type: "object",
  additionalProperties: false,
  properties: { deviceId: { type: "string", minLength: 1 } },
  required: ["deviceId"],
};

const DeviceSourceInstanceSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    object: { const: "device_source_instance" },
    source_instance_id: { type: "string" },
    connector_instance_id: { type: ["string", "null"] },
    device_id: { type: "string" },
    connector_id: { type: "string" },
    local_binding_name: { type: "string" },
    display_name: { type: ["string", "null"] },
    created_at: { type: "string" },
    last_ingest_at: { type: ["string", "null"] },
    accepted_record_count: { type: "integer", minimum: 0 },
    rejected_record_count: { type: "integer", minimum: 0 },
    last_error: { type: ["object", "null"], additionalProperties: true },
  },
  required: ["object", "source_instance_id", "device_id", "connector_id", "local_binding_name", "created_at"],
};

const DeviceExporterSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    object: { const: "device_exporter" },
    device_id: { type: "string" },
    subject_id: { type: "string" },
    display_name: { type: ["string", "null"] },
    status: { type: "string", enum: ["active", "revoked"] },
    created_at: { type: "string" },
    last_heartbeat_at: { type: ["string", "null"] },
    last_ingest_at: { type: ["string", "null"] },
    revoked_at: { type: ["string", "null"] },
    stale: { type: "boolean" },
    source_instances: { type: "array", items: DeviceSourceInstanceSchema },
    last_error: { type: ["object", "null"], additionalProperties: true },
  },
  required: ["object", "device_id", "subject_id", "status", "created_at", "stale", "source_instances"],
};

const DeviceEnrollmentCodeCreateBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    connector_id: { type: "string", minLength: 1 },
    local_binding_name: { type: "string", minLength: 1 },
    display_name: { type: "string" },
    expires_in_seconds: { type: "integer", minimum: 60, maximum: 86_400 },
  },
  required: ["connector_id", "local_binding_name"],
};

const DeviceEnrollmentCodeResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "device_exporter_enrollment_code" },
    enrollment_code: { type: "string" },
    expires_at: { type: "string" },
    connector_id: { type: "string" },
    local_binding_name: { type: "string" },
  },
  required: ["object", "enrollment_code", "expires_at", "connector_id", "local_binding_name"],
};

const DeviceEnrollmentExchangeBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enrollment_code: { type: "string", minLength: 1 },
    agent_version: { type: "string" },
  },
  required: ["enrollment_code"],
};

const DeviceEnrollmentExchangeResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "device_exporter_enrollment" },
    device_id: { type: "string" },
    connector_instance_id: { type: "string" },
    source_instance_id: { type: "string" },
    device_token: { type: "string" },
    connector_id: { type: "string" },
    local_binding_name: { type: "string" },
  },
  required: [
    "object",
    "device_id",
    "connector_instance_id",
    "source_instance_id",
    "device_token",
    "connector_id",
    "local_binding_name",
  ],
};

const DeviceHeartbeatBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    agent_version: { type: "string" },
    connector_id: { type: "string" },
    source_instance_id: { type: "string" },
    status: { type: "string", enum: ["starting", "healthy", "retrying", "blocked", "stopped"] },
    records_pending: { type: "integer", minimum: 0 },
    source_instances: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          source_instance_id: { type: "string" },
          last_error: { type: ["object", "null"], additionalProperties: true },
        },
        required: ["source_instance_id"],
      },
    },
    last_error: { type: ["object", "null"], additionalProperties: true },
  },
};

const DeviceHeartbeatResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "device_exporter_heartbeat" },
    device_id: { type: "string" },
    received_at: { type: "string" },
    status: { type: "string", enum: ["accepted"] },
  },
  required: ["object", "device_id", "received_at", "status"],
};

const DeviceIngestBatchBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    device_id: { type: "string" },
    source_instance_id: { type: "string" },
    batch_id: { type: "string" },
    batch_seq: { type: "integer", minimum: 0 },
    body_hash: { type: "string" },
    connector_id: { type: "string" },
    records: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          stream: { type: "string" },
          record_key: { type: ["string", "array"] },
          emitted_at: { type: "string" },
          data: { type: "object", additionalProperties: true },
        },
        required: ["stream", "record_key", "data"],
      },
    },
  },
  required: ["device_id", "source_instance_id", "batch_id", "batch_seq", "body_hash", "connector_id", "records"],
};

const DeviceIngestBatchResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "device_ingest_batch_result" },
    device_id: { type: "string" },
    connector_instance_id: { type: "string" },
    source_instance_id: { type: "string" },
    batch_id: { type: "string" },
    body_hash: { type: "string" },
    status: { type: "string", enum: ["accepted", "replayed", "rejected"] },
    accepted_record_count: { type: "integer", minimum: 0 },
    rejected_record_count: { type: "integer", minimum: 0 },
  },
  required: [
    "object",
    "device_id",
    "connector_instance_id",
    "source_instance_id",
    "batch_id",
    "body_hash",
    "status",
    "accepted_record_count",
    "rejected_record_count",
  ],
};

const DeviceSourceInstanceStateParamSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    deviceId: { type: "string", minLength: 1 },
    sourceInstanceId: { type: "string", minLength: 1 },
  },
  required: ["deviceId", "sourceInstanceId"],
};

const DeviceSourceInstanceStatePutBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    state: { type: "object", additionalProperties: true },
  },
  required: ["state"],
};

const DeviceSourceInstanceStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "device_source_instance_state" },
    device_id: { type: "string" },
    connector_instance_id: { type: "string" },
    source_instance_id: { type: "string" },
    state: { type: "object", additionalProperties: true },
    updated_at: { type: ["string", "null"] },
  },
  required: ["object", "device_id", "connector_instance_id", "source_instance_id", "state", "updated_at"],
};

// Operator oversight for client event subscriptions. These /_ref routes never
// return the subscription's signing secret. See:
//   openspec/specs/reference-implementation-architecture/spec.md
//   openspec/changes/archive/2026-05-28-add-client-event-subscription-management
const EventSubscriptionStatusSchema = {
  type: "string",
  enum: ["pending_verification", "active", "disabled", "disabled_failure", "disabled_revoked", "deleted"],
};

const EventSubscriptionScopeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    streams: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1 },
          connection_id: { type: "string" },
        },
        required: ["name"],
      },
    },
    filters: {
      type: "object",
      additionalProperties: false,
      properties: {
        streams: { type: "array", items: { type: "string", minLength: 1 } },
      },
    },
  },
  required: ["streams"],
};

const RefEventSubscriptionDeliveryFields = {
  pending_queue_count: { type: "integer", minimum: 0 },
  final_failure_count: { type: "integer", minimum: 0 },
  last_attempted_at: { type: ["string", "null"], format: "date-time" },
  last_attempt_ok: { type: ["boolean", "null"] },
  last_attempt_status_code: { type: ["integer", "null"] },
};

const RefEventSubscriptionListItemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    subscription_id: { type: "string", minLength: 1 },
    client_id: { type: "string", minLength: 1 },
    grant_id: { type: "string", minLength: 1 },
    status: EventSubscriptionStatusSchema,
    disabled_reason: { type: ["string", "null"] },
    callback_host: { type: "string", minLength: 1 },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
    disabled_at: { type: ["string", "null"], format: "date-time" },
    ...RefEventSubscriptionDeliveryFields,
  },
  required: [
    "subscription_id",
    "client_id",
    "grant_id",
    "status",
    "disabled_reason",
    "callback_host",
    "created_at",
    "updated_at",
    "disabled_at",
    "pending_queue_count",
    "final_failure_count",
    "last_attempted_at",
    "last_attempt_ok",
    "last_attempt_status_code",
  ],
};

const RefEventSubscriptionListResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "list" },
    data: { type: "array", items: RefEventSubscriptionListItemSchema },
  },
  required: ["object", "data"],
};

const RefEventSubscriptionAttemptSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    attempt_id: { type: "integer" },
    queue_id: { type: "integer" },
    event_id: { type: "string", minLength: 1 },
    event_type: { type: "string", minLength: 1 },
    attempted_at: { type: "string", format: "date-time" },
    status_code: { type: ["integer", "null"] },
    ok: { type: "boolean" },
    latency_ms: { type: ["integer", "null"] },
    error: { type: ["string", "null"] },
    response_snippet: { type: ["string", "null"] },
  },
  required: ["attempt_id", "queue_id", "event_id", "event_type", "attempted_at", "ok"],
};

const RefEventSubscriptionDetailSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    subscription_id: { type: "string", minLength: 1 },
    client_id: { type: "string", minLength: 1 },
    grant_id: { type: "string", minLength: 1 },
    subject_id: { type: "string", minLength: 1 },
    status: EventSubscriptionStatusSchema,
    disabled_reason: { type: ["string", "null"] },
    callback_url: { type: "string", format: "uri" },
    callback_host: { type: "string", minLength: 1 },
    scope: EventSubscriptionScopeSchema,
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
    disabled_at: { type: ["string", "null"], format: "date-time" },
    ...RefEventSubscriptionDeliveryFields,
    recent_attempts: { type: "array", items: RefEventSubscriptionAttemptSchema },
  },
  required: [
    "subscription_id",
    "client_id",
    "grant_id",
    "subject_id",
    "status",
    "disabled_reason",
    "callback_url",
    "callback_host",
    "scope",
    "created_at",
    "updated_at",
    "disabled_at",
    "pending_queue_count",
    "final_failure_count",
    "last_attempted_at",
    "last_attempt_ok",
    "last_attempt_status_code",
    "recent_attempts",
  ],
};

const EventSubscriptionIdParamSchema = {
  type: "object",
  additionalProperties: false,
  properties: { subscription_id: { type: "string", minLength: 1 } },
  required: ["subscription_id"],
};

export const referenceManifests = [
  {
    id: "refSearch",
    method: "GET",
    path: "/_ref/search",
    surface: "reference",
    tags: ["reference", "search"],
    summary: "Search exact trace/grant/run ids and record content across retained records.",
    request: {
      query: {
        type: "object",
        additionalProperties: false,
        properties: {
          q: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
          cursor: { type: "string" },
          connector_id: { type: "string" },
          stream: { type: "string" },
          order: { type: "string", enum: ["asc", "desc"] },
          sort: { type: "string", enum: ["native", "ingested"] },
        },
      },
    },
    responses: {
      200: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            object: { const: "search_result" },
            exact: { type: ["object", "null"] },
            traces: { type: "array", items: { type: "object" } },
            grants: { type: "array", items: { type: "object" } },
            runs: { type: "array", items: { type: "object" } },
            records: { type: "array", items: RefSearchRecordSchema },
            record_page: RecordPageSchema,
          },
          required: ["object", "exact", "traces", "grants", "runs", "records", "record_page"],
        },
      },
      ...CommonErrors,
    },
  },
  {
    id: "refListConnectors",
    method: "GET",
    path: "/_ref/connectors",
    surface: "reference",
    tags: ["reference", "connectors"],
    summary: "List configured connection summaries with manifest, latest run, schedule, and freshness.",
    responses: { 200: { schema: ConnectorListResponseSchema }, ...CommonErrors },
  },
  {
    id: "refGetConnector",
    method: "GET",
    path: "/_ref/connectors/{connectorId}",
    surface: "reference",
    tags: ["reference", "connectors"],
    summary: "Get a single connector with manifest excerpt, schedule, recent runs, and stream summaries.",
    request: { params: ConnectorIdParamSchema },
    responses: { 200: { schema: ConnectorSummarySchema }, ...CommonErrors },
  },
  {
    id: "refListConnections",
    method: "GET",
    path: "/_ref/connections",
    surface: "reference",
    tags: ["reference", "connections"],
    summary:
      "List owner-facing configured connector connections with labels, lifecycle status, binding metadata, and schedules.",
    request: { query: ConnectionQuerySchema },
    responses: { 200: { schema: ConnectionListResponseSchema }, ...CommonErrors },
  },
  {
    id: "refListConnectorInstances",
    method: "GET",
    path: "/_ref/connector-instances",
    surface: "reference",
    tags: ["reference", "connections"],
    summary: "Compatibility alias for listing configured connector instances behind owner-facing connections.",
    request: { query: ConnectionQuerySchema },
    responses: { 200: { schema: ConnectionListResponseSchema }, ...CommonErrors },
  },
  {
    id: "ownerListConnections",
    method: "GET",
    path: "/v1/owner/connections",
    surface: "reference",
    tags: ["reference", "connections", "owner-agent"],
    summary:
      "Owner-agent bearer listing of configured connections with connection_id, connector_key, owner-meaningful display_name, label status, lifecycle fields, and schedules.",
    request: { query: ConnectionQuerySchema },
    responses: { 200: { schema: OwnerConnectionListResponseSchema }, ...CommonErrors },
  },
  {
    id: "ownerListConnectorTemplates",
    method: "GET",
    path: "/v1/owner/connector-templates",
    surface: "reference",
    tags: ["reference", "connections", "owner-agent"],
    summary:
      "Owner-agent bearer listing of connector templates separated from configured connection instances. Embeds related connection summaries and template-level supported_actions for adding new connections as typed intents.",
    responses: { 200: { schema: OwnerConnectorTemplateListResponseSchema }, ...CommonErrors },
  },
  {
    id: "ownerControlCapabilities",
    method: "GET",
    path: "/v1/owner/control",
    surface: "reference",
    tags: ["reference", "owner-agent"],
    summary:
      "Owner-agent bearer control entrypoint: capability document naming supported, owner-mediated, and unsupported owner-agent control action families with links to supported routes.",
    responses: { 200: { schema: OwnerControlSurfaceResponseSchema }, ...CommonErrors },
  },
  {
    id: "ownerSetConnectionDisplayName",
    method: "PATCH",
    path: "/v1/owner/connections/{connectionId}",
    surface: "reference",
    tags: ["reference", "connections", "owner-agent"],
    summary:
      "Owner-agent bearer rename of the owner-meaningful `display_name` on a connection, addressed by `connection_id`. Owner bearers only; client/mcp_package grants SHALL NOT reach this route. Shares the connector-instance store rename semantics with the cookie-authed `/_ref` PATCH; on success the returned row reports label_status owner_set.",
    request: {
      params: ConnectionIdParamSchema,
      body: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            display_name: { type: "string", minLength: 1, maxLength: 200 },
          },
          required: ["display_name"],
        },
      },
    },
    responses: { 200: { schema: OwnerConnectionSchema }, ...CommonErrors },
  },
  {
    id: "ownerCreateConnectionIntent",
    method: "POST",
    path: "/v1/owner/connections/intents",
    surface: "reference",
    tags: ["reference", "connections", "owner-agent"],
    summary:
      "Owner-agent bearer: initiate a new connection as a typed, auditable, owner-mediated intent. Returns a typed `next_step` (`enroll_local_collector` for proven local-collector connectors; `unsupported` with a reason for browser-bound, API/network-only, and unknown connectors) and never marks a connection active. Owner bearers only; client/mcp_package grants SHALL NOT reach this route.",
    request: { body: { schema: OwnerConnectionIntentRequestSchema } },
    responses: { 201: { schema: OwnerConnectionIntentResponseSchema }, ...CommonErrors },
  },
  {
    id: "ownerPauseConnectionSchedule",
    method: "POST",
    path: "/v1/owner/connections/{connectionId}/schedule/pause",
    surface: "reference",
    tags: ["reference", "runs", "connections", "owner-agent"],
    summary:
      "Owner-agent bearer: pause one configured connection's schedule, addressed by `connection_id`, without deleting its config. Owner bearers only; client/mcp_package grants SHALL NOT reach this route. Shares the controller `setScheduleEnabled` semantics with the cookie-authed `/_ref` pause route under a separate owner-bearer auth adapter.",
    request: { params: ConnectionIdParamSchema },
    responses: { 200: { description: "Paused" }, ...CommonErrors },
  },
  {
    id: "ownerResumeConnectionSchedule",
    method: "POST",
    path: "/v1/owner/connections/{connectionId}/schedule/resume",
    surface: "reference",
    tags: ["reference", "runs", "connections", "owner-agent"],
    summary:
      "Owner-agent bearer: resume one paused configured connection's schedule, addressed by `connection_id`. Owner bearers only; client/mcp_package grants SHALL NOT reach this route. Shares the controller `setScheduleEnabled` semantics with the cookie-authed `/_ref` resume route under a separate owner-bearer auth adapter.",
    request: { params: ConnectionIdParamSchema },
    responses: { 200: { description: "Resumed" }, ...CommonErrors },
  },
  {
    id: "ownerPauseConnectorSchedule",
    method: "POST",
    path: "/v1/owner/connectors/{connectorId}/schedule/pause",
    surface: "reference",
    tags: ["reference", "runs", "owner-agent"],
    summary:
      "Owner-agent bearer: pause a connector's schedule addressed by `connector_id`. Auto-selects the only active connection for that connector. When more than one active connection exists the request is rejected with a typed `ambiguous_connection` (409) carrying the available `connection_id` values and `retry_with: connection_id`. Owner bearers only; client/mcp_package grants SHALL NOT reach this route.",
    request: { params: ConnectorIdParamSchema },
    responses: { 200: { description: "Paused" }, ...CommonErrors },
  },
  {
    id: "ownerResumeConnectorSchedule",
    method: "POST",
    path: "/v1/owner/connectors/{connectorId}/schedule/resume",
    surface: "reference",
    tags: ["reference", "runs", "owner-agent"],
    summary:
      "Owner-agent bearer: resume a connector's paused schedule addressed by `connector_id`. Auto-selects the only active connection for that connector. When more than one active connection exists the request is rejected with a typed `ambiguous_connection` (409) carrying the available `connection_id` values and `retry_with: connection_id`. Owner bearers only; client/mcp_package grants SHALL NOT reach this route.",
    request: { params: ConnectorIdParamSchema },
    responses: { 200: { description: "Resumed" }, ...CommonErrors },
  },
  {
    id: "ownerDeleteConnectionSchedule",
    method: "DELETE",
    path: "/v1/owner/connections/{connectionId}/schedule",
    surface: "reference",
    tags: ["reference", "runs", "connections", "owner-agent"],
    summary:
      "Owner-agent bearer: delete one configured connection's schedule config, addressed by `connection_id`. Returns 204 when the schedule was deleted and a typed 404 when no schedule existed. Owner bearers only; client/mcp_package grants SHALL NOT reach this route. Shares the controller `deleteSchedule` semantics with the cookie-authed `/_ref` delete route under a separate owner-bearer auth adapter.",
    request: { params: ConnectionIdParamSchema },
    responses: { 204: { description: "Schedule deleted" }, ...CommonErrors },
  },
  {
    id: "ownerDeleteConnectorSchedule",
    method: "DELETE",
    path: "/v1/owner/connectors/{connectorId}/schedule",
    surface: "reference",
    tags: ["reference", "runs", "owner-agent"],
    summary:
      "Owner-agent bearer: delete a connector's schedule config addressed by `connector_id`. Auto-selects the only active connection for that connector. When more than one active connection exists the request is rejected with a typed `ambiguous_connection` (409) carrying the available `connection_id` values and `retry_with: connection_id`. Returns 204 on delete and a typed 404 when no schedule existed. Owner bearers only; client/mcp_package grants SHALL NOT reach this route.",
    request: { params: ConnectorIdParamSchema },
    responses: { 204: { description: "Schedule deleted" }, ...CommonErrors },
  },
  {
    id: "ownerRunConnection",
    method: "POST",
    path: "/v1/owner/connections/{connectionId}/run",
    surface: "reference",
    tags: ["reference", "runs", "connections", "owner-agent"],
    summary:
      "Owner-agent bearer: start a run-now for one configured connection, addressed by `connection_id`. Returns 202 with run_id + trace_id, or 409 run_already_active. Owner bearers only; client/mcp_package grants SHALL NOT reach this route. Shares the controller `runNow` semantics with the cookie-authed `/_ref` run route under a separate owner-bearer auth adapter.",
    request: { params: ConnectionIdParamSchema },
    responses: {
      202: { schema: RunStartResponseSchema, description: "Accepted" },
      ...CommonErrors,
    },
  },
  {
    id: "ownerRunConnector",
    method: "POST",
    path: "/v1/owner/connectors/{connectorId}/run",
    surface: "reference",
    tags: ["reference", "runs", "owner-agent"],
    summary:
      "Owner-agent bearer: start a run-now for a connector addressed by `connector_id`. Auto-selects the only active connection for that connector. When more than one active connection exists the request is rejected with a typed `ambiguous_connection` (409) carrying the available `connection_id` values and `retry_with: connection_id`. Returns 202 with run_id + trace_id, or 409 run_already_active. Owner bearers only; client/mcp_package grants SHALL NOT reach this route.",
    request: { params: ConnectorIdParamSchema },
    responses: {
      202: { schema: RunStartResponseSchema, description: "Accepted" },
      ...CommonErrors,
    },
  },
  {
    id: "ownerRevokeConnection",
    method: "POST",
    path: "/v1/owner/connections/{connectionId}/revoke",
    surface: "reference",
    tags: ["reference", "connections", "owner-agent"],
    summary:
      "Owner-agent bearer: revoke one configured connection, addressed by `connection_id`. Flips the connection to status `revoked` so no future run/ingest lands; already-collected records, spine evidence, device rows, and sibling connections are untouched (zero cascade), and the revoke is durable across owner reads and grant/polyfill scope resolution. A double-revoke returns a typed `connector_instance_inactive` (400). Owner bearers only; client/mcp_package grants SHALL NOT reach this route. `/mcp` owner-bearer rejection is untouched.",
    request: { params: ConnectionIdParamSchema },
    responses: {
      200: { schema: OwnerConnectionRevokeSchema, description: "Revoked" },
      ...CommonErrors,
    },
  },
  {
    id: "ownerRevokeConnector",
    method: "POST",
    path: "/v1/owner/connectors/{connectorId}/revoke",
    surface: "reference",
    tags: ["reference", "owner-agent"],
    summary:
      "Owner-agent bearer: revoke a connector's connection addressed by `connector_id`. Auto-selects the only active connection for that connector. When more than one active connection exists the request is rejected with a typed `ambiguous_connection` (409) carrying the available `connection_id` values and `retry_with: connection_id`. Flips the resolved connection to status `revoked` (zero cascade, durable). Owner bearers only; client/mcp_package grants SHALL NOT reach this route.",
    request: { params: ConnectorIdParamSchema },
    responses: {
      200: { schema: OwnerConnectionRevokeSchema, description: "Revoked" },
      ...CommonErrors,
    },
  },
  {
    id: "ownerDeleteConnection",
    method: "DELETE",
    path: "/v1/owner/connections/{connectionId}",
    surface: "reference",
    tags: ["reference", "connections", "owner-agent"],
    summary:
      "Owner-agent bearer: DESTRUCTIVELY delete one configured connection, addressed by `connection_id`. Erases that connection's records, record-change history, version counters, blobs, blob bindings, search indices, and attention records, deletes its schedule, clears its device source-instance back-reference, and removes the connector_instances row — all keyed strictly on one connection_id, never widening to connector_id (sibling connections of the same connector type are untouched). It does NOT erase a running collection: a connection with an in-flight run is REFUSED, not deleted (no active-run row is erased while running). The source-of-truth deletion (records, history, version counters, blobs, blob bindings, attention, schedule, device back-ref, and the connector_instances row) is transactional all-or-nothing across one connector_instance_id; the search-index teardown is a rebuildable projection cleaned up after that commit. PRESERVES the audit spine (appending an owner_agent.connection.delete event), disclosure grants, and the device edge. Delete is NOT revoke: it erases the past and removes the configuration, where revoke only stops the future. A repeat/unknown/foreign-owner id returns a typed `connector_instance_not_found` (404) without leaking existence. An in-flight run returns `connection_run_active` (409). A default-account binding returns `default_account_delete_unsupported` (409) — revoke it instead. Owner bearers only; client/mcp_package grants SHALL NOT reach this route. `/mcp` owner-bearer rejection is untouched.",
    request: { params: ConnectionIdParamSchema },
    responses: {
      200: { schema: OwnerConnectionDeleteSchema, description: "Deleted" },
      ...CommonErrors,
    },
  },
  {
    id: "ownerDeleteConnector",
    method: "DELETE",
    path: "/v1/owner/connectors/{connectorId}",
    surface: "reference",
    tags: ["reference", "owner-agent"],
    summary:
      "Owner-agent bearer: DESTRUCTIVELY delete a connector's connection addressed by `connector_id`. Auto-selects the only active connection for that connector. When more than one active connection exists the request is rejected with a typed `ambiguous_connection` (409) carrying the available `connection_id` values and `retry_with: connection_id`. Erases the resolved connection's data + configuration per the connection-scoped cascade (see ownerDeleteConnection). Owner bearers only; client/mcp_package grants SHALL NOT reach this route.",
    request: { params: ConnectorIdParamSchema },
    responses: {
      200: { schema: OwnerConnectionDeleteSchema, description: "Deleted" },
      ...CommonErrors,
    },
  },
  {
    id: "ownerInspectConnectionDiagnostics",
    method: "GET",
    path: "/v1/owner/connections/{connectionId}/diagnostics",
    surface: "reference",
    tags: ["reference", "connections", "owner-agent"],
    summary:
      "Owner-agent bearer: read connection-scoped diagnostics for one configured connection, addressed by `connection_id` — last run status, last successful run, last successful ingest time, current schedule state, freshness, and a typed health classification. Connection-scoped by construction: the response describes only the addressed connection and carries no device-exporter subsystem or sibling-connection state. Owner bearers only; client/mcp_package grants SHALL NOT reach this route.",
    request: { params: ConnectionIdParamSchema },
    responses: { 200: { schema: OwnerConnectionDiagnosticsSchema }, ...CommonErrors },
  },
  {
    id: "ownerInspectConnectorDiagnostics",
    method: "GET",
    path: "/v1/owner/connectors/{connectorId}/diagnostics",
    surface: "reference",
    tags: ["reference", "connections", "owner-agent"],
    summary:
      "Owner-agent bearer: read connection-scoped diagnostics for a connector addressed by `connector_id`. Auto-selects the only active connection for that connector. When more than one active connection exists the request is rejected with a typed `ambiguous_connection` (409) carrying the available `connection_id` values and `retry_with: connection_id`. Owner bearers only; client/mcp_package grants SHALL NOT reach this route.",
    request: { params: ConnectorIdParamSchema },
    responses: { 200: { schema: OwnerConnectionDiagnosticsSchema }, ...CommonErrors },
  },
  {
    id: "refGetConnection",
    method: "GET",
    path: "/_ref/connections/{connectorInstanceId}",
    surface: "reference",
    tags: ["reference", "connections"],
    summary: "Get one owner-facing configured connector connection by connector instance id.",
    request: { params: ConnectorInstanceIdParamSchema },
    responses: { 200: { schema: RefConnectionSchema }, ...CommonErrors },
  },
  {
    id: "refGetConnectorInstance",
    method: "GET",
    path: "/_ref/connector-instances/{connectorInstanceId}",
    surface: "reference",
    tags: ["reference", "connections"],
    summary: "Compatibility alias for reading one configured connector instance behind an owner-facing connection.",
    request: { params: ConnectorInstanceIdParamSchema },
    responses: { 200: { schema: RefConnectionSchema }, ...CommonErrors },
  },
  {
    id: "refSetConnectionDisplayName",
    method: "PATCH",
    path: "/_ref/connections/{connectorInstanceId}",
    surface: "reference",
    tags: ["reference", "connections"],
    summary:
      "Owner-authenticated mutation of the owner-meaningful `display_name` carried on the public read contract. Operator-only surface; grant-authorized tokens SHALL NOT reach this route.",
    request: {
      params: ConnectorInstanceIdParamSchema,
      body: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            display_name: { type: "string", minLength: 1, maxLength: 200 },
          },
          required: ["display_name"],
        },
      },
    },
    responses: { 200: { schema: RefConnectionSchema }, ...CommonErrors },
  },
  {
    id: "refListApprovals",
    method: "GET",
    path: "/_ref/approvals",
    surface: "reference",
    tags: ["reference", "grants"],
    summary: "List pending approvals across provider-connect consents and owner-device flows.",
    responses: {
      200: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            object: { const: "list" },
            data: { type: "array", items: ApprovalItemSchema },
          },
          required: ["object", "data"],
        },
      },
      ...CommonErrors,
    },
  },
  {
    id: "refCreateDeviceExporterEnrollmentCode",
    method: "POST",
    path: "/_ref/device-exporters/enrollment-codes",
    surface: "reference",
    tags: ["reference", "device-exporters"],
    summary: "Create a short-lived local device exporter enrollment code for an owner-approved connector binding.",
    request: { body: { schema: DeviceEnrollmentCodeCreateBodySchema } },
    responses: { 201: { schema: DeviceEnrollmentCodeResponseSchema, description: "Created" }, ...DeviceExporterErrors },
  },
  {
    id: "refExchangeDeviceExporterEnrollmentCode",
    method: "POST",
    path: "/_ref/device-exporters/enroll",
    surface: "reference",
    tags: ["reference", "device-exporters"],
    summary: "Exchange a one-time enrollment code for a device-scoped local exporter credential.",
    request: { body: { schema: DeviceEnrollmentExchangeBodySchema } },
    responses: {
      201: { schema: DeviceEnrollmentExchangeResponseSchema, description: "Created" },
      ...DeviceExporterErrors,
    },
  },
  {
    id: "refListDeviceExporters",
    method: "GET",
    path: "/_ref/device-exporters",
    surface: "reference",
    tags: ["reference", "device-exporters"],
    summary: "List enrolled local device exporters and their source-instance diagnostics.",
    responses: {
      200: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            object: { const: "list" },
            data: { type: "array", items: DeviceExporterSchema },
          },
          required: ["object", "data"],
        },
      },
      ...DeviceExporterErrors,
    },
  },
  {
    id: "refListDeviceExporterSourceInstances",
    method: "GET",
    path: "/_ref/device-exporters/source-instances",
    surface: "reference",
    tags: ["reference", "device-exporters"],
    summary:
      "List local device exporter source instances without promoting source-instance identity to the public PDPP contract.",
    request: {
      query: {
        type: "object",
        additionalProperties: false,
        properties: { device_id: { type: "string" } },
      },
    },
    responses: {
      200: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            object: { const: "list" },
            data: { type: "array", items: DeviceSourceInstanceSchema },
          },
          required: ["object", "data"],
        },
      },
      ...DeviceExporterErrors,
    },
  },
  {
    id: "refListDeviceExporterDiagnostics",
    method: "GET",
    path: "/_ref/device-exporters/diagnostics",
    surface: "reference",
    tags: ["reference", "device-exporters"],
    summary: "List owner/operator diagnostics for local device exporters, including heartbeat and ingest freshness.",
    responses: {
      200: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            object: { const: "list" },
            data: { type: "array", items: DeviceExporterSchema },
          },
          required: ["object", "data"],
        },
      },
      ...DeviceExporterErrors,
    },
  },
  {
    id: "refRevokeDeviceExporter",
    method: "POST",
    path: "/_ref/device-exporters/{deviceId}/revoke",
    surface: "reference",
    tags: ["reference", "device-exporters"],
    summary: "Revoke a local device exporter credential and stop future heartbeats or ingest from that device.",
    request: { params: DeviceIdParamSchema },
    responses: {
      200: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            object: { const: "device_exporter_revocation" },
            device_id: { type: "string" },
            revoked_at: { type: "string" },
          },
          required: ["object", "device_id", "revoked_at"],
        },
      },
      ...DeviceExporterErrors,
    },
  },
  {
    id: "refHeartbeatDeviceExporter",
    method: "POST",
    path: "/_ref/device-exporters/{deviceId}/heartbeat",
    surface: "reference",
    tags: ["reference", "device-exporters"],
    summary: "Accept a heartbeat from a device-scoped local exporter credential.",
    request: { params: DeviceIdParamSchema, body: { schema: DeviceHeartbeatBodySchema } },
    responses: { 200: { schema: DeviceHeartbeatResponseSchema }, ...DeviceExporterErrors },
  },
  {
    id: "refIngestDeviceExporterBatch",
    method: "POST",
    path: "/_ref/device-exporters/{deviceId}/ingest-batches",
    surface: "reference",
    tags: ["reference", "device-exporters"],
    summary: "Accept an idempotent source-instance-aware ingest batch from a local device exporter.",
    request: { params: DeviceIdParamSchema, body: { schema: DeviceIngestBatchBodySchema } },
    responses: {
      200: { schema: DeviceIngestBatchResponseSchema },
      201: { schema: DeviceIngestBatchResponseSchema, description: "Created" },
      ...DeviceExporterErrors,
    },
  },
  {
    id: "refGetDeviceExporterSourceInstanceState",
    method: "GET",
    path: "/_ref/device-exporters/{deviceId}/source-instances/{sourceInstanceId}/state",
    surface: "reference",
    tags: ["reference", "device-exporters"],
    summary:
      "Read device-scoped local collector state for a source instance. Owner-token and client-token routes do not accept device credentials and vice versa.",
    request: { params: DeviceSourceInstanceStateParamSchema },
    responses: {
      200: { schema: DeviceSourceInstanceStateResponseSchema },
      ...DeviceExporterErrors,
    },
  },
  {
    id: "refPutDeviceExporterSourceInstanceState",
    method: "PUT",
    path: "/_ref/device-exporters/{deviceId}/source-instances/{sourceInstanceId}/state",
    surface: "reference",
    tags: ["reference", "device-exporters"],
    summary:
      "Persist device-scoped local collector state for a source instance. State is a stream-keyed map; existing streams are merged with last-write-wins semantics.",
    request: {
      params: DeviceSourceInstanceStateParamSchema,
      body: { schema: DeviceSourceInstanceStatePutBodySchema },
    },
    responses: {
      200: { schema: DeviceSourceInstanceStateResponseSchema },
      ...DeviceExporterErrors,
    },
  },
  {
    id: "refListSchedules",
    method: "GET",
    path: "/_ref/schedules",
    surface: "reference",
    tags: ["reference", "runs"],
    summary: "List all configured schedules with runtime status.",
    responses: { 200: { description: "Schedule list" }, ...CommonErrors },
  },
  {
    id: "refRunConnector",
    method: "POST",
    path: "/_ref/connectors/{connectorId}/run",
    surface: "reference",
    tags: ["reference", "runs"],
    summary: "Start a connector run asynchronously. Returns 202 with run_id + trace_id, or 409 run_already_active.",
    request: { params: ConnectorIdParamSchema },
    responses: {
      202: { schema: RunStartResponseSchema, description: "Accepted" },
      ...CommonErrors,
    },
  },
  {
    id: "refRunConnection",
    method: "POST",
    path: "/_ref/connections/{connectorInstanceId}/run",
    surface: "reference",
    tags: ["reference", "runs", "connections"],
    summary:
      "Start a connector run for one configured connection. Returns 202 with run_id + trace_id, or 409 run_already_active.",
    request: { params: ConnectorInstanceIdParamSchema },
    responses: {
      202: { schema: RunStartResponseSchema, description: "Accepted" },
      ...CommonErrors,
    },
  },
  {
    id: "refPutConnectorSchedule",
    method: "PUT",
    path: "/_ref/connectors/{connectorId}/schedule",
    surface: "reference",
    tags: ["reference", "runs"],
    summary: "Create or replace the single schedule for a connector.",
    request: {
      params: ConnectorIdParamSchema,
      body: { contentType: "application/json", schema: ScheduleUpsertBodySchema },
    },
    responses: { 200: { description: "Schedule upserted" }, ...CommonErrors },
  },
  {
    id: "refPutConnectionSchedule",
    method: "PUT",
    path: "/_ref/connections/{connectorInstanceId}/schedule",
    surface: "reference",
    tags: ["reference", "runs", "connections"],
    summary: "Create or replace the schedule for one configured connection.",
    request: {
      params: ConnectorInstanceIdParamSchema,
      body: { contentType: "application/json", schema: ScheduleUpsertBodySchema },
    },
    responses: { 200: { description: "Schedule upserted" }, ...CommonErrors },
  },
  {
    id: "refPauseConnectorSchedule",
    method: "POST",
    path: "/_ref/connectors/{connectorId}/schedule/pause",
    surface: "reference",
    tags: ["reference", "runs"],
    summary: "Pause the connector schedule without deleting its config.",
    request: { params: ConnectorIdParamSchema },
    responses: { 200: { description: "Paused" }, ...CommonErrors },
  },
  {
    id: "refPauseConnectionSchedule",
    method: "POST",
    path: "/_ref/connections/{connectorInstanceId}/schedule/pause",
    surface: "reference",
    tags: ["reference", "runs", "connections"],
    summary: "Pause one configured connection schedule without deleting its config.",
    request: { params: ConnectorInstanceIdParamSchema },
    responses: { 200: { description: "Paused" }, ...CommonErrors },
  },
  {
    id: "refResumeConnectorSchedule",
    method: "POST",
    path: "/_ref/connectors/{connectorId}/schedule/resume",
    surface: "reference",
    tags: ["reference", "runs"],
    summary: "Resume a paused connector schedule.",
    request: { params: ConnectorIdParamSchema },
    responses: { 200: { description: "Resumed" }, ...CommonErrors },
  },
  {
    id: "refResumeConnectionSchedule",
    method: "POST",
    path: "/_ref/connections/{connectorInstanceId}/schedule/resume",
    surface: "reference",
    tags: ["reference", "runs", "connections"],
    summary: "Resume one paused configured connection schedule.",
    request: { params: ConnectorInstanceIdParamSchema },
    responses: { 200: { description: "Resumed" }, ...CommonErrors },
  },
  {
    id: "refDeleteConnectorSchedule",
    method: "DELETE",
    path: "/_ref/connectors/{connectorId}/schedule",
    surface: "reference",
    tags: ["reference", "runs"],
    summary: "Delete the connector schedule config.",
    request: { params: ConnectorIdParamSchema },
    responses: { 204: { description: "Deleted" }, ...CommonErrors },
  },
  {
    id: "refDeleteConnectionSchedule",
    method: "DELETE",
    path: "/_ref/connections/{connectorInstanceId}/schedule",
    surface: "reference",
    tags: ["reference", "runs", "connections"],
    summary: "Delete the schedule config for one configured connection.",
    request: { params: ConnectorInstanceIdParamSchema },
    responses: { 204: { description: "Deleted" }, ...CommonErrors },
  },
  {
    id: "refRunInteraction",
    method: "POST",
    path: "/_ref/runs/{runId}/interaction",
    surface: "reference",
    tags: ["reference", "runs"],
    summary:
      "Owner-only control surface: answer the current pending interaction for an active controller-managed run. Reference-only; not part of the public PDPP API.",
    request: {
      params: {
        type: "object",
        additionalProperties: false,
        properties: { runId: { type: "string", minLength: 1 } },
        required: ["runId"],
      },
      body: {
        contentType: "application/json",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            interaction_id: { type: "string", minLength: 1 },
            status: { type: "string", enum: ["success", "cancelled"] },
            data: {
              type: "object",
              additionalProperties: true,
            },
          },
          required: ["interaction_id", "status"],
        },
      },
    },
    responses: {
      202: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            object: { const: "run_interaction_ack" },
            run_id: { type: "string" },
            interaction_id: { type: "string" },
            status: { type: "string", enum: ["success", "cancelled"] },
          },
          required: ["object", "run_id", "interaction_id", "status"],
        },
        description: "Accepted",
      },
      ...CommonErrors,
    },
  },
  {
    id: "refRecordsTimeline",
    method: "GET",
    path: "/_ref/records/timeline",
    surface: "reference",
    tags: ["reference", "records"],
    summary: "Server-backed cross-connector recent-record feed for the Records > Timeline UI.",
    request: {
      query: {
        type: "object",
        additionalProperties: false,
        properties: {
          connector_id: { type: "string" },
          stream: { type: "string" },
          since: { type: "string" },
          until: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
          order: { type: "string", enum: ["asc", "desc"] },
          timestamp_mode: { type: "string", enum: ["native", "ingest"] },
        },
      },
    },
    responses: {
      200: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            object: { const: "list" },
            data: { type: "array", items: TimelineEntrySchema },
            meta: {
              type: "object",
              additionalProperties: false,
              properties: {
                bounded: { type: "boolean" },
                ordering: { type: "string" },
                limit: { type: "integer" },
                timestamp_mode: { type: "string", enum: ["native", "ingest"] },
                filters: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    connector_id: { type: ["string", "null"] },
                    stream: { type: ["string", "null"] },
                    since: { type: ["string", "null"] },
                    until: { type: ["string", "null"] },
                  },
                  required: ["connector_id", "stream", "since", "until"],
                },
              },
              required: ["bounded", "ordering", "limit", "timestamp_mode", "filters"],
            },
          },
          required: ["object", "data", "meta"],
        },
      },
      ...CommonErrors,
    },
  },
  {
    id: "refDatasetSummary",
    method: "GET",
    path: "/_ref/dataset/summary",
    surface: "reference",
    tags: ["reference", "dataset"],
    summary:
      "Projection-backed dataset summary: record counts, retained-history bytes, timespan bounds, top connectors, and freshness metadata.",
    request: {},
    responses: {
      200: {
        schema: DatasetSummaryResponseSchema,
      },
      ...CommonErrors,
    },
  },
  {
    id: "refDatasetSummaryStreams",
    method: "GET",
    path: "/_ref/dataset/summary/streams",
    surface: "reference",
    tags: ["reference", "dataset"],
    summary:
      "Per-(connector_id, stream) rows from the dataset-summary projection. NULL/dirty time bounds pass through honestly.",
    request: {
      query: {
        type: "object",
        additionalProperties: false,
        properties: {
          connector_id: { type: "string" },
        },
      },
    },
    responses: {
      200: {
        schema: DatasetSummaryStreamsResponseSchema,
      },
      ...CommonErrors,
    },
  },
  {
    id: "refDatasetSummaryRebuild",
    method: "POST",
    path: "/_ref/dataset/summary/rebuild",
    surface: "reference",
    tags: ["reference", "dataset"],
    summary: "Owner-triggered rebuild of the projection-backed dataset summary from durable reference state.",
    request: {},
    responses: {
      200: {
        schema: DatasetSummaryResponseSchema,
      },
      ...CommonErrors,
    },
  },
  {
    id: "refDatasetSummaryReconcile",
    method: "POST",
    path: "/_ref/dataset/summary/reconcile",
    surface: "reference",
    tags: ["reference", "dataset"],
    summary: "Owner-triggered reconciliation of dirty dataset-summary record-time bounds from durable reference state.",
    request: {},
    responses: {
      200: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            object: { const: "dataset_summary_reconcile" },
            reconciled: { type: "integer", minimum: 0 },
            deferred: { type: "integer", minimum: 0 },
            summary: DatasetSummaryResponseSchema,
          },
          required: ["object", "reconciled", "deferred", "summary"],
        },
      },
      ...CommonErrors,
    },
  },
  {
    id: "refDatasetSize",
    method: "GET",
    path: "/_ref/dataset/size",
    surface: "reference",
    tags: ["reference", "dataset"],
    summary: "Projection-backed retained logical bytes by finite dataset grain.",
    request: {
      query: {
        type: "object",
        additionalProperties: false,
        properties: {
          grain: { type: "string", enum: ["global", "connection", "stream"] },
          connector_instance_id: { type: "string" },
          stream: { type: "string" },
        },
      },
    },
    responses: {
      200: { schema: RetainedSizeResponseSchema },
      ...CommonErrors,
    },
  },
  {
    id: "refDatasetTop",
    method: "GET",
    path: "/_ref/dataset/top",
    surface: "reference",
    tags: ["reference", "dataset"],
    summary: "Bounded retained-size heavy hitters for owner dataset introspection.",
    request: {
      query: {
        type: "object",
        additionalProperties: false,
        properties: {
          scope: { type: "string", enum: ["connection", "stream", "record", "blob"] },
          measure: {
            type: "string",
            enum: [
              "total_retained_bytes",
              "current_record_json_bytes",
              "record_history_json_bytes",
              "blob_bytes",
              "record_count",
              "record_history_count",
              "blob_count",
            ],
          },
          limit: { type: "integer", minimum: 1, maximum: 25 },
        },
      },
    },
    responses: {
      200: { schema: RetainedSizeTopResponseSchema },
      ...CommonErrors,
    },
  },
  {
    id: "refRecordsVersionStats",
    method: "GET",
    path: "/_ref/records/version-stats",
    surface: "reference",
    tags: ["reference", "records"],
    summary: "Record-version churn stats with projection and record-change authority for owner diagnostics.",
    request: {
      query: {
        type: "object",
        additionalProperties: false,
        properties: {
          connector_instance_id: { type: "string" },
          stream: { type: "string" },
          risk: { type: "string", enum: ["normal", "watch", "high"] },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
      },
    },
    responses: {
      200: { schema: RecordVersionStatsResponseSchema },
      ...CommonErrors,
    },
  },
  {
    id: "refDatasetSizeRebuild",
    method: "POST",
    path: "/_ref/dataset/size/rebuild",
    surface: "reference",
    tags: ["reference", "dataset"],
    summary: "Owner-triggered rebuild of retained-size projection rows from durable reference state.",
    request: {},
    responses: {
      200: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            object: { const: "ref_dataset_size_rebuild" },
            projection: RetainedSizeRowSchema,
          },
          required: ["object", "projection"],
        },
      },
      ...CommonErrors,
    },
  },
  {
    id: "refDatasetSizeReconcile",
    method: "POST",
    path: "/_ref/dataset/size/reconcile",
    surface: "reference",
    tags: ["reference", "dataset"],
    summary: "Owner-triggered reconciliation of dirty retained-size projection rows from durable reference state.",
    request: {},
    responses: {
      200: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            object: { const: "ref_dataset_size_reconcile" },
            streams: { type: "integer", minimum: 0 },
            connections: { type: "integer", minimum: 0 },
            projection: RetainedSizeRowSchema,
          },
          required: ["object", "streams", "connections", "projection"],
        },
      },
      ...CommonErrors,
    },
  },
  {
    id: "refListEventSubscriptions",
    method: "GET",
    path: "/_ref/event-subscriptions",
    surface: "reference",
    tags: ["event-subscriptions", "reference"],
    summary:
      "Operator oversight: list all client event subscriptions. Filter by `client_id`, `grant_id`, or `status`. Secrets are never returned on `/_ref` routes.",
    request: {
      query: {
        type: "object",
        additionalProperties: false,
        properties: {
          client_id: { type: "string", minLength: 1 },
          grant_id: { type: "string", minLength: 1 },
          status: EventSubscriptionStatusSchema,
        },
      },
    },
    responses: {
      200: { schema: RefEventSubscriptionListResponseSchema },
    },
  },
  {
    id: "refGetEventSubscription",
    method: "GET",
    path: "/_ref/event-subscriptions/{subscription_id}",
    surface: "reference",
    tags: ["event-subscriptions", "reference"],
    summary: "Operator oversight: get a single subscription with delivery attempt history.",
    request: { params: EventSubscriptionIdParamSchema },
    responses: {
      200: { schema: RefEventSubscriptionDetailSchema },
      404: { schema: ErrorObjectSchema, description: "Subscription not found" },
    },
  },
  {
    id: "refDisableEventSubscription",
    method: "POST",
    path: "/_ref/event-subscriptions/{subscription_id}/disable",
    surface: "reference",
    tags: ["event-subscriptions", "reference"],
    summary:
      "Operator safety valve: forcibly disable a subscription. Accepts an optional `reason` string. Secrets are never returned.",
    request: {
      params: EventSubscriptionIdParamSchema,
      body: {
        contentType: "application/json",
        required: false,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            reason: { type: "string", minLength: 1 },
          },
        },
      },
    },
    responses: {
      200: { schema: RefEventSubscriptionDetailSchema, description: "Subscription after disabling." },
      400: { schema: ErrorObjectSchema, description: "Invalid request" },
      404: { schema: ErrorObjectSchema, description: "Subscription not found" },
    },
  },
];
