# Parent-first emit order decision — 2026-04-23

**Status:** resolved owner decision
**Scope:** `packages/polyfill-connectors/*`
**Layer:** reference implementation quality / connector runtime contract

## Context

The A++ follow-up audit found that several connectors with obvious
parent/child stream relationships were historically child-first:

- gmail: `messages` before `threads`
- chatgpt: `messages` before `conversations`
- claude_code: `messages` / `attachments` before `sessions`

That was not refactor drift; it was the actual pre-existing behavior.
The follow-up work intentionally inverted those connectors to
parent-first and then benchmarked the cost, especially for
`claude_code`.

Measured on the owner's real `~/.claude/projects` corpus:

- legacy single-pass: about `11-12s`
- parent-first `claude_code`: about `23-24s`
- corpus size: roughly `687k` records

So the decision is not "free correctness." It is a real contract-quality
gain purchased with material extra wall-clock on large local corpora.

## Decision

`parent-first` is the reference-quality default for connectors that emit
related parent/child streams.

That means:

- parent records should emit before any of their child records
- connector integration tests should pin that invariant when applicable
- consumer-facing notes should call out any intentional ordering change

This is **not** promoted to a core PDPP protocol requirement. It is a
reference implementation quality rule for live ingest semantics.

## Why the owner chose this

The upside is not richer final data. The upside is a better live
contract:

- incremental consumers can upsert the parent first and attach children
  without ad hoc buffering
- cross-connector behavior is more uniform
- agent-built consumers have fewer connector-specific ordering quirks
- the runtime/query story is easier to reason about during active ingest

For normal settled reads after the run completes, final data fidelity is
not materially different. The value is in live ingest behavior and
consumer simplicity.

## Exception policy

Exceptions are allowed, but only by explicit owner sign-off after
measured evidence.

The required bar for an exception is:

1. prove the attempted parent-first implementation is correct
2. benchmark it on a real corpus or realistic workload
3. show that the cost or complexity is high enough to justify breaking
   uniformity
4. document the exception truthfully for downstream consumers

Without that, connector authors should assume parent-first is expected.
