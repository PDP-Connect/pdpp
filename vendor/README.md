# Vendored cross-repo dependency tarballs (transitional)

## Current 1.0.0 release-boundary pins

Both consumers now pin data-connect PR #36's exact reviewer-confirmed head,
`10f25a3cd6ab1e11aabab08a88dbf8fa301a919b` ("chore: add missing Apache-2.0
SPDX headers to package-artifact scripts"). Prior pins had a per-package
provenance because `pdpp-collector-runtime-0.0.2.tgz` and
`pdpp-connector-protocol-0.0.2.tgz` were packed from two different commits
(`6676f900e` and `75b4af02b` respectively) that coincidentally shared the
`0.0.2` package-version string. That is no longer the case: both packages are
lockstep-versioned by data-connect's own semantic-release pipeline
(`.releaserc.yaml`, one release computes one `nextRelease.version` and applies
it to both `packages/connector-protocol` and `packages/collector-runtime` via
two `@semantic-release/npm` `pkgRoot` entries), so both artifacts below are
packed from the same source commit at the same package version, `1.0.0`.

`packages/collector-runtime/package.json` commits `@pdpp/connector-protocol`
pinned to `0.0.1` in-repo — a floor for local installs, not what gets
published. The actual publish-time pin comes from a `prepareCmd` step,
`scripts/pin-collector-runtime-protocol-dependency.ts`, wired in
`.releaserc.yaml` before both `@semantic-release/npm` prepare entries: it
rewrites the dependency to the release's computed `nextRelease.version` in the
ephemeral checkout only (see data-connect PR #36 comment 5479509596, commit
`fe91a83`, for the root-cause writeup and Verdaccio-registry proof this fix
was correct). Left unrepinned, a published `collector-runtime` install would
resolve `connector-protocol` from whatever version was last committed, not the
version actually released alongside it — broken whenever connector-protocol's
release adds exports collector-runtime imports, which PR #36 does.

Both tarballs below were produced from a clean clone of data-connect at
`10f25a3cd6ab1e11aabab08a88dbf8fa301a919b`, applying only the two mutations
the real `.releaserc.yaml` `prepare` lifecycle applies before packing — no
registry, no `publishConfig` edits, no other source changes:

1. `node --import tsx scripts/pin-collector-runtime-protocol-dependency.ts 1.0.0`
   (the `prepareCmd` step, run first, matching plugin-array order) — rewrites
   `packages/collector-runtime/package.json`'s `connector-protocol` dependency
   to `1.0.0`.
2. `npm version 1.0.0 --no-git-tag-version --allow-same-version` in each
   `pkgRoot` (exactly what `@semantic-release/npm`'s prepare step runs; see
   its `lib/prepare.js`) — writes the package version.

Then `npm pack <pkgRoot>` in each package's own workspace (so the sibling
workspace dependency resolves during the `prepack`/build step), with each
package's `publishConfig` — `registry: "https://registry.npmjs.org/"`,
`provenance: true` — untouched. An earlier version of this pin briefly routed
through a local scratch npm registry (Verdaccio) to reproduce the release
pipeline's registry-auth steps as well; that run patched `publishConfig` to
point at the scratch registry so `npm publish` would succeed, and that edit
leaked into the packed tarball's `package.json`. Superseded here: the pin
script + `npm version` + plain `npm pack` reproduces the exact `prepare`-phase
output the real pipeline produces without needing a registry round-trip at
all, so there is nothing scratch-specific to leak. Verified directly by
extracting each packed tarball's `package/package.json`:

```
@pdpp/collector-runtime@1.0.0
  dependencies: {"@pdpp/connector-protocol": "1.0.0"}
  publishConfig.registry: "https://registry.npmjs.org/"
  publishConfig.provenance: true
@pdpp/connector-protocol@1.0.0
  publishConfig.registry: "https://registry.npmjs.org/"
  publishConfig.provenance: true
```

For the root-cause writeup and the release-pipeline proof that this repin
mechanism itself is correct (registry round-trip included), see data-connect
PR #36 comment 5479509596, commit `fe91a83`, and commit `90a8f0c`
(`nextRelease.version = 1.0.0`, matching what this pin's own `npm version`
step computed).

