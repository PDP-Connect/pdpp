# Design — gate the statement hydration-availability flap

## Problem restated

Both statement connectors emit one `statements` record per index row. On a
successful PDF download the body carries `document_url`/`pdf_path`/`pdf_sha256`; on a
failed download the body falls back to all-null (index-only). The three hydrated
fields are content-addressed and the statement identity is immutable, so the only
thing that makes a previously-hydrated statement re-version is a hydration-availability
flip:

```
run A: hydrate  -> {pdf_path: P, pdf_sha256: S, document_url: U}   (version 1)
run B: fail     -> {pdf_path: null, sha: null, url: null}          (version 2)  ← flap
run C: hydrate  -> {pdf_path: P, pdf_sha256: S, document_url: U}   (version 3)  ← flap-back
```

Versions 2 and 3 are not real history. The PDF at path `P` (content-addressed by
`S`) still exists after run B — run B simply failed to re-fetch it. The
`SKIP_RESULT` already records that per-run failure honestly. The question is only
what the *retained record body* should assert.

## Why the existing gates do not (and must not) catch it

The per-statement fingerprint cursor excludes only `fetched_at`. A `value -> null`
move on `pdf_path` is a genuine fingerprint change, so `shouldEmit` returns `true`.
The registered compaction policy mirrors that fingerprint (`excludeKeys:
["fetched_at"]`), and the already-shipped `extend-chase-run-clock-churn-gates` spec
pins the opposite-direction invariant explicitly:

> a version that changes any retained real field — for example a newly-hydrated
> `pdf_path`/`pdf_sha256`/`document_url` ... SHALL remain a fingerprint boundary
> that is never collapsed

So neither the connector gate nor the compaction tool is allowed to collapse the
flap, and that is correct: a blanket exclusion of the hydrated fields would also
swallow the legitimate `null -> value` first hydration, which is real history worth
one version. The flap can only be removed by not producing it — at the emit layer.

## Chosen construction: carry forward prior hydrated pointers (option 1)

On a hydration failure for a statement whose prior STATE cursor shows it was
previously hydrated, re-emit the prior `document_url`/`pdf_path`/`pdf_sha256` instead
of null. A statement with no prior hydrated pointers stays index-only (all-null).

```
run A: hydrate  -> {P, S, U}                         (version 1)
run B: fail     -> carry forward {P, S, U}           (no new version; SKIP_RESULT emitted)
run C: hydrate  -> {P, S, U} identical               (no new version)
```

`null -> value` first hydration still versions exactly once; a real identity/title
change still versions; the steady state returns to ~1 version per statement.

### Why this is the right construction, not just the smallest

The full-context-refresh "good construction before feature lists" test asks whether
this still looks like the right foundation under a novel case. It does, because it is
**not a new primitive** — it is a second application of an existing, owner-accepted
one. The canonical capability spec already says the per-record fingerprint cursor
SHALL "expose the prior fingerprint value so a connector with derived-field-
preservation policy can read it." Codex is the first consumer: when a run does not
re-parse a session's rollout file, `makeThreadFingerprint` pulls the prior
`message_count`/`function_call_count` forward (`agg?.messageCount ??
priorFingerprint?.message_count ?? null`) so a state-only update never clobbers a
real count with null. The statement flap is isomorphic: hydration failure is "did not
re-fetch the artifact this run," and the prior pointers are the derived fields to
preserve. The construction generalizes to any connector whose body carries a
content-addressed artifact pointer that a given run may fail to re-verify.

### The one real sub-decision: where the prior body lives

The statements cursor today is the hash-only `openFingerprintCursor` (`T = string`).
A hash cannot reconstruct `{P, S, U}`. Two equivalent ways to give the connector the
prior pointers, both reusing the existing carry-forward lifecycle:

- **(a) Structured fingerprint** — move the statements cursor to
  `openCarryForwardCursor<StatementFingerprint>` where the fingerprint carries the
  hydrated pointers (plus the identity hash for change detection), exactly as Codex
  carries `ThreadFingerprint`. The prior pointers come straight from `cursor.prior(id)`.
  Change detection compares the structured value (or a hash field within it).
- **(b) Hash cursor + sibling prior-body map** — keep the hash `openFingerprintCursor`
  for change detection and persist a second `hydration: { id -> {P,S,U} }` map in the
  same `statements` STATE cursor, decoded by an extended
  `readPriorStatementFingerprints`. On failure, look up `hydration[id]`.

