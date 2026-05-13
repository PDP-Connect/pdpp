## 1. OpenSpec

- [x] 1.1 Create the `extract-remote-surface-substrate` proposal, design, tasks, and spec delta.
- [x] 1.2 Note the dependency from `add-dynamic-neko-surface-allocation` to the extracted substrate.
- [x] 1.3 Validate this change and the dynamic allocation change with `openspec validate --strict`.

## 2. Package Boundary

- [x] 2.1 Move the pure browser-surface lease model and manager into `@pdpp/remote-surface`.
- [x] 2.2 Add backend allocator interfaces without importing reference, server, Docker, app, or connector code.
- [x] 2.3 Keep reference-specific env parsing and connector launch env assembly in the reference implementation.

## 3. Reference Integration

- [x] 3.1 Preserve public names through package exports and the compatibility shim.
- [x] 3.2 Update workspace/package dependency configuration as needed for resolution.
- [x] 3.3 Run targeted browser-surface lease/controller tests and package typecheck/tests.

## 4. Acceptance Checks

- [x] 4.1 Confirm no forbidden imports exist in `packages/remote-surface`.
- [x] 4.2 Grep touched files for stale direct implementation patterns before handoff.
