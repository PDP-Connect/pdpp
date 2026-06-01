# PDPP reference-implementation /_ref operator surface

Generated from `packages/reference-contract/src/reference/`. Reference-designated routes: not part of the public PDPP contract.

| Method | Path | Operation | Summary |
|--------|------|-----------|---------|
| **GET** | `/_ref/search` | `refSearch` | Search exact trace/grant/run ids and record content across retained records. |
| **GET** | `/_ref/connectors` | `refListConnectors` | List registered connectors with manifest summary, latest run summary, schedule summary, and freshness. |
| **GET** | `/_ref/connectors/{connectorId}` | `refGetConnector` | Get a single connector with manifest excerpt, schedule, recent runs, and stream summaries. |
| **GET** | `/_ref/connections` | `refListConnections` | List owner-facing configured connector connections with labels, lifecycle status, binding metadata, and schedules. |
| **GET** | `/_ref/connector-instances` | `refListConnectorInstances` | Compatibility alias for listing configured connector instances behind owner-facing connections. |
| **GET** | `/v1/owner/connections` | `ownerListConnections` | Owner-agent bearer listing of configured connections with connection_id, connector_key, owner-meaningful display_name, label status, lifecycle fields, and schedules. |
| **GET** | `/v1/owner/connector-templates` | `ownerListConnectorTemplates` | Owner-agent bearer listing of connector templates separated from configured connection instances. Embeds related connection summaries and template-level supported_actions for adding new connections as typed intents. |
| **GET** | `/v1/owner/control` | `ownerControlCapabilities` | Owner-agent bearer control entrypoint: capability document naming supported, owner-mediated, and unsupported owner-agent control action families with links to supported routes. |
| **PATCH** | `/v1/owner/connections/{connectionId}` | `ownerSetConnectionDisplayName` | Owner-agent bearer rename of the owner-meaningful `display_name` on a connection, addressed by `connection_id`. Owner bearers only; client/mcp_package grants SHALL NOT reach this route. Shares the connector-instance store rename semantics with the cookie-authed `/_ref` PATCH; on success the returned row reports label_status owner_set. |
| **POST** | `/v1/owner/connections/intents` | `ownerCreateConnectionIntent` | Owner-agent bearer: initiate a new connection as a typed, auditable, owner-mediated intent. Returns a typed `next_step` (`enroll_local_collector` for proven local-collector connectors; `unsupported` with a reason for browser-bound, API/network-only, and unknown connectors) and never marks a connection active. Owner bearers only; client/mcp_package grants SHALL NOT reach this route. |
| **GET** | `/_ref/connections/{connectorInstanceId}` | `refGetConnection` | Get one owner-facing configured connector connection by connector instance id. |
| **GET** | `/_ref/connector-instances/{connectorInstanceId}` | `refGetConnectorInstance` | Compatibility alias for reading one configured connector instance behind an owner-facing connection. |
| **PATCH** | `/_ref/connections/{connectorInstanceId}` | `refSetConnectionDisplayName` | Owner-authenticated mutation of the owner-meaningful `display_name` carried on the public read contract. Operator-only surface; grant-authorized tokens SHALL NOT reach this route. |
| **GET** | `/_ref/approvals` | `refListApprovals` | List pending approvals across provider-connect consents and owner-device flows. |
| **POST** | `/_ref/device-exporters/enrollment-codes` | `refCreateDeviceExporterEnrollmentCode` | Create a short-lived local device exporter enrollment code for an owner-approved connector binding. |
| **POST** | `/_ref/device-exporters/enroll` | `refExchangeDeviceExporterEnrollmentCode` | Exchange a one-time enrollment code for a device-scoped local exporter credential. |
| **GET** | `/_ref/device-exporters` | `refListDeviceExporters` | List enrolled local device exporters and their source-instance diagnostics. |
| **GET** | `/_ref/device-exporters/source-instances` | `refListDeviceExporterSourceInstances` | List local device exporter source instances without promoting source-instance identity to the public PDPP contract. |
| **GET** | `/_ref/device-exporters/diagnostics` | `refListDeviceExporterDiagnostics` | List owner/operator diagnostics for local device exporters, including heartbeat and ingest freshness. |
| **POST** | `/_ref/device-exporters/{deviceId}/revoke` | `refRevokeDeviceExporter` | Revoke a local device exporter credential and stop future heartbeats or ingest from that device. |
| **POST** | `/_ref/device-exporters/{deviceId}/heartbeat` | `refHeartbeatDeviceExporter` | Accept a heartbeat from a device-scoped local exporter credential. |
| **POST** | `/_ref/device-exporters/{deviceId}/ingest-batches` | `refIngestDeviceExporterBatch` | Accept an idempotent source-instance-aware ingest batch from a local device exporter. |
| **GET** | `/_ref/device-exporters/{deviceId}/source-instances/{sourceInstanceId}/state` | `refGetDeviceExporterSourceInstanceState` | Read device-scoped local collector state for a source instance. Owner-token and client-token routes do not accept device credentials and vice versa. |
| **PUT** | `/_ref/device-exporters/{deviceId}/source-instances/{sourceInstanceId}/state` | `refPutDeviceExporterSourceInstanceState` | Persist device-scoped local collector state for a source instance. State is a stream-keyed map; existing streams are merged with last-write-wins semantics. |
| **GET** | `/_ref/schedules` | `refListSchedules` | List all configured schedules with runtime status. |
| **POST** | `/_ref/connectors/{connectorId}/run` | `refRunConnector` | Start a connector run asynchronously. Returns 202 with run_id + trace_id, or 409 run_already_active. |
| **POST** | `/_ref/connections/{connectorInstanceId}/run` | `refRunConnection` | Start a connector run for one configured connection. Returns 202 with run_id + trace_id, or 409 run_already_active. |
| **PUT** | `/_ref/connectors/{connectorId}/schedule` | `refPutConnectorSchedule` | Create or replace the single schedule for a connector. |
| **PUT** | `/_ref/connections/{connectorInstanceId}/schedule` | `refPutConnectionSchedule` | Create or replace the schedule for one configured connection. |
| **POST** | `/_ref/connectors/{connectorId}/schedule/pause` | `refPauseConnectorSchedule` | Pause the connector schedule without deleting its config. |
| **POST** | `/_ref/connections/{connectorInstanceId}/schedule/pause` | `refPauseConnectionSchedule` | Pause one configured connection schedule without deleting its config. |
| **POST** | `/_ref/connectors/{connectorId}/schedule/resume` | `refResumeConnectorSchedule` | Resume a paused connector schedule. |
| **POST** | `/_ref/connections/{connectorInstanceId}/schedule/resume` | `refResumeConnectionSchedule` | Resume one paused configured connection schedule. |
| **DELETE** | `/_ref/connectors/{connectorId}/schedule` | `refDeleteConnectorSchedule` | Delete the connector schedule config. |
| **DELETE** | `/_ref/connections/{connectorInstanceId}/schedule` | `refDeleteConnectionSchedule` | Delete the schedule config for one configured connection. |
| **POST** | `/_ref/runs/{runId}/interaction` | `refRunInteraction` | Owner-only control surface: answer the current pending interaction for an active controller-managed run. Reference-only; not part of the public PDPP API. |
| **GET** | `/_ref/records/timeline` | `refRecordsTimeline` | Server-backed cross-connector recent-record feed for the Records > Timeline UI. |
| **GET** | `/_ref/dataset/summary` | `refDatasetSummary` | Projection-backed dataset summary: record counts, retained-history bytes, timespan bounds, top connectors, and freshness metadata. |
| **GET** | `/_ref/dataset/summary/streams` | `refDatasetSummaryStreams` | Per-(connector_id, stream) rows from the dataset-summary projection. NULL/dirty time bounds pass through honestly. |
| **POST** | `/_ref/dataset/summary/rebuild` | `refDatasetSummaryRebuild` | Owner-triggered rebuild of the projection-backed dataset summary from durable reference state. |
| **POST** | `/_ref/dataset/summary/reconcile` | `refDatasetSummaryReconcile` | Owner-triggered reconciliation of dirty dataset-summary record-time bounds from durable reference state. |
| **GET** | `/_ref/dataset/size` | `refDatasetSize` | Projection-backed retained logical bytes by finite dataset grain. |
| **GET** | `/_ref/dataset/top` | `refDatasetTop` | Bounded retained-size heavy hitters for owner dataset introspection. |
| **GET** | `/_ref/records/version-stats` | `refRecordsVersionStats` | Record-version churn stats with projection and record-change authority for owner diagnostics. |
| **POST** | `/_ref/dataset/size/rebuild` | `refDatasetSizeRebuild` | Owner-triggered rebuild of retained-size projection rows from durable reference state. |
| **POST** | `/_ref/dataset/size/reconcile` | `refDatasetSizeReconcile` | Owner-triggered reconciliation of dirty retained-size projection rows from durable reference state. |
| **GET** | `/_ref/event-subscriptions` | `refListEventSubscriptions` | Operator oversight: list all client event subscriptions. Filter by `client_id`, `grant_id`, or `status`. Secrets are never returned on `/_ref` routes. |
| **GET** | `/_ref/event-subscriptions/{subscription_id}` | `refGetEventSubscription` | Operator oversight: get a single subscription with delivery attempt history. |
| **POST** | `/_ref/event-subscriptions/{subscription_id}/disable` | `refDisableEventSubscription` | Operator safety valve: forcibly disable a subscription. Accepts an optional `reason` string. Secrets are never returned. |

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

