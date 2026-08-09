// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Reference-only /_ref route manifests.
//
// These are reference-designated operator/control surfaces. They belong in
// the full OpenAPI artifact and in reference-implementation docs, but NOT in
// the public PDPP contract surface.

import { ErrorObjectSchema, FreshnessSchema } from "../common/index.ts";

const ConnectorSummarySchema = {
  additionalProperties: true,
  properties: {
    connector_id: { type: "string" },
    display_name: { type: "string" },
    freshness: FreshnessSchema,
    last_run: {
      additionalProperties: true,
      properties: {
        event_count: { type: "integer" },
        failure_reason: { type: ["string", "null"] },
        finished_at: { type: ["string", "null"] },
        first_at: { type: "string" },
        last_at: { type: "string" },
        run_id: { type: "string" },
        started_at: { type: "string" },
        status: { type: "string" },
      },
      type: ["object", "null"],
    },
    last_successful_run: {
      additionalProperties: true,
      properties: {
        event_count: { type: "integer" },
        failure_reason: { type: ["string", "null"] },
        finished_at: { type: ["string", "null"] },
        first_at: { type: "string" },
        last_at: { type: "string" },
        run_id: { type: "string" },
        started_at: { type: "string" },
        status: { type: "string" },
      },
      type: ["object", "null"],
    },
    manifest_version: { type: "string" },
    schedule: {
      additionalProperties: true,
      properties: {
        enabled: { type: "boolean" },
        interval_seconds: { type: "integer" },
        jitter_seconds: { type: "integer" },
        next_due_at: { type: ["string", "null"] },
      },
      type: ["object", "null"],
    },
    streams: { items: { type: "string" }, type: "array" },
    total_records: { type: "integer" },
    // Orthogonal state for total_records (reconcile-active-summary-evidence
    // design.md "Health boundary"): "stale" when the evidence backing
    // total_records exists but its record_snapshot is not current — the
    // number is a non-authoritative carried-over hint, not a proven exact
    // count. Optional: a reference predating this field omits it.
    total_records_state: { enum: ["known", "known_zero", "unobserved", "stale", "unknown"], type: "string" },
  },
  required: ["connector_id"],
  type: "object",
};

const ConnectorListResponseSchema = {
  additionalProperties: false,
  properties: {
    data: { items: ConnectorSummarySchema, type: "array" },
    has_more: { type: "boolean" },
    next_cursor: { type: ["string", "null"] },
    object: { const: "list" },
  },
  required: ["object", "data"],
  type: "object",
};

// Owner-only aggregate composition over the existing connection-health
// projection. This deliberately exposes evidence references and closed outcome
// dimensions, not presentation copy or a new persisted health state.
const FleetConnectionReferenceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    connection_id: { type: "string" },
    connector_id: { type: "string" },
    connector_instance_id: { type: "string" },
    display_name: { type: "string" },
  },
  required: ["connection_id", "connector_id", "connector_instance_id", "display_name"],
};

const FleetConnectionReferencesSchema = {
  type: "array",
  items: FleetConnectionReferenceSchema,
};

const FleetHealthVerdictResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    dimensions: {
      type: "object",
      additionalProperties: false,
      properties: {
        active_work: FleetConnectionReferencesSchema,
        attention: {
          type: "object",
          additionalProperties: false,
          properties: { needs_owner: FleetConnectionReferencesSchema },
          required: ["needs_owner"],
        },
        coverage_audit: { type: "string", enum: ["fail", "inconclusive", "pass"] },
        freshness_advisories: FleetConnectionReferencesSchema,
        intentional_policy: {
          type: "object",
          additionalProperties: false,
          properties: {
            manual: FleetConnectionReferencesSchema,
            paused: FleetConnectionReferencesSchema,
          },
          required: ["manual", "paused"],
        },
        recovery: {
          type: "object",
          additionalProperties: false,
          properties: {
            retryable: FleetConnectionReferencesSchema,
            terminal: FleetConnectionReferencesSchema,
          },
          required: ["retryable", "terminal"],
        },
        runtime: { type: "string", enum: ["healthy", "unhealthy", "unknown"] },
        stalled_work: FleetConnectionReferencesSchema,
        system: {
          type: "object",
          additionalProperties: false,
          properties: { degraded_or_broken: FleetConnectionReferencesSchema },
          required: ["degraded_or_broken"],
        },
        unknown_evidence: FleetConnectionReferencesSchema,
      },
      required: [
        "active_work",
        "attention",
        "coverage_audit",
        "freshness_advisories",
        "intentional_policy",
        "recovery",
        "runtime",
        "stalled_work",
        "system",
        "unknown_evidence",
      ],
    },
    fully_healthy: { type: "boolean" },
    scope: {
      type: "object",
      additionalProperties: false,
      properties: {
        assessed: FleetConnectionReferencesSchema,
        configured: { type: "integer", minimum: 0 },
        intentional_exclusions: FleetConnectionReferencesSchema,
        setup_pending: FleetConnectionReferencesSchema,
        unassessed: FleetConnectionReferencesSchema,
      },
      required: ["assessed", "configured", "intentional_exclusions", "setup_pending", "unassessed"],
    },
    state: { type: "string", enum: ["healthy", "healthy_with_advisories", "indeterminate", "unhealthy"] },
  },
  required: ["dimensions", "fully_healthy", "scope", "state"],
};

// Optional connection selector for the connection-summary list. When present,
// the route projects only the resolved connection (an exact `connection_id` /
// `connector_instance_id` match is preferred, else the first connection whose
// `connector_id` matches); when absent, the route lists every configured
// connection. The response stays `ConnectorListResponseSchema` — a list of 0 or
// 1 when the selector is supplied.
//
// The paged (non-`connection`) form accepts `connector_id` as either a single
// string or a bounded repeated-value set (1..100 canonical distinct ids,
// design doc add-source-perf-design-agy-0730.md "Minimal contract"); it stays
// mutually exclusive with `connection`. `profile` selects a named,
// option-gated dependency-family subset of the one shared projection
// (`identity_inventory`, `retained_count_summary`) — omitted preserves the
// full (`detail`-shaped) response.
const ConnectorListQuerySchema = {
  additionalProperties: false,
  properties: {
    connection: { minLength: 1, type: "string" },
    connector_id: {
      oneOf: [
        { minLength: 1, type: "string" },
        { items: { minLength: 1, type: "string" }, maxItems: 100, minItems: 1, type: "array" },
      ],
    },
    cursor: { minLength: 1, type: "string" },
    include_fleet_health: { enum: ["0", "1"], type: "string" },
    limit: { maximum: 100, minimum: 1, type: "integer" },
    profile: { enum: ["identity_inventory", "retained_count_summary"], type: "string" },
  },
  type: "object",
};

const ScheduleUpsertBodySchema = {
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    interval_seconds: { minimum: 1, type: "integer" },
    jitter_seconds: { minimum: 0, type: "integer" },
  },
  required: ["interval_seconds"],
  type: "object",
};

const RunStartResponseSchema = {
  additionalProperties: true,
  properties: {
    run_id: { type: "string" },
    trace_id: { type: "string" },
  },
  required: ["run_id"],
  type: "object",
};

const ConnectorInstanceIdParamSchema = {
  additionalProperties: false,
  properties: { connectorInstanceId: { minLength: 1, type: "string" } },
  required: ["connectorInstanceId"],
  type: "object",
};

// Owner-agent control surface standardizes on `connection_id` as the stable
// selector (see `OwnerConnectionSchema`), so its path params use
// `{connectionId}` rather than the deprecated `{connectorInstanceId}` alias the
// `/_ref/*` surface carries.
const ConnectionIdParamSchema = {
  additionalProperties: false,
  properties: { connectionId: { minLength: 1, type: "string" } },
  required: ["connectionId"],
  type: "object",
};

const ConnectionQuerySchema = {
  additionalProperties: false,
  properties: {
    connector_id: { type: "string" },
    status: { enum: ["active", "paused", "revoked"], type: "string" },
  },
  type: "object",
};

