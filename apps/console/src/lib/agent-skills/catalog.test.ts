import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPdppCliCommand, getPdppCliPackageInfo } from "../../../../../packages/cli/src/package-info.js";
import { pdppCliConnectCommand, pdppCliPackageInfo } from "../pdpp-cli-command.ts";
import {
  agentSkillsLLMSIndex,
  buildAgentSkillCatalog,
  ownerAgentOnboardingLLMSIndex,
  readAgentSkillFile,
} from "./catalog.ts";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const SKILL_FRONTMATTER_NAME = /name: pdpp-data-access/;
const OWNER_SKILL_FRONTMATTER_NAME = /name: pdpp-owner-agent/;
const OWNER_AGENT_METADATA_PATH = /\/\.well-known\/oauth-protected-resource/;
const OWNER_AGENT_SKILL_PATH = /\/\.well-known\/skills\/pdpp-owner-agent\/SKILL\.md/;
const MCP_PATH = /\/mcp/;
const MCP_OWNER_BEARER_REJECTION_COPY = /rejects owner bearers/;
const OWNER_AGENT_REST_PATH = /\/v1\/\*\*/;
const OWNER_AGENT_ONBOARD_COMMAND = /pdpp owner-agent onboard/;
const DO_NOT_PASTE_TOKENS_COPY = /Do not paste tokens\./;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

test("console agent skill catalog lists the served skills and files", async () => {
  const catalog = await buildAgentSkillCatalog("https://pdpp.vivid.fish/");
  assert.equal(catalog.object, "agent_skill_catalog");
  assert.equal(catalog.skills.length, 2);

  const skill = catalog.skills.find((entry) => entry.name === "pdpp-data-access");
  assert.ok(skill);
  assert.deepEqual(
    skill.files.map((file) => file.path),
    [
      "pdpp-data-access/SKILL.md",
      "pdpp-data-access/references/grant-design.md",
      "pdpp-data-access/references/query-cookbook.md",
      "pdpp-data-access/references/security.md",
      "pdpp-data-access/references/troubleshooting.md",
    ]
  );

  for (const file of skill.files) {
    assert.ok(file.url.startsWith("https://pdpp.vivid.fish/.well-known/skills/"));
    assert.ok(file.bytes > 0);
    assert.match(file.sha256, SHA256_HEX);
  }

  const ownerSkill = catalog.skills.find((entry) => entry.name === "pdpp-owner-agent");
  assert.ok(ownerSkill);
  assert.deepEqual(
    ownerSkill.files.map((file) => file.path),
    ["pdpp-owner-agent/SKILL.md"]
  );
});

test("console readAgentSkillFile serves only explicit files", async () => {
  const skill = await readAgentSkillFile("pdpp-data-access/SKILL.md");
  assert.ok(skill);
  assert.match(skill.body.toString("utf8"), SKILL_FRONTMATTER_NAME);

  const ownerSkill = await readAgentSkillFile("pdpp-owner-agent/SKILL.md");
  assert.ok(ownerSkill);
  assert.match(ownerSkill.body.toString("utf8"), OWNER_SKILL_FRONTMATTER_NAME);

  assert.equal(await readAgentSkillFile("../package.json"), null);
  assert.equal(await readAgentSkillFile("pdpp-data-access/../../package.json"), null);
  assert.equal(await readAgentSkillFile("pdpp-data-access/references/missing.md"), null);
});

test("console agent skill and llms index use the CLI package-info source of truth", async () => {
  const expectedCommand = createPdppCliCommand("<provider-url>");
  const expectedInfo = getPdppCliPackageInfo("<provider-url>");
  const skill = await readAgentSkillFile("pdpp-data-access/SKILL.md");

  assert.ok(skill);
  assert.equal(pdppCliConnectCommand, expectedCommand);
  assert.deepEqual(pdppCliPackageInfo, expectedInfo);
  assert.match(skill.body.toString("utf8"), new RegExp(escapeRegExp(expectedCommand)));
  assert.match(agentSkillsLLMSIndex(), new RegExp(escapeRegExp(expectedCommand)));
});

test("console llms index points trusted owner agents at canonical onboarding surfaces", async () => {
  const ownerAgentSection = ownerAgentOnboardingLLMSIndex();

  assert.match(ownerAgentSection, OWNER_AGENT_METADATA_PATH);
  assert.match(ownerAgentSection, OWNER_AGENT_SKILL_PATH);
  assert.match(ownerAgentSection, MCP_PATH);
  assert.match(ownerAgentSection, MCP_OWNER_BEARER_REJECTION_COPY);
  assert.match(ownerAgentSection, OWNER_AGENT_REST_PATH);
  assert.match(ownerAgentSection, OWNER_AGENT_ONBOARD_COMMAND);
  assert.match(ownerAgentSection, DO_NOT_PASTE_TOKENS_COPY);
  assert.ok(agentSkillsLLMSIndex().includes(ownerAgentSection));

  const servedOwnerSkill = await readAgentSkillFile("pdpp-owner-agent/SKILL.md");
  assert.ok(servedOwnerSkill);
  const skill = readFileSync(path.join(REPO_ROOT, "docs/agent-skills/pdpp-owner-agent/SKILL.md"), "utf8");
  assert.equal(servedOwnerSkill.body.toString("utf8"), skill);
  assert.match(skill, OWNER_SKILL_FRONTMATTER_NAME);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
