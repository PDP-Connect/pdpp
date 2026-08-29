# Vendored cross-repo dependency tarballs (transitional)

`pdpp-connector-protocol-0.0.1.tgz` was RE-PACKED on 2026-08-29 from
PDP-Connect/data-connect commit `65fa39cf3bb27abc598f8a15ab20353660b77479`
("fix(protocol): let a session-first connector skip the credentials prompt") on
branch `rail/pr36-0828`, packed with `npm pack` from inside that repo's
workspace so sibling dependencies resolve during the prepack build. Artifact
SHA-256 `65c1c3a7fd994a8d0b83231a226a0b3c69556377afdeb579c844439274660cc5`
(see SHA256SUMS); the matching sha512 integrity is pinned in `pnpm-lock.yaml`.
The tarball is a straight pack of that commit with a clean worktree — no
post-pack edits to its contents.

It carries one behavior change, in the `env` auth strategy.
`AuthStrategyContext` gains an optional `authOptional`; when it is set and a
declared credential is missing, the strategy returns the resolved subset
immediately instead of raising a `credentials` INTERACTION. This unblocks
session-first browser connectors (ChatGPT): the browser profile is the real
authenticator, so a scheduled run no longer dies waiting on a prompt nobody
can answer, and a repair run no longer shows a username/password form to an
owner who signs in through SSO. The same change drops the prompt's
".env.local for persistence" instruction, which promised a persistence the
system does not provide. Additive and default-absent, so every connector that
genuinely requires its secret still prompts and still fails closed.

Its parent, commit `7faa043c27f9743e57b3c117e37470ca12cb3c04`
("fix(protocol): export skip boundary claims") on branch
`fix/protocol-stream-evidence-boundary-claim-0828`, is the prior pin point and
remains fully contained in this artifact.
It adds two fields the reference implementation already CONSUMED but no
connector could emit: `SKIP_RESULT.boundary_claim` (GroupMe emits it, the RI's
`PERSISTED_BOUNDARY_CLAIMS` already allows its only value, but it was dropped in
transit) and the `STREAM_EVIDENCE` message (the RI validates and accepts it;
its own re-review recorded "no connector in this repo can emit STREAM_EVIDENCE
and typecheck" as a hard blocker). Both are additive: `boundary_claim` is
optional and STREAM_EVIDENCE is a new union member, so nothing that compiled
before stops compiling.

The final source commits add compile-time contract tests and export
`SkipResultBoundaryClaim` through the public package barrel. The
`connector-runtime-protocol.ts` SHA-256 remains
`c27e038e18b2ecf1d08850b4079232819277f927a8eaa244c1a5766fad74430c`,
while the barrel change is included in this artifact built from the final PR
head.

The prior artifact was built via `npm pack` from PDP-Connect/data-connect @
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
commits") on branch `fix/terminal-commit-recovery-0827-clean`, merged into
data-connect `main` as `0bc3f8c5b4ffdc1cbbfb43f1a251915456859886` by
PDP-Connect/data-connect PR #34 (https://github.com/PDP-Connect/data-connect/pull/34,
exact reviewed head `200b26098`). It carries the port of
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
