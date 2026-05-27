import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const VIEW_FILE = `${HERE}records-list-view.tsx`;

test("records summary uses activity wording instead of an Idle health label", async () => {
  const src = await readFile(VIEW_FILE, "utf8");

  assert.match(src, /return "No active runs"/);
  assert.doesNotMatch(src, /return "Idle"/);
});
