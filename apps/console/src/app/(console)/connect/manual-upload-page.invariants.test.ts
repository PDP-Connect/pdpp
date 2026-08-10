// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// biome-ignore-all lint/performance/useTopLevelRegex: invariant tests read more clearly with local regex assertions.
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
const REF_UPLOAD_ENDPOINT = /\/_ref\/connectors\/.*manual-upload-staged-artifact/;
const REF_ARTIFACT_POLL_ENDPOINT = /\/_ref\/manual-upload\/artifacts/;
const REF_PREVIEW_ENDPOINT = /\/_ref\/connectors\/.*manual-upload-validation-preview/;
const REF_RUN_ENDPOINT = /\/_ref\/connections\/.*\/run/;
const REF_RUN_SETUP_ADMISSION = /run_admission:\s*"setup"/;
const STAGED_CONTENT_TYPE = /application\/vnd\.pdpp\.manual-upload/;
const FILE_INPUT = /type="file"/;
const MULTIPLE_FILES = /\bmultiple\b/;
const ACCEPT_ATTR = /accepted_file_names/;
const ACCEPT_EXTENSIONS = /accepted_file_extensions/;
const SIZE_PREFLIGHT = /max_file_bytes/;
const HELP_URL = /help_url/;
const NEW_TAB = /target="_blank"/;
const NEW_TAB_COPY = /in a new tab/;
const NOREFERRER = /rel="noreferrer"/;
const SECURITY_BOUNDARY_COPY = /stored for this source and is not exposed to connected apps or clients/i;
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
const LABEL_INPUT = /name=\{connectionName\.name\}/;
const NO_SERVER_ACTION = /useActionState|manualUploadConnectionFormAction|action=\{formAction\}/;
const NO_SECRET_LOG = /console\.(log|error|warn)\([\s\S]*secret/;

test("manual-upload page is manifest-driven, not a connector-specific prompt", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, GET_SETUP);
  assert.match(src, FORM_COMPONENT);
  // Third gate REVISE (2026-07-29): existing-sources discovery no longer
  // fetches a bounded FLEET page at all — it uses the exact per-connector
  // seam (existingSourcesForManualUpload / existingSourcesForConnector),
  // never loadConnectorSummaryPage's fleet-wide primitive.
  assert.match(src, /existingSourcesForManualUpload\(/);
  assert.doesNotMatch(
    src,
    /loadConnectorSummaryPage\(/,
    "existing-sources discovery must use the exact connector-scoped seam, never a fleet page"
  );
  assert.match(src, SECURITY_BOUNDARY_COPY);
  assert.doesNotMatch(src, NO_CONNECTOR_BRANCH);
  assert.doesNotMatch(src, NO_PROVIDER_COPY);
});

test("manual-upload form imports directly and offers preview without connector-specific branches", async () => {
  const src = await readFile(FORM_FILE, "utf8");
  assert.match(src, CLIENT_SUBMIT);
  assert.match(src, RAW_XHR_UPLOAD);
  assert.match(src, REF_UPLOAD_ENDPOINT);
  assert.match(src, REF_ARTIFACT_POLL_ENDPOINT);
  assert.match(src, REF_PREVIEW_ENDPOINT);
  assert.match(src, REF_RUN_ENDPOINT);
  assert.match(src, REF_RUN_SETUP_ADMISSION);
  assert.match(src, STAGED_CONTENT_TYPE);
  assert.match(src, FILE_INPUT);
  assert.match(src, MULTIPLE_FILES);
  assert.match(src, ACCEPT_ATTR);
  assert.match(src, ACCEPT_EXTENSIONS);
  assert.match(src, SIZE_PREFLIGHT);
  assert.match(src, HELP_URL);
  assert.match(src, NEW_TAB);
  assert.match(src, NEW_TAB_COPY);
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

test("manual-upload-final-redteam-0810 #2: the Preview button's request declares the streamed content type, not the default octet-stream fallback", async () => {
  // Regression test for the exact defect the independent red team found:
  // sendRawFile()'s XHR defaults Content-Type to "application/octet-stream"
  // unless the caller passes an explicit `contentType` -- previewManualUpload
  // omitted it, so the RS's streaming-only content-type gate fell through to
  // the wildcard whole-buffer parser for the "Preview" button specifically
  // (a real, easily-triggered user journey with no client-side size gate).
  // Isolate previewManualUpload's own function body (not just "the string
  // appears somewhere in the file") so a future refactor that moves the
  // streamed call elsewhere in the file still fails this test honestly.
  const src = await readFile(FORM_FILE, "utf8");
  const bodyMatch = src.match(/async function previewManualUpload\([\s\S]*?\n\}\n/);
  assert.ok(bodyMatch, "expected to locate previewManualUpload's function body in manual-upload-form.tsx");
  const body = bodyMatch[0];
  assert.match(
    body,
    STAGED_CONTENT_TYPE,
    "previewManualUpload must pass contentType: 'application/vnd.pdpp.manual-upload' to sendRawFile"
  );
});
