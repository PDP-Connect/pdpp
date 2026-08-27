# Vendored cross-repo dependency tarballs (transitional)

`pdpp-connector-protocol-0.0.1.tgz` built via `npm pack` from PDP-Connect/data-connect @
9155e57ae47ab145214eb10551ed2c2185d7098a (merges pdpp preservation-fixes-0819 port PR #30:
bare-specifier package validation, iMessage fixture date fix, connector spawn tsx-resolution
hardening), from inside that repo's workspace so sibling dependencies resolve during the
prepack build.

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
