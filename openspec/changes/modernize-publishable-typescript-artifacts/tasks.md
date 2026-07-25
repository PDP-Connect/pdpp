## 1. Contract and discovery prerequisites

- [ ] 1.1 Add package contract checks for emitted files, declarations, `exports`,
      `main`, `types`, bins, tarball contents, dependency ranges, and source/test exclusion.
- [ ] 1.2 Land/consume the test-accounting discovery parity gate before renaming
      or migrating any test; record exact before/after files, assertions, and skips.
- [ ] 1.3 Add per-tranche receipts containing base/head SHA, closure hash, build,
      typecheck, tarball file list/hash, resolution paths, Node version, and runtime output.

## 2. Emitted package pilots

- [ ] 2.1 Emit and prove read-core: build, declarations if exposed, pack, import
      every export, install in an empty project, and run its installed suite.
- [ ] 2.2 Emit and prove CLI: all exports and `dist/bin/pdpp.js`, installed help,
      package smoke, and optional local-collector subprocess behavior (including
      deliberate failure when the sibling is absent).
- [ ] 2.3 Preserve or rebuild local-collector's existing emitted connector closure;
      prove its package contract and its installed CLI-shim interaction.
- [x] 2.4 Emit and prove MCP: exports, bin, installed help, stdio smoke, and
      resolution of candidate CLI/read-core rather than registry artifacts.
      Evidence: `packages/mcp-server/scripts/package-contract.ts` verifies
      emitted-only declared targets and packed contents;
      `packages/mcp-server/scripts/pack-install-run.ts` requires a clean
      tracked/untracked tree, rebuilds CLI/read-core candidates from the current
      reviewed head, binds each installed candidate to base/head/source-closure,
      source-tarball, and release-candidate tarball hashes before a two-step
      install (offline for the zero-external-dependency CLI/read-core
      candidates, online for MCP's own real external registry dependencies,
      with `pnpm-workspace.yaml` overrides still pinning the local candidates
      regardless of network mode), hashes each installed tree against its
      tarball, imports each declared export, executes the bin, and performs
      `initialize` plus `tools/call(schema)`. All five build/artifact scripts
      (`build.ts`, `package-contract.ts`, `artifact-receipt.ts`,
      `installed-stdio-probe.ts`, `pack-install-run.ts`) are TypeScript.
      The shared matrix still owns its cross-package runtime/version receipts.

## 3. Together-install and runtime matrix

- [ ] 3.1 Build and pack all four candidates, then in a fresh directory run:
      `npm init -y` and `npm install --ignore-scripts <local-collector.tgz> <read-core.tgz> <cli.tgz> <mcp.tgz>`.
- [ ] 3.2 Assert every resolved identity is a candidate path under
      `node_modules/@pdpp/*`; inspect `npm ls --all`; run
      `npx --no-install pdpp --help`, `pdpp-local-collector --help`, and
      `pdpp-mcp-server --help`, plus MCP stdio and CLI collector probes.
- [ ] 3.3 Repeat at Node 22.14.0 and repository Node 25; add Node 26 for affected
      Neko/Docker paths. Record any declared optional profile explicitly.
- [x] 3.4 Establish the integration-owned CLI/read-core pilot authority: use
      digest-pinned Node 22.14.0 and repository Docker Node rows, provision the
      repository-pinned pnpm with its recorded integrity, run the package-local
      exact-floor gates, and install only the two candidate tarballs together in
      a network-disabled consumer. Emit and replay-check a machine-readable
      receipt by rebuilding every row from the bound clean head and comparing
      image/runner/runtime/package-manager identities, tarball bytes/file lists,
      installed resolutions, export/bin probes, and canonical command-outcome hashes. Keep
      Docker and bootstrap networking out of ordinary package `verify`; add
      mutation coverage for resealed receipt/config/closure drift.

## 4. Runtime-class migration

- [ ] 4.1 Migrate only coherent production dependency closures in order:
      app/private leaves, private libraries, CLI/read-core, MCP, scripts/deploy,
      then RI helpers through runtime.
- [ ] 4.2 For every retained JS/MJS/config/wrapper, record owner, host/runtime
      reason, executable probe, and review condition; do not use mass conversion
      or diagnostic counts as completion criteria.
- [ ] 4.3 After a production closure passes, migrate its tests by runner boundary
      under dual-extension discovery and prove the executed set is unchanged
      except for recorded renames.
      `@pdpp/mcp-server` complete (2026-07-25): all 23 `test/*.test.js` files
      and `test/smoke-stdio.mjs` renamed to `.ts` (`git mv`, history
      preserved); `package.json`'s `test`/`test:read-surface` glob updated
      from `"test/*.test.js"` to `"test/*.test.ts"` and `test/smoke-stdio.mjs`
      to `test/smoke-stdio.ts`; executed suite count unchanged at 189/189
      passing tests before and after. Other packages in this task remain
      pending.

## Acceptance checks

- [ ] A. Each affected package's build, typecheck, pack, export/bin, install, and runtime gates pass.
- [ ] B. The together-install oracle passes for all four candidate tarballs at the required runtimes.
- [ ] C. `pnpm release:policy-check:test`, `pnpm release:matrix:test`, test-accounting verification, and
      `git diff --check` pass; no registry fallback is observed.
- [ ] D. `openspec validate modernize-publishable-typescript-artifacts --strict`.
- [ ] E. `openspec validate --all --strict`.
