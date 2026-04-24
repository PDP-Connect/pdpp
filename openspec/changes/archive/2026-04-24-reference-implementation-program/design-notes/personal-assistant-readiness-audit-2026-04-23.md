## Personal Assistant Readiness Audit

**Date:** 2026-04-23
**Scope:** changes needed so an owner-side personal assistant can reliably use the PDPP reference for story-rolls, cross-stream recall, and date-window analysis without hitting avoidable bugs.

## Executive Summary

The highest-value blocker is **not** search anymore. It is **records pagination truthfulness and manifest truthfulness**.

Today the reference's SQL-backed records path only supports `cursor_field` schemas that are:

- numeric
- `string` with `format: "date"`
- `string` with `format: "date-time"`
- or the nullable variants of those shapes

That server-side contract is now implemented correctly in [records.js](/home/user/code/pdpp/reference-implementation/server/records.js:556), and nullable regressions are fixed. The remaining failures come from shipped connector manifests whose `cursor_field` declarations do not match that contract.

This is large in scope:

- `58` shipped streams still declare unsupported `cursor_field` shapes
- across `26` manifest files

The reference is therefore still unsafe for assistant-style browsing of many rich streams unless we repair those declarations and add one systemic guardrail.

## Findings

### P0: Shipped manifests still declare unsupported `cursor_field` schemas

The records path now rejects unsupported cursor types deliberately, but many assistant-critical streams are still under-typed or mis-typed.

Examples:

- Gmail messages use `cursor_field: "received_at"` but declare `received_at` as plain `string` instead of `string` + `format: "date-time"` in [gmail.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/gmail.json:72) and [gmail.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/gmail.json:130)
- Gmail threads use `last_message_date` as nullable string with no date/date-time format in [gmail.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/gmail.json:241) and [gmail.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/gmail.json:268)
- Gmail attachments use `message_received_at` as plain `string` in [gmail.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/gmail.json:485) and [gmail.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/gmail.json:499)
- ChatGPT conversations/messages/etc. use nullable timestamp strings with no format in [chatgpt.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/chatgpt.json:95), [chatgpt.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/chatgpt.json:193), and [chatgpt.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/chatgpt.json:257)
- Claude Code and Codex use nullable timestamp strings with no format in [claude_code.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/claude_code.json:187), [claude_code.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/claude_code.json:282), [codex.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/codex.json:147), and [codex.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/codex.json:219)
- GitHub issues/PRs/repos/gists use nullable `updated_at` / `pushed_at` / `starred_at` strings with no format in [github.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/github.json:127), [github.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/github.json:282), [github.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/github.json:522), [github.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/github.json:738), and [github.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/github.json:857)
- Slack messages use `cursor_field: "ts"` with `ts` declared as plain `string` in [slack.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/slack.json:694) and [slack.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/slack.json:836)
- Reddit submitted/comments/saved use `created_utc` declared as plain `string` in [reddit.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/reddit.json:85), [reddit.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/reddit.json:97), [reddit.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/reddit.json:164), and [reddit.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/reddit.json:176)

Required change:

- repair `cursor_field` schemas so they truthfully match server expectations
- do this first for assistant-critical/narratively rich streams:
  - Gmail
  - Slack
  - ChatGPT
  - Codex
  - Claude Code
  - GitHub
  - Reddit

Recommended approach by bucket:

- `Plainly ISO timestamps`
  - add `format: "date-time"` or `format: "date"`
  - examples: Gmail `received_at`, GitHub `updated_at`, ChatGPT `create_time`
- `String-encoded numeric timestamps`
  - either change schema to numeric if that is the true data shape, or switch `cursor_field` to a canonical ISO companion field if one already exists
  - examples: Slack `ts`, Reddit `created_utc`
- `Opaque identifiers used as cursor fields`
  - change the `cursor_field` itself; do not try to make opaque ids sortable temporal cursors
  - example: Gmail `message_bodies.cursor_field = "message_id"` in [gmail.json](/home/user/code/pdpp/packages/polyfill-connectors/manifests/gmail.json:410)

### P0: The manifest validator does not enforce `cursor_field` sort compatibility

