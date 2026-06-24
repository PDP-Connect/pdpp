# Owner Noun Model Decision

Date: 2026-06-18
Status: Decided for implementation packets

## Decision

The normal owner-facing noun for a configured data-producing instance is `Source`.

`Source` covers:

- provider account source, such as "Gmail - work"
- browser-backed source, such as "Amazon - family account"
- local collector source, such as "Claude Code on Peregrine"
- artifact/import source, such as "WhatsApp - personal exports"
- device-bound source when the device is the essential identity

The console should use `Source` in normal navigation, headings, source detail, Add Data, source setup, recovery, and record-inspection entry points.

## Owner Noun Map

| Owner noun | Meaning | Internal/API terms that may back it | Owner-surface rule |
|---|---|---|---|
| Source | Configured data-producing instance | `connection`, `connection_id`, `connector_instance_id`, `source_instance_id`, connector binding | Use `Source` by default. Show raw IDs only in advanced/debug detail or copyable technical metadata. |
| Connector | Connector type or capability, such as Gmail or WhatsApp | `connector_id`, manifest key, provider key | Use only when choosing what kind of source to add or explaining connector capability. Do not use it for an owner-configured instance. |
| Stream | Typed subset of records under a source | stream key, manifest stream name | Use for child data slices under a source. |
| Record | Readable collected item | record key, record id, row, item | Use for data items in Explore and stream views. |
| Client | App or agent that can request/read data | OAuth client, MCP client, dynamic client, client id | Use for access review. Distinguish verified origin from client-authored name/logo. |
| Grant | Authority the owner approved | grant id, package child grant, consent artifact | Use when explaining what the client can read. Do not force owners to decode raw package children first. |
| Grant package | Parent bundle of related grants | package id, grant group | Use when grouping package children, but always explain it as a bundle for one client/request. |
| Read | Actual access/disclosure event | trace event, disclosure event, read record | Use when explaining what a client actually read. |
| Run or Sync | Collection attempt/evidence | run id, sync id, scheduled run, active run | Use as evidence. `Sync` may be owner-facing for collection attempts, but source state remains primary. |
| Trace | Low-level protocol/runtime timeline | trace id, span, event | Use in advanced/evidence contexts, not as the first answer to an owner question. |
| Credential | Stored provider secret or owner/client credential | token, app password, PAT, OAuth credential | Use concrete credential language; keep bearer-token/debug paths advanced. |
| Device | Host or local collector identity | local device exporter, host binding, device id | Use when the device is the owner-action location, such as re-running a collector on Peregrine. |
| Schedule | Collection timing policy | cron, cadence, next eligible run | Use as source policy, not as an independent product object unless the owner is editing schedules. |

## Route Decision

Do not rename or remove routes in this planning tranche.

Implementation packets may propose clean owner aliases such as `/dashboard/sources`, but any route change must include:

- compatibility redirects for existing links
- a screenshot/mock showing the owner route model
- subject-preserving link helpers for `View records`, `Explore`, `Review`, `Reauthorize`, `Recover`, run, trace, grant, and credential links
- no backend/API renames unless a separate protocol or reference contract change requires them

## Why

the owner's feedback shows that `Sources`, `Connections`, `Records`, `Runs`, `Syncs`, IDs, and URLs currently require translation. The essential object in the owner journey is not the connector type or internal connection row; it is the owner-configured source of personal data. Keeping that noun stable reduces incidental complexity without hiding advanced evidence.

## Acceptance Implication

Wave 1 implementation may proceed only after it can show:

- the changed surface's route, heading, nav label, primary CTA, empty state, and breadcrumb using this map
- a vocabulary-boundary report explaining any remaining internal/protocol terms
- desktop and mobile pixels proving the language works in context
