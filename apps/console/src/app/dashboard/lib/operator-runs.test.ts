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
const RUN_CONNECTION_EXPORT_RE = /export function runConnectionNow\(connectionId: string\)/;
const SAVE_CONNECTION_SCHEDULE_EXPORT_RE = /export function saveConnectionSchedule\(/;
const PAUSE_CONNECTION_SCHEDULE_EXPORT_RE = /export function pauseConnectionSchedule\(connectionId: string\)/;
const RESUME_CONNECTION_SCHEDULE_EXPORT_RE = /export function resumeConnectionSchedule\(connectionId: string\)/;
const DELETE_CONNECTION_SCHEDULE_EXPORT_RE = /export async function deleteConnectionSchedule\(connectionId: string\)/;

test("operator run helpers expose connection-scoped control paths", async () => {
  const src = await readFile(OPERATOR_RUNS_FILE, "utf8");
  assert.match(src, CONNECTION_CONTROL_PATH_SIGNATURE_RE);
  assert.match(src, CONNECTION_CONTROL_PATH_TEMPLATE_RE);
  assert.match(src, RUN_CONNECTION_EXPORT_RE);
  assert.match(src, SAVE_CONNECTION_SCHEDULE_EXPORT_RE);
  assert.match(src, PAUSE_CONNECTION_SCHEDULE_EXPORT_RE);
  assert.match(src, RESUME_CONNECTION_SCHEDULE_EXPORT_RE);
  assert.match(src, DELETE_CONNECTION_SCHEDULE_EXPORT_RE);
});