At registration time, the validator only checks that `cursor_field` and `consent_time_field` exist in `schema.properties` in [auth.js](/home/user/code/pdpp/reference-implementation/server/auth.js:1226). It does **not** check that the declared `cursor_field` is compatible with the SQL-backed records path.

That means a connector can register successfully and only fail later when the assistant tries to page records.

Required change:

- add validator logic in [auth.js](/home/user/code/pdpp/reference-implementation/server/auth.js:1226) that rejects unsupported `cursor_field` shapes for the reference implementation
- enforce the same supported set that [records.js](/home/user/code/pdpp/reference-implementation/server/records.js:556) actually supports:
  - `integer`
  - `number`
  - `string` with `format: "date"` or `format: "date-time"`
  - nullable variants of the above

This is the most important systemic guardrail. Without it, the same bug class will keep shipping.

### P1: Unsupported `cursor_field` values still fail as server errors instead of degrading gracefully

When an unsupported `cursor_field` slips through, the records path throws from [records.js](/home/user/code/pdpp/reference-implementation/server/records.js:556). The result is effectively a broken stream for the assistant.

Required change:

- add a reference-only defense so assistant-critical browsing does not hard-fail when one stream is misdeclared

Two viable choices:

1. `Preferred for robustness`
- fall back to the older JS comparator path for that stream only
- keep the SQL path as the default for supported schemas
- log the fallback loudly

2. `Minimum acceptable`
- return a structured client-visible `not_supported` response rather than a generic server error
- include the stream and `cursor_field` in the error

For assistant reliability, fallback is better than hard failure.

### P1: There is no release test that exercises the assistant’s actual workflow

Unit tests now cover:

- nullable cursor fields
- nullable filters
- query-contract pagination basics

What is still missing is an assistant-readiness smoke suite that mirrors the actual usage pattern:

- owner token
- paginated reads on high-value streams
- record hydration by key
- cross-stream lexical search
- date-window roll over real manifests

Required change:

- add one smoke test or scripted check that runs against a representative assistant-critical set
- minimum target streams:
  - Gmail messages
  - Slack messages
  - ChatGPT messages
  - Codex / Claude Code messages
  - GitHub issues / pull requests
  - YNAB transactions

This should fail the rollout if any of those streams 500 on basic page-one record listing.

### P2: Dashboard search still has avoidable UX bugs

The dashboard search page still:

- hard-caps record hits at `50` via [page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/search/page.tsx:23)
- discards `next_cursor`
- exposes the weak `messages-like` scope heuristic in [page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/search/page.tsx:41) and [page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/search/page.tsx:205)

This does not block API-level assistant use, but it does degrade operator-side validation and demos.

Status:

- this is already correctly in scope for the approved semantic implementation tranche

### P2: Search lacks assistant-friendly narrowing controls, but those are product gaps, not bugs

The assistant’s report highlighted two real limitations:

- no date/window filter on search
- no connector-scoping parameter on the public search surface

These are not correctness bugs in the current lexical contract. They are follow-up product/design questions.

They should **not** block the immediate readiness work above.

## Recommended Execution Order

### Batch 1: Stop the broken streams

1. Repair manifest `cursor_field` truthfulness for assistant-critical streams
2. Add validator enforcement for `cursor_field` compatibility
3. Re-run assistant-critical paginated record smoke tests

This is the minimum bar before relying on the assistant for demos or leadership story-rolls.

### Batch 2: Add defense-in-depth

1. Add per-stream graceful fallback or at least structured `not_supported`
2. Add assistant-readiness smoke coverage to CI / release checks

This stops one future manifest mistake from re-breaking the assistant.

### Batch 3: Clean up operator UX

1. Remove `messages-like`
2. Default dashboard search to all streams
3. Add cursor pagination to dashboard search

This improves human validation and makes the product feel less brittle.

## Non-Goals For This Audit

This note is **not** recommending:

- reopening the lexical retrieval public contract
- adding search date filters immediately
- adding public `connector_id` search scoping immediately
- changing the semantic retrieval public contract
- widening records pagination to arbitrary plain string sorts

Those may become worthwhile later, but they are not the minimal set needed to stop the assistant from encountering avoidable bugs now.
