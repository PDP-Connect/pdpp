# Connection-First Collection Identity

Status: captured
Owner: protocol / reference implementation owner
Created: 2026-05-18
Updated: 2026-05-18
Related: `design-notes/source-instances-and-multi-account-configurations-2026-04-24.md`, `design-notes/source-authority-vs-schema-identity-2026-04-30.md`, `design-notes/gmail-attachments-and-multi-instance-readiness-2026-05-15.md`, `spec-collection-profile.md`, `openspec/changes/define-connector-instances`

## Question

What is the smallest durable identity model that supports multiple accounts, multiple local devices, browser-backed sources, schedules, state, health, and provenance without adding incidental complexity?

## Context

The older source-instance note correctly identified a real problem: bare `connector_id` cannot safely namespace records, state, credentials, schedules, grants, indexes, or diagnostics once one owner has multiple accounts or configurations for the same connector type.

Recent local-collector and prior-art review sharpened the model:

- `connector_id` names connector type / manifest / implementation.
- The Collection Profile uses `runtime` for the component that satisfies `runtime_requirements.bindings`, sends `START`, handles `RECORD` / `STATE` / `INTERACTION`, and persists state at valid durability boundaries.
- A device, browser profile, n.eko surface, filesystem path, OAuth credential, or local source home is not itself necessarily the durable user-facing collection unit.
- The owner-facing product noun should be `connection`: one configured thing the owner can add, pause, refresh, inspect, schedule, and revoke.

This note uses `connection` as the product noun and `connector_instance` as the current reference-internal durable key. It intentionally avoids promoting `source_instance` as a peer top-level noun unless a future invariant proves that bindings need independent lifecycle, authority, schedules, health, or grants.

## Stakes

The wrong model creates either data collisions or unnecessary object sprawl.

Too few durable identities:

- two Gmail accounts collide in state, schedules, records, and health;
- two Claude Code homes on different devices overwrite or hide each other;
- browser-backed profiles become implicit, hard-to-debug global state;
- owner UX cannot explain what is stale, blocked, paused, or revoked.

Too many first-class identities:

- `connection`, `connector_instance`, `source_instance`, `device`, and `runtime` become overlapping nouns;
- simple cases require managing objects users do not understand;
- grants, schedules, health, and runs have to choose among near-synonyms;
- implementation detail leaks into the product model.

## Current Leaning

Use a connection-first model:

```text
connector type  = implementation / manifest identity
connection      = one owner-configured source binding, internally connector_instance
runtime         = execution component that runs the Collection Profile protocol
run             = one execution attempt for one connection
record/artifact = admitted output with connection-aware provenance
grant           = authorization to access accepted PDPP data
```

`connection` should namespace or own:

- credential/profile/source-home binding metadata;
- state and checkpoints;
- schedules and automation policy;
- run history and active-run exclusion;
- health, gaps, and diagnostics;
- record/artifact provenance and idempotency namespace.

Bindings remain structured metadata under a connection:

```text
connection.source_bindings[]
connection.credential_bindings[]
connection.runtime_requirements/preferences
connection.local_device_refs[]
connection.browser_profile_refs[]
```

A binding should become a first-class object only when it has independent lifecycle, authority, user action, schedule, health, grant semantics, or storage namespace requirements that cannot be expressed at the connection level.

Examples:

- `Gmail personal` is one connection. OAuth grant and Gmail account email are bindings.
- `Gmail work` is another connection, even though it uses the same connector type.
- `ChatGPT main` is one connection. Browser profile / n.eko surface are runtime resources or binding metadata, not separate connections.
- `Claude Code on MacBook` is one connection. Device id and source-home path hash are binding metadata.
- `Claude Code on desktop` is another connection.
- `Chase` may be one connection even if it yields multiple financial accounts, because those accounts are records/resources beneath the login unless they need independent lifecycle.

## Promotion Trigger

Promote this into OpenSpec before implementing or changing any durable contract that depends on this model, including:

- multi-account connection UI;
- moving records, blobs, state, schedules, active runs, gaps, health, or diagnostics from `connector_id` to connection/instance identity;
- changing the Collection Profile global-state namespace from connector-global to connection-scoped;
- replacing public or reference API fields such as `source_instance_id`, `connector_instance_id`, or `connector_id`;
- adding grant, query, or dashboard filtering by connection;
- packaging local collectors as a general connection execution runtime.

## Decision Log

- 2026-05-18: Captured after reviewing Collection Profile runtime terminology and local collector prior art. Decision: keep `runtime` aligned with the Collection Profile executor concept; prefer first-class `connection` / internal `connector_instance` over top-level `source_instance` unless future evidence proves a binding needs independent lifecycle or authority.
