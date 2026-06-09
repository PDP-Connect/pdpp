/**
 * Source-regex guard for the dashboard's ordinary agent setup page.
 *
 * This page is the low-cognitive-tax path for connecting AI apps to the
 * grant-scoped MCP surface. It must lead with the resolved `/mcp` URL and
 * concrete Claude Code / Codex commands, not owner bearers or placeholder
 * substitution copy.
 *
 * Spec: openspec/changes/define-mcp-agent-entrypoint-surface/
 *       specs/reference-agent-access-workflow/spec.md
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

const PLACEHOLDER_ORIGIN_RE = /<PDPP_REFERENCE_ORIGIN>/;
const RESOLVE_PUBLIC_ORIGIN_RE = /await\s+getReferencePublicOrigin\(\)/;
const MCP_URL_BUILDER_RE = /const mcpUrl = `\$\{base\}\/mcp`/;
const CLAUDE_CODE_COMMAND_RE = /claude mcp add --transport http pdpp/;
const CLAUDE_CODE_CIMD_COMMAND_RE = /claude mcp add --transport http --client-id \$\{clientId\} pdpp/;
const CODEX_COMMAND_RE = /codex mcp add pdpp --url/;
const CODEX_CIMD_COMMAND_RE = /--oauth-client-id \$\{clientId\}/;
const CHATGPT_RE = /ChatGPT/;
const CLAUDE_AI_RE = /Claude\.ai/;
const PDPP_CLI_CONNECT_RE = /npx -y @pdpp\/cli@beta connect/;
const AGENT_ENTRYPOINT_RE = /\/llms\.txt/;
const OWNER_AGENT_LINK_RE = /href="\/dashboard\/deployment\/tokens"/;
const OWNER_TOKEN_ENV_VAR_RE = /bearer-token-env-var|Authorization: Bearer|PDPP_OWNER|owner bearer token/;
const PROFILE_VOCABULARY_RE = /\b(core|events|full)\s+profile\b|\bprofile\s+(core|events|full)\b/i;
const LIST_CIMD_DOCS_RE = /listCimdClientDocuments\(\)/;
const CREATE_CIMD_ACTION_RE = /createCimdClientIdentityAction/;
const DELETE_CIMD_ACTION_RE = /deleteCimdClientIdentityAction/;
const REDIRECT_URI_INPUT_RE = /name="redirect_uri"/;

test("connect page derives concrete entrypoints from the running public origin", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RESOLVE_PUBLIC_ORIGIN_RE);
  assert.match(src, MCP_URL_BUILDER_RE);
  assert.doesNotMatch(src, PLACEHOLDER_ORIGIN_RE);
});

test("connect page includes copy-paste setup for target MCP hosts", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, CLAUDE_CODE_COMMAND_RE);
  assert.match(src, CLAUDE_CODE_CIMD_COMMAND_RE);
  assert.match(src, CODEX_COMMAND_RE);
  assert.match(src, CODEX_CIMD_COMMAND_RE);
  assert.match(src, CHATGPT_RE);
  assert.match(src, CLAUDE_AI_RE);
});

test("connect page manages stable CIMD identities in the setup flow", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, LIST_CIMD_DOCS_RE);
  assert.match(src, CREATE_CIMD_ACTION_RE);
  assert.match(src, DELETE_CIMD_ACTION_RE);
  assert.match(src, REDIRECT_URI_INPUT_RE);
});

test("connect page also exposes CLI and agent-readable entrypoints", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, PDPP_CLI_CONNECT_RE);
  assert.match(src, AGENT_ENTRYPOINT_RE);
});

test("connect page keeps owner credentials secondary and out of MCP setup copy", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, OWNER_AGENT_LINK_RE);
  assert.doesNotMatch(src, OWNER_TOKEN_ENV_VAR_RE);
  assert.doesNotMatch(src, PROFILE_VOCABULARY_RE);
});
