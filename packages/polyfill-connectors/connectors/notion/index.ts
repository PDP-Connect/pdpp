#!/usr/bin/env node
/**
 * PDPP Notion Connector (v0.1.0)
 *
 * Auth: Notion internal integration token via NOTION_API_TOKEN env var.
 * Create at https://www.notion.so/profile/integrations. The integration must
 * be explicitly shared with each page/database (Notion security model).
 *
 * API: https://api.notion.com/v1/search (POST)
 * Rate limit: 3 req/s average.
 */

import { createConnectorHttpGovernor } from "../../src/connector-http-governor.ts";
import { politeDelay, runConnector } from "../../src/connector-runtime.ts";
import { validateRecord } from "./schemas.ts";

// Single per-provider send governor + retry layer. `maxAttempts: 1` keeps the
// 429 throw byte-identical (cross-run cooldown via `retryablePattern`).
const httpGovernor = createConnectorHttpGovernor({ name: "notion", maxAttempts: 1 });

const API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const PAGE_SIZE = 100;
const POLITE_DELAY_MS = 400;

interface ProgressExtra {
  cursor_present?: boolean;
  item_count?: number;
  page_index?: number;
  phase?: string;
  rate_limit_pressure?: number;
  stream?: string;
  total_seen?: number;
}

interface NotionTitlePart {
  plain_text?: string;
}

interface NotionParent {
  database_id?: string;
  page_id?: string;
  type?: string;
  workspace?: boolean | string;
}

interface NotionProperty {
  title?: NotionTitlePart[];
  type?: string;
}

interface NotionObject {
  archived?: boolean;
  created_by?: { id?: string } | null;
  created_time?: string | null;
  id: string;
  last_edited_by?: { id?: string } | null;
  last_edited_time?: string | null;
  object?: string;
  parent?: NotionParent | null;
  properties?: Record<string, NotionProperty>;
  title?: NotionTitlePart[];
  url?: string | null;
}

interface NotionSearchResponse {
  has_more?: boolean;
  next_cursor?: string | null;
  results: NotionObject[];
}

interface NotionSearchFilter {
  property: string;
  value: string;
}

interface NotionSearchBody {
  filter?: NotionSearchFilter;
  page_size: number;
  sort: { direction: string; timestamp: string };
  start_cursor?: string;
}

