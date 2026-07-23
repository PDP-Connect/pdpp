## 1. Inventory and manifest

- [x] 1.1 Add the Git-derived classifier and checked manifest schema, including
      suite/profile commands, normalized planned paths, and expiring exclusions.
- [x] 1.2 Add deterministic inventory and profile-selecting plan commands with
      exact option parsing.
- [x] 1.3 Bind the intended integration base to the manifest and require a clean
      worktree/index plus complete tracked-tree digest for authority execution.

## 2. Verifier-issued execution authority

- [x] 2.1 Add one authority that issues run IDs, nonces, freshness, child
      selection, execution, transcript, completion, and single-use verification.
- [x] 2.2 Route each manifest suite and normal package test command through that
      authority. Preserve RI `.test.ts` discovery.
- [x] 2.3 Require one structured child result per selected suite/profile and
      reject generic skips, missing required profiles, assertion shrinkage, and
      receipts outside Git-private authority state.

## 3. Mutation and task validity

- [x] 3.1 Preserve clean fixture mutations for renamed tests, unrecognized tests,
      empty selection, exclusion abuse, assertion removal, and skip addition.
- [x] 3.2 Preserve comment-masked dynamic-import and spawn-target mutations,
      require every manifest-command spawn edge, and source-resolve declared
      literals before accepting a closure.
- [x] 3.3 Preserve generated-artifact drift and a no-output generator mutation;
      run generators in an isolated copy after removing their output.
- [x] 3.4 Add a current task packet plus strict claim/validate commands for base,
      closure, ownership and forbidden paths, source-resolved runtime edges,
      generated artifacts, manifest, contained paths, and an atomic local
      lease/CAS receipt binding every closure input.

## Acceptance checks

- [ ] A. `node scripts/test-accounting/inventory.mjs --check --fail-on-unaccounted --fail-on-empty` on a clean worktree.
- [ ] B. `node scripts/test-accounting/authority.mjs --run --suite all` produces
      and consumes one verified receipt for every required suite/profile.
- [x] C. Run focused authority and packet fixture mutations; each returns a
      nonzero rejection before the unmutated fixture passes.
- [ ] D. `git diff --check`, relevant package suites, and
      `openspec validate make-test-accounting-fail-closed --strict`.
- [ ] E. `openspec validate --all --strict`.
