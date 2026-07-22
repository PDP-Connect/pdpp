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
