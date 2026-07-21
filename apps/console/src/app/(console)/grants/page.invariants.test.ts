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
const CLIENT_ORIGIN_CAPTION_HELPER_RE = /function clientOriginCaption\(/;
const RAW_CLIENT_CAPTION_RE = /client\s+\{grant\.client_id\}/;

// C6: the Pending approvals section collapses entirely at zero — it must be
// gated on a non-empty length, never rendered unconditionally with an
// empty-state at the top of the grants list.
const PENDING_SECTION_GATED_RE = /approvals\.data\.length > 0 \? \(\s*<Section/;
const PENDING_EMPTY_STATE_IMPORT_RE = /EmptyState/;

test("grants list formats visible client captions instead of rendering raw client ids", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, CLIENT_CAPTION_HELPER_RE);
  assert.match(src, CLIENT_ORIGIN_CAPTION_HELPER_RE);
  assert.doesNotMatch(src, RAW_CLIENT_CAPTION_RE);
});

test("grants page collapses the Pending approvals section when there are zero pending", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // The Section is rendered only inside a `length > 0` guard...
  assert.match(src, PENDING_SECTION_GATED_RE);
  // ...and the empty-state placeholder is no longer used (nothing renders at zero).
  assert.doesNotMatch(src, PENDING_EMPTY_STATE_IMPORT_RE);
});
