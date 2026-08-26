# Surfacing a shrinking upstream disclosure window

**Status:** intake. Not an OpenSpec change; no requirement is proposed yet.
**Date:** 2026-08-17

## The observation that prompted this

PDPP holds two H-E-B orders for the owner, both captured in the same scan on 2026-07-15:

| id | date | status | total |
|---|---|---|---|
| `HEB20169324473` | 2023-08-09 | Order canceled (`SHORTED`) | $293.98 |
| `HEB20607368035` | 2023-08-19 | Delivered | $382.67 |

H-E-B now displays only the second one to that account.

The owner's inference is the load-bearing one: **PDPP scrapes what the account UI shows, so if it
captured the first order, H-E-B was showing it then.** The record did not move. The provider's
disclosure did.

That is the product working exactly as intended — PDPP holds data the provider no longer surfaces.
But the app cannot say so. Its dashboard shows "2 orders" today and would show "2 orders" after a
fresh run that finds nothing. Something important happened and the product is silent about it.

For a tool whose purpose is outrunning deletion, "the source is disclosing less than it used to"
is not noise. It is the alarm.

## What the system already has

- Per-source checkpoint: `{"checkpoint": "2023-08-19", "fingerprints": {...}}`
- `fetched_at` on every record
- Scan-termination reasons in the H-E-B connector distinguishing `pagination_exhausted` from
  `selector_drift`, `pagination_metadata_absent`, `source_auth_or_challenge`
  (`packages/polyfill-connectors/connectors/heb/index.ts:320-335`)

What is missing is durable evidence of *why a scan stopped* and *how far back it reached*. For
`cin_c875ca3ec8b6ce2c283a4288` no such evidence was stored, and there is no run history at all —
so today we cannot distinguish "H-E-B showed us everything" from "we hit a wall."

## The proposed primitive: an observed boundary, not availability

Per successful run, one value: **the oldest item the provider displayed**, recorded only when the
scan proves it reached the end of its range. Comparing across runs yields a moving frontier.

The product could then say something entirely factual:

> H-E-B showed orders back to 2023-08-09 in July 2026; today it goes back to 2023-08-19.
> 1 stored order is no longer displayed.

Every clause is an observation. The conclusion — *their retention window is closing* — is the
owner's to draw, and they can draw it, because they know whether they shopped in 2024.

## Hard constraints

**1. A moving boundary is information about the provider, never an annotation on a record.**
This is the one absolute. Nothing in this design may mark a stored record deleted, stale, or
suspect. Deliberately: no connector in the fleet emits deletions today — verified, zero occurrences
of a delete/tombstone emission across `packages/polyfill-connectors/connectors/` — so provider
erasure structurally cannot propagate into the owner's copy. Introducing a path that annotates
records based on absence would give that up for a signal that is frequently wrong.

**2. Absence is evidence only when the scan proves it covered the range.**
A run ending `pagination_exhausted` makes absence meaningful. A run ending `selector_drift` or
`source_auth_or_challenge` makes it meaningless. Without a stored termination reason there is no
signal, and the correct output is "unknown."

**3. Do not encode provider retention policies.**
"H-E-B keeps 18 months" is undocumented, changes silently, and varies by account and region. A
wrong constant produces confident lies. The empirically observed window is strictly better: it is
measured, not asserted, and it survives the provider changing policy without telling anyone.

## Edge cases that make a *general* solution hard

- **Silent auth degradation.** A session expiring into a logged-out-but-200 view returns no items,
  reports pagination exhausted, and yields a boundary of nothing — indistinguishable from a total
  purge. The nastiest false positive, and the reason constraint 1 is absolute.
- **Not every source has an ordering.** Contacts have no time axis. Notion pages are edited, so
  recency is not age. Gmail's "oldest visible" depends on the query. A single scalar frontier fits
  perhaps half the fleet and produces meaningless numbers for the rest.
- **Scope change mimics retention.** Leaving a Slack channel removes its history from view; a plan
  downgrade hides older data; a provider splitting history by store looks like shrinkage. No
  boundary comparison can tell these from deletion.
- **Retention is rarely uniform.** Amazon keeps orders but drops invoice PDFs; Slack's free tier
  hides messages but keeps files; Gmail retains mail but purges trash at 30 days. One per-source
  boundary cannot express "text kept, attachments gone," and per-stream boundaries multiply the
  connector burden.
- **Imports have no upstream.** Google Maps and the WhatsApp exports are one-shot files. They need
  to be first-class *not applicable*, not zero — the same failure this codebase already has with
  "Not measured" (see `add-honest-uncollected-source-states`).
- **Contiguity assumptions are false.** "Orders are sequential, so a gap means deletion" breaks on
  a month with no shopping. The owner's own H-E-B data is two orders ten days apart and then
  nothing — a gap that is a fact about their life, not their provider.

## Recommended shape

**Opt-in per connector, not a universal contract.** Connectors with a genuine monotonic frontier
and a provable pagination stop — orders, transactions, messages — report a boundary. Everything
else reports nothing, and nothing is fine. A signal present on eight connectors and honest beats
one present on twenty-four and wrong.

**Runtime owns the bookkeeping.** The author declares the scanned range and the termination reason;
the runtime derives the boundary and its movement. A connector must never assert that something is
gone.

**Fail closed.** No termination reason means no boundary claim. A lazy or broken connector produces
"unknown," never a false purge.

**Machine reports, human interprets.** State the observation; leave the conclusion to the owner.
That is not a cop-out — it puts the inference where the context actually lives. The owner knew
instantly that PDPP could not have collected an invisible order; no rule authored here would have
encoded that.

## Honest caveat on feasibility

This is reasoned from one connector and a day of code reading. The fleet has not been surveyed for
how many connectors could actually satisfy constraint 2. Today's evidence argues for pessimism:
Slack emitted duplicate coverage for every multi-archive run since inception, and a Codex source
was rendered unmeasurable by a single stale store name. If the existing, simpler coverage contract
is unevenly met, a boundary contract will be too. Expect "unknown" from a meaningful fraction of
the fleet for a long while — and prefer that to false confidence.

## Relationship to existing work

Same failure shape as several open items: a derived value that goes quietly stale because nothing
watches whether its source changed. Compare `add-projection-contract-versioning` (input checkpoints
cannot see a formula change), `make-local-coverage-tolerate-unexpected-stores` (a stale store name
discards a valid proof), and `add-durable-connection-account-identity` (identity derived from a
provisional binding key). The recurring principle is worth stating once, somewhere durable:
**derive nothing durable from a value that may be provisional, and watch anything you do derive.**
