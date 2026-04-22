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
import { runConnector } from "../../src/connector-runtime.ts";

interface TweetEntities {
  media?: unknown[];
  urls?: unknown[];
}

interface TweetShape {
  created_at?: string;
  entities?: TweetEntities;
  favorite_count?: string | number;
  full_text?: string | null;
  id?: string;
  id_str?: string;
  in_reply_to_screen_name?: string | null;
  in_reply_to_status_id_str?: string | null;
  lang?: string | null;
  retweet_count?: string | number;
  text?: string | null;
}

interface TweetEntry {
  tweet?: TweetShape;
  [k: string]: unknown;
}

interface DMShape {
  createdAt?: string;
  id?: string;
  recipientId?: string | null;
  senderId?: string | null;
  text?: string | null;
}

interface DMMessage {
  messageCreate?: DMShape;
  [k: string]: unknown;
}

interface DMConversation {
  conversationId?: string | null;
  messages?: DMMessage[];
}

interface DMEntry {
  dmConversation?: DMConversation;
  [k: string]: unknown;
}

interface StreamState {
  last_created_at?: string;
}

// Module-level regexes (Biome useTopLevelRegex).
const WINDOW_ASSIGN_PREFIX_RE = /^[^=]*=\s*/;
const TRAILING_SEMICOLON_RE = /;?\s*$/;

async function readJsArchive(path: string): Promise<unknown[] | null> {
  if (!existsSync(path)) {
    return null;
  }
  const text = await readFile(path, "utf8");
  // Archive files start like:  window.YTD.tweets.part0 = [ ... ]
  const stripped = text
    .replace(WINDOW_ASSIGN_PREFIX_RE, "")
    .trim()
    .replace(TRAILING_SEMICOLON_RE, "");
  try {
    const parsed = JSON.parse(stripped) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

runConnector({
  name: "twitter_archive",
  async collect({ state, requested, emit, emitRecord }) {
    const importDir =
      process.env.TWITTER_ARCHIVE_DIR ||
      join(homedir(), ".pdpp/imports/twitter_archive");

    const typedState = state as Record<string, StreamState | undefined>;

    if (requested.has("tweets")) {
      let arr = await readJsArchive(join(importDir, "data", "tweets.js"));
      if (!arr) {
        arr = await readJsArchive(join(importDir, "data", "tweet.js"));
      }
      if (arr) {
        const since = typedState.tweets?.last_created_at;
        let latest: string | undefined = since;
        await emit({
          type: "PROGRESS",
          stream: "tweets",
          message: `Importing ${arr.length} tweets`,
        });
        for (const rawEntry of arr) {
          const entry = rawEntry as TweetEntry;
          const t: TweetShape = entry.tweet || (entry as TweetShape);
          const createdAt = t.created_at
            ? new Date(t.created_at).toISOString()
            : null;
          if (!createdAt) {
            continue;
          }
          if (since && createdAt <= since) {
            continue;
          }
          await emitRecord("tweets", {
            id: t.id_str || t.id || null,
            text: t.full_text ?? t.text ?? null,
            created_at: createdAt,
            favorite_count: t.favorite_count
              ? Number.parseInt(String(t.favorite_count), 10)
              : null,
            retweet_count: t.retweet_count
              ? Number.parseInt(String(t.retweet_count), 10)
              : null,
            in_reply_to_status_id: t.in_reply_to_status_id_str ?? null,
            in_reply_to_screen_name: t.in_reply_to_screen_name ?? null,
            lang: t.lang ?? null,
            media_count: (t.entities?.media || []).length,
            url_count: (t.entities?.urls || []).length,
          });
          if (!latest || createdAt > latest) {
            latest = createdAt;
          }
        }
        await emit({
          type: "STATE",
          stream: "tweets",
          cursor: { last_created_at: latest },
        });
      } else {
        await emit({
          type: "SKIP_RESULT",
          stream: "tweets",
          reason: "archive_not_found",
          message: `tweets.js not found in ${importDir}/data/`,
        });
      }
    }

    if (requested.has("direct_messages")) {
      const arr = await readJsArchive(
        join(importDir, "data", "direct-messages.js")
      );
      if (arr) {
        const since = typedState.direct_messages?.last_created_at;
        let latest: string | undefined = since;
        for (const rawConvo of arr) {
          const convo = rawConvo as DMEntry;
          const conversation: DMConversation =
            convo.dmConversation || (convo as DMConversation);
          const convId = conversation.conversationId || null;
          for (const m of conversation.messages || []) {
            const mm: DMShape = m.messageCreate || (m as DMShape);
            const createdAt = mm.createdAt
              ? new Date(mm.createdAt).toISOString()
              : null;
            if (!createdAt) {
              continue;
            }
            if (since && createdAt <= since) {
              continue;
            }
            await emitRecord("direct_messages", {
              id: mm.id ?? null,
              conversation_id: convId,
              sender_id: mm.senderId ?? null,
              recipient_id: mm.recipientId ?? null,
              created_at: createdAt,
              text: mm.text ?? null,
            });
            if (!latest || createdAt > latest) {
              latest = createdAt;
            }
          }
        }
        await emit({
          type: "STATE",
          stream: "direct_messages",
          cursor: { last_created_at: latest },
        });
      } else {
        await emit({
          type: "SKIP_RESULT",
          stream: "direct_messages",
          reason: "archive_not_found",
          message: `direct-messages.js not found in ${importDir}/data/`,
        });
      }
    }
  },
});
