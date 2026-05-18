# Source Instances And Multi-Account Configurations

Status: superseded
Owner: project owner
Created: 2026-04-24
Updated: 2026-05-18
Related: `openspec/changes/add-polyfill-connector-system/design-notes/connector-configuration-open-question.md`, `design-notes/connection-first-collection-identity-2026-05-18.md`

## Question

How should PDPP, the Collection Profile, and the reference implementation model cases where one user has multiple accounts for the same platform, or wants to use the same account in multiple connector configurations?

Examples:

- two GitHub accounts
- two Gmail accounts
- one Gmail account synced with different stream/configuration choices
- one browser-backed account used in both "full history" and "recent lightweight" modes
- multiple Slack workspaces under one Slack connector implementation

## Context

PDPP core can conceptually represent multiple sources through distinct source/grant/stream relationships. The Collection Profile can also support multiple accounts or configurations if each run has distinct source identity, credentials, state, and scheduling identity.

The current reference implementation and first-party polyfill connectors mostly model each platform as one `connector_id`. That is not enough to productize multi-account or multi-configuration use. If two configured GitHub accounts both write under the same connector/storage identity, records, state, credentials, scheduler runs, grants, semantic/lexical indexes, and operator UI state can collide or become ambiguous.

The likely future shape is an explicit configured source identity, such as:

- `connector_id + config_id`
- a derived stable `source_instance_id`
- a structured `source_binding` that includes connector plus configuration identity

This should be decided before implementing connector configuration as a product feature.

## Stakes

This decision affects:

- record primary-key namespace and collision semantics
- incremental state storage
- scheduler identity and non-overlap rules
- credential storage and rotation
- owner UI labels and setup flows
- grants and consent artifacts
- deletion/re-sync semantics
- lexical and semantic search indexing
- backup/restore and deploy portability
- whether behavior belongs in PDPP core, Collection Profile, or the reference implementation only

A weak model will make multi-account support look like it works until data from two accounts collides or grants become ambiguous.

## Current Leaning

This note is superseded by `design-notes/connection-first-collection-identity-2026-05-18.md`.

The core problem remains valid: the reference should not treat bare `connector_id` as enough once connector configuration exists. The newer leaning changes the solution: use a first-class owner-facing `connection` / internal `connector_instance` as the durable configured-source unit, and keep source/account/profile/device details as structured binding metadata unless they prove they need independent lifecycle, authority, schedules, health, grants, or storage namespaces.

The older plausible direction below is retained as historical context, not current guidance.

A plausible direction:

- Keep `connector_id` as the implementation/package identity.
- Introduce stable `source_instance_id` or equivalent structured `source_binding` for each configured account/configuration.
- Scope records, state, schedules, credentials, grants, and indexes by source instance, not by bare connector.
- Preserve user-facing labels separately from stable IDs.

Open question: which parts of this become PDPP/Collection Profile normativity versus reference-only implementation discipline.

## Promotion Trigger

Promote this into an OpenSpec change before implementing any of:

- connector configuration UI
- multiple configured accounts for one connector
- account-specific credential storage
- source-instance-aware scheduler behavior
- source-instance-aware record/state/index storage
- multi-account grants or consent display

## Decision Log

- 2026-04-24: Captured after asking whether PDPP, the Collection Profile, and the reference support multiple accounts or multiple configurations per account. Answer: conceptually yes, but the current reference is not fully productized for it because most first-party polyfill connectors are still modeled as one connector per platform.
- 2026-05-18: Superseded by `connection-first-collection-identity-2026-05-18.md`. The collision problem remains accepted, but the preferred solution is first-class `connection` / internal `connector_instance` with structured bindings, not first-class top-level `source_instance` by default.
