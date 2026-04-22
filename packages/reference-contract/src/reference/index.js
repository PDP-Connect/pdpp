// Reference-only /_ref route manifests.
//
// These are reference-designated operator/control surfaces. They belong in
// the full OpenAPI artifact and in reference-implementation docs, but NOT in
// the public PDPP contract surface.

import { ErrorObjectSchema, FreshnessSchema } from '../common/index.js';

const ConnectorSummarySchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    connector_id: { type: 'string' },
    display_name: { type: 'string' },
    manifest_version: { type: 'string' },
    streams: { type: 'array', items: { type: 'string' } },
    freshness: FreshnessSchema,
    schedule: {
      type: ['object', 'null'],
      additionalProperties: true,
      properties: {
        interval_seconds: { type: 'integer' },
        jitter_seconds: { type: 'integer' },
        enabled: { type: 'boolean' },
        next_due_at: { type: ['string', 'null'] },
      },
    },
    last_run: {
      type: ['object', 'null'],
      additionalProperties: true,
      properties: {
        run_id: { type: 'string' },
        status: { type: 'string' },
        started_at: { type: 'string' },
        finished_at: { type: ['string', 'null'] },
      },
    },
  },
  required: ['connector_id'],
};

const ConnectorListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    object: { const: 'list' },
    data: { type: 'array', items: ConnectorSummarySchema },
  },
  required: ['object', 'data'],
};

const ScheduleUpsertBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    interval_seconds: { type: 'integer', minimum: 1 },
    jitter_seconds: { type: 'integer', minimum: 0 },
    enabled: { type: 'boolean' },
  },
  required: ['interval_seconds'],
};

const RunStartResponseSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    run_id: { type: 'string' },
    trace_id: { type: 'string' },
  },
  required: ['run_id'],
};

const ApprovalItemSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    object: { const: 'approval' },
    approval_id: { type: 'string' },
    kind: { type: 'string', enum: ['consent', 'owner_device'] },
    client_id: { type: ['string', 'null'] },
    grant_preview: { type: 'object' },
    created_at: { type: 'string' },
  },
  required: ['object', 'approval_id', 'kind'],
};

const RefSearchRecordSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    connector_id: { type: 'string' },
    stream: { type: 'string' },
    id: { type: 'string' },
    emitted_at: { type: 'string' },
    data: { type: ['object', 'null'] },
    matched_field: { type: ['string', 'null'] },
    snippet: { type: ['string', 'null'] },
    native_timestamp: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        field: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['field', 'value'],
    },
  },
  required: ['connector_id', 'stream', 'id', 'emitted_at'],
};

const RecordPageSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer' },
    offset: { type: 'integer' },
    returned: { type: 'integer' },
    total: { type: 'integer' },
    has_more: { type: 'boolean' },
    next_cursor: { type: ['string', 'null'] },
    prev_cursor: { type: ['string', 'null'] },
    sort: { type: 'string', enum: ['native', 'ingested'] },
    order: { type: 'string', enum: ['asc', 'desc'] },
    filters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        connector_id: { type: ['string', 'null'] },
        stream: { type: ['string', 'null'] },
      },
      required: ['connector_id', 'stream'],
    },
  },
  required: [
    'limit',
    'offset',
    'returned',
    'total',
    'has_more',
    'next_cursor',
    'prev_cursor',
    'sort',
    'order',
    'filters',
  ],
};

const TimelineEntrySchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    object: { const: 'timeline_entry' },
    connector_id: { type: 'string' },
    stream: { type: 'string' },
    id: { type: 'string' },
    emitted_at: { type: 'string' },
    version: { type: ['integer', 'string', 'null'] },
    data: { type: ['object', 'null'] },
    semantic_timestamp: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        field: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['field', 'value'],
    },
    display_timestamp: { type: 'string' },
  },
  required: [
    'object',
    'connector_id',
    'stream',
    'id',
    'emitted_at',
    'version',
    'data',
    'semantic_timestamp',
    'display_timestamp',
  ],
};

const CommonErrors = {
  400: { schema: ErrorObjectSchema, description: 'Invalid request' },
  401: { schema: ErrorObjectSchema, description: 'Missing or invalid owner/operator auth' },
  403: { schema: ErrorObjectSchema, description: 'Not permitted' },
  404: { schema: ErrorObjectSchema, description: 'Not found' },
  409: { schema: ErrorObjectSchema, description: 'Conflict (e.g. run_already_active)' },
};

const ConnectorIdParamSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { connectorId: { type: 'string', minLength: 1 } },
  required: ['connectorId'],
};

