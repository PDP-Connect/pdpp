/**
 * Sources cockpit acceptance invariants for the owner-console stabilization plan.
 *
 * These pin the concrete complaints from the live walkthrough:
 * - the source list must not be a narrow rail on desktop;
 * - selected-row emphasis must not touch row text;
 * - severity/status must not change row geometry;
 * - stream rows must not be dash-only placeholders.
 *
 * This is deliberately source/CSS structural. Pixel proof is still required by
 * the OpenSpec task, but these checks stop the same implementation shape from
 * reappearing without a browser.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CSS_FILE = `${HERE}sources-view.css`;
const VIEW_FILE = `${HERE}sources-view.tsx`;
const MODEL_FILE = `${HERE}sources-view-model.ts`;

const DESKTOP_GRID_RE = /grid-template-columns:\s*minmax\(320px,\s*0\.9fr\)\s+minmax\(0,\s*1\.7fr\)/;
const OLD_NARROW_GRID_RE = /grid-template-columns:\s*minmax\(0,\s*280px\)/;
const ROW_PADDING_RE = /\.rr-s-item\s*\{[\s\S]*?padding:\s*10px\s+12px\s+11px\s+14px;/;
const SELECTED_ACCENT_RE = /\.rr-s-item\.is-on\s*\{[\s\S]*?inset\s+3px\s+0\s+0\s+var\(--primary\)/;
const OLD_TOUCHING_PADDING_RE = /\.rr-s-item\s*\{[\s\S]*?padding:\s*10px\s+0\s+11px;/;
const STATE_GEOMETRY_RE =
  /\.rr-s-item(?:\.|[^\n{])*(?:degraded|attention|warning)[^{]*\{[\s\S]*?(?:margin|width|border-radius)\s*:/i;
const COLLECTION_REPORT_INDEX_RE = /indexCollectionReportByStream\(summary\.collection_report\)/;
const DUPLICATE_COLLAPSE_RE = /collapseDuplicateFallbackSources\(instances\)/;
const DUPLICATE_GROUP_TESTID_RE = /data-testid="sources-duplicate-group"/;
const FACTS_UNAVAILABLE_COPY_RE = /Collection facts not available yet/;
const RECORDS_HEADER_RE = /<TableHeader>records<\/TableHeader>/;
const STREAM_RECORDS_RE = /summary\.stream_records/;
const PRIMARY_VERDICT_ACTION_RE = /primaryVerdictAction=\{instance\.primaryVerdictAction\}/;
const NON_OWNER_VERDICT_GUARD_RE =
  /primaryVerdictAction !== null && !primaryVerdictAction\.ownerRunnable[\s\S]*data-testid="sources-verdict-status-action"[\s\S]*Sync now/;
const OWNER_ACTION_CUE_TESTID_RE = /data-testid="sources-owner-action-cue"/;
const OWNER_ACTION_CUE_ASCII_RE = /Review: \{instance\.ownerActionCue\.label\}/;
const OWNER_ACTION_CUE_DETAIL_TITLE_RE = /Open the source detail to review this suggested action\./;
const OLD_CURSOR_HEADER_RE = /<TableHeader>cursor<\/TableHeader>/;
const OLD_SEARCH_HEADER_RE = /<TableHeader>search<\/TableHeader>/;
const OLD_CURSOR_FALLBACK_RE = /\{stream\.cursor\s*\?\?\s*"—"\}/;
const OLD_SEARCH_LABEL_RE = /function searchLabel/;

test("desktop source list has a useful width and stable gap", async () => {
  const css = await readFile(CSS_FILE, "utf8");
  assert.match(css, DESKTOP_GRID_RE);
  assert.doesNotMatch(css, OLD_NARROW_GRID_RE);
});

test("selected row accent has padding between the accent and text", async () => {
  const css = await readFile(CSS_FILE, "utf8");
  assert.match(css, ROW_PADDING_RE);
  assert.match(css, SELECTED_ACCENT_RE);
  assert.doesNotMatch(css, OLD_TOUCHING_PADDING_RE);
});

test("status state does not create separate row geometry", async () => {
  const css = await readFile(CSS_FILE, "utf8");
  assert.doesNotMatch(css, STATE_GEOMETRY_RE);
});

test("stream manifest uses collection facts or an explicit unavailable state, not dash-only columns", async () => {
  const view = await readFile(VIEW_FILE, "utf8");
  const model = await readFile(MODEL_FILE, "utf8");
  assert.match(model, COLLECTION_REPORT_INDEX_RE);
  assert.match(model, STREAM_RECORDS_RE);
  assert.match(view, FACTS_UNAVAILABLE_COPY_RE);
  assert.match(view, RECORDS_HEADER_RE);
  assert.doesNotMatch(view, OLD_CURSOR_HEADER_RE);
  assert.doesNotMatch(view, OLD_SEARCH_HEADER_RE);
  assert.doesNotMatch(view, OLD_CURSOR_FALLBACK_RE);
  assert.doesNotMatch(view, OLD_SEARCH_LABEL_RE);
});

test("repeated unnamed same-type sources are collapsed into a review group", async () => {
  const view = await readFile(VIEW_FILE, "utf8");
  assert.match(view, DUPLICATE_COLLAPSE_RE);
  assert.match(view, DUPLICATE_GROUP_TESTID_RE);
});

test("source passport suppresses generic sync for non-owner verdict actions", async () => {
  const view = await readFile(VIEW_FILE, "utf8");
  assert.match(view, PRIMARY_VERDICT_ACTION_RE);
  assert.match(view, NON_OWNER_VERDICT_GUARD_RE);
});

test("source list shows advisory owner-action cues as non-mutating review copy", async () => {
  const view = await readFile(VIEW_FILE, "utf8");
  assert.match(view, OWNER_ACTION_CUE_TESTID_RE);
  assert.match(view, OWNER_ACTION_CUE_ASCII_RE);
  assert.match(view, OWNER_ACTION_CUE_DETAIL_TITLE_RE);
  const cueBlock = view.slice(view.indexOf('data-testid="sources-owner-action-cue"') - 220);
  const cueElement = cueBlock.slice(0, cueBlock.indexOf("</span>"));
  assert.doesNotMatch(cueElement, /<button/);
  assert.doesNotMatch(cueElement, /onClick|runConnectorNowAction/);
});
