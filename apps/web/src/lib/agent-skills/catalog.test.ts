import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentSkillCatalog, readAgentSkillFile } from "./catalog.ts";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const SKILL_FRONTMATTER_NAME = /name: pdpp-data-access/;

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
