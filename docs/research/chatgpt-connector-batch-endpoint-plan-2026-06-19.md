# ChatGPT Connector: Batch Endpoint Switch Plan

**Date:** 2026-06-19
**Scope:** SURGICAL endpoint swap only. No rate machinery, no checkpoint/resume, no AIMD. See STEER doc for binding scope.
**Source:** vana-com/data-connectors PR #82 (Volod) + our connector packages/polyfill-connectors/connectors/chatgpt/index.ts (3897 lines, v0.1.0)

---

## 1. The Batch Endpoint Mechanism (from PR #82)

### Request shape

```
POST https://chatgpt.com/backend-api/conversations/batch
Authorization: Bearer <token>
OpenAI-Device-ID: <deviceId>
Content-Type: application/json

{ "conversation_ids": ["id1", "id2", ..., "id10"] }
```

Server hard cap: **10 ids per request**. Exceeding 10 returns HTTP 422. (PR #82, line 816: `const BATCH_MAX = 10 // server caps conversation_ids at 10 (422 above that)`.)

### Response shape

HTTP 200 with a **JSON array** of full conversation objects. Each element has the same shape as the single-conversation GET response -- `{ id, mapping, current_node, title, create_time, update_time, gizmo_id, is_archived, workspace_id, ... }`. Our existing `ConversationDetail` type (types.ts) and parsers (parsers.ts, `flattenTreeCurrentBranch`, `extractContent`) consume exactly this shape.

Crucially: a conversation that the server cannot serve at 200 is **silently omitted** from the array (e.g., oversized, broken). It is NOT returned as a failed element. The caller must diff ids-sent vs ids-returned and treat missing ids as requiring the per-id GET fallback.

### Unthrottled claim (PR #82)

PR #82 lines 543-544:
```
const START_CONCURRENCY = 10;  // a full batch from the start -- batch endpoint isn't throttled
const MAX_CONCURRENCY = 10;    // server hard cap on conversation_ids per request
```

This is Volod's empirical observation. It should be treated as a likely-true claim with an open question caveat (see Section 7).

### Per-id GET fallback

For each id that was sent to the batch endpoint but not returned in the response array, fall back to the existing single-conversation GET:

```
GET https://chatgpt.com/backend-api/conversation/{id}
```

This is the CURRENT primary path in our connector (index.ts:3261). Post-switch it becomes the minority fallback path (oversized/broken conversations only).

### Old path being replaced

Listing: `GET /backend-api/conversations?offset=...&limit=...&order=updated` (UNCHANGED -- we keep this)
Detail: one `GET /backend-api/conversation/{id}` per conversation id (the storm -- this is what the batch endpoint replaces)

For N conversations, the old path issues N detail GETs. The batch path issues ceil(N/10) POSTs, roughly a 10x reduction in detail-fetch request count.

---

## 2. Exact Swap Points in Our Connector

### 2.1 The listing path (UNCHANGED)

`listForCursor()` at index.ts:2075:
```ts
const res = await deps.api.fetch(`/conversations?offset=${offset}&limit=${limit}&order=updated`);
```
This produces `conversationsToSync: ConversationListItem[]`. It is NOT changed. We still list the same way; we only change how we fetch detail for each listed id.

### 2.2 The per-id GET path (THE TARGET)

The single GET is at index.ts:3261, inside the inner function `fetchConversationDetailWaitingOutCircuit`:
```ts
return await deps.api.fetch(`/conversation/${encodeURIComponent(c.id)}`);
```

This function is called by `fetchConversationDetailWithRecoverableRetry`, which is called from the main per-conversation worker task inside `runMessagesAndConversationsWithDetail`.

### 2.3 The `ChatGptApi` interface (the seam to extend)

`ChatGptApi` is defined in types.ts (imported at index.ts:71) and implemented by `createChatGptApi` at index.ts:1252-1269. The interface currently exposes:
- `fetch(path)` -- GET with retry, returns `ChatGptFetchResult`
- `fetchStatus(path)` -- GET without full parse, for probes (index.ts:1458)
- `auth()` -- extracts auth token

The batch endpoint requires adding one method to this interface:
- `fetchBatch(ids: string[]): Promise<ChatGptFetchResult[]>` -- POSTs to `/conversations/batch` in one call (the caller is responsible for chunking to <=10). Returns an array corresponding to the subset of ids that the server returned (omitted ids are absent from the array, NOT represented as failures). Each element is a full `ChatGptFetchResult` with `json` shaped like `ConversationDetail`.

### 2.4 Where to intercept (the pre-fetch cache approach)

The cleanest swap avoids restructuring `fetchConversationDetailWaitingOutCircuit` (which has complex retry/wait-out logic). Instead:

**In `runMessagesAndConversationsWithDetail`**, before dispatching individual conversations to the adaptive lane, collect conversation ids into groups of 10, call `deps.api.fetchBatch(chunk)`, and populate a `Map<string, ChatGptFetchResult>` cache. Then, in `fetchConversationDetailWaitingOutCircuit`, check the cache first:

```
if cache.has(c.id) => return cache.get(c.id)  [batch hit, no network call]
else => deps.api.fetch(`/conversation/${c.id}`)  [batch miss/omission, existing GET fallback]
```

This approach:
- Leaves all retry/wait-out/circuit/density logic intact (the fallback path still uses it)
- Does NOT restructure the lane dispatch
- The batch prefetch happens once per tranche of conversations before the lane runs them

### 2.5 Shape compatibility

Our `ConversationDetail` type (types.ts:13, 21, 84) has fields: `id`, `title`, `create_time`, `update_time`, `current_node`, `mapping`, `gizmo_id`, `is_archived`, `is_starred`, `workspace_id`. The batch response array elements carry the SAME fields as the single-conversation GET. Volod's connector reuses the same `walkMessages` tree traversal over batch response elements (PR #82 lines 830-870). Our parsers (parsers.ts: `flattenTreeCurrentBranch`, `extractContent`, `buildConversationRecord`) operate on this exact shape. No parser changes needed.

The `ChatGptFetchResult` for a batch-hit conversation should have `status: 200` and `json` set to the conversation object from the array. For a batch-omitted id, the fallback GET still produces a `ChatGptFetchResult` via the existing path.

---

## 3. Rate Governance: No New Machinery

### What the batch endpoint changes

The detail-fetch request count drops from N (one GET per conversation) to roughly ceil(N/10) POSTs. For a 2,484-conversation account (Volod's production case), that is 2,484 GETs reduced to ~249 POSTs -- nearly 10x fewer requests hitting the backend. The per-id 429 storm was proportional to N; the batch is (per Volod's comment) unthrottled.

### What we already have and keep as-is

All of the following in index.ts survive unchanged:

1. **`CHATGPT_BARE_429_FAST_OPEN_ATTEMPTS = 3` (line 178)**: If the batch endpoint itself returns a bare 429, `retryHttp` fast-opens after 3 attempts. This is the right behavior.
2. **Cumulative 429-density tracker** (`densityTracker`, `ChatGptRateLimitDensityTracker`): counts 429s across the run. With batch, 429s will be far rarer, so this tracker will rarely fire. It remains in place as a safety net.
3. **Circuit breaker via `providerBudget`** and `fetchConversationDetailWaitingOutCircuit`'s wait-out loop: the fallback per-id GET path still flows through this. Correct.
4. **`retryHttp` with Retry-After**: the batch POST call site (in `createChatGptApi.fetchBatch`) should pass through `retryHttp` the same way `fetch` does, so a 429-with-Retry-After on the batch itself is handled correctly.
5. **`PDPP_CHATGPT_DETAIL_RATE_LIMIT_STOP_AFTER`**: the density stop threshold is an env knob. With batch, operators may want to raise this or disable it (set to 0 = Infinity, no density stop) since the blast radius is already 10x smaller. This is an OPTIONAL tuning note, not a required change.

### DETAIL_GAP records

The gap's `networkPressure.endpoint_route` field (currently `"/conversation/{id}"`, index.ts ~2650) should be updated to `"/conversations/batch"` for gaps produced by batch-path failures, and left as `"/conversation/{id}"` for gaps produced by the fallback GET. This is a minor diagnostic accuracy improvement, not a behavioral change. The gap structure, resume logic, and backlog-gap watermark are all unchanged.

---

## 4. Test Strategy in Our Harness

### 4.1 Integration test extension (integration.test.ts)

The existing test harness uses a `ChatGptApi` fake (lines ~489-495) with a `fetchQueue: ChatGptFetchResult[]` consumed sequentially. After adding `fetchBatch` to the `ChatGptApi` interface, extend the fake with a `batchHandler?: (ids: string[]) => ChatGptFetchResult[]` option.

**New test cases to add:**

1. **Batch happy path -- no fallback**: construct `deps` with a `batchHandler` that returns full `ChatGptFetchResult` objects for all 10 ids. Run `runMessagesAndConversationsWithDetail` with 10 conversations. Assert:
   - No calls to `deps.api.fetch(/conversation/{id})` (the per-GET fallback is never hit)
   - All 10 conversations emit correct records through `processConversationDetail`
   - Batch is called once with exactly 10 ids

2. **Batch omission -- fallback fires**: `batchHandler` returns results for only 8 of 10 ids (simulating 2 omitted conversations). Assert:
   - `deps.api.fetch(/conversation/{id})` is called exactly twice (for the 2 omitted ids)
   - All 10 conversations ultimately emit records

3. **Large account -- no per-conversation storm**: construct 100 conversations. Assert that the batch POST is called ceil(100/10) = 10 times, NOT 100 times. This is the primary regression guard.

4. **Batch 429 -- fallback to per-GET**: `batchHandler` returns a 429 (after retryHttp exhausts). Assert that affected conversations are durably gapped as DETAIL_GAPs (not silently dropped), mirroring the existing behavior for per-GET 429s.

5. **Batch miss treated as GET fallback, not as omission error**: id present in `conversationsToSync` but absent from batch response is fetched via GET and succeeds. Assert the conversation record is emitted successfully, not as a SKIP.

### 4.2 Fixture updates (__fixtures__/)

The existing `conversation-mapping.json` and `gizmo-wrapped.json` fixtures cover the ConversationDetail parse path. No new fixture shape is needed (batch response elements are the same shape). The integration tests' `batchHandler` can return the same fake detail objects already used in the `fetchQueue` tests.

### 4.3 Parser tests (parsers.test.ts)

No changes needed. `flattenTreeCurrentBranch` and `extractContent` are shape-only and the shape is unchanged.

### 4.4 Convergence parity test (convergence-parity.test.ts)

No changes needed if the parity test compares emitted records to expected records by shape -- the batch path feeds the same `processConversationDetail` the GET path does.

---

## 5. Manifest / Version Implications

Our connector is at `v0.1.0` (index.ts line 3, header comment). Volod's PR bumped 2.0.0 to 3.0.0, which is a different versioning scheme and includes his full rewrite.

For our connector, the batch endpoint switch is:
- **Not a schema change** (no new fields in emitted records)
- **Not a cursor/STATE shape change** (the conversation list cursor and detail-gap structures are unchanged)
- **Not a behavioral change to emitted records** (same records, same parsers)
- **A change to the detail-fetch strategy** (different endpoint for the same data)

Per the connector authoring guide section 10 ("Versioning and drift"): bump the version when "schemas change, selector strategies change materially, or STATE cursor shape changes." This change does alter the fetch strategy materially, so bump is appropriate: `v0.1.0 -> v0.2.0`. Keep a CHANGES note in the header comment.

**Manifest / connector-index impact**: `generate-connector-index` reads the manifest. The connector manifest records the version. A patch to bump the version string in the header comment and any manifest JSON (`manifest.json` if it exists separately, or the version annotation in index.ts) is the full scope of the versioning work. No scope/source-id-stability impact -- source IDs and stream names are unchanged.

---

## 6. Sequencing (Small Shippable Steps)

**Step 1: Extend the `ChatGptApi` interface and its `createChatGptApi` implementation**

Add `fetchBatch(ids: string[]): Promise<ChatGptFetchResult[]>` to the `ChatGptApi` type in types.ts. Implement it in `createChatGptApi` (index.ts:1252): use `page.evaluate` (the same pattern as `fetch`) to run the POST inside the browser context, identical auth headers (`Authorization: Bearer`, `OpenAI-Device-ID`), body `JSON.stringify({ conversation_ids: ids })`, URL `https://chatgpt.com/backend-api/conversations/batch`. Parse the JSON array response; return a `ChatGptFetchResult[]` with `status: 200` and `json` set to the conversation object for each element. Route through `retryHttp` for the same retry/backoff behavior as `fetch`. This is the ONLY implementation change to `createChatGptApi`.

Deliverable: `ChatGptApi` has `fetchBatch`, `createChatGptApi` implements it, types compile. No behavior change yet (nothing calls it).

**Step 2: Add pre-fetch cache in `runMessagesAndConversationsWithDetail`**

Before the lane dispatch loop, chunk `convosToSync` into groups of 10, call `deps.api.fetchBatch(chunk)` for each, and populate `const batchCache = new Map<string, ChatGptFetchResult>()` with the results (keyed by conversation id). The `fetchBatch` call is NOT inside the lane (it is sequential, one POST per chunk, before the adaptive lane runs). This keeps the batch calls themselves unaffected by the per-conversation retry/circuit machinery.

In `fetchConversationDetailWaitingOutCircuit`, add a cache check before the GET:
```ts
const cached = batchCache.get(c.id);
if (cached) { batchCache.delete(c.id); return cached; }
return await deps.api.fetch(`/conversation/${encodeURIComponent(c.id)}`);
```

Deliverable: in a full run, the detail-fetch path now uses the batch endpoint for all cacheable ids and falls back to per-GET only for omissions.

**Step 3: Integration tests**

Add the 5 new test cases described in Section 4.1. Update the fake `ChatGptApi` in integration.test.ts to include a `fetchBatch` stub (default: returns empty array, i.e., all ids fall through to the existing `fetchQueue`-backed GET fallback). This means existing tests continue to pass unchanged (the default stub causes all ids to miss the cache and fall through to the queue as before). New tests exercise the batch-hit and batch-omission paths explicitly.

Deliverable: all existing integration tests still pass; new batch tests pass.

**Step 4: Version bump and CHANGES note**

Bump `v0.1.0 -> v0.2.0` in the header comment (index.ts line 3). Add a one-line CHANGES entry: "v0.2.0 -- switched conversation-detail fetch from per-id GET storm to POST /conversations/batch (up to 10 ids/request); per-id GET retained as fallback for batch-omitted ids."

Update the `DETAIL_GAP` `networkPressure.endpoint_route` from `"/conversation/{id}"` to `"/conversations/batch"` (or a ternary based on whether the gap came from the batch path or the fallback GET path) for accurate diagnostics.

---

## 7. Risks and Open Questions for the owner

### Open question A: Does the batch endpoint return the same full conversation detail our parsers need?

**Status: LIKELY YES, open to live verification.** Volod's PR #82 reuses the same `walkMessages` tree traversal (same `mapping`, `current_node` fields) over batch response elements. Our `ConversationDetail` type matches the shape. However, Volod's connector is a Playwright-browser connector (different codebase, different parser) and we have not fetched live data from the batch endpoint ourselves. **Recommended: before merging step 2, run a one-off live probe** -- call the batch endpoint manually with 2-3 known conversation ids and inspect the JSON response against our `ConversationDetail` type. If the batch response drops any fields our parsers need (e.g., `gizmo_id`, `is_starred`, `workspace_id`), the plan needs an addendum noting which fields require the GET fallback for completeness.

### Open question B: Does the batch endpoint require different headers or cookies than the per-id GET?

**Status: LIKELY SAME, verify.** Both use `Authorization: Bearer <token>` and `OpenAI-Device-ID`. Volod's implementation (PR #82 lines 962-964) uses the same `accessToken` and `deviceId` variables as the listing call. Our `createChatGptApi` already extracts these. If the batch endpoint requires additional headers (e.g., `Content-Type: application/json` -- it does, since it is a POST), those must be explicitly set in `fetchBatch`. The GET paths rely on the browser's default fetch behavior; the POST must explicitly set `Content-Type` and `method: 'POST'`.

### Open question C: Is the batch endpoint stable enough to depend on?

**Status: SUFFICIENT EVIDENCE, with caveat.** It is used by the official ChatGPT iOS/macOS clients (per Volod's comment and the STEER doc). It appears in Volod's production-ready PR. The risk is that OpenAI may change or remove it without notice (it is not a public API). Mitigation: the per-id GET fallback is always there. A batch-endpoint failure (e.g., 404 or 501 from the server) can be detected and gracefully degraded to 100% GET fallback without data loss. Planning for this graceful degradation path (detect batch-endpoint unavailability and fall back entirely to GET for that run) is a worthwhile addition to step 2.

### Open question D: Account-size / pagination edge cases

For very large accounts (10,000+ conversations), the batch pre-fetch approach (chunk all convosToSync before the lane runs) may hold a large `batchCache` in memory. This is fine for the run sizes our existing `runBudget` allows (bounded by `PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN` and `PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS`). No behavioral edge; mention only for awareness.

### Open question E: The batch endpoint's 429 handling -- same or different?

Volod's comment says it is "not throttled," but this may mean "less aggressively throttled" rather than "immune to 429." If the batch endpoint returns 429 WITH a Retry-After header, our `retryHttp` handles it correctly (the full retry budget). If it returns a bare 429, `CHATGPT_BARE_429_FAST_OPEN_ATTEMPTS = 3` fast-opens after 3 attempts. Both cases result in a run-level deferral (DETAIL_GAP), not a silent data loss -- the existing machinery handles it. No new code needed; this is confirmation the current 429 design already covers the batch path.

### What is explicitly NOT an open question

- Rate governance: covered by existing machinery (see Section 3). No action.
- Checkpoint/resume (IndexedDB in Volod's PR): our cursor.ts + DETAIL_GAP system already provides crash-safe incremental collection. Not needed.
- AIMD concurrency: our AdaptiveLane controls concurrency over the lane. The batch calls themselves are sequential pre-fetch (not inside the lane), so AIMD does not interact with the batch chunking. Not needed.

---

## 8. File Summary

| File | Change | Scope |
|------|--------|-------|
| `connectors/chatgpt/types.ts` | Add `fetchBatch(ids: string[]): Promise<ChatGptFetchResult[]>` to `ChatGptApi` interface | 3-5 lines |
| `connectors/chatgpt/index.ts` | (a) Implement `fetchBatch` in `createChatGptApi` (lines ~1252-1500); (b) Add batch pre-fetch + cache in `runMessagesAndConversationsWithDetail` (lines ~3300+); (c) Cache check in `fetchConversationDetailWaitingOutCircuit` (line 3261) | ~60-80 lines net new |
| `connectors/chatgpt/integration.test.ts` | Extend `ChatGptApi` fake with `fetchBatch` stub; add 5 new test cases | ~80-100 lines |
| `connectors/chatgpt/index.ts` (header) | Version bump v0.1.0 -> v0.2.0 + CHANGES note | 2 lines |
| Manifest / connector-index JSON (if exists) | Version string update | 1 line |

Parsers, schemas, cursor, convergence-parity test, fixtures: **no changes.**
