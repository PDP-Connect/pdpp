# reference-native-provider-boundary Specification

## Purpose
Define how the reference implementation keeps native-provider public contracts provider-first while preserving connector-shaped details only where they are implementation internals or polyfill-specific operational surfaces.
## Requirements
### Requirement: Native provider requests stay provider-first
The reference implementation SHALL treat native-provider requests as provider/source-bound requests, not as connector requests with hidden branding.

#### Scenario: Native grant request
- **WHEN** a client requests data from the native provider
- **THEN** the public request contract SHALL use `provider_id` and SHALL reject connector-shaped native requests that would blur the native-vs-polyfill boundary

#### Scenario: Native public artifacts
- **WHEN** the reference emits native grant, introspection, query, disclosure, or timeline artifacts
- **THEN** those public artifacts SHALL expose a provider/source descriptor and SHALL not expose connector-shaped storage identifiers

### Requirement: Polyfill-only operational surfaces stay out of the native public contract
The native provider realization SHALL not expose connector registry or Collection Profile operational routes as if they were part of the native public contract.

#### Scenario: Native public surface
- **WHEN** the server is running in native mode
- **THEN** connector registration and other polyfill-only operational routes SHALL be unavailable on the native public contract

#### Scenario: Native owner access
- **WHEN** an owner queries native-provider data through the public RS surface
- **THEN** that owner path SHALL work without requiring a public `connector_id`
