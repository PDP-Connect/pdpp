// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SOURCE_SETUP_CATALOG_FILE = fileURLToPath(new URL("./source-setup-catalog.tsx", import.meta.url));

const EXTERNAL_DOCS = /externalDocs\.map/;
const NEW_TAB = /target="_blank"/;
const NEW_TAB_TITLE = /title="Opens in a new tab"/;
const NEW_TAB_COPY = /\(opens in a new tab\)/;
const NOREFERRER = /rel="noreferrer"/;

test("source-setup-catalog renders external documentation links with new-tab forewarning", async () => {
  const src = await readFile(SOURCE_SETUP_CATALOG_FILE, "utf8");
  assert.match(src, EXTERNAL_DOCS, "must render externalDocs links");
  assert.match(src, NEW_TAB, 'all external links must have target="_blank"');
  assert.match(src, NEW_TAB_COPY, "external documentation links must warn visibly before opening a new tab");
  assert.match(
    src,
    NEW_TAB_TITLE,
    'external documentation links must have title="Opens in a new tab" for accessibility/forewarning'
  );
  assert.match(src, NOREFERRER, 'all external links must have rel="noreferrer" for security');
});

const UNAVAILABLE_GUIDANCE_COMPONENT =
  /function SourceUnavailableGuidance\(\{ entry \}: \{ entry: ConnectorCatalogEntry \}\)/;
const UNAVAILABLE_GUIDANCE_TESTID = /data-testid="source-unavailable-guidance"/;
const UNAVAILABLE_SUMMARY_RENDERS_GUIDANCE =
  /data-testid="unavailable-source-summary"[\s\S]*?<SourceUnavailableGuidance entry=\{entry\} \/>/;
const UNAVAILABLE_ROW_RENDERS_GUIDANCE =
  /\{sourceMethodLine\(entry, existingSources\.length\)\}<\/p>\s*<SourceUnavailableGuidance entry=\{entry\} \/>/;

/**
 * `sourceMethodLine` states a FACT for an unavailable entry ("No proven setup
 * path is available in this dashboard."). A fact alone is the dead end the
 * owner complained about — it never says why the path is missing or who could
 * change it. Every surface that renders that fact must also render the
 * guidance line beside it, or the fix in source-setup-presentation.ts is
 * unreachable from the UI that actually shows the refusal.
 */
test("every surface showing the no-setup-path fact also shows what the owner or operator can do next", async () => {
  const src = await readFile(SOURCE_SETUP_CATALOG_FILE, "utf8");

  assert.match(src, UNAVAILABLE_GUIDANCE_COMPONENT, "the unavailable-guidance component must exist");
  assert.match(src, UNAVAILABLE_GUIDANCE_TESTID, "the guidance must be addressable for UI verification");
  assert.match(
    src,
    UNAVAILABLE_SUMMARY_RENDERS_GUIDANCE,
    "the collapsed unavailable-sources summary must render guidance, not only the refusal fact"
  );
  assert.match(
    src,
    UNAVAILABLE_ROW_RENDERS_GUIDANCE,
    "a full source card must render guidance directly beneath the method line"
  );
});
