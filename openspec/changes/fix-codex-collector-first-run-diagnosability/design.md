## Context

Full evidence trail (remote read-only investigation, direct reproduction,
code reading of both the deployed `0.0.0` package and the current repo
source) lives in a non-committed operator evidence report from this
session's post-deploy acceptance work. Summary of the two proven root
causes is in `proposal.md`. This design covers only the fix decisions.

## Decision: prefer the connector's own terminal DONE error over the generic exit/stderr fallback, don't replace it

`throwIfConnectorExitedUncleanly` (`collector-runner.ts`) is called with an
`exitCode` and a bounded `stderr` buffer, but at the point it runs the
runner has *also* already parsed the child's full protocol stream and knows
whether a terminal `DONE` was observed (`terminalDone`, computed
immediately afterward in the pre-fix code). Two options:

1. Move the whole "was there a terminal DONE" check before the exit-code
   check and let it subsume both cases.
2. Keep both checks in their existing order and positions, but pass
   `terminalDone` into `throwIfConnectorExitedUncleanly` so its own error
   message can prefer the connector's structured reason when present.

Chose (2). Reordering (1) would change more than the diagnosability gap —
the two checks currently encode different invariants (`exitCode !== 0` is
about process-level failure; the `terminalDone` check afterward is about
protocol-level completeness, and deliberately still fires even on a *clean*
exit with no or unsuccessful DONE, per the pre-existing comment "a zero
exit only proves the process stopped cleanly"). Threading `terminalDone`
into the existing exit-code branch is the minimal, behavior-preserving
change: the exit-code branch still fires under the exact same condition as
before (`exitCode !== 0 && !scanBudgetExceeded`), it just now has better
information available for its own error message. The subsequent
`terminalDone` check and its own error path are untouched.

The stderr-derived message is retained as the fallback, unchanged, for a
child that exits non-zero with **no** terminal DONE at all (e.g. an
unhandled exception, a crash before the protocol even starts) — this is
exactly the shape of the pre-existing
`"runCollectorConnector records a connector_child_failure gap when the
child exits non-zero after partial flush"` test (a raw `process.exit(31)`
with a stderr write, no DONE), which was reverified green, unmodified,
after this change.

## Decision: `terminalDone.error.message` is preferred only when `status === "failed"`

A connector could theoretically emit `DONE {status:"succeeded"}` and still
exit non-zero (a bug in the connector itself, or a supervisor-level kill
after a logically-complete run). In that case there is no `error.message`
to prefer — `terminalDone.error` is only ever populated by a `failed`
DONE, and the existing type (`connector-runtime-protocol.ts`) makes `error`
optional exactly because a `succeeded` DONE has no error. The new logic
requires both `terminalDone?.status === "failed"` and a truthy
`terminalDone.error?.message` before preferring it; any other shape
(succeeded + non-zero exit, or a failed DONE with no message somehow)
falls through unchanged to the generic exit-code/stderr detail — never a
crash, never a wrong claim about a message that wasn't sent.

## Decision: remove the fatal check for `rules`/`prompts`/`skills`, keep `sessions` strict

Traced every consumer of `assertRequestedCodexSources`'s three now-removed
checks:

- `emitRulesStream`/`emitPromptsStream` (via the shared `listIfExists`
  helper, which already returns `null` and no-ops on a missing directory)
  and `emitSkillsStream` (its own try/catch around `readdir`, returning
  early on any error) all already handle a missing directory gracefully —
  zero records emitted, no exception.
- `coverage_diagnostics`'s per-store classification already reports each
  of `rules`, `prompts`, `skills` as `"status": "missing"` (not an error)
  when the corresponding directory is absent — proven present in the SAME
  run that then hit the fatal assert, confirmed both by direct
  reproduction against the live host and by the pre-existing
  `"codex emits coverage diagnostics for a missing source home before
  failing"` test (kept, still green, still proves diagnostics land before
  any failure).
- `sessions` is different in kind, not degree: there is no graceful-empty
  collection path for it (a Codex install with genuinely zero session
  history has nothing to report at all, and the store is core to the
  connector's entire value), so the existing `needsRollouts`/`hasRollouts
  || hasThreadsDb` check is unchanged and remains fatal when both the
  sessions directory and the state DB are absent.

The fix is a narrow deletion (three `missing.push(...)` branches removed,
`isReadableDirectory` retained — still used by the `sessions`/rollout
checks), not a rewrite of the assert's shape or a change to what "missing"
means for coverage diagnostics.

## Rejected alternative: make the assert configurable per-stream

Considered adding an explicit `hardRequired: Set<string>` allowlist to
`assertRequestedCodexSources` instead of deleting the three branches
outright, so a future stream could opt back into fatal-on-missing without
another code edit. Rejected: today there is exactly one hard-required
source (`sessions`, plus its own two-shape `hasRollouts || hasThreadsDb`
check, which is not expressible as a flat allowlist entry anyway) and
zero evidence any other current or near-term stream needs the same
strictness. A configurable mechanism for a single caller is unwarranted
abstraction — if a second hard-required store is added later, that is the
trigger to generalize, not now.

## Residual risk

- This change does not touch the remote host's stale `0.0.0` install — the
  fix must still be published and re-pinned there (or wherever else the
  same symptom would recur) before the specific incident host recovers.
  Documented as a Non-Goal and as the report's "Next action" list; no
  publish/deploy performed as part of this change.
- The `throwIfConnectorExitedUncleanly` fix improves diagnosability for
  every connector, not just Codex — verified by rerunning every other
  connector's existing collector-runner test (the change is generic, gated
  only on `status === "failed"` + a present `error.message`, no
  connector-specific branching), but no other connector's own precondition
  asserts were audited for the same "fatal-when-gracefully-recoverable"
  pattern found in Codex. That audit is explicitly out of scope (see
  proposal.md Non-Goals) and would be a separate change if warranted.
