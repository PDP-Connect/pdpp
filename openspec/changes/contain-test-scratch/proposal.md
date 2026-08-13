## Why

Canonical PDPP test and supported smoke commands can leave host temporary
state behind after ordinary failures or termination. Existing test-local
`t.after()` and `try/finally` cleanup is valuable but cannot contain the whole
command tree or recover verified debris after SIGKILL. Routing every canonical
entrypoint through a single invocation owner fixes that lifecycle defect
without rewriting hundreds of independently-owned test allocations.

## What Changes

- Add one root-owned test-scratch command boundary that creates a private run
  root, propagates standard temporary-directory variables to its descendants,
  owns one POSIX process group, and removes only the verified root.
- Make nested wrappers participants in an existing valid ownership boundary;
  they neither create a second root nor clean the owner's root.
- Add marker-backed, fail-closed cleanup and conservative stale-root recovery
  below a dedicated same-user parent.
- Route canonical root/package/CI test front doors through the boundary and
  add repository-derived entrypoint and executable-host-write ratchets.
- Migrate only the confirmed hard-coded host scratch writers. Keep reviewed
  container paths, fixtures, production contracts, and the shared dynamic
  n.eko flock as explicit exceptions.

## Capabilities

- Added: `test-scratch-lifecycle`

## Impact

- New root-level `pnpm test:scratch -- <command> [args...]` command and
  `scripts/test-scratch/` ownership implementation.
- Canonical test aliases and the remaining raw CI test commands gain
  command-scoped scratch containment; raw developer commands remain a
  documented bypass.
- Affected host-writing smoke scripts and the browser fixture use the inherited
  run root or `tmpdir()` instead of stable host `/tmp` paths. The arbiter's
  named Netflix fixture paths are absent from this worktree, so they are
  explicitly not guessed or recreated here.
- No protocol semantics, production storage lifecycle, Docker-container path,
  or shared n.eko cross-run lock contract changes.
