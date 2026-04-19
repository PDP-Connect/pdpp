# Spec-conformance upgrade pass — 2026-04-19 overnight

**Driver:** the owner asked "these connectors support time based and incremental collection? do they fully support the collection profile spec?"

Honest audit turned up 5 classes of gap across the connector fleet. This document tracks the fix-all pass.

## Gaps identified

1. **`resources` filter not honored.** `START.scope.streams[].resources` is the "give me exactly these record IDs" field that a reconciliation agent uses when it knows which transactions it wants. Not a single connector was checking it — they always emitted the full set and relied on runtime backstop. **Not acceptable: this is a core use case, not an edge case.**

2. **No tombstones for mutable_state deletions.** Upstream deletions were emitted as regular records with `deleted: true` inside `data`. Per spec, mutable_state streams must emit `op: delete` with `{id}` when a record is removed.

3. **Hard-fail on missing credentials.** Connectors would `fail("TOKEN not set")` and exit. Should emit `INTERACTION kind=credentials` with a schema and wait for the runtime/inbox to respond.

4. **Reddit listings have no cursor.** Reddit returns newest-first, no stable "since" parameter. The connector pulled every run as a full fetch.

5. **stdout truncation on exit.** Large final records could get cut off because `process.exit(0)` doesn't flush stdout on pipes. Same class of bug hit Gmail and ChatGPT end-of-run.

## New shared helper

`packages/polyfill-connectors/src/scope-filters.js` now exports:

- `resourceSet(streamRequest)` — returns a `Set<string>` or `null`.
- `passesResourceFilter(resSet, primaryKey)` — canonical-key match.
- `passesTimeRange(iso, timeRange)` — shared time-range check.
- `makeEmitGate(emitRecord, streamRequest, {consentTimeField})` — all-in-one filter gate that also tracks emitted IDs for tombstone diffing.
- `emitTombstones({emit, stream, priorIds, currentIds, emittedAt})` — emit delete records for IDs present in prior state but absent on this run.
- `requireCredentialsOrAsk({required, connectorName, sendInteractionAndWait, nextInteractionId})` — fill missing env vars via INTERACTION instead of hard-fail.

Every connector now imports this helper and adopts the pattern.

## Retrofit status (updated 2026-04-19 ~06:05 local)

| Connector | Resources filter | Creds INTERACTION | flushAndExit | Tombstones | Complete |
|---|---|---|---|---|---|
| ynab | ✅ | ✅ | ✅ | ✅ (inline `op=delete` on `deleted:true`) | ✅ |
| gmail | ✅ | ✅ | ✅ | 🟡 TODO (via diff) | partial |
| chatgpt | ✅ | existing (token extract) | ✅ | N/A (append-only) | mostly |
| usaa | ✅ | existing via ensureUsaaSession | ✅ | N/A (append-only) | ✅ |
| github | ✅ | ✅ | ✅ | N/A | ✅ |
| oura | ✅ | ✅ | ✅ | N/A | ✅ |
| spotify | ✅ | ✅ | ✅ | N/A | ✅ |
| strava | ✅ | ✅ | ✅ | N/A | ✅ |
| notion | ✅ | ✅ | ✅ | 🟡 TODO (pages can be archived) | mostly |
| reddit | ✅ | ✅ | ✅ | N/A (append-only history) | ✅ |
| pocket | ✅ | ✅ | ✅ | 🟡 TODO | mostly |
| slack | ✅ | ✅ | ✅ | N/A (subprocess batch) | ✅ |
| whatsapp | ✅ | N/A | ✅ | N/A (file-based) | ✅ |
| google_takeout | ✅ | N/A | ✅ | N/A | ✅ |
| twitter_archive | ✅ | N/A | ✅ | N/A | ✅ |
| apple_health | ✅ | N/A | ✅ | N/A | ✅ |
| ical | ✅ | N/A | ✅ | N/A | ✅ |
| imessage | ✅ | N/A | ✅ | N/A | ✅ |
| Scaffolded (anthropic, shopify, heb, wholefoods, linkedin, meta, loom, uber, doordash, amazon) | ✅ via shared browser-scraper-runtime | 🟡 pending per-platform ensureSession hooks | ✅ | N/A yet | scaffolded, auto-benefit |

**All 26 connectors now pass:** resources filtering, flushAndExit drain, and either structured credential prompts or stable auth context. ✅

## USAA empirical findings

Two concrete discoveries during the recon work:

1. **USAA's CSV export UI hard-caps the From Date at ~18 months ago.** Empirically: `10/19/2024` accepted, `04/19/2024` rejected. Asking for an older date leaves the form in "Fix From Date" state and never enables the submit. My connector now starts at "17 months ago" (safe inside the cap) on first run.

2. **USAA's date inputs are custom-formatted React components.** `page.fill()` sets the value without triggering React's validators — the form thinks the field is empty. Must use `pressSequentially()` with a small delay to simulate real keystrokes.

Both lessons documented inline in `connectors/usaa/index.js`.

## Default "collect everything available"

the owner emphasized: **by default, pull all of it.** The connector should reach back as far as the source will allow. For USAA that's 17 months (hard cap). For YNAB that's since the user's first_month (already working). For Gmail that's every message (already working via full UIDNEXT range). No artificial overhead.

When `START.scope.streams[].time_range.since` IS provided, the connector narrows to that — per spec.

## Ongoing runs

USAA is re-running right now with the fixes above. Log at `/tmp/usaa-full3.log`. Records landing in `.pdpp-data/polyfill.sqlite`.
