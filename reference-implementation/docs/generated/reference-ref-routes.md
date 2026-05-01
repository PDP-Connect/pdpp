# PDPP reference-implementation /_ref operator surface

Generated from `packages/reference-contract/src/reference/`. Reference-designated routes: not part of the public PDPP contract.

| Method | Path | Operation | Summary |
|--------|------|-----------|---------|
| **GET** | `/_ref/search` | `refSearch` | Search exact trace/grant/run ids and record content across retained records. |
| **GET** | `/_ref/connectors` | `refListConnectors` | List registered connectors with manifest summary, latest run summary, schedule summary, and freshness. |
| **GET** | `/_ref/connectors/{connectorId}` | `refGetConnector` | Get a single connector with manifest excerpt, schedule, recent runs, and stream summaries. |
| **GET** | `/_ref/approvals` | `refListApprovals` | List pending approvals across provider-connect consents and owner-device flows. |
| **POST** | `/_ref/device-exporters/enrollment-codes` | `refCreateDeviceExporterEnrollmentCode` | Create a short-lived local device exporter enrollment code for an owner-approved connector binding. |
| **POST** | `/_ref/device-exporters/enroll` | `refExchangeDeviceExporterEnrollmentCode` | Exchange a one-time enrollment code for a device-scoped local exporter credential. |
| **GET** | `/_ref/device-exporters` | `refListDeviceExporters` | List enrolled local device exporters and their source-instance diagnostics. |
| **GET** | `/_ref/device-exporters/source-instances` | `refListDeviceExporterSourceInstances` | List local device exporter source instances without promoting source-instance identity to the public PDPP contract. |
| **GET** | `/_ref/device-exporters/diagnostics` | `refListDeviceExporterDiagnostics` | List owner/operator diagnostics for local device exporters, including heartbeat and ingest freshness. |
| **POST** | `/_ref/device-exporters/{deviceId}/revoke` | `refRevokeDeviceExporter` | Revoke a local device exporter credential and stop future heartbeats or ingest from that device. |
| **POST** | `/_ref/device-exporters/{deviceId}/heartbeat` | `refHeartbeatDeviceExporter` | Accept a heartbeat from a device-scoped local exporter credential. |
| **POST** | `/_ref/device-exporters/{deviceId}/ingest-batches` | `refIngestDeviceExporterBatch` | Accept an idempotent source-instance-aware ingest batch from a local device exporter. |
| **GET** | `/_ref/schedules` | `refListSchedules` | List all configured schedules with runtime status. |
| **POST** | `/_ref/connectors/{connectorId}/run` | `refRunConnector` | Start a connector run asynchronously. Returns 202 with run_id + trace_id, or 409 run_already_active. |
| **PUT** | `/_ref/connectors/{connectorId}/schedule` | `refPutConnectorSchedule` | Create or replace the single schedule for a connector. |
| **POST** | `/_ref/connectors/{connectorId}/schedule/pause` | `refPauseConnectorSchedule` | Pause the connector schedule without deleting its config. |
| **POST** | `/_ref/connectors/{connectorId}/schedule/resume` | `refResumeConnectorSchedule` | Resume a paused connector schedule. |
| **DELETE** | `/_ref/connectors/{connectorId}/schedule` | `refDeleteConnectorSchedule` | Delete the connector schedule config. |
| **POST** | `/_ref/runs/{runId}/interaction` | `refRunInteraction` | Owner-only control surface: answer the current pending interaction for an active controller-managed run. Reference-only; not part of the public PDPP API. |
| **GET** | `/_ref/records/timeline` | `refRecordsTimeline` | Server-backed cross-connector recent-record feed for the Records > Timeline UI. |
| **GET** | `/_ref/dataset/summary` | `refDatasetSummary` | Aggregate dataset summary: live record counts, retained-history bytes, timespan bounds, and top connectors. |

## refSearch

`GET /_ref/search`

Search exact trace/grant/run ids and record content across retained records.

### Query parameters

- `q` — string
- `limit` — integer · min: 1 · max: 200
- `cursor` — string
- `connector_id` — string
- `stream` — string
- `order` — enum `asc | desc`
- `sort` — enum `native | ingested`

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refListConnectors

`GET /_ref/connectors`

List registered connectors with manifest summary, latest run summary, schedule summary, and freshness.

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refGetConnector

`GET /_ref/connectors/{connectorId}`

Get a single connector with manifest excerpt, schedule, recent runs, and stream summaries.

### Path parameters

- `connectorId` — string

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refListApprovals

`GET /_ref/approvals`

List pending approvals across provider-connect consents and owner-device flows.

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refCreateDeviceExporterEnrollmentCode

`POST /_ref/device-exporters/enrollment-codes`

Create a short-lived local device exporter enrollment code for an owner-approved connector binding.

### Request body

`application/json`
- `connector_id` (required) — string
- `local_binding_name` (required) — string
- `display_name` — string
- `expires_in_seconds` — integer · min: 60 · max: 86400

### Responses

- `201` — Created
- `400` — Invalid request
- `401` — Authentication required
- `403` — Permission denied
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refExchangeDeviceExporterEnrollmentCode

