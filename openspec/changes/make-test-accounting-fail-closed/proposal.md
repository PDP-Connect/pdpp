## Why

Current runners discover different subsets of the 1,213 tracked test-like files. A
test renamed during modernization can disappear while the remaining suite passes,
and task packets can be applied to a stale integration head.

## What Changes

- Add a Git-derived, versioned test manifest covering legacy and TypeScript test extensions.
- Require pre-run discovery parity and post-run file, assertion, skip, and profile receipts.
- Make unknown, missing, duplicate, stale, malformed, empty, and unobserved selections fail closed.
- Add mutation probes for discovery, runtime edges, generated drift, assertion/skip shrinkage, and stale task bases.
- Treat the task ledger as advisory scheduling data with base/closure hashes, ownership, runtime edges, and atomic leases.

## Capabilities

- Added: `test-accounting`

## Impact

The change affects test runner wrappers, the checked manifest, accounting scripts,
CI checks, and modernization task packet metadata. It does not migrate production
or test files and does not mutate remote or live state.
