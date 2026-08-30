# Connector Verification Workflow

This guide is for connector authors who need to run and prove out a connector locally, without reading the source. Keep it open while developing or debugging a connector's `collect()` behavior.

It covers three commands that form one loop: `connector-dev` (watch a connector run), `scenario-record` (capture what it did against your real account), and `scenario-verify` (replay that capture offline and check it still matches). The vocabulary these commands use — `recorded_replay`, `author_live`, coverage flags, disclosure classes — is defined in [`connector-evidence-claims.md`](./connector-evidence-claims.md). Read that document for what each claim does and does not establish; this guide only covers how to run the tools that produce the evidence.

## The loop

### 1. Run and watch — `connector-dev`

```
pnpm exec tsx bin/connector-dev.ts <connector>
pnpm exec tsx bin/connector-dev.ts ynab
pnpm exec tsx bin/connector-dev.ts gmail --summary-out /tmp/gmail-run.json
```

Spawns the connector's own entrypoint exactly the way production does, and streams every `RECORD`/`STATE`/`SKIP_RESULT`/`PROGRESS`/`INTERACTION` message live as it arrives. Auth is resolved from your environment, same as production. Nothing is persisted to a Record Store; this is a local dev loop for watching one connector's behavior against its real upstream, not an end-to-end ingest proof.

If the connector prompts mid-run (OTP, manual action), `connector-dev` renders the prompt in the terminal and sends your answer back; non-interactive runs supply answers with `--answer <id-or-index>=<value>` or `--answers <file>`, and fail loudly naming the prompt when no answer is available.

When the run finishes, it writes a mechanically-generated run summary to `runs/<connector>/<timestamp>-summary.json` (or the path given to `--summary-out`) and prints per-stream record counts, `state_emitted`, and `latest_record_emitted_at`. (Those names are deliberate: no Record Store durability path runs here, so nothing is "committed," and `emitted_at` is connector processing time, not source freshness.) This run summary backs an `author_live` claim **only when the run showed observed, non-loopback provider contact** — a run against a local stub can never earn it. A run that exits nonzero or emits protocol output after DONE is a failure even if DONE said succeeded.

### 2. Capture a scenario — `scenario-record`

```
pnpm exec tsx bin/scenario-record.ts <connector>
pnpm exec tsx bin/scenario-record.ts oura
pnpm exec tsx bin/scenario-record.ts oura --runs 1 --out /tmp/oura-run1.json
```

Runs the connector against your real account and real upstream, exactly like `connector-dev`, but with a preload that captures every HTTP request/response pair the run makes. By default it captures two runs: run 1 from empty state (full refresh), then run 2 immediately re-run seeded with run 1's actual committed state (incremental narrowing). Pass `--runs 1` to capture only the full-refresh run.

Mid-run INTERACTION prompts (OTP, manual action) are captured too: the prompt/response pairs ride the scenario and are replayed scripted by `scenario-verify`, so an OTP-gated flow regression-tests with no human present.

The result is a scenario file: `runs/<connector>/<timestamp>-scenario.json`. Its `evidence_class` is **computed, never asserted**: `derived-from-real` requires tool-observed non-loopback provider contact; a capture from a loopback provider or a dev entrypoint override is labeled `synthetic-spike` mechanically. The file also carries declaration and source-tree digests binding it to the connector that produced it. This capture is **local-only** — it may contain real response bodies from your account and must not be committed or shared without a scrub pass. It is also a **candidate oracle**: it was produced by the same connector implementation it will later be replayed against, so it can prove faithful reprocessing and regression safety, not that the original field mapping was correct. See "What the evidence does and does not establish" below.

### 3. Replay it offline — `scenario-verify`

```
pnpm exec tsx bin/scenario-verify.ts <connector> <scenario-path>
pnpm exec tsx bin/scenario-verify.ts oura runs/oura/2026-08-13T00-00-00-000Z-scenario.json
```

First validates the scenario strictly (incomplete captures, zero runs, malformed shapes, and identity/digest mismatches are rejected before anything is spawned), then replays every run against the real connector code. Network denial covers the connector process itself — `fetch`, `http`/`https`, and raw sockets are all intercepted — and, where OS namespace isolation is available, its descendant processes too; when only process-local denial is active the output says `network isolation: process-local only` (a spawned external client like `curl` is outside that boundary). It checks that the connector produces exactly the recorded streams (extra streams fail), the same records, ids, content hashes, and final state, emits valid protocol output only, ends with a single final DONE, and exits zero.

