## Why

Post-deploy acceptance of D8 (`decouple-device-enrollment-from-ingest-writer-
admission`, commit `f6864f6f9`) enrolled a fresh Codex collector on a
remote collector host — proving the enrollment fix. Its first scheduled
cron run then exited 1 after queueing 2 record batches, and the runner log
carried only `codex connector exited 1: exit 1:` plus the Node SQLite
experimental warning — no usable diagnosis.

Live, read-only investigation (full evidence trail available in a
non-committed operator evidence report covering this session's post-deploy
acceptance work) traced this to two independent, pre-existing defects,
neither related to D8 or to enrollment:

1. **The runner discards the connector's own structured failure reason.**
   `packages/polyfill-connectors/src/collector-runner.ts`'s
   `throwIfConnectorExitedUncleanly` ran BEFORE the `terminalDone` check and
   only ever inspected the child's `stderr` buffer. The Codex connector
   correctly emits a terminal `DONE {status:"failed", error:{message}}` on
   **stdout** per the documented connector protocol, then exits non-zero,
   writing nothing to stderr. The exit-code branch fired first, saw empty
   stderr, and threw `"unknown error"` — silently discarding the
   connector's own diagnosis on every run, every host, forever. Directly
   reproduced on both the deployed `0.0.0` package and the current repo
   source (byte-identical logic — not something the published `0.19.3`
   build already fixes).

2. **The Codex connector treats optional, user-authored directories as
   fatal preconditions.** `assertRequestedCodexSources` throws when
   `rules`/`prompts` (both in the always-requested
   `CODEX_DEFAULT_STREAMS`) are missing — but Codex CLI never creates those
   directories until a user actually authors a rule or prompt, and the
   connector's own coverage diagnostics already correctly classify each as
   `"missing"` (not an error) in the same run. The actual collection
   functions (`emitRulesStream`, `emitPromptsStream`, `emitSkillsStream`)
   already no-op safely on a missing directory — the pre-flight assert was
   redundant, stricter than the code it guards, and fatal. Confirmed on a
   remote collector host: its `CODEX_HOME`-relative `rules` and `prompts`
   directories genuinely do not exist. Consequence: **every fresh Codex
   install on any host fails its very first scheduled run**, until an
   operator manually creates two empty directories nothing tells them to
   create.

Both fixes, tests, and full-suite verification are already implemented and
green in the worktree (see `tasks.md` §4). This proposal is the OpenSpec
change required before landing them, per standing project convention (every
durable reference-implementation behavior change — see
`decouple-device-enrollment-from-ingest-writer-admission`,
`fix-slack-optional-stream-isolation` — ships with a matching OpenSpec
change).

## What Changes

- **`assertRequestedCodexSources`** (`packages/polyfill-connectors/
  connectors/codex/index.ts`): stop treating `rules`/`prompts`/`skills` as
  fatal preconditions when their directories are absent. `sessions` (and
  the rollout-needs check) is unaffected — it has no graceful-empty
  collection path and stays a hard requirement.
- **`throwIfConnectorExitedUncleanly`** (`packages/polyfill-connectors/src/
  collector-runner.ts`): when a connector exits non-zero AND has already
  emitted a terminal `DONE {status:"failed", error:{message}}`, that
  message becomes the authoritative failure detail — preferred over the
  generic `exit <code>: <stderr>` fallback, which is retained unchanged for
  a child that crashes with no DONE at all (e.g. an unhandled exception,
  no protocol violation).
- **Regression tests** for both, mutation-verified against the exact live
  symptom (see `tasks.md`).

## Non-Goals

- **The remote host's `0.0.0` placeholder package install** is a separate,
  pre-existing deployment-posture hygiene gap (already surfaced by the
  collector's own `doctor` diagnostic, `deployment_posture: "warn"`). This
  change fixes the code; re-pinning that specific host to a published
  release is a follow-up operator action, not part of this change, and no
  remote host, credential, or queue was touched while authoring it.
- **Publishing a new `@pdpp/local-collector` release** is out of scope —
  this change lands the source fix only.
- **Root-causing why the D8 enrollment itself needed live remediation** is
  already closed by the D8 change; not reopened here.
- **A repo-wide audit of every connector's own precondition-assert
  strictness** is out of scope — this change is scoped to the two Codex-
  specific and runner-generic defects actually proven live.

## Capabilities

- Modified: `local-agent-collector-completeness` — the Codex durable-stream-
  contract requirement now distinguishes a hard-required source (no
  graceful-empty path) from an optional, user-authored source (has one),
  and states that only the former may be treated as a fatal precondition.
- Modified: `local-collector-durable-work` — adds a requirement that a
  connector child's own terminal DONE failure message is authoritative
  evidence for the run's failure detail, not discarded in favor of a
  generic exit-code/stderr fallback when both are available.

## Impact

- `packages/polyfill-connectors/connectors/codex/index.ts`
- `packages/polyfill-connectors/connectors/codex/source-preflight.test.ts`
- `packages/polyfill-connectors/src/collector-runner.ts`
- `packages/polyfill-connectors/src/collector-runner.test.ts`
