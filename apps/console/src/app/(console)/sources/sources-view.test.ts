// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SOURCES_VIEW_FILE = `${HERE}sources-view.tsx`;
const INSTANCE_PASSPORT_KEY_RE = /<InstancePassport[\s\S]*key=\{selected\.id\}/;
const TOAST_STATE_RE = /type ToastState =[\s\S]*runHref\?: string; runId\?: string/;
const TOAST_RUN_HREF_RE = /runHref: res\.run_id \? `\/syncs\/\$\{encodeURIComponent\(res\.run_id\)\}` : undefined/;
const TOAST_LINK_RE = /<Link href=\{toast\.runHref\}>Open run \{toast\.runId\}/;
const ALREADY_RUNNING_MESSAGE_RE = /message: res\.message/;
const ALREADY_RUNNING_RUN_HREF_RE =
  /runHref: res\.run_id \? `\/syncs\/\$\{encodeURIComponent\(res\.run_id\)\}` : undefined/;
const ALREADY_RUNNING_RUN_ID_RE = /runId: res\.run_id/;
const RUN_VERDICT_KIND_RE =
  /primaryVerdictAction\.kind === "refresh_now" \|\| primaryVerdictAction\.kind === "retry_gap"/;
const RUN_VERDICT_LABEL_RE = /\{isPending \? "Starting.*" : primaryVerdictAction\.cta\}/;
const OWNER_VERDICT_ACTION_TESTID_RE = /data-testid="sources-owner-verdict-action"/;
const OWNER_VERDICT_ACTION_HREF_RE = /href=\{instance\.detailHref\}/;
const OWNER_VERDICT_ACTION_TITLE_RE = /Open source details to complete this owner action/;
const SOURCE_ROW_MARKER_RE = /data-pdpp-source-row=\{instance\.connectionId \?\? instance\.id\}/g;
const SOURCE_SCOPE_MARKER_RE = /data-pdpp-source-scope=\{instance\.sourceScope\}/g;
const STREAM_ROW_MARKER_RE =
  /data-connection-id=\{connectionId\}[\s\S]*data-pdpp-stream-row="true"[\s\S]*data-stream-name=\{stream\.name\}/;

test("SourcesView resets passport-local state when the selected source changes", async () => {
  const src = await readFile(SOURCES_VIEW_FILE, "utf8");
  assert.match(src, INSTANCE_PASSPORT_KEY_RE);
});

test("SourcesView success toasts link to the concrete run detail", async () => {
  const src = await readFile(SOURCES_VIEW_FILE, "utf8");
  assert.match(src, TOAST_STATE_RE);
  assert.match(src, TOAST_RUN_HREF_RE, "successful run toast should carry the run detail href");
  assert.match(src, TOAST_LINK_RE);
});

test("SourcesView already-running toasts preserve and link the active run id", async () => {
  const src = await readFile(SOURCES_VIEW_FILE, "utf8");
  const branch = src.slice(
    src.indexOf('if (res.reason === "already_running")'),
    src.indexOf('setToast({ kind: "error"')
  );
  assert.match(branch, ALREADY_RUNNING_MESSAGE_RE);
  assert.match(branch, ALREADY_RUNNING_RUN_HREF_RE);
  assert.match(branch, ALREADY_RUNNING_RUN_ID_RE);
});

test("SourcesView uses server verdict action labels for owner-runnable run actions", async () => {
  const src = await readFile(SOURCES_VIEW_FILE, "utf8");
  const action = src.slice(src.indexOf("function CollectionRunAction"));
  assert.match(action, RUN_VERDICT_KIND_RE);
  assert.match(action, RUN_VERDICT_LABEL_RE);
});

test("SourcesView renders non-run owner actions as subject-scoped detail links, not generic Sync buttons", async () => {
  const src = await readFile(SOURCES_VIEW_FILE, "utf8");
  const action = src.slice(src.indexOf("function CollectionRunAction"));
  assert.match(action, OWNER_VERDICT_ACTION_TESTID_RE);
  assert.match(action, OWNER_VERDICT_ACTION_HREF_RE);
  assert.match(action, OWNER_VERDICT_ACTION_TITLE_RE);
});

