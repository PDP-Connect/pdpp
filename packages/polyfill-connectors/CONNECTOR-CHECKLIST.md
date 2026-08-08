# Connector checklist

What a connector must satisfy to reach each evidence level, and the exact
command that proves it. Modeled on Home Assistant's Integration Quality
Scale: per-rule, machine-checked where a check can exist, an explicit
written exemption where it can't — never a silent skip.

Run `node --import tsx scripts/conformance.ts <connector>` first. It runs
every check below in order and prints the specific next action for
anything that isn't PASS. This document explains what those checks mean
and what promotion between levels requires beyond them.

**Promotion between levels is a human decision, not automatic.** A PASS on
every mechanical check means "nothing mechanical is wrong" — it does not
mean the connector works against a real account. Only an operator running
it against a real account, once, proves that. `conformance` composes
evidence; a human still edits the manifest's `public_listing.status`.

## Level 1 — scaffold

The floor. A connector directory exists and the runtime can start it, even
if it only emits `SKIP_RESULT`.

| Rule | Check |
|---|---|
| Manifest exists, declares ≥1 stream | `conformance <connector>` → `manifest` step |
| Connector directory + entry point exist | `conformance <connector>` → `tests` step |
| If not yet collecting, listed in `KNOWN_SCAFFOLD_CONNECTORS` (`src/connector-conformance-roster.ts`) and `public_listing.listed: false` | manual roster edit — `connector-conformance.test.ts` enforces the two stay consistent |

## Level 2 — unproven (real collector, unverified against a live account)

Real collection logic exists — no unconditional `SKIP_RESULT`. This is
where most of this repo's connectors sit today.

| Rule | Check |
|---|---|
| Test file exists and its suite passes | `conformance <connector>` → `tests` step |
| Emitted records validate against `schemas.ts` | covered by the connector's own test suite via `validateRecord` |
| Roster entry in `PRODUCTION_READY_CONNECTORS` or `REAL_UNLISTED_CONNECTORS`, `testFile` points at a real test | `connector-conformance.test.ts` |
| Manifest `public_listing.status: "unproven"` (or `needs_human_auth` if it needs an interactive login) | manual — this IS the honesty claim, not machine-derived |

## Level 3 — path-verified (unproven + independently sourced evidence the code hits the right endpoint)

The level this task's work targets. Two independent, non-mock sources of
evidence, neither authored by the connector's own author in the same
sitting as the code:

| Rule | Check | Applies to |
|---|---|---|
| Reachability probe target defined and green (no `WRONG_PATH`) | `node scripts/connector-reachability.mjs` — see `conformance`'s `reachability` step for whether one exists | connectors with a fixed public API base and an unauthenticated-probeable endpoint. Browser-automation-only and file-import-only connectors are **permanently exempt** — say so in the connector's own header comment, not a silent gap |
| Mock-mutation verdict is `PASS` (every path literal in the test suite is load-bearing) | `node --import tsx scripts/mock-mutation-check.ts --connector=<connector>` — see `conformance`'s `mock mutation` step | any connector with a path-asserting mock. A connector with zero HTTP surface reports `UNKNOWN` here permanently and correctly — that is not a gap to close |
| Pilot fixture present, locks emitted shape against drift | `conformance <connector>` → `pilot fixture` step (looks for `fixtures/<connector>/scrubbed/pilot-real-shape/`) | any connector that makes network/file calls; captured via `PDPP_CAPTURE_FIXTURES=1` against a real account, then the `scrub-connector-fixtures` skill |

**Exemption rule:** if a connector genuinely cannot be reachability-probed
(browser-automation against a login wall, no fixed public endpoint — e.g.
Amazon, Chase, USAA) or has no HTTP surface at all (file-import — e.g.
WhatsApp, Google Takeout), write that reason in the connector's own header
comment and in `docs/inbox/report-connector-coverage.md`'s classification
table. `UNKNOWN` with a written reason is a legitimate resting state, not a
failure to fix later.

## Level 4 — proven (a real account run has recorded real data end-to-end)

| Rule | Check |
|---|---|
| An operator ran this connector against their own real account and it collected real data with no errors | no automated check exists or ever will — this is the Jellyfin-class limit: only a live run proves a live provider actually serves what the code expects |
| Manifest `public_listing.status: "proven"` | manual — a deliberate human edit after the run above, never inferred |

## Anti-patterns this checklist exists to prevent

- **Writing a mock to pass the mock-mutation check.** A mock authored by
  the same person, in the same sitting, as the code it mocks can share the
  code's own misunderstanding — see
  `docs/inbox/design-note-connector-conformance.md`. `mock-mutation-check`
  proves a mock is *load-bearing*, never that it's *correct*. Only the
  reachability probe (a real request to the real provider) or a real
  account run can prove correctness.
- **Treating `UNKNOWN` as a bug to silence.** For most connectors in
  categories with no HTTP surface, `UNKNOWN` on reachability and
  mock-mutation is the permanently correct answer. Read
  `docs/inbox/report-connector-coverage.md`'s (a)/(b)/(c) classification
  before assuming a connector's `UNKNOWN` is fixable.
- **Bumping `public_listing.status` because every mechanical check went
  green.** It doesn't mean the connector works. It means nothing
  *mechanical* is wrong. Promotion needs a real run.
