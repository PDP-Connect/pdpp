## Why

Trusted local agents such as Daisy and Simon can now obtain owner-agent credentials and read owner-visible data, but they cannot discover or initiate owner data-source lifecycle operations such as adding another Amazon account. The reference needs a complete, safe owner-agent REST control surface so trusted agents can help operators manage current and future data without collapsing back to bearer-copy debugging or dashboard-only workflows.

## What Changes

- Define an owner-agent REST control surface for operator-grade actions: discover connector templates, list connection instances, initiate new connection intents, label/rename connections, run/schedule/pause/resume connector instances, inspect diagnostics, and revoke/delete connections where supported.
- Preserve the split between routine scoped-agent data access and trusted owner-agent administration: MCP remains grant-scoped and rejects owner bearers; owner-agent REST can perform owner-approved admin operations.
- Require every owner-agent-visible connection surface to expose both connector type identity (`connector_id` / `connector_key`) and configured binding identity (`connection_id` / `connector_instance_id`) with an owner-meaningful `display_name`.
- Model new-connection creation as a typed owner-mediated intent, not a silent headless login. The control surface returns OAuth, browser-assistance, upload/import, or local-collector enrollment steps as appropriate for the connector.
- Add acceptance checks using Amazon as the motivating multi-connection case: agents must be able to tell template `amazon` apart from one or more Amazon connection instances, initiate a second connection flow, and address the intended connection by `connection_id`.

## Capabilities

### New Capabilities

- `reference-owner-agent-control-surface`: Trusted owner-agent REST administration for connector and connection lifecycle operations on a reference instance.

### Modified Capabilities

- `reference-agent-access-workflow`: Distinguish default scoped client grants from explicitly approved trusted owner-agent credentials that may perform owner REST administration.
- `reference-connector-instances`: Require owner-agent and operator control surfaces to expose configured connection identity and owner-meaningful labels, not connector-key-only targets.

## Impact

- Affected APIs: `/.well-known/oauth-protected-resource`, owner-agent metadata, `/_ref/*` or equivalent owner REST routes, connector/connection listing, connection intent creation, run/schedule management, and local-agent CLI guidance.
- Affected code areas: `reference-implementation/server/routes/ref-connectors.ts`, owner auth/owner-agent bearer guards, connector instance store, CLI owner-agent commands, dashboard copy, tests, and OpenSpec specs.
- No breaking change to grant-scoped MCP or public read semantics. Owner bearer acceptance remains explicit to owner REST routes and does not make `/mcp` an owner-admin surface.
