## Why

The current hosted MCP surface exposes every read and event-subscription tool in
one flat `tools/list` response. The first footprint tranche removes duplicated
prose, but it intentionally preserves the 14-tool topology. That is still too
broad for the normal read/query setup path.

The answer is not profiles. The SLVP design is one profile-free normal MCP
read entrypoint. Server-owned least-surface narrowing is essential for generic
MCP clients; profile taxonomy is incidental complexity and is not part of the
contract.

## What Changes

- Define the SLVP bar for the recommended MCP agent entrypoint: one normal setup
  path, least capability by default, low model-loaded surface, grant alignment,
  host awareness, reversibility, and evidence.
- Do not define, advertise, document, or branch on explicit profile selectors in
  hosted or local MCP setup.
- Make the recommended hosted MCP setup use the SLVP-selected normal read
  entrypoint without requiring users to understand `core`, `events`, or `full`.
- Keep event-subscription management out of the default model-loaded surface.
- Do not preserve full/developer MCP profiles as a user-facing or test
  requirement; tests SHALL gate the normal surface directly.
- Keep server `instructions` and concise tool descriptions from the footprint
  tranche, but treat them as supporting hygiene rather than the whole solution.
- Add regression measurements for the selected normal path and any advanced
  developer/test surfaces.
- Do not add a non-standard lazy-loading protocol, and do not collapse the API
  into one large operation-enum tool.
- Do not claim profiles are the only SLVP ideal. Host-native tool search,
  `allowed_tools` / tool allow-lists, grant-shaped tool availability, split
  workflow surfaces, resources/prompts, and agent skills remain part of the
  design space.
- Add an RI owner decision gate: setup UX and change acceptance cannot close
  until the recommended entrypoint is evaluated separately for Claude Code,
  Codex, ChatGPT/OpenAI Responses, and generic MCP clients.
- Add a dashboard-level setup page that gives ordinary AI apps one copy-paste
  entrypoint before deployment diagnostics, owner-token issuance, or advanced
  troubleshooting.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `mcp-adapter`: hosted and stdio MCP adapters expose a least-surface
  profile-free recommended entrypoint for agent setup. Explicit profiles are
  not retained as setup choices or a protocol branch.
- `reference-agent-access-workflow`: the operator dashboard exposes one
  ordinary-agent setup page with MCP, CLI, and agent-readable entrypoints while
  keeping owner-token onboarding separate.

## Impact

- Affects `packages/mcp-server` tool registration and tests.
- Affects hosted MCP routing and local stdio options by removing profile
  selection semantics.
- Affects operator setup copy so the recommended command points at the
  profile-free normal read entrypoint.
- Affects operator dashboard IA by adding `/dashboard/connect` and linking
  deployment diagnostics to it.
- No PDPP Core, Collection Profile, resource-server read contract, grant
  semantics, connector behavior, or owner-token posture change.
