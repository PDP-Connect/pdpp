## Why

Expired open owner-action rows from older failed runs can remain in the durable attention table. If a later run succeeds, those stale rows must not be surfaced as current operator attention.

## What Changes

- Filter expired open attention rows out of the reference attention read model.
- Preserve the existing fail-open scheduler behavior when the attention store is unreadable.
- Cover the stale-row case with focused reference-implementation tests.

## Capabilities

Modified:

- `reference-implementation-runtime`

## Impact

- Scope is limited to reference-implementation attention projection and tests.
- No protocol surface, connector manifest, credential source, or live database mutation changes.
