import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SOURCES_VIEW_FILE = `${HERE}sources-view.tsx`;

test("SourcesView resets passport-local state when the selected source changes", async () => {
  const src = await readFile(SOURCES_VIEW_FILE, "utf8");
  assert.match(src, /<InstancePassport[\s\S]*key=\{selected\.id\}/);
});

test("SourcesView success toasts link to the concrete run detail", async () => {
  const src = await readFile(SOURCES_VIEW_FILE, "utf8");
  assert.match(src, /type ToastState =[\s\S]*runHref\?: string; runId\?: string/);
  assert.ok(
    src.includes("runHref: res.run_id ? `/dashboard/runs/${encodeURIComponent(res.run_id)}` : undefined"),
    "successful run toast should carry the run detail href"
  );
  assert.match(src, /<Link href=\{toast\.runHref\}>Open run \{toast\.runId\}/);
});

test("SourcesView already-running toasts preserve and link the active run id", async () => {
  const src = await readFile(SOURCES_VIEW_FILE, "utf8");
  const branch = src.slice(
    src.indexOf('if (res.reason === "already_running")'),
    src.indexOf('setToast({ kind: "error"')
  );
  assert.match(branch, /message: res\.message/);
  assert.match(
    branch,
    /runHref: res\.run_id \? `\/dashboard\/runs\/\$\{encodeURIComponent\(res\.run_id\)\}` : undefined/
  );
  assert.match(branch, /runId: res\.run_id/);
});

test("SourcesView uses server verdict action labels for owner-runnable run actions", async () => {
  const src = await readFile(SOURCES_VIEW_FILE, "utf8");
  const action = src.slice(src.indexOf("function CollectionRunAction"));
  assert.match(action, /primaryVerdictAction\.kind === "refresh_now" \|\| primaryVerdictAction\.kind === "retry_gap"/);
  assert.match(action, /\{isPending \? "Starting.*" : primaryVerdictAction\.cta\}/);
});

test("SourcesView renders non-run owner actions as detail hints, not generic Sync buttons", async () => {
  const src = await readFile(SOURCES_VIEW_FILE, "utf8");
  const action = src.slice(src.indexOf("function CollectionRunAction"));
  assert.match(action, /data-testid="sources-owner-verdict-action"/);
  assert.match(action, /Open source details to complete this owner action/);
});
