## MODIFIED Requirements

### Requirement: Native provider requests stay provider-first
The reference implementation SHALL treat native-provider requests as provider/source-bound requests, not as connector requests with hidden branding. Native-provider public artifacts SHALL identify the source with a single discriminated **source object** of shape `{ kind: 'provider_native', id: <native provider id> }` rather than with a top-level `provider_id` scalar.

#### Scenario: Native grant request
- **WHEN** a client requests data from the native provider
- **THEN** the public request contract SHALL carry a source object whose `kind` is `provider_native` and whose `id` is the configured native provider id
- **AND** the contract SHALL reject requests that present a top-level `provider_id` scalar, a top-level `connector_id` scalar, a `kind` of `connector`, or any shape that would blur the native-vs-polyfill boundary

#### Scenario: Native public artifacts
- **WHEN** the reference emits native grant, introspection, query, disclosure, or timeline artifacts
- **THEN** those public artifacts SHALL expose the canonical source object (`kind = 'provider_native'`, `id = <native provider id>`)
- **AND** those artifacts SHALL NOT expose connector-shaped storage identifiers
- **AND** those artifacts SHALL NOT expose a top-level `provider_id` scalar alongside the source object

### Requirement: Polyfill-only operational surfaces stay out of the native public contract
The native provider realization SHALL not expose connector registry or Collection Profile operational routes as if they were part of the native public contract.

#### Scenario: Native public surface
- **WHEN** the server is running in native mode
- **THEN** connector registration and other polyfill-only operational routes SHALL be unavailable on the native public contract

#### Scenario: Native owner access
- **WHEN** an owner queries native-provider data through the public RS surface
- **THEN** that owner path SHALL work without requiring a public `connector_id` query parameter or a connector-kind source object
- **AND** native-source discovery responses SHALL identify the source with the canonical source object whose `kind` is `provider_native`
