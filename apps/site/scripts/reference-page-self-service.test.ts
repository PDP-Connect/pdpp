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
const RELEASED_BUNDLE_URL = "https://github.com/PDP-Connect/pdpp/releases/latest/download/docker-compose.yml";
const RAW_MAIN_OR_COMMIT_FETCH_RE =
  /raw\.githubusercontent\.com\/PDP-Connect\/pdpp\/(?:main|[0-9a-f]{40})\/deploy\/docker\/docker-compose\.yml/;
const PAGE_MARKERS = [
  "Deploy the released Compose bundle",
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
  "## 1. Deploy the released Compose bundle",
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

test("the self-service journey deploys via the one stable release URL, never a raw main/commit fetch", async () => {
  const page = await readFile(fileURLToPath(PAGE_PATH), "utf8");
  const runbook = await readFile(fileURLToPath(RUNBOOK_PATH), "utf8");

  assert.doesNotMatch(
    page,
    RAW_MAIN_OR_COMMIT_FETCH_RE,
    "public reference page must not fetch deploy/docker/docker-compose.yml from a raw main-branch or commit-SHA URL"
  );
  // The .tsx source references the URL through a named constant, not the
  // literal string, so check for the constant's declared value.
  assert.match(
    page,
    /RELEASED_COMPOSE_BUNDLE_URL = `\$\{GITHUB_REPO\}\/releases\/latest\/download\/docker-compose\.yml`/,
    "public reference page must derive its deploy URL from the one stable release path"
  );

  assert.doesNotMatch(
    runbook,
    RAW_MAIN_OR_COMMIT_FETCH_RE,
    "self-service runbook must not fetch deploy/docker/docker-compose.yml from a raw main-branch or commit-SHA URL"
  );
  assert.ok(runbook.includes(RELEASED_BUNDLE_URL), "self-service runbook must document the one stable release URL");
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
