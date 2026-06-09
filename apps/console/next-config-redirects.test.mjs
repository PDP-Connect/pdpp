import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("bare connector redirect excludes every top-level dashboard section", async () => {
  const src = await readFile(new URL("./next.config.mjs", import.meta.url), "utf8");
  const redirectPattern = src.match(/\/dashboard\/:connector\(\(\?!([^)]*)\)\[\^\/]\+\)\/:rest\*/)?.[1];
  assert.ok(redirectPattern, "connector redirect pattern should exist");

  for (const section of [
    "connect",
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

test("top-level /explore redirects to dashboard Explore in the console app", async () => {
  const src = await readFile(new URL("./next.config.mjs", import.meta.url), "utf8");
  assert.match(src, /source:\s*['"]\/explore['"]/, "console app must expose /explore");
  assert.match(src, /destination:\s*['"]\/dashboard\/explore['"]/, "console /explore must redirect to /dashboard/explore");
  assert.match(src, /source:\s*['"]\/explore\/:rest\*['"]/, "console app must preserve nested /explore paths");
  assert.match(
    src,
    /destination:\s*['"]\/dashboard\/explore\/:rest\*['"]/,
    "console nested /explore paths must redirect under /dashboard/explore",
  );
});
