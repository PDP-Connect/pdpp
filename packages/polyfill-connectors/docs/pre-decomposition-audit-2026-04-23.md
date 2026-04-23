# Pre-decomposition behavior audit

**Date:** 2026-04-23
**Scope:** 7 connectors whose `collect()` (or `main()`) was decomposed by subagents during the cognitive-complexity refactor, plus `amazon` (decomposed by hand) as a reference.
**Status:** findings only; no code changes in this pass.
**Method:** `git show <decomp-commit>^:<index.ts>` diffed against current `index.ts` + `collect-helpers.ts`. Focus is the `collect()` body, per-stream emit order, STATE timing, SKIP_RESULT shape, timestamp fields, and error-handling boundaries.

## Summary table

| Connector  | Emit order | Scope gating | STATE timing | SKIP_RESULT | Timestamp | Error handling | Verdict |
|------------|-----------|-------------|-------------|-------------|-----------|----------------|---------|
| amazon     | preserved | preserved   | preserved   | preserved   | preserved | preserved      | clean   |
| chatgpt    | preserved (messages-before-conversation is pre-existing) | preserved | preserved | preserved | preserved | preserved | clean — no drift |
| slack      | preserved | preserved   | preserved   | preserved   | preserved | preserved      | clean   |
| codex      | preserved | preserved   | preserved   | preserved   | preserved | preserved      | clean   |
| claude_code| preserved (messages emitted during scan BEFORE sessions; pre-existing) | preserved | preserved | preserved | preserved | preserved | clean   |
| chase      | preserved | preserved   | preserved   | preserved   | preserved | preserved      | clean   |
| usaa       | preserved | preserved   | preserved   | preserved   | preserved | preserved      | clean   |
| gmail      | preserved (messages-before-threads is pre-existing) | preserved | preserved | preserved | preserved | preserved | clean — no drift |

**Material-difference count:** 0 drift, 0 material intentional. The decompositions are behavior-preserving at the emit layer. The two ordering quirks flagged by the integration tests were PRE-EXISTING — not introduced by the decompositions.

## Direct answers to the flagged questions

**Q: Was gmail's "messages before threads" ordering present PRE-decomposition? Or did the decomposition introduce it?**
**A: PRE-EXISTING.** In pre-decomp `main()` the per-message body-pass loop (lines 440–635 of `gmail_before.ts`) emits `message_bodies` → `messages` → `attachments` per message, then the THREADS block (lines 702–753) runs a separate IMAP fetch and emits `threads` records afterward. Current decomposition preserves this exact ordering: `emitMessagesPass(...)` → `runDeltaPass(...)` → `runThreadsPass(...)` → STATE (index.ts:623–647). The "messages before threads" ordering existed before 54156d8 and after.

**Q: Was chatgpt's "messages before conversations record" present PRE-decomposition? Or did fa0e349 introduce it?**
**A: PRE-EXISTING.** In pre-decomp `collect()` (chatgpt_before.ts:1001–1011), for each conversation detail the connector iterates the mapping and calls `emitRecord("messages", msg)` inside the loop, then AFTER the loop exits calls `emitConversation(c, detail.json)`. Current `processConversationDetail` in `collect-helpers.ts:173–181` does the same: loop emits messages, then `await emitConversation(c, detail.json)` at the end. The inversion is the existing contract; the new `collect-helpers.ts` doc-comment explicitly calls this out (lines 142–146).

## Per-connector detail

### amazon (reference — decomposed by hand in e62c368)

Functions extracted: `extractAndShapeCheckOrders`, `reportEmptyPageDiagnostics`, `scrapeListPage`, `processListOrder`, `runYear`. `collect()` reduced to an orchestration loop over years. No ordering changes observed between pre-decomp and current. This is the comparison baseline.

### chatgpt (fa0e349)

Functions extracted into `collect-helpers.ts`: `runMemoriesStream`, `runCustomInstructionsStream`, `processConversationDetail`, plus `StreamDeps` bag. Helpers kept in `index.ts`: `runCustomGptsStream`, `runSharedConversationsStream`, `listConversationsSinceCursor`, `runMessagesAndConversationsWithDetail`, `runConversationsAndMessagesStreams`, `makeEmitRecord`.

**Per-stream emit order** (pre-decomp `collect()` 555→1040 vs current index.ts:486–518):

```
memories → custom_gpts → custom_instructions → shared_conversations → conversations+messages
```

Both paths identical.

**Per-conversation emit order inside the detail batch** (the flagged quirk):

Pre-decomp (lines 1001–1011):
```ts
for (const [nodeId, node] of Object.entries(mapping)) {
  const msg = extractMessage(...);
  if (!msg || !msg.role) continue;
  emitRecord("messages", msg);
}
emitConversation(c, detail.json);
```