On a pass, it prints the claim and the coverage flags the scenario actually exercised, for example:

```
recorded_replay: PASS (captured 2026-08-13T00:00:00.000Z)
coverage: empty_state_run, state_seeded_second_run_with_changed_requests
```

If the scenario has a second run but that run's requests are identical to the first run's, `state_seeded_second_run_with_changed_requests` is withheld and a note explains why — see the honesty rule below.

## Artifacts

| Artifact | Where it lives | What it is |
|---|---|---|
| Run summary | `runs/<connector>/<timestamp>-summary.json` | Mechanically generated by `connector-dev`: per-stream record counts, `state_emitted`, `latest_record_emitted_at`, skips. Backs `author_live` only with observed non-loopback provider contact. |
| Scenario file | `runs/<connector>/<timestamp>-scenario.json` | Written by `scenario-record`. A `pdpp.connector-scenario/1` envelope (`src/scenario/format.ts`): every HTTP request/response pair a run made, plus what the run is expected to produce (per-stream record counts, ids, content hashes, and the final committed state). `verify.ts` replays it offline against the real connector and proves the two match. |
| `provenance.json` | `fixtures/<connector>/scrubbed/pilot-real-shape/provenance.json` | Labels a committed fixture's origin, e.g. `{"format": "pdpp.fixture-provenance/1", "class": "synthetic", "labeled_by": "tool:provenance-labeler/1", "labeled_at": "2026-08-13"}`. Distinct from `runs/` scenario files: fixtures here are the committed, scrubbed kind, not local captures. |

`runs/` is listed in `packages/polyfill-connectors/.gitignore` — it is local-only and never committed. Do not hand-copy a file out of `runs/` into a committed fixture without going through a scrub pass (see `scrub-connector-fixtures`).

## What the evidence does and does not establish

Full definitions live in [`connector-evidence-claims.md`](./connector-evidence-claims.md). Two rules to hold onto while using these commands:

**The candidate-oracle rule.** A scenario captured by `scenario-record` is generated by the same connector implementation `scenario-verify` later checks it against. If the connector maps a field wrong or drops a value, replay reproduces that bug faithfully instead of catching it. A `recorded_replay` pass proves the connector processes a dated interaction the same way it did at capture time — not that the original mapping was correct.

**The state-seeded-run honesty rule.** The `state_seeded_second_run_with_changed_requests` flag is only claimed when a scenario's second run was actually seeded from the first run's committed state *and* that second run's recorded requests differ from the first run's. Two runs existing is not enough — `scenario-verify` checks that state seeding observably changed request planning. If the requests are identical or the seeded state was trivial, the flag is withheld and the tool says why. The replay oracle also compares the normalized protocol trace (skips, coverage, gaps, terminal error semantics), so a change that silently drops completeness evidence fails replay.

## Current limitations

- **API-class connectors only.** The capture/replay mechanism patches the subprocess's `fetch`. Browser-navigation connectors (patchright/playwright-driven) do not route their traffic through `fetch` in a way this captures, so they stay on live verification. File-import connectors make no network calls at all and need no scenario.
- **Response bodies are stored verbatim.** Provider-issued values in request params are stored as bindings (references into the response that issued them) rather than raw values, and capture temp files live in a private `0700` workspace — but response *bodies* are persisted as received, minus a size cap. Keep scenario files local — this is why `runs/` is gitignored — and do not record connectors that exchange long-lived tokens in their response bodies yet.
- **Auth flows are not captured.** The recorder captures data-collection requests and mid-run INTERACTION prompts, not the login/token-exchange sequence. Auth is resolved from your environment before the run starts, the same way it is in production.
- **Descendant processes escape process-local network denial.** A connector that spawns an external network client (`curl`, a child interpreter) is only contained when OS namespace isolation is available; otherwise replay honestly reports `process-local only` isolation. Connectors that spawn network helpers should not be treated as replay-eligible under process-local isolation.
