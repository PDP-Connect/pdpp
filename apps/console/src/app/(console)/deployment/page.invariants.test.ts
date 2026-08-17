// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-regex guard for the operator-console deployment page.
 *
 * The page is a retrieval-diagnostics surface. Agent connection setup lives on
 * /connect, which already renders the MCP URL alongside the per-client
 * commands; the deployment page deliberately does NOT repeat that card.
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

const CONNECT_AGENT_CARD_RE = /ConnectAgentCard/;
const TOKENS_LINK_RE = /href="\/deployment\/tokens"/;

test("deployment page does not repeat the connect-an-AI-app card", async () => {
  // The card is just an MCP URL with a copy button, and /connect already
  // renders that URL plus the per-client setup commands. Two copies of the
  // same endpoint on two surfaces is one more place to drift.
  const src = await readFile(PAGE_FILE, "utf8");
  assert.doesNotMatch(src, CONNECT_AGENT_CARD_RE);
});

test("deployment page links to the tokens issuance surface", async () => {
  // The Tokens link in the page header is how an operator navigates from
  // deployment diagnostics to the owner-token issuance flow (the path for
  // trusted local agents like Daisy).
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, TOKENS_LINK_RE);
});