## refListConnections

`GET /_ref/connections`

List owner-facing configured connector connections with labels, lifecycle status, binding metadata, and schedules.

### Query parameters

- `connector_id` — string
- `status` — enum `active | paused | revoked`

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refListConnectorInstances

`GET /_ref/connector-instances`

Compatibility alias for listing configured connector instances behind owner-facing connections.

### Query parameters

- `connector_id` — string
- `status` — enum `active | paused | revoked`

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## ownerListConnections

`GET /v1/owner/connections`

Owner-agent bearer listing of configured connections with connection_id, connector_key, owner-meaningful display_name, label status, lifecycle fields, and schedules.

### Query parameters

- `connector_id` — string
- `status` — enum `active | paused | revoked`

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## ownerListConnectorTemplates

`GET /v1/owner/connector-templates`

Owner-agent bearer listing of connector templates separated from configured connection instances. Embeds related connection summaries and template-level supported_actions for adding new connections as typed intents.

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## ownerControlCapabilities

`GET /v1/owner/control`

Owner-agent bearer control entrypoint: capability document naming supported, owner-mediated, and unsupported owner-agent control action families with links to supported routes.

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## ownerSetConnectionDisplayName

`PATCH /v1/owner/connections/{connectionId}`

Owner-agent bearer rename of the owner-meaningful `display_name` on a connection, addressed by `connection_id`. Owner bearers only; client/mcp_package grants SHALL NOT reach this route. Shares the connector-instance store rename semantics with the cookie-authed `/_ref` PATCH; on success the returned row reports label_status owner_set.

