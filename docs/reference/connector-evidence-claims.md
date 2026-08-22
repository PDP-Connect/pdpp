# Connector Evidence Claims

This document defines the vocabulary connectors use to describe what has been established about them, and what has not. Keep it open when generating evidence metadata, reviewing a publish, or writing anything that touches connector status.

## Purpose

"Verified" is banned as a connector status word. The word hides at least four different propositions — that a connector speaks the protocol correctly, that it correctly processed one real interaction, that it contacted the provider on some date, and that it works against the provider right now — and collapsing them into one word is how verification labels rot. WHOOP shipped with a live-run claim that was prose in a PR comment and passed every automated gate anyway, because no gate tested provider contact. A single word cannot carry four different guarantees without eventually being read as the strongest one.

The fix is to report claims separately. Each claim below is machine-readable, dated where it applies, and asserted or withheld on its own — never merged into a composite score or a bronze/silver/gold rung. A connector can legitimately show three claims passing and two withheld; that is an honest status, not a partial failure. Labels are written by tooling from observed evidence, not typed by connector authors, so a claim can never be stronger than what actually produced it.

## Functional evidence claims

Five claims describe what a connector has been shown to do. They stack in the sense that later claims are harder to obtain, but they are reported independently — passing one does not imply another.

| Claim | Definition | What establishes it | What it does NOT establish | Who can assert it |
|---|---|---|---|---|
| `protocol_conformant` | The connector speaks the Collection Profile correctly: manifest shape, process state machine, JSONL message contract. | Wire/conformance tests run against the built package. | Provider compatibility. A connector can be perfectly conformant and never successfully contact a real provider. | Tool only. |
| `recorded_replay` | The connector correctly processes a specific, dated, recorded provider interaction. | Black-box replay of a connector-verification scenario against the connector source bound by declaration and source-tree digests. (Binding to the built distributable package arrives with the publication pipeline; until then the claim binds source, and says so.) | That the provider still behaves this way. Replay proves faithful reprocessing of the past, not current compatibility. Replay's network denial covers the connector process (fetch, http/https, raw sockets) and — where OS namespace isolation is available — its descendants; when only process-local denial is active, the status says `network isolation: process-local only`. | Tool only. |
| `author_live` | The connector contacted the real provider successfully, on a specific date, from the author's own account. | **Withheld by all current tooling.** Establishing it requires tool-observed contact matching a per-connector provider-authority policy (accepted origins), which is designed but not built; today's recorder proves only `non_loopback_contact_observed` (any remote endpoint qualifies — a synthetic server or proxy would pass), and `connector-dev` observes protocol output, not network authority. No tool prints this claim until the authority policy exists. | Independent verification. The author's own run is not checked by anyone else. | Tool only (the run is tool-generated; the author supplies the account). |
| `independent_live` | The connector contacted the provider successfully, on a specific date, verified by a second party with their own account. | A live run performed and reported by someone other than the author. | Future behavior. A pass today says nothing about tomorrow. | Second party. |
| `scheduled_live` (future tier) | The connector is currently working, within a defined monitoring window. | A recurring, scheduled live probe against the provider. | Anything outside the probe window — universal account coverage, data-shape coverage, or behavior for accounts unlike the probe account. | Tool only, on a schedule. |

`protocol_conformant` and `recorded_replay` can be established with no provider account at all. `author_live` and `independent_live` require an account. `scheduled_live` is not built in v1; the evidence format is designed so it can be added later without redefining the other four.

## Disclosure classes

Disclosure is orthogonal to functional evidence. A connector can have strong functional evidence and still disclose nothing publicly — evidence generation is default-on, but sharing is always explicit opt-in, never default.

