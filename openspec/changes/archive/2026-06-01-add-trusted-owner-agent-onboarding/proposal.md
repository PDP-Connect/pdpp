## Why

A local owner-trusted assistant such as Daisy needs a smooth way to discover an owner-operated reference instance, request owner approval, and then keep a token-efficient local view of the owner's current and future data. The current agent workflow correctly discourages owner-token shortcuts for routine third-party/coding agents, but it does not distinguish that least-privilege path from an explicit trusted owner-agent profile.

## What Changes

- Define a trusted owner-agent onboarding profile for local agents that act as the owner, separate from grant-scoped third-party agents.
- Add discovery requirements so an agent can start from an entrypoint URL or `.well-known` metadata and learn the correct approval, token, schema, cursor, and subscription surfaces.
- Require browser-mediated owner approval and non-printing token handoff; the agent must not ask the owner to paste bearer material.
- Preserve the current route boundary: owner-agent credentials are for owner-level REST/control-plane workflows, while `/mcp` remains grant/client-scoped and rejects owner bearers.
- Define token-efficient data access expectations: metadata-first discovery, connection-scoped reads, cursors, `changes_since`, blobs by reference, and event subscriptions or polling based on capability.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-agent-access-workflow`: Distinguish grant-scoped agent access from the trusted local owner-agent profile and define the onboarding/discovery expectations for that profile.
- `reference-implementation-architecture`: Define the reference metadata, owner approval, REST-only owner credential boundary, and efficient-sync behavior required to support trusted owner-agent onboarding.

## Impact

- Affected surfaces: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `GET /`, owner deployment-token/token management surfaces, `/v1/schema`, `/v1/streams`, `/v1/*` read APIs, event-subscription APIs, and `/mcp` auth rejection.
- Affected docs/skills: `docs/agent-skills/pdpp-data-access`, operator onboarding docs, and Daisy/local-agent runbooks.
- Security posture: high. This intentionally supports owner-level local automation, so discovery, approval, storage, revocation, and route boundaries must be explicit and auditable.
