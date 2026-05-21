## MODIFIED Requirements

### Requirement: The website is a downstream consumer

The reference implementation's downstream consumer SHALL be split into two Next deployables — a public-site deployable (`apps/site` or its successor) and an operator-console deployable (`apps/console` or its successor) — that consume the reference implementation independently. Neither deployable SHALL define the primary reference contract. The public-site deployable SHALL NOT depend on a running reference-implementation AS/RS. The operator-console deployable SHALL act as the BFF in front of a co-deployed reference-implementation AS/RS for the operator's `/dashboard/**` experience.

#### Scenario: A bridge route exists for the operator console

- **WHEN** the operator-console deployable exposes a bridge route to the reference implementation
- **THEN** that bridge SHALL reflect the current reference contract honestly and SHALL not invent a stronger or different protocol contract than the underlying reference implementation exposes
- **AND** the bridge SHALL be owned by the operator-console deployable rather than by the public-site deployable

#### Scenario: The public site renders documentation and demos

- **WHEN** the public-site deployable renders protocol docs, the reference explainer, the mock sandbox, the OpenSpec viewer, the contributor workbench, or LLM index files
- **THEN** those artifacts SHALL be treated as derived explanatory surfaces rather than as the implementation boundary itself
- **AND** the public-site deployable SHALL build and serve without a running reference-implementation AS/RS process

#### Scenario: A downstream deployable changes independently

- **WHEN** the public-site deployable or the operator-console deployable changes its internal implementation
- **THEN** the forkable reference substrate in `reference-implementation/` SHALL remain the authoritative runnable implementation artifact rather than becoming coupled to deployable-specific code paths
- **AND** the other deployable SHALL be unaffected unless it explicitly shares code through the operator UI workspace package

## ADDED Requirements

### Requirement: The reference deployable shape SHALL be three independent artifacts

The reference implementation SHALL produce three independently buildable and deployable artifacts from this repository: the public-site deployable, the operator-console deployable, and the reference-implementation AS/RS service. Each SHALL be deployable without the others. Shared UI between the public-site sandbox and the operator-console dashboard SHALL live in a workspace package consumed by both rather than being duplicated.

#### Scenario: Three deployable artifacts exist

- **WHEN** the repository is built for release
- **THEN** the build SHALL produce a public-site deployable, an operator-console deployable, and a reference-implementation AS/RS deployable
- **AND** each artifact SHALL be deployable in isolation

#### Scenario: Sandbox and dashboard share UI

- **WHEN** the public-site sandbox and the operator-console dashboard render the same feature surface (records, search, grants, runs, traces, deployment, timelines, or related operator UI)
- **THEN** the shared feature components SHALL live in a workspace package (e.g. `packages/operator-ui`) imported by both deployables
- **AND** neither deployable SHALL duplicate those feature components in its own source tree

#### Scenario: The operator deploys console + reference only

- **WHEN** an operator runs `docker compose up` (or the equivalent local deploy) for a self-hosted PDPP reference instance
- **THEN** the operator-console deployable and the reference-implementation AS/RS service SHALL be sufficient to serve `/dashboard/**` and the AS/RS routes
- **AND** the public-site deployable SHALL NOT be required for that deployment to function

#### Scenario: The reference-implementation service stays a substrate

- **WHEN** the public-site deployable or the operator-console deployable evolves
- **THEN** the reference-implementation service SHALL remain runnable on its own (its existing CLI entrypoints, AS/RS HTTP routes, and `hosted-ui.js`-served `/consent`, `/device`, `/owner/login` pages SHALL keep working without the operator-console deployable)
- **AND** the reference-implementation service SHALL NOT acquire build-time or runtime dependencies on either Next deployable