`pdpp-collector-runtime-1.0.0.tgz` SHA-256 is
`2d75fc9fae056ba5302ff53d9933daf4fc386221935bd0ed32ca0826d8865301`; SHA-512
integrity is pinned in `pnpm-lock.yaml`
(`sha512-hURTh2GAUj0GVLgEEglcpQhOgdSdYoLU4JAik8BNywZDQhiW9yxxh1UIm9Yi1JAw1DetwN9qPYRD185PBDWDHg==`).

`pdpp-connector-protocol-1.0.0.tgz` SHA-256 is
`4a1e9c1fe2cf4b25148d1a8b576f9e894c54005d46ef9f9733ddc843b5422020`; SHA-512
integrity is pinned in `pnpm-lock.yaml`
(`sha512-5ZPoVEgKt1cyuYe9tLiivhsQFntlzGf/t6lKCre2ylmRrkhaCrBDrckA+cwR6KPBT66DNS3txscB6Jw4y+NlWw==`).

Both package archives are verified by
`scripts/check-pdpp-vendored-package-pins.ts` before the PDPP train can be
treated as installed.

`CONNECTOR_PROTOCOL_VERSION` (the wire-contract constant, unrelated to the
npm package-release version above) remains `"0.0.2"` in this pin — unchanged
from the prior pin. See `packages/connector-protocol/src/connector-runtime-protocol.ts`
in data-connect: the wire-contract number bumps only when message shapes
change, and PR #36's commits after the `0.0.2` wire pin (STREAM_EVIDENCE
outcomes partition, capability gating, the connector-protocol version-pin fix
itself) are release-process and dependency-resolution fixes, not wire-shape
changes.

It carries one breaking protocol change, in `STREAM_EVIDENCE`
(`84dd39a63955fdd6ecc37520541269602d8c3406`). The scalar `covered` member is
gone, replaced by a disjoint partition
`outcomes: { emitted, unchanged, gapped, unaccounted }` whose four fields MUST
sum to `considered` exactly. A single `covered` count could not distinguish
emitted from unchanged from gapped from unaccounted keys, so it silently hid
gaps a caller needed to see. The sum-check is enforced at the untyped wire
boundary by the newly exported `validateStreamEvidenceCounts` (bounded to
`Number.MAX_SAFE_INTEGER`, called right after `JSON.parse`, because the type
system cannot check an unknown value); collector-runner fails closed when a
connector emits `STREAM_EVIDENCE` with invalid counts. A reader that wants a
`covered` projection derives it as `outcomes.emitted + outcomes.unchanged`.
The `covered` members that remain in `dist/connector-runtime-protocol.d.ts`
belong to `DetailCoverageMessage` and `RuntimeContinuationFact` — different
messages that are not affected by this change.

It carries a second breaking change: `LocalCollectorDefinition` now REQUIRES
`protocol_capabilities: readonly ConnectorProtocolCapability[]`. Upstream
deliberately treats an omitted field as `"undeclared_capabilities"` rather than
defaulting it to `[]` — an object missing the field is the exact shape a forged
legacy-bypass caller produces, and the old `protocol_contract_version: "0.0.1"`
escape hatch was removed because nothing separated a genuine legacy artifact
from a caller merely claiming to be one.

Every bundled collector definition in this repo therefore declares the field
explicitly. All seven declare `[]`: no connector here emits `STREAM_EVIDENCE`,
so none needs a capability today. Six of the seven mirror data-connect's own
definitions at the pin commit above and were reconciled to match them exactly;
`signal` has no canonical counterpart and was derived the same way, from its
own emissions (`START`/`RECORD`/`SKIP_RESULT`/`DONE`). The declarations are
pinned against drift by
`packages/polyfill-connectors/src/collector-definition-protocol-capabilities.test.ts`
(each definition declares exactly what its source emits) and
`packages/polyfill-connectors/bin/collector-runner-protocol-capabilities.test.ts`
(a custom operator-supplied command gets no synthesized declaration).

The prior `pdpp-collector-runtime-0.0.1.tgz` pin had no capability field in its
`ConnectorPlacementInput`, so that historical state enforced the requirement
at compile time only. The current `0.0.2` runtime pin carries the withdrawn
capability placement gate described above.

