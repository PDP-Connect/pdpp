// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE_PATH = new URL("../src/app/reference/page.tsx", import.meta.url);
const RUNBOOK_PATH = new URL("../../../docs/operator/self-service-gmail-mcp.md", import.meta.url);
const CONNECT_PAGE_PATH = new URL("../../../apps/console/src/app/(console)/connect/page.tsx", import.meta.url);
const ADD_SOURCE_PAGE_PATH = new URL("../../../apps/console/src/app/(console)/sources/add/page.tsx", import.meta.url);
const WHITESPACE_RE = /\s+/g;
const SOURCE_ROUTE_RE = /<your-deployment-origin>\/sources\/add/;
const CONNECT_PAGE_TITLE_RE = /title="Connect AI apps"/;
const ADD_SOURCE_PAGE_TITLE_RE = /title="Add source"/;
const PAGE_MARKERS = [
  "pinned Docker/Compose",
  "/owner/login",
  "<your-deployment-origin>/sources/add",
  "Gmail",
  "app password",
  "healthy",
  "records > 0",
  "<your-deployment-origin>/connect",
  "claude mcp add --transport http pdpp <your-deployment-origin>/mcp",
];
const RUNBOOK_MARKERS = [
  "## 1. Deploy a pinned Compose stack",
  "## 2. Sign in as owner",
  "## 3. Add Gmail with a Google app password",
  "<your-deployment-origin>/sources/add",
  "## 4. Wait for healthy data",
  "records > 0",
  "## 5. Add the deployed MCP server to Claude Code",
  "<your-deployment-origin>/connect",
  "claude mcp add --transport http pdpp <your-deployment-origin>/mcp",
];

test("public reference page never presents its origin as a live MCP server", async () => {
  const src = await readFile(fileURLToPath(PAGE_PATH), "utf8");

  assert.equal(src.includes("ConnectAgentCard"), false);
  assert.equal(src.includes('mode="live"'), false);
  assert.equal(src.includes("providerUrl"), false);
  assert.ok(src.includes("<your-deployment-origin>/connect"));
  assert.ok(src.includes("<your-deployment-origin>/mcp"));
  assert.ok(src.replace(WHITESPACE_RE, " ").includes("The public site is documentation; it is not this MCP server"));
});

test("blessed self-service journey keeps the health and data gate before MCP", async () => {
  const sources = await Promise.all([PAGE_PATH, RUNBOOK_PATH].map((path) => readFile(fileURLToPath(path), "utf8")));
  for (const [sourceIndex, src] of sources.entries()) {
    let previousIndex = -1;
    const markers = sourceIndex === 0 ? PAGE_MARKERS : RUNBOOK_MARKERS;
    for (const marker of markers) {
      const index = src.indexOf(marker);
      assert.notEqual(index, -1, `blessed journey source ${sourceIndex} is missing ${marker}`);
      assert.ok(index > previousIndex, `${marker} must remain after the preceding self-service step`);
      previousIndex = index;
    }
  }
});

test("self-service source setup names the authoritative owner route", async () => {
  const [runbook, connectPage, addSourcePage] = await Promise.all(
    [RUNBOOK_PATH, CONNECT_PAGE_PATH, ADD_SOURCE_PAGE_PATH].map((path) => readFile(fileURLToPath(path), "utf8"))
  );

  assert.match(runbook, SOURCE_ROUTE_RE);
  assert.match(connectPage, CONNECT_PAGE_TITLE_RE);
  assert.ok(connectPage.includes("dashboardRoutes.section.addSource"));
  assert.match(addSourcePage, ADD_SOURCE_PAGE_TITLE_RE);
});
