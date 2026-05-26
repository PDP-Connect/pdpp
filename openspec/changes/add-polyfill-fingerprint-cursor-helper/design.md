## Context

The connector-author no-op confidence report (`tmp/workstreams/connector-author-noop-confidence-report.md`, 2026-05-26) audits four hand-rolled fingerprint cursors and concludes that the construction belongs in the polyfill connector authoring layer, opt-in, with the runtime byte-equivalence check kept as a backstop. The report sets a 95% confidence bar on the construction direction and an 80% bar on the exact API shape, pending one real migration. This change executes that migration against Slack.

The four existing implementations all do the same thing: build a stable fingerprint over the emitted record (with a connector-local exclude list for run-clock fields), decode a prior fingerprint map from the prior STATE cursor (tolerantly), skip the emit when the fingerprint matches, carry forward fingerprints for skipped records so the next STATE write does not drop them, track which IDs were seen this run, and prune fingerprints for IDs no longer observed on requested full-scan streams. The Codex variant additionally reads the prior fingerprint to drive a derived-field-preservation policy — connector-specific logic that must remain at the call site, not in the primitive.

## Decision

### Primitive shape

A single factory function returns a small cursor object with five obvious operations:

```ts
export interface FingerprintCursor {
  shouldEmit(id: string, data: RecordData): boolean;
  priorFingerprint(id: string): string | undefined;
  toState(): Record<string, string>;
  pruneStale(): void;
  size(): number;
}

export function openFingerprintCursor(
  priorState: unknown,
  options?: FingerprintCursorOptions,
): FingerprintCursor;
```

`FingerprintCursorOptions` carries:

- `excludeFromFingerprint`: readonly list of record fields that participate in the emitted shape but must not change the fingerprint (run-clock fields).
- `priorFingerprints`: optional pre-decoded prior map, for callers that decode the cursor themselves.

`openFingerprintCursor` tolerantly decodes the prior state if `priorFingerprints` is not supplied: it accepts `undefined`, a record with `{ fingerprints: { id: string } }`, a record with the legacy `synced_at` shape, and silently drops malformed entries. This matches the existing Slack `readPriorFingerprintMap` behavior.

`shouldEmit(id, data)`:

- Returns `true` if the fingerprint of `data` (with exclusions applied) differs from the prior fingerprint for `id`, or if there is no prior.
- Always records the computed fingerprint into the next map and the id into the seen set, even when returning `false`. This is the load-bearing line for STATE carry-forward.
- Records without an id (id is `null`/`undefined`/empty) cannot be fingerprinted; callers gate this themselves and emit anonymous records unconditionally.

`priorFingerprint(id)` exposes the prior cursor's value for connector-specific derived-field preservation. This is the Codex pattern; the primitive does not encode policy.

`toState()` returns a plain `Record<string, string>` suitable for use as a stream cursor field. The connector decides what wrapper key to use (`{ fingerprints: cursor.toState(), synced_at }` matches the existing Slack STATE shape).

`pruneStale()` drops every id from the next map that was not added via `shouldEmit` this run. This must only be called for streams whose run is a full scan; the caller decides which streams to prune, so the primitive does not need a stream registry. If `shouldEmit` was called zero times, every prior id is dropped — that is the correct behavior for a requested full-scan stream that returned zero records.

