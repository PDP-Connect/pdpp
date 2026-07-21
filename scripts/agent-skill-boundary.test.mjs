#!/usr/bin/env node
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

function readSkill(relativePath) {
  return readFileSync(path.join(SKILLS_ROOT, relativePath), "utf8");
}

test("pdpp-data-access keeps owner bearers off the default agent path", () => {
  const skill = readSkill("pdpp-data-access/SKILL.md");

  // The default skill must still forbid owner bearers for routine work.
  assert.match(
    skill,
    /Do not (ask for, use, or persist|use) an owner bearer token/i,
    "pdpp-data-access must keep its hard rule against owner bearer tokens for routine work"
  );
  // It must keep pointing the default path at scoped client grants.
  assert.match(
    skill,
    /scoped (PDPP )?client grant/i,
    "pdpp-data-access must keep scoped client grants as the default path"
  );
});

test("pdpp-owner-agent is labeled owner-level local automation, not the default path", () => {
  const skill = readSkill("pdpp-owner-agent/SKILL.md");

  assert.match(
    skill,
    /owner-level local automation/i,
    "pdpp-owner-agent must explicitly label itself owner-level local automation"
  );
  // It must defer the default case back to the grant-scoped skill.
  assert.match(
    skill,
    /pdpp-data-access/,
    "pdpp-owner-agent must point ordinary agents back to pdpp-data-access"
  );
  // It must not present itself as the default. The description frontmatter must scope it.
  assert.match(
    skill,
    /not the default/i,
    "pdpp-owner-agent must state it is not the default agent path"
  );
});

test("pdpp-owner-agent keeps owner bearers off /mcp", () => {
  const skill = readSkill("pdpp-owner-agent/SKILL.md");

  // The skill must assert the /mcp boundary, not invite owner bearers onto it.
  assert.match(
    skill,
    /\/mcp[^\n]*reject|reject[^\n]*owner bearer/i,
    "pdpp-owner-agent must state that /mcp rejects owner bearers"
  );
  assert.doesNotMatch(
    skill,
    /owner bearer[^\n]*(over|on|via|through)\s+\/mcp\b(?![^\n]*reject)/i,
    "pdpp-owner-agent must not recommend sending owner bearers to /mcp"
  );
});