const RefConnectionSchema = {
  additionalProperties: true,
  properties: {
    connector_id: { type: "string" },
    connector_instance_id: { type: "string" },
    created_at: { type: "string" },
    display_name: { type: ["string", "null"] },
    object: { const: "ref_connection" },
    revoked_at: { type: ["string", "null"] },
    schedule: { additionalProperties: true, type: ["object", "null"] },
    source_binding: { additionalProperties: true, type: ["object", "null"] },
    source_kind: { type: ["string", "null"] },
    status: { type: "string" },
    updated_at: { type: "string" },
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
  type: "object",
};

const ConnectionListResponseSchema = {
  additionalProperties: false,
  properties: {
    data: { items: RefConnectionSchema, type: "array" },
    object: { const: "list" },
  },
  required: ["object", "data"],
  type: "object",
};

// One owner-agent control action descriptor. Shared by the control entrypoint
// document (`GET /v1/owner/control`) and the per-connection `supported_actions`
// array, so the two surfaces describe an action the same way. `status` is the
// stable selector: `supported` carries a `method` + absolute `url`; everything
// else carries `null` for both so an agent does not probe a route this build
// does not serve. Defined before `OwnerConnectionSchema` because that schema
// references it for its `supported_actions` items.
const OwnerControlActionSchema = {
  additionalProperties: false,
  properties: {
    family: { type: "string" },
    method: { type: ["string", "null"] },
    reason: { type: "string" },
    status: { enum: ["supported", "owner_mediated", "unsupported"], type: "string" },
    url: { type: ["string", "null"] },
  },
  required: ["family", "status", "method", "url", "reason"],
  type: "object",
};

// Owner-agent control-surface projection of a configured connection. The
// bearer-authed `/v1/owner/connections` sibling of `/_ref/connections`
// standardizes on `connection_id` as the stable selector (keeping
// `connector_instance_id` as a deprecated alias), exposes both
// `connector_id` and the canonical `connector_key`, and adds `label_status`
// so an owner agent can tell an owner-chosen label from a storage-layer
// fallback (label-needed) without re-deriving the placeholder rules.
const OwnerConnectionSchema = {
  additionalProperties: true,
  properties: {
    connection_id: { type: "string" },
    connector_id: { type: "string" },
    connector_instance_id: { type: "string" },
    connector_key: { type: "string" },
    created_at: { type: ["string", "null"] },
    display_name: { type: ["string", "null"] },
    label_status: { enum: ["owner_set", "fallback"], type: "string" },
    object: { const: "owner_connection" },
    revoked_at: { type: ["string", "null"] },
    schedule: { additionalProperties: true, type: ["object", "null"] },
    source_binding: { additionalProperties: true, type: ["object", "null"] },
    source_kind: { type: ["string", "null"] },
    status: { type: ["string", "null"] },
    // Capability-advertised, instance-scoped control actions for this exact
    // connection (`rename_connection`, `run_connection`, `manage_schedule`,
    // `inspect_diagnostics`, `delete_connection`, `revoke_connection`).
    // Projected from the same control catalog `GET /v1/owner/control` reads, so
    // a row can never claim a supported action the control document calls
    // unsupported. Supported actions carry this connection's concrete URL;
    // unavailable actions are marked `owner_mediated`/`unsupported` with a typed
    // reason rather than omitted, so an agent never probes a 404.
    supported_actions: { items: OwnerControlActionSchema, type: "array" },
    updated_at: { type: ["string", "null"] },
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
  type: "object",
};

const OwnerConnectionListResponseSchema = {
  additionalProperties: false,
  properties: {
    data: { items: OwnerConnectionSchema, type: "array" },
    object: { const: "list" },
  },
  required: ["object", "data"],
  type: "object",
};

const OwnerConnectionSummarySchema = {
  additionalProperties: false,
  properties: {
    connection_id: { type: "string" },
    connector_id: { type: "string" },
    connector_instance_id: { type: "string" },
    connector_key: { type: "string" },
    created_at: { type: ["string", "null"] },
    display_name: { type: ["string", "null"] },
    label_status: { enum: ["owner_set", "fallback"], type: "string" },
    object: { const: "owner_connection_summary" },
    revoked_at: { type: ["string", "null"] },
    source_kind: { type: ["string", "null"] },
    status: { type: ["string", "null"] },
    updated_at: { type: ["string", "null"] },
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
  type: "object",
};

const OwnerConnectorTemplateSetupPlanSchema = {
  additionalProperties: true,
  properties: {
    deployment_readiness: {
      additionalProperties: true,
      type: "object",
    },
    next_step_kind: {
      enum: [
        "enroll_local_collector",
        "enroll_browser_collector",
        "capture_static_secret",
        "open_provider_auth",
        "needs_deployment_config",
        "provide_import_file",
        "manual_runbook",
        "unsupported",
      ],
      type: "string",
    },
    proof_gate: { type: ["string", "null"] },
    runbook_path: { type: ["string", "null"] },
    setup_modality: {
      enum: [
        "local_collector",
        "browser_bound",
        "static_secret",
        "provider_authorization",
        "manual_or_upload",
        "unsupported",
        "unknown",
      ],
      type: "string",
    },
    support_state: {
      enum: ["supported", "proof_gated", "unsupported", "needs_deployment_config"],
      type: "string",
    },
    validation: {
      enum: ["synchronous", "first_sync"],
      type: "string",
    },
  },
  required: ["setup_modality", "support_state", "next_step_kind", "proof_gate", "runbook_path"],
  type: "object",
};

const OwnerConnectorTemplateSchema = {
  additionalProperties: false,
  properties: {
    connection_count: { minimum: 0, type: "integer" },
    connections: { items: OwnerConnectionSummarySchema, type: "array" },
    connector_id: { type: "string" },
    connector_key: { type: "string" },
    connector_modality: {
      enum: ["local_collector", "browser_bound", "api_network", "unknown"],
      type: "string",
    },
    display_name: { type: "string" },
    object: { const: "owner_connector_template" },
    setup_plan: OwnerConnectorTemplateSetupPlanSchema,
    stream_count: { minimum: 0, type: "integer" },
    supported_actions: { items: OwnerControlActionSchema, type: "array" },
    version: { type: ["string", "null"] },
  },
  required: [
    "object",
    "connector_id",
    "connector_key",
    "display_name",
    "version",
    "connector_modality",
    "setup_plan",
    "stream_count",
    "connection_count",
    "connections",
    "supported_actions",
  ],
  type: "object",
};

const OwnerConnectorTemplateListResponseSchema = {
  additionalProperties: false,
  properties: {
    data: { items: OwnerConnectorTemplateSchema, type: "array" },
    object: { const: "list" },
  },
  required: ["object", "data"],
  type: "object",
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
  additionalProperties: false,
  properties: {
    actions: { items: OwnerControlActionSchema, type: "array" },
    entrypoint: { type: "string" },
    mcp_owner_bearer_rejected: { const: true },
    object: { const: "owner_agent_control_surface" },
    scope: { const: "reference_implementation" },
  },
  required: ["object", "entrypoint", "scope", "mcp_owner_bearer_rejected", "actions"],
  type: "object",
};

// One run summary inside the connection-scoped diagnostics read. Carries only
// the non-secret status/timing/run-id fields; gap arrays and event counts stay
// in the richer connector-summary surface.
const OwnerConnectionDiagnosticsRunSchema = {
  additionalProperties: false,
  properties: {
    failure_reason: { type: ["string", "null"] },
    finished_at: { type: ["string", "null"] },
    run_id: { type: ["string", "null"] },
    started_at: { type: ["string", "null"] },
    status: { type: "string" },
  },
  required: ["run_id", "status", "started_at", "finished_at", "failure_reason"],
  type: "object",
};

// The typed connection-health classification inside the diagnostics read. `state`
// is the canonical connection-health taxonomy the connector-health-surface
// research captured; `axes` and `badges` are orthogonal diagnostic detail. The
// shape mirrors the runtime `ConnectionHealthSnapshot` subset the diagnostics
// projection surfaces, so it stays permissive (`additionalProperties: true`) on
// the nested axes/badges objects to avoid a contract break when an axis is added.
const OwnerConnectionDiagnosticsHealthSchema = {
  additionalProperties: false,
  properties: {
    axes: { additionalProperties: true, type: "object" },
    badges: { additionalProperties: true, type: "object" },
    last_success_at: { type: ["string", "null"] },
    next_attempt_at: { type: ["string", "null"] },
    reason_code: { type: ["string", "null"] },
    state: {
      enum: ["blocked", "cooling_off", "degraded", "healthy", "idle", "needs_attention", "unknown"],
      type: "string",
    },
  },
  required: ["state", "reason_code", "last_success_at", "next_attempt_at", "axes", "badges"],
  type: "object",
};

// Owner-only recovery-admission diagnostics (OpenSpec
// `add-connector-neutral-recovery-governor`, tasks 2.6/2.7). Derived from the
// connection's durable `connector_detail_gaps` rows: `admission` re-derives the
// connector-neutral recovery admission decision (counts/classes/timing, and a
// top-line `why_not_now` when nothing is admissible now), and `stall` is the
// observe-only stall watchdog. Counts/classes/timing only — never a record
// payload, locator, or secret.
const OwnerConnectionDiagnosticsRecoverySchema = {
  additionalProperties: false,
  properties: {
    admission: {
      additionalProperties: false,
      properties: {
        admitted: { type: "integer" },
        candidates: { type: "integer" },
        deferred: { type: "integer" },
        // Per-reason-class deferral counts; present only when deferred > 0.
        deferred_by_reason: {
          additionalProperties: false,
          properties: {
            budget: { type: "integer" },
            cooldown: { type: "integer" },
            owner_required: { type: "integer" },
            system_issue: { type: "integer" },
          },
          type: "object",
        },
        next_eligible_at: { type: "string" },
        // Present only when nothing is admissible now.
        why_not_now: {
          enum: ["cooldown", "budget", "owner_required", "system_issue"],
          type: "string",
        },
      },
      required: ["candidates", "admitted", "deferred"],
      type: "object",
    },
    read_limit: { type: ["integer", "null"] },
    stall: {
      additionalProperties: false,
      properties: {
        eligibleCandidates: { type: "integer" },
        lastAttemptAt: { type: ["string", "null"] },
        stalled: { type: "boolean" },
      },
      required: ["stalled", "eligibleCandidates", "lastAttemptAt"],
      type: "object",
    },
    unreadable: { type: "boolean" },
  },
  required: ["admission", "stall", "read_limit", "unreadable"],
  type: "object",
};

// Owner-agent connection-scoped diagnostics read returned by
// `GET /v1/owner/connections/{connectionId}/diagnostics`. Connection-scoped by
// construction: every field describes exactly the one configured connection the
// `connection_id` addresses — last run status, last successful run, last
// successful ingest time, current schedule state, freshness, typed health
// classification, and the rendered verdict / required-action projection shared
// with the console. It carries NO device-exporter subsystem state and NO
// sibling-connection state, which is the boundary that lets it ship under the
// owner-bearer adapter where device-rooted diagnostics cannot. See
// openspec/changes/add-owner-agent-control-surface.
const OwnerConnectionDiagnosticsSchema = {
  additionalProperties: false,
  properties: {
    connection_id: { type: "string" },
    connector_id: { type: "string" },
    connector_key: { type: "string" },
    display_name: { type: ["string", "null"] },
    freshness: { additionalProperties: true, type: "object" },
    health: OwnerConnectionDiagnosticsHealthSchema,
    last_ingest_at: { type: ["string", "null"] },
    last_run: { oneOf: [OwnerConnectionDiagnosticsRunSchema, { type: "null" }] },
    last_successful_run: { oneOf: [OwnerConnectionDiagnosticsRunSchema, { type: "null" }] },
    object: { const: "owner_connection_diagnostics" },
    recovery: OwnerConnectionDiagnosticsRecoverySchema,
    rendered_verdict: { additionalProperties: true, type: "object" },
    schedule: {
      oneOf: [
        {
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            interval_seconds: { type: ["integer", "null"] },
          },
          required: ["enabled", "interval_seconds"],
          type: "object",
        },
        { type: "null" },
      ],
    },
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
    "recovery",
    "rendered_verdict",
  ],
  type: "object",
};

// Owner-agent connection-revoke result: the soft-flipped connection. Revoke is
// zero-cascade (records, spine, device rows, and sibling connections are
// untouched) and durable, so the response only confirms the connection's new
// `revoked` status and the `revoked_at` stamp — there is nothing else to report.
const OwnerConnectionRevokeSchema = {
  additionalProperties: false,
  properties: {
    connection_id: { type: "string" },
    connector_id: { type: "string" },
    connector_key: { type: "string" },
    object: { const: "owner_connection_revoke" },
    revoked_at: { type: ["string", "null"] },
    status: { const: "revoked" },
  },
  required: ["object", "connection_id", "connector_id", "connector_key", "status", "revoked_at"],
  type: "object",
};

const OwnerConnectionReactivateSchema = {
  additionalProperties: false,
  properties: {
    connection_id: { type: "string" },
    connector_id: { type: "string" },
    connector_key: { type: "string" },
    object: { const: "owner_connection_reactivate" },
    reactivated_at: { type: "string" },
    status: { const: "active" },
  },
  required: ["object", "connection_id", "connector_id", "connector_key", "status", "reactivated_at"],
  type: "object",
};

// Non-secret deletion summary returned by the owner-agent connection-DELETE
// routes. Carries counts + stable identifiers only — never record contents,
// secrets, or per-record detail. `deleted_record_count` /
// `deleted_stream_count` report what the cascade erased; `schedule_deleted`
// reflects whether a schedule row existed; `device_refs_cleared` is the count
// of device source-instance back-references set to null.
const OwnerConnectionDeleteSchema = {
  additionalProperties: false,
  properties: {
    connection_id: { type: "string" },
    connector_id: { type: "string" },
    connector_key: { type: "string" },
    deleted: { const: true },
    deleted_record_count: { type: "integer" },
    deleted_stream_count: { type: "integer" },
    device_refs_cleared: { type: "integer" },
    object: { const: "owner_connection_delete" },
    schedule_deleted: { type: "boolean" },
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
  type: "object",
};

// Owner-agent connection-intent request: a trusted owner agent names the
// connector type it wants to add a connection for. `connector_id` accepts the
// canonical key (`amazon`) or a registry URL; the route canonicalizes it. An
// optional `display_name` is a label hint carried through to the materialized
// connection where the next step supports one (e.g. local-collector enroll).
const OwnerConnectionIntentRequestSchema = {
  additionalProperties: false,
  properties: {
    connector_id: { minLength: 1, type: "string" },
    display_name: { maxLength: 200, minLength: 1, type: "string" },
  },
  required: ["connector_id"],
  type: "object",
};

// Typed next step a connection intent returns. The route projects the shared
// setup-plan vocabulary: supported local collectors emit enrollment material;
// proof-gated connectors emit either a non-secret owner-session step
// (`capture_static_secret`), a file-import step (`provide_import_file`), or
// `manual_runbook`; deployment-blocked provider authorization emits
// `needs_deployment_config`; unsupported connectors emit `unsupported`.
// `enroll_browser_collector`, `capture_static_secret`, `provide_import_file`,
// and `open_provider_auth` SHALL NOT carry provider/browser secrets.
const OwnerConnectionIntentNextStepSchema = {
  additionalProperties: true,
  properties: {
    authorization_url: { type: "string" },
    capture_endpoint: { type: "string" },
    enroll_endpoint: { type: "string" },
    enrollment_code: { type: "string" },
    expires_at: { type: "string" },
    kind: {
      enum: [
        "enroll_local_collector",
        "enroll_browser_collector",
        "capture_static_secret",
        "open_provider_auth",
        "needs_deployment_config",
        "provide_import_file",
        "manual_runbook",
        "unsupported",
      ],
      type: "string",
    },
    local_binding_name: { type: "string" },
    reason: { type: ["string", "null"] },
    runbook_path: { type: "string" },
    upload_endpoint: { type: "string" },
  },
  required: ["kind"],
  type: "object",
};

// Owner-agent connection-intent response. The intent is an auditable workflow
// object, NOT a created connection: `connection_active` is always `false` and no
// `connector_instances` row is written by the intent itself. `connector_modality`
// classifies the connector by its manifest `runtime_requirements.bindings`
// (`local_collector` | `browser_bound` | `api_network` | `unknown`) so an agent
// can explain why a given `next_step.kind` was returned.
const OwnerConnectionIntentResponseSchema = {
  additionalProperties: true,
  properties: {
    connection_active: { const: false },
    connector_id: { type: "string" },
    connector_key: { type: "string" },
    connector_modality: {
      enum: ["local_collector", "browser_bound", "api_network", "unknown"],
      type: "string",
    },
    deployment_readiness: {
      additionalProperties: true,
      properties: {
        blockers: {
          items: {
            additionalProperties: true,
            properties: {
              key: { type: "string" },
              label: { type: "string" },
              secret: { type: "boolean" },
            },
            required: ["key", "label", "secret"],
            type: "object",
          },
          type: "array",
        },
        guidance: { type: ["string", "null"] },
        state: {
          enum: ["not_applicable", "ready", "needs_config"],
          type: "string",
        },
      },
      required: ["state", "guidance", "blockers"],
      type: "object",
    },
    next_step: OwnerConnectionIntentNextStepSchema,
    object: { const: "owner_connection_intent" },
    proof_gate: { type: ["string", "null"] },
    runbook_path: { type: ["string", "null"] },
    setup_modality: {
      enum: [
        "local_collector",
        "browser_bound",
        "static_secret",
        "provider_authorization",
        "manual_or_upload",
        "unsupported",
        "unknown",
      ],
      type: "string",
    },
    support_state: {
      enum: ["supported", "proof_gated", "unsupported", "needs_deployment_config"],
      type: "string",
    },
    validation: {
      enum: ["synchronous", "first_sync"],
      type: "string",
    },
  },
  required: [
    "object",
    "connector_id",
    "connector_key",
    "connector_modality",
    "connection_active",
    "deployment_readiness",
    "next_step",
    "proof_gate",
    "runbook_path",
    "setup_modality",
    "support_state",
  ],
  type: "object",
};

const ApprovalItemSchema = {
  additionalProperties: true,
  properties: {
    approval_id: { type: "string" },
    client_id: { type: ["string", "null"] },
    created_at: { type: "string" },
    grant_preview: { type: "object" },
    kind: { enum: ["consent", "owner_device"], type: "string" },
    object: { const: "approval" },
  },
  required: ["object", "approval_id", "kind"],
  type: "object",
};

const RefSearchRecordSchema = {
  additionalProperties: true,
  properties: {
    connector_id: { type: "string" },
    data: { type: ["object", "null"] },
    emitted_at: { type: "string" },
    id: { type: "string" },
    matched_field: { type: ["string", "null"] },
    native_timestamp: {
      additionalProperties: false,
      properties: {
        field: { type: "string" },
        value: { type: "string" },
      },
      required: ["field", "value"],
      type: ["object", "null"],
    },
    snippet: { type: ["string", "null"] },
    stream: { type: "string" },
  },
  required: ["connector_id", "stream", "id", "emitted_at"],
  type: "object",
};

const RecordPageSchema = {
  additionalProperties: false,
  properties: {
    filters: {
      additionalProperties: false,
      properties: {
        connector_id: { type: ["string", "null"] },
        stream: { type: ["string", "null"] },
      },
      required: ["connector_id", "stream"],
      type: "object",
    },
    has_more: { type: "boolean" },
    limit: { type: "integer" },
    next_cursor: { type: ["string", "null"] },
    offset: { type: "integer" },
    order: { enum: ["asc", "desc"], type: "string" },
    prev_cursor: { type: ["string", "null"] },
    returned: { type: "integer" },
    sort: { enum: ["native", "ingested"], type: "string" },
    total: { type: "integer" },
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
  type: "object",
};

const DatasetSummaryResponseSchema = {
  additionalProperties: false,
  properties: {
    blob_bytes: { minimum: 0, type: "integer" },
    connector_count: { minimum: 0, type: "integer" },
    earliest_ingested_at: { type: ["string", "null"] },
    earliest_record_time: { type: ["string", "null"] },
    latest_ingested_at: { type: ["string", "null"] },
    latest_record_time: { type: ["string", "null"] },
    object: { const: "dataset_summary" },
    projection: {
      additionalProperties: false,
      properties: {
        computed_at: { type: ["string", "null"] },
        last_error: { type: ["string", "null"] },
        rebuild_status: { enum: ["idle", "running", "failed"] },
        source_high_watermark: { type: ["string", "null"] },
        stale_since: { type: ["string", "null"] },
        state: {
          enum: ["fresh", "refreshing", "stale", "rebuilding", "failed"],
        },
      },
      required: ["computed_at", "state", "stale_since", "rebuild_status", "last_error"],
      type: "object",
    },
    record_changes_json_bytes: { minimum: 0, type: "integer" },
    record_count: { minimum: 0, type: "integer" },
    record_json_bytes: { minimum: 0, type: "integer" },
    stream_count: { minimum: 0, type: "integer" },
    top_connectors: {
      items: {
        additionalProperties: false,
        properties: {
          connector_id: { type: "string" },
          object: { const: "dataset_connector_summary" },
          record_count: { minimum: 0, type: "integer" },
        },
        required: ["object", "connector_id", "record_count"],
        type: "object",
      },
      type: "array",
    },
    total_retained_bytes: { minimum: 0, type: "integer" },
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
  type: "object",
};

const DatasetSummaryStreamsResponseSchema = {
  additionalProperties: false,
  properties: {
    filters: {
      additionalProperties: false,
      properties: {
        connector_id: { type: ["string", "null"] },
      },
      required: ["connector_id"],
      type: "object",
    },
    object: { const: "dataset_summary_streams" },
    projection: {
      additionalProperties: false,
      properties: {
        computed_at: { type: ["string", "null"] },
        last_error: { type: ["string", "null"] },
        rebuild_status: { enum: ["idle", "running", "failed"] },
        source_high_watermark: { type: ["string", "null"] },
        stale_since: { type: ["string", "null"] },
        state: {
          enum: ["fresh", "refreshing", "stale", "rebuilding", "failed"],
        },
      },
      required: ["computed_at", "state", "stale_since", "rebuild_status", "last_error"],
      type: "object",
    },
    streams: {
      items: {
        additionalProperties: false,
        properties: {
          computed_at: { type: ["string", "null"] },
          connector_id: { type: "string" },
          consent_time_field: { type: ["string", "null"] },
          dirty_record_time_bounds: { type: "boolean" },
          earliest_ingested_at: { type: ["string", "null"] },
          earliest_record_time: { type: ["string", "null"] },
          latest_ingested_at: { type: ["string", "null"] },
          latest_record_time: { type: ["string", "null"] },
          record_count: { minimum: 0, type: "integer" },
          record_json_bytes: { minimum: 0, type: "integer" },
          stream: { type: "string" },
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
        type: "object",
      },
      type: "array",
    },
  },
  required: ["object", "streams", "filters", "projection"],
  type: "object",
};

const RetainedSizeProjectionSchema = {
  additionalProperties: false,
  properties: {
    computed_at: { type: ["string", "null"] },
    dirty: { type: "boolean" },
    metadata: { additionalProperties: true, type: ["object", "null"] },
  },
  required: ["computed_at", "dirty", "metadata"],
  type: "object",
};

const RetainedSizeRowSchema = {
  additionalProperties: false,
  properties: {
    blob_bytes: { minimum: 0, type: "integer" },
    blob_count: { minimum: 0, type: "integer" },
    computed_at: { type: ["string", "null"] },
    connector_id: { type: ["string", "null"] },
    connector_instance_id: { type: ["string", "null"] },
    current_record_json_bytes: { minimum: 0, type: "integer" },
    dirty: { type: "boolean" },
    grain: { type: "string" },
    metadata: { additionalProperties: true, type: ["object", "null"] },
    record_count: { minimum: 0, type: "integer" },
    record_family: { type: ["string", "null"] },
    record_history_count: { minimum: 0, type: "integer" },
    record_history_json_bytes: { minimum: 0, type: "integer" },
    stream: { type: ["string", "null"] },
    total_retained_bytes: { minimum: 0, type: "integer" },
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
  type: "object",
};

const RetainedSizeTopRowSchema = {
  additionalProperties: false,
  properties: {
    ...RetainedSizeRowSchema.properties,
    blob_id: { type: ["string", "null"] },
    grain_key: { type: "string" },
    measure: { type: "string" },
    rank: { minimum: 1, type: "integer" },
    record_key: { type: ["string", "null"] },
    scope: { type: "string" },
  },
  required: [...RetainedSizeRowSchema.required, "scope", "measure", "rank", "grain_key", "record_key", "blob_id"],
  type: "object",
};

const RetainedSizeResponseSchema = {
  additionalProperties: false,
  properties: {
    grain: { type: "string" },
    object: { const: "ref_dataset_size" },
    projection: RetainedSizeProjectionSchema,
    rows: { items: RetainedSizeRowSchema, type: "array" },
  },
  required: ["object", "grain", "rows", "projection"],
  type: "object",
};

const RetainedSizeTopResponseSchema = {
  additionalProperties: false,
  properties: {
    measure: { type: "string" },
    object: { const: "ref_dataset_top" },
    projection: RetainedSizeProjectionSchema,
    rows: { items: RetainedSizeTopRowSchema, type: "array" },
    scope: { type: "string" },
  },
  required: ["object", "scope", "measure", "rows", "projection"],
  type: "object",
};

const RecordVersionStatsRowSchema = {
  additionalProperties: false,
  properties: {
    connector_id: { type: ["string", "null"] },
    connector_instance_id: { type: "string" },
    current_record_count: { minimum: 0, type: "integer" },
    display_name: { type: ["string", "null"] },
    last_current_at: { type: ["string", "null"] },
    last_history_at: { type: ["string", "null"] },
    projection_authority: { enum: ["record_changes_ground_truth", "retained_size_projection"], type: "string" },
    projection_dirty: { type: "boolean" },
    projection_missing: { type: "boolean" },
    record_history_count: { minimum: 0, type: "integer" },
    record_key_count: { minimum: 0, type: ["integer", "null"] },
    risk_level: { enum: ["normal", "watch", "high"], type: "string" },
    risk_reasons: { items: { type: "string" }, type: "array" },
    stream: { type: "string" },
    // Reference-DERIVED disposition (never connector-authored). A label only:
    // it does not alter risk_level/risk_reasons/risk_thresholds. Only
    // `active_defect_or_unclassified` counts toward an operator needs-review
    // signal.
    version_disposition: {
      enum: [
        "active_defect_or_unclassified",
        "reviewed_historical_residue",
        "point_in_time_retained_history",
        "lossless_compaction_candidate",
        "recurring_point_in_time_snapshot",
      ],
      type: "string",
    },
    // Reference-DERIVED remediation (never connector-authored). Orthogonal to
    // version_disposition: disposition says WHY the history exists, remediation
    // says WHAT the operator does next. A label only — it never alters
    // risk_level/risk_reasons/risk_thresholds/version_disposition, and a
    // connector cannot set or override it. See the consistency rules in
    // `reference-implementation/server/version-disposition.js`.
    version_remediation: {
      enum: ["none", "content_fingerprint_pending", "owner_migration_pending", "owner_retention_policy"],
      type: "string",
    },
    versions_per_record: { minimum: 0, type: "number" },
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
    "version_disposition",
    "version_remediation",
  ],
  type: "object",
};

const RecordVersionStatsResponseSchema = {
  additionalProperties: false,
  properties: {
    data: { items: RecordVersionStatsRowSchema, type: "array" },
    meta: {
      additionalProperties: false,
      properties: {
        // Normative assertion that version_disposition is a label and never
        // alters the numeric risk thresholds above. Always false.
        disposition_affects_thresholds: { const: false },
        filters: {
          additionalProperties: false,
          properties: {
            connector_instance_id: { type: ["string", "null"] },
            risk: { enum: ["normal", "watch", "high", null], type: ["string", "null"] },
            stream: { type: ["string", "null"] },
          },
          required: ["connector_instance_id", "stream", "risk"],
          type: "object",
        },
        has_more: { type: "boolean" },
        limit: { maximum: 500, minimum: 1, type: "integer" },
        // Normative assertion that version_remediation is likewise a label and
        // never alters the numeric risk thresholds above. Always false.
        remediation_affects_thresholds: { const: false },
        returned: { minimum: 0, type: "integer" },
        risk_thresholds: {
          additionalProperties: false,
          properties: {
            high_history_count: { type: "integer" },
            high_history_versions_per_record: { type: "number" },
            high_versions_per_record: { type: "number" },
            watch_versions_per_record: { type: "number" },
          },
          required: [
            "watch_versions_per_record",
            "high_versions_per_record",
            "high_history_count",
            "high_history_versions_per_record",
          ],
          type: "object",
        },
        source: { const: "retained_size_projection_with_record_changes_ground_truth" },
        total_matching: { minimum: 0, type: "integer" },
      },
      required: [
        "returned",
        "total_matching",
        "has_more",
        "limit",
        "filters",
        "source",
        "risk_thresholds",
        "disposition_affects_thresholds",
        "remediation_affects_thresholds",
      ],
      type: "object",
    },
    object: { const: "ref_record_version_stats" },
    projection: RetainedSizeProjectionSchema,
  },
  required: ["object", "data", "meta", "projection"],
  type: "object",
};

const TimelineEntrySchema = {
  additionalProperties: true,
  properties: {
    connector_id: { type: "string" },
    data: { type: ["object", "null"] },
    display_timestamp: { type: "string" },
    emitted_at: { type: "string" },
    id: { type: "string" },
    object: { const: "timeline_entry" },
    semantic_timestamp: {
      additionalProperties: false,
      properties: {
        field: { type: "string" },
        value: { type: "string" },
      },
      required: ["field", "value"],
      type: ["object", "null"],
    },
    stream: { type: "string" },
    version: { type: ["integer", "string", "null"] },
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
  type: "object",
};

const CommonErrors = {
  400: { description: "Invalid request", schema: ErrorObjectSchema },
  404: { description: "Not found", schema: ErrorObjectSchema },
  409: { description: "Conflict (e.g. run_already_active)", schema: ErrorObjectSchema },
};

const DeviceExporterErrors = {
  ...CommonErrors,
  401: { description: "Authentication required", schema: ErrorObjectSchema },
  403: { description: "Permission denied", schema: ErrorObjectSchema },
};

const ConnectorIdParamSchema = {
  additionalProperties: false,
  properties: { connectorId: { minLength: 1, type: "string" } },
  required: ["connectorId"],
  type: "object",
};

const DeviceIdParamSchema = {
  additionalProperties: false,
  properties: { deviceId: { minLength: 1, type: "string" } },
  required: ["deviceId"],
  type: "object",
};

const DeviceSourceInstanceSchema = {
  additionalProperties: true,
  properties: {
    accepted_record_count: { minimum: 0, type: "integer" },
    connector_id: { type: "string" },
    connector_instance_id: { type: ["string", "null"] },
    created_at: { type: "string" },
    device_id: { type: "string" },
    display_name: { type: ["string", "null"] },
    heartbeat_age_ms: { type: ["integer", "null"] },
    // Presented health, derived from heartbeat age against
    // `heartbeat_lease_ms`. `stale`/`unknown` are derivations, not statuses a
    // collector reports. Read this, not `last_heartbeat_status`, for whether
    // a collector is currently alive.
    heartbeat_health: {
      enum: ["blocked", "healthy", "retrying", "stale", "starting", "stopped", "unknown"],
      type: "string",
    },
    heartbeat_lease_ms: { minimum: 0, type: "integer" },
    last_error: { additionalProperties: true, type: ["object", "null"] },
    last_ingest_at: { type: ["string", "null"] },
    local_binding_name: { type: "string" },
    object: { const: "device_source_instance" },
    rejected_record_count: { minimum: 0, type: "integer" },
    source_instance_id: { type: "string" },
  },
  required: ["object", "source_instance_id", "device_id", "connector_id", "local_binding_name", "created_at"],
  type: "object",
};

const DeviceExporterSchema = {
  additionalProperties: true,
  properties: {
    created_at: { type: "string" },
    device_id: { type: "string" },
    display_name: { type: ["string", "null"] },
    last_error: { additionalProperties: true, type: ["object", "null"] },
    last_heartbeat_at: { type: ["string", "null"] },
    last_ingest_at: { type: ["string", "null"] },
    object: { const: "device_exporter" },
    revoked_at: { type: ["string", "null"] },
    source_instances: { items: DeviceSourceInstanceSchema, type: "array" },
    stale: { type: "boolean" },
    status: { enum: ["active", "revoked"], type: "string" },
    subject_id: { type: "string" },
  },
  required: ["object", "device_id", "subject_id", "status", "created_at", "stale", "source_instances"],
  type: "object",
};

const DeviceEnrollmentCodeCreateBodySchema = {
  additionalProperties: false,
  properties: {
    connector_id: { minLength: 1, type: "string" },
    display_name: { type: "string" },
    expires_in_seconds: { maximum: 86_400, minimum: 60, type: "integer" },
    local_binding_name: { minLength: 1, type: "string" },
  },
  required: ["connector_id", "local_binding_name"],
  type: "object",
};

const DeviceEnrollmentCodeResponseSchema = {
  additionalProperties: false,
  properties: {
    connector_id: { type: "string" },
    enrollment_code: { type: "string" },
    expires_at: { type: "string" },
    local_binding_name: { type: "string" },
    object: { const: "device_exporter_enrollment_code" },
  },
  required: ["object", "enrollment_code", "expires_at", "connector_id", "local_binding_name"],
  type: "object",
};

const DeviceEnrollmentExchangeBodySchema = {
  additionalProperties: false,
  properties: {
    agent_version: { type: "string" },
    enrollment_code: { minLength: 1, type: "string" },
  },
  required: ["enrollment_code"],
  type: "object",
};

const DeviceEnrollmentExchangeResponseSchema = {
  additionalProperties: false,
  properties: {
    connector_id: { type: "string" },
    connector_instance_id: { type: "string" },
    device_id: { type: "string" },
    device_token: { type: "string" },
    local_binding_name: { type: "string" },
    object: { const: "device_exporter_enrollment" },
    source_instance_id: { type: "string" },
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
  type: "object",
};

const DeviceHeartbeatBodySchema = {
  additionalProperties: false,
  properties: {
    agent_version: { type: "string" },
    connector_id: { type: "string" },
    last_error: { additionalProperties: true, type: ["object", "null"] },
    records_pending: { minimum: 0, type: "integer" },
    source_instance_id: { type: "string" },
    source_instances: {
      items: {
        additionalProperties: false,
        properties: {
          last_error: { additionalProperties: true, type: ["object", "null"] },
          source_instance_id: { type: "string" },
        },
        required: ["source_instance_id"],
        type: "object",
      },
      type: "array",
    },
    status: { enum: ["starting", "healthy", "retrying", "blocked", "stopped"], type: "string" },
  },
  type: "object",
};

const DeviceHeartbeatResponseSchema = {
  additionalProperties: false,
  properties: {
    device_id: { type: "string" },
    object: { const: "device_exporter_heartbeat" },
    received_at: { type: "string" },
    status: { enum: ["accepted"], type: "string" },
  },
  required: ["object", "device_id", "received_at", "status"],
  type: "object",
};

const DeviceIngestBatchBodySchema = {
  additionalProperties: false,
  properties: {
    batch_id: { type: "string" },
    batch_seq: { minimum: 0, type: "integer" },
    body_hash: { type: "string" },
    connector_id: { type: "string" },
    device_id: { type: "string" },
    records: {
      items: {
        additionalProperties: false,
        properties: {
          data: { additionalProperties: true, type: "object" },
          emitted_at: { type: "string" },
          record_key: { type: ["string", "array"] },
          stream: { type: "string" },
        },
        required: ["stream", "record_key", "data"],
        type: "object",
      },
      type: "array",
    },
    source_instance_id: { type: "string" },
  },
  required: ["device_id", "source_instance_id", "batch_id", "batch_seq", "body_hash", "connector_id", "records"],
  type: "object",
};

const DeviceIngestBatchResponseSchema = {
  additionalProperties: false,
  properties: {
    accepted_record_count: { minimum: 0, type: "integer" },
    batch_id: { type: "string" },
    body_hash: { type: "string" },
    connector_instance_id: { type: "string" },
    device_id: { type: "string" },
    object: { const: "device_ingest_batch_result" },
    rejected_record_count: { minimum: 0, type: "integer" },
    source_instance_id: { type: "string" },
    status: { enum: ["accepted", "replayed", "rejected"], type: "string" },
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
  type: "object",
};

const DeviceSourceInstanceStateParamSchema = {
  additionalProperties: false,
  properties: {
    deviceId: { minLength: 1, type: "string" },
    sourceInstanceId: { minLength: 1, type: "string" },
  },
  required: ["deviceId", "sourceInstanceId"],
  type: "object",
};

const DeviceSourceInstanceStatePutBodySchema = {
  additionalProperties: false,
  properties: {
    state: { additionalProperties: true, type: "object" },
  },
  required: ["state"],
  type: "object",
};

const DeviceSourceInstanceStateResponseSchema = {
  additionalProperties: false,
  properties: {
    connector_instance_id: { type: "string" },
    device_id: { type: "string" },
    object: { const: "device_source_instance_state" },
    source_instance_id: { type: "string" },
    state: { additionalProperties: true, type: "object" },
    updated_at: { type: ["string", "null"] },
  },
  required: ["object", "device_id", "connector_instance_id", "source_instance_id", "state", "updated_at"],
  type: "object",
};

// Operator oversight for client event subscriptions. These /_ref routes never
// return the subscription's signing secret. See:
//   openspec/specs/reference-implementation-architecture/spec.md
//   openspec/changes/archive/2026-05-28-add-client-event-subscription-management
const EventSubscriptionStatusSchema = {
  enum: ["pending_verification", "active", "disabled", "disabled_failure", "disabled_revoked", "deleted"],
  type: "string",
};

const EventSubscriptionScopeSchema = {
  additionalProperties: false,
  properties: {
    filters: {
      additionalProperties: false,
      properties: {
        streams: { items: { minLength: 1, type: "string" }, type: "array" },
      },
      type: "object",
    },
    streams: {
      items: {
        additionalProperties: false,
        properties: {
          connection_id: { type: "string" },
          name: { minLength: 1, type: "string" },
        },
        required: ["name"],
        type: "object",
      },
      type: "array",
    },
  },
  required: ["streams"],
  type: "object",
};

const RefEventSubscriptionDeliveryFields = {
  final_failure_count: { minimum: 0, type: "integer" },
  last_attempt_ok: { type: ["boolean", "null"] },
  last_attempt_status_code: { type: ["integer", "null"] },
  last_attempted_at: { format: "date-time", type: ["string", "null"] },
  pending_queue_count: { minimum: 0, type: "integer" },
};

const RefEventSubscriptionListItemSchema = {
  additionalProperties: false,
  properties: {
    callback_host: { minLength: 1, type: "string" },
    client_id: { minLength: 1, type: "string" },
    created_at: { format: "date-time", type: "string" },
    disabled_at: { format: "date-time", type: ["string", "null"] },
    disabled_reason: { type: ["string", "null"] },
    grant_id: { minLength: 1, type: "string" },
    status: EventSubscriptionStatusSchema,
    subscription_id: { minLength: 1, type: "string" },
    updated_at: { format: "date-time", type: "string" },
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
  type: "object",
};

const RefEventSubscriptionListResponseSchema = {
  additionalProperties: false,
  properties: {
    data: { items: RefEventSubscriptionListItemSchema, type: "array" },
    object: { const: "list" },
  },
  required: ["object", "data"],
  type: "object",
};

const RefEventSubscriptionAttemptSchema = {
  additionalProperties: false,
  properties: {
    attempt_id: { type: "integer" },
    attempted_at: { format: "date-time", type: "string" },
    error: { type: ["string", "null"] },
    event_id: { minLength: 1, type: "string" },
    event_type: { minLength: 1, type: "string" },
    latency_ms: { type: ["integer", "null"] },
    ok: { type: "boolean" },
    queue_id: { type: "integer" },
    response_snippet: { type: ["string", "null"] },
    status_code: { type: ["integer", "null"] },
  },
  required: ["attempt_id", "queue_id", "event_id", "event_type", "attempted_at", "ok"],
  type: "object",
};

const RefEventSubscriptionDetailSchema = {
  additionalProperties: false,
  properties: {
    callback_host: { minLength: 1, type: "string" },
    callback_url: { format: "uri", type: "string" },
    client_id: { minLength: 1, type: "string" },
    created_at: { format: "date-time", type: "string" },
    disabled_at: { format: "date-time", type: ["string", "null"] },
    disabled_reason: { type: ["string", "null"] },
    grant_id: { minLength: 1, type: "string" },
    scope: EventSubscriptionScopeSchema,
    status: EventSubscriptionStatusSchema,
    subject_id: { minLength: 1, type: "string" },
    subscription_id: { minLength: 1, type: "string" },
    updated_at: { format: "date-time", type: "string" },
    ...RefEventSubscriptionDeliveryFields,
    recent_attempts: { items: RefEventSubscriptionAttemptSchema, type: "array" },
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
  type: "object",
};

const EventSubscriptionIdParamSchema = {
  additionalProperties: false,
  properties: { subscription_id: { minLength: 1, type: "string" } },
  required: ["subscription_id"],
  type: "object",
};

// One record in the merged timeline (and in the upcoming projection). Forward-
// compatible (additionalProperties: true), but the known fields are declared so
// omission/shape drift is caught (the boot-crash class taught us route shapes need
// explicit gates).
const ExploreTimelineRecordSchema = {
  additionalProperties: true,
  properties: {
    connector_id: { type: "string" },
    connector_instance_id: { type: "string" },
    data: { type: ["object", "null"] },
    emitted_at: { type: "string" },
    object: { const: "timeline_record" },
    record_key: { type: "string" },
    // The authoritative semantic/display time the feed is ordered by; clients use it
    // directly as the display timestamp (display == sort by construction).
    semantic_time: { type: "string" },
    stream: { type: "string" },
  },
  required: ["object", "connector_id", "connector_instance_id", "stream", "record_key", "emitted_at", "semantic_time"],
  type: "object" as const,
};

// The 200 response: the main feed (`data`, clamped to <= the pinned now boundary),
// pagination/snapshot fields, and the SEPARATE `upcoming` (future-dated) projection
// with a true `upcoming_total` count.
const ExploreRecordsResponseSchema = {
  additionalProperties: true,
  properties: {
    data: { items: ExploreTimelineRecordSchema, type: "array" },
    has_more: { type: "boolean" },
    new_since_snapshot: { type: "integer" },
    next_cursor: { type: ["string", "null"] },
    object: { const: "list" },
    snapshot_at: { type: "string" },
    upcoming: { items: ExploreTimelineRecordSchema, type: "array" },
    upcoming_has_more: { type: "boolean" },
    // Opaque cursor for the NEXT page of Upcoming (future) records, walking the
    // future projection to exhaustion (count==reachability: every one of the N
    // "upcoming" records is reachable, not just a capped head). Null when the
    // future set is fully returned by this page. Independent of `next_cursor`.
    upcoming_next_cursor: { type: ["string", "null"] },
    upcoming_total: { type: "integer" },
  },
  required: [
    "object",
    "data",
    "has_more",
    "next_cursor",
    "snapshot_at",
    "new_since_snapshot",
    "upcoming",
    "upcoming_total",
    "upcoming_next_cursor",
    "upcoming_has_more",
  ],
  type: "object" as const,
};

const ExploreRecordBucketSchema = {
  additionalProperties: false,
  properties: {
    count: { minimum: 0, type: "integer" },
    end: { format: "date-time", type: "string" },
    start: { format: "date-time", type: "string" },
  },
  required: ["start", "end", "count"],
  type: "object" as const,
} as const;

const ExploreRecordBucketsResponseSchema = {
  additionalProperties: false,
  properties: {
    buckets: { items: ExploreRecordBucketSchema, type: "array" },
    extent: {
      additionalProperties: false,
      properties: {
        count: { minimum: 0, type: "integer" },
        end: { format: "date-time", type: ["string", "null"] },
        start: { format: "date-time", type: ["string", "null"] },
      },
      required: ["start", "end", "count"],
      type: "object" as const,
    },
    granularity: { enum: ["hour", "day", "week", "month", "quarter", "year"], type: "string" },
    object: { const: "explore_record_buckets" },
    time_zone: { const: "UTC" },
  },
  required: ["object", "granularity", "time_zone", "extent", "buckets"],
  type: "object" as const,
} as const;

export const referenceManifests = [
  {
    id: "refSearch",
    method: "GET",
    path: "/_ref/search",
    request: {
      query: {
        additionalProperties: false,
        properties: {
          connector_id: { type: "string" },
          cursor: { type: "string" },
          limit: { maximum: 200, minimum: 1, type: "integer" },
          order: { enum: ["asc", "desc"], type: "string" },
          q: { type: "string" },
          sort: { enum: ["native", "ingested"], type: "string" },
          stream: { type: "string" },
        },
        type: "object",
      },
    },
    responses: {
      200: {
        schema: {
          additionalProperties: true,
          properties: {
            exact: { type: ["object", "null"] },
            grants: { items: { type: "object" }, type: "array" },
            object: { const: "search_result" },
            record_page: RecordPageSchema,
            records: { items: RefSearchRecordSchema, type: "array" },
            runs: { items: { type: "object" }, type: "array" },
            traces: { items: { type: "object" }, type: "array" },
          },
          required: ["object", "exact", "traces", "grants", "runs", "records", "record_page"],
          type: "object",
        },
      },
      ...CommonErrors,
    },
    summary: "Search exact trace/grant/run ids and record content across retained records.",
    surface: "reference",
    tags: ["reference", "search"],
  },
  {
    id: "refListConnectors",
    method: "GET",
    path: "/_ref/connectors",
    request: { query: ConnectorListQuerySchema },
    responses: { 200: { schema: ConnectorListResponseSchema }, ...CommonErrors },
    summary: "List configured connection summaries with manifest, latest run, schedule, and freshness.",
    surface: "reference",
    tags: ["reference", "connectors"],
  },
  {
    id: "refGetFleetHealth",
    method: "GET",
    path: "/_ref/fleet-health",
    surface: "reference",
    tags: ["reference", "connectors", "owner"],
    summary: "Get the owner-only composed fleet-health verdict for configured connections.",
    responses: { 200: { schema: FleetHealthVerdictResponseSchema }, ...CommonErrors },
  },
  {
    id: "refGetConnector",
    method: "GET",
    path: "/_ref/connectors/{connectorId}",
    request: { params: ConnectorIdParamSchema },
    responses: { 200: { schema: ConnectorSummarySchema }, ...CommonErrors },
    summary: "Get a single connector with manifest excerpt, schedule, recent runs, and stream summaries.",
    surface: "reference",
    tags: ["reference", "connectors"],
  },
  {
    id: "refListConnections",
    method: "GET",
    path: "/_ref/connections",
    request: { query: ConnectionQuerySchema },
    responses: { 200: { schema: ConnectionListResponseSchema }, ...CommonErrors },
    summary:
      "List owner-facing configured connector connections with labels, lifecycle status, binding metadata, and schedules.",
    surface: "reference",
    tags: ["reference", "connections"],
  },
  {
    id: "refListConnectorInstances",
    method: "GET",
    path: "/_ref/connector-instances",
    request: { query: ConnectionQuerySchema },
    responses: { 200: { schema: ConnectionListResponseSchema }, ...CommonErrors },
    summary: "Compatibility alias for listing configured connector instances behind owner-facing connections.",
    surface: "reference",
    tags: ["reference", "connections"],
  },
  {
    id: "ownerListConnections",
    method: "GET",
    path: "/v1/owner/connections",
    request: { query: ConnectionQuerySchema },
    responses: { 200: { schema: OwnerConnectionListResponseSchema }, ...CommonErrors },
    summary:
      "Owner-agent bearer listing of configured connections with connection_id, connector_key, owner-meaningful display_name, label status, lifecycle fields, and schedules.",
    surface: "reference",
    tags: ["reference", "connections", "owner-agent"],
  },
  {
    id: "ownerListConnectorTemplates",
    method: "GET",
    path: "/v1/owner/connector-templates",
    responses: { 200: { schema: OwnerConnectorTemplateListResponseSchema }, ...CommonErrors },
    summary:
      "Owner-agent bearer listing of connector templates separated from configured connection instances. Embeds related connection summaries and template-level supported_actions for adding new connections as typed intents.",
    surface: "reference",
    tags: ["reference", "connections", "owner-agent"],
  },
  {
    id: "ownerControlCapabilities",
    method: "GET",
    path: "/v1/owner/control",
    responses: { 200: { schema: OwnerControlSurfaceResponseSchema }, ...CommonErrors },
    summary:
      "Owner-agent bearer control entrypoint: capability document naming supported, owner-mediated, and unsupported owner-agent control action families with links to supported routes.",
    surface: "reference",
    tags: ["reference", "owner-agent"],
  },
  {
    id: "ownerSetConnectionDisplayName",
    method: "PATCH",
    path: "/v1/owner/connections/{connectionId}",
    request: {
      body: {
        schema: {
          additionalProperties: false,
          properties: {
            display_name: { maxLength: 200, minLength: 1, type: "string" },
          },
          required: ["display_name"],
          type: "object",
        },
      },
      params: ConnectionIdParamSchema,
    },
    responses: { 200: { schema: OwnerConnectionSchema }, ...CommonErrors },
    summary:
      "Owner-agent bearer rename of the owner-meaningful `display_name` on a connection, addressed by `connection_id`. Owner bearers only; client/mcp_package grants SHALL NOT reach this route. Shares the connector-instance store rename semantics with the cookie-authed `/_ref` PATCH; on success the returned row reports label_status owner_set.",
    surface: "reference",
    tags: ["reference", "connections", "owner-agent"],
  },
  {
    id: "ownerCreateConnectionIntent",
    method: "POST",
    path: "/v1/owner/connections/intents",
    request: { body: { schema: OwnerConnectionIntentRequestSchema } },
    responses: { 201: { schema: OwnerConnectionIntentResponseSchema }, ...CommonErrors },
    summary:
      "Owner-agent bearer: initiate a new connection as a typed, auditable, owner-mediated intent. Returns the shared setup-plan projection (`setup_modality`, `support_state`, `deployment_readiness`, `proof_gate`, `runbook_path`) plus a typed `next_step`; it never marks a connection active. Owner bearers only; client/mcp_package grants SHALL NOT reach this route.",
    surface: "reference",
    tags: ["reference", "connections", "owner-agent"],
  },
  {
    id: "ownerPauseConnectionSchedule",
    method: "POST",
    path: "/v1/owner/connections/{connectionId}/schedule/pause",
    request: { params: ConnectionIdParamSchema },
    responses: { 200: { description: "Paused" }, ...CommonErrors },
    summary:
      "Owner-agent bearer: pause one configured connection's schedule, addressed by `connection_id`, without deleting its config. Owner bearers only; client/mcp_package grants SHALL NOT reach this route. Shares the controller `setScheduleEnabled` semantics with the cookie-authed `/_ref` pause route under a separate owner-bearer auth adapter.",
    surface: "reference",
    tags: ["reference", "runs", "connections", "owner-agent"],
  },
  {
    id: "ownerResumeConnectionSchedule",
    method: "POST",
    path: "/v1/owner/connections/{connectionId}/schedule/resume",
    request: { params: ConnectionIdParamSchema },
    responses: { 200: { description: "Resumed" }, ...CommonErrors },
    summary:
      "Owner-agent bearer: resume one paused configured connection's schedule, addressed by `connection_id`. Owner bearers only; client/mcp_package grants SHALL NOT reach this route. Shares the controller `setScheduleEnabled` semantics with the cookie-authed `/_ref` resume route under a separate owner-bearer auth adapter.",
    surface: "reference",
    tags: ["reference", "runs", "connections", "owner-agent"],
  },
  {
    id: "ownerPauseConnectorSchedule",
    method: "POST",
    path: "/v1/owner/connectors/{connectorId}/schedule/pause",
    request: { params: ConnectorIdParamSchema },
    responses: { 200: { description: "Paused" }, ...CommonErrors },
    summary:
      "Owner-agent bearer: pause a connector's schedule addressed by `connector_id`. Auto-selects the only active connection for that connector. When more than one active connection exists the request is rejected with a typed `ambiguous_connection` (409) carrying the available `connection_id` values and `retry_with: connection_id`. Owner bearers only; client/mcp_package grants SHALL NOT reach this route.",
    surface: "reference",
    tags: ["reference", "runs", "owner-agent"],
  },
  {
    id: "ownerResumeConnectorSchedule",
    method: "POST",
    path: "/v1/owner/connectors/{connectorId}/schedule/resume",
    request: { params: ConnectorIdParamSchema },
    responses: { 200: { description: "Resumed" }, ...CommonErrors },
    summary:
      "Owner-agent bearer: resume a connector's paused schedule addressed by `connector_id`. Auto-selects the only active connection for that connector. When more than one active connection exists the request is rejected with a typed `ambiguous_connection` (409) carrying the available `connection_id` values and `retry_with: connection_id`. Owner bearers only; client/mcp_package grants SHALL NOT reach this route.",
    surface: "reference",
    tags: ["reference", "runs", "owner-agent"],
  },
  {
    id: "ownerDeleteConnectionSchedule",
    method: "DELETE",
    path: "/v1/owner/connections/{connectionId}/schedule",
    request: { params: ConnectionIdParamSchema },
    responses: { 204: { description: "Schedule deleted" }, ...CommonErrors },
    summary:
      "Owner-agent bearer: delete one configured connection's schedule config, addressed by `connection_id`. Returns 204 when the schedule was deleted and a typed 404 when no schedule existed. Owner bearers only; client/mcp_package grants SHALL NOT reach this route. Shares the controller `deleteSchedule` semantics with the cookie-authed `/_ref` delete route under a separate owner-bearer auth adapter.",
    surface: "reference",
    tags: ["reference", "runs", "connections", "owner-agent"],
  },
  {
    id: "ownerDeleteConnectorSchedule",
    method: "DELETE",
    path: "/v1/owner/connectors/{connectorId}/schedule",
    request: { params: ConnectorIdParamSchema },
    responses: { 204: { description: "Schedule deleted" }, ...CommonErrors },
    summary:
      "Owner-agent bearer: delete a connector's schedule config addressed by `connector_id`. Auto-selects the only active connection for that connector. When more than one active connection exists the request is rejected with a typed `ambiguous_connection` (409) carrying the available `connection_id` values and `retry_with: connection_id`. Returns 204 on delete and a typed 404 when no schedule existed. Owner bearers only; client/mcp_package grants SHALL NOT reach this route.",
    surface: "reference",
    tags: ["reference", "runs", "owner-agent"],
  },
  {
    id: "ownerRunConnection",
    method: "POST",
    path: "/v1/owner/connections/{connectionId}/run",
    request: { params: ConnectionIdParamSchema },
    responses: {
      202: { description: "Accepted", schema: RunStartResponseSchema },
      ...CommonErrors,
    },
    summary:
      "Owner-agent bearer: start a run-now for one configured connection, addressed by `connection_id`. Returns 202 with run_id + trace_id, or 409 run_already_active. Owner bearers only; client/mcp_package grants SHALL NOT reach this route. Shares the controller `runNow` semantics with the cookie-authed `/_ref` run route under a separate owner-bearer auth adapter.",
    surface: "reference",
    tags: ["reference", "runs", "connections", "owner-agent"],
  },
  {
    id: "ownerRunConnector",
    method: "POST",
    path: "/v1/owner/connectors/{connectorId}/run",
    request: { params: ConnectorIdParamSchema },
    responses: {
      202: { description: "Accepted", schema: RunStartResponseSchema },
      ...CommonErrors,
    },
    summary:
      "Owner-agent bearer: start a run-now for a connector addressed by `connector_id`. Auto-selects the only active connection for that connector. When more than one active connection exists the request is rejected with a typed `ambiguous_connection` (409) carrying the available `connection_id` values and `retry_with: connection_id`. Returns 202 with run_id + trace_id, or 409 run_already_active. Owner bearers only; client/mcp_package grants SHALL NOT reach this route.",
    surface: "reference",
    tags: ["reference", "runs", "owner-agent"],
  },
  {
    id: "ownerRevokeConnection",
    method: "POST",
    path: "/v1/owner/connections/{connectionId}/revoke",
    request: { params: ConnectionIdParamSchema },
    responses: {
      200: { description: "Revoked", schema: OwnerConnectionRevokeSchema },
      ...CommonErrors,
    },
    summary:
      "Owner-agent bearer: revoke one configured connection, addressed by `connection_id`. Flips the connection to status `revoked` so no future run/ingest lands; already-collected records, spine evidence, device rows, and sibling connections are untouched (zero cascade), and the revoke is durable across owner reads and grant/polyfill scope resolution. A double-revoke returns a typed `connector_instance_inactive` (400). Owner bearers only; client/mcp_package grants SHALL NOT reach this route. `/mcp` owner-bearer rejection is untouched.",
    surface: "reference",
    tags: ["reference", "connections", "owner-agent"],
  },
  {
    id: "ownerRevokeConnector",
    method: "POST",
    path: "/v1/owner/connectors/{connectorId}/revoke",
    request: { params: ConnectorIdParamSchema },
    responses: {
      200: { description: "Revoked", schema: OwnerConnectionRevokeSchema },
      ...CommonErrors,
    },
    summary:
      "Owner-agent bearer: revoke a connector's connection addressed by `connector_id`. Auto-selects the only active connection for that connector. When more than one active connection exists the request is rejected with a typed `ambiguous_connection` (409) carrying the available `connection_id` values and `retry_with: connection_id`. Flips the resolved connection to status `revoked` (zero cascade, durable). Owner bearers only; client/mcp_package grants SHALL NOT reach this route.",
    surface: "reference",
    tags: ["reference", "owner-agent"],
  },
  {
    id: "ownerReactivateConnection",
    method: "POST",
    path: "/v1/owner/connections/{connectionId}/reactivate",
    request: { params: ConnectionIdParamSchema },
    responses: {
      200: { description: "Reactivated", schema: OwnerConnectionReactivateSchema },
      ...CommonErrors,
    },
    summary:
      "Owner-agent bearer: reactivate one revoked connection, addressed by `connection_id`. The clean inverse of `ownerRevokeConnection`: flips the connection from `revoked` back to `active`, clears `revoked_at`, and resumes future collection. Already-collected records, grants, schedule, and audit spine are untouched (zero cascade). A non-revoked (active/draft) connection returns `connector_instance_not_revoked` (409). A foreign/unknown id returns `connector_instance_not_found` (404). Owner bearers only; client/mcp_package grants SHALL NOT reach this route.",
    surface: "reference",
    tags: ["reference", "connections", "owner-agent"],
  },
  {
    id: "ownerReactivateConnector",
    method: "POST",
    path: "/v1/owner/connectors/{connectorId}/reactivate",
    request: { params: ConnectorIdParamSchema },
    responses: {
      200: { description: "Reactivated", schema: OwnerConnectionReactivateSchema },
      ...CommonErrors,
    },
    summary:
      "Owner-agent bearer: reactivate a connector's revoked connection addressed by `connector_id`. Auto-selects the only revoked connection for that connector. When more than one connection exists the request is rejected with a typed `ambiguous_connection` (409). Flips the resolved connection from `revoked` to `active` (zero cascade). Owner bearers only.",
    surface: "reference",
    tags: ["reference", "owner-agent"],
  },
  {
    id: "ownerDeleteConnection",
    method: "DELETE",
    path: "/v1/owner/connections/{connectionId}",
    request: { params: ConnectionIdParamSchema },
    responses: {
      200: { description: "Deleted", schema: OwnerConnectionDeleteSchema },
      ...CommonErrors,
    },
    summary:
      "Owner-agent bearer: DESTRUCTIVELY delete one configured connection, addressed by `connection_id`. Erases that connection's records, record-change history, version counters, blobs, blob bindings, search indices, and attention records, deletes its schedule, clears its device source-instance back-reference, and removes the connector_instances row — all keyed strictly on one connection_id, never widening to connector_id (sibling connections of the same connector type are untouched). It does NOT erase a running collection: a connection with an in-flight run is REFUSED, not deleted (no active-run row is erased while running). The source-of-truth deletion (records, history, version counters, blobs, blob bindings, attention, schedule, device back-ref, and the connector_instances row) is transactional all-or-nothing across one connector_instance_id; the search-index teardown is a rebuildable projection cleaned up after that commit. PRESERVES the audit spine (appending an owner_agent.connection.delete event), disclosure grants, and the device edge. Delete is NOT revoke: it erases the past and removes the configuration, where revoke only stops the future. A repeat/unknown/foreign-owner id returns a typed `connector_instance_not_found` (404) without leaking existence. An in-flight run returns `connection_run_active` (409). A default-account binding returns `default_account_delete_unsupported` (409) — revoke it instead. Owner bearers only; client/mcp_package grants SHALL NOT reach this route. `/mcp` owner-bearer rejection is untouched.",
    surface: "reference",
    tags: ["reference", "connections", "owner-agent"],
  },
  {
    id: "ownerDeleteConnector",
    method: "DELETE",
    path: "/v1/owner/connectors/{connectorId}",
    request: { params: ConnectorIdParamSchema },
    responses: {
      200: { description: "Deleted", schema: OwnerConnectionDeleteSchema },
      ...CommonErrors,
    },
    summary:
      "Owner-agent bearer: DESTRUCTIVELY delete a connector's connection addressed by `connector_id`. Auto-selects the only active connection for that connector. When more than one active connection exists the request is rejected with a typed `ambiguous_connection` (409) carrying the available `connection_id` values and `retry_with: connection_id`. Erases the resolved connection's data + configuration per the connection-scoped cascade (see ownerDeleteConnection). Owner bearers only; client/mcp_package grants SHALL NOT reach this route.",
    surface: "reference",
    tags: ["reference", "owner-agent"],
  },
  {
    id: "ownerInspectConnectionDiagnostics",
    method: "GET",
    path: "/v1/owner/connections/{connectionId}/diagnostics",
    request: { params: ConnectionIdParamSchema },
    responses: { 200: { schema: OwnerConnectionDiagnosticsSchema }, ...CommonErrors },
    summary:
      "Owner-agent bearer: read connection-scoped diagnostics for one configured connection, addressed by `connection_id` — last run status, last successful run, last successful ingest time, current schedule state, freshness, and a typed health classification. Connection-scoped by construction: the response describes only the addressed connection and carries no device-exporter subsystem or sibling-connection state. Owner bearers only; client/mcp_package grants SHALL NOT reach this route.",
    surface: "reference",
    tags: ["reference", "connections", "owner-agent"],
  },
  {
    id: "ownerInspectConnectorDiagnostics",
    method: "GET",
    path: "/v1/owner/connectors/{connectorId}/diagnostics",
    request: { params: ConnectorIdParamSchema },
    responses: { 200: { schema: OwnerConnectionDiagnosticsSchema }, ...CommonErrors },
    summary:
      "Owner-agent bearer: read connection-scoped diagnostics for a connector addressed by `connector_id`. Auto-selects the only active connection for that connector. When more than one active connection exists the request is rejected with a typed `ambiguous_connection` (409) carrying the available `connection_id` values and `retry_with: connection_id`. Owner bearers only; client/mcp_package grants SHALL NOT reach this route.",
    surface: "reference",
    tags: ["reference", "connections", "owner-agent"],
  },
  {
    id: "refGetConnection",
    method: "GET",
    path: "/_ref/connections/{connectorInstanceId}",
    request: { params: ConnectorInstanceIdParamSchema },
    responses: { 200: { schema: RefConnectionSchema }, ...CommonErrors },
    summary: "Get one owner-facing configured connector connection by connector instance id.",
    surface: "reference",
    tags: ["reference", "connections"],
  },
  {
    id: "refGetConnectorInstance",
    method: "GET",
    path: "/_ref/connector-instances/{connectorInstanceId}",
    request: { params: ConnectorInstanceIdParamSchema },
    responses: { 200: { schema: RefConnectionSchema }, ...CommonErrors },
    summary: "Compatibility alias for reading one configured connector instance behind an owner-facing connection.",
    surface: "reference",
    tags: ["reference", "connections"],
  },
  {
    id: "refSetConnectionDisplayName",
    method: "PATCH",
    path: "/_ref/connections/{connectorInstanceId}",
    request: {
      body: {
        schema: {
          additionalProperties: false,
          properties: {
            display_name: { maxLength: 200, minLength: 1, type: "string" },
          },
          required: ["display_name"],
          type: "object",
        },
      },
      params: ConnectorInstanceIdParamSchema,
    },
    responses: { 200: { schema: RefConnectionSchema }, ...CommonErrors },
    summary:
      "Owner-authenticated mutation of the owner-meaningful `display_name` carried on the public read contract. Operator-only surface; grant-authorized tokens SHALL NOT reach this route.",
    surface: "reference",
    tags: ["reference", "connections"],
  },
  {
    id: "refListApprovals",
    method: "GET",
    path: "/_ref/approvals",
    responses: {
      200: {
        schema: {
          additionalProperties: false,
          properties: {
            data: { items: ApprovalItemSchema, type: "array" },
            object: { const: "list" },
          },
          required: ["object", "data"],
          type: "object",
        },
      },
      ...CommonErrors,
    },
    summary: "List pending approvals across provider-connect consents and owner-device flows.",
    surface: "reference",
    tags: ["reference", "grants"],
  },
  {
    id: "refCreateDeviceExporterEnrollmentCode",
    method: "POST",
    path: "/_ref/device-exporters/enrollment-codes",
    request: { body: { schema: DeviceEnrollmentCodeCreateBodySchema } },
    responses: { 201: { description: "Created", schema: DeviceEnrollmentCodeResponseSchema }, ...DeviceExporterErrors },
    summary: "Create a short-lived local device exporter enrollment code for an owner-approved connector binding.",
    surface: "reference",
    tags: ["reference", "device-exporters"],
  },
  {
    id: "refExchangeDeviceExporterEnrollmentCode",
    method: "POST",
    path: "/_ref/device-exporters/enroll",
    request: { body: { schema: DeviceEnrollmentExchangeBodySchema } },
    responses: {
      201: { description: "Created", schema: DeviceEnrollmentExchangeResponseSchema },
      ...DeviceExporterErrors,
    },
    summary: "Exchange a one-time enrollment code for a device-scoped local exporter credential.",
    surface: "reference",
    tags: ["reference", "device-exporters"],
  },
  {
    id: "refListDeviceExporters",
    method: "GET",
    path: "/_ref/device-exporters",
    responses: {
      200: {
        schema: {
          additionalProperties: false,
          properties: {
            data: { items: DeviceExporterSchema, type: "array" },
            object: { const: "list" },
          },
          required: ["object", "data"],
          type: "object",
        },
      },
      ...DeviceExporterErrors,
    },
    summary: "List enrolled local device exporters and their source-instance diagnostics.",
    surface: "reference",
    tags: ["reference", "device-exporters"],
  },
  {
    id: "refListDeviceExporterSourceInstances",
    method: "GET",
    path: "/_ref/device-exporters/source-instances",
    request: {
      query: {
        additionalProperties: false,
        properties: { device_id: { type: "string" } },
        type: "object",
      },
    },
    responses: {
      200: {
        schema: {
          additionalProperties: false,
          properties: {
            data: { items: DeviceSourceInstanceSchema, type: "array" },
            object: { const: "list" },
          },
          required: ["object", "data"],
          type: "object",
        },
      },
      ...DeviceExporterErrors,
    },
    summary:
      "List local device exporter source instances without promoting source-instance identity to the public PDPP contract.",
    surface: "reference",
    tags: ["reference", "device-exporters"],
  },
  {
    id: "refListDeviceExporterDiagnostics",
    method: "GET",
    path: "/_ref/device-exporters/diagnostics",
    responses: {
      200: {
        schema: {
          additionalProperties: false,
          properties: {
            data: { items: DeviceExporterSchema, type: "array" },
            object: { const: "list" },
          },
          required: ["object", "data"],
          type: "object",
        },
      },
      ...DeviceExporterErrors,
    },
    summary: "List owner/operator diagnostics for local device exporters, including heartbeat and ingest freshness.",
    surface: "reference",
    tags: ["reference", "device-exporters"],
  },
  {
    id: "refRevokeDeviceExporter",
    method: "POST",
    path: "/_ref/device-exporters/{deviceId}/revoke",
    request: { params: DeviceIdParamSchema },
    responses: {
      200: {
        schema: {
          additionalProperties: false,
          properties: {
            device_id: { type: "string" },
            object: { const: "device_exporter_revocation" },
            revoked_at: { type: "string" },
          },
          required: ["object", "device_id", "revoked_at"],
          type: "object",
        },
      },
      ...DeviceExporterErrors,
    },
    summary: "Revoke a local device exporter credential and stop future heartbeats or ingest from that device.",
    surface: "reference",
    tags: ["reference", "device-exporters"],
  },
  {
    id: "refSelfRevokeDeviceExporter",
    method: "POST",
    path: "/_ref/device-exporters/{deviceId}/self-revoke",
    request: { params: DeviceIdParamSchema },
    responses: {
      200: {
        schema: {
          additionalProperties: false,
          properties: {
            device_id: { type: "string" },
            object: { const: "device_exporter_revocation" },
            revoked_at: { type: "string" },
          },
          required: ["object", "device_id", "revoked_at"],
          type: "object",
        },
      },
      ...DeviceExporterErrors,
    },
    summary:
      "Revoke a local device exporter's own credential using its own device bearer token. A device credential may " +
      "only revoke itself, never another device; the path deviceId must match the authenticated credential's " +
      "device. Used by local-collector `logout` to close the server-side lane before deleting local credentials.",
    surface: "reference",
    tags: ["reference", "device-exporters"],
  },
  {
    id: "refHeartbeatDeviceExporter",
    method: "POST",
    path: "/_ref/device-exporters/{deviceId}/heartbeat",
    request: { body: { schema: DeviceHeartbeatBodySchema }, params: DeviceIdParamSchema },
    responses: { 200: { schema: DeviceHeartbeatResponseSchema }, ...DeviceExporterErrors },
    summary: "Accept a heartbeat from a device-scoped local exporter credential.",
    surface: "reference",
    tags: ["reference", "device-exporters"],
  },
  {
    id: "refIngestDeviceExporterBatch",
    method: "POST",
    path: "/_ref/device-exporters/{deviceId}/ingest-batches",
    request: { body: { schema: DeviceIngestBatchBodySchema }, params: DeviceIdParamSchema },
    responses: {
      200: { schema: DeviceIngestBatchResponseSchema },
      201: { description: "Created", schema: DeviceIngestBatchResponseSchema },
      ...DeviceExporterErrors,
    },
    summary: "Accept an idempotent source-instance-aware ingest batch from a local device exporter.",
    surface: "reference",
    tags: ["reference", "device-exporters"],
  },
  {
    id: "refGetDeviceExporterSourceInstanceState",
    method: "GET",
    path: "/_ref/device-exporters/{deviceId}/source-instances/{sourceInstanceId}/state",
    request: { params: DeviceSourceInstanceStateParamSchema },
    responses: {
      200: { schema: DeviceSourceInstanceStateResponseSchema },
      ...DeviceExporterErrors,
    },
    summary:
      "Read device-scoped local collector state for a source instance. Owner-token and client-token routes do not accept device credentials and vice versa.",
    surface: "reference",
    tags: ["reference", "device-exporters"],
  },
  {
    id: "refPutDeviceExporterSourceInstanceState",
    method: "PUT",
    path: "/_ref/device-exporters/{deviceId}/source-instances/{sourceInstanceId}/state",
    request: {
      body: { schema: DeviceSourceInstanceStatePutBodySchema },
      params: DeviceSourceInstanceStateParamSchema,
    },
    responses: {
      200: { schema: DeviceSourceInstanceStateResponseSchema },
      ...DeviceExporterErrors,
    },
    summary:
      "Persist device-scoped local collector state for a source instance. State is a stream-keyed map; existing streams are merged with last-write-wins semantics.",
    surface: "reference",
    tags: ["reference", "device-exporters"],
  },
  {
    id: "refListSchedules",
    method: "GET",
    path: "/_ref/schedules",
    responses: { 200: { description: "Schedule list" }, ...CommonErrors },
    summary: "List all configured schedules with runtime status.",
    surface: "reference",
    tags: ["reference", "runs"],
  },
  {
    id: "refRunConnector",
    method: "POST",
    path: "/_ref/connectors/{connectorId}/run",
    request: { params: ConnectorIdParamSchema },
    responses: {
      202: { description: "Accepted", schema: RunStartResponseSchema },
      ...CommonErrors,
    },
    summary: "Start a connector run asynchronously. Returns 202 with run_id + trace_id, or 409 run_already_active.",
    surface: "reference",
    tags: ["reference", "runs"],
  },
  {
    id: "refRunConnection",
    method: "POST",
    path: "/_ref/connections/{connectorInstanceId}/run",
    request: { params: ConnectorInstanceIdParamSchema },
    responses: {
      202: { description: "Accepted", schema: RunStartResponseSchema },
      ...CommonErrors,
    },
    summary:
      "Start a connector run for one configured connection. Returns 202 with run_id + trace_id, or 409 run_already_active.",
    surface: "reference",
    tags: ["reference", "runs", "connections"],
  },
  {
    id: "refPutConnectorSchedule",
    method: "PUT",
    path: "/_ref/connectors/{connectorId}/schedule",
    request: {
      body: { contentType: "application/json", schema: ScheduleUpsertBodySchema },
      params: ConnectorIdParamSchema,
    },
    responses: { 200: { description: "Schedule upserted" }, ...CommonErrors },
    summary: "Create or replace the single schedule for a connector.",
    surface: "reference",
    tags: ["reference", "runs"],
  },
  {
    id: "refPutConnectionSchedule",
    method: "PUT",
    path: "/_ref/connections/{connectorInstanceId}/schedule",
    request: {
      body: { contentType: "application/json", schema: ScheduleUpsertBodySchema },
      params: ConnectorInstanceIdParamSchema,
    },
    responses: { 200: { description: "Schedule upserted" }, ...CommonErrors },
    summary: "Create or replace the schedule for one configured connection.",
    surface: "reference",
    tags: ["reference", "runs", "connections"],
  },
  {
    id: "refPauseConnectorSchedule",
    method: "POST",
    path: "/_ref/connectors/{connectorId}/schedule/pause",
    request: { params: ConnectorIdParamSchema },
    responses: { 200: { description: "Paused" }, ...CommonErrors },
    summary: "Pause the connector schedule without deleting its config.",
    surface: "reference",
    tags: ["reference", "runs"],
  },
  {
    id: "refPauseConnectionSchedule",
    method: "POST",
    path: "/_ref/connections/{connectorInstanceId}/schedule/pause",
    request: { params: ConnectorInstanceIdParamSchema },
    responses: { 200: { description: "Paused" }, ...CommonErrors },
    summary: "Pause one configured connection schedule without deleting its config.",
    surface: "reference",
    tags: ["reference", "runs", "connections"],
  },
  {
    id: "refResumeConnectorSchedule",
    method: "POST",
    path: "/_ref/connectors/{connectorId}/schedule/resume",
    request: { params: ConnectorIdParamSchema },
    responses: { 200: { description: "Resumed" }, ...CommonErrors },
    summary: "Resume a paused connector schedule.",
    surface: "reference",
    tags: ["reference", "runs"],
  },
  {
    id: "refResumeConnectionSchedule",
    method: "POST",
    path: "/_ref/connections/{connectorInstanceId}/schedule/resume",
    request: { params: ConnectorInstanceIdParamSchema },
    responses: { 200: { description: "Resumed" }, ...CommonErrors },
    summary: "Resume one paused configured connection schedule.",
    surface: "reference",
    tags: ["reference", "runs", "connections"],
  },
  {
    id: "refDeleteConnectorSchedule",
    method: "DELETE",
    path: "/_ref/connectors/{connectorId}/schedule",
    request: { params: ConnectorIdParamSchema },
    responses: { 204: { description: "Deleted" }, ...CommonErrors },
    summary: "Delete the connector schedule config.",
    surface: "reference",
    tags: ["reference", "runs"],
  },
  {
    id: "refDeleteConnectionSchedule",
    method: "DELETE",
    path: "/_ref/connections/{connectorInstanceId}/schedule",
    request: { params: ConnectorInstanceIdParamSchema },
    responses: { 204: { description: "Deleted" }, ...CommonErrors },
    summary: "Delete the schedule config for one configured connection.",
    surface: "reference",
    tags: ["reference", "runs", "connections"],
  },
  {
    id: "refRevokeConnection",
    method: "POST",
    path: "/_ref/connections/{connectorInstanceId}/revoke",
    request: { params: ConnectorInstanceIdParamSchema },
    responses: { 200: { description: "Revoked" }, ...CommonErrors },
    summary:
      "Owner-session: revoke one configured connection, addressed by `connection_id`. Flips the connection to status `revoked` so no future run/ingest lands; already-collected records, grants, spine evidence, device rows, and sibling connections are untouched (zero cascade). A double-revoke returns a typed `connector_instance_inactive` (400). Owner-session only (operator console); shares the same connector-instance store soft-flip primitive and audit event type as the owner-agent bearer `ownerRevokeConnection` route under a cookie auth adapter.",
    surface: "reference",
    tags: ["reference", "connections"],
  },
  {
    id: "refReactivateConnection",
    method: "POST",
    path: "/_ref/connections/{connectorInstanceId}/reactivate",
    request: { params: ConnectorInstanceIdParamSchema },
    responses: { 200: { description: "Reactivated" }, ...CommonErrors },
    summary:
      "Owner-session: reactivate one revoked connection, addressed by `connection_id`. The clean inverse of `refRevokeConnection`: flips the connection from `revoked` back to `active`, clears `revoked_at`, and resumes future collection. Already-collected records, grants, schedule, and audit spine are untouched (zero cascade). A non-revoked (active/draft) connection returns `connector_instance_not_revoked` (409). A foreign/unknown id returns `connector_instance_not_found` (404). Owner-session only (operator console); shares the same connector-instance store soft-flip primitive and audit event type as the owner-agent bearer `ownerReactivateConnection` route under a cookie auth adapter.",
    surface: "reference",
    tags: ["reference", "connections"],
  },
  {
    id: "refDeleteConnection",
    method: "DELETE",
    path: "/_ref/connections/{connectorInstanceId}",
    request: { params: ConnectorInstanceIdParamSchema },
    responses: { 200: { description: "Deleted" }, ...CommonErrors },
    summary:
      "Owner-session: DESTRUCTIVELY delete one configured connection, addressed by `connection_id`. Erases exactly that connection's records, history, blobs, search indices, and attention, deletes its schedule, clears its device source-instance back-reference, and removes the connector_instances row — keyed strictly on one connection_id, never widening to connector_id (sibling connections untouched). A connection with an in-flight run is REFUSED (`connection_run_active` 409), and a default-account binding is REFUSED (`default_account_delete_unsupported` 409). A repeat/unknown/foreign-owner id returns a typed `connector_instance_not_found` (404). PRESERVES the audit spine (appending an owner_agent.connection.delete event), disclosure grants, and the device edge. Owner-session only (operator console); shares the same `deleteConnection` cascade and audit event type as the owner-agent bearer `ownerDeleteConnection` route under a cookie auth adapter.",
    surface: "reference",
    tags: ["reference", "connections"],
  },
  {
    id: "refRunInteraction",
    method: "POST",
    path: "/_ref/runs/{runId}/interaction",
    request: {
      body: {
        contentType: "application/json",
        schema: {
          additionalProperties: false,
          properties: {
            data: {
              additionalProperties: true,
              type: "object",
            },
            interaction_id: { minLength: 1, type: "string" },
            status: { enum: ["success", "cancelled"], type: "string" },
          },
          required: ["interaction_id", "status"],
          type: "object",
        },
      },
      params: {
        additionalProperties: false,
        properties: { runId: { minLength: 1, type: "string" } },
        required: ["runId"],
        type: "object",
      },
    },
    responses: {
      202: {
        description: "Accepted",
        schema: {
          additionalProperties: false,
          properties: {
            interaction_id: { type: "string" },
            object: { const: "run_interaction_ack" },
            run_id: { type: "string" },
            status: { enum: ["success", "cancelled"], type: "string" },
          },
          required: ["object", "run_id", "interaction_id", "status"],
          type: "object",
        },
      },
      ...CommonErrors,
    },
    summary:
      "Owner-only control surface: answer the current pending interaction for an active controller-managed run. Reference-only; not part of the public PDPP API.",
    surface: "reference",
    tags: ["reference", "runs"],
  },
  {
    id: "refRecordsTimeline",
    method: "GET",
    path: "/_ref/records/timeline",
    request: {
      query: {
        additionalProperties: false,
        properties: {
          connector_id: { type: "string" },
          limit: { maximum: 500, minimum: 1, type: "integer" },
          order: { enum: ["asc", "desc"], type: "string" },
          since: { type: "string" },
          stream: { type: "string" },
          timestamp_mode: { enum: ["native", "ingest"], type: "string" },
          until: { type: "string" },
        },
        type: "object",
      },
    },
    responses: {
      200: {
        schema: {
          additionalProperties: false,
          properties: {
            data: { items: TimelineEntrySchema, type: "array" },
            meta: {
              additionalProperties: false,
              properties: {
                bounded: { type: "boolean" },
                filters: {
                  additionalProperties: false,
                  properties: {
                    connector_id: { type: ["string", "null"] },
                    since: { type: ["string", "null"] },
                    stream: { type: ["string", "null"] },
                    until: { type: ["string", "null"] },
                  },
                  required: ["connector_id", "stream", "since", "until"],
                  type: "object",
                },
                limit: { type: "integer" },
                ordering: { type: "string" },
                timestamp_mode: { enum: ["native", "ingest"], type: "string" },
              },
              required: ["bounded", "ordering", "limit", "timestamp_mode", "filters"],
              type: "object",
            },
            object: { const: "list" },
          },
          required: ["object", "data", "meta"],
          type: "object",
        },
      },
      ...CommonErrors,
    },
    summary: "Server-backed cross-connector recent-record feed for the Records > Timeline UI.",
    surface: "reference",
    tags: ["reference", "records"],
  },
  {
    id: "refDatasetSummary",
    method: "GET",
    path: "/_ref/dataset/summary",
    request: {},
    responses: {
      200: {
        schema: DatasetSummaryResponseSchema,
      },
      ...CommonErrors,
    },
    summary:
      "Projection-backed dataset summary: record counts, retained-history bytes, timespan bounds, top connectors, and freshness metadata.",
    surface: "reference",
    tags: ["reference", "dataset"],
  },
  {
    id: "refDatasetSummaryStreams",
    method: "GET",
    path: "/_ref/dataset/summary/streams",
    request: {
      query: {
        additionalProperties: false,
        properties: {
          connector_id: { type: "string" },
        },
        type: "object",
      },
    },
    responses: {
      200: {
        schema: DatasetSummaryStreamsResponseSchema,
      },
      ...CommonErrors,
    },
    summary:
      "Per-(connector_id, stream) rows from the dataset-summary projection. NULL/dirty time bounds pass through honestly.",
    surface: "reference",
    tags: ["reference", "dataset"],
  },
  {
    id: "refDatasetSummaryRebuild",
    method: "POST",
    path: "/_ref/dataset/summary/rebuild",
    request: {},
    responses: {
      200: {
        schema: DatasetSummaryResponseSchema,
      },
      ...CommonErrors,
    },
    summary: "Owner-triggered rebuild of the projection-backed dataset summary from durable reference state.",
    surface: "reference",
    tags: ["reference", "dataset"],
  },
  {
    id: "refDatasetSummaryReconcile",
    method: "POST",
    path: "/_ref/dataset/summary/reconcile",
    request: {},
    responses: {
      200: {
        schema: {
          additionalProperties: false,
          properties: {
            deferred: { minimum: 0, type: "integer" },
            object: { const: "dataset_summary_reconcile" },
            reconciled: { minimum: 0, type: "integer" },
            summary: DatasetSummaryResponseSchema,
          },
          required: ["object", "reconciled", "deferred", "summary"],
          type: "object",
        },
      },
      ...CommonErrors,
    },
    summary: "Owner-triggered reconciliation of dirty dataset-summary record-time bounds from durable reference state.",
    surface: "reference",
    tags: ["reference", "dataset"],
  },
  {
    id: "refDatasetSize",
    method: "GET",
    path: "/_ref/dataset/size",
    request: {
      query: {
        additionalProperties: false,
        properties: {
          connector_instance_id: { type: "string" },
          grain: { enum: ["global", "connection", "stream"], type: "string" },
          stream: { type: "string" },
        },
        type: "object",
      },
    },
    responses: {
      200: { schema: RetainedSizeResponseSchema },
      ...CommonErrors,
    },
    summary: "Projection-backed retained logical bytes by finite dataset grain.",
    surface: "reference",
    tags: ["reference", "dataset"],
  },
  {
    id: "refDatasetTop",
    method: "GET",
    path: "/_ref/dataset/top",
    request: {
      query: {
        additionalProperties: false,
        properties: {
          limit: { maximum: 25, minimum: 1, type: "integer" },
          measure: {
            enum: [
              "total_retained_bytes",
              "current_record_json_bytes",
              "record_history_json_bytes",
              "blob_bytes",
              "record_count",
              "record_history_count",
              "blob_count",
            ],
            type: "string",
          },
          scope: { enum: ["connection", "stream", "record", "blob"], type: "string" },
        },
        type: "object",
      },
    },
    responses: {
      200: { schema: RetainedSizeTopResponseSchema },
      ...CommonErrors,
    },
    summary: "Bounded retained-size heavy hitters for owner dataset introspection.",
    surface: "reference",
    tags: ["reference", "dataset"],
  },
  {
    id: "refRecordsVersionStats",
    method: "GET",
    path: "/_ref/records/version-stats",
    request: {
      query: {
        additionalProperties: false,
        properties: {
          connector_instance_id: { type: "string" },
          limit: { maximum: 500, minimum: 1, type: "integer" },
          risk: { enum: ["normal", "watch", "high"], type: "string" },
          stream: { type: "string" },
        },
        type: "object",
      },
    },
    responses: {
      200: { schema: RecordVersionStatsResponseSchema },
      ...CommonErrors,
    },
    summary: "Record-version churn stats with projection and record-change authority for owner diagnostics.",
    surface: "reference",
    tags: ["reference", "records"],
  },
  {
    id: "refDatasetSizeRebuild",
    method: "POST",
    path: "/_ref/dataset/size/rebuild",
    request: {},
    responses: {
      200: {
        schema: {
          additionalProperties: false,
          properties: {
            object: { const: "ref_dataset_size_rebuild" },
            projection: RetainedSizeRowSchema,
          },
          required: ["object", "projection"],
          type: "object",
        },
      },
      ...CommonErrors,
    },
    summary: "Owner-triggered rebuild of retained-size projection rows from durable reference state.",
    surface: "reference",
    tags: ["reference", "dataset"],
  },
  {
    id: "refDatasetSizeReconcile",
    method: "POST",
    path: "/_ref/dataset/size/reconcile",
    request: {},
    responses: {
      200: {
        schema: {
          additionalProperties: false,
          properties: {
            connections: { minimum: 0, type: "integer" },
            object: { const: "ref_dataset_size_reconcile" },
            projection: RetainedSizeRowSchema,
            streams: { minimum: 0, type: "integer" },
          },
          required: ["object", "streams", "connections", "projection"],
          type: "object",
        },
      },
      ...CommonErrors,
    },
    summary: "Owner-triggered reconciliation of dirty retained-size projection rows from durable reference state.",
    surface: "reference",
    tags: ["reference", "dataset"],
  },
  {
    id: "refListEventSubscriptions",
    method: "GET",
    path: "/_ref/event-subscriptions",
    request: {
      query: {
        additionalProperties: false,
        properties: {
          client_id: { minLength: 1, type: "string" },
          grant_id: { minLength: 1, type: "string" },
          status: EventSubscriptionStatusSchema,
        },
        type: "object",
      },
    },
    responses: {
      200: { schema: RefEventSubscriptionListResponseSchema },
    },
    summary:
      "Operator oversight: list all client event subscriptions. Filter by `client_id`, `grant_id`, or `status`. Secrets are never returned on `/_ref` routes.",
    surface: "reference",
    tags: ["event-subscriptions", "reference"],
  },
  {
    id: "refGetEventSubscription",
    method: "GET",
    path: "/_ref/event-subscriptions/{subscription_id}",
    request: { params: EventSubscriptionIdParamSchema },
    responses: {
      200: { schema: RefEventSubscriptionDetailSchema },
      404: { description: "Subscription not found", schema: ErrorObjectSchema },
    },
    summary: "Operator oversight: get a single subscription with delivery attempt history.",
    surface: "reference",
    tags: ["event-subscriptions", "reference"],
  },
  {
    id: "refDisableEventSubscription",
    method: "POST",
    path: "/_ref/event-subscriptions/{subscription_id}/disable",
    request: {
      body: {
        contentType: "application/json",
        required: false,
        schema: {
          additionalProperties: false,
          properties: {
            reason: { minLength: 1, type: "string" },
          },
          type: "object",
        },
      },
      params: EventSubscriptionIdParamSchema,
    },
    responses: {
      200: { description: "Subscription after disabling.", schema: RefEventSubscriptionDetailSchema },
      400: { description: "Invalid request", schema: ErrorObjectSchema },
      404: { description: "Subscription not found", schema: ErrorObjectSchema },
    },
    summary:
      "Operator safety valve: forcibly disable a subscription. Accepts an optional `reason` string. Secrets are never returned.",
    surface: "reference",
    tags: ["event-subscriptions", "reference"],
  },
  {
    id: "refExploreRecordBuckets",
    method: "GET",
    path: "/_ref/explore/records/buckets",
    request: {
      query: {
        additionalProperties: false,
        properties: {
          connection: { type: "string" },
          connection_id: { type: "string" },
          connections: { type: "string" },
          granularity: { enum: ["auto", "hour", "day", "week", "month", "quarter", "year"], type: "string" },
          since: { type: "string" },
          stream: { type: "string" },
          streams: { type: "string" },
          time_zone: { const: "UTC" },
          until: { type: "string" },
          xconnection: { type: "string" },
          xconnection_id: { type: "string" },
          xconnections: { type: "string" },
          xstream: { type: "string" },
          xstreams: { type: "string" },
        },
        type: "object",
      },
    },
    responses: {
      200: { schema: ExploreRecordBucketsResponseSchema },
      ...CommonErrors,
    },
    summary:
      "Owner Explore surface: exact dense over-time bucket counts across the scoped merged record set. " +
      "The server derives populated extent and auto granularity in one owner-session call.",
    surface: "reference",
    tags: ["explore", "reference"],
  },
  {
    id: "refExploreRecords",
    method: "GET",
    path: "/_ref/explore/records",
    request: {
      query: {
        additionalProperties: true,
        properties: {
          connection_id: { type: "string" },
          cursor: { type: "string" },
          limit: { maximum: 500, minimum: 1, type: "integer" },
          // REWIND: when "1"/"true" AND `cursor` is set, re-render page 1 pinned
          // to the cursor's ORIGINAL snapshot (snapshotSeq) instead of capturing a
          // fresh snapshot. The console "Load more" accumulator uses this for page 1
          // so an after-snapshot backfill can never displace an original page-1 row.
          rewind: { enum: ["1", "true"], type: "string" },
          stream: { type: "string" },
        },
        type: "object",
      },
    },
    responses: {
      200: {
        schema: ExploreRecordsResponseSchema,
      },
      400: { description: "Invalid cursor or request parameters", schema: ErrorObjectSchema },
    },
    summary:
      "Owner Explore surface: cross-source merged timeline with a single composite keyset cursor. " +
      "Returns time-ordered records (<= a pinned now boundary) spanning all (connection, stream) " +
      "partitions with point-in-time snapshot stability, a new_since_snapshot count for the N-new pill, " +
      "and a SEPARATE upcoming (future-dated) projection with a true upcoming_total count.",
    surface: "reference",
    tags: ["explore", "reference"],
  },
];