| Class | Definition | What may leave the author's machine |
|---|---|---|
| `local_only` | Evidence exists only on the author's machine. | Nothing. No artifact, summary, or count is published or sent to a reviewer. |
| `private_reviewer` | Evidence is shared with a trusted maintainer or reviewer, not published. | Raw or lightly-redacted evidence, sent to a specific named reviewer under the same handling rules as personal data. Not public. |
| `public_synthetic` | Evidence is published, built from synthetic (non-real) data. | Synthetic request/response pairs and outputs. No real personal data of any kind. |
| `public_derived` | Evidence is published, derived from a real run but transformed before publication. | Derived fixtures: real structure and behavior, with real values replaced or generalized. Never pattern-preserving for pattern-identifying classes (see below). |
| `public_scrubbed_real` | Evidence is published, built from a real run with deterministic and LLM-assisted redaction applied. | Scrubbed real records: real shape and largely real values, with credentials, identifiers, and sensitive fields removed or replaced. Prohibited outright for the sensitive classes listed below. |

A connector's status can honestly read "local-only evidence, replay pass, author-live 2026-08-13, independent-live not available." That is a complete, publishable status — not a placeholder for something better later.

## Recency fields and the aging rule

Two fields track how current a claim is:

- `captured_at` — when the underlying scenario or artifact was recorded.
- `live_verified_at` — when a live claim (`author_live`, `independent_live`, `scheduled_live`) was last confirmed.

The aging rule has two halves, and they do not share a threshold:

- **Replay scenarios never expire as regression evidence.** A `recorded_replay` pass from a year ago is still a valid regression signal — it proves the connector still processes that dated interaction correctly. Its age is always displayed alongside the claim, so a reader can judge staleness themselves, but the claim itself does not lapse.
- **Live claims age separately and independently.** `author_live` and `independent_live` are claims about a specific date, not standing facts. Their age is displayed the same way, but nothing here defines a global cutoff after which a live claim becomes invalid.

There is no universal freshness threshold in v1. A stable public API and a scraped browser session age at different rates, and picking one number for both would be arbitrary. Source-specific live-check policies are left for a later support tier once real aging data exists.

## Scenario-coverage flags

A `recorded_replay` claim carries flags describing which behaviors the underlying scenario actually exercised. These are not pass/fail on their own — they scope what the replay pass means.

| Flag | What it covers |
|---|---|
| `empty_state_run` | A run from empty state with real interactions and expected records. (Renamed from `full_refresh`: the producer does not prove every declared stream was exercised or accounted for, so the flag names only what it observes.) |
| `state_seeded_second_run_with_changed_requests` | A later run seeded from an earlier run's non-trivial committed state whose recorded requests differ. (Renamed from `incremental_two_run`: this proves state seeding changed request planning — not overlap handling, duplicate suppression, or safe failure behavior, which need dedicated scenario fixtures.) |
| `pagination` | Multi-page responses and page-to-page continuation. |
| `retry` | Recovery from a transient failure (rate limit, timeout, transient server error) within a run. |
| `partial_failure` | Recovery when part of a run fails without over-advancing committed state. |
| `auth_reuse` | Reuse of an existing authenticated session across requests or runs, without re-authenticating live. |

A connector with only `empty_state_run` coverage has a narrower, honestly-scoped replay claim than one with all six flags set. Coverage flags are reported, not averaged into a single score.

