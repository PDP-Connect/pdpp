## Why

The public specification route eagerly compiles every MDX document during development. The largest protocol specification can exhaust the Node.js heap before the route renders.

## What Changes

- Load specification document bodies on demand while retaining eager metadata for navigation and static parameters.
- Add the Fumadocs remote-MDX runtime required by dynamic document collections.
- Keep the generated Fumadocs source artifacts in lockstep with the source configuration.

## Capabilities

- Modified: `reference-surface-topology`

## Impact

- Affected code: `apps/site` specification source generation and page rendering.
- Added dependency: `@fumadocs/mdx-remote`.
- No protocol semantics, document content, route shape, or public navigation changes.
