// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-regex guards for the Grants list page.
 *
 * Grants are an owner-comprehension surface: row copy may preserve raw
 * client_id as hover/identity detail, but the visible caption must not lead
 * with `client cli_...` technical ids when registered client metadata exists.
 *
 * Client captions are authoritative-only: the caption uses the stored
 * `client_name` from oauth_clients when present, otherwise the raw
 * client_id verbatim. There must be no URL-hostname or client-id-shape
 * heuristic standing in for a real registered name (see
 * `grants-ia-maker-0803`: heuristics were removed as misleading).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

const CLIENT_CAPTION_HELPER_RE = /function grantClientCaption\(/;
const RAW_CLIENT_CAPTION_RE = /client\s+\{grant\.client_id\}/;
const URL_HEURISTIC_RE = /new URL\(|clientOriginCaption|looksLikeTechnicalClientId/;
const CURRENT_ACCESS_STATUS_RE = /CURRENT_ACCESS_STATUS = "issued"/;
const ALL_VIEW_RE = /params\.view === "all"/;
const STATUS_DEFAULT_RE = /params\.status \?\? \(showAll \? undefined : CURRENT_ACCESS_STATUS\)/;
const LAST_USED_LABEL_RE = /last used <IcTimestamp/;
const ISSUED_LABEL_RE = /issued <IcTimestamp/;

// C6: the Pending approvals section collapses entirely at zero — it must be
// gated on a non-empty length, never rendered unconditionally with an
// empty-state at the top of the grants list.
const PENDING_SECTION_GATED_RE = /approvals\.data\.length > 0 \? \(\s*<Section/;
const PENDING_EMPTY_STATE_IMPORT_RE = /EmptyState/;

test("grants list formats visible client captions instead of rendering raw client ids", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, CLIENT_CAPTION_HELPER_RE);
  assert.doesNotMatch(src, RAW_CLIENT_CAPTION_RE);
});

test("grants list never derives a client name from a URL or client-id shape", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.doesNotMatch(src, URL_HEURISTIC_RE);
});

test("grants list defaults to current, actionable access and offers an explicit all-evidence view", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, CURRENT_ACCESS_STATUS_RE);
  assert.match(src, ALL_VIEW_RE);
  // The default must never win over an explicit status filter.
  assert.match(src, STATUS_DEFAULT_RE);
});

test("grants list issued/last-used timestamps are labeled, never a bare unlabeled timestamp", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, LAST_USED_LABEL_RE);
  assert.match(src, ISSUED_LABEL_RE);
});

test("grants page collapses the Pending approvals section when there are zero pending", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // The Section is rendered only inside a `length > 0` guard...
  assert.match(src, PENDING_SECTION_GATED_RE);
  // ...and the empty-state placeholder is no longer used (nothing renders at zero).
  assert.doesNotMatch(src, PENDING_EMPTY_STATE_IMPORT_RE);
});
