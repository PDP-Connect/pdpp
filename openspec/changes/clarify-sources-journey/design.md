## Context

The operator console now has distinct surfaces for connection setup, record
inspection, and AI-app access. The route names and existing data make those
surfaces easy to conflate:

- Connections shows configured connection health and setup controls.
- Explore is where records are read and searched.
- Connect AI apps is where clients receive grant-scoped read access.

The fix is navigational clarity, not a new capability.

## Decision

The route will lead with an explicit three-step orientation:

1. Connections manages configured connections and repair actions.
2. Explore reads and searches collected records.
3. Connect AI apps grants scoped read access to clients and local agents.

The configured-connections list itself will use one visible status per row, anchored
before connection identity, with a subtle row tone for warning/destructive states.
Freshness text that the health model projects into `status.label` must remain
visible in the row instead of being demoted to a tooltip or screen-reader-only
dot.

The Add connections catalog will use the same distinction. It can describe supported
setup paths and existing connection reuse, but it must not sound like an AI-app
grant, MCP onboarding flow, or general record reader.

## Alternatives

- Rename `/dashboard/records` to `/dashboard/sources`: deferred. Route renaming
  has broader link and compatibility cost than this P1 needs.
- Fold connection setup into Connect AI apps: rejected. That recreates the "connect"
  ambiguity and mixes owner credentials with client read access.
- Add explanatory help text to every connection card: rejected. The confusion is at
  the journey level, so a single orientation strip is lower noise.

## Acceptance Checks

- OpenSpec validates with `openspec validate clarify-sources-journey --strict`.
- Connections IA invariant tests pin the three surface labels and routes.
- Normal owner UI still has no developer-only commands or raw setup-planner
  labels.