### Path parameters

- `connectionId` — string

### Request body

`application/json`
- `display_name` (required) — string

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## ownerCreateConnectionIntent

`POST /v1/owner/connections/intents`

Owner-agent bearer: initiate a new connection as a typed, auditable, owner-mediated intent. Returns a typed `next_step` (`enroll_local_collector` for proven local-collector connectors; `unsupported` with a reason for browser-bound, API/network-only, and unknown connectors) and never marks a connection active. Owner bearers only; client/mcp_package grants SHALL NOT reach this route.

### Request body

`application/json`
- `connector_id` (required) — string
- `display_name` — string

### Responses

- `201` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refGetConnection

`GET /_ref/connections/{connectorInstanceId}`

Get one owner-facing configured connector connection by connector instance id.

### Path parameters

- `connectorInstanceId` — string

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refGetConnectorInstance

`GET /_ref/connector-instances/{connectorInstanceId}`

Compatibility alias for reading one configured connector instance behind an owner-facing connection.

### Path parameters

- `connectorInstanceId` — string

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refSetConnectionDisplayName

`PATCH /_ref/connections/{connectorInstanceId}`

Owner-authenticated mutation of the owner-meaningful `display_name` carried on the public read contract. Operator-only surface; grant-authorized tokens SHALL NOT reach this route.

### Path parameters

- `connectorInstanceId` — string

### Request body

`application/json`
- `display_name` (required) — string

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

## refGetDeviceExporterSourceInstanceState

`GET /_ref/device-exporters/{deviceId}/source-instances/{sourceInstanceId}/state`

Read device-scoped local collector state for a source instance. Owner-token and client-token routes do not accept device credentials and vice versa.

### Path parameters

- `deviceId` — string
- `sourceInstanceId` — string

### Responses

- `200` — JSON body
- `400` — Invalid request
- `401` — Authentication required
- `403` — Permission denied
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refPutDeviceExporterSourceInstanceState

`PUT /_ref/device-exporters/{deviceId}/source-instances/{sourceInstanceId}/state`

