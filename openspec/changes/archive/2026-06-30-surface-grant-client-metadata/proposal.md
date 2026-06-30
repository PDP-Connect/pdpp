# surface-grant-client-metadata

## Why

The Standing dashboard answers "who can read parts of me?" and "what has been read?" by summarizing `_ref/grants` and `_ref/traces`. Those summaries can carry only `client_id`, so live rows can render as raw `cli_...` identifiers even when the reference server has registered client metadata. That is honest but below the owner-comprehension bar.

## What Changes

- Add optional registered-client metadata to reference-only grant and trace summaries.
- Keep `client_id` as the verified identity anchor; treat `client_name` as display metadata.
- Use the metadata in the operator console when present, while preserving the raw `client_id` beside the name.

## Capabilities

- Modified: `reference-implementation-architecture`

## Impact

- Affects only the owner-authenticated `_ref/grants` reference surface and its operator-console consumer.
- Does not change PDPP Core, public RS APIs, token issuance, grants, or stored spine events.
