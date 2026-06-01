/**
 * Source-regex guard for ConnectAgentCard's provider-URL substitution.
 *
 * The card renders the `pdpp connect <provider-url>` copy that operators
 * paste into AI agents. When the caller knows the running deployment's
 * public origin (e.g. the live operator dashboard at /dashboard/deployment),
 * the card MUST substitute that origin into the command rather than the
 * literal `<provider-url>` placeholder. A regression here trains operators
 * to invent the URL by hand.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CARD_FILE = `${HERE}connect-agent-card.tsx`;

const PROVIDER_URL_PROP_RE = /providerUrl\??:\s*string/;
const CONDITIONAL_SUBSTITUTION_RE =
  /providerUrl\s*\?\s*pdppCliConnectCommandFor\(providerUrl\)\s*:\s*pdppCliConnectCommand/;

test("ConnectAgentCard accepts a providerUrl prop", async () => {
  const src = await readFile(CARD_FILE, "utf8");
  assert.match(src, PROVIDER_URL_PROP_RE);
});

test("ConnectAgentCard substitutes a known providerUrl into the connect command", async () => {
  const src = await readFile(CARD_FILE, "utf8");
  // The card MUST switch to `pdppCliConnectCommandFor(providerUrl)` when the
  // caller knows the URL. Without this conditional, the dashboard's connect
  // copy regresses to the literal `<provider-url>` placeholder.
  assert.match(src, CONDITIONAL_SUBSTITUTION_RE);
});
