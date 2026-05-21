import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPdppCliCommand, getPdppCliPackageInfo } from "../../../../../packages/cli/src/package-info.js";
import { pdppCliConnectCommand, pdppCliPackageInfo } from "../pdpp-cli-command.ts";
import { agentSkillsLLMSIndex, buildAgentSkillCatalog, readAgentSkillFile } from "./catalog.ts";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const SKILL_FRONTMATTER_NAME = /name: pdpp-data-access/;
const PDPP_CLI_CONNECT_COMMAND_SYMBOL = /pdppCliConnectCommand/;
const PDPP_CLI_TOKEN_COMPLETION_UNAVAILABLE_SYMBOL = /pdppCliTokenCompletionUnavailable/;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

test("agent skill catalog lists the PDPP data access skill and every served file", async () => {
  const catalog = await buildAgentSkillCatalog("https://pdpp.dev/");
  assert.equal(catalog.object, "agent_skill_catalog");
  assert.equal(catalog.skills.length, 1);

  const [skill] = catalog.skills;
  assert.equal(skill.name, "pdpp-data-access");
  assert.equal(skill.canonical_source, "docs/agent-skills");
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
    assert.ok(file.url.startsWith("https://pdpp.dev/.well-known/skills/"));
    assert.ok(file.bytes > 0);
    assert.match(file.sha256, SHA256_HEX);
  }
});

test("readAgentSkillFile serves only explicit skill files", async () => {
  const skill = await readAgentSkillFile("pdpp-data-access/SKILL.md");
  assert.ok(skill);
  assert.match(skill.body.toString("utf8"), SKILL_FRONTMATTER_NAME);

  assert.equal(await readAgentSkillFile("../package.json"), null);
  assert.equal(await readAgentSkillFile("pdpp-data-access/../../package.json"), null);
  assert.equal(await readAgentSkillFile("pdpp-data-access/references/missing.md"), null);
});

test("agent skill and llms index use the CLI package-info source of truth", async () => {
  const expectedCommand = createPdppCliCommand("<provider-url>");
  const expectedInfo = getPdppCliPackageInfo("<provider-url>");
  const skill = await readAgentSkillFile("pdpp-data-access/SKILL.md");

  assert.ok(skill);
  assert.equal(pdppCliConnectCommand, expectedCommand);
  assert.deepEqual(pdppCliPackageInfo, expectedInfo);
  assert.match(skill.body.toString("utf8"), new RegExp(escapeRegExp(expectedCommand)));
  assert.match(agentSkillsLLMSIndex(), new RegExp(escapeRegExp(expectedCommand)));
});

test("reference docs and web copy use the CLI package-info source of truth", () => {
  const expectedCommand = createPdppCliCommand("<provider-url>");
  const files = ["apps/web/content/docs/reference-implementation.md", "reference-implementation/README.md"];

  for (const file of files) {
    const contents = readFileSync(path.join(REPO_ROOT, file), "utf8");
    assert.match(contents, new RegExp(escapeRegExp(expectedCommand)), `${file} must include ${expectedCommand}`);
  }

  const card = readFileSync(
    path.join(REPO_ROOT, "apps/web/src/app/dashboard/components/connect-agent-card.tsx"),
    "utf8"
  );
  assert.match(card, PDPP_CLI_CONNECT_COMMAND_SYMBOL);
  assert.match(card, PDPP_CLI_TOKEN_COMPLETION_UNAVAILABLE_SYMBOL);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