async function ntn(
  path: string,
  token: string,
  body: NotionSearchBody,
  progress?: (message: string, extra?: ProgressExtra) => Promise<void>,
  extra?: ProgressExtra
): Promise<NotionSearchResponse> {
  let raw: { body: string; status: number };
  try {
    const r = await httpGovernor.request<{ body: string; status: number }, { body: string; status: number }>(
      async () => {
        const res = await fetch(`${API}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        const retryAfter = res.headers.get("retry-after");
        return {
          body: await res.text().catch((): string => ""),
          ...(retryAfter == null ? {} : { headers: { "retry-after": retryAfter } }),
          status: res.status,
        } as { body: string; status: number };
      },
      (resp) => ({ status: resp.status, value: resp })
    );
    raw = r.value;
  } catch (error) {
    if (error instanceof Error && error.message === "notion_rate_limited") {
      await progress?.("Notion search rate limited", { ...extra, phase: "rate_limit", rate_limit_pressure: 1 });
    }
    throw error;
  }
  if (raw.status === 401) {
    throw new Error("notion_auth_failed");
  }
  if (raw.status < 200 || raw.status >= 300) {
    throw new Error(`notion_http_${String(raw.status)}: ${raw.body.slice(0, 200)}`);
  }
  return JSON.parse(raw.body) as NotionSearchResponse;
}

function extractTitle(obj: NotionObject): string | null {
  // Pages: properties[*].title[].plain_text   Databases: title[].plain_text
  if (obj.properties) {
    for (const p of Object.values(obj.properties)) {
      if (p?.type === "title" && Array.isArray(p.title)) {
        return p.title.map((t) => t.plain_text || "").join("") || null;
      }
    }
  }
  if (Array.isArray(obj.title)) {
    return obj.title.map((t) => t.plain_text || "").join("") || null;
  }
  return null;
}

function parentId(parent: NotionParent | null | undefined): string | null {
  if (!parent) {
    return null;
  }
  if (parent.page_id) {
    return parent.page_id;
  }
  if (parent.database_id) {
    return parent.database_id;
  }
  if (parent.workspace) {
    return typeof parent.workspace === "string" ? parent.workspace : null;
  }
  return null;
}

async function searchAll(
  token: string,
  filter: NotionSearchFilter | undefined,
  progress: (message: string, extra?: ProgressExtra) => Promise<void>,
  streamName: string
): Promise<NotionObject[]> {
  const results: NotionObject[] = [];
  let cursor: string | undefined;
  let pageIndex = 0;
  while (true) {
    const body: NotionSearchBody = {
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: PAGE_SIZE,
    };
    if (filter) {
      body.filter = filter;
    }
    if (cursor) {
      body.start_cursor = cursor;
    }
    const pageExtra = {
      stream: streamName,
      phase: "fetch",
      page_index: pageIndex,
      total_seen: results.length,
      cursor_present: Boolean(cursor),
    };
    await progress("Fetching Notion search page", pageExtra);
    const json = await ntn("/search", token, body, progress, pageExtra);
    results.push(...(json.results || []));
    await progress("Fetched Notion search page", {
      stream: streamName,
      phase: "page",
      page_index: pageIndex,
      item_count: json.results?.length ?? 0,
      total_seen: results.length,
      cursor_present: Boolean(json.has_more && json.next_cursor),
    });
    if (!(json.has_more && json.next_cursor)) {
      break;
    }
    cursor = json.next_cursor;
    pageIndex++;
    await politeDelay(POLITE_DELAY_MS);
  }
  return results;
}

function toPageRecord(p: NotionObject): Record<string, unknown> {
  return {
    id: p.id,
    object: p.object,
    parent_type: p.parent?.type ?? null,
    parent_id: parentId(p.parent),
    title: extractTitle(p),
    url: p.url ?? null,
    archived: p.archived ?? null,
    created_time: p.created_time ?? null,
    last_edited_time: p.last_edited_time ?? null,
    created_by_id: p.created_by?.id ?? null,
    last_edited_by_id: p.last_edited_by?.id ?? null,
  };
}

function toDatabaseRecord(d: NotionObject): Record<string, unknown> {
  return {
    id: d.id,
    title: extractTitle(d),
    parent_type: d.parent?.type ?? null,
    parent_id: parentId(d.parent),
    url: d.url ?? null,
    archived: d.archived ?? null,
    created_time: d.created_time ?? null,
    last_edited_time: d.last_edited_time ?? null,
    property_names: d.properties ? Object.keys(d.properties) : [],
  };
}

interface RunStreamArgs {
  emit: (msg: { type: "STATE"; stream: string; cursor: unknown }) => Promise<void>;
  emitRecord: (stream: string, data: Record<string, unknown>) => Promise<void>;
  filter: NotionSearchFilter;
  progress: (message: string, extra?: ProgressExtra) => Promise<void>;
  state: Record<string, unknown>;
  streamName: string;
  token: string;
  toRecord: (o: NotionObject) => Record<string, unknown>;
}

async function runStream(args: RunStreamArgs): Promise<void> {
  const { streamName, filter, toRecord, state, token, emit, emitRecord, progress } = args;
  await progress(`Searching ${streamName}`, { stream: streamName, phase: "start" });
  const items = await searchAll(token, filter, progress, streamName);
  const streamState = state[streamName] as { last_edited_time?: string } | undefined;
  const prior = streamState?.last_edited_time;
  let latest = prior;
  for (const item of items) {
    if (prior && item.last_edited_time && item.last_edited_time <= prior) {
      continue;
    }
    await emitRecord(streamName, toRecord(item));
    if (item.last_edited_time && (!latest || item.last_edited_time > latest)) {
      latest = item.last_edited_time;
    }
  }
  await progress(`Emitted ${streamName}`, {
    stream: streamName,
    phase: "emit",
    item_count: items.length,
    total_seen: items.length,
    cursor_present: Boolean(latest || prior),
  });
  await emit({
    type: "STATE",
    stream: streamName,
    cursor: { last_edited_time: latest || prior || null },
  });
}

runConnector({
  name: "notion",
  validateRecord,
  retryablePattern: /ECONN|fetch failed|rate_limited/i,
  auth: { kind: "env", required: ["NOTION_API_TOKEN"] },
  // Notion marks deleted items with archived=true rather than omitting them.
  isTombstone: (_stream, d) => d.archived === true,
  async collect({ state, requested, credentials, emit, emitRecord, progress }) {
    const token = credentials.NOTION_API_TOKEN;
    if (!token) {
      throw new Error("notion_auth_failed");
    }

    if (requested.has("pages")) {
      await runStream({
        streamName: "pages",
        filter: { property: "object", value: "page" },
        toRecord: toPageRecord,
        state,
        token,
        emit,
        emitRecord,
        progress,
      });
    }

    if (requested.has("databases")) {
      await runStream({
        streamName: "databases",
        filter: { property: "object", value: "database" },
        toRecord: toDatabaseRecord,
        state,
        token,
        emit,
        emitRecord,
        progress,
      });
    }
  },
});
