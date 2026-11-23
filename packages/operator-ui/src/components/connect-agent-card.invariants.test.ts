// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectAgentCard } from "./connect-agent-card.tsx";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CARD_FILE = `${HERE}connect-agent-card.tsx`;

const PROVIDER_URL_PROP_RE = /providerUrl\??:\s*string/;
const MCP_URL_HELPER_RE = /function mcpUrlFor\(providerUrl\??:\s*string\): string/;
const MCP_URL_SUBSTITUTION_RE =
  /providerUrl\s*\?\s*`\$\{trimTrailingSlash\(providerUrl\)\}\/mcp`\s*:\s*"<provider-url>\/mcp"/;
const CONNECT_HREF_PROP_RE = /connectHref\??:\s*string/;
const OPEN_SETUP_LINK_RE = /href=\{connectHref\}/;
const OWNER_TOKEN_SETUP_RE = /Authorization: Bearer|bearer-token-env-var|Issue owner token/;

const LIVE_SETUP_LINK = /href="\/sample-setup"/;
const LIVE_MCP_TEXT = /https:\/\/fixture\.example\/mcp<\/code>/;
const SANDBOX_MCP_TEXT = /&lt;provider-url&gt;\/mcp<\/code>/;
const SANDBOX_COPY = /deterministic mock data/;
const LINK_ELEMENT = /<a(?: |>)/;

test("ConnectAgentCard renders the setup link and one normalized MCP path", () => {
  const html = renderToStaticMarkup(createElement(ConnectAgentCard, {
    connectHref: "/sample-setup",
    mode: "live",
    providerUrl: "https://fixture.example///",
  }));
  assert.match(html, LIVE_SETUP_LINK);
  assert.match(html, LIVE_MCP_TEXT);
});

test("ConnectAgentCard sandbox without a deployment renders a placeholder and no setup link", () => {
  const html = renderToStaticMarkup(createElement(ConnectAgentCard, { mode: "sandbox" }));
  assert.match(html, SANDBOX_MCP_TEXT);
  assert.match(html, SANDBOX_COPY);
  assert.doesNotMatch(html, LINK_ELEMENT);
});

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
