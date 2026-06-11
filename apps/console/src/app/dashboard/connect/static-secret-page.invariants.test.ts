import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE_FILE = fileURLToPath(new URL("./static-secret/[connectorId]/page.tsx", import.meta.url));
const ACTION_FILE = fileURLToPath(new URL("./static-secret/[connectorId]/actions.ts", import.meta.url));
const STATUS_PAGE_FILE = fileURLToPath(new URL("./status/[connectionId]/page.tsx", import.meta.url));
const LEGACY_STATUS_PAGE_FILE = fileURLToPath(
  new URL("./static-secret/[connectorId]/status/[connectionId]/page.tsx", import.meta.url)
);

// Hoisted to satisfy useTopLevelRegex; grouped by the surface they assert.
const GET_SETUP = /getStaticSecretSetup\(connectorId\)/;
const FORM_ACTION = /action=\{createStaticSecretConnectionAction\}/;
const FIELDS_MAP = /setup\.credential_capture\.fields\.map/;
const HELP_URL = /field\.help_url/;
const NEW_TAB = /target="_blank"/;
const NOREFERRER = /rel="noreferrer"/;
const OPEN_HELP_COPY = /Open provider setup page in a new tab/;
const SECRET_BOUNDARY_COPY = /agents, MCP clients, REST reads, audit payloads, or the dashboard/;
const STORAGE_NOT_READY_COPY = /Credential storage is not ready/;
const NO_CONNECTOR_BRANCH = /connectorId\s*===/;
const NO_PROVIDER_COPY = /\bGmail\b|\bGitHub\b|app password|personal access token/i;
const NO_INGEST_COPY = /hidden until ingest accepts records/i;
const NO_ENV_VAR_COPY = /No deployment env var per account/;
const NO_TRANSIENT_NOTICE = /first_sync_started/;

const ACTION_USE_SERVER = /^"use server";/;
const REQUIRE_ACCESS = /await requireDashboardAccess\(/;
const CREATE_DRAFT = /createStaticSecretDraftConnection\(connectorId, setupFields\)/;
const CAPTURE_SECRET = /captureStaticSecretCredential\(\{/;
const RUN_NOW = /runConnectionNow\(draft\.connection_id\)/;
const STATUS_SURFACE_PATH = /\/dashboard\/connect\/status\//;
const STATUS_HREF_CALL = /statusHref\(/;
const NO_NOTICE_REDIRECT = /notice:\s*"first_sync_started"/;
const NO_LEGACY_BRANCH = /isStaticSecretConnector/;
const NO_SECRET_LOG = /console\.(log|error|warn)\([\s\S]*secret/;
const NO_BEARER = /Authorization:\s*`Bearer/;

const STATUS_FETCH = /getConnectionSetupStatus\(/;
const STATUS_SETUP_STATE = /setup_state/;
const STATUS_SETUP_MATERIAL = /setup_material/;
const STATUS_FAILED_STATE = /first_sync_failed/;
const STATUS_LAST_ERROR = /last_error/;
const STATUS_CONNECTION_ID = /connection_id/;
const STATUS_NOT_FOUND = /notFound\(\)/;
const STATUS_NO_PASSWORD_INPUT = /type="password"/;
const STATUS_NO_SECRET_INPUT = /name="secret"/;
const LEGACY_REDIRECT = /\/dashboard\/connect\/status\/\$\{encodeURIComponent/;

test("static-secret page is an owner-session capture form, not an agent secret prompt", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, GET_SETUP);
  assert.match(src, FORM_ACTION);
  assert.match(src, FIELDS_MAP);
  assert.match(src, HELP_URL);
  assert.match(src, NEW_TAB);
  assert.match(src, NOREFERRER);
  assert.match(src, OPEN_HELP_COPY);
  assert.doesNotMatch(src, NO_CONNECTOR_BRANCH);
  assert.doesNotMatch(src, NO_PROVIDER_COPY);
  assert.match(src, SECRET_BOUNDARY_COPY);
  assert.match(src, STORAGE_NOT_READY_COPY);
  assert.doesNotMatch(src, NO_INGEST_COPY);
  assert.doesNotMatch(src, NO_ENV_VAR_COPY);
  // The page must no longer carry a transient post-submit notice as the only
  // owner-visible state; that lifecycle now lives on the durable status page.
  assert.doesNotMatch(src, NO_TRANSIENT_NOTICE);
});

test("static-secret action redirects to the durable setup-status surface, not a transient notice", async () => {
  const src = await readFile(ACTION_FILE, "utf8");
  assert.match(src, ACTION_USE_SERVER);
  assert.match(src, REQUIRE_ACCESS);
  assert.match(src, GET_SETUP);
  assert.match(src, CREATE_DRAFT);
  assert.match(src, CAPTURE_SECRET);
  assert.match(src, RUN_NOW);
  // The success and the draft-created-then-failed paths both land on the
  // durable per-connection status surface, keyed on the real connection id.
  assert.match(src, STATUS_SURFACE_PATH);
  assert.match(src, STATUS_HREF_CALL);
  assert.doesNotMatch(src, NO_NOTICE_REDIRECT);
  assert.doesNotMatch(src, NO_LEGACY_BRANCH);
  assert.doesNotMatch(src, NO_CONNECTOR_BRANCH);
  assert.doesNotMatch(src, NO_PROVIDER_COPY);
  assert.doesNotMatch(src, NO_SECRET_LOG);
  assert.doesNotMatch(src, NO_BEARER);
});

test("durable setup-status page reads the connection-scoped status route and surfaces lifecycle + failure", async () => {
  const src = await readFile(STATUS_PAGE_FILE, "utf8");
  // Reads the durable, connection-scoped setup-status route.
  assert.match(src, STATUS_FETCH);
  // Surfaces the projected lifecycle (running/pending/failed/active) and the
  // identifiers the owner needs, with no provider-specific branches.
  assert.match(src, STATUS_SETUP_STATE);
  assert.match(src, STATUS_SETUP_MATERIAL);
  assert.match(src, STATUS_FAILED_STATE);
  assert.match(src, STATUS_LAST_ERROR);
  assert.match(src, STATUS_CONNECTION_ID);
  // 404s a missing connection rather than fabricating a status.
  assert.match(src, STATUS_NOT_FOUND);
  // No provider-specific copy and no secret-bearing input on a read-only
  // status surface (the status page never captures a credential).
  assert.doesNotMatch(src, NO_PROVIDER_COPY);
  assert.doesNotMatch(src, STATUS_NO_PASSWORD_INPUT);
  assert.doesNotMatch(src, STATUS_NO_SECRET_INPUT);
});

test("legacy static-secret setup-status URL redirects to the generic setup-status surface", async () => {
  const src = await readFile(LEGACY_STATUS_PAGE_FILE, "utf8");
  assert.match(src, LEGACY_REDIRECT);
  assert.doesNotMatch(src, STATUS_FETCH);
});
