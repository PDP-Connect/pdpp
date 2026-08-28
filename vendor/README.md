# Vendored cross-repo dependency tarballs (transitional)

`pdpp-connector-protocol-0.0.1.tgz` built via `npm pack` from PDP-Connect/data-connect @
3c8aeb0343dcbcbccb0bba3357f6b6bf543012b1 (branch `fix/skip-result-boundary-claim-0828`,
pushed, not merged: "fix(connector-protocol): add SkipResultBoundaryClaim to source"), from
inside that repo's workspace so sibling dependencies resolve during the prepack build.
`SKIP_RESULT.boundary_claim` (closed-vocabulary type
`SkipResultBoundaryClaim = "provider_history_boundary"`, exported from both
`connector-runtime-protocol.ts` and the package barrel) was added to the `EmittedMessage`
SKIP_RESULT variant so GroupMe's already-shipped `boundary_claim: "provider_history_boundary"`
emission (packages/polyfill-connectors/connectors/groupme/index.ts) type-checks against the
vendored package instead of only against `reference-implementation/server/ref-control.ts`'s
own `RuntimeSkipBoundaryClaim`. Source-of-truth for the literal vocabulary is
`RuntimeSkipBoundaryClaim` in ref-control.ts; the vendored protocol type mirrors it rather
than widening to `string`, so an unrecognized literal fails to compile instead of silently
type-checking and being dropped only at runtime. The edit is committed source in the repo
above (no local, not-yet-upstreamed delta) — this tarball is a straight `npm pack` of that
commit's workspace, with no worktree edits applied afterward. The `dist/*.d.ts` diff versus
the previous vendored tarball is exactly this addition (`.js` output is unchanged — this is a
type-only addition); the rest of the byte diff is `package.json`/`README.md` picking up
`origin/main`'s newer npm-publish-workflow metadata (`repository`, `publishConfig`, package
`README.md`) added by PR #32 after the old pin point. Re-vendor again once
`fix/skip-result-boundary-claim-0828` merges to `origin/main`, at which point this same
content will be reachable from main directly.

`pdpp-collector-runtime-0.0.1.tgz` was resynced on 2026-08-27 via `npm pack` from commit
`200b26098cb353d7d2fbdc52cc451712a92f6c85` ("fix(local-collector): rebuild rejected terminal
commits") in a local checkout at `~/.tmp/data-connect-terminal-recovery-clean-0827`, one
commit ahead of `data-connect`'s `origin/main` tip (`9766c77e2eab8909974ba7777fe4bafe0eac29e6`)
on branch `fix/terminal-commit-recovery-0827-clean`, publicly reviewable at
PDP-Connect/data-connect PR #34 (https://github.com/PDP-Connect/data-connect/pull/34,
exact head `200b26098`) but not yet merged. It carries the port of
PDPP's `fef2464` (repair-terminal-commit-recovery) onto collector-runtime/local-collector:
retaining rejected `terminal_run_commit` evidence until a newly completed pass produces an
accepted replacement, recording an append-only supersession link (schema v4) instead of
retrying invalid bytes. Packed from inside that repo's workspace (`packages/collector-runtime`,
with `packages/connector-protocol` built as its workspace sibling) so the workspace-link
dependency resolves during the `prepack` build, matching the mechanism this file already
documents below. Independently reviewed prior to this vendor resync (see the source repo's
own review of `200b26098`); this resync only repacks the already-reviewed commit into PDPP's
vendored artifact and does not re-review its content.

Same mechanism, same rationale, and same removal trigger as data-connectors PR #36's vendor/
directory: pnpm/npm git+path dependencies prepare the subpackage in isolation where its
workspace sibling does not exist, so packed tarballs are the only mechanism that installs
deterministically today. Deleted when the packages publish from data-connect. Digests:
SHA256SUMS.
