# reference-surface-topology deltas: adopt-single-release-channel

## MODIFIED Requirements

### Requirement: Deployment-diagnostics SHALL surface collector protocol-version and runner-version drift

The reference deployment-diagnostics dashboard surface SHALL render the bound collector's protocol version, runner version, and bundled connector versions alongside the existing runtime-capabilities bindings list, so an operator can see whether a paired collector is compatible with the running reference server.

#### Scenario: Compatible collector is paired

- **WHEN** a collector whose protocol version is in the server's accepted set is paired
- **THEN** the dashboard SHALL render `collector_protocol_version`, `runner_version`, and `connector_versions` on the runtime-capabilities row
- **AND** the dashboard SHALL NOT raise a `collector_protocol_outdated` warning

#### Scenario: Outdated collector is paired

- **WHEN** a collector whose protocol version is not in the server's accepted set is paired
- **THEN** the dashboard SHALL raise a `collector_protocol_outdated` warning distinct from `browser_connectors_need_collector`
- **AND** the warning SHALL link to the operator action (`npm i -g @pdpp/local-collector`, which resolves the published release on npm's default `latest` dist-tag) without exposing device tokens or local paths

### Requirement: Public operator copy SHALL advertise the npm-installable collector path as the supported public flow

The public dashboard, `pdpp connect` copy, and operator-facing docs SHALL advertise `npx -y @pdpp/local-collector ...` (or a global install of the same package, which resolves the published release on npm's default `latest` dist-tag) as the supported public path for filesystem-class connector collection on a fresh host. Monorepo-clone instructions SHALL remain available only as a development path, not as the primary public flow.

#### Scenario: Operator reads `pdpp connect` or dashboard onboarding copy

- **WHEN** an operator reads the public onboarding copy for Claude Code / Codex collection
- **THEN** the copy SHALL show `npx -y @pdpp/local-collector ...` (or `npm i -g @pdpp/local-collector`) as the primary instruction
- **AND** the copy SHALL NOT pin the retired `@beta` dist-tag
- **AND** the copy SHALL NOT lead with `git clone` of the monorepo for filesystem-class connectors

#### Scenario: A browser-bound connector is documented

- **WHEN** the dashboard surfaces a connector whose runtime bindings include `browser`
- **THEN** the surface SHALL clearly indicate that the public `@pdpp/local-collector` does not yet ship browser-class collection
- **AND** the surface SHALL NOT imply that `npx -y @pdpp/local-collector` covers browser-bound connectors