export const referenceManifests = [
  {
    id: 'refSearch',
    method: 'GET',
    path: '/_ref/search',
    surface: 'reference',
    tags: ['reference', 'search'],
    summary: 'Search exact trace/grant/run ids and record content across retained records.',
    request: {
      query: {
        type: 'object',
        additionalProperties: false,
        properties: {
          q: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          cursor: { type: 'string' },
          connector_id: { type: 'string' },
          stream: { type: 'string' },
          order: { type: 'string', enum: ['asc', 'desc'] },
          sort: { type: 'string', enum: ['native', 'ingested'] },
        },
      },
    },
    responses: {
      200: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            object: { const: 'search_result' },
            exact: { type: ['object', 'null'] },
            traces: { type: 'array', items: { type: 'object' } },
            grants: { type: 'array', items: { type: 'object' } },
            runs: { type: 'array', items: { type: 'object' } },
            records: { type: 'array', items: RefSearchRecordSchema },
            record_page: RecordPageSchema,
          },
          required: ['object', 'exact', 'traces', 'grants', 'runs', 'records', 'record_page'],
        },
      },
      ...CommonErrors,
    },
  },
  {
    id: 'refListConnectors',
    method: 'GET',
    path: '/_ref/connectors',
    surface: 'reference',
    tags: ['reference', 'connectors'],
    summary: 'List registered connectors with manifest summary, latest run summary, schedule summary, and freshness.',
    responses: { 200: { schema: ConnectorListResponseSchema }, ...CommonErrors },
  },
  {
    id: 'refGetConnector',
    method: 'GET',
    path: '/_ref/connectors/{connectorId}',
    surface: 'reference',
    tags: ['reference', 'connectors'],
    summary: 'Get a single connector with manifest excerpt, schedule, recent runs, and stream summaries.',
    request: { params: ConnectorIdParamSchema },
    responses: { 200: { schema: ConnectorSummarySchema }, ...CommonErrors },
  },
  {
    id: 'refListApprovals',
    method: 'GET',
    path: '/_ref/approvals',
    surface: 'reference',
    tags: ['reference', 'grants'],
    summary: 'List pending approvals across provider-connect consents and owner-device flows.',
    responses: {
      200: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            object: { const: 'list' },
            data: { type: 'array', items: ApprovalItemSchema },
          },
          required: ['object', 'data'],
        },
      },
      ...CommonErrors,
    },
  },
  {
    id: 'refListSchedules',
    method: 'GET',
    path: '/_ref/schedules',
    surface: 'reference',
    tags: ['reference', 'runs'],
    summary: 'List all configured schedules with runtime status.',
    responses: { 200: { description: 'Schedule list' }, ...CommonErrors },
  },
  {
    id: 'refRunConnector',
    method: 'POST',
    path: '/_ref/connectors/{connectorId}/run',
    surface: 'reference',
    tags: ['reference', 'runs'],
    summary: 'Start a connector run asynchronously. Returns 202 with run_id + trace_id, or 409 run_already_active.',
    request: { params: ConnectorIdParamSchema },
    responses: {
      202: { schema: RunStartResponseSchema, description: 'Accepted' },
      ...CommonErrors,
    },
  },
  {
    id: 'refPutConnectorSchedule',
    method: 'PUT',
    path: '/_ref/connectors/{connectorId}/schedule',
    surface: 'reference',
    tags: ['reference', 'runs'],
    summary: 'Create or replace the single schedule for a connector.',
    request: {
      params: ConnectorIdParamSchema,
      body: { contentType: 'application/json', schema: ScheduleUpsertBodySchema },
    },
    responses: { 200: { description: 'Schedule upserted' }, ...CommonErrors },
  },
  {
    id: 'refPauseConnectorSchedule',
    method: 'POST',
    path: '/_ref/connectors/{connectorId}/schedule/pause',
    surface: 'reference',
    tags: ['reference', 'runs'],
    summary: 'Pause the connector schedule without deleting its config.',
    request: { params: ConnectorIdParamSchema },
    responses: { 200: { description: 'Paused' }, ...CommonErrors },
  },
  {
    id: 'refResumeConnectorSchedule',
    method: 'POST',
    path: '/_ref/connectors/{connectorId}/schedule/resume',
    surface: 'reference',
    tags: ['reference', 'runs'],
    summary: 'Resume a paused connector schedule.',
    request: { params: ConnectorIdParamSchema },
    responses: { 200: { description: 'Resumed' }, ...CommonErrors },
  },
  {
    id: 'refDeleteConnectorSchedule',
    method: 'DELETE',
    path: '/_ref/connectors/{connectorId}/schedule',
    surface: 'reference',
    tags: ['reference', 'runs'],
    summary: 'Delete the connector schedule config.',
    request: { params: ConnectorIdParamSchema },
    responses: { 204: { description: 'Deleted' }, ...CommonErrors },
  },
  {
    id: 'refRecordsTimeline',
    method: 'GET',
    path: '/_ref/records/timeline',
    surface: 'reference',
    tags: ['reference', 'records'],
    summary: 'Server-backed cross-connector recent-record feed for the Records > Timeline UI.',
    request: {
      query: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connector_id: { type: 'string' },
          stream: { type: 'string' },
          since: { type: 'string' },
          until: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
          order: { type: 'string', enum: ['asc', 'desc'] },
          timestamp_mode: { type: 'string', enum: ['native', 'emitted'] },
        },
      },
    },
    responses: {
      200: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            object: { const: 'list' },
            data: { type: 'array', items: TimelineEntrySchema },
            meta: {
              type: 'object',
              additionalProperties: false,
              properties: {
                bounded: { type: 'boolean' },
                ordering: { type: 'string' },
                limit: { type: 'integer' },
                timestamp_mode: { type: 'string', enum: ['native', 'emitted'] },
                filters: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    connector_id: { type: ['string', 'null'] },
                    stream: { type: ['string', 'null'] },
                    since: { type: ['string', 'null'] },
                    until: { type: ['string', 'null'] },
                  },
                  required: ['connector_id', 'stream', 'since', 'until'],
                },
              },
              required: ['bounded', 'ordering', 'limit', 'timestamp_mode', 'filters'],
            },
          },
          required: ['object', 'data', 'meta'],
        },
      },
      ...CommonErrors,
    },
  },
];
