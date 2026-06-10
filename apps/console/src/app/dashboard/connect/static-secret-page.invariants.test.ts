import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE_FILE = fileURLToPath(new URL("./static-secret/[connectorId]/page.tsx", import.meta.url));
const ACTION_FILE = fileURLToPath(new URL("./static-secret/[connectorId]/actions.ts", import.meta.url));

test("static-secret page is an owner-session capture form, not an agent secret prompt", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, /getStaticSecretSetup\(connectorId\)/);
  assert.match(src, /action=\{createStaticSecretConnectionAction\}/);
  assert.match(src, /setup\.credential_capture\.fields\.map/);
  assert.match(src, /field\.help_url/);
  assert.doesNotMatch(src, /connectorId\s*===/);
  assert.doesNotMatch(src, /\bGmail\b|\bGitHub\b|app password|personal access token/i);
  assert.match(src, /agents, MCP clients, REST reads, audit payloads, or the dashboard/);
  assert.match(src, /Credential storage is not ready/);
});

test("static-secret action creates draft, captures secret, then starts first sync", async () => {
  const src = await readFile(ACTION_FILE, "utf8");
  assert.match(src, /^"use server";/);
  assert.match(src, /await requireDashboardAccess\(/);
  assert.match(src, /getStaticSecretSetup\(connectorId\)/);
  assert.match(src, /createStaticSecretDraftConnection\(connectorId, setupFields\)/);
  assert.match(src, /captureStaticSecretCredential\(\{/);
  assert.match(src, /runConnectionNow\(draft\.connection_id\)/);
  assert.doesNotMatch(src, /isStaticSecretConnector/);
  assert.doesNotMatch(src, /connectorId\s*===/);
  assert.doesNotMatch(src, /\bGmail\b|\bGitHub\b|app password|personal access token/i);
  assert.doesNotMatch(src, /console\.(log|error|warn)\([\s\S]*secret/);
  assert.doesNotMatch(src, /Authorization:\s*`Bearer/);
});
