## Why

`swap-sqlite-driver` bundled two different goals: replacing the crash-prone SQLite driver and extracting SQL into inspectable artifacts. The driver swap has landed; query extraction remains valuable, but it should now be evaluated on inspectability and maintainability rather than native-driver stability.

## What Changes

- Create a dedicated reference-query inspectability tranche.
- Extract static SQL used by the reference implementation into named `.sql` artifacts and a typed query registry.
- Add validation that query artifacts parse against the live schema before they are treated as implementation-ready.
- Keep dynamic query construction explicit in code where static extraction would make behavior harder to audit.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: SQL query surfaces become explicit, named, and mechanically inspectable reference artifacts.

## Impact

- `reference-implementation/server/**`
- `reference-implementation/runtime/**`
- `reference-implementation/lib/**`
- `reference-implementation/test/**`
- future dashboard/operator query-inspection surfaces
