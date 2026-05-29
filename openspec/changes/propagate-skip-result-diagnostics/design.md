## Context

`packages/polyfill-connectors/src/connector-runtime-protocol.ts` declares `SKIP_RESULT.diagnostics?: unknown`. Several connectors (USAA CSV export, USAA PDF parser, USAA PDF hydrate fallback) already emit it with rich page/state/response evidence. `reference-implementation/runtime/index.js` reads only `msg.stream`, `msg.reason`, `msg.message`, `msg.recovery_hint`, and the scope hints. The validator at `runtime/index.js:789` does not acknowledge the field. The spine emit at `runtime/index.js:2341-2359` writes only `source`, `stream`, `reason`, `message`, and `known_gap`. The diagnostics object is dropped, which made offline diagnosis of three USAA export attempts (`run_1779855264344`) impossible without another live human run.

The sibling change `persist-connector-failure-diagnostics` solved the analogous problem for `run.failed` (connector exits before `DONE`) by adding a bounded, redacted `connector_diagnostics.stderr_tail`. The `run.stream_skipped` path needs the same shape — owner-only timeline evidence, bounded and redacted, with no protocol semantics or `/v1` exposure.

## Decision

1. **Validate the field as a bounded object.** Propagate only object-shaped diagnostics so that downstream owner surfaces receive a predictable shape. Arrays and non-object scalars are dropped from persistence without rejecting the `SKIP_RESULT` message — the connector is free to emit them, but they are not propagated.
2. **Reuse the existing redaction policy.** `boundGapString` already redacts the tokens the runtime considers sensitive (`bearer`, `token`, `password`, `passwd`, `cookie`, `secret`, `otp`, 6-digit OTP numbers). The new helper SHALL walk a connector-authored diagnostics object recursively and apply `boundGapString` to every string leaf; non-strings (number, boolean, null) pass through unchanged. Nested arrays are preserved up to a fixed element cap; nested objects are preserved up to a fixed depth.
3. **Bound the total JSON byte size.** The persisted shape SHALL be capped (target: 8 KiB JSON when stringified). On overflow, surface `{ truncated: true, original_keys: [...], reason: "size_overflow" }` instead of the original object. This keeps downstream spine-event payloads bounded.
4. **Attach to both surfaces.** Forward the bounded diagnostics on `run.stream_skipped.data.diagnostics` (spine event payload) and on the `known_gap` (so the diagnostic survives into the run's terminal `known_gaps` block and dashboard surfaces).
5. **Connector behavior unchanged.** No connector-side type change. USAA can continue emitting `SKIP_RESULT.diagnostics` as it already does.

## Diagnostic Shape

The persisted shape on `run.stream_skipped.data.diagnostics` and `known_gap.diagnostics` is a connector-authored object. Each string field passes through the same secret-redaction policy used for `boundGapString`. Example for USAA export failure:

```json
{
  "phase": "export_artifact_wait_failed",
  "diag": {
    "url": "https://www.usaa.com/my/checking?accountId=…",
    "title": "USAA Checking",
    "dialog_html_preview": "…",
    "dialogs_open": 1
  },
  "artifact": {
    "cdpReady": true,
    "cdpError": null,
    "candidates": [
      {
        "source": "cdp",
        "status": 200,
        "reason": "not_expected_body",
        "url": "https://www.usaa.com/…",
        "contentType": "text/html;charset=utf-8",
        "bodyBytes": 1247
      }
    ]
  },
  "error": "download_empty"
}
```

The dashboard MAY render this as collapsed connector-authored evidence next to the run timeline. It is labeled connector-authored, never as the authoritative runtime failure classification.

## Bounds And Redaction

- The runtime SHALL apply `boundGapString` to every string leaf reachable from the connector-authored diagnostics object.
- The runtime SHALL truncate the bounded diagnostics by total JSON byte size (implementation target: 8 KiB) and emit a sentinel object `{ truncated: true, reason: "size_overflow" }` when the cap is exceeded so the owner can see that evidence was omitted.
- The runtime SHALL preserve the diagnostic's top-level shape (object → object) so consumers do not have to handle arrays at the top level.
- Nested array length SHALL be capped (implementation target: 32 elements). Nested object recursion depth SHALL be capped (implementation target: 6 levels). Exceedances SHALL be replaced with the sentinel `{ truncated: true, reason: "depth_overflow" | "list_overflow" }`.

## Alternatives Considered

- **Keep the field connector-private.** Rejected. The connector emits a rich diagnostic precisely because the runtime is the only place that can persist it across the process boundary. Dropping it teaches connector authors that emitting evidence is pointless.
- **Pass raw `diagnostics` through unchanged.** Rejected. Connector authors are not constrained to bounded strings; an unredacted dialog HTML preview could leak account numbers, OTP-like patterns, or session token names. The same redaction policy used for `SKIP_RESULT.message` SHALL apply.
- **Add a separate `pdpp_diagnostics` envelope.** Rejected. The field already exists in the protocol type. Adding a parallel envelope would require updating every connector that already emits it.
- **Propagate only to `known_gap`, not to the spine event payload.** Rejected. The terminal `known_gaps` block is summary-shaped; the spine event payload is the inspection surface. Both should carry the diagnostic so timeline scrubbing and run-summary rendering both work.

## Non-Goals

- No `/v1` grant-scoped exposure of `SKIP_RESULT.diagnostics`.
- No new connector protocol field. The `SKIP_RESULT.diagnostics` field already exists in `packages/polyfill-connectors/src/connector-runtime-protocol.ts`.
- No change to how USAA emits diagnostics.
- No change to the `run.failed` `connector_diagnostics.stderr_tail` shape from `persist-connector-failure-diagnostics`.
- No new dashboard renderer. The change ships data; rendering follows in a downstream slice.
- No change to OpenSpec storage of `known_gaps_json`. The diagnostics live inside the existing known-gap blob; no schema migration.

## Acceptance Checks

- A connector emitting `SKIP_RESULT` with a `diagnostics` object produces a `run.stream_skipped` spine event whose `data.diagnostics` carries the connector-authored object with bounded, redacted string leaves.
- A connector emitting `SKIP_RESULT` with `diagnostics` containing a representative secret-shaped string (e.g. `password=secret` or a 6-digit OTP) lands the redacted text in `data.diagnostics`, not the original.
- A connector emitting `SKIP_RESULT` with a diagnostics object whose JSON exceeds the size cap produces a sentinel `{ truncated: true, reason: "size_overflow" }` in place of the original object.
- A connector emitting `SKIP_RESULT.diagnostics` that is an array, string, or other non-object value drops the field (it does not propagate) without rejecting the message.
- A grant-scoped `/v1` read does not include `SKIP_RESULT.diagnostics`. (Existing `/v1` scope rules already exclude run-timeline events; this change adds no new exposure path.)
- The bounded diagnostics survive on the `known_gap` block emitted in the terminal `run.completed` / `run.failed` payload.

## Residual Risks

**Live USAA export root-cause verification (owner-only):** A live USAA run with diagnostics propagation enabled is the only way to confirm that the `PageDiagnostics` and `BodyResponseDiagnostics` payload emitted at the export failure moment survives into the persisted timeline and is sufficient for offline root-cause analysis without another human-driven run. The automated tests (3.1–3.4) cover all code paths with stub data. This live step cannot be replaced by automation because it requires real USAA credentials and the operator-specific Docker deployment. The owner should run a real USAA export attempt and verify that `data.diagnostics` appears on the `run.stream_skipped` spine event in the run timeline before treating this change as fully proven in production.
