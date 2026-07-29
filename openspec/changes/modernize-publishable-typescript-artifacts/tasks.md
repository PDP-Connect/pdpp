## 1. Contract and discovery prerequisites

- [x] 1.1 Add package contract checks for emitted files, declarations, `exports`,
      `main`, `types`, bins, tarball contents, dependency ranges, and source/test exclusion.
      Evidence: all four publishable packages already carry this machinery, executed
      2026-07-25 on `57da9e224`. `packages/read-core/scripts/validate-package.ts`
      (`pnpm --filter @pdpp/read-core validate-package`) asserted every `exports`
      target resolves under `dist/`, hashed the tarball
      (`0f6b85d89cf435fe17ba1f495657f26ed1a07408b749aa13182de442e2d4230e`), and
      printed the 3-file packed list (`README.md, dist/index.js, package.json`).
      `packages/cli/scripts/validate-package.ts` +
      `packages/cli/scripts/package-contract.ts` (`pnpm --filter @pdpp/cli
      validate:package`) asserted `main`/`types`/`exports`/`bin` targets land inside
      `dist/`, extracted the real tarball, and re-validated the extracted tree
      (62 files, `pdpp-cli-0.0.0.tgz`). `packages/local-collector/scripts/validate-package.ts`
      (`pnpm --filter @pdpp/local-collector validate:package`) asserted
      `main`/`types`/`exports["."].import`/`exports["."].types`/bin all resolve to
      packed files, rejected `src/`, `bin/`, `test/`, raw `.ts`, and `node_modules/`
      leakage, resolved every literal relative import (including dynamic imports)
      inside the packed `.js`/`.d.ts` tree, and rejected forbidden runtime imports
      (`playwright`, `patchright`, `imapflow`, `pdf-parse`, `better-sqlite3`,
      `linkedom`, `workspace:`) baked into any packed file — this ran clean as part
      of `pnpm --filter @pdpp/local-collector verify`. `packages/mcp-server/scripts/package-contract.ts`
      (`pnpm --filter @pdpp/mcp-server validate:package`, already the 2.4 evidence)
      covers the same shape for MCP. Dependency-range exclusion
      (`workspace:` rejection) is asserted non-vacuously in
      `packages/local-collector/scripts/validate-package.ts`, which loops
      `dependencies`/`optionalDependencies`/`peerDependencies` asserting no range
      starts with `workspace:`, and in `packages/mcp-server/scripts/package-contract.ts`
      (`assertManifestTargets`, dependency loop). For `read-core` and `cli` the
      requirement is satisfied vacuously rather than by assertion: neither manifest
      declares a `dependencies` key at all, so there is no range to exclude.
      No new script was needed; this box
      was closed by executing the existing four scripts and reading their real
      output, not by inspection.
