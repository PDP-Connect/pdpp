# Tasks — Local collector deployment-posture surface

## 1. Posture detection

- [x] 1.1 Add `classifyLocalCollectorDeploymentPosture` (exported, pure on an
  injectable start URL) in `bin/pdpp-local-collector.ts`: resolve the running
  module realpath, walk to the nearest `@pdpp/local-collector` package root,
  classify `published_package` / `repo_dist_override` / `unknown`.
- [x] 1.2 Derive `is_placeholder_version` from the resolved version (`0.0.0`).
- [x] 1.3 Emit a redacted `location_hint` + `module_basename`; never an absolute
  home path.

## 2. CLI surface

- [x] 2.1 Add a `deployment_posture` block to the `status` JSON.
- [x] 2.2 Add a `deployment_posture` doctor check (`ok` | `warn`) and a static
  remediation hint; escalate `doctor.status` to at most `warning`.
- [x] 2.3 Keep all existing `status`/`doctor` fields (additive only).

## 3. Docs

- [x] 3.1 Update `docs/local-collector.md` to point the manual `readlink` recipe
  at the mechanical `deployment_posture` block as the primary check.

## 4. Tests

- [x] 4.1 Published-like layout (manifest under
  `node_modules/@pdpp/local-collector`, `.js` bin) → `published_package`.
- [x] 4.2 Repo-dist-like layout (package root with `src/`+`bin/`) →
  `repo_dist_override`.
- [x] 4.3 `.ts` entrypoint → repo/source override even when layout is
  inconclusive.
- [x] 4.4 No absolute home path leaks through `status`/`doctor` posture fields.
- [x] 4.5 `doctor` escalates to `warning` (not `critical`) for a repo override /
  `0.0.0` placeholder; a clean published doctor stays `ok` for this check.

## Acceptance checks

- `cd packages/local-collector && node --test --import tsx 'test/*.test.js'` — green.
- `npx tsc -p packages/local-collector/tsconfig.build.json --noEmit` — clean.
- `cd packages/local-collector && pnpm build && node scripts/validate-package.mjs` — green.
- `openspec validate add-local-collector-deployment-posture-surface --strict`.