Current (collect-helpers.ts:173–181):
```ts
for (const [nodeId, node] of Object.entries(mapping)) {
  const msg = extractMessage(...);
  if (!msg?.role) continue;
  await deps.emitRecord("messages", msg);
}
await emitConversation(c, detail.json as ConversationDetail);
```

Same sequencing. **Classification: intentional (and preserved).**

**SKIP_RESULT shapes** — all match: `reason: "http_error"` / `"not_available"` with `http ${status}` messages. Notably, the 404/403 → `not_available` vs other non-200 → `http_error` split is preserved per stream (`memories` pre-decomp only distinguished "http_error" — current matches). Verified.

**STATE timing** — each stream emits STATE at the end of its block on success; on non-200 the `anyError`/`sawError` flags still correctly suppress STATE. Preserved.

**Timestamps** — `emittedAt` (per-run) vs `nowIso()` (per-STATE) usage matches between both versions.

**Error handling** — `makeEmitRecord` guard wrapping `JSON.stringify` preserved verbatim.

**Verdict: clean.** The messages-before-conversation ordering is pre-existing.

### slack (8a35f3a)

Functions extracted: `runWorkspaceStream`, `runChannelsStream`, `runChannelMembershipsStream`, `runUsersStream`, `runMessagesUnifiedPass`, `runFilesStream`, `runCanvasesStream`, `emitUnavailableStreams`, `emitStateCheckpoints`, `makeEmitRecord`, `ensureArchiveOnDisk`, `runRequestedStreams`, `buildChildEnv`, `resolveArchivePaths`, `pickResumeTarget`, `extractCredentials`, `readSlackOptions`, `buildArchiveArgs`, `runArchiveOrResume`, `loadMessageRows`.

**Emit order** (pre-decomp 407→899 vs current runRequestedStreams at index.ts:732–760 + collect at 771–837):

```
workspace → channels → channel_memberships → users → messages (+reactions+message_attachments unified) → files → canvases → unavailable SKIPs → STATE per stream
```

Identical. The unified messages/reactions/message_attachments pass still threads `maxMessageTs` out via the return value (was a closure `let` before). Not a behavior change; same cursor computation.

**Per-message emit order** inside the unified pass: `messages` → `reactions` (flat across all reactions × users) → `message_attachments`. Pre-decomp (lines 622–701) and current `runMessagesUnifiedPass` identical.

**STATE ordering** — `emitStateCheckpoints` emits `messages` STATE first (including `archive_dir` under the messages cursor), then looped `channels`/`users`/`files`/`canvases`/`workspace` STATE. Matches pre-decomp (lines 879–899).

**Verdict: clean.**

### codex (18c293c)

Functions extracted: `iterJsonlLines` (unchanged), `walkDayFiles`/`walkMonthDays`/`walkYearMonths`/`walkRollouts` (refactored but iteration surface identical), `openThreadsDb`, `queryThreadsRows`, `loadThreadsMap`, `parseRolloutFile`, `processRolloutEntry`, `scanRollouts`, `emitSessions`, `readStartMessage`, `resolveCodexDirs`, `readFileMtimes`, `buildRequestedMap`, `buildResourceFilters`, `emitStateCursors`. Parsing helpers (`processRolloutLine`, `flushPendingCalls`, `emitSessionsFromMaps`) extracted into `collect-helpers.ts`.

**Emit order** (pre-decomp main() 479→812 vs current index.ts:571→):

```
rollout scan (emits messages + function_calls during scan, per-file) →
  sessions emit (threads-from-state_5 first, then rollout-only survivors) →
    rules → prompts → skills → STATE (sessions, messages|function_calls, rules, prompts, skills)
```

Identical, line for line. `newMtimes` is still mutated in-place under a shared ref; the `ScanRolloutsArgs` bag makes that explicit.

**Pending function_call flush** — pre-decomp inlined the `for (const call of pendingCalls.values()) emitRecord("function_calls", { ...call })` at end-of-file (lines 689–691). Current moves this into `flushPendingCalls` (collect-helpers.ts) called from `parseRolloutFile` — same call site, same ordering.

**STATE shape** — `emitStateCursors` reproduces pre-decomp's exact conditional: sessions STATE, then `messages` OR `function_calls` (preferring messages) STATE with `file_mtimes` embedded, then rules/prompts/skills. Matches.

**Verdict: clean.**

### claude_code (dfe0f07)

