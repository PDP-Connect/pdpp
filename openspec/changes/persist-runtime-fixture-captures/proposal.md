## Why

Live connector runs can enable fixture capture for diagnostics. The reference Docker stack mounted the capture directory from the deploy checkout, so deleting a temporary deploy checkout could leave the running container with an unusable capture path and wedge connector startup.

## What Changes

- Add an explicit runtime capture root setting for fixture capture artifacts.
- Default the composed reference stack to store live capture artifacts under persistent runtime storage.
- Keep local development behavior unchanged when the setting is unset.

## Capabilities

Modified:
- `polyfill-runtime`

## Impact

- Docker reference deployments no longer depend on a checkout bind mount for runtime captures.
- Local development still writes to `packages/polyfill-connectors/fixtures` unless overridden.
