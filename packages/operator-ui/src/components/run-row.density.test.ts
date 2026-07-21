import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const RUN_ROW_FILE = `${HERE}run-row.tsx`;
const DENSITY_ROW_CLASS_RE = /pdpp-data-list-row/;
const HARDCODED_VERTICAL_PADDING_RE = /py-2/;

test("RunRow consumes the shared density row token instead of hardcoded vertical padding", async () => {
  const src = await readFile(RUN_ROW_FILE, "utf8");

  assert.match(src, DENSITY_ROW_CLASS_RE);
  assert.equal(HARDCODED_VERTICAL_PADDING_RE.test(src), false);
});
