# PDPP reference-implementation /_ref operator surface

Generated from `packages/reference-contract/src/reference/`. Reference-designated routes: not part of the public PDPP contract.

| Method | Path | Operation | Summary |
|--------|------|-----------|---------|
| **GET** | `/_ref/search` | `refSearch` | Search exact trace/grant/run ids and record content across retained records. |
| **GET** | `/_ref/connectors` | `refListConnectors` | List registered connectors with manifest summary, latest run summary, schedule summary, and freshness. |
| **GET** | `/_ref/connectors/{connectorId}` | `refGetConnector` | Get a single connector with manifest excerpt, schedule, recent runs, and stream summaries. |
| **GET** | `/_ref/approvals` | `refListApprovals` | List pending approvals across provider-connect consents and owner-device flows. |
| **GET** | `/_ref/schedules` | `refListSchedules` | List all configured schedules with runtime status. |
| **POST** | `/_ref/connectors/{connectorId}/run` | `refRunConnector` | Start a connector run asynchronously. Returns 202 with run_id + trace_id, or 409 run_already_active. |
| **PUT** | `/_ref/connectors/{connectorId}/schedule` | `refPutConnectorSchedule` | Create or replace the single schedule for a connector. |
| **POST** | `/_ref/connectors/{connectorId}/schedule/pause` | `refPauseConnectorSchedule` | Pause the connector schedule without deleting its config. |
| **POST** | `/_ref/connectors/{connectorId}/schedule/resume` | `refResumeConnectorSchedule` | Resume a paused connector schedule. |
| **DELETE** | `/_ref/connectors/{connectorId}/schedule` | `refDeleteConnectorSchedule` | Delete the connector schedule config. |
| **GET** | `/_ref/records/timeline` | `refRecordsTimeline` | Server-backed cross-connector recent-record feed for the Records > Timeline UI. |

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
- `401` — Missing or invalid owner/operator auth
- `403` — Not permitted
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refListConnectors

`GET /_ref/connectors`

List registered connectors with manifest summary, latest run summary, schedule summary, and freshness.

### Responses

- `200` — JSON body
- `400` — Invalid request
- `401` — Missing or invalid owner/operator auth
- `403` — Not permitted
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
- `401` — Missing or invalid owner/operator auth
- `403` — Not permitted
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refListApprovals

`GET /_ref/approvals`

List pending approvals across provider-connect consents and owner-device flows.

### Responses

- `200` — JSON body
- `400` — Invalid request
- `401` — Missing or invalid owner/operator auth
- `403` — Not permitted
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

## refListSchedules

`GET /_ref/schedules`

List all configured schedules with runtime status.

### Responses

- `200` — Schedule list
- `400` — Invalid request
- `401` — Missing or invalid owner/operator auth
- `403` — Not permitted
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
- `401` — Missing or invalid owner/operator auth
- `403` — Not permitted
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
- `401` — Missing or invalid owner/operator auth
- `403` — Not permitted
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
- `401` — Missing or invalid owner/operator auth
- `403` — Not permitted
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
- `401` — Missing or invalid owner/operator auth
- `403` — Not permitted
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
- `401` — Missing or invalid owner/operator auth
- `403` — Not permitted
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
- `timestamp_mode` — enum `native | emitted`

### Responses

- `200` — JSON body
- `400` — Invalid request
- `401` — Missing or invalid owner/operator auth
- `403` — Not permitted
- `404` — Not found
- `409` — Conflict (e.g. run_already_active)

