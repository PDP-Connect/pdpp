import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const OPERATOR_RUNS_FILE = `${HERE}operator-runs.ts`;

test("operator run helpers expose connection-scoped control paths", async () => {
  const src = await readFile(OPERATOR_RUNS_FILE, "utf8");
  assert.match(src, /function connectionControlPath\(connectionId: string, suffix: string\): string/);
  assert.match(src, /`\/_ref\/connections\/\$\{encodeURIComponent\(connectionId\)\}\$\{suffix\}`/);
  assert.match(src, /export async function runConnectionNow\(connectionId: string\)/);
  assert.match(src, /export async function saveConnectionSchedule\(/);
  assert.match(src, /export async function pauseConnectionSchedule\(connectionId: string\)/);
  assert.match(src, /export async function resumeConnectionSchedule\(connectionId: string\)/);
  assert.match(src, /export async function deleteConnectionSchedule\(connectionId: string\)/);
});

test("setConnectionDisplayName targets the owner-only PATCH route with a JSON display_name body", async () => {
  const src = await readFile(OPERATOR_RUNS_FILE, "utf8");
  assert.match(src, /export async function setConnectionDisplayName\(connectionId: string, displayName: string\)/);
  // The PATCH must go to /_ref/connections/:id with no suffix and carry
  // display_name in the JSON body — the reference server's owner-only
  // rename route.
  assert.match(src, /method: "PATCH"/);
  assert.match(src, /connectionControlPath\(connectionId, ""\)/);
  assert.match(src, /asJson\(\{ display_name: displayName \}\)/);
});
