## 1. Ownership boundary

- [x] 1.1 Add `scripts/test-scratch/ownership.ts` with trusted placement,
      allocation capability, exclusive marker state, identity validation,
      quarantine cleanup, and conservative stale-root recovery.
- [x] 1.2 Add `scripts/test-scratch/run-command.ts` with exact argv parsing,
      owner/participant selection, inherited environment, POSIX process-group
      control, close-drained output, and exact exit/signal reproduction.
- [x] 1.3 Add deterministic fixtures and an independent lifecycle oracle for
      normal results, ambient-temp preservation, symlink/inode attacks,
      cleanup-failure precedence, nested/parallel descendants, signals,
      escalation, SIGKILL recovery, and stable recovery reason codes.
- [x] 1.4 Repair the launch handoff, early signal latch, journal-backed
      quarantine recovery, bounded rotating startup harvest, strict Linux UUID
      boot-ID parsing, and running-group absence proof; add deterministic
      crash, signal, fairness, and malformed-boot tests.

## 2. Canonical routing

- [x] 2.1 Add root `test:scratch` and route exactly the root aliases named in
      `design.md` through one owner; retain `reference-implementation:test` as
      a delegate.
- [x] 2.2 Route the public package test aliases and RI special modes in the
      twelve manifests named in `design.md` through the owner without changing
      their loaders, reporter arguments, cwd, concurrency, or secondary
      runners; do not add a `packages/list-envelope` front door.
- [x] 2.3 Route raw test commands in exactly the five workflows named in
      `design.md` through `pnpm test:scratch -- ...`.
- [x] 2.5 Install the pinned Node, pnpm, and workspace dependencies before the
      reference-stack project-safety workflow invokes the routed boundary.
- [x] 2.6 Add a lifecycle workflow for the owner oracle and canonical-entrypoint
      ratchet, with the sole reviewed direct lifecycle command documented
      because inheriting an owner would invalidate the oracle; trigger it for
      every host-writer source extension it inventories and run the honest
      scoped strict TypeScript project for lifecycle/canonical sources and
      fixtures.
- [x] 2.7 Keep lifecycle and canonical-entrypoint oracle tests out of the
      inherited-owner accounting batch. Add a dedicated, exact-one-owner suite
      with a manifest-validated complete capability scrub and prove both the
      spawned environment boundary and bounded outer-owner completion.
- [x] 2.4 Add the repository-derived canonical-entrypoint ratchet over package
      manifests and workflow YAML run blocks; permit only owned routes,
      reviewed delegates, or explicit reviewed exemptions, and prove injected
      package/workflow bypasses fail without an inventory edit.

## 3. Confirmed host writers

- [x] 3.1 Migrate the exact RI browser-ledger to `tmpdir()` while retaining its
      immediate cleanup. The three named Netflix files are absent from this
      worktree (verified with `rg --files`), so no speculative migration was
      made.
- [x] 3.2 Migrate only the exact n.eko network/dynamic-allocator scripts and
      path-contract tests named in `design.md` to the invocation root after
      Docker teardown ownership is preserved.
- [x] 3.3 Add the repository-derived executable-host-write ratchet with parsed
      JavaScript/TypeScript and shell write detection, narrow documented
      exceptions for parser fixtures, container paths, production/external
      roots, and the shared dynamic n.eko flock, and prove an injected writer
      fails without an inventory edit.

- [x] 3.4 Reject malformed nonce syntax at marker parsing and prove traversal,
      nested, absolute-looking, backslash, and encoded nonce variants retain
      their roots and cannot rename or delete an outside sentinel.

## 4. Documentation and acceptance

- [x] 4.1 Document `pnpm test:scratch -- <command> [args...]`, its canonical
      containment promise, infrastructure-failure behavior, and raw-command
      bypass boundary in `CONTRIBUTING.md`.
- [ ] 4.2 Run focused lifecycle and static-ratchet tests, affected script and
      package tests, RI tests, accounting checks, formatter/typecheck, and
      `openspec validate contain-test-scratch --strict`.
- [ ] 4.3 Inspect the final diff; read every touched file; grep migrated old
      paths and every reviewed exception pattern; record unrelated baseline
      failures separately with command evidence.
