/**
 * Source-regex guard for ConnectAgentCard's MCP URL substitution.
 *
 * The card is the deployment-page pointer to the low-copy setup page. When the
 * caller knows the running deployment's public origin, the card MUST derive
 * `<origin>/mcp` rather than rendering a placeholder or broad owner-token setup.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CARD_FILE = `${HERE}connect-agent-card.tsx`;

const PROVIDER_URL_PROP_RE = /providerUrl\??:\s*string/;
const MCP_URL_HELPER_RE = /function mcpUrlFor\(providerUrl\??:\s*string\): string/;
const MCP_URL_SUBSTITUTION_RE = /providerUrl\s*\?\s*`\$\{trimTrailingSlash\(providerUrl\)\}\/mcp`\s*:\s*"<provider-url>\/mcp"/;
const CONNECT_HREF_PROP_RE = /connectHref\??:\s*string/;
const OPEN_SETUP_LINK_RE = /href=\{connectHref\}/;
const OWNER_TOKEN_SETUP_RE = /Authorization: Bearer|bearer-token-env-var|Issue owner token/;

test("ConnectAgentCard accepts a providerUrl prop", async () => {
  const src = await readFile(CARD_FILE, "utf8");
  assert.match(src, PROVIDER_URL_PROP_RE);
});

test("ConnectAgentCard derives the MCP URL from a known providerUrl", async () => {
  const src = await readFile(CARD_FILE, "utf8");
  assert.match(src, MCP_URL_HELPER_RE);
  assert.match(src, MCP_URL_SUBSTITUTION_RE);
});

test("ConnectAgentCard links to the dedicated setup page without owner-token setup copy", async () => {
  const src = await readFile(CARD_FILE, "utf8");
  assert.match(src, CONNECT_HREF_PROP_RE);
  assert.match(src, OPEN_SETUP_LINK_RE);
  assert.doesNotMatch(src, OWNER_TOKEN_SETUP_RE);
});
