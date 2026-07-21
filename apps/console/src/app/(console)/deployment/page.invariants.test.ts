/**
 * Source-regex guard for the operator-console deployment page.
 *
 * The deployment page resolves the running instance's public origin and feeds
 * it into `ConnectAgentCard`. If the page drops the `providerUrl` prop, the
 * card falls back to a placeholder MCP URL, which trains operators to invent
 * the URL by hand.
 *
 * Spec: openspec/specs/reference-implementation-architecture/spec.md
 *       (Operator deployment diagnostics surface)
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

const RESOLVE_PUBLIC_ORIGIN_CALL_RE = /await\s+getReferencePublicOrigin\(\)/;
const CARD_PASSES_PROVIDER_URL_RE = /<ConnectAgentCard[^>]*providerUrl=\{providerUrl\}/;
const CARD_LINKS_CONNECT_PAGE_RE = /<ConnectAgentCard[^>]*connectHref="\/connect"/;
const TOKENS_LINK_RE = /href="\/deployment\/tokens"/;

test("deployment page resolves the running instance's public origin", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RESOLVE_PUBLIC_ORIGIN_CALL_RE);
});

test("deployment page passes providerUrl into ConnectAgentCard", async () => {
  // ConnectAgentCard falls back to `<provider-url>/mcp` when providerUrl is
  // missing. The deployment page knows the running origin, so it MUST pass it
  // through — otherwise operators copy a placeholder and have to substitute the
  // URL by hand.
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, CARD_PASSES_PROVIDER_URL_RE);
});

test("deployment page links ConnectAgentCard to the setup page", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, CARD_LINKS_CONNECT_PAGE_RE);
});

test("deployment page links to the tokens issuance surface", async () => {
  // The Tokens link in the page header is how an operator navigates from
  // deployment diagnostics to the owner-token issuance flow (the path for
  // trusted local agents like Daisy).
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, TOKENS_LINK_RE);
});