Functions extracted: `emitToolResultFile`, `processToolResultEntry`, `walkToolResults` (refactored), `updateSessionAccumulator`, `parseJsonlFile`, `emitSkills`, `processSlashCommandFile`, `emitSlashCommands`, `processJsonlFile`, `processTopLevelJsonl`, `readSubagentFiles`, `processSessionDir`, `scanProjectDir`, `listProjectDirs`, `scanProjectDirs`, `runSkillsAndCommands`, plus `emitSessionsFromAccumulators` in `collect-helpers.ts`.

**Emit order** (pre-decomp 711→793 vs current index.ts:552→600):

```
skills (via emitSkills) → slash_commands (via emitSlashCommands) → STATE skills → STATE slash_commands →
  projects scan (emits messages + attachments during scan) →
    sessions emit (from accumulators) → STATE sessions → STATE messages (file_mtimes)
```

Identical.

**Note on parent/child ordering** — the messages emits happen DURING `scanProjectDirs` (i.e. interleaved with the file walk), and the sessions records emit AFTER the full scan completes via `emitSessionsFromAccumulators`. This means child rows (`messages`) land on the wire BEFORE the parent `sessions` row. This is PRE-EXISTING (pre-decomp lines 755–783: `scanProjectDirs` → `for sessions: emitRecord("sessions", ...)` → STATE). The decomposition preserves this exactly. Call-out for owner judgment if parent-first ordering is desired — but not drift.

**STATE timing** — skills/slash_commands STATE emitted immediately after their scans; sessions STATE and messages STATE emitted after the projects scan. Matches pre-decomp.

**Error handling** — `try/catch` wrappers around `emitSkills` and `emitSlashCommands` (emitting `PROGRESS` on failure rather than `SKIP_RESULT`) are preserved verbatim inside `runSkillsAndCommands`.

**Verdict: clean.**

### chase (5743e1f)

Functions extracted: `emitNoAccountsDiagnostic`, `emitAccountsStream`, `processAccountDownload`, `runTransactionsAndBalances`, `processStatementRow`, `runStatements`, `emitTransactionsStateIfAny`, `filterAccountsByScope`, `chooseActivity`, plus an `EmitDeps` bag.

**Emit order** (pre-decomp 470→797 vs current index.ts:692–777):

```
accounts → transactions+balances (per account, interleaved with STATE transactions per-account) →
  statements (per row, STATE statements at end) → final STATE transactions if any
```

Identical. Notably, the STATE transactions emit INSIDE the per-account loop (pre-decomp line 743–747) is preserved in `runTransactionsAndBalances` via `processAccountDownload`. The `emitTransactionsStateIfAny` at end also preserved.

**SKIP_RESULT** — all 4 reason codes preserved: `selectors_pending`, `qfx_download_failed`, `qfx_parse_failed`, `pdf_download_failed`, `row_exception`, `statements_scrape_failed`.

**Timestamps** — `emittedAt` threaded through deps; `fetched_at` on records preserved.

**Error handling** — outer `try/finally` with tmpDir cleanup preserved. Per-statement `try/catch` inside `runStatements` preserved. Statements-scope `try/catch` with fallback `SKIP_RESULT` preserved.

**Verdict: clean.**

### usaa (3fb979c)

Functions extracted: `emitExportClickFailedDiagnostic`, `emitDialogUnexpectedShapeDiagnostic`, `openExportDialog`, `fillExportDateRange`, `submitExportAndAwait`, `driveExport` (restructured), `reauthAfterSessionLapse`, `runSingleLadderAttempt`, `tryExportLadder`, `emitCsvTransactions`, `processAccountTransactions`, `runTransactionsStream`, `scrapeStatementsIndex`, `hydratePdfsForIndex`, `processPdfStatementRow`, `emitPdfStatementTransactions`, `runStatementsStream`, `scrapeInboxRows`, `runInboxStream`, `scrapeCreditCardBilling`, `runCreditCardBillingStream`, `emitAccountsStream`, `emitDeferredStreams`. Big extraction — 23+ helpers.

**Emit order** (pre-decomp 534→1143 vs current index.ts:1075–1142):

```
accounts (+STATE) → transactions (ladder per account, STATE transactions emitted per-account inside the loop) →
  statements (scrape + hydrate + emit statements, then Phase B: parse PDFs → emit transactions + STATE statements) →
  inbox_messages (+STATE) → credit_card_billing (+STATE) → deferred-stream SKIPs
```

Identical.

**Session-dead gating** — the `sessionDeadMidRun` flag moved into a mutable `TransactionsStreamState` bag so helpers can flip it. Observable gating is preserved: statements/inbox/credit_card skipped if `streamState.sessionDeadMidRun`; final `throw` preserved.

