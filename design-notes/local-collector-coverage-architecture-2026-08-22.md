# Local-collector coverage: two parallel systems, not one dropped field

Investigation of PR #166 owner-feedback item C1: four local-collector sources
(peregrine Claude Code, peregrine Codex, Simon VM Claude Code, vivid fish Claude
Code) emit coverage facts with blank `covered`/`considered` while server-run
connectors emit real numbers.

**Read this before "fixing" the blank denominators.** The obvious fix is wrong
and would fabricate a false coverage claim. The disproof is in §3.

## Verdict

The owner's reasoning — "local collector runs a connector the same way the
server does, so denominators should depend on the CONNECTOR, not the runner" —
is sound in principle but does not describe how this is built. There is no
single runner with a dropped field. There are **two parallel coverage systems**
with different units, vocabularies, and transports.

This is a **per-connector gap plus a transport that cannot carry counts**, not a
runtime silently discarding numbers the connector emitted. `claude_code` and
`codex` emit no `DETAIL_COVERAGE` message at all — zero occurrences in either
`connectors/*/index.ts`.

| | Server path | Local path |
|---|---|---|
| Signal | `DETAIL_COVERAGE` message | `coverage_diagnostics` records |
| Unit | per-record counts | per-**store** status enum |
| Vocabulary | `covered` / `considered` | `collected`, `inventory_only`, `missing`, `deferred`, `excluded`, `unsupported`, `unaccounted` |
| Verdict source | `covered` vs `considered` | `localCoverageConditionForStatus` |

## 1. Three independent barriers

Any one of these alone is sufficient to produce blank denominators. All three
are present, so a partial fix changes nothing.

**Barrier 1 — the producer has no numeric field.**
`packages/polyfill-connectors/src/local-source-inventory.ts:168-181`.
`CoverageRecord` carries `status`, `store`, `stream`, `reason` — no count.
`coverageStatus()` (:541) answers "does this store exist and what is its
policy", one status per store. Counts that *are* measured get stringified into
prose at :245:

```ts
return `enumeration complete, ${input.examined} examined (${input.emitted} emitted)`;
```

**Barrier 2 — the wire contract forbids counts.**
`packages/reference-contract/src/reference/index.ts:1839-1848`:

```ts
const DeviceTerminalRunFactSchema = {
  additionalProperties: false,
  properties: {
    coverage_statuses: { items: { minLength: 1, type: "string" }, minItems: 1, type: "array" },
    scoped: { type: "boolean" },
    stream: { minLength: 1, type: "string" },
  },
  required: ["coverage_statuses", "stream"],
```

`additionalProperties: false` — numeric coverage is actively rejected, not
merely absent. `canonicalTerminalRunCommitEnvelope`
(`packages/reference-contract/src/common/terminal-run-commit.ts:32-45`)
reconstructs each fact from exactly these three fields, so anything else is
dropped before signing.

**Barrier 3 — the server hard-codes null.**
`reference-implementation/operations/local-device-terminal-collection.ts:249-258`:

```ts
const fact = readRuntimeCollectionFact({
  checkpoint: "committed",
  collected: 0,
  considered: null,
  coverage_statuses: coverageStatuses,
  covered: null,
  ...
```

This exactly reproduces the observed rows: `covered: null`, `considered: null`,
`collected: 0`, `checkpoint: "committed"`.

## 2. The local path is NOT verdict-less

Worth stating because "coverage unknown" was over-scoped in the ledger. The
server has a working local coverage authority:
`reference-implementation/server/ref-control.ts:3829-3848` maps
`collected -> "complete"`, `inventory_only -> "inventory_only"`,
`unaccounted -> "gaps"`. `coverageTone` (`runtime/rendered-verdict.ts:560`)
renders `complete`, `deferred`, and `inventory_only` all **green**.

`connector-coverage-policy.ts:246-249` treats `observed_collected` (derived from
`coverage_statuses`) as legitimate non-numeric coverage proof, and
`verdict.proven` can return `"complete"` with no denominator at all.

So blank denominators do not automatically mean a red or unknown stream. Check
the rendered verdict per stream before scoping work.

## 3. Why `examined` is NOT the denominator (the trap)

The prose already contains real numbers, so piping them into `considered` looks
like a one-line fix. It is a fabricated denominator. Production disproof
(peregrine Codex, `cin_ece4bfe5096b8bf67a1468c2`):

```
coverage_diagnostics reason: "enumeration complete, 566589 examined (0 emitted)"
actual stored records:       758,345
```

**Examined (566,589) is LOWER than stored (758,345).** `scanLocalJsonl`
(`packages/polyfill-connectors/src/local-jsonl-cursor.ts:139-172`) is
incremental: on a `fast_skip` or `append` decision `onLine` fires only for new
bytes. `examined` is therefore a **per-run delta**, not a corpus size.

Rendering that as `considered` would show "566589 of 566589 — complete" for a
run that skipped most of the corpus. That is precisely the fabricated-watermark
defect class this program exists to eliminate.

It is also not uniform. `sessions` reports `"declared rollout source"` — **no
count exists at all**. Any fix must be per-stream.

## 4. What an honest denominator would be

For these inventory-style local collectors: **corpus discovered vs corpus
parsed**, measured at the enumeration site independently of the incremental
cursor — e.g. sessions/transcript files discovered on disk vs successfully
parsed. That satisfies the standard `DetailCoverageParams` already documents
(`connector-runtime.ts:494-509`): measured at the enumeration site, never
aliased to the collected/emitted count.

Today's counters cannot supply it. `messagesExamined`
(`connectors/claude_code/index.ts:1447-1470`) is honestly measured per-line and
classified independently of emission — it is a *good* number, just a
per-run-delta one. Getting a real denominator means teaching the connectors to
measure corpus size on a full pass, separate from the cursor.

Streams that genuinely cannot have one (a store whose whole content is
`inventory_only` by policy) should keep saying so precisely via
`coverage_statuses` rather than reporting a blank number.

## 5. Cross-repo scope

The end-to-end fix spans three places, one of which is not this repo:

- **data-connect** (`PDP-Connect/data-connect @ 9155e57`) — the collector
  runtime and `@pdpp/connector-protocol` that build `terminal_facts`. Vendored
  here as `vendor/pdpp-collector-runtime-0.0.1.tgz` and
  `vendor/pdpp-connector-protocol-0.0.1.tgz`; not editable in this repo.
- **this repo, reference-contract** — the wire schema AND
  `canonicalTerminalRunCommitEnvelope`, which is the **commit-id / replay hash
  authority**. Widening the fact shape changes envelope hashes, so it is a
  compatibility break requiring a versioned migration, not an additive field.
- **this repo, reference-implementation** — `normalizeTerminalFacts` and the
  coverage policy.

Recorded as a known architectural gap. Not attempted here: a hash-contract break
across repos needs deliberate scoping.

## 6. Related finding: freshness is a separate defect

Ledger C3 suspects local sources write no run history. **They do** — 537
succeeded runs for peregrine Claude Code, 380 for peregrine Codex, all recent.
C3 is right only for Signal.

Local-device runs are deliberately discarded for health
(`ref-control.ts:5215-5221`, `localDeviceBacked ? null : ...`), so freshness
rests entirely on the heartbeat gate. A single dead-lettered row out of 10,001
forced `blocked` -> `stalled` -> no freshness proof -> RED "can't collect" on a
2.5-million-record source whose collector was healthy. Fixed separately in
`localDeviceFreshnessHeartbeatAt`; see
`test/local-device-terminal-backlog-freshness.test.ts`.
