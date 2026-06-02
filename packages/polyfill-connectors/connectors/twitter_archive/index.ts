#!/usr/bin/env node

/**
 * PDPP Twitter/X Archive Connector (v0.1.0)
 *
 * Auth: none. User requests their Twitter archive at
 *   https://twitter.com/settings/download_your_data
 * extracts the .zip into TWITTER_ARCHIVE_DIR (defaults
 * ~/.pdpp/imports/twitter_archive/), and runs this connector.
 *
 * The archive contains JS files that assign to a global — we strip the
 * prefix to get JSON. Expected files:
 *   data/tweets.js  (or data/tweet.js in older archives)
 *   data/direct-messages.js
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type EmittedMessage, runConnector } from "../../src/connector-runtime.ts";
import {
  advanceCursor,
  buildDmRecord,
  buildTweetRecord,
  isBeforeCursor,
  stripJsArchive,
  unwrapDmConversation,
  unwrapDmMessage,
  unwrapTweetEntry,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { StreamState } from "./types.ts";

async function readJsArchive(path: string): Promise<unknown[] | null> {
  if (!existsSync(path)) {
    return null;
  }
  const text = await readFile(path, "utf8");
  // Archive files start like:  window.YTD.tweets.part0 = [ ... ]
  return stripJsArchive(text);
}

/**
 * Locate `tweets.js`, falling back to the older `tweet.js` filename some
 * archives use. Returns the parsed array, or null when neither file is
 * present.
 */
async function loadTweetArchive(importDir: string): Promise<unknown[] | null> {
  const modern = await readJsArchive(join(importDir, "data", "tweets.js"));
  if (modern) {
    return modern;
  }
  return readJsArchive(join(importDir, "data", "tweet.js"));
}

interface TweetsContext {
  emit: (msg: EmittedMessage) => Promise<void>;
  emitRecord: (stream: string, rec: Record<string, unknown>) => Promise<void>;
  importDir: string;
  state: StreamState | undefined;
}

async function runTweetsStream(ctx: TweetsContext): Promise<void> {
  const { emit, emitRecord, importDir, state } = ctx;
  const arr = await loadTweetArchive(importDir);
  if (!arr) {
    await emit({
      type: "SKIP_RESULT",
      stream: "tweets",
      reason: "archive_not_found",
      message: "Twitter archive tweets data was not found in the configured import directory",
    });
    return;
  }
  const since = state?.last_created_at;
  let latest: string | undefined = since;
  await emit({
    type: "PROGRESS",
    stream: "tweets",
    message: `Twitter archive phase=emit pass=emit stream=tweets total_items=${arr.length}`,
  });
  let itemOrdinal = 0;
  for (const raw of arr) {
    itemOrdinal++;
    const tweet = unwrapTweetEntry(raw);
    const rec = buildTweetRecord(tweet);
    if (!rec) {
      continue;
    }
    if (isBeforeCursor(rec.created_at, since)) {
      continue;
    }
    latest = advanceCursor(latest, rec.created_at);
    await emitRecord("tweets", { ...rec });
    if (itemOrdinal % 10_000 === 0) {
      await emit({
        type: "PROGRESS",
        stream: "tweets",
        message: `Twitter archive phase=emit pass=emit stream=tweets item=${itemOrdinal}/${arr.length}`,
      });
    }
  }
  await emit({
    type: "STATE",
    stream: "tweets",
    cursor: { last_created_at: latest },
  });
}

interface DmsContext {
  emit: (msg: EmittedMessage) => Promise<void>;
  emitRecord: (stream: string, rec: Record<string, unknown>) => Promise<void>;
  importDir: string;
  state: StreamState | undefined;
}

/** Cursor box threaded through the per-message loop. */
interface DmCursor {
  latest: string | undefined;
  since: string | undefined;
}

async function emitDmConversation(
  rawConvo: unknown,
  cursor: DmCursor,
  emitRecord: DmsContext["emitRecord"]
): Promise<void> {
  const conversation = unwrapDmConversation(rawConvo);
  const convId = conversation.conversationId || null;
  for (const msg of conversation.messages || []) {
    const mm = unwrapDmMessage(msg);
    const rec = buildDmRecord(mm, convId);
    if (!rec) {
      continue;
    }
    if (isBeforeCursor(rec.created_at, cursor.since)) {
      continue;
    }
    cursor.latest = advanceCursor(cursor.latest, rec.created_at);
    await emitRecord("direct_messages", { ...rec });
  }
}

async function runDirectMessagesStream(ctx: DmsContext): Promise<void> {
  const { emit, emitRecord, importDir, state } = ctx;
  const arr = await readJsArchive(join(importDir, "data", "direct-messages.js"));
  if (!arr) {
    await emit({
      type: "SKIP_RESULT",
      stream: "direct_messages",
      reason: "archive_not_found",
      message: "Twitter archive direct-message data was not found in the configured import directory",
    });
    return;
  }
  const cursor: DmCursor = {
    since: state?.last_created_at,
    latest: state?.last_created_at,
  };
  await emit({
    type: "PROGRESS",
    stream: "direct_messages",
    message: `Twitter archive phase=emit pass=emit stream=direct_messages total_conversations=${arr.length}`,
  });
  let conversationOrdinal = 0;
  for (const rawConvo of arr) {
    conversationOrdinal++;
    await emitDmConversation(rawConvo, cursor, emitRecord);
    if (conversationOrdinal % 1000 === 0) {
      await emit({
        type: "PROGRESS",
        stream: "direct_messages",
        message: `Twitter archive phase=emit pass=emit stream=direct_messages conversation=${conversationOrdinal}/${arr.length}`,
      });
    }
  }
  await emit({
    type: "STATE",
    stream: "direct_messages",
    cursor: { last_created_at: cursor.latest },
  });
}

runConnector({
  name: "twitter_archive",
  validateRecord,
  async collect({ state, requested, emit, emitRecord }) {
    const importDir = process.env.TWITTER_ARCHIVE_DIR || join(homedir(), ".pdpp/imports/twitter_archive");
    const typedState = state as Record<string, StreamState | undefined>;

    if (requested.has("tweets")) {
      await runTweetsStream({
        importDir,
        state: typedState.tweets,
        emit,
        emitRecord,
      });
    }

    if (requested.has("direct_messages")) {
      await runDirectMessagesStream({
        importDir,
        state: typedState.direct_messages,
        emit,
        emitRecord,
      });
    }
  },
});
