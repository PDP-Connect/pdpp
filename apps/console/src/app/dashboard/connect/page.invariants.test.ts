/**
 * Source-regex guard for the dashboard's ordinary connect page.
 *
 * This page is the low-cognitive-tax path for connecting AI apps to the
 * grant-scoped MCP surface. Source-account setup belongs under Sources and must
 * not be rendered here.
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
const RESOLVE_PUBLIC_ORIGIN_RE = /getReferencePublicOrigin\(\)/;
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
const LIST_CONNECTOR_MANIFESTS_RE = /listConnectorManifests\(\)/;
const BUILD_CONNECTOR_CATALOG_RE = /buildConnectorCatalog\(manifests\)/;
const SOURCE_SETUP_SECTION_RE = /title="Add data sources"/;
const SOURCE_SEARCH_RE = /name="source_q"[\s\S]*?Search source name or connector key/;
const SOURCE_CARD_RE = /data-testid=\{`source-setup-\$\{entry\.connectorKey\}`\}/;
const ADD_SOURCE_POINTER_RE = /href=\{dashboardRoutes\.section\.addSource\}[\s\S]*Add a source/;
const SOURCE_FORBIDDEN_NORMAL_COPY_RE =
  /CLI preview|pdpp owner-agent connectors explain|Manual setup|Ready with provider secret|Track only|No setup path yet|Needs browser proof/;

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

test("connect page does not render the data-source setup catalog", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.doesNotMatch(src, LIST_CONNECTOR_MANIFESTS_RE);
  assert.doesNotMatch(src, BUILD_CONNECTOR_CATALOG_RE);
  assert.doesNotMatch(src, SOURCE_SETUP_SECTION_RE);
  assert.doesNotMatch(src, SOURCE_SEARCH_RE);
  assert.doesNotMatch(src, SOURCE_CARD_RE);
  assert.match(src, ADD_SOURCE_POINTER_RE);
});

test("connect page has no owner source-setup vocabulary", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.doesNotMatch(src, SOURCE_FORBIDDEN_NORMAL_COPY_RE);
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
