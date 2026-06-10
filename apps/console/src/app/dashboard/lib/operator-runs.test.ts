import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const OPERATOR_RUNS_FILE = `${HERE}operator-runs.ts`;
const CONNECTION_CONTROL_PATH_SIGNATURE_RE =
  /function connectionControlPath\(connectionId: string, suffix: string\): string/;
const CONNECTION_CONTROL_PATH_TEMPLATE_RE =
  /`\/_ref\/connections\/\$\{encodeURIComponent\(connectionId\)\}\$\{suffix\}`/;
const RUN_CONNECTION_EXPORT_RE = /export function runConnectionNow\(connectionId: string, options: RunNowOptions = \{\}\)/;
const RUN_NOW_FORCE_BODY_RE = /body: asJson\(\{ force: true \}\)/;
const RUN_CONNECTOR_OPTIONS_RE = /export function runConnectorNow\(connectorId: string, options: RunNowOptions = \{\}\)/;
const SAVE_CONNECTION_SCHEDULE_EXPORT_RE = /export function saveConnectionSchedule\(/;
const PAUSE_CONNECTION_SCHEDULE_EXPORT_RE = /export function pauseConnectionSchedule\(connectionId: string\)/;
const RESUME_CONNECTION_SCHEDULE_EXPORT_RE = /export function resumeConnectionSchedule\(connectionId: string\)/;
const DELETE_CONNECTION_SCHEDULE_EXPORT_RE = /export async function deleteConnectionSchedule\(connectionId: string\)/;
const SET_DISPLAY_NAME_EXPORT_RE =
  /export async function setConnectionDisplayName\(connectionId: string, displayName: string\)/;
const SET_DISPLAY_NAME_PATCH_RE = /method: "PATCH"/;
const SET_DISPLAY_NAME_BODY_RE = /asJson\(\{ display_name: displayName \}\)/;

test("operator run helpers expose connection-scoped control paths", async () => {
  const src = await readFile(OPERATOR_RUNS_FILE, "utf8");
  assert.match(src, CONNECTION_CONTROL_PATH_SIGNATURE_RE);
  assert.match(src, CONNECTION_CONTROL_PATH_TEMPLATE_RE);
  assert.match(src, RUN_CONNECTOR_OPTIONS_RE);
  assert.match(src, RUN_CONNECTION_EXPORT_RE);
  assert.match(src, RUN_NOW_FORCE_BODY_RE);
  assert.match(src, SAVE_CONNECTION_SCHEDULE_EXPORT_RE);
  assert.match(src, PAUSE_CONNECTION_SCHEDULE_EXPORT_RE);
  assert.match(src, RESUME_CONNECTION_SCHEDULE_EXPORT_RE);
  assert.match(src, DELETE_CONNECTION_SCHEDULE_EXPORT_RE);
});

test("setConnectionDisplayName PATCHes the connection route with a display_name body", async () => {
  // The rename mutation targets the owner-gated
  // `PATCH /_ref/connections/:connectorInstanceId` route with a
  // `{ display_name }` body — the connection (not the connector type) is the
  // selector, and the verb must be PATCH to match the backend contract.
  const src = await readFile(OPERATOR_RUNS_FILE, "utf8");
  assert.match(src, SET_DISPLAY_NAME_EXPORT_RE);
  assert.match(src, SET_DISPLAY_NAME_PATCH_RE);
  assert.match(src, SET_DISPLAY_NAME_BODY_RE);
});
