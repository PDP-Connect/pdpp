# Decision memo: mutation-falsification evidence pilot (V1)

Written per design.md Decision #8 and tasks.md section 3. Recommendation: **NARROW**.

## What ran

**Migration-oracle adapter (tasks.md section 1).** Fully implemented and exercised. The legacy and structured modes were run twice each on a clean revision; both modes reported byte-identical human output and identical named cases, catching checks, positive-control result, and rollback result across both runs. Runtime was ~1.3-1.7s per run either mode; structured output adds ~2.6KB. All 115 unit and differential tests for the mutation-falsification scripts pass (`node --experimental-strip-types --test scripts/mutation-falsification/*.test.ts`). `pnpm exec openspec validate add-mutation-falsification-evidence --strict` passes.

No independent reviewer was available in this single-operator session to review this adapter's evidence before the domain pilot began, as tasks.md 1.6 calls for. Recorded honestly as a limitation, not fabricated.

**GroupMe domain pilot (tasks.md section 2).** The registry, isolation, evidence-store, projection, and fault-injection layers are fully implemented and unit-tested (`groupme-operators.ts`, `workspace.ts`, `evidence-store.ts`, `projection.ts`, `groupme-runner.ts`). Both operators (`groupme-page-ceiling-v1`, `groupme-nonprogress-weakening-v1`) were previously verified by hand against a disposable clone to kill their one targeted pre-existing test in `incremental-frontier.test.ts`, with the other 22 tests in that file unaffected.

**Task 2.6 — the real end-to-end batch run — did not complete.** A driver (`scripts/mutation-falsification/run-groupme-pilot.ts`) was built and run twice against this branch's checkout. Both runs correctly aborted at the mandatory clean complete `polyfill-connectors` backstop, before any operator's mutant was interpreted, because `runAuthority` fails with:

```
polyfill-connectors/default skips do not exactly match the profile baseline
```

## Root cause (verified, not inferred)

The real (not simulated) skip counts differ from `test-accounting.manifest.json`'s pinned baseline for `polyfill-connectors/default` by exactly one extra reason, appearing twice:

```
"network isolation unavailable on this host: unshare -r -n true exited 1: unshare: write failed
/proc/self/uid_map: Operation not permitted — unprivileged user namespaces are unavailable on
this host (kernel sysctl or an LSM policy such as AppArmor's unprivileged-userns restriction is
the usual cause)": 2
```

This comes from `packages/polyfill-connectors/src/scenario/isolation.ts`'s network-isolation preflight, which test-spawns `unshare -r -n true` and skips two tests when it fails. On this development host, `sysctl kernel.apparmor_restrict_unprivileged_userns` reads `1` — Ubuntu 24+'s default AppArmor restriction on unprivileged user namespaces — so the probe fails and the two dependent tests skip, a reason the pinned baseline does not account for.

This is a **pre-existing host/repo condition, not a mutation-falsification defect.** It was reproduced identically by running `runAuthority({ suites: ["polyfill-connectors"] })` directly against the plain, uncloned, non-isolated host checkout — zero mutation-harness code involved. Every other skip reason and count in the pinned baseline (`GROUPME_ACCESS_TOKEN unset: 2`, the Amazon/Chase/USAA local-fixture skips, the module-mocks and `--expose-gc` skips) matched exactly; only the network-isolation reason was extra.

A same-host devcontainer build (`--privileged` in its `runArgs`, which permits the underlying syscall) was attempted as a workaround. After a symlink/relative-`build.context` resolution bug in the shared devcontainer config was worked around locally, the build itself hung for over 9 minutes with no progress on this already heavily-loaded shared machine (dozens of other concurrent agent sessions and containers), and was abandoned within the owner's explicit 30-minute time-box. The owner explicitly ruled out requesting a host-wide AppArmor relaxation (`sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`) as out of scope for this task.

Consequently **no GroupMe operator attempt ran for real in this session.** Tasks 2.6 and 2.7 are marked not completed, honestly, in tasks.md.

## A second, independent stop signal: dominant setup/runtime cost

Even setting the skip-mismatch aside, the clean complete `polyfill-connectors` backstop alone measured **~590-630 seconds** (two measurements: 589s running directly against the host checkout, 624s running against a real isolated clone) against a 10-minute (600s) locked batch budget — before any operator's focused check or mutant backstop even begins. This suite currently has 370 test files and 5,227 assertions.

Design.md Decision #8 names exactly this as a stop-or-narrow signal: *"Stop generalization if setup consumes most runtime."* On this host, the backstop alone would consume nearly the entire batch window even if the skip-mismatch were fixed, leaving little to no margin for two operators' clone + install + focused-check + (conditionally) mutant-backstop cycles within the declared 10-minute window. Both registered operators are already known (from prior manual verification) to kill on the cheap focused check, so in the expected case the complete backstop runs only once per batch — but the margin is thin, and a single focused-survivor would very likely blow the budget on this host.

## Recommendation: NARROW

**Land as-is:**
- The migration-oracle adapter's structured evidence (tasks.md section 1) — fully implemented, tested, and calibrated on two clean runs.
- The GroupMe pilot's registry, isolation, evidence-store, and projection machinery (tasks.md 2.1-2.5) — fully implemented and unit-tested, including real preimage/forbidden-path verification against a disposable clone.
- The real pilot-batch driver (`run-groupme-pilot.ts`) — it correctly and honestly aborted rather than fabricating success, which is exactly the fail-closed behavior design.md requires.

**Do not yet claim:** that the GroupMe domain pilot's own operator-level killed/survived evidence (tasks.md 2.6/2.7) is complete. It is not — no operator attempt ran.

**Before those tasks can close:** re-run `run-groupme-pilot.ts` on a host where `unshare -r -n true` succeeds — GitHub Actions CI runners typically permit unprivileged user namespaces, as would a devcontainer build that completes cleanly, or another developer machine without this AppArmor restriction. Until then this PR should not be described as having produced real GroupMe kill/survive evidence, only as having built and unit-proven the machinery to produce it.

**Do not generalize:** no coordinator, generic executor, StrykerJS experiment, CI lane, or sandbox should be built from this pilot's evidence — that decision was never reached, since the domain pilot itself did not complete. This remains true independent of the outcome once the pilot is successfully re-run: design.md requires a separate, independently reviewed OpenSpec proposal before any of that infrastructure is built.

## Adapter comparison (tasks.md 3.3)

Both adapters share: the intent/attempt/triage schema split, RFC 8785 canonicalization and SHA-256 digesting, the issued/completed marker lifecycle with fsync discipline, and the conservative total projection table. They differ in almost everything else — the migration oracle is self-contained (its own fixture repos, judges, and rollback proof, no isolated clone, no complete-suite backstop), while the GroupMe pilot needs a full isolated clone, offline dependency materialization, and the real `runAuthority` backstop. This divergence is exactly what design.md Decision #2 predicted ("duplication is preferable to a shallow common executor with adapter-specific escape hatches") and this pilot does not surface any additional shared invariant beyond the evidence/projection layer already factored into `schemas.ts`, `canonicalize.ts`, `evidence-store.ts`, and `projection.ts` — all adapter-agnostic today. No further generalization is justified by this evidence.
