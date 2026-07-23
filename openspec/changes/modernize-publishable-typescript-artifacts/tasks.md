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
- [ ] 2.4 Emit and prove MCP: exports, bin, installed help, stdio smoke, and
      resolution of candidate CLI/read-core rather than registry artifacts.

## 3. Together-install and runtime matrix

- [ ] 3.1 Build and pack all four candidates, then in a fresh directory run:
      `npm init -y` and `npm install --ignore-scripts <local-collector.tgz> <read-core.tgz> <cli.tgz> <mcp.tgz>`.
- [ ] 3.2 Assert every resolved identity is a candidate path under
      `node_modules/@pdpp/*`; inspect `npm ls --all`; run
      `npx --no-install pdpp --help`, `pdpp-local-collector --help`, and
      `pdpp-mcp-server --help`, plus MCP stdio and CLI collector probes.
- [ ] 3.3 Repeat at Node 22.14.0 and repository Node 25; add Node 26 for affected
      Neko/Docker paths. Record any declared optional profile explicitly.

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

## Acceptance checks

- [ ] A. Each affected package's build, typecheck, pack, export/bin, install, and runtime gates pass.
- [ ] B. The together-install oracle passes for all four candidate tarballs at the required runtimes.
- [ ] C. `pnpm release:policy-check:test`, test-accounting verification, and
      `git diff --check` pass; no registry fallback is observed.
- [ ] D. `openspec validate modernize-publishable-typescript-artifacts --strict`.
- [ ] E. `openspec validate --all --strict`.
