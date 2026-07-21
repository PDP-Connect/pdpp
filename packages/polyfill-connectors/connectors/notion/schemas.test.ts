/**
 * Schema tests for the Notion connector. Parsing is inline in index.ts (no
 * parsers.ts), so these assert the schema against literal records shaped
 * exactly as `toPageRecord` / `toDatabaseRecord` build them — the authoritative
 * emitted shape. SLVP "validate representative emitted records".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { databasesSchema, pagesSchema, validateRecord } from "./schemas.ts";

// A page record exactly as toPageRecord emits it. Notion returns dashed UUIDs;
// title is free-form text; url is a notion.so URL.
const PAGE_RECORD = {
  id: "59833787-2cf9-4fdf-8782-e53db20768a5",
  object: "page",
  parent_type: "workspace",
  parent_id: null,
  title: "Q3 Planning Notes",
  url: "https://www.notion.so/Q3-Planning-Notes-598337872cf94fdf8782e53db20768a5",
  archived: false,
  created_time: "2024-02-01T12:00:00.000Z",
  last_edited_time: "2024-03-15T09:30:00.000Z",
  created_by_id: "a1b2c3d4-0000-1111-2222-333344445555",
  last_edited_by_id: "a1b2c3d4-0000-1111-2222-333344445555",
};

// A database record exactly as toDatabaseRecord emits it.
const DATABASE_RECORD = {
  id: "98ad959b-2b6a-4774-80ee-00246fb0ea9b",
  title: "Tasks",
  parent_type: "page_id",
  parent_id: "59833787-2cf9-4fdf-8782-e53db20768a5",
  url: "https://www.notion.so/98ad959b2b6a477480ee00246fb0ea9b",
  archived: false,
  created_time: "2024-02-01T12:00:00.000Z",
  last_edited_time: "2024-03-15T09:30:00.000Z",
  property_names: ["Name", "Status", "Due date", "Assignee"],
};

test("pages schema accepts a representative emitted record", () => {
  const result = pagesSchema.safeParse(PAGE_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("pages schema accepts a child page with a dash-stripped parent id and null title", () => {
  const result = pagesSchema.safeParse({
    ...PAGE_RECORD,
    parent_type: "page_id",
    parent_id: "598337872cf94fdf8782e53db20768a5", // 32-hex, no dashes
    title: null,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("databases schema accepts a representative emitted record", () => {
  const result = databasesSchema.safeParse(DATABASE_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("databases schema accepts an empty-property database (no columns yet)", () => {
  const result = databasesSchema.safeParse({ ...DATABASE_RECORD, property_names: [] });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("pages schema rejects a non-UUID id (search-result drift / wrong object captured)", () => {
  assert.equal(pagesSchema.safeParse({ ...PAGE_RECORD, id: "page-not-a-uuid" }).success, false);
});

test("pages schema rejects a non-URL url (parser captured raw text instead of href)", () => {
  assert.equal(pagesSchema.safeParse({ ...PAGE_RECORD, url: "Q3 Planning Notes" }).success, false);
});

test("databases schema rejects property_names containing a non-string (Object.keys drift)", () => {
  assert.equal(databasesSchema.safeParse({ ...DATABASE_RECORD, property_names: ["Name", 42] }).success, false);
});

test("validateRecord routes by stream and passes unknown streams through", () => {
  assert.equal(validateRecord("pages", PAGE_RECORD).ok, true);
  assert.equal(validateRecord("databases", DATABASE_RECORD).ok, true);
  assert.equal(validateRecord("blocks", { id: "x" }).ok, true);
});
