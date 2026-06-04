# Design — Local collector deployment-posture surface

## Goal

Make published-vs-dev runtime posture mechanically visible on
`pdpp-local-collector status`/`doctor`, replacing the documented manual
`command -v` + `readlink -f` + version cross-check ritual in
`docs/local-collector.md`.

## Detection signals

The CLI already walks up from its own `import.meta.url` to find the nearest
`@pdpp/local-collector` `package.json` (`resolveLocalCollectorPackageVersion`).
Posture detection reuses that walk against the module's **realpath** (symlinks
resolved, because a dev override is usually an `npm link` / `file:` install that
symlinks the global bin back into the repo `dist/`), and classifies the package
root it lands in:

1. **`published_package`** — the resolved package root sits inside a
   `node_modules/@pdpp/local-collector` path. That is the canonical published
   install location.
2. **`repo_dist_override`** — the package root is NOT inside `node_modules` and
   contains sibling entries the published tarball never ships. The published
   `files` allowlist is `["dist/", "README.md"]`; a repo checkout's package root
   additionally has `src/`, `bin/`, `test/`, `scripts/`, and
   `tsconfig.build.json`. Presence of any of those repo-only siblings is the
   discriminator. This is layout-based and does not depend on home-path strings.
3. **`unknown`** — neither pattern is conclusive (no manifest found, or a
   package root that is neither under `node_modules` nor carries repo-only
   siblings). Conservative default; never guesses `published_package`.

A secondary signal — whether the running module file is `.ts` (source, always
dev) vs `.js` (built) — is folded in: a `.ts` entrypoint is reported as a
repo/source override even if the layout heuristic is inconclusive, because the
published package ships only compiled `.js`.

The `0.0.0` placeholder version is reported as a boolean
(`is_placeholder_version`). It is independent of `kind`: a real published beta
can be pinned (good), while `0.0.0` means either an unpinned `latest` install of
the placeholder or an in-repo manifest — both disqualify operator-host evidence.

## Redaction

Per `local-collector-durable-work`'s existing "diagnostics displayed remotely"
requirement, the block MUST NOT emit unredacted absolute local paths. The
existing `db.path` field already prints a full path, but that is an
operator-supplied queue path the operator chose; the *module install location*
is environment-derived and may expose a home directory, so the posture block
emits a **classified, redacted** location instead:

- `kind` (the classification above);
- `module_basename` — the bin filename only (`pdpp-local-collector.js` /
  `.ts`);
- `location_hint` — a short tail descriptor that conveys the meaningful segment
  without the home prefix: for a published install,
  `node_modules/@pdpp/local-collector`; for a repo override,
  `packages/local-collector` (the repo-relative package dir name), never the
  absolute path above it.

No env files, tokens, queue payloads, or full home paths are emitted.

## Why warning, not error, for repo_dist_override

A dev override is the supported monorepo development path. `doctor` already uses
`warning` for self-healing/informational conditions and reserves `critical` for
dead-letter rows that need operator recovery. `repo_dist_override` and the
`0.0.0` placeholder are "this output is dev evidence, not operator-host
evidence" — a warning that disqualifies host attribution, not a failure. They
escalate `doctor.status` to at most `warning`, never `critical`.

## Alternatives considered

- **Shelling out to `command -v` / `readlink -f`**: brittle (depends on PATH and
  the binary being on it), and the running process already knows its own
  resolved path via `import.meta.url`. Rejected.
- **Emitting the full realpath and letting the reader classify**: violates the
  no-unredacted-absolute-path requirement and re-creates the manual ritual.
  Rejected in favor of emitting the classification itself.
- **Folding into `add-local-collector-lifecycle-state-surface`**: that change is
  fully implemented and only awaits archive; posture is a distinct capability
  addition. Kept separate per AGENTS.md.

## Acceptance checks

- `cd packages/local-collector && node --test --import tsx 'test/*.test.js'` — green.
- `npx tsc -p packages/local-collector/tsconfig.build.json --noEmit` — clean.
- `cd packages/local-collector && pnpm build && node scripts/validate-package.mjs` — green.
- A published-like layout (manifest under `node_modules/@pdpp/local-collector`,
  built `.js` bin) classifies `published_package`; a repo-dist-like layout
  (package root with `src/`+`bin/`) classifies `repo_dist_override`; neither
  emits an absolute home path.
- `openspec validate add-local-collector-deployment-posture-surface --strict`.
