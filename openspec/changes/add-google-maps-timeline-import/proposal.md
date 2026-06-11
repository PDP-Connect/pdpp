## Why

Google Maps Timeline is a high-value owner data source, but the existing Google Takeout connector exposes location history only as one stream inside a broad archive connector. Current Google guidance also makes Timeline export a device/app file flow, so a browser scraper would be the wrong first implementation.

## What Changes

- Add a first-party `google_maps` polyfill connector for owner-provided Google Maps Timeline export files.
- Support newer Timeline export JSON and legacy Google Takeout `Records.json` location files.
- Emit normalized Timeline point and segment streams with source-format provenance, emit-time validation, incremental cursors, and bounded progress messages.
- Keep the connector file-based: no Google login automation, no browser scraping, and no network binding.
- Correct the existing Google Takeout location manifest so `accuracy_meters` matches the parser/schema numeric contract.

## Capabilities

Modified:
- `polyfill-runtime`

Added:
- None.

Removed:
- None.

## Impact

- Adds a new manifest, connector runtime entrypoint, parser, schemas, and tests under `packages/polyfill-connectors`.
- Registers the connector with the local orchestrator and manifest registration smoke path.
- Does not change live stack deployment, OAuth, owner UI routing, or MCP/REST/CLI read contracts.
