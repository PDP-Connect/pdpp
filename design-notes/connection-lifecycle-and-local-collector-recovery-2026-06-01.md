# Connection Lifecycle And Local Collector Recovery

Status: sprint-needed
Owner: RI owner
Created: 2026-06-01
Updated: 2026-06-01
Related: `openspec/changes/add-browser-collector-enrollment-primitive`, `openspec/changes/add-owner-agent-control-surface`, `openspec/specs/reference-connector-instances/spec.md`

## Question

What should the reference console treat as the owner-facing lifecycle for a connector: catalog entry, connection creation, enrollment, credential/challenge collection, first ingest, stalled recovery, and cleanup?

## Context

The current console leaks implementation history. The add-connection surface is shaped around the Amazon manual browser-collector path, while the owner actually needs a generic way to start any supported connector class. Local collector connections can appear as zero-record "connections" before first durable ingest, and abandoned placeholder connections for connectors the owner does not use look indistinguishable from real but empty sources. Stalled local collectors show state such as "retryable gap" and "Check the collector host" without telling the owner which host, which command, or which recovery action applies.

There is a separate but related browser-bound note for owner-agent delegated browser connection creation. This note is broader: it covers the product contract for any connector class and the console behavior around setup, stalled local exporters, unused zero-record connections, and version-history maintenance.

The credential model is also unresolved. Some connectors may need credentials before a run can start. Others can collect credentials, OTP, CAPTCHA, browser trust, or local filesystem permissions during the connector run or enrollment stream. The setup flow should not require up-front credentials where the connector can collect them at the right moment with a bounded, auditable prompt.

## Stakes

If the reference implementation is the SLVP construction, owners should not have to infer internal connector classes or remember commands that an agent ran earlier. A connector catalog is not a connection list. A pending enrollment is not a durable connected source. A stalled local exporter is not actionable unless the UI names the stalled device, the dead-letter/pending counts, the last attempt, and the exact command or owner action that can move it forward.

This also affects trust in data quality warnings. Version churn, no-data connections, and stalled local collectors are not current record loss, but weak actionability makes them feel like mystery data loss.

## Current Leaning

The console should model a generic lifecycle:

1. Connector catalog entry: available capability, not a connection.
2. Connection draft or enrollment: owner intent exists, but no durable records yet.
3. Active connection: durable identity plus at least one successful ingest or an explicit active schedule/run state.
4. Degraded connection: current records remain usable, but a specific recovery action is needed.
5. Retired or abandoned draft: removable without implying data deletion.

The add-connection surface should be connector-class driven, not Amazon-driven. For every connector it should show one concise next action: run local collector, start browser collector proof, start API/OAuth/static-secret setup, or unavailable pending owner-approved flow. The enrollment-code form should accept connector selection as the primary decision and derive the required binding/profile details from the connector manifest where possible.

Credentials should be optional at setup when a connector can collect them during an owner-visible run. The durable contract should distinguish "credentials required before enrollment" from "credentials/challenges collected during run."

## Promotion Trigger

Promote into OpenSpec before changing durable connection-instance states, adding a generic connection-create route, changing enrollment-code contracts, or introducing a new credential/challenge collection contract. Pure console copy, grouping, and clearer recovery commands can land as reference implementation cleanup if they do not change backend contracts.

## Decision Log

- 2026-06-01: Captured owner feedback that the current add-connection UI is too Amazon-specific, too verbose, and does not match the mental model of choosing a connector and providing credentials or handling challenges only when necessary.
- 2026-06-01: Captured owner feedback that zero-record unused connections should not exist as normal connections just because a connector is available; connector catalog entries are fine, connection instances need lifecycle semantics.
- 2026-06-01: Captured owner feedback that "Check the collector host" is not actionable when the owner did not personally set up the collector; the UI should name the host/command/recovery path.
- 2026-06-01: Captured owner feedback that version churn maintenance should be concrete and non-scary: latest records are intact, but dry-run compaction and connector re-emission review need an owner-operable path.
