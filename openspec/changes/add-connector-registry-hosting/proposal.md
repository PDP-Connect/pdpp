# add-connector-registry-hosting

## Why

Docker reference deployments need browser-managed connectors to resolve their
declared manifest URLs without relying on ambient public DNS or an untracked
local compose edit.

## What Changes

- Add an in-network `registry-mock` service to the n.eko compose overlay.
- Serve bundled polyfill connector manifests at the current canonical
  `registry.pdpp.org` host inside the compose network.
- Make `reference` depend on that service when the n.eko overlay is enabled.

## Capabilities

Modified:
- `reference-implementation-architecture`

## Impact

- Docker-only runtime topology changes for the reference n.eko overlay.
- No PDPP protocol change.
- No connector manifest identity migration.
