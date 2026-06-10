# Open question: debugging-leverage infrastructure for connector development

**Status:** open — some items to be implemented now, others deferred
**Raised:** 2026-04-19
**Trigger:** Debugging a single Gmail connector crash took 8 iterations over 90 minutes. Each iteration cost ~1.5 minutes of IMAP warm-up to reach the crash boundary. The stdout-JSONL protocol is opaque: errors surface as "connector emitted invalid JSONL at position 1651 line 1" without the actual line. Each new instrumentation required editing connector code and waiting for another full run.

Several connectors in today's fleet (Gmail, ChatGPT, USAA, Slack) have had hours of debugging that similar infrastructure could have cut to minutes. This pattern will repeat every time we fix a bug or add a connector.

## What we're missing

The JSONL-over-stdio protocol is **correct** — this isn't a spec issue. But the reference implementation and tooling around it make debugging harder than it should be:

1. **No persistent message-stream recording.** Runtime reads lines from connector stdout; if a parse fails, the offending bytes are lost. Debugging requires hand-adding logging to the runtime or the connector.
2. **No offline replay.** A bug reproducing only against a live API (Gmail IMAP, ChatGPT backend) means each iteration pays the full network + auth cost.
3. **No fixture-based smoke tests.** A connector typo (missing import, missing await, undefined identifier) fails only during a real run — my ChatGPT `sendInteractionAndWait is not defined` bug surfaced only after a 30-second run warmup.
4. **No manifest↔data consistency checker in CI.** The Layer 1 audit script exists (see `scripts/audit_polyfill.py`) but isn't wired to run automatically. Drift discoveries are manual.
5. **Runtime error reporting omits the failing bytes.** "invalid JSONL at position 1651" doesn't include the 1651 bytes leading up to the failure.
6. **Spine events capture outcomes but not inputs.** When a run fails, we see what happened but not what was being processed.

## Infrastructure to add, in priority order

### 1. Message-stream recorder (P0, small)
Runtime writes every received line to `.pdpp-data/runtime-traces/<run_id>.jsonl` before parsing. On crash, the file is inspectable with `jq` + `less`. Adds 5 lines to the runtime; saves 80% of ad-hoc logging.

### 2. Connector-output tee (P0, small)
Optional mode `PDPP_TRACE_CONNECTOR_OUTPUT=/tmp/connector-trace.jsonl` that tees the connector's raw stdout before the runtime consumes it. Lets us see exactly what the connector tried to emit, separate from what the runtime saw. Works with (1) to diff sent-vs-received.

### 3. Fixture-driven connector smoke tests (P1, medium)
Each connector ships a `test/fixtures.json` with known-good synthetic input data + a golden-output snapshot. `npm run smoke:<connector>` pipes fixtures into the connector, compares output. Runs in <1 second. Catches typos/syntax errors before live runs.

### 4. Offline runtime replay harness (P1, medium)
Tool that takes a recorded `runtime-traces/*.jsonl` from (1) and replays it against the runtime's ingest/validation logic. Deterministic, fast, no network. Isolates "connector bug vs runtime bug."

### 5. Runtime error reporting includes offending bytes (P2, small; spec-adjacent)
When emitting "invalid JSONL" or "protocol violation," attach 200 chars of context before/after the failure point in the error message + spine event. Spec clarification: **runtimes SHOULD capture the offending bytes and MUST capture the byte offset.**

### 6. Live manifest↔data consistency check (P2, medium)
The Layer 1 audit script runs on every new ingest (or on a schedule) and surfaces problems in the dashboard's data-health view automatically. Turns the one-time audit into a continuous signal.

### 7. Connector-sandbox dashboard page (P3, medium; depends on #6)
Live spine-event tail. Per-stream "why is this null?" navigation. Converts hidden DB issues into visible artifacts. Serves both engineer and LF-reviewer audiences (**honest reference**).

## What to implement now vs. later

**Implement now** (alongside this note):
- (1) message-stream recorder — adds `runtime-traces/*.jsonl` on every run, controlled by env var
- (2) connector output tee — same as above, opt-in

With these two alone, the Gmail debugging loop drops from ~2 minutes per iteration to ~30 seconds (inspect file, form hypothesis, try again).

**Deferred until next session:**
- (3), (4) — fixture tests + replay harness, as a ~2-hour focused build
- (5) — proposed as a minor spec clarification; coordinate with reference-implementation owner
- (6), (7) — dashboard-level improvements, after data is pristine

## Why this matters for the spec audiences

- **Engineers evaluating adoption** — the debugging story materially affects whether they'll use PDPP. If their first bug takes 90 minutes, they'll leave.
- **Linux Foundation reviewers** — a spec whose reference implementation has no debugging infrastructure looks unserious. Deterministic replay + recorded traces are audit-grade tooling.
- **the owner (owner of the reference)** — faster iteration means more features, fewer bugs, and the owner spending less time in detective mode.

## Cross-cutting

- `raw-provenance-capture-open-question.md` — recording runtime traces is a close cousin to "raw capture" but at a different layer (protocol bytes, not upstream responses).
- `layer-2-completeness-open-question.md` — fixture smoke tests force a connector author to articulate what "complete" looks like.
- `connector-configuration-open-question.md` — per-connector test harness is yet another place where `options_schema` would clarify what's under test.

## Action items

- [x] Implement (1) + (2) in the reference runtime with env-var opt-in
- [ ] Re-run Gmail with tracing; find the actual offending bytes; fix root cause
- [ ] After ingest backlog clears: (3) fixture smoke tests for all connectors
- [ ] After (3) lands: (4) offline replay harness
- [ ] Raise (5) with reference-implementation runtime owner as a spec clarification
- [ ] (6) + (7) as dashboard upgrades once data is pristine
