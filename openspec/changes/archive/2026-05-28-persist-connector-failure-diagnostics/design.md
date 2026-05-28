## Context

`tmp/connector-failure-diagnostics-memo.md` established a concrete reference-runtime forensics gap:

- `run_1777231599663` (`ynab`) and `run_1777231731305` (`slack`) both failed with `reason: "connector_exit_without_done"` and `exit_code: 1`.
- The persisted terminal payload had no connector error string, no stderr excerpt, and only `known_gaps.recovery_hint.action: "unknown"`.
- `reference-implementation/runtime/index.js` captured child stderr into memory, forwarded it as a transient `onProgress({ type: "stderr" })`, and then dropped it before building the persisted `run.failed` event.

The owner problem is not "make the error prettier." The problem is evidentiary: once a connector exits, the only durable artifact a reviewer or operator can inspect is the timeline. A generic terminal reason is honest but insufficient when the runtime already had relevant connector-authored evidence.

## Decision

Implement a narrow reference-runtime diagnostic slice:

1. Persist a **bounded, redacted stderr tail** on failed connector runs where the connector exits before `DONE` and stderr was observed.
2. Add runtime-authored fields to the terminal failure payload:
   - `failure_origin`: one of `connector`, `runtime`, `transport`, or `storage`.
   - `failure_message`: a concise runtime-authored explanation such as `Connector exited with code 1 before emitting DONE.`
   - `connector_diagnostics.stderr_tail`: a connector-authored excerpt object with byte counts, truncation metadata, redaction metadata, and the text excerpt.
3. Treat the diagnostic as **owner/control-plane evidence only**. It SHALL NOT be exposed through grant-scoped `/v1` records/search/schema reads.
4. Do not build a full log artifact/blob store in this slice. Capture the shape as a deferred follow-up because it needs separate retention and authorization decisions.

## Node Diagnostic Reports

`tmp/connector-failure-diagnostics-followup-node-reports.md` adds an orthogonal option: Node.js diagnostic reports can capture fatal V8/native failures and uncaught exceptions where a connector may produce little or no stderr. They are complementary to stderr tails:

- stderr tails cover deliberate `console.error(...)` / `process.exit(1)` and many ordinary JS failures.
- Node reports cover fatal native/V8 and uncaught-exception cases, but do not cover every deliberate exit and are Node-specific.

Owner decision:

- Keep stderr-tail persistence as the first diagnostic contract because it directly addresses the observed discarded-evidence bug.
- Allow Node diagnostic reports as **operator-local reference artifacts** only.
- Any command path that enables report flags in a process whose `NODE_OPTIONS` may be inherited by connector children must include `--report-exclude-env` and `--report-exclude-network`. Connector children routinely receive API tokens, cookies, filesystem paths, and usernames in env; default Node reports would otherwise persist them.
- Do not thread Node report paths into `run.failed` yet. Correlating reports to runs needs a separate design for per-child filenames, retention, and owner-only authorization.

## Diagnostic Shape

The terminal `run.failed` data may include:

```json
{
  "failure_origin": "connector",
  "failure_message": "Connector exited with code 1 before emitting DONE.",
  "connector_diagnostics": {
    "stderr_tail": {
      "object": "connector_stderr_tail",
      "encoding": "utf-8",
      "text": "...bounded redacted tail...",
      "bytes_observed": 49320,
      "bytes_captured": 16384,
      "truncated": true,
      "redacted": true
    }
  }
}
```

`text` is connector-authored and therefore untrusted. The dashboard may render it, but it must label it as connector output and should default to a collapsed/preformatted diagnostic panel rather than presenting it as a verified PDPP error message.

## Bounds And Redaction

- The runtime SHALL cap stderr capture as a tail buffer rather than accumulating unlimited chunks.
- The persisted excerpt SHALL be capped at a fixed byte limit; the implementation target is 16 KiB unless tests or existing payload-size conventions justify a smaller cap.
- The excerpt SHALL pass through the same secret-redaction policy used for reference diagnostics before persistence.
- The payload SHALL preserve `bytes_observed`, `bytes_captured`, and `truncated` so the owner can tell whether evidence was omitted.

## Alternatives Considered

- **Inline raw stderr.** Rejected. Connector output may contain credentials, cookies, local paths, or sensitive upstream payloads. Full raw stderr also makes terminal events unbounded.
- **Content-addressed log artifact now.** Deferred. This is the cleaner long-term pattern and matches Vercel/Airbyte/Fivetran style job diagnostics, but it raises retention, authorization, and blob-surface questions. It should be a second slice if bounded tails prove insufficient.
- **Node reports instead of stderr persistence.** Rejected. Reports catch a different failure subset and miss deliberate exits that write stderr. They are useful as a complement, not a substitute.
- **Developer-only files under `tmp/run-stderr/`.** Rejected as the primary fix. Local files help active development, but they do not travel with the run timeline and are easy to lose.
- **No durable capture; rely on live logs.** Rejected. The observed failures happened precisely because live logs were unavailable after the fact.

## Non-Goals

- No root PDPP protocol change.
- No client-token access to connector stderr.
- No durable full-log retention policy.
- No run-linked Node report artifact in this slice.
- No attempt to solve the unexplained `.env.local` absence from the long-lived dev process. That remains an investigation fact from the memo, not a proven root cause.
- No change to connector wire protocol or `DONE` semantics.

## Acceptance Checks

- A stub connector that writes stderr and exits `1` before `DONE` produces a terminal `run.failed` event with `failure_origin`, `failure_message`, `exit_code`, and `connector_diagnostics.stderr_tail`.
- A large stderr stream is bounded, reports `truncated: true`, and does not grow runtime memory unboundedly.
- A stderr stream containing representative secrets is redacted before persistence.
- Dev scripts that enable Node diagnostic reports include env/network exclusion flags.
- The dashboard run detail page renders the diagnostic as connector-authored evidence without treating it as the authoritative failure message.
- Grant-scoped `/v1` reads do not expose connector stderr diagnostics.
