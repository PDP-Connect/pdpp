import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const OPERATOR_RUNS_FILE = `${HERE}operator-runs.ts`;
const CONNECTION_CONTROL_HELPER_PATTERN =
  /function connectionControlPath\(connectionId: string, suffix: string\): string/;
const CONNECTION_CONTROL_PATH_PATTERN = /`\/_ref\/connections\/\$\{encodeURIComponent\(connectionId\)\}\$\{suffix\}`/;
const RUN_CONNECTION_NOW_PATTERN = /export function runConnectionNow\(connectionId: string\)/;
const SAVE_CONNECTION_SCHEDULE_PATTERN = /export function saveConnectionSchedule\(/;
const PAUSE_CONNECTION_SCHEDULE_PATTERN = /export function pauseConnectionSchedule\(connectionId: string\)/;
const RESUME_CONNECTION_SCHEDULE_PATTERN = /export function resumeConnectionSchedule\(connectionId: string\)/;
const DELETE_CONNECTION_SCHEDULE_PATTERN = /export async function deleteConnectionSchedule\(connectionId: string\)/;
const SET_CONNECTION_DISPLAY_NAME_PATTERN =
  /export async function setConnectionDisplayName\(connectionId: string, displayName: string\)/;
const PATCH_METHOD_PATTERN = /method: "PATCH"/;
const CONNECTION_DISPLAY_NAME_PATH_PATTERN = /connectionControlPath\(connectionId, ""\)/;
const CONNECTION_DISPLAY_NAME_BODY_PATTERN = /asJson\(\{ display_name: displayName \}\)/;

test("operator run helpers expose connection-scoped control paths", async () => {
  const src = await readFile(OPERATOR_RUNS_FILE, "utf8");
  assert.match(src, CONNECTION_CONTROL_HELPER_PATTERN);
  assert.match(src, CONNECTION_CONTROL_PATH_PATTERN);
  assert.match(src, RUN_CONNECTION_NOW_PATTERN);
  assert.match(src, SAVE_CONNECTION_SCHEDULE_PATTERN);
  assert.match(src, PAUSE_CONNECTION_SCHEDULE_PATTERN);
  assert.match(src, RESUME_CONNECTION_SCHEDULE_PATTERN);
  assert.match(src, DELETE_CONNECTION_SCHEDULE_PATTERN);
});

test("setConnectionDisplayName targets the owner-only PATCH route with a JSON display_name body", async () => {
  const src = await readFile(OPERATOR_RUNS_FILE, "utf8");
  assert.match(src, SET_CONNECTION_DISPLAY_NAME_PATTERN);
  // The PATCH must go to /_ref/connections/:id with no suffix and carry
  // display_name in the JSON body — the reference server's owner-only
  // rename route.
  assert.match(src, PATCH_METHOD_PATTERN);
  assert.match(src, CONNECTION_DISPLAY_NAME_PATH_PATTERN);
  assert.match(src, CONNECTION_DISPLAY_NAME_BODY_PATTERN);
});
