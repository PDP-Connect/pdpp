/**
 * Source-regex guard for the dashboard's ordinary connect page.
 *
 * This page is the low-cognitive-tax path for adding data sources and then
 * connecting AI apps to the grant-scoped MCP surface. It must source its data
 * setup cards from the shared setup catalog, then expose concrete MCP/CLI
 * commands without owner bearers or placeholder substitution copy.
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
// The disposition→owner-copy mapping was extracted to a shared presentation
// module so the Connect catalog and the Sources page's add-account projection
// render the same vocabulary. The no-provider-specific-copy invariant now
// guards that shared module, which is the single source of truth.
const SOURCE_SETUP_PRESENTATION_FILE = `${HERE}../lib/source-setup-presentation.ts`;

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
const SOURCE_REPEATS_ACCOUNT_RE =
  /repeat the same setup to add another account|Repeat setup to add another device or account|Submit again to add another mailbox or account/i;
const AGENT_SECTION_AFTER_SOURCE_RE =
  /<SourceSetupSection catalog=\{catalog\} query=\{sourceQuery\} \/>[\s\S]*title="Connect AI apps"/;
// The page consumes the shared presentation helpers rather than defining the
// disposition→copy mapping inline; the drift check below reads the helper file.
const SOURCE_SETUP_PRESENTATION_IMPORT_RE = /from "\.\.\/lib\/source-setup-presentation\.ts"/;
const SOURCE_PROVIDER_SPECIFIC_COPY_RE =
  /\b(Amazon|Gmail|GitHub|Slack|ChatGPT|Chase|Notion|Spotify)\b|app password|personal access token/i;
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

test("connect page leads with the shared data-source setup catalog", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, LIST_CONNECTOR_MANIFESTS_RE);
  assert.match(src, BUILD_CONNECTOR_CATALOG_RE);
  assert.match(src, SOURCE_SETUP_SECTION_RE);
  assert.match(src, SOURCE_SEARCH_RE);
  assert.match(src, SOURCE_CARD_RE);
  assert.match(src, SOURCE_REPEATS_ACCOUNT_RE);
  assert.match(src, AGENT_SECTION_AFTER_SOURCE_RE);
  // The page renders source cards from the shared presentation helpers rather
  // than inlining the disposition→copy mapping.
  assert.match(src, SOURCE_SETUP_PRESENTATION_IMPORT_RE);
});

test("data-source setup UI has no connector-specific copy or examples", async () => {
  // The disposition→owner-copy mapping lives in the shared presentation module
  // now; the no-provider-specific-copy invariant guards that single source of
  // truth so neither Connect nor the Sources add-account projection can drift.
  const src = await readFile(SOURCE_SETUP_PRESENTATION_FILE, "utf8");
  assert.doesNotMatch(src, SOURCE_PROVIDER_SPECIFIC_COPY_RE);
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
