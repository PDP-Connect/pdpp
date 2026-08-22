# Connector coverage findings — USAA and Gmail (2026-08-22)

Four owner-reported coverage gaps (ledger items D1–D4). Two of the four had a
wrong premise in the report; the evidence is recorded here because each finding
is the kind that gets rediscovered as something else entirely six months later.

## D1 — USAA `transactions` stuck at 2 of 4: a marketing interstitial, NOT a UI change

**The finding that will otherwise be rediscovered as "USAA changed their UI".**

USAA serves a promotional interstitial in FRONT of a checking account page:

```
https://www.usaa.com/my/banking-offer/atm-deposit
    ?accountId=…&accountType=checking&goto=https://www.usaa.com/inet/ent_home/CpHome
title: "Find an ATM | USAA"      ("Depositing cash just got more convenient!")
```

`locateExportPage` navigated to the account URL, was redirected here, found no
Export button, and reported `source_structure_changed` — whose owner-facing
meaning is "the source's UI changed; retrying is pointless until the connector's
selectors are revisited". **The selectors were fine.** The connector was looking
at a page that never claimed to have an Export button.

Only `LOGON_REDIRECT_RE` was checked after navigation. `/my/banking-offer`
matched neither that nor `USAA_ACCOUNT_DETAIL_ROUTE_RE`, so it classified as
`unknown` and fell through to the no-affordance path.

### The correlation that proves it

The denominator for `transactions` is **accounts, not statements**
(`emitTransactionsDetailCoverage`, `state_stream: "accounts"`): 5 accounts, 4
transaction-eligible (Chase is `external-account`).

| account | type | offered ATM deposit? | outcome |
|---|---|---|---|
| Checking | checking | yes → interstitial | **gap** |
| Family Checking | checking | yes → interstitial | **gap** |
| Signature Visa | credit-card | no | covered |
| American Express | credit-card | no | covered |

**The 2 covered accounts were precisely the 2 credit cards** — the accounts that
get no ATM-deposit offer. Both checking accounts hit the interstitial; both
credit cards exported normally. That is the whole of the 2-of-4 gap. Captured
live 2026-07-14 in the connector's own page artifacts (URL + title).

Note also: `pdf_template_unknown` is a *separate*, much smaller skip on the
statements→PDF path. It is NOT the cause of the 2-of-4 transactions gap, and
chasing it would have fixed nothing.

**Fix:** navigate through the offer once, using the interstitial's own `goto`
param when it names a USAA account-detail route (off-host or wrong-section
`goto` values are refused, so a redirect chain cannot steer the connector).
Session death is re-checked *after* the hop, because an offer page can itself
bounce to logon — that must surface as session-dead (which triggers re-auth),
never as a missing affordance.

**Watch for:** other banks doing the same thing. A promotional interstitial in
front of an account page is a generic pattern, and the failure mode it produces
— "the source changed its UI" — is maximally misleading.

## D2 — a gap-opening path with no gap-closing path (general defect class)

USAA `statements` simultaneously reported:

- stream fact: `covered 10 / considered 10, checkpoint: committed`
- gap table: **4 rows still `pending`**, three with `attempt_count = 0`

Both readings were current. They disagreed because the four "pending"
statements were not missing at all — every one has a durable `pdf_sha256` on its
record. They had been downloaded.

### The class

A pending detail gap leaves `pending` **only** on an explicit
`DETAIL_GAP_RECOVERED` (`connector-detail-gap-store.ts`). Nothing closes one
implicitly: not a later success, not a full-coverage `DETAIL_COVERAGE`, not a
committed checkpoint.

USAA emitted that message for `transactions`
(`recoverServedAccountTransactionGaps`) and for both credit-card streams —
**but never for `statements`**. So the first statement PDF that ever failed to
download opened a gap that no subsequent run could close, however many times it
succeeded afterwards. Three of the four were never even re-attempted.

> **The general shape: any stream with a gap-OPENING path but no matching
> gap-CLOSING path accumulates permanent false gaps.** It is silent — the stream
> looks fully collected on every axis except the gap table — and it is
> self-inflicted, needing no source misbehavior at all.

**Worth auditing across every connector**: for each stream that can emit
`DETAIL_GAP`, confirm a `DETAIL_GAP_RECOVERED` path exists and is reachable.
The asymmetry within a single connector (USAA had closers for 3 streams and not
the 4th) suggests these are added per-stream as each is built, so the omission
is easy to repeat.

**Fix:** `emitStatementCoverage` now emits recovery for each served gap whose
statement is hydrated this run, driven by `coverage.hydratedKeys` — the same set
that feeds the coverage numerator, so recovery and coverage cannot drift apart.

## D3 — Gmail `message_bodies` has no denominator: PROHIBITED, not unimplemented

Definitive answer to the owner's direct question ("are you sure it's not
possible?").

