# Design — register current high-churn compaction policies

## Scope

Three current high/watch churn streams whose churn is provably non-semantic:

| Stream | ~v/rec | Stored body | Volatile field | Forward fix |
| --- | --- | --- | --- | --- |
| gmail / labels | 269 | `{name, canonical_name, is_system, parent_name, message_count}` | none (`message_count` is `null`) | fingerprint over stored body |
| usaa / statements | 14.93 | identity + content-addressed pdf fields + `fetched_at` | `fetched_at` only | exclude `fetched_at` |
| chase / accounts | 20 | identity + all-null balances + `fetched_at` | `fetched_at` only | exclude `fetched_at` |
| slack / channel_memberships | high | `{id, channel_id, user_id, fetched_at}` | `fetched_at` only | exclude `fetched_at` (forward gate already shipped) |

## Why these three and not the others

The audit classified all eight brief-listed streams:

- **slack / channel_memberships** — forward fix already shipped (in
  `FINGERPRINTED_STREAMS` with `fetched_at` excluded, proven by
  `connectors/slack/fingerprint.test.ts`); only historical residue remained. No
  new connector work needed. The matching Family-1 compaction policy
  (`excludeKeys: ["fetched_at"]`) is now registered to collapse that residue —
  excluding only the run clock is lossless because the remaining fields
  (`id`/`channel_id`/`user_id`) are the membership identity, so a membership
  appearing or disappearing always survives as a fingerprint boundary.
- **github / user** — churns on real volatile fields (`followers`, `following`,
  `public_repos`, `public_gists`). No safe `excludeKeys` mirror exists; the only
  honest forward fix is to project these counts into a separate stream or accept
  the churn as semantic. Report-only.
- **slack / channels** — churns on `num_members`, a real membership-count
  change. Excluding it would hide genuine changes. Report-only.
- **usaa / accounts**, **usaa / credit_card_billing** — churn on real balance
  fields (`balance_cents`, `current_balance_cents`, …) in addition to
  `fetched_at`. Excluding only `fetched_at` would still leave balance churn (a
  real change), and excluding balances would hide real changes. Report-only.

The brief is explicit: "A low-quality 'exclude timestamps' guess is not
acceptable." For the three in-scope streams, excluding the run-clock field (or,
for labels, hashing the stored body) loses **nothing** real — the excluded field
is the run clock, not source data. For the four out-of-scope streams, any
exclusion would drop real signal, so they get a root-cause recommendation
instead of a churn-hiding compaction policy.

## gmail/labels parity construction

`labels` is keyed by `name`, not `id`; the stored `record_json` has no `id`
field. The fingerprint cursor keys on `data.id`, so the connector passes a
synthetic `id = name` but excludes it via `excludeFromFingerprint: ["id"]`. The
hash is therefore computed over exactly the stored body. The compaction policy
uses `excludeKeys: []` over the stored body (which has no `id`). Both produce
byte-identical hashes — asserted by the parity fixture
`gmail/labels: connector(exclude id) == compaction(stored body)`.

## content-addressed pdf stability (usaa/statements)

`pdfPath = join(dir, ${ym}-${pdfSha256.slice(0,16)}.pdf)` and
`document_url = fileUrlForPath(pdfPath)`. Both derive from the statement's
content hash, so a re-hydrated identical statement yields byte-identical
`pdf_path`/`pdf_sha256`/`document_url`. Only `fetched_at` moves between runs.
Excluding `fetched_at` is lossless; a genuinely re-hydrated statement (different
content → different sha → different path) is a real change and re-emits — pinned
by the `index-only → hydrated re-emits` test.

## Owner-gated live apply (deferred)

This lane does NOT run live `--apply` (no production mutation). Procedure for the
owner, per stream, dry-run first:

```
# dry-run (read-only, no secrets printed)
node reference-implementation/scripts/compact-record-history.mjs \
  --connector-instance-id=<cin> --stream=labels      # gmail
  --connector-instance-id=<cin> --stream=statements  # usaa
  --connector-instance-id=<cin> --stream=accounts    # chase
```

Confirm a non-zero `removableVersions`, then re-run with `--apply`. The tool
creates `compact_record_history_backup_<runId>` in the same transaction as the
DELETE (rollback handle), asserts insert/delete row-count parity, and marks the
retained-size projection dirty for rebuild. The console churn row clears on its
own after the projection recomputes from ground truth.

## Acceptance checks

- `node --test reference-implementation/test/compact-record-history.test.js`
- `node --test --import tsx reference-implementation/test/compact-record-history-fingerprint-parity.test.js`
- gmail/usaa/chase forward-gate tests + existing connector suites
- `openspec validate register-current-churn-compaction-policies --strict`

## Out of scope

- Live `--apply` (owner-gated).
- github/user, slack/channels forward fixes (need a real-field design decision,
  not a churn-hiding exclusion). usaa/accounts and usaa/credit_card_billing were
  later registered as `fetched_at`-only Family-1 policies (their real balance
  fields are retained as boundaries).
