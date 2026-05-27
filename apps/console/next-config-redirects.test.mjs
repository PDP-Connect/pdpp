import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("bare connector redirect excludes every top-level dashboard section", async () => {
  const src = await readFile(new URL("./next.config.mjs", import.meta.url), "utf8");
  const redirectPattern = src.match(/\/dashboard\/:connector\(\(\?!([^)]*)\)\[\^\/]\+\)\/:rest\*/)?.[1];
  assert.ok(redirectPattern, "connector redirect pattern should exist");

  for (const section of [
    "deployment",
    "device-exporters",
    "event-subscriptions",
    "explore",
    "grants",
    "records",
    "runs",
    "schedules",
    "search",
    "stream-playground",
    "timeline",
    "traces",
  ]) {
    assert.match(redirectPattern, new RegExp(`(^|\\|)${section}(\\||$)`));
  }
});
