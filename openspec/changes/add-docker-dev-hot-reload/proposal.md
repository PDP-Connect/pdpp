## Why

The Docker Compose path currently runs production-built images. That is useful
for smoke validation, but it is slow for iterative reference implementation and
dashboard work because source edits require image rebuilds.

## What Changes

- Add a Docker Compose development override for hot reload.
- Bind-mount the repo source into containers while preserving container
  `node_modules` in named volumes.
- Run the reference server with Node watch mode and the web app with Next dev.
- Document the dev command separately from the production/smoke Compose path.

## Capabilities

### New Capabilities

*(none)*

### Modified Capabilities

- `reference-implementation-architecture`: document supported Docker dev
  assembly behavior for local hot reload.

## Impact

- New `docker-compose.dev.yml`.
- Root npm script and README updates.
- No PDPP protocol changes.
