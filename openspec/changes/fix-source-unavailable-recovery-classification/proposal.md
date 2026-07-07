## Why

Live source health showed a stored-credential USAA connection projected as needing credential repair after the source login system reported `source_unavailable`.

The connector had not proved credential rejection. The connector already declared `source_unavailable` retryable, but the shared browser session-establishment wrapper converted the failure into a non-retryable terminal error before the outer runtime could apply the connector retryability pattern. That bad terminal event then persisted as a `refresh_credentials` known gap and the source-health projection over-promoted it into an owner reconnect action.

## What Changes

- Preserve connector retryability patterns when browser session establishment fails.
- Keep definitive auth failures mapped to credential repair.
- Prevent legacy `source_unavailable` run evidence from manufacturing a credential-required condition.
- Add regressions for the shared runtime seam and the live source-health shape.

## Capabilities

Modified:

- `reference-connection-health`
- `polyfill-runtime`

## Impact

- USAA-like source outages no longer ask the owner to reconnect credentials without credential-rejection evidence.
- Browser-backed connectors keep their declared retryability semantics during session establishment.
- Existing credential-rejection and missing-credential paths are unchanged.
