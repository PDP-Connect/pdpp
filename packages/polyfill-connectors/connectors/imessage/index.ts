#!/usr/bin/env node

/**
 * PDPP iMessage Connector (v0.1.0)
 *
 * Reads ~/Library/Messages/chat.db (macOS only by default). SQLite is
 * read-only opened. User may override with IMESSAGE_DB_PATH env var (useful
 * for copying chat.db off a machine and running the connector on Linux).
 *
 * Incremental via message.date (Apple epoch: seconds/nanos since 2001-01-01).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// biome-ignore lint/correctness/noUnresolvedImports: @databases/sqlite is declared in package.json but Biome's resolver may see a stale cache after pnpm add; tsc resolves it correctly
import connect, { sql } from "@databases/sqlite";
import { runConnector } from "../../src/connector-runtime.ts";

interface MessageRow {
  cache_has_attachments: number | null;
  chat_id: number | null;
  date: number | null;
  date_read: number | null;
  guid: string | null;
  handle: string | null;
  id: number;
  is_from_me: number;
  service: string | null;
  text: string | null;
}

// Apple cocoa epoch offset: seconds from 1970 to 2001-01-01 UTC.
const APPLE_EPOCH_SEC = 978_307_200;
const APPLE_NANOS_THRESHOLD = 1e10;
const APPLE_NANOS_DIVISOR = 1e9;
const MS_PER_SEC = 1000;

function appleDateToIso(raw: number | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  // Newer macOS: nanoseconds; older: seconds. Heuristic: > 1e10 → nanos.
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return null;
  }
  const sec = n > APPLE_NANOS_THRESHOLD ? n / APPLE_NANOS_DIVISOR : n;
  return new Date((APPLE_EPOCH_SEC + sec) * MS_PER_SEC).toISOString();
}

runConnector({
  name: "imessage",
  async collect({ state, requested, emit, emitRecord, progress }) {
    const dbPath =
      process.env.IMESSAGE_DB_PATH ||
      join(homedir(), "Library/Messages/chat.db");
    if (!existsSync(dbPath)) {
      throw new Error(
        `imessage_db_not_found: ${dbPath}. On macOS the path is ~/Library/Messages/chat.db; on Linux copy it over and set IMESSAGE_DB_PATH.`
      );
    }

    // @ts-expect-error — @databases/sqlite exports default function, but its
    // CJS-shaped .d.ts types the default export as a namespace rather than a
    // callable. Runtime invocation works (verified live).
    const db = connect(dbPath);

    if (!requested.has("messages")) {
      return;
    }

    const messagesState = (state.messages ?? {}) as {
      last_apple_date?: number;
    };
    const since = messagesState.last_apple_date ?? 0;
    await progress("Reading chat.db", { stream: "messages" });

    const rows = (await db
      .query(sql`
        SELECT m.ROWID as id, m.guid, m.handle_id, m.service, m.is_from_me,
               m.text, m.date, m.date_read, m.cache_has_attachments,
               h.id as handle,
               cmj.chat_id as chat_id
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        WHERE m.date > ${since}
        ORDER BY m.date ASC
      `)
      .catch(async (err: unknown): Promise<unknown[]> => {
        const msg = err instanceof Error ? err.message : String(err);
        await emit({
          type: "SKIP_RESULT",
          stream: "messages",
          reason: "db_query_failed",
          message: msg.slice(0, 200),
        });
        return [];
      })) as MessageRow[];

    let latestApple = since;
    for (const r of rows) {
      await emitRecord("messages", {
        id: r.guid || String(r.id),
        chat_id: r.chat_id ? String(r.chat_id) : null,
        handle: r.handle ?? null,
        service: r.service ?? null,
        is_from_me: Boolean(r.is_from_me),
        text: r.text ?? null,
        date: appleDateToIso(r.date) ?? new Date().toISOString(),
        date_read: appleDateToIso(r.date_read),
        has_attachments: Boolean(r.cache_has_attachments),
      });
      if (r.date && Number(r.date) > latestApple) {
        latestApple = Number(r.date);
      }
    }
    await emit({
      type: "STATE",
      stream: "messages",
      cursor: { last_apple_date: latestApple },
    });
  },
});