test("SourcesView emits stable source and stream row markers for acceptance evidence", async () => {
  const src = await readFile(SOURCES_VIEW_FILE, "utf8");
  assert.equal(src.match(SOURCE_ROW_MARKER_RE)?.length, 2, "mobile and desktop source rows must both be marked");
  assert.equal(
    src.match(SOURCE_SCOPE_MARKER_RE)?.length,
    2,
    "mobile and desktop source rows must declare lifecycle scope"
  );
  assert.match(src, STREAM_ROW_MARKER_RE);
});

const SOURCES_VIEW_CSS_FILE = `${HERE}sources-view.css`;
const MANIFEST_CONTAINER_TYPE_RE = /\.rr-s-manifest\s*\{[\s\S]{0,120}?container-type:\s*inline-size;/;
const MANIFEST_CONTAINER_NAME_RE = /\.rr-s-manifest\s*\{[\s\S]{0,120}?container-name:\s*rr-s-manifest;/;
const MANIFEST_CONTAINER_QUERY_RE =
  /@container rr-s-manifest \(max-width:\s*34rem\)\s*\{[\s\S]*?--cols:\s*minmax\(0, 1fr\) minmax\(0, 1\.25fr\)\s*!important;/;
const MANIFEST_VIEWPORT_QUERY_RE = /@media \(max-width:\s*640px\)\s*\{\s*\.rr-s-cols/;

/**
 * The stream-name column is a flexible `minmax(0, 1fr)` track sharing a grid
 * with three FIXED minimums (13rem + 10rem + 6.5rem = 472px). Whenever the
 * manifest's own box is narrower than that sum, the fixed tracks win and the
 * stream track is squeezed to literally 0px — the name becomes invisible while
 * the facts beside it stay legible.
 *
 * That squeeze is a function of the DETAIL PANEL's width, not the viewport's:
 * at a 1024px viewport the panel is only ~366px. A viewport media query cannot
 * see it, which is precisely why the original `@media (max-width: 640px)` rule
 * never fired for the collapse. The breakpoint must therefore be a container
 * query on the panel itself.
 */
test("stream manifest columns respond to the panel's own width, so the stream name can never be squeezed to zero", async () => {
  const css = await readFile(SOURCES_VIEW_CSS_FILE, "utf8");

  assert.match(
    css,
    MANIFEST_CONTAINER_TYPE_RE,
    "the manifest must establish an inline-size container to query against"
  );
  assert.match(
    css,
    MANIFEST_CONTAINER_NAME_RE,
    "the container must be named so the query cannot bind to a stray ancestor"
  );
  // `!important` is what makes the override actually apply: the shared Table
  // primitive sets --cols as an INLINE style, which outranks any stylesheet
  // rule. Dropping it silently restores the collapse, so it is pinned here.
  assert.match(
    css,
    MANIFEST_CONTAINER_QUERY_RE,
    "below the fixed track minimums the manifest must drop to two tracks (with !important, to beat the primitive's inline --cols)"
  );
  assert.doesNotMatch(
    css,
    MANIFEST_VIEWPORT_QUERY_RE,
    "the stream-column breakpoint must not key on viewport width — the panel is far narrower than the viewport"
  );
});

// Quiet-expiry defect fix (owner ruling 2026-08-22): the setup-failed
// passport note must render the server's specific `forward_statement`
// (`setupFailedForwardStatement`) rather than always showing the same
// generic sentence regardless of WHY setup failed — that generic-only
// behavior is exactly the pre-fix defect (a TTL-expired attempt reading
// identically to an owner-abandoned one).
const SETUP_FAILED_NOTE_RE =
  /instance\.setupFailedForwardStatement\s*\?\?\s*\n?\s*"This connection attempt never finished setup\. No records were collected/;

test("SourcesView's setup-failed passport note prefers the server's specific forward_statement over the generic fallback", async () => {
  const src = await readFile(SOURCES_VIEW_FILE, "utf8");
  const block = src.slice(
    src.indexOf("{instance.setupFailed ? ("),
    src.indexOf("{instance.revoked && !instance.setupFailed ? (")
  );
  assert.match(
    block,
    SETUP_FAILED_NOTE_RE,
    "the passport note must read setupFailedForwardStatement first, falling back to the generic sentence only when absent"
  );
});
