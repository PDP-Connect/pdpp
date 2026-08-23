import assert from "node:assert/strict";
import test from "node:test";
import { walkPagesWithCeiling } from "./page-ceiling.ts";

test("walkPagesWithCeiling distinguishes terminal exhaustion from a capped continuation", async () => {
  const completedPages: number[] = [];
  const complete = await walkPagesWithCeiling({
    maxPages: 2,
    fetchPage: (pageNumber) => {
      completedPages.push(pageNumber);
      return pageNumber < 2;
    },
  });
  assert.deepEqual(complete, { pagesFetched: 2, truncated: false });
  assert.deepEqual(completedPages, [1, 2]);

  const cappedPages: number[] = [];
  const capped = await walkPagesWithCeiling({
    maxPages: 2,
    fetchPage: (pageNumber) => {
      cappedPages.push(pageNumber);
      return true;
    },
  });
  assert.deepEqual(capped, { pagesFetched: 2, truncated: true });
  assert.deepEqual(cappedPages, [1, 2]);
});