**STATE per-account transactions** — pre-decomp (lines 743–747) emits STATE inside the per-account loop after every successful export. Current `processAccountTransactions` preserves this.

**SKIP_RESULT reasons** — all preserved: `session_dead_reauth_failed`, `export_error`, `credit_card_export_unverified`, `export_no_download`, `scrape_failed`, `hydrate_crashed`, `pdf_download_*`, `pdf_template_unknown`, `pdf_parse_failed`, `selectors_pending`.

**Error handling** — outer `try/finally` with `downloadQueue.detach()` preserved.

**Verdict: clean.**

### gmail (54156d8)

Functions extracted: `emitLabelsStream`, `collectMetadata`, `buildBodyPartsRequest`, `decodeFetchedBodies`, `fetchBodies`, `runDeltaPass`, `runThreadsPass`, `runAllMailPasses`, `makeEmitRecord`, `readStartMessage`, `deriveAllMailSession`, `selectBodyParts`, plus `processMessage` and `emitMessagesPass` in `collect-helpers.ts`.

**Top-level emit order** (pre-decomp 315→779 vs current index.ts main + `runAllMailPasses`):

```
labels stream (+STATE labels) → [list mailboxes → getMailboxLock(All Mail)] →
  runAllMailPasses:
    metadata collect →
    emitMessagesPass (per message: message_bodies → messages → attachments) →
    runDeltaPass (if incremental: flag/label delta messages only) →
    runThreadsPass (if requested) →
    STATE messages (all_mail cursor)
```

Identical to pre-decomp.

**Per-message emit order inside emitMessagesPass** — pre-decomp lines 534–620:
```ts
if (wantBodies) emitRecord("message_bodies", {...})
if (wantMessages) emitRecord("messages", {...})
if (requested.has("attachments") && attachments.length) for (...) emitRecord("attachments", ...)
```
Current `processMessage` (collect-helpers.ts:127–163): same three conditionals in same order. **Preserved.**

**Threads come AFTER messages** — pre-existing. See "Direct answers" above. Current `runAllMailPasses` calls `emitMessagesPass` → `runDeltaPass` → `runThreadsPass` in that order (index.ts:623, 626, 632–634).

**STATE timing** — labels STATE emitted immediately after labels block; messages STATE emitted LAST (after threads pass). Pre-decomp (lines 335–339, 756–766) matches current (index.ts:637–647).

**Delta-pass gating** — pre-decomp (line 663) checks `requested.has("messages")` inside the loop; current `runDeltaPass` (index.ts:496–498) uses `if (!requested.has("messages")) continue;` inside the loop. Same net behavior.

**Timestamps** — `emittedAt` captured once at top of main; `nowIso()` for STATE cursors; `internalDateToIso(... , nowIso)` falls back to `nowIso()` when Gmail returns no internalDate. Both versions identical.

**Error handling** — outer `try/finally { client.logout() }` preserved. Inner `try/finally { lock.release() }` preserved. Per-message `try/catch` swallowing per-message errors preserved in `emitMessagesPass` (collect-helpers.ts:175–192) — same stderr format (`[gmail] per-message error at UID ${uid}: ${emsg}`).

**Verdict: clean.** The "messages before threads" ordering is pre-existing.

## Cross-cutting observations

1. **Parent/child ordering across the fleet.** Three connectors emit child-before-parent today: `chatgpt` (messages before conversation record within each detail batch), `claude_code` (messages before sessions at the run level), `gmail` (messages before threads at the run level). All three are PRE-EXISTING; none was introduced by a decomposition. Whether to invert any of these is an owner-judgment question separate from the refactor audit.

2. **STATE-after-RECORDs invariant.** Every connector still emits STATE after the last RECORD for that stream in the same run. Preserved everywhere.

3. **`emittedAt` vs `nowIso()`.** Convention preserved: records carry `emitted_at = emittedAt` (single run-wide timestamp) while STATE cursors use `fetched_at: nowIso()` (timestamp at emit time). No swaps observed.

4. **`SKIP_RESULT` reason codes.** All reason strings grepped in current match pre-decomp verbatim. The 404/403 → `not_available` vs other non-200 → `http_error` split in chatgpt is preserved per-stream.

5. **Try/catch boundaries.** All per-item and per-stream try/catch boundaries preserved. No wider catches swallowing per-record errors; no narrower catches newly introducing partial failures.

## Recommendation

No code changes required for the decompositions. The two ordering quirks flagged by the integration tests (`gmail: messages before threads`, `chatgpt: messages before conversation`) are pre-existing behavior that the decompositions faithfully preserved; they are appropriate for the tests to pin as the current contract. If the owner decides either ordering should be inverted, that is a separate proposal that does not relate to the decomposition refactor.