Recommendation: **(a) structured fingerprint**, because it keeps one source of truth
per statement in the cursor and matches the Codex precedent the canon already cites,
which is the cleaner construction. (b) is a valid fallback if the owner prefers to
leave the change-detection hash untouched. The spec delta is written to be
satisfied by either; `tasks.md` assumes (a) and notes (b) as the alternative.

In both cases the carried-forward fields are content-addressed: re-emitting `{P, S,
U}` asserts "this statement's PDF is at content-addressed path `P`", which remains
true because the bytes never move. The new body-honesty invariant is stated
normatively: a carried-forward body asserts the artifact's last known content-
addressed location, not that this run re-verified it; the per-run `SKIP_RESULT`
remains the authoritative record that this run did not re-fetch it.

## Alternatives considered (owner may override the choice)

- **Option 2 — asymmetric fingerprint exclusion.** Exclude the hydrated fields from
  change detection only for the `value -> null` direction, keeping `null -> value` as
  a boundary. Rejected as the primary construction: it is harder to prove lossless
  (the exclusion rule is directional and stateful) and it leaves a *false* body on
  disk (the record still says `pdf_path: null` for a statement that has a PDF) while
  merely hiding the version. Carry-forward fixes the body, not just the version count.
- **Option 3 — separate attachment observation.** Model PDF availability as its own
  attachment stream/noun rather than entity-versioning fields on the statement. This
  is the better long-term noun (an attachment is its own thing; the canon already has
  a "source file bytes / attachments / statements / receipts / exports" requirement
  around storage), and if the owner wants statement PDFs to be first-class attachments
  it is the right target. Deferred here because it is the largest change — a new
  stream, manifest surface, and read-path — and is not required to stop the flap.
  This change deliberately does not foreclose option 3: it touches only the statement
  body contract, so a later attachment-stream change can supersede it.
- **Do nothing.** The rows stay correctly classified as
  `lossless_compaction_candidate`, so there is no dashboard regression, but
  `versions_per_record` inflates whenever hydration is flaky and the compaction tool
  is contractually unable to clean it. Rejected: the flap is avoidable churn on an
  immutable record.

## Scope

In scope: the `chase/statements` and `usaa/statements` emit-failure body contract,
the statements STATE cursor shape (connector-internal), the two pinned integration
tests, and new fingerprint tests. The shared cursor primitive is reused, not
redesigned.

Out of scope: all other attachment-bearing streams; any non-statement field; the
compaction tool and its policies; the public RECORD/STATE wire shape; PDPP Core. A
general "attachment observation" noun (option 3) is explicitly out of scope for this
change.

## Acceptance checks

Reproducible per `tasks.md`. The six cases the construction must satisfy:

- **AC-1 no regression flap.** Run A hydrates statement `id`; run B fails hydration
  for the same `id` → the entity stream emits NO new version (carry-forward keeps the
  body byte-identical modulo `fetched_at`) and a `SKIP_RESULT` is still emitted for
  run B.
- **AC-2 first hydration still versions.** Run A index-only (never hydrated); run B
  hydrates → exactly one new version. `null -> value` is real and must survive.
- **AC-3 genuine identity change still versions.** A statement whose identity/title
  changes still re-versions; carry-forward keys on `id` and never masks a real change.
- **AC-4 flap-back idempotent.** Run A hydrate, run B fail (carry-forward), run C
  re-hydrate identical PDF → one version total, not three.
- **AC-5 both connectors share the observable contract.** chase
  `processStatementRow`/`emitStatementIndexOnly` and usaa `emitStatementRecords`
  produce the same carry-forward behavior; the pinned all-null assertions are updated
  to (i) all-null when never hydrated, (ii) carried-forward pointers when previously
  hydrated.
- **AC-6 compaction safety.** No policy change. The `fetched_at`-only fingerprint
  parity fixture for `chase/statements` and `usaa/statements` stays valid; `--apply`
  still cannot collapse a real `null -> value` first hydration.

## Validation

- `node --test --import tsx connectors/chase/{statements-fingerprint,integration}.test.ts`
- `node --test --import tsx connectors/usaa/{statements-fingerprint,integration}.test.ts`
- `node --test test/compact-record-history*.test.js` (policy parity unchanged)
- `openspec validate gate-statement-hydration-availability-flap --strict`
- `openspec validate --all --strict`
