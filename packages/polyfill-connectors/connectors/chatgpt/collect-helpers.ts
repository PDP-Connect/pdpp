/**
 * Collect-layer helpers for the ChatGPT connector.
 *
 * Lives in its own file (not index.ts) because index.ts calls
 * `runConnector({...})` at module load — importing it in a test keeps
 * the Node event loop alive waiting for the stdin protocol. This file
 * contains only Playwright-free helpers so integration tests can import
 * them without side effects.
 *
 * The extracted seams are the observable emit-path invariants:
 *   processConversationDetail   — per-conversation: emit messages along
 *                                 the detail mapping, then emit the merged
 *                                 conversation record. Falls back to a
 *                                 list-only record when detail is missing
 *                                 or http-errored.
 *   runMemoriesStream           — per-run: one record per memory entry;
 *                                 STATE heartbeat on success, SKIP on http
 *                                 error.
 *   runCustomInstructionsStream — per-run: zero or one record (the
 *                                 user-wide custom instructions body).
 *
 * Page-bound orchestration (pagination walk over /conversations,
 * /gizmos/mine, /shared_conversations) stays in index.ts — those helpers
 * call api.fetch() in loops and aren't meaningfully testable without a
 * fake ChatGptApi driver; the per-stream seams above are where the
 * emit-order and scope invariants live.
 */

import type { CollectContext, RecordData } from "../../src/connector-runtime.ts";
import { nowIso } from "../../src/connector-runtime.ts";
import {
  buildCustomInstructionsRecord,
  buildMemoryRecord,
  type ConversationDetail,
  extractMessage,
  flattenTreeCurrentBranch,
} from "./parsers.ts";
import type {
  ChatGptApi,
  ChatGptFetchResult,
  ConversationListItem,
  RawCustomInstructionsBody,
  RawMemoryEntry,
} from "./types.ts";

/** Per-run dependency bag threaded through every emit-path helper. Mirrors
 *  the amazon/chase pattern: one stable bag so collect() becomes pure
 *  orchestration and the helpers are individually testable. */
export interface StreamDeps {
  api: ChatGptApi;
  emit: CollectContext["emit"];
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  progress: CollectContext["progress"];
  requested: CollectContext["requested"];
}

const MEMORIES_PATH = "/memories?include_memory_entries=true";

/**
 * Fetch /memories and emit one record per entry.
 *
 * Invariants:
 *   - On http !== 200, emits a SKIP_RESULT and no records.
 *   - On success, emits records in list order, then a STATE heartbeat.
 *   - buildMemoryRecord filters entries with no id; those drop silently.
 */
export async function runMemoriesStream(deps: StreamDeps): Promise<void> {
  deps.emit({
    type: "PROGRESS",
    stream: "memories",
    message: "Fetching memories",
  });
  const res = await deps.api.fetch(MEMORIES_PATH);
  if (res.status !== 200) {
    deps.emit({
      type: "SKIP_RESULT",
      stream: "memories",
      reason: "http_error",
      message: `memories fetch http ${res.status}`,
    });
    return;
  }
  const entries =
    (res.json?.memories as RawMemoryEntry[] | undefined) || (res.json?.items as RawMemoryEntry[] | undefined) || [];
  for (const m of entries) {
    const rec = buildMemoryRecord(m);
    if (rec) {
      await deps.emitRecord("memories", rec);
    }
  }
  deps.emit({
    type: "STATE",
    stream: "memories",
    cursor: { fetched_at: nowIso() },
  });
}

/**
 * Fetch /user_system_messages and emit at most one custom_instructions
 * record (there is only one per user). 404/403 → SKIP "not_available";
 * other non-200 → SKIP "http_error". Success path emits the record and a
 * STATE heartbeat.
 */
export async function runCustomInstructionsStream(deps: StreamDeps): Promise<void> {
  deps.emit({
    type: "PROGRESS",
    stream: "custom_instructions",
    message: "Fetching custom instructions",
  });
  const res = await deps.api.fetch("/user_system_messages");
  if (res.status === 404 || res.status === 403) {
    deps.emit({
      type: "SKIP_RESULT",
      stream: "custom_instructions",
      reason: "not_available",
      message: `user_system_messages http ${res.status}`,
    });
    return;
  }
  if (res.status !== 200) {
    deps.emit({
      type: "SKIP_RESULT",
      stream: "custom_instructions",
      reason: "http_error",
      message: `user_system_messages http ${res.status}`,
    });
    return;
  }
  await deps.emitRecord("custom_instructions", buildCustomInstructionsRecord(res.json as RawCustomInstructionsBody));
  deps.emit({
    type: "STATE",
    stream: "custom_instructions",
    cursor: { fetched_at: nowIso() },
  });
}

/**
 * Process a single fetched conversation detail payload: emit messages
 * along the current branch (if the messages stream was requested), then
 * emit the merged conversation record via the supplied `emitConversation`
 * callback.
 *
 * Emit order is messages first, then the conversation record — the
 * inverse of the parent-before-child pattern other connectors use. This
 * is the existing (pre-test) contract; see integration.test.ts for the
 * pinned assertion and a note to owners weighing whether to invert it.
 *
 * When `detail.status !== 200` or the mapping is missing, emits a
 * `SKIP_RESULT` on the messages stream and falls back to a list-only
 * conversation record (null detail) so the conversation itself still
 * lands downstream.
 */
export async function processConversationDetail(
  deps: StreamDeps,
  c: ConversationListItem,
  detail: ChatGptFetchResult,
  emitConversation: (c: ConversationListItem, detail: ConversationDetail | null) => Promise<void>
): Promise<void> {
  if (detail.status !== 200 || !detail.json?.mapping) {
    deps.emit({
      type: "SKIP_RESULT",
      stream: "messages",
      reason: "http_error",
      message: `conversation ${c.id} http ${detail.status}`,
    });
    // Fall back to list-only conversation record.
    await emitConversation(c, null);
    return;
  }
  const mapping = detail.json.mapping;
  const currentNode = detail.json.current_node || c.current_node;
  const currentBranchIds = new Set(flattenTreeCurrentBranch(mapping, currentNode).map((x) => x.nodeId));
  for (const [nodeId, node] of Object.entries(mapping)) {
    const msg = extractMessage(nodeId, node, c.id, currentBranchIds.has(nodeId));
    if (!msg?.role) {
      // synthetic root — skip
      continue;
    }
    await deps.emitRecord("messages", msg);
  }
  await emitConversation(c, detail.json as ConversationDetail);
}
