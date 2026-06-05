## Context

The reference implementation stores current records in `records` and retained history in `record_changes`. Older or weaker connector code can create duplicate retained versions when only acquisition metadata changes. Chase transactions are the current proof case: `1145` current records, `4605` retained versions, and exactly `1145` semantic versions after excluding QFX acquisition metadata `fetched_at` and `source`.

Prior-art lanes produced these constraints:

- Kafka-style compaction keeps key-ordered logical state, does not renumber offsets, and treats tombstones as boundaries.
- Debezium snapshot/stream reconciliation makes the authoritative current stream event win over a redundant snapshot read.
- Airbyte/Singer/dlt-style connectors require explicit identity, cursor/state, scan-kind, and stable change detection; leaving those semantics in ad-hoc connector code prevents a second component from proving compaction.
- Temporal/versioned storage guidance is still in flight; the design avoids depending on physical history rewrites beyond backed-up row deletion.

## Goals / Non-Goals

**Goals:**

- Make retained-history compaction converge, for eligible streams, to the same owner-visible semantic version boundaries a corrected connector would have emitted from day one.
- Add an opt-in canonical mode that can collapse immutable same-fingerprint history to one survivor per semantic run.
- Keep default audit-mode compaction unchanged for all streams not explicitly opted in.
- Preserve current `records` rows and version identities during the first implementation slice.
- Validate destructive behavior on a copied/narrow database before any live apply.

**Non-Goals:**

- No protocol-level PDPP Core change.
- No global compaction of arbitrary connector JSON.
- No aggressive compaction for mutable streams, point-in-time snapshots, or streams lacking explicit canonical policy.
- No first-slice relocation of acquisition metadata out of `record_json`; that is required for exact raw payload convergence but is a separate connector/data-shape change.
- No deletion of backup tables or database capacity cleanup as part of this change.

## Decisions

### Add canonical mode rather than changing audit mode

Default compaction keeps first observation plus current observation for audit provenance. Canonical mode is a new explicit mode that lowers the same-fingerprint retention floor to one survivor per semantic run. This keeps existing safety behavior stable while letting immutable streams opt into stronger convergence.

Alternative considered: change the existing selector globally. Rejected because mutable streams and historically-reviewed residue rely on conservative retention.

### Keep current as the same-fingerprint survivor in the first slice

Canonical mode keeps the `records.version` row for the current semantic run. This avoids rewriting the `records` table, preserves public current reads, avoids orphaning the current anchor, and follows CDC/log-compaction prior art where the authoritative current state wins.

Alternative considered: keep the first semantic observation. Rejected for the first slice because it requires current-row rewrites and conflates storage convergence with payload/provenance cleanup. It remains useful as evidence for exact cross-universe payload analysis, but not as the first destructive policy.

### Gate canonical mode by explicit stream policy

Canonical mode requires `changeModel: "immutable_semantic"` and `representativePolicy: "current"` on the compaction policy. A missing or mutable policy SHALL fail closed. Initial eligibility is limited to `chase/transactions`, whose copied-data proof shows no record has more than one semantic version after excluding `fetched_at` and `source`.

Alternative considered: infer eligibility from low semantic version count. Rejected because one local dataset is not a durable connector contract.

### Bind connector no-op suppression to compaction fingerprint

The compactor and connector runtime must use the same canonical fingerprint definition. Today the equality is enforced through parity tests and policy comments; this change makes it normative for eligible streams and strengthens tests so parity cannot silently skip.

Alternative considered: let compaction own independent field exclusions. Rejected because that lets a connector defect be hidden by a later tool and breaks the old-bad/new-good convergence proof.

### Separate semantic payload convergence from raw storage equality

The SLVP ideal is owner-visible canonical data convergence. If run-clock or acquisition metadata remains in `record_json`, exact byte equality across two environments is impossible. The first implementation slice therefore proves semantic/version-boundary convergence and current-state preservation; a later connector/data-shape change should relocate non-versioning acquisition metadata into run/audit/provenance telemetry.

Alternative considered: rewrite old `record_json` payloads during compaction to strip metadata. Rejected for this slice because it changes record payloads and grant-visible fields, requiring a broader data-shape proposal.

## Risks / Trade-offs

- **Mutable stream collapse** → Canonical mode refuses streams without `changeModel: "immutable_semantic"` and targeted tests cover denial.
- **Tombstone loss** → Tombstones and resurrection boundaries remain hard survivors.
- **Current anchor orphaning** → The current `records.version` row remains pinned; copied-DB validation asserts every current row has a matching retained history row after apply.
- **Version gaps** → Versions are not renumbered. Existing version-floor behavior prevents reuse; tests should keep this pinned.
- **Over-claiming equality** → Docs and operator output must say canonical mode converges semantic version boundaries and current owner-visible state, not raw byte identity while acquisition metadata remains in payload.
- **Backup growth** → Apply still writes backup tables. Storage visibility and backup retention are handled by a separate operational visibility lane.

## Migration Plan

1. Add `mode: "audit" | "canonical"` to the compaction script; default remains `audit`.
2. Add opt-in canonical policy fields for `chase/transactions`.
3. Add selector tests for canonical mode, fingerprint-boundary preservation, tombstones, current survivor, and denial gates.
4. Add parity tests that fail closed when connector fingerprint helpers cannot load.
5. Run dry-runs and apply on a copied/narrow database.
6. Only after validation, run a live dry-run; live apply remains an explicit owner action.

## Open Questions

- Should non-versioning acquisition metadata be removed from future canonical `record_json` payloads and stored only as run/provenance telemetry?
- Should manifest stream definitions eventually carry identity, fingerprint exclusion, run-clock metadata, and scan-kind declarations instead of keeping them in connector code plus compaction policy?
- What retention/expiry policy should apply to compaction backup tables after owner acceptance?
