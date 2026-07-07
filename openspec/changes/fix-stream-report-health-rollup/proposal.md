## Why

The source list can show a connection as `Healthy` while the same connection's
stream rows report `partial` / `resumable` coverage. That is a shared projection
bug: the connection-level health rollup is computed before the per-stream
collection report and can miss stream-level shortfalls.

## What Changes

- Roll each connection's derived stream collection report back into the
  connection-level coverage axis before rendering the source pill.
- Keep accepted stream policies (`inventory_only`, `deferred`, `unsupported`,
  `unavailable`) out of the degrading rollup unless they already map to a
  degrading coverage condition.
- Add regression coverage for a succeeded run whose stream report is partial.

## Capabilities

- Modified: `reference-connection-health`

## Impact

- Owner source surfaces stop labeling a connection healthy when its own streams
  still have resumable or terminal coverage work.
- The change is connector-neutral and uses existing collection-report evidence.
