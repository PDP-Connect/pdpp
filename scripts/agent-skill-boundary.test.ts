#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Guard: the two agent-skill profiles must keep a clear trust boundary.
//
//   pdpp-data-access  — default. Ordinary third-party / coding / task-scoped agents.
//                       Scoped client grants. MUST NOT recommend owner bearers as the
//                       default data-access path.
//   pdpp-owner-agent  — opt-in owner-level local automation (e.g. Daisy). Owner-level
//                       REST credential after explicit approval. MUST label itself as
//                       owner-level local automation, MUST NOT present owner bearers as
//                       the default agent path, and MUST keep owner bearers off /mcp.
//
// This test reads the committed skill docs directly so it runs without a pnpm install
// and cannot silently drift if either skill's framing is later weakened. It is the
// doc-side guard for task 5.4 of add-trusted-owner-agent-onboarding.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_ROOT = path.join(REPO_ROOT, "docs/agent-skills");

function readSkill(relativePath: string): string {
  return readFileSync(path.join(SKILLS_ROOT, relativePath), "utf8");
}

const OWNER_BEARER_RULE_PATTERN = /Do not (ask for, use, or persist|use) an owner bearer token/i;
const SCOPED_CLIENT_GRANT_PATTERN = /scoped (PDPP )?client grant/i;
const OWNER_LEVEL_LOCAL_AUTOMATION_PATTERN = /owner-level local automation/i;
const POINTS_TO_DATA_ACCESS_PATTERN = /pdpp-data-access/;
const NOT_THE_DEFAULT_PATTERN = /not the default/i;
const MCP_REJECTS_OWNER_BEARER_PATTERN = /\/mcp[^\n]*reject|reject[^\n]*owner bearer/i;
const OWNER_BEARER_VIA_MCP_PATTERN = /owner bearer[^\n]*(over|on|via|through)\s+\/mcp\b(?![^\n]*reject)/i;

test("pdpp-data-access keeps owner bearers off the default agent path", () => {
  const skill = readSkill("pdpp-data-access/SKILL.md");

  // The default skill must still forbid owner bearers for routine work.
  assert.match(
    skill,
    OWNER_BEARER_RULE_PATTERN,
    "pdpp-data-access must keep its hard rule against owner bearer tokens for routine work"
  );
  // It must keep pointing the default path at scoped client grants.
  assert.match(
    skill,
    SCOPED_CLIENT_GRANT_PATTERN,
    "pdpp-data-access must keep scoped client grants as the default path"
  );
});

test("pdpp-owner-agent is labeled owner-level local automation, not the default path", () => {
  const skill = readSkill("pdpp-owner-agent/SKILL.md");

  assert.match(
    skill,
    OWNER_LEVEL_LOCAL_AUTOMATION_PATTERN,
    "pdpp-owner-agent must explicitly label itself owner-level local automation"
  );
  // It must defer the default case back to the grant-scoped skill.
  assert.match(
    skill,
    POINTS_TO_DATA_ACCESS_PATTERN,
    "pdpp-owner-agent must point ordinary agents back to pdpp-data-access"
  );
  // It must not present itself as the default. The description frontmatter must scope it.
  assert.match(skill, NOT_THE_DEFAULT_PATTERN, "pdpp-owner-agent must state it is not the default agent path");
});

test("pdpp-owner-agent keeps owner bearers off /mcp", () => {
  const skill = readSkill("pdpp-owner-agent/SKILL.md");

  // The skill must assert the /mcp boundary, not invite owner bearers onto it.
  assert.match(skill, MCP_REJECTS_OWNER_BEARER_PATTERN, "pdpp-owner-agent must state that /mcp rejects owner bearers");
  assert.doesNotMatch(
    skill,
    OWNER_BEARER_VIA_MCP_PATTERN,
    "pdpp-owner-agent must not recommend sending owner bearers to /mcp"
  );
});
