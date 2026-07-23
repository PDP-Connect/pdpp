## Context

The tracked census includes 1,213 test-like paths, while the reference runner's
current rules execute 698. Package and app runners have additional, independent
globs and explicit lists. The smallest useful seam is a source-derived checker
around existing runners; runners remain responsible for execution and the checker
owns classification and parity.

## Goals and non-goals

Goals are complete discovery, structured execution evidence, explicit profile
skips, and stale-task invalidation. This change does not choose a test framework,
convert tests to TypeScript, change product behavior, or make live services a
required dependency where the repository declares an optional profile.

## Decisions

- Derive tracked paths with `git ls-files`, classify `.test.js`, `.test.mjs`,
  `.test.cjs`, `.test.ts`, `.test.tsx`, `.test.py`, `.test.sh`, `.spec.js`, and
  `.spec.ts`, plus `test`/`tests` directories. The manifest records exact
  intentional exclusions with path, reason, owner, profile, and expiry.
- Check the planned set before execution and validate JSON receipts afterward.
  A receipt records exact normalized files, assertions (or explicit `null` with
  a mutation oracle), passes, failures, skips, reasons, profile, SHA, and exit.
- Required profiles that cannot run are failures. Optional profiles are visible
  skips with a declared predicate and reason; skips are never silently treated as pass.
- Runtime edges are declared for dynamic imports, subprocesses, Docker commands,
  generated files, exports, bins, and scripts. An edge hash is part of a task
  closure, not inferred from a task title.
- A task packet is valid only at its exact base SHA with its closure hash and
  atomic lease. Integration invalidates packets whose base, closure, or forbidden
  shared paths no longer match.

## Alternatives rejected

Count-only checks, filesystem-only globs, and a static ledger are insufficient:
they cannot prove replacement identity, runtime targets, or stale work. Replacing
all runners with one new framework would add infrastructure without closing the
specific false-pass seam.

## Acceptance checks

The checker must pass on the unmutated fixture corpus and fail nonzero for every
required mutation in the spec and tasks. The exact commands are recorded in
`tasks.md`; all checks are local and deterministic.
