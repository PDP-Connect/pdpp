#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Pocket Connector (v0.1.0) — DEPRECATED.
 *
 * Mozilla shut Pocket down on 2025-07-08; all user data was deleted by
 * 2025-10-08. The developer portal is gone; new consumer keys can no longer
 * be issued; the v3 API returns 404. This connector is kept on disk purely
 * for historical reference and is excluded from register-all. Do not run.
 *
 * If you have an old Pocket export (HTML from the user's "Export" page), a
 * file-based variant could still parse it. That path is deferred — nobody
 * who comes to PDPP after 2025-07-08 has fresh Pocket data.
 *
 * Auth: POCKET_CONSUMER_KEY + POCKET_ACCESS_TOKEN env vars (retained only
 * to keep the 0.1.0 manifest shape stable for archival purposes).
 */

import { type RecordData, runConnector } from "../../src/connector-runtime.ts";
import { validateRecord } from "./schemas.ts";

interface PocketAuthor {
  name?: string;
}

interface PocketTags {
  [name: string]: unknown;
}

interface PocketItem {
  authors?: Record<string, PocketAuthor>;
  favorite?: string;
  given_title?: string | null;
  given_url?: string;
  item_id: string;
  resolved_title?: string | null;
  resolved_url?: string;
  status?: string;
  tags?: PocketTags;
  time_added?: string | number;
  time_favorited?: string | number;
  time_read?: string | number;
  time_to_read?: string;
  time_updated?: string | number;
  word_count?: string;
}

interface PocketGetResponse {
  list?: Record<string, PocketItem> | unknown[];
}

interface PocketRequestBody {
  access_token: string;
  consumer_key: string;
  count: number;
  detailType: string;
  offset?: number;
  since?: number;
  sort: string;
  state: string;
}

const POCKET_PAGE_SIZE = 500;
const SERVER_ERROR_PATTERN = /5\d\d/;
const POCKET_URL = "https://getpocket.com/v3/get";

const isoFromUnix = (u: string | number | undefined | null): string | null =>
  u ? new Date(Number(u) * 1000).toISOString() : null;

function itemRecord(it: PocketItem): RecordData {
  // Pocket status: '0' = unread, '1' = archived, '2' = deleted (tombstone).
  const itemId = String(it.item_id);
  return {
    id: itemId,
    status: it.status,
    url: it.resolved_url || it.given_url,
    title: it.resolved_title || it.given_title || null,
    author: it.authors
      ? Object.values(it.authors)
          .map((a) => a.name)
          .filter(Boolean)
          .join(", ")
      : null,
    time_added: isoFromUnix(it.time_added),
    time_updated: isoFromUnix(it.time_updated),
    time_read: isoFromUnix(it.time_read),
    time_favorited: isoFromUnix(it.time_favorited),
    tags: it.tags ? Object.keys(it.tags) : [],
    archived: it.status === "1",
    favorite: it.favorite === "1",
    word_count: it.word_count ? Number.parseInt(it.word_count, 10) : null,
    reading_time_minutes: it.time_to_read ? Number.parseInt(it.time_to_read, 10) : null,
  };
}

async function fetchPocketPage(body: PocketRequestBody, offset: number): Promise<PocketItem[]> {
  const res = await fetch(POCKET_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Accept": "application/json",
    },
    body: JSON.stringify({ ...body, offset }),
  });
  if (res.status === 401) {
    throw new Error("pocket_auth_failed");
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    const msg = `pocket_http_${String(res.status)}: ${text}`;
    if (SERVER_ERROR_PATTERN.test(String(res.status))) {
      throw new Error(`${msg} (retryable)`);
    }
    throw new Error(msg);
  }
  const data = (await res.json()) as PocketGetResponse;
  if (!(data.list && typeof data.list === "object") || Array.isArray(data.list)) {
    return [];
  }
  return Object.values(data.list) as PocketItem[];
}

runConnector({
  name: "pocket",
  validateRecord,
  retryablePattern: /ECONN|fetch failed/i,
  auth: {
    kind: "env",
    required: ["POCKET_CONSUMER_KEY", "POCKET_ACCESS_TOKEN"],
  },
  // Pocket status '2' = deleted (tombstone).
  isTombstone: (_stream, d) => d.status === "2",
  async collect({ state, requested, credentials, emit, emitRecord, progress }) {
    const consumerKey = credentials.POCKET_CONSUMER_KEY;
    const accessToken = credentials.POCKET_ACCESS_TOKEN;
    if (!(consumerKey && accessToken)) {
      throw new Error("pocket_auth_failed");
    }

    if (!requested.has("items")) {
      return;
    }

    await progress("Fetching Pocket items", { stream: "items" });
    const itemsState = state.items as { last_time_updated_unix?: number } | undefined;
    const since = itemsState?.last_time_updated_unix;
    const body: PocketRequestBody = {
      consumer_key: consumerKey,
      access_token: accessToken,
      detailType: "complete",
      state: "all",
      sort: "oldest",
      count: POCKET_PAGE_SIZE,
      ...(since === undefined ? {} : { since }),
    };
    let offset = 0;
    let latest = since || 0;
    while (true) {
      const items = await fetchPocketPage(body, offset);
      if (!items.length) {
        break;
      }
      for (const it of items) {
        const updated = Number.parseInt(String(it.time_updated || it.time_added || "0"), 10);
        await emitRecord("items", itemRecord(it));
        if (updated > latest) {
          latest = updated;
        }
      }
      offset += items.length;
      if (items.length < POCKET_PAGE_SIZE) {
        break;
      }
    }
    await emit({
      type: "STATE",
      stream: "items",
      cursor: { last_time_updated_unix: latest || null },
    });
  },
});
