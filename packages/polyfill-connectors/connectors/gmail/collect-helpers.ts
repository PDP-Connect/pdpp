/**
 * Collect-layer helpers for the Gmail connector.
 *
 * Lives in its own file (not index.ts) because index.ts runs `main()` at
 * module load — it opens stdin, talks the runtime protocol, and connects
 * to IMAP. Importing it from test code would keep the Node event loop
 * alive. This file contains only pure/stateless helpers whose side
 * effects (body fetch, progress emit, clock read) are injected via the
 * `PerMessageDeps` contract.
 *
 * The helpers here are the "emit path" of the Phase-B body pass:
 *   processMessage(msg)   — per-message: picks streams, builds records,
 *                           calls injected fetchBodies, then emits.
 *   emitMessagesPass(metas) — loop driver: iterates metas and reports
 *                             progress every FETCH_MSG_PROGRESS rows.
 */

import type {
  FetchMessageObject,
  // biome-ignore lint/correctness/noUnresolvedImports: imapflow is declared in package.json; Biome's resolver doesn't see it here
} from "imapflow";
import {
  type BodyPartSelection,
  buildMessageBodyRecord,
  buildMessageRecord,
  decodeBodystructureForAttachments,
  isInTimeRange,
  selectBodyParts,
  toFlagsArray,
  toLabelsArray,
} from "./parsers.ts";
import type { ProgressMessage, StreamRequest } from "./types.ts";

/** Progress cadence for the body pass — emit a PROGRESS message every N
 *  processed rows. Exported so the extraction preserves observable
 *  behavior; tests rely on the boundary. */
export const FETCH_MSG_PROGRESS = 500;

export type EmitRecordFn = (stream: string, data: Record<string, unknown>, keyField?: "id" | "name") => Promise<void>;

export type ProgressEmitter = (msg: ProgressMessage) => Promise<void>;

/** Bodies resolved for one message. All fields may be null if the fetch
 *  failed, the message has no matching parts, or scope didn't ask. */
export interface FetchedBodies {
  bodyHtmlFull: string | null;
  bodyTextFull: string | null;
  snippet: string | null;
}

/**
 * Injected body fetcher. Production wires this to an IMAP round-trip;
 * tests wire it to a pure function that returns canned bodies (or a
 * rejected promise to simulate fetch failure — the helper turns that
 * into all-nulls internally).
 */
export type FetchBodiesFn = (
  msg: FetchMessageObject,
  selection: BodyPartSelection,
  wantBodies: boolean,
  wantMessages: boolean
) => Promise<FetchedBodies>;

export interface PerMessageDeps {
  emitProgress: ProgressEmitter;
  emitRecord: EmitRecordFn;
  fetchBodies: FetchBodiesFn;
  nowIso: () => string;
  requested: Map<string, StreamRequest>;
  timeRange: { since?: string; until?: string } | undefined;
  wantBodies: boolean;
  wantMessages: boolean;
}

function internalDateToIso(date: Date | string | undefined, nowIso: () => string): string {
  if (!date) {
    return nowIso();
  }
  return new Date(date).toISOString();
}

/**
 * Emit the per-stream records for one Gmail message.
 *
 * Invariants (tested in integration.test.ts):
 *   1. No X-GM-MSGID → skip silently (return false).
 *   2. time_range filter skips out-of-range messages.
 *   3. Emit order within a single message: message_bodies → messages →
 *      attachments. The per-message order matters because downstream
 *      consumers rely on bodies being present before the messages row
 *      that references them.
 *   4. wantBodies / wantMessages / requested.has("attachments") each
 *      gate their own stream; disabling one doesn't suppress siblings.
 *   5. Body-fetch failure (returned all-nulls) still emits the messages
 *      record with a null snippet — never silently drops the envelope.
 *
 * Returns true if the message produced any emits (or would have, modulo
 * scope). Returns false when skipped by an early filter so the caller
 * can skip progress accounting.
 */
export async function processMessage(deps: PerMessageDeps, msg: FetchMessageObject): Promise<boolean> {
  // Gmail-specific IDs via imapflow: msg.emailId = X-GM-MSGID; msg.threadId = X-GM-THRID.
  const gmMsgid = String(msg.emailId ?? "");
  const gmThrid = String(msg.threadId ?? "");
  if (!gmMsgid) {
    return false;
  }

  const env = msg.envelope ?? {};
  const receivedAt = internalDateToIso(msg.internalDate, deps.nowIso);
  if (!isInTimeRange(receivedAt, deps.timeRange)) {
    return false;
  }
  const dateHeader = env.date ? new Date(env.date).toISOString() : null;
  const flagsArr = toFlagsArray(msg.flags);
  const labels = toLabelsArray(msg.labels);
  const attachments = decodeBodystructureForAttachments(msg.bodyStructure, gmMsgid, receivedAt);

  const selection = selectBodyParts(msg.bodyStructure, deps.wantBodies);
  const { bodyHtmlFull, bodyTextFull, snippet } = await deps.fetchBodies(
    msg,
    selection,
    deps.wantBodies,
    deps.wantMessages
  );

  if (deps.wantBodies) {
    await deps.emitRecord(
      "message_bodies",
      buildMessageBodyRecord({
        bodyHtmlFull,
        bodyTextFull,
        gmMsgid,
        htmlCharset: selection.htmlCharset,
        textCharset: selection.plainCharset,
      })
    );
  }

  if (deps.wantMessages) {
    await deps.emitRecord(
      "messages",
      buildMessageRecord({
        attachmentsCount: attachments.length,
        dateHeader,
        envelope: env,
        flagsArr,
        gmMsgid,
        gmThrid,
        labels,
        rawHeaders: msg.headers,
        receivedAt,
        sizeBytes: typeof msg.size === "number" ? msg.size : null,
        snippet,
      })
    );
  }

  if (deps.requested.has("attachments") && attachments.length) {
    for (const a of attachments) {
      await deps.emitRecord("attachments", { ...a });
    }
  }
  return true;
}

/**
 * Phase B driver: iterate metas, emit records, report progress every
 * FETCH_MSG_PROGRESS rows. Per-message errors are logged to stderr and
 * swallowed so a single bad message doesn't halt the whole pass.
 */
export async function emitMessagesPass(deps: PerMessageDeps, metas: readonly FetchMessageObject[]): Promise<void> {
  let count = 0;
  for (const msg of metas) {
    try {
      const processed = await processMessage(deps, msg);
      if (!processed) {
        continue;
      }
      count += 1;
      if (count % FETCH_MSG_PROGRESS === 0) {
        await deps.emitProgress({
          type: "PROGRESS",
          stream: "messages",
          message: `Fetched ${count} messages`,
        });
      }
    } catch (perMsgErr) {
      const emsg = perMsgErr instanceof Error ? (perMsgErr.stack ?? perMsgErr.message) : String(perMsgErr);
      process.stderr.write(`[gmail] per-message error at UID ${String(msg.uid)}: ${emsg}\n`);
      // Continue with next message; don't let one bad record halt the whole run.
    }
  }
}
