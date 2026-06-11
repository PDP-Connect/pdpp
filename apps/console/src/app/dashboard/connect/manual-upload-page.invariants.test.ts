import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE_FILE = fileURLToPath(new URL("./manual-upload/[connectorId]/page.tsx", import.meta.url));
const ACTION_FILE = fileURLToPath(new URL("./manual-upload/[connectorId]/actions.ts", import.meta.url));

const GET_SETUP = /getManualUploadSetup\(connectorId\)/;
const FORM_ACTION = /action=\{createManualUploadConnectionAction\}/;
const FILE_INPUT = /type="file"/;
const ACCEPT_ATTR = /accepted_file_names/;
const HELP_URL = /help_url/;
const NEW_TAB = /target="_blank"/;
const NOREFERRER = /rel="noreferrer"/;
const SECURITY_BOUNDARY_COPY = /never returned to agents, MCP clients, REST reads/i;
const NO_CONNECTOR_BRANCH = /connectorId\s*===/;
const NO_PROVIDER_COPY = /\bGoogle\b|\bTimeline\b|\bMaps\b/i;

const ACTION_USE_SERVER = /^"use server";/;
const REQUIRE_ACCESS = /await requireDashboardAccess\(/;
const CREATE_DRAFT = /createManualUploadDraftConnection\(connectorId, fileEntry\)/;
const RUN_NOW = /runConnectionNow\(draft\.connection_id\)/;
const STATUS_SURFACE_PATH = /\/dashboard\/connect\/status\//;
const STATUS_HREF_CALL = /statusHref\(/;
const NO_BEARER = /Authorization:\s*`Bearer/;
const NO_SECRET_LOG = /console\.(log|error|warn)\([\s\S]*secret/;

test("manual-upload page is manifest-driven, not a connector-specific prompt", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, GET_SETUP);
  assert.match(src, FORM_ACTION);
  assert.match(src, FILE_INPUT);
  assert.match(src, ACCEPT_ATTR);
  assert.match(src, HELP_URL);
  assert.match(src, NEW_TAB);
  assert.match(src, NOREFERRER);
  assert.match(src, SECURITY_BOUNDARY_COPY);
  assert.doesNotMatch(src, NO_CONNECTOR_BRANCH);
  assert.doesNotMatch(src, NO_PROVIDER_COPY);
});

test("manual-upload action redirects to durable setup status, not a transient notice", async () => {
  const src = await readFile(ACTION_FILE, "utf8");
  assert.match(src, ACTION_USE_SERVER);
  assert.match(src, REQUIRE_ACCESS);
  assert.match(src, GET_SETUP);
  assert.match(src, CREATE_DRAFT);
  assert.match(src, RUN_NOW);
  assert.match(src, STATUS_SURFACE_PATH);
  assert.match(src, STATUS_HREF_CALL);
  assert.doesNotMatch(src, NO_BEARER);
  assert.doesNotMatch(src, NO_SECRET_LOG);
});
