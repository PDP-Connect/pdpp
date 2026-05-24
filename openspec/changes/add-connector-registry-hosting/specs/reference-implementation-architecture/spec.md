## MODIFIED Requirements

### Requirement: Native and polyfill realizations stay honest
The reference implementation SHALL support both native-provider and polyfill realizations over one engine substrate while keeping their public source identity honest. Public artifacts SHALL identify the data source with a single discriminated **source object** of shape `{ kind: 'connector' | 'provider_native', id: string }` rather than with parallel top-level `connector_id` and `provider_id` scalars. The kind discriminator names the realization; the `id` field carries the kind-keyed identifier (a registered connector id when `kind = 'connector'`, a registered native provider id when `kind = 'provider_native'`).

#### Scenario: Docker n.eko deployments resolve bundled connector manifests
- **WHEN** the reference Docker deployment runs the n.eko compose overlay for browser-managed polyfill connectors
- **THEN** the deployment SHALL provide an in-network manifest registry for the bundled polyfill connector manifests used by that overlay
- **AND** the in-network registry SHALL preserve the connector manifest's declared public connector identifier rather than inventing a Docker-only connector identity