Producer status (kept honest, per this document's own rule): today's tooling computes `empty_state_run` and `state_seeded_second_run_with_changed_requests` under exactly the conditions their names state, and captures/compares the normalized protocol trace — SKIP_RESULT with continuation evidence, DETAIL_COVERAGE, DETAIL_GAP with digested locator/pressure evidence, DETAIL_GAP_ATTEMPTED/RECOVERED, DETAIL_GAPS_PAGE_REQUEST, and terminal DONE semantics — under a compile-time-exhaustive policy over the runtime message union: a new message kind cannot be added without being dispositioned, and a run exercising an unsupported evidence surface (ASSISTANCE) has the canonical replay claim withheld. The remaining four flags — `pagination`, `retry`, `partial_failure`, `auth_reuse` — are defined vocabulary with **no producer yet**; nothing sets them, and any status displaying them before a producer exists is lying. They arrive with fault-variant scenarios.

Exactness note: `derived-from-real` is NOT currently produced by any tool. Captures with observed remote contact earn `non_loopback_contact_observed` — the exact observed fact — because any remote endpoint (a synthetic server, a proxy) satisfies the observation. `derived-from-real` becomes producible only when a per-connector provider-authority policy (accepted origins) exists to check contact against.

## Provenance classes

Every claim also carries a provenance class describing where the label came from:

- `tool_generated` — produced mechanically by tooling from an observed run or replay, with no author input into the label text.
- `author_asserted` — a claim the author states but that tooling cannot independently observe (used sparingly; prefer `tool_generated` wherever possible).
- `independently_observed` — produced by a second party's tooling-generated run, not the author's.

Labels are written by tooling, never typed by authors. An author does not get to write "author-live: pass" in a manifest or PR description; the `dev`/run-and-watch command generates that line from an actual run. Enforcement today: the fixture-provenance test suite requires every pilot fixture set to carry a tool-written provenance label of valid shape, and `scenario-record` computes `evidence_class` from observed provider contact rather than accepting an author-supplied value. A fuller CI lint — cross-checking every displayed label against the evidence artifact that must have produced it — is designed but not yet built; until it exists, that check is review discipline, not a gate. This is what keeps the WHOOP failure mode — a real live run reduced to unverifiable prose — from recurring.

## Sensitive-class defaults

Health, biometric, financial, messages, location, and contacts connectors default to `local_only` or `private_reviewer` disclosure. An author must take an explicit, separate action to move evidence for these classes to any public disclosure class.

Pattern-preserving scrubbed recordings are prohibited for pattern-identifying classes — the classes above, plus any stream where record counts, timing, or category distribution could identify the author or people connected to them. The reason: for these classes, the pattern *is* the fingerprint. Redacting a value while preserving its shape (a constant timestamp shift, a token-for-token substitution) still preserves cadence, weekly structure, counts, and distributions, and those are frequently as identifying as the redacted values themselves. Scrubbing a body but leaving 340 messages sent every weekday between 9pm and 11pm intact does not protect the author.

Before any evidence artifact is shared beyond the author's machine — `private_reviewer` or higher — a mandatory third-party-data check runs first. An author's export routinely contains other people who did not consent to appearing in it: message senders, calendar attendees, transaction counterparties, contacts. This check is not optional and is not satisfied by the author's own consent alone.

All shared evidence, at every disclosure class above `local_only`, is pseudonymized personal data in the GDPR sense. It is never described as anonymized. Pseudonymization reduces risk; it does not remove the data from personal-data handling obligations, because it can still be linked back to an individual — directly through retained structure, or indirectly through pattern.

## What no combination of claims ever means

No combination of the claims above, at any coverage or disclosure level, ever means:

- **That the connector works against the provider right now.** Even `scheduled_live`, when it exists, only covers its probe window and probe account — not every account shape, not the exact moment a reader looks at the status.
- **That the provider hasn't changed since capture.** `recorded_replay`, `author_live`, and `independent_live` are all claims about a specific date. Providers change endpoints, response shapes, and auth flows without notice, and no claim here detects that on its own.
- **That a recording proves the semantic correctness of the mapping.** This is the candidate-oracle rule: a recorded scenario is generated by the same connector implementation being evaluated. If the connector maps a field wrong, drops a nested value, or mislabels a timestamp, replay of that recording reproduces the bug faithfully rather than catching it. A `recorded_replay` pass proves the connector processes that dated interaction the same way it did when captured — not that the processing was correct in the first place.

## Lifecycle

A scenario starts as a **candidate oracle**, not a trusted one. It was produced by the implementation under test, so by default it can only prove regression safety and faithful reprocessing — not that the original mapping was right.

Promotion from candidate to a scenario that can support stronger claims requires, proportionate to what will be shared or relied on:

- **Declaration-to-output coverage** — every declared stream in the scenario is exercised by a run, or explicitly marked skipped. A stream the scenario never touches cannot be silently assumed correct.
- **Negative controls** — the scenario is deliberately broken (a mapping altered, a request corrupted) and replay is confirmed to fail. A scenario that cannot fail is not evidence of anything.
- **Human mapping review, when evidence is shared** — a person checks the response-to-record mapping by hand before the scenario supports any disclosure class above `local_only`. This is the step that catches what the connector's own code cannot catch about itself.

A scenario that has not gone through this lifecycle can still back a `recorded_replay` claim for local regression use. It cannot back a claim that leaves the author's machine, and it never backs a claim of semantic correctness regardless of disclosure class.