The same fold classifies `stream_evidence_run_registry` as `backup_required` in
`reference-implementation/server/backup-table-policy.ts`. That table is
introduced by this train (accepted P1-2) relative to the base it merges onto,
and it holds the accepted `(run_id, stream)` claims enforcing
spec-collection-profile.md rule 5. Rule 5 defines "same run" strictly by
caller-chosen `run_id` with no restart or restore exception and the rows are
never deleted, so a claim lost at the durability boundary would let a reused
`run_id` re-accept and admit duplicate authority. It is retained for the same
reason `source_webhook_run_receipts` is.
`reference-implementation/test/stream-evidence-run-registry-durability.test.ts`
proves the rows — not merely the table — carry the rejection across a
backup/restore boundary, and that the surviving uniqueness scope is exactly
`(run_id, stream)`.

Earlier commits in the same source stack pin the package at `0.0.2`, bind
legacy-artifact identity, close an undeclared-capability bypass, validate
capability array members via `isConnectorProtocolCapabilityArray`, and bind the
attestation signer workflow. The head commit only regenerates `artifact.json`
against the committed tree; it changes no `dist/` output.

The prior artifact, `pdpp-connector-protocol-0.0.1.tgz` (SHA-256
`65c1c3a7fd994a8d0b83231a226a0b3c69556377afdeb579c844439274660cc5`), was
RE-PACKED on 2026-08-29 from commit
`65fa39cf3bb27abc598f8a15ab20353660b77479` ("fix(protocol): let a session-first
connector skip the credentials prompt") on branch `rail/pr36-0828`. Its
contents remain contained in this artifact except for the `STREAM_EVIDENCE`
change above. It carried one behavior change, in the `env` auth strategy.
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

The final source commits of that 0.0.1 lineage add compile-time contract tests
and export `SkipResultBoundaryClaim` through the public package barrel. Its
`connector-runtime-protocol.ts` SHA-256 was
`c27e038e18b2ecf1d08850b4079232819277f927a8eaa244c1a5766fad74430c`; at the
0.0.2 pin point above that source file is
`d8886bc91e761400688c1b49409c9a2dafcb7d6098f4a3657ecd52e4e9a4421f`, because the
`STREAM_EVIDENCE` outcomes partition rewrote it.

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

`pdpp-collector-runtime-0.0.1.tgz` was resynced again on 2026-09-02 via `npm pack` from
data-connect main's tip, `63a3792762e6568315c8d210852ea8f5c4f3b3d2` ("chore(deps): bump the
cargo group in /src-tauri with 5 updates", #39). data-connectors' own pin-freshness — data-connect
check had gone red: main had moved past the prior `0bc3f8c5b4` pin in
`packages/collector-runtime` and `packages/connector-protocol` themselves, via data-connect PR
#36 ("Add local collection and release checks", merged as `b70dda89aef1c3e3cee97cf21005dfdef9f1a38f`,
the same PR that data-connect-1-0-0's pin already tracks). Packed the same way as the prior
resync (workspace build from inside `packages/collector-runtime`, sibling `connector-protocol`
resolved from the same checkout). Verified locally: fresh repack's content differs from the
prior committed tarball in every `dist/*.{js,d.ts}` file, `package.json`, and `README.md` — a
genuine re-vendor, not a no-op SHA move.

`pdpp-collector-runtime-0.0.1.tgz` was resynced a third time on 2026-09-02 (same day) via
`npm pack` from data-connect main's tip, `82a45176ebe654eee595f06d5fa97de0648e86ba` (merge of
data-connect#41, "fix(polyfill-connectors): sync claude_code/codex/google_messages from
canonical"). The prior `63a3792` pin was itself already one commit behind an unrelated
dependabot npm bump (data-connect #37) that data-connect#41 was based on top of, touching
`packages/collector-runtime/package.json`'s devDependencies — confirmed the fresh repack's
`package.json` bytes differ from the prior committed tarball (only `package.json`, no `dist/`
change this time, since #37 is a devDependency-only bump). Data-connectors' own equivalent
tarball (`packages/polyfill-connectors/vendor/pdpp-collector-runtime-0.0.1.tgz`) was re-vendored
identically in the same cutover, and both share the same digest — packed from the same
data-connect commit.
