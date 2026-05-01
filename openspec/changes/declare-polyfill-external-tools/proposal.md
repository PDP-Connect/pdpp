## Why

Some polyfill connectors depend on subprocess binaries that are neither npm dependencies nor PDPP runtime bindings. Slack currently requires `slackdump`, but that dependency is invisible in the manifest, consent/review surfaces, and operator setup.

## What Changes

- Add static `runtime_requirements.external_tools` manifest metadata.
- Retrofit Slack with a visible `slackdump` declaration.
- Validate `external_tools` declaration shapes at connector registration.
- Add manifest honesty coverage for connectors that reference known external tools.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`

## Impact

- Slack connector manifest.
- Reference connector-manifest validator.
- Polyfill connector manifest tests.
- Connector ecosystem docs and existing design-note status.
