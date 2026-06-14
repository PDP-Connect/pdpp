import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE_FILE = fileURLToPath(new URL("./manual-upload/[connectorId]/page.tsx", import.meta.url));
const FORM_FILE = fileURLToPath(new URL("./manual-upload/[connectorId]/manual-upload-form.tsx", import.meta.url));

const GET_SETUP = /getManualUploadSetup\(connectorId\)/;
const FORM_COMPONENT = /<ManualUploadForm existingSources=\{existingSources\} setup=\{setup\}/;
const CLIENT_SUBMIT = /onSubmit=\{handleSubmit\}/;
const RAW_XHR_UPLOAD = /new XMLHttpRequest\(\)/;
const REF_UPLOAD_ENDPOINT = /\/_ref\/connectors\/.*manual-upload-draft-connection/;
const REF_PREVIEW_ENDPOINT = /\/_ref\/connectors\/.*manual-upload-validation-preview/;
const REF_RUN_ENDPOINT = /\/_ref\/connections\/.*\/run/;
const FILE_INPUT = /type="file"/;
const MULTIPLE_FILES = /\bmultiple\b/;
const ACCEPT_ATTR = /accepted_file_names/;
const ACCEPT_EXTENSIONS = /accepted_file_extensions/;
const SIZE_PREFLIGHT = /max_file_bytes/;
const HELP_URL = /help_url/;
const NEW_TAB = /target="_blank"/;
const NOREFERRER = /rel="noreferrer"/;
const SECURITY_BOUNDARY_COPY = /never returned to agents, MCP clients, REST reads/i;
const NO_CONNECTOR_BRANCH = /connectorId\s*===/;
const NO_PROVIDER_COPY = /\bGoogle\b|\bTimeline\b|\bMaps\b/i;

const ACTION_USE_SERVER = /^"use server";/;
const REQUIRE_ACCESS = /await requireDashboardAccess\(/;
const PREVIEW_ONLY_COPY = /Preview only/;
const IMPORT_FILE_COPY = /Import file/;
const OPTIONAL_PREVIEW_COPY = /Preview checks one file/;
const WHAT_PDPP_FOUND_COPY = /What PDPP found/;
const TARGET_CHOICE_COPY = /Create a new source for these files/;
const EXISTING_SOURCE_COPY = /Add these files to an existing source/;
const LABEL_INPUT = /name="display_name"/;
const NO_SERVER_ACTION = /useActionState|manualUploadConnectionFormAction|action=\{formAction\}/;
const NO_SECRET_LOG = /console\.(log|error|warn)\([\s\S]*secret/;

test("manual-upload page is manifest-driven, not a connector-specific prompt", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, GET_SETUP);
  assert.match(src, FORM_COMPONENT);
  assert.match(src, /listConnectorSummaries\(\)/);
  assert.match(src, SECURITY_BOUNDARY_COPY);
  assert.doesNotMatch(src, NO_CONNECTOR_BRANCH);
  assert.doesNotMatch(src, NO_PROVIDER_COPY);
});

test("manual-upload form imports directly and offers preview without connector-specific branches", async () => {
  const src = await readFile(FORM_FILE, "utf8");
  assert.match(src, CLIENT_SUBMIT);
  assert.match(src, RAW_XHR_UPLOAD);
  assert.match(src, REF_UPLOAD_ENDPOINT);
  assert.match(src, REF_PREVIEW_ENDPOINT);
  assert.match(src, REF_RUN_ENDPOINT);
  assert.match(src, FILE_INPUT);
  assert.match(src, MULTIPLE_FILES);
  assert.match(src, ACCEPT_ATTR);
  assert.match(src, ACCEPT_EXTENSIONS);
  assert.match(src, SIZE_PREFLIGHT);
  assert.match(src, HELP_URL);
  assert.match(src, NEW_TAB);
  assert.match(src, NOREFERRER);
  assert.match(src, PREVIEW_ONLY_COPY);
  assert.match(src, IMPORT_FILE_COPY);
  assert.match(src, OPTIONAL_PREVIEW_COPY);
  assert.match(src, WHAT_PDPP_FOUND_COPY);
  assert.match(src, TARGET_CHOICE_COPY);
  assert.match(src, EXISTING_SOURCE_COPY);
  assert.match(src, LABEL_INPUT);
  assert.doesNotMatch(src, NO_CONNECTOR_BRANCH);
  assert.doesNotMatch(src, NO_PROVIDER_COPY);
  assert.doesNotMatch(src, NO_SERVER_ACTION);
});

test("manual-upload no longer posts large multipart bodies through a Server Action", async () => {
  const src = await readFile(FORM_FILE, "utf8");
  assert.doesNotMatch(src, ACTION_USE_SERVER);
  assert.doesNotMatch(src, REQUIRE_ACCESS);
  assert.doesNotMatch(src, NO_SERVER_ACTION);
  assert.doesNotMatch(src, NO_SECRET_LOG);
});
