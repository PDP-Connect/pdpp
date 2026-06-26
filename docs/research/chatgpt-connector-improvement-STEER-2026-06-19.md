# ChatGPT connector improvement: the owner's binding steer (corrected scope)

Status: BINDING. This narrows the plan. Any plan that does not center this is off-target.

## The ONE core innovation to borrow

Switch our ChatGPT connector's conversation fetch from the **per-conversation GET storm** to the **bulk `POST /conversations/batch` endpoint** that the official ChatGPT iOS/macOS apps use.

Evidence (Volod's PR #82 diff, vana-com/data-connectors):
- Old path (what we likely still do): list via `GET https://chatgpt.com/backend-api/conversations?offset=...&limit=...&order=updated`, then ONE `GET` per conversation id. N conversations = N requests = the 429 storm (his prod log: 2,484 convs, 2,410 x 429).
- New path: `POST /conversations/batch` with `conversation_ids[]`, server hard cap = **10 ids per request**, and the batch endpoint **is not throttled** ("a full batch from the start; batch endpoint isn't throttled"). So ~10x fewer requests AND no rate-limit storm.
- Fallback: per-id GET only for ids the batch endpoint misses.

This is a REQUEST-COUNT / endpoint change, not a rate-control change. Eliminating the storm at the source is the whole win.

## What to EXPLICITLY REJECT (PDPP already owns it, or our connector does)

Do NOT port Volod's connector-local rate/reporting/resume machinery. Justify each rejection against the actual PDPP/our-connector code:
- AIMD concurrency + circuit breaker + Retry-After-in-connector: PDPP has system-level governance (packages/polyfill-connectors/src/adaptive-lane.ts, provider-pacing.ts, connector-http-governor.ts, send-governor.ts, http-retry.ts, provider-budget.ts, run-budget.ts) AND our chatgpt/index.ts already has sophisticated 429 handling (CHATGPT_BARE_429_FAST_OPEN_ATTEMPTS, bare-429-as-account-bucket-signal, cumulative-429-density wait-resume). A second connector-local rate controller stacked on PDPP's = the stacked-backoff anti-pattern. REJECT unless you can prove PDPP genuinely lacks a specific piece.
- "degraded -> partial" run classification: PDPP has its own run-classification + connection-health model (more developed than data-connectors'). Map onto it; do NOT import Volod's scheme.
- IndexedDB-on-origin checkpoint + AIMD-style resume: most of this is COMPENSATION for the per-conversation storm. Once we use the unthrottled batch endpoint, the storm is gone, so the elaborate resume/checkpoint is likely unnecessary. ASSESS honestly: with the batch endpoint, do we still need checkpoint/resume at all, or does PDPP's existing cursor (we have connectors/chatgpt/cursor.ts) + incremental emission already cover crash-safety and incremental collection? Default assumption: we do NOT need to add Volod's checkpoint machinery; prove otherwise if you disagree.

## The plan's real job (narrowed)

1. Confirm the batch endpoint mechanism in Volod's diff (POST /conversations/batch, conversation_ids[] <=10, unthrottled, GET fallback) and the request/response shape.
2. Determine how OUR connector (packages/polyfill-connectors/connectors/chatgpt/index.ts, 3897 lines) currently fetches conversations, and exactly where/how to switch it to the batch endpoint while PRESERVING our parsers/schemas/cursor/auth/tests.
3. The concrete change: the batch request (10 ids/POST), response parsing into our existing conversation shape, GET-fallback for misses, conforming to connector-authoring-guide.md + playwright-hygiene.md.
4. Confirm PDPP's governor + our existing 429 logic correctly handle the (now much smaller) request volume - i.e. we do NOT add new rate machinery.
5. Test strategy in OUR harness (integration.test.ts / fixtures): assert we hit the batch endpoint, fetch 10/POST, fall back to GET for misses, and that a large account no longer storms.
6. Honest open questions for the owner (e.g. does the batch endpoint require any header/auth the per-GET didn't; does it return the same conversation detail shape our parsers expect; any account-size edge).

KEY: this is a SURGICAL endpoint swap on a mature connector, not a rewrite and not a rate-control project. The smaller and more focused the plan, the better.