`POST /_ref/device-exporters/enroll`

Exchange a one-time enrollment code for a device-scoped local exporter credential.

### Request body

`application/json`
- `enrollment_code` (required) — string
- `agent_version` — string

### Responses

- `201` — Created
- `400` — Invalid request
- `401` — Authentication required
- `403` — Permission denied
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refListDeviceExporters

`GET /_ref/device-exporters`

List enrolled local device exporters and their source-instance diagnostics.

### Responses

- `200` — JSON body
- `400` — Invalid request
- `401` — Authentication required
- `403` — Permission denied
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refListDeviceExporterSourceInstances

`GET /_ref/device-exporters/source-instances`

List local device exporter source instances without promoting source-instance identity to the public PDPP contract.

### Query parameters

- `device_id` — string

### Responses

- `200` — JSON body
- `400` — Invalid request
- `401` — Authentication required
- `403` — Permission denied
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refListDeviceExporterDiagnostics

`GET /_ref/device-exporters/diagnostics`

List owner/operator diagnostics for local device exporters, including heartbeat and ingest freshness.

### Responses

- `200` — JSON body
- `400` — Invalid request
- `401` — Authentication required
- `403` — Permission denied
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refRevokeDeviceExporter

`POST /_ref/device-exporters/{deviceId}/revoke`

Revoke a local device exporter credential and stop future heartbeats or ingest from that device.

### Path parameters

- `deviceId` — string

### Responses

- `200` — JSON body
- `400` — Invalid request
- `401` — Authentication required
- `403` — Permission denied
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refHeartbeatDeviceExporter

`POST /_ref/device-exporters/{deviceId}/heartbeat`

Accept a heartbeat from a device-scoped local exporter credential.

### Path parameters

- `deviceId` — string

### Request body

`application/json`
- `agent_version` — string
- `connector_id` — string
- `source_instance_id` — string
- `status` — enum `starting | healthy | retrying | blocked | stopped`
- `records_pending` — integer · min: 0
- `source_instances` — array
- `last_error` — object|null

### Responses

- `200` — JSON body
- `400` — Invalid request
- `401` — Authentication required
- `403` — Permission denied
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refIngestDeviceExporterBatch

`POST /_ref/device-exporters/{deviceId}/ingest-batches`

Accept an idempotent source-instance-aware ingest batch from a local device exporter.

### Path parameters

- `deviceId` — string

### Request body

`application/json`
- `device_id` (required) — string
- `source_instance_id` (required) — string
- `batch_id` (required) — string
- `batch_seq` (required) — integer · min: 0
- `body_hash` (required) — string
- `connector_id` (required) — string
- `records` (required) — array

### Responses

- `200` — JSON body
- `201` — Created
- `400` — Invalid request
- `401` — Authentication required
- `403` — Permission denied
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refListSchedules

`GET /_ref/schedules`

List all configured schedules with runtime status.

### Responses

- `200` — Schedule list
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refRunConnector

`POST /_ref/connectors/{connectorId}/run`

Start a connector run asynchronously. Returns 202 with run_id + trace_id, or 409 run_already_active.

### Path parameters

- `connectorId` — string

### Responses

- `202` — Accepted
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refPutConnectorSchedule

`PUT /_ref/connectors/{connectorId}/schedule`

Create or replace the single schedule for a connector.

### Path parameters

- `connectorId` — string

### Request body

`application/json`
- `interval_seconds` (required) — integer · min: 1
- `jitter_seconds` — integer · min: 0
- `enabled` — boolean

### Responses

- `200` — Schedule upserted
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refPauseConnectorSchedule

`POST /_ref/connectors/{connectorId}/schedule/pause`

Pause the connector schedule without deleting its config.

### Path parameters

- `connectorId` — string

### Responses

- `200` — Paused
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refResumeConnectorSchedule

`POST /_ref/connectors/{connectorId}/schedule/resume`

Resume a paused connector schedule.

### Path parameters

- `connectorId` — string

### Responses

- `200` — Resumed
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refDeleteConnectorSchedule

`DELETE /_ref/connectors/{connectorId}/schedule`

Delete the connector schedule config.

### Path parameters

- `connectorId` — string

### Responses

- `204` — Deleted
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refRunInteraction

`POST /_ref/runs/{runId}/interaction`

Owner-only control surface: answer the current pending interaction for an active controller-managed run. Reference-only; not part of the public PDPP API.

### Path parameters

- `runId` — string

### Request body

`application/json`
- `interaction_id` (required) — string
- `status` (required) — enum `success | cancelled`
- `data` — object

### Responses

- `202` — Accepted
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refRecordsTimeline

`GET /_ref/records/timeline`

Server-backed cross-connector recent-record feed for the Records > Timeline UI.

### Query parameters

- `connector_id` — string
- `stream` — string
- `since` — string
- `until` — string
- `limit` — integer · min: 1 · max: 500
- `order` — enum `asc | desc`
- `timestamp_mode` — enum `native | ingest`

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refDatasetSummary

`GET /_ref/dataset/summary`

Aggregate dataset summary: live record counts, retained-history bytes, timespan bounds, and top connectors.

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

