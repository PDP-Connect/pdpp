/**
 * Schema tests for the Pocket connector. The connector is DEPRECATED (API gone)
 * but still declares the `items` stream and wires `validateRecord`; parsing is
 * inline in index.ts, so these assert the schema against a literal record
 * shaped exactly as the `itemRecord` builder emits it — the authoritative
 * emitted shape that a future file-based re-import variant would also produce.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { itemsSchema, validateRecord } from "./schemas.ts";

// An item record exactly as itemRecord emits it. Pocket item_ids are numeric
// strings; status is the "0"/"1"/"2" code; time_* are ISO from unix seconds.
const ITEM_RECORD = {
  id: "229279689",
  status: "0",
  url: "https://example.com/great-article",
  title: "The Great Article",
  author: "Jane Doe, John Smith",
  time_added: "2024-01-15T08:30:00.000Z",
  time_updated: "2024-02-01T12:00:00.000Z",
  time_read: "2024-01-20T19:45:00.000Z",
  time_favorited: "2024-01-16T10:00:00.000Z",
  tags: ["longreads", "tech"],
  archived: false,
  favorite: true,
  word_count: 2400,
  reading_time_minutes: 11,
};

test("items schema accepts a representative emitted record", () => {
  const result = itemsSchema.safeParse(ITEM_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("items schema accepts an archived item with no tags and null read/favorite times", () => {
  const result = itemsSchema.safeParse({
    ...ITEM_RECORD,
    status: "1",
    archived: true,
    favorite: false,
    tags: [],
    time_read: null,
    time_favorited: null,
    word_count: null,
    reading_time_minutes: null,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("items schema accepts a tombstone (status 2 / deleted item)", () => {
  const result = itemsSchema.safeParse({ ...ITEM_RECORD, status: "2" });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("items schema rejects a non-numeric id (String(item_id) regression)", () => {
  assert.equal(itemsSchema.safeParse({ ...ITEM_RECORD, id: "item-229279689" }).success, false);
});

test("items schema rejects an out-of-range status code (API drift)", () => {
  assert.equal(itemsSchema.safeParse({ ...ITEM_RECORD, status: "3" }).success, false);
});

test("items schema rejects a non-URL url (raw title leaked into url field)", () => {
  assert.equal(itemsSchema.safeParse({ ...ITEM_RECORD, url: "The Great Article" }).success, false);
});

test("validateRecord routes by stream and passes unknown streams through", () => {
  assert.equal(validateRecord("items", ITEM_RECORD).ok, true);
  assert.equal(validateRecord("highlights", { id: "1" }).ok, true);
});