Persist device-scoped local collector state for a source instance. State is a stream-keyed map; existing streams are merged with last-write-wins semantics.

### Path parameters

- `deviceId` — string
- `sourceInstanceId` — string

### Request body

`application/json`
- `state` (required) — object

### Responses

- `200` — JSON body
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

## refRunConnection

`POST /_ref/connections/{connectorInstanceId}/run`

Start a connector run for one configured connection. Returns 202 with run_id + trace_id, or 409 run_already_active.

### Path parameters

- `connectorInstanceId` — string

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

## refPutConnectionSchedule

`PUT /_ref/connections/{connectorInstanceId}/schedule`

Create or replace the schedule for one configured connection.

### Path parameters

- `connectorInstanceId` — string

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

## refPauseConnectionSchedule

`POST /_ref/connections/{connectorInstanceId}/schedule/pause`

Pause one configured connection schedule without deleting its config.

### Path parameters

- `connectorInstanceId` — string

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

## refResumeConnectionSchedule

`POST /_ref/connections/{connectorInstanceId}/schedule/resume`

Resume one paused configured connection schedule.

### Path parameters

- `connectorInstanceId` — string

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

## refDeleteConnectionSchedule

`DELETE /_ref/connections/{connectorInstanceId}/schedule`

Delete the schedule config for one configured connection.

### Path parameters

- `connectorInstanceId` — string

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

Projection-backed dataset summary: record counts, retained-history bytes, timespan bounds, top connectors, and freshness metadata.

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refDatasetSummaryStreams

`GET /_ref/dataset/summary/streams`

Per-(connector_id, stream) rows from the dataset-summary projection. NULL/dirty time bounds pass through honestly.

### Query parameters

- `connector_id` — string

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refDatasetSummaryRebuild

`POST /_ref/dataset/summary/rebuild`

Owner-triggered rebuild of the projection-backed dataset summary from durable reference state.

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refDatasetSummaryReconcile

`POST /_ref/dataset/summary/reconcile`

Owner-triggered reconciliation of dirty dataset-summary record-time bounds from durable reference state.

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refDatasetSize

`GET /_ref/dataset/size`

Projection-backed retained logical bytes by finite dataset grain.

### Query parameters

- `grain` — enum `global | connection | stream`
- `connector_instance_id` — string
- `stream` — string

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refDatasetTop

`GET /_ref/dataset/top`

Bounded retained-size heavy hitters for owner dataset introspection.

### Query parameters

- `scope` — enum `connection | stream | record | blob`
- `measure` — enum `total_retained_bytes | current_record_json_bytes | record_history_json_bytes | blob_bytes | record_count | record_history_count | blob_count`
- `limit` — integer · min: 1 · max: 25

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refRecordsVersionStats

`GET /_ref/records/version-stats`

Record-version churn stats with projection and record-change authority for owner diagnostics.

### Query parameters

- `connector_instance_id` — string
- `stream` — string
- `risk` — enum `normal | watch | high`
- `limit` — integer · min: 1 · max: 500

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refDatasetSizeRebuild

`POST /_ref/dataset/size/rebuild`

Owner-triggered rebuild of retained-size projection rows from durable reference state.

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refDatasetSizeReconcile

`POST /_ref/dataset/size/reconcile`

Owner-triggered reconciliation of dirty retained-size projection rows from durable reference state.

### Responses

- `200` — JSON body
- `400` — Invalid request
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refListEventSubscriptions

`GET /_ref/event-subscriptions`

Operator oversight: list all client event subscriptions. Filter by `client_id`, `grant_id`, or `status`. Secrets are never returned on `/_ref` routes.

### Query parameters

- `client_id` — string
- `grant_id` — string
- `status` — enum `pending_verification | active | disabled | disabled_failure | disabled_revoked | deleted`

### Responses

- `200` — JSON body

## refGetEventSubscription

`GET /_ref/event-subscriptions/{subscription_id}`

Operator oversight: get a single subscription with delivery attempt history.

### Path parameters

- `subscription_id` — string

### Responses

- `200` — JSON body
- `404` — Subscription not found

## refDisableEventSubscription

`POST /_ref/event-subscriptions/{subscription_id}/disable`

Operator safety valve: forcibly disable a subscription. Accepts an optional `reason` string. Secrets are never returned.

### Path parameters

- `subscription_id` — string

### Request body

`application/json`
- `reason` — string

### Responses

- `200` — Subscription after disabling.
- `400` — Invalid request
- `404` — Subscription not found

