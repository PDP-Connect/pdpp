// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GET as getFull } from "../llms-full.txt/route.ts";
import { GET as getIndex } from "./route.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NEXT_CONFIG_FILE = path.resolve(HERE, "..", "..", "..", "next.config.mjs");
const LLMS_REWRITE_PAIR = /source:\s*['"]\/\.well-known\/llms\.txt['"][\s\S]*?destination:\s*['"]\/llms\.txt['"]/;
const TEXT_MARKDOWN = /^text\/markdown/;
const LLMS_HEADING = /# PDPP operator agent entrypoints/;
const DATA_ACCESS_SKILL_PATH = /\/\.well-known\/skills\/pdpp-data-access\/SKILL\.md/;
const OWNER_AGENT_SKILL_PATH = /\/\.well-known\/skills\/pdpp-owner-agent\/SKILL\.md/;
const PROTECTED_RESOURCE_PATH = /\/\.well-known\/oauth-protected-resource/;
const MCP_PATH = /\/mcp/;
const DATA_ACCESS_SKILL_BODY_HEADING = /## docs\/agent-skills\/pdpp-data-access\/SKILL\.md/;
const DATA_ACCESS_SKILL_FRONTMATTER = /name: pdpp-data-access/;
const OWNER_AGENT_SKILL_BODY_HEADING = /## docs\/agent-skills\/pdpp-owner-agent\/SKILL\.md/;
const OWNER_AGENT_SKILL_FRONTMATTER = /name: pdpp-owner-agent/;

test("console /llms.txt exposes same-origin agent skill pointers", async () => {
  const response = await getIndex();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", TEXT_MARKDOWN);

  const text = await response.text();
  assert.match(text, LLMS_HEADING);
  assert.match(text, DATA_ACCESS_SKILL_PATH);
  assert.match(text, OWNER_AGENT_SKILL_PATH);
  assert.match(text, PROTECTED_RESOURCE_PATH);
  assert.match(text, MCP_PATH);
});

test("console /llms-full.txt serves the bundled skill bodies", async () => {
  const response = await getFull();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", TEXT_MARKDOWN);

  const text = await response.text();
  assert.match(text, DATA_ACCESS_SKILL_BODY_HEADING);
  assert.match(text, DATA_ACCESS_SKILL_FRONTMATTER);
  assert.match(text, OWNER_AGENT_SKILL_BODY_HEADING);
  assert.match(text, OWNER_AGENT_SKILL_FRONTMATTER);
});

test("console rewrites .well-known llms alias to the routable handler", () => {
  const nextConfig = readFileSync(NEXT_CONFIG_FILE, "utf8");
  assert.match(nextConfig, LLMS_REWRITE_PAIR, "next.config.mjs must rewrite /.well-known/llms.txt to /llms.txt");
});
