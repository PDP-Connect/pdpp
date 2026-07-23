## 1. Inventory and manifest

- [ ] 1.1 Add the Git-derived classifier and checked manifest schema, including
      suite/profile commands, normalized planned paths, and expiring exclusions.
- [ ] 1.2 Add deterministic plan/check commands:
      `node scripts/test-accounting/inventory.mjs --check --sha HEAD` and
      `node scripts/test-accounting/inventory.mjs --plan --suite all --profile memory-default --json receipts/plan.json`.
- [ ] 1.3 Enumerate current runner boundaries, explicit lists, dynamic imports,
      subprocess targets, Docker inputs, generated paths, exports, and bins in the
      manifest or its owned runtime-edge file.

## 2. Runner receipts

- [ ] 2.1 Add the smallest runner wrapper seam that emits one JSON receipt per
      suite/profile with exact file, assertion, pass, failure, skip, reason,
      argv, SHA, and exit fields; never report unavailable assertions as zero.
- [ ] 2.2 Update RI and package/app runner boundaries to discover both legacy and
      TypeScript extensions where their loaders support them, retaining explicit
      host-required exclusions.
- [ ] 2.3 Add the verifier:
      `node scripts/test-accounting/inventory.mjs --verify receipts/*.json --manifest test-accounting.manifest.json`.
      Require exact tracked coverage, sorted unique paths, declared skips, and
      required profiles.

## 3. Mutation and task validity

- [ ] 3.1 Preserve clean fixture mutations for renamed tests, unrecognized tests,
      empty selection, exclusion abuse, assertion removal, and skip addition; each
      must make the checker exit nonzero.
- [ ] 3.2 Preserve dynamic-import and spawn-target mutations and require runtime
      edge hash/receipt mismatch to fail.
- [ ] 3.3 Preserve generated-artifact drift and stale-base mutations; require the
      generator check and task SHA/closure check to fail closed.
- [ ] 3.4 Add task metadata validation for base SHA, closure hash, owned paths,
      forbidden shared paths, runtime edges, executed-test manifest, and atomic lease.

## Acceptance checks

- [ ] A. `node scripts/test-accounting/inventory.mjs --check --fail-on-unaccounted --fail-on-unknown --fail-on-empty`.
- [ ] B. Run each affected runner with an accounting receipt, then run the exact
      `--verify` command above; no unreviewed required-profile skip is allowed.
- [ ] C. Run all mutation probes from §3 in isolated clean temporary fixtures and
      assert nonzero exit for each.
- [ ] D. `git diff --check`, relevant package suites, and
      `openspec validate make-test-accounting-fail-closed --strict`.
- [ ] E. `openspec validate --all --strict`.
