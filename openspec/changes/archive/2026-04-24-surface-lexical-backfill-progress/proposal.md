## Why

Lexical index rebuilds can take long enough that operators see log lines but
the dashboard still looks idle. Semantic indexing already surfaces progress on
`/dashboard/deployment`; lexical backfill should provide the same operational
visibility.

## What Changes

- Track active lexical backfill jobs in the reference server.
- Expose lexical backfill progress through `/_ref/deployment`.
- Render lexical progress and warnings on `/dashboard/deployment`.
- Keep the progress surface reference-only and out of PDPP protocol metadata.

## Capabilities

### New Capabilities

*(none)*

### Modified Capabilities

- `reference-implementation-architecture`: add lexical backfill progress to
  reference deployment diagnostics.

## Impact

- `reference-implementation/server/search.js`
- `reference-implementation/server/deployment-diagnostics.ts`
- `apps/web/src/app/dashboard/deployment/page.tsx`
- `apps/web/src/app/dashboard/lib/ref-client.ts`
- Focused diagnostics tests.