`size()` is included so connectors can avoid writing an empty `fingerprints` field for visibility (Slack's existing pattern).

### Why a per-stream cursor instead of a multi-stream registry

The four existing implementations all carry per-stream maps in a single bag with a `FINGERPRINTED_STREAMS` constant and a single prune call across streams. That works because Slack happens to have three fingerprinted streams. The shared primitive is **per stream**: a connector opens one cursor per fingerprinted stream and decides when to prune. This stays closer to the call-site so debugging churn does not require chasing a registry, and it removes the implicit coupling between unrelated streams' carry-forward.

Slack's migration uses one cursor per stream. The connector still owns the multi-stream STATE write loop in `emitStateCheckpoints`; the helper does not hide that.

### What lives outside the primitive

The primitive does not own:

- the choice of which fields are run-clock — only the connector knows;
- the wrapper shape of STATE (where the fingerprints map sits next to other cursor fields);
- the identity of records (the connector still constructs the id);
- the deterministic record builder (sorted participant arrays, sorted label sets, stable JSON key order from `Object.create(null)`-style builders) — these are the connector's responsibility and the authoring guide must continue to call them out;
- the runtime byte-equivalence backstop, which remains at the storage layer.

### Test surface

A focused test exercises the primitive directly against the four scenarios the confidence report names: identical second run emits nothing, run-clock-only diff does not re-emit, source-field change re-emits, prior id absent from this run is pruned, malformed/legacy state is tolerated. The migrated Slack `fingerprint.test.ts` continues to assert the same end-to-end behavior against the Slack call site, with the helper sitting inside it.

A fully generic `assertConnectorIsIdempotent` harness was considered. It was scoped out for this tranche because:

- It would need to drive a full connector run against a fixture, which depends on `connector-runtime` plumbing and per-connector fixture conventions that vary today.
- The confidence-raising work the report calls out is a single real migration with the existing Slack tests passing on the new helper. That is the cheaper path to >95% confidence on the exact API shape.

The primitive-level test set is the seam any future per-connector harness would call. It can be promoted to a reusable assertion in the next tranche once one more connector migrates.

## Alternatives

- **Make the primitive a decorator around `emitRecord`.** Rejected — hides where state lives, how carry-forward happens, and what gets pruned. All four hand-rolled implementations kept the cursor and the gate visible at the call site precisely because debugging churn requires it.
- **Promote the fingerprint into a runtime/storage column.** Rejected — leaks connector-domain knowledge (which fields are run-clock, which are derived) into storage, requires a per-stream policy registry on the runtime side, and crosses the Core / reference boundary in `full-context-refresh.md`.
- **Mandate adoption with auto-migration of Gmail / Codex / YNAB.** Rejected — those connectors converged on the same shape but with connector-specific details (Codex's count fallback is load-bearing). A forced migration would risk regressions for no immediate benefit; opportunistic migration is correct.
- **Make the primitive multi-stream out of the box.** Rejected for now — Slack's three-stream bag was incidental, and a per-stream cursor stays closer to the call site. If a connector with many fingerprinted streams emerges later, a thin wrapper that groups cursors by stream is cheap to add and cannot be retrofitted onto a single-stream primitive cleanly without churn.

## Acceptance Checks

- A new `openFingerprintCursor` helper lives under `packages/polyfill-connectors/src/` with `shouldEmit`, `priorFingerprint`, `toState`, `pruneStale`, `size` operations and tolerant prior-state decoding.
- The Slack connector wires through the helper and uses it for `workspace`, `users`, and `files` streams. Slack-specific `emitWithFingerprint`, `pruneStaleFingerprints`, and `readPriorFingerprintMap` are removed (the deterministic-stringify `recordFingerprint` helper moves into the shared module).
- The existing Slack `fingerprint.test.ts` continues to assert the same behavior, updated only to reflect the new helper.
- A new focused test in `packages/polyfill-connectors/src/` proves the four scenarios named in the confidence report against the helper directly.
- The connector authoring guide names the primitive, when to use it, the exclusion list, the prune semantics, and explicitly states the runtime byte-equivalence check is a backstop.
- `openspec validate add-polyfill-fingerprint-cursor-helper --strict` passes.

## Out of scope

- A fully generic `assertConnectorIsIdempotent` harness running real connector runtimes against fixtures.
- Migrating Gmail, Codex, or YNAB.
- Any change to PDPP Core, Collection Profile, public record shape, or storage schema.
- A new wire field on RECORD or STATE.
- Cross-connection dedupe.
- Historical compaction.