- [x] 1.2 Land/consume the test-accounting discovery parity gate before renaming
      or migrating any test; record exact before/after files, assertions, and skips.
      Evidence: the previously-recorded gap — "not wired into CI or a pre-commit
      hook" — is now closed on this lane's base (`de1fcb33b`), landed by the
      independent R1 lane's merge and confirmed by commit ancestry: `git log
      --oneline de1fcb33b~1..de1fcb33b` shows `4c5e93624
      ci(test-accounting): wire the inventory-closure gate into lefthook and CI`
      and `53b4a9aa6 fix(test-accounting): wire the fail-closed closure check
      into the real authority path`, both ancestors of HEAD (`git merge-base
      --is-ancestor 4c5e93624 HEAD` / same for `53b4a9aa6` exit 0). Re-running the
      previously-negative probe now finds real hits: `grep -rn "test-accounting"
      .github/workflows/*.yml lefthook.yml` (executed 2026-07-25) returns
      `.github/workflows/test-accounting.yml` (a dedicated workflow, `on: push
      branches: [main]` / `pull_request`, both path-filtered to
      `.github/workflows/test-accounting.yml`, `scripts/test-accounting/**`,
      `test-accounting.manifest.json`, running `pnpm test-accounting:inventory`
      then `pnpm test-accounting:test` as required checks) and
      `lefthook.yml:147-149` (`test-accounting:inventory-closure`, glob-scoped to
      `{scripts/test-accounting/**,test-accounting.manifest.json}`, pre-push job
      `run: pnpm test-accounting:inventory`). `npx lefthook dump` (executed
      2026-07-25) confirms the job is actually registered, not just declared:
      `- name: test-accounting:inventory-closure / run: pnpm
      test-accounting:inventory`. Beyond the CI/hook wiring, the enforcement is
      not just a side-channel check — `scripts/test-accounting/authority.ts`'s
      `runAuthority()` (the real dispatch path every suite run goes through, per
      `scripts/test-accounting/authority-closure.e2e.test.ts`) itself now
      performs the closure check inline, so a discovery gap fails closed on the
      authority path itself, not only in a separate CI job.
      The substantive three-dimension capture (files, assertions, skips) was
      re-verified rather than re-trusted: `pnpm test-accounting:inventory`
      (executed 2026-07-25 on `de1fcb33b`) prints `test accounting: 1194
      executable, 45 helpers, 1188 planned, 6 excluded` (file-count parity, the
      counts moved from the previously-recorded 1192/1186 because other lanes
      added tests on this base — expected, not a regression). Reading
      `scripts/test-accounting/inventory.ts:672-699` (`assertCounts`) confirms
      it requires `counts.assertions === counts.passed + counts.failed +
      counts.skipped` (assertion parity, non-vacuous — `assertions === 0` alone
      fails) and calls `validateSkipReasons` plus checks
      `counts.skipped === sum(counts.skip_reasons values)` (skip parity, not
      just a skip count). `pnpm test-accounting:test` (executed 2026-07-25, 33/33
      passing — up from the previously-recorded 28/28 as new e2e coverage
      (`authority-closure.e2e.test.ts`) landed with the wiring) includes "fails
      closed when a renamed TypeScript test is not planned or excluded"
      (`inventory.test.ts:246`) and the new e2e test "e2e: a real mcp-server
      .test.ts renamed to .test.js (N->N-1, sibling glob still matches) fails
      closed on the runAuthority path" plus its inverse both-ways proof ("...
      makes the mcp-server rename mutation pass silently again"), which
      exercises the closure check on the real authority dispatch path against a
      genuine file-system rename, not a mock. All three enumerated dimensions
      (files, assertions, skips) and the CI/hook enforcement are now
      independently confirmed present and exercised.
- [x] 1.3 Add per-tranche receipts containing base/head SHA, closure hash, build,
      typecheck, tarball file list/hash, resolution paths, Node version, and runtime output.
      Evidence: the previously-recorded blocker (`ERR_MODULE_NOT_FOUND: Cannot
      find package 'tsx'` inside the Node 22.14.0 row container, a
      chicken-and-egg tsx bootstrap bug) is fixed by commit `3c554d09f`
      ("fix(release-matrix): bootstrap pnpm install before the TypeScript row
      entrypoint"), confirmed an ancestor of this lane's base:
      `git merge-base --is-ancestor 3c554d09f HEAD` exits 0. I ran the real,
      Docker-backed matrix end to end rather than re-trusting the unit tests:
      `pnpm release:matrix -- --receipt <temporary-receipt-dir>/release-matrix-receipt.json`
      (executed 2026-07-25 on `de1fcb33b`, Docker 29.6.2) built both row images
      (`node:22.14.0-bookworm-slim` and the repository's
      `node:25.8.2-bookworm-slim`), ran `pnpm install --frozen-lockfile
      --ignore-scripts --offline --store-dir /pdpp-pnpm-store` successfully
      inside each `--network none` container (the tsx bootstrap that previously
      failed), and completed with `Release matrix receipt:
      .../release-matrix-receipt.json`. I then replay-checked it:
      `pnpm release:matrix -- --verify-receipt
      .../release-matrix-receipt.json` (executed 2026-07-25) printed `Release
      matrix receipt replay is current: c54205a4-658d-41a8-bc13-18a3e548cd82` —
      a from-scratch second Docker run reproduced byte-identical evidence against
      the bound clean head (`assertReplayMatches`), not just schema validation.
      Element-by-element against the task text, read directly from the emitted
      receipt JSON:
      - **base/head SHA** — present: `snapshot.baseSha = 530e39ee9d490b...`
        (the immediate committed parent, `HEAD^`, per
        `currentSnapshot()`'s documented per-tranche binding — this receipt's
        own base differs from this packet's `de1fcb33b~4` base because the
        matrix binds tranche-to-tranche, not to this lane's packet base) and
        `snapshot.headSha = de1fcb33b990e...` (matches `git rev-parse HEAD`
        in this worktree).
      - **closure hash** — present: `snapshot.sourceClosure.sha256` (a real
        sha256 over a 3,582-file sorted source list) and repeated per-candidate
        as `candidates[].source.sourceClosureSha256`.
      - **build** — present: `rows[].commands` includes `pnpm --filter
        @pdpp/cli run build`, `@pdpp/read-core run build`,
        `@pdpp/local-collector run build`, `@pdpp/mcp-server run build`, each
        with `exitCode: 0` and a `resultSha256`.
      - **typecheck** — present, but implicit rather than a separate labeled
        step: each package's build script invokes `tsc -p
        tsconfig.build.json` (or `build.ts`, which shells out to the same),
        confirmed by reading `packages/read-core/scripts/build.ts`,
        `packages/mcp-server/scripts/build.ts`, and the `cli`/`local-collector`
        `package.json` build scripts directly — a type error fails the `build`
        command already recorded above with a nonzero exit code, so typecheck
        is exercised and would show up as a build failure, but there is no
        `commands[]` entry whose command array is literally `tsc --noEmit`.
      - **tarball file list/hash** — present: `candidates[].tarball.filename`,
        `.sha256`, and `.files` (a real per-file array, e.g. `@pdpp/cli`'s
        tarball listing `dist/bin/pdpp.js`, `dist/src/index.js`, etc.), for all
        4 candidates in each of the 2 rows.
      - **resolution paths** — present: `rows[].consumer.tree` is a real
        `npm ls --all --json` dependency tree with `resolved` paths per
        package (`file:/workspace/.release-matrix/candidates/....tgz` for the
        4 local candidates, `https://registry.npmjs.org/...` for their real
        transitive deps), plus `rows[].deepProbe.cliCollector.resolvedRunnerScript`
        (an installed-tree-relative resolved bin path).
      - **Node version** — present: `rows[].row.nodeVersion` (`v22.14.0`,
        `v25.8.2`) and `rows[].runtime.nodeVersion`/`.nodePath` (the actual
        `node --version` observed inside each container, matching the pinned
        row).
      - **runtime output** — present, captured as structured semantic output
        rather than raw stdout bytes (a deliberate design choice recorded in
        `runRecorded`'s own comment: package-manager logs are non-reproducible,
        so the receipt binds each command's deterministic outcome instead of
        pretending ephemeral logs are reproducible evidence): every
        `commands[]` entry has `exitCode` and a `resultSha256` binding
        `{command, cwd, exitCode}`, and `rows[].deepProbe` carries the actual
        observed runtime behavior of the installed packages —
        `cliCollector.advertiseMatchesDirect` (boolean equality between the
        installed CLI-shim's advertised output and the direct local-collector
        output), `mcpStdio.connectedToScopedCredential`,
        `mcpStdio.toolContract`, `mcpStdio.toolResultVersion` — real values
        read from the running installed packages, not placeholders.
      All eight enumerated elements are present in the real emitted receipt;
      the one caveat worth a future reader's attention is that "typecheck" is
      captured as an implicit side effect of the `build` command's exit code
      rather than its own named receipt field — functionally equivalent
      coverage, but not a literally separate ledger line.
      `pnpm release:matrix:test` (executed 2026-07-25 on `de1fcb33b`, 5/5
      passing) continues to unit-test the receipt shape and replay/mutation
      logic in isolation, now corroborated by the real run above rather than
      standing alone. The emitted receipt itself
      is a real generated artifact tied to an ephemeral local Docker run
      (absolute host-worktree paths inside `.tarball`/`.consumer` command
      records, a random `runId`, and machine-local Docker image IDs); this repo
      has no established location for committing generated release-matrix
      receipts (`reference-implementation/docs/receipts/` is a different,
      hand-curated benchmark-receipt convention with no absolute paths), so it
      is deliberately kept out of the repo rather than committed — re-running
      the two commands above reproduces it.

## 2. Emitted package pilots

- [x] 2.1 Emit and prove read-core: build, declarations if exposed, pack, import
      every export, install in an empty project, and run its installed suite.
      Evidence: `pnpm --filter @pdpp/read-core verify` (= `test` + `validate-package`
      + `pack-install-test`), executed 2026-07-25 on `57da9e224`, passed end to end.
      `test` ran 22/22 real node:test assertions (including
      `test/artifact-contract.test.ts` asserting build delegates emission to
      `tsc` and rejects source-only package contents, and a test asserting "test
      discovery finds a renamed TypeScript test and refuses to silently skip it").
      read-core has no `types` field (`assert.equal(manifest.types, undefined,
      "read-core does not expose a declaration contract")` in
      `validate-package.ts` — declarations are intentionally not exposed, verified
      rather than assumed). `pack-install-test` built, packed, installed the real
      tarball into a fresh empty `npm init -y` project with `--offline`, and ran a
      probe that imported every declared export; real output: `runtime=v25.8.2`,
      `resolved=.../node_modules/@pdpp/read-core/dist/index.js`, and all 13
      exported symbols (`binaryFieldMetadata`, `buildRecordContentLadder`, ...,
      `truncateText`) individually imported and listed.
- [x] 2.2 Emit and prove CLI: all exports and `dist/bin/pdpp.js`, installed help,
      package smoke, and optional local-collector subprocess behavior (including
      deliberate failure when the sibling is absent).
      Evidence: `pnpm --filter @pdpp/cli verify` (= `test` + `validate:package` +
      `pack-install-run`), executed 2026-07-25 on `57da9e224`, passed end to end.
      `test` ran 183/183 node:test assertions. `pack-install-run` packed the real
      tarball, installed it offline into a fresh consumer with no
      `@pdpp/local-collector` present, imported all 3 declared exports
      (`@pdpp/cli`, `@pdpp/cli/cache-layout`, `@pdpp/cli/package-info`) via a
      single `Promise.all(...map(import))`, resolved `import.meta.resolve("@pdpp/cli")`
      to `.../dist/src/index.js`, ran `npx --no-install pdpp --help` and matched
      `/PDPP CLI/`, and then ran `npx --no-install pdpp collector advertise`
      **expecting failure**: real captured output was `pdpp collector requires
      @pdpp/local-collector. Install once with "npm i -g @pdpp/local-collector" or
      run "npx -y @pdpp/local-collector ...".` — the deliberate-absence failure
      path is exercised and asserted, not simulated. The run emitted a full
      `ARTIFACT_RECEIPT` binding `gitHeadSha`, `packageContentSha256`,
      `tarballSha256`, and every subprocess's Node version/exec path.
- [x] 2.3 Preserve or rebuild local-collector's existing emitted connector closure;
      prove its package contract and its installed CLI-shim interaction.
      Fixed one genuine pre-existing bug to get here: `test/pack-metadata.test.ts`
      asserted `packageJson.scripts.prepack === undefined`, but
      `local-collector/package.json` has declared `prepack: "pnpm build"` since it
      was added, matching the `prepare`/`prepack` pair every other publishable
      package in this repo declares (`cli`, `read-core`, `mcp-server` all set
      both — confirmed by reading their `package.json` `scripts` blocks). Prior
      commit messages (`git log -p` on this file) explicitly flagged this as a
      known pre-existing failure across at least two prior script migrations
      without fixing it. Fixed the stale assertion to `"pnpm build"` (commit
      `57da9e224`, package-local test file, not a forbidden path). Evidence after
      the fix: `pnpm --filter @pdpp/local-collector verify` (= `test` +
      `validate:package`), executed 2026-07-25, now passes 102/102 (was 101/102).
      Separately ran `node --import tsx scripts/pack-install-run.ts` directly
      (not wired into `verify`) — real output: built/packed, installed offline
      into a fresh temp project, resolved and imported
      `@pdpp/local-collector`/`/runner`/`/errors`, confirmed the installed
      `pdpp-local-collector` bin is executable, exercised the browser-shaped
      runtime branch and confirmed it fails closed with the typed
      `browser_runtime_unavailable` capability code (not a raw
      `ERR_MODULE_NOT_FOUND`), ran `pdpp-local-collector advertise` from the
      installed package (`runtime: "collector"`, bindings
      `filesystem/local_device/network`, bundled connectors `claude_code/codex`),
      then installed the packed `@pdpp/cli` tarball alongside it in the same
      consumer and confirmed `npx --no-install pdpp collector advertise`
      (the CLI shim) returns byte-identical output to the standalone binary — this
      is the installed CLI-shim interaction proof the task asks for. It then
      booted the reference server in-process against an ephemeral SQLite DB and
      ran a fixture-backed `enroll` + `run --connector codex` through the
      installed binary end to end (`Fixture-backed enroll/run smoke PASS: 2
      record(s) persisted at ingest`), plus a `collector_protocol_mismatch` 409
      smoke. All output is real, captured stdout from the executed scripts, not
      inferred.
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

- [x] 3.1 Build and pack all four candidates, then in a fresh directory run:
      `npm init -y` and `npm install --ignore-scripts <local-collector.tgz> <read-core.tgz> <cli.tgz> <mcp.tgz>`.
      Evidence: `scripts/release-package-matrix.ts` (`PACKAGE_NAMES` already
      covered all four candidates) builds and `npm pack`s
      `@pdpp/cli`/`@pdpp/read-core`/`@pdpp/local-collector`/`@pdpp/mcp-server`
      from the bound clean head, then runs `npm init --yes` and
      `npm install --ignore-scripts --offline --force <cli.tgz> <read-core.tgz>
      <local-collector.tgz> <mcp.tgz>` together in one fresh consumer with
      Docker networking disabled (`pnpm release:matrix -- --receipt <file>`,
      run at both matrix rows, receipt + replay-check attached to the
      integration report).
- [x] 3.2 Assert every resolved identity is a candidate path under
      `node_modules/@pdpp/*`; inspect `npm ls --all`; run
      `npx --no-install pdpp --help`, `pdpp-local-collector --help`, and
      `pdpp-mcp-server --help`, plus MCP stdio and CLI collector probes.
      Evidence: the receipt's `consumer.tree` binds `npm ls --all --json` and
      `assertRowReceipt` asserts every candidate's `resolved` field is the
      local candidate tarball (never a registry URL) and every export/bin
      probe path stays inside its own `node_modules/@pdpp/*` root; the
      in-container consumer probe runs `npx --no-install` against all three
      declared bins. Beyond bare `--help`, a second consumer staged outside
      `/workspace` (so `@pdpp/cli`'s collector shim cannot fall back to the
      monorepo dev `bin/collector-runner.ts`) proves `pdpp collector
      advertise` reaches the *installed* `@pdpp/local-collector` candidate
      byte-identically to `pdpp-local-collector advertise` run directly, and
      drives the installed `@pdpp/mcp-server` stdio bin through
      `initialize` + `tools/call(schema)` via the same
      `runInstalledStdioProbe` helper 2.4 proved. Mutation-tested: a resealed
      registry-substituted `resolved` field, a resealed monorepo-dev-script
      escape, a resealed tampered tarball hash, and a resealed
      silently-failed MCP stdio connection each fail `assertReceipt`
      (`scripts/release-package-matrix.test.ts`).
- [x] 3.3 Repeat at Node 22.14.0 and repository Node 25; add Node 26 for affected
      Neko/Docker paths. Record any declared optional profile explicitly.
      Evidence: both required rows ran and passed with the receipt
      replay-checked — digest-pinned Node 22.14.0 (exact-floor gates) and the
      repository Docker Node 25.8.2 row (`.nvmrc`/root `Dockerfile`). Node 26
      checked explicitly and found NOT APPLICABLE: none of the four
      publishable candidates are installed inside a Node-26 image anywhere in
      this repository. `apps/console/Dockerfile` and `apps/site/Dockerfile`
      (`FROM node:26-slim`) each `COPY package.json` then `npm install`
      against only their own manifest (`@pdpp/brand`, `@pdpp/brand-react`,
      `@pdpp/operator-ui`, `pdpp-reference-implementation`) — none of the
      four candidates. `docker/neko/Dockerfile`'s `FROM node:26-slim AS
      patchright-chromium` stage installs only `patchright`, not any
      `@pdpp/*` package. `reference-implementation/package.json` does depend
      on `@pdpp/mcp-server` (`workspace:*`), but RI's own image is the root
      `Dockerfile`, pinned `ARG NODE_VERSION=25.8.2-bookworm-slim`, not 26.
      No declared optional profile exists to record. Node 26 remains an
      UNMET row only in the sense that it was affirmatively ruled
      not-applicable rather than executed; re-open this line if a future
      change makes any candidate reachable from a Node-26 image.
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

- [x] 4.1 Migrate only coherent production dependency closures in order:
      app/private leaves, private libraries, CLI/read-core, MCP, scripts/deploy,
      then RI helpers through runtime.
- [x] 4.2 For every retained JS/MJS/config/wrapper, record owner, host/runtime
      reason, executable probe, and review condition; do not use mass conversion
      or diagnostic counts as completion criteria.
- [x] 4.3 After a production closure passes, migrate its tests by runner boundary
      under dual-extension discovery and prove the executed set is unchanged
      except for recorded renames.
      `@pdpp/mcp-server` complete (2026-07-25): all 23 `test/*.test.js` files
      and `test/smoke-stdio.mjs` renamed to `.ts` (`git mv`, history
      preserved); `package.json`'s `test`/`test:read-surface` glob updated
      from `"test/*.test.js"` to `"test/*.test.ts"` and `test/smoke-stdio.mjs`
      to `test/smoke-stdio.ts`; executed suite count unchanged at 189/189
      passing tests before and after. Superseded 2026-07-28: the remaining
      package migrations are complete and are proved by the four-package
      release-matrix build/pack/together-install/runtime replay plus the
      fail-closed repository test-accounting authority.

## Acceptance checks

- [x] A. Each affected package's build, typecheck, pack, export/bin, install, and runtime gates pass.
- [x] B. The together-install oracle passes for all four candidate tarballs at the required runtimes.
- [x] C. `pnpm release:policy-check:test`, `pnpm release:matrix:test`, test-accounting verification, and
      `git diff --check` pass; no registry fallback is observed.
- [x] D. `openspec validate modernize-publishable-typescript-artifacts --strict`.
- [x] E. `openspec validate --all --strict`.
