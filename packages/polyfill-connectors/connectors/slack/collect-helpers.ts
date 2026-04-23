/**
 * Collect-layer helpers for the Slack connector.
 *
 * Lives in its own file (not index.ts) because index.ts calls
 * `runConnector({...})` at module load — importing it in a test keeps
 * the Node event loop alive waiting for the stdin protocol. This file
 * contains only sqlite-free helpers so integration tests can import
 * them without spawning slackdump or opening a DB.
 *
 * The extracted seam is the unified cross-stream emit pass:
 *   emitMessagesPass — iterates pre-loaded MessageRow[] and emits into
 *                      messages / reactions / message_attachments as
 *                      gated by the requested scope, tracking maxMessageTs.
 *
 * SQL-bound helpers (runWorkspaceStream, runChannelsStream,
 * loadMessageRows, etc.) stay in index.ts since they're thin wrappers
 * around DatabaseSync and aren't meaningfully testable without a real
 * sqlite archive. The unified pass is the seam that owns cross-stream
 * ordering and scope gating, which is where the observable invariants
 * live.
 */

import { type CollectContext, nowIso, type RecordData } from "../../src/connector-runtime.ts";
import { buildMessageAttachmentRecords, buildMessageRecord, buildReactionRecords, parseMessageRow } from "./parsers.ts";
import type { MessageRow } from "./types.ts";

/**
 * Subset of the per-stream dependency bag that the unified messages pass
 * actually needs. The sqlite-bound helpers in index.ts extend this with a
 * `db: DatabaseSync` field; tests can satisfy this narrower interface
 * without opening a DB. Mirrors the gmail/chase/usaa EmitDeps shape.
 */
export interface MessagesPassDeps {
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  emittedAt: string;
  progress: CollectContext["progress"];
  requested: CollectContext["requested"];
}

export interface MessagesPassResult {
  maxMessageTs: string | null;
}

/**
 * Single-pass co-traversal of pre-loaded MESSAGE rows, emitting into
 * messages, reactions, and message_attachments streams as requested.
 * Tracks maxMessageTs across every row for the post-loop STATE checkpoint.
 *
 * Contract pinned by integration.test.ts:
 *   - Per row, the `messages` record emits BEFORE its reactions and
 *     attachments (parent-before-children within the row).
 *   - Scope gating is per-stream: disabling one of the three does not
 *     suppress the other two — they share the pass but not the guard.
 *   - When all three are disabled, the loop still runs (rows are iterated)
 *     but emits nothing; maxMessageTs still advances so the STATE
 *     checkpoint is accurate. This is the current pre-decomposition
 *     behavior: the caller guards entry to this function on
 *     `requested.has("messages" | "reactions" | "message_attachments")`,
 *     so in practice an all-disabled call is a harmless no-op.
 *   - A message with no reactions / no attachments still emits its
 *     messages record; enrichment is additive, not gating.
 *   - This function does not dedupe — dedup happens in `loadMessageRows`
 *     at the sqlite layer via `MAX(CHUNK_ID) GROUP BY (CHANNEL_ID, TS)`.
 *     Passing the same row twice emits twice on purpose.
 *   - `deps.emittedAt` is the pinned emit-time; `parseMessageRow` uses
 *     nowIso() only as a fallback when the row's TS is unparseable,
 *     which threads into the record's `sent_at` (distinct from
 *     `emitted_at`, which the runtime stamps on the RECORD envelope).
 */
export async function emitMessagesPass(
  deps: MessagesPassDeps,
  rows: readonly MessageRow[],
  priorTs: string | null
): Promise<MessagesPassResult> {
  if (priorTs) {
    deps.progress(`incremental: filtering messages newer than ${priorTs} (${rows.length} to process)`, {
      stream: "messages",
    });
  }

  const wantMessages = deps.requested.has("messages");
  const wantReactions = deps.requested.has("reactions");
  const wantMsgAttachments = deps.requested.has("message_attachments");

  let maxMessageTs: string | null = null;
  for (const r of rows) {
    const parsed = parseMessageRow(r, nowIso());
    const ts = parsed.ts;
    // Track the max ts seen in this run for the post-loop STATE emit.
    // Slack ts is a fixed-shape "seconds.micros" string; string compare
    // matches numeric order because both halves are zero-padded by Slack.
    if (ts && (maxMessageTs === null || ts > maxMessageTs)) {
      maxMessageTs = ts;
    }
    if (wantMessages) {
      await deps.emitRecord("messages", buildMessageRecord(parsed));
    }
    if (wantReactions) {
      for (const rec of buildReactionRecords(parsed)) {
        await deps.emitRecord("reactions", rec);
      }
    }
    if (wantMsgAttachments) {
      for (const rec of buildMessageAttachmentRecords(parsed)) {
        await deps.emitRecord("message_attachments", rec);
      }
    }
  }
  return { maxMessageTs };
}
