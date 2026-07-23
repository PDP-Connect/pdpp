## 1. Policy and baseline

- [ ] 1.1 Pin and fingerprint the resolved workspace Biome/Ultracite versions,
      Node/pnpm versions, config hashes, and exact selected/excluded path sets.
- [ ] 1.2 Add a machine-readable diagnostic receipt keyed by workspace, path, rule,
      category, message, and location, plus rule/severity totals and exception ledger.
- [ ] 1.3 Adjudicate every active rule and exclusion as defect, style, mismatch, or
      domain exception; record owner, scope, invariant, and expiry for exceptions.
- [ ] 1.4 Add selection mutation tests, including raw provider-capture exclusion,
      executable fixture retention, and selection shrinkage; require Biome/Ultracite equality.

## 2. Generated and bounded deterministic work

- [ ] 2.1 Make OpenAPI and site generated outputs generator-owned: run
      `pnpm reference-contract:check-generated` and the site generation/check when
      reachable; reject formatter-only generated drift.
- [ ] 2.2 Land policy/config/key-order decisions as one bounded tranche, including
      the scoped `useSortedKeys` policy; do not change serialized/query ordering by autofix.
- [ ] 2.3 Land formatter-only authored-source cohorts by disjoint package/subsystem,
      then separate braces, numeric separators, templates, and interface ordering.
- [ ] 2.4 Preserve and run a discriminating regression fixture before any semantic
      async, loop, regex, null-guard, delete, control-flow, or complexity repair.

## 3. RI and remaining cleanup

- [ ] 3.1 Reconstruct RI cleanup in bounded cohorts with default plus PostgreSQL/Docker
      proofs where touched; explicitly do not land the 910-file RI checkpoint.
- [ ] 3.2 Attribute every removed diagnostic to a reviewed diff or policy decision;
      fail on new tuples, baseline regressions, selection shrinkage, or untriaged findings.
- [ ] 3.3 Keep generated files, captured data, host-required JS/MJS, and required
      wrappers in explicit ledgers; do not convert files solely to reduce counts.

## 4. Receipts and review

- [ ] 4.1 Emit each tranche receipt with base/head SHA, closure/config hashes,
      selection and diagnostic fingerprints, exact tests/skips, generated hashes,
      relevant runtime gates, and retained exceptions.
- [ ] 4.2 Have a different checker/session review each tranche's actual diff and
      raw receipt before integration; serialize shared paths and high-risk RI subsystems.

## Acceptance checks

- [ ] A. `pnpm biome:selection` and full JSON diagnostics pass with equal selection,
      no unexplained baseline increase, and zero untriaged diagnostics.
- [ ] B. `pnpm reference-contract:check-generated`, relevant site generation/check,
      `pnpm spec:check`, affected package verifies, and `git diff --check` pass.
- [ ] C. Relevant `pnpm --dir reference-implementation run typecheck`, SQLite,
      PostgreSQL, Docker, and test-accounting gates pass; required profiles cannot skip.
- [ ] D. `openspec validate modernize-biome-policy-and-cleanup --strict`.
- [ ] E. `openspec validate --all --strict`.
