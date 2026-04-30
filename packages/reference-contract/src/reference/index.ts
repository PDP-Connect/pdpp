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
    source_instance_id: { type: "string" },
    device_token: { type: "string" },
    connector_id: { type: "string" },
    local_binding_name: { type: "string" },
  },
  required: ["object", "device_id", "source_instance_id", "device_token", "connector_id", "local_binding_name"],
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
    "source_instance_id",
    "batch_id",
    "body_hash",
    "status",
    "accepted_record_count",
    "rejected_record_count",
  ],
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
    summary: "List registered connectors with manifest summary, latest run summary, schedule summary, and freshness.",
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
    responses: { 201: { schema: DeviceEnrollmentExchangeResponseSchema, description: "Created" }, ...DeviceExporterErrors },
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
    summary: "List local device exporter source instances without promoting source-instance identity to the public PDPP contract.",
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
      "Aggregate dataset summary: live record counts, retained-history bytes, timespan bounds, and top connectors.",
    request: {},
    responses: {
      200: {
        schema: {
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
          ],
        },
      },
      ...CommonErrors,
    },
  },
];