`manifests/gmail.json` declares `message_bodies` with `state_stream: "messages"`,
making it a **static single-parent detail stream** whose checkpoint status is
projected from the parent's own commit outcome. `runtime/index.ts:1514`
(`validateDetailCoverageAgainstManifest`) **throws and fails the entire run** if
such a stream emits `DETAIL_COVERAGE`. This is not a missing feature; emitting a
denominator is an error.

The owner's reasoning is sound but lands one level off. The message count *is*
knowable — but it is the **parent's** number. Reporting it under
`message_bodies` would assert `covered == considered` for bodies that were
skipped or whose fetch failed. A real denominator would require a per-key
hydration tally, which this stream does not produce.

`attachments` is the instructive contrast: it has no `state_stream`, and it
earns coverage from a genuine attempt-per-key tally — which is exactly why it
is permitted to emit at all.

Already corrected in-tree (`cfe738071`); live evidence shows `collected: 4,
checkpoint: committed` with no fabricated coverage.

## D4 — Gmail `attachments` "won't backfill": a forged impossibility proof

The 32 terminal `too_large` gaps are **all collectible**. None is genuinely
oversized.

Gmail's hydrator briefly sized attachments from imapflow's `meta.expectedSize`,
populated from the FETCH `RFC822.SIZE` item — the size of the **entire message**,
identical for every part of a multipart message. Against a per-part cap this
condemned every attachment of a message whenever their SUM crossed it.

The durable signature, straight from the rows:

| claimed "observed" | sum of that message's parts | largest single part |
|---|---|---|
| 32,229,094 | 32,218,046 | 7,711,218 |
| 30,062,404 | 30,051,218 | 8,709,138 |
| 29,830,196 | 29,800,496 | 10,947,340 |

32 gaps, only **7 distinct claimed sizes** (real per-part sizes are never
byte-for-byte identical across distinct attachments); every claim ≈ the sum of
its message's parts; the smallest condemned item is **3,080 bytes** against a
26,214,400-byte cap.

The connector was fixed (`1bf3f6cfa`, per-part BODYSTRUCTURE size), but the rows
already written stayed terminal, and `isProvenUnfillableGap` reads
`observed > limit` as durable per-item proof — so the false verdict outlived the
defect that produced it.

> **Transferable lesson: a durable "proof" is only as good as the measurement
> behind it.** `too_large` was treated as unfalsifiable because a size beats a
> retry count as evidence. But the number itself came from a buggy source, and
> nothing re-checked it against the item's own recorded size. Any terminal state
> justified by a recorded measurement should be falsifiable by independent
> evidence.

**Fix:** `classifyTooLargeProof` adjudicates a row against the item's OWN size —
requeue only on positive contradiction (`fabricated_proof`); keep terminal for
`proof_holds`, `no_corroborating_record`, and `not_a_size_proof`. Absence of
contradiction is not proof of fabrication.

Repair tool: `scripts/repair/requeue-fabricated-too-large-detail-gaps.ts`
(gmail/attachments-locked, dry-run by default).

**APPLIED 2026-08-22** to `cin_12407c1afb78d56848fe0b20`, with backup table
`gmail_gaps_backup_20260822034236` (32 rows):

| | before | after |
|---|---|---|
| `recovered / temporary_unavailable` | 10,236 | 10,240 |
| `terminal / too_large` | **32** | **0** |
| `terminal / quarantined` | 3 | 0 |
| `pending / temporary_unavailable` | 0 | 31 |

All 32 adjudicated `fabricated_proof` (0 `proof_holds`, 0
`no_corroborating_record`). The 3 `quarantined` rows went through the existing
allowlisted tool in the same pass. **Zero terminal gaps remain.**

Recovery is confirmed real, not hollow: within a minute, 4 of the 32 had already
moved to `recovered` with `hydration_status: hydrated` and content-addressed
blobs (2,248 / 13,162 / 220,273 / 1,970,646 bytes) — every one far under the cap
it had been condemned against. So the requeued gaps ARE picked up by the ordinary
recovery path; this is not the D2 defect class inverted.

Each requeued row carries an audit trail
(`class: "too_large_proof_contradicted"`) recording the claimed size, the cap,
and the item's real size, so the repair is legible in the row's own history.


## Operational: a repair CLI that silently misread its own arguments

Found while applying the D4 repair. `--reason too_large` (space-separated)
parsed as `reason = "true"`: the parser read a value only from `--key=value` and
substituted the boolean `true` otherwise. The operator saw

    --reason='true' is not requeueable (allowed: quarantined, ...)

naming a value they never typed. The refusal was correct — `too_large` IS
refused by that tool by design — but the message pointed at the wrong thing, so
the tool looked broken in a different way than it was, and the real routing
(use the adjudicating tool) stayed hidden.

Both repair CLIs now accept `--flag value` and `--flag=value`, and REFUSE a
value-taking flag given no value rather than defaulting. Defaulting is what
produced the defect; failing closed is the only safe reading of an ambiguous
argument list for a tool that writes to production.

> **Worth checking in other operator tooling:** the `--key=value`-only parser
> with a `true` fallback is a common hand-rolled shape, and it fails silently
> and specifically on the argument form most operators type first.
