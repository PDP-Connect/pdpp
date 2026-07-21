import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

test("progress and skip messages do not interpolate Chase account or document text", async () => {
  const source = await readFile(join(here, "index.ts"), "utf8");
  const emittedMessageTemplates = source.matchAll(/message:\s*`[^`]*`/g);
  const banned =
    /\b(?:account\.name|row\.title|account\.last_four|row\.account_reference|result\.qfxPath|dlResult\.pdfPath)\b/;

  for (const match of emittedMessageTemplates) {
    assert.doesNotMatch(match[0], banned, match[0]);
  }
});
