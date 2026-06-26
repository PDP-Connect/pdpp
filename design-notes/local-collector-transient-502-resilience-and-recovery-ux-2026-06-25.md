# Local-collector transient-502 resilience + recovery UX

Status: requirements discovery (not yet an OpenSpec change).
Date: 2026-06-25.
Trigger: the owner's local `claude_code` collector (`dsrc_f23027f4ec365b1e`) accumulated **81 dead-letter
upload rows, all of error class `local device request failed: 502`**, and the owner was told (by tooling
output) to hand-run `npx @pdpp/local-collector recover --source-instance-id <id> --apply` to recover them.
The command worked (dead_letter 81 → 0; a subsequent scan collected 107,939 records), but the fact that a
human had to run it at all — and the form that recovery took — is the defect this note captures.

## What happened (the causal chain)

1. The owner-operator redeployed the live reference stack several times on 2026-06-25
   (`reference-stack.sh up --build-app` recreates `pdpp-web-1` + `pdpp-reference-1`). Each recreation makes
   the Resource Server briefly unreachable → the edge returns **502 Bad Gateway** for a few seconds.
2. The local collector was mid-upload during one of those windows. Its uploads got 502s, it retried, and it
   **exhausted its retry budget while the stack was still cycling** → 81 rows moved to `dead_letter`.
   `oldest_pending_at` (12:37Z) lines up with the deploy churn.
3. The collector's `lifecycle_state` went to `dead_letter`. Nothing self-healed; the rows sat until the
   owner manually ran the low-level `recover … --apply` CLI.

The data was never at risk of loss (it was durably queued in the local SQLite outbox). The defect is that a
**routine, recoverable, transient infrastructure event (a 502 during a deploy) escalated into a state that
required the human to be the recovery mechanism.**

## Why this fails the SLVP bar

Three distinct gaps, each independently worth fixing:

### 1. A transient 502 should not become a dead letter that needs a human
A 502 during a deploy is the *most recoverable* error class there is — the server is briefly down, not
rejecting the request. The collector treated it like a terminal failure (retry-budget-exhaust → dead-letter)
instead of a "server is cycling, back off and keep trying" condition.

Requirements to explore:
- **Classify 502/503/504/connection-refused/timeout as RETRYABLE-INFRA, distinct from a 4xx semantic
  rejection.** Infra-class failures should back off (capped exponential + jitter) and keep retrying for a
  long horizon — they should essentially never dead-letter on their own, because the cure (server returns)
  is guaranteed and external.
- Only genuinely terminal failures (a durable 4xx the payload itself causes — auth revoked, schema
  rejected, payload too large) belong in `dead_letter`, because those *do* need a decision.
- Consider a `retry_after`-aware backoff if the edge ever sends one.
- The retry budget that exists today is tuned for "the request is bad," not "the server is briefly gone" —
  those need different policies.

### 2. Recovery should not be a human typing a source-instance-id into a CLI
Even granting that some rows reached `dead_letter`, the recovery path the owner was handed —
`npx @pdpp/local-collector recover --source-instance-id dsrc_f23027f4ec365b1e --apply` — is the opposite of
SLVP. The owner should not know that command, that flag, or that opaque id exists. The tool's own output
even references "the dashboard recovery path," implying a Console affordance the owner bypassed by being
told to run the CLI.

Requirements to explore:
- **Auto-requeue retryable-infra dead-letters on the next scheduled run** (with backoff), so the common case
  — a deploy blip — self-heals with zero human action and zero notification.
- For dead-letters that genuinely need a decision, surface them in the **Console** in plain language:
  e.g. "81 records are waiting to retry · [Recover]" — a one-click button that runs the same primitive the
  CLI does, on the source the owner is already looking at. No id, no flag, no terminal.
- The low-level CLI (`recover --source-instance-id … --apply`) is fine as an operator/diagnostic escape
  hatch, but it must not be the *advertised* recovery path for the owner. (Cross-reference the owner-journey
  acceptance harness, which already forbids advertising raw monorepo/CLI internals on normal owner paths.)

### 3. The recovery output is a dev-console wall (Gate-1 honesty violation)
The `--apply` run emitted ~600 lines of raw JSON and ended on
`"fully_drained": false`, `"drained": false`, `"drain_stopped_reason": "no_progress"` — which *reads as
failure* to a human, even though the outcome was success (dead_letter → 0; 35 residual rows that drain on the
next scheduled run; `no_progress` just means it correctly stopped hammering a settling stack). This is
exactly the "walls of debugging text" / "a number that doesn't reconcile or doesn't mean what it says"
pattern THE-LENS Gate 1 forbids.

Requirements to explore:
- A human-readable summary line is the default; the raw JSON is `--json`/`--verbose` on demand.
- Plain-language terminal states: "Recovered 81 records. 35 will finish on the next scheduled run — nothing
  more to do." `no_progress`/`not fully drained` must not read as an error when the outcome is healthy.
- The `sent` counter caps/prunes at 10,000, so `total`/`sent` numbers don't obviously reconcile — any
  surfaced number must mean exactly what it says or be labeled (Gate-1: a count names its kind).

## A self-inflicted-cost angle worth naming

The proximate cause here was the operator's own deploy churn (six `--build-app` deploys in one afternoon).
Even with a perfect collector, frequent full-stack recreations will 502 in-flight uploads. Two mitigations,
independent of the collector fixes:
- A near-zero-downtime deploy (rolling/health-gated swap of `pdpp-web`/`pdpp-reference`) would remove the
  502 window entirely.
- At minimum, the collector being resilient to it (gap #1) makes operator deploy cadence a non-event for
  data integrity — which is the right invariant: **an owner's local collector should never be collateral
  damage of a server deploy.**

## Open questions

- Where does the retry/dead-letter classification live today, and is the policy per-error-class or a single
  budget? (Confirm in `@pdpp/local-collector` outbox logic before proposing the split.)
- Does the Console already have a dashboard recovery affordance the CLI output is referencing, and if so why
  was the owner routed to the CLI instead? (If it exists, the gap is discoverability/routing; if not, it's a
  build.)
- Should auto-requeue of infra-class dead-letters be unconditional, or gated on a recent-success signal to
  avoid masking a genuinely-down device endpoint?

## Suggested disposition

Promote the retryable-infra reclassification (gap #1) and the Console one-click recovery + plain-language
output (gaps #2/#3) into an OpenSpec change once the current outbox retry policy is confirmed in code. Gap #1
is the highest-leverage: it makes the common case need no recovery at all.
