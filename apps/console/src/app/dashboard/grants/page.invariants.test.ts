/**
 * Source-regex guards for the Grants list page.
 *
 * Grants are an owner-comprehension surface: row copy may preserve raw
 * client_id as hover/identity detail, but the visible caption must not lead
 * with `client cli_...` technical ids when registered client metadata exists.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

const CLIENT_CAPTION_HELPER_RE = /function grantClientCaption\(/;
const RAW_CLIENT_CAPTION_RE = /client\s+\{grant\.client_id\}/;

test("grants list formats visible client captions instead of rendering raw client ids", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, CLIENT_CAPTION_HELPER_RE);
  assert.doesNotMatch(src, RAW_CLIENT_CAPTION_RE);
});
