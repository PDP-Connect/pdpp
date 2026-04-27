import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "./[...path]/route.ts";

const APPLICATION_JSON = /^application\/json/;
const PDPP_SKILL_FRONTMATTER = /name: pdpp-data-access/;
const TROUBLESHOOTING_HEADING = /# Troubleshooting/;
const TEXT_MARKDOWN = /^text\/markdown/;

function callSkillsRoute(path: string[], headers?: HeadersInit): Promise<Response> {
  return GET(new Request(`http://0.0.0.0:3000/.well-known/skills/${path.join("/")}`, { headers }), {
    params: Promise.resolve({ path }),
  });
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

test("agent skill .well-known route serves the catalog with forwarded origin", async () => {
  const response = await callSkillsRoute(["index.json"], {
    "x-forwarded-host": "pdpp.dev",
    "x-forwarded-proto": "https",
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", APPLICATION_JSON);

  const body = await jsonOf(response);
  assert.equal(body.object, "agent_skill_catalog");
  const skills = body.skills as Array<{ files: Array<{ url: string }> }>;
  assert.equal(skills.length, 1);
  assert.ok(
    skills[0]?.files.some((file) => file.url === "https://pdpp.dev/.well-known/skills/pdpp-data-access/SKILL.md")
  );
});

test("agent skill .well-known route serves only allowlisted files", async () => {
  const skill = await callSkillsRoute(["pdpp-data-access", "SKILL.md"]);
  assert.equal(skill.status, 200);
  assert.match(skill.headers.get("content-type") ?? "", TEXT_MARKDOWN);
  assert.equal(skill.headers.get("x-content-type-options"), "nosniff");
  assert.match(await skill.text(), PDPP_SKILL_FRONTMATTER);

  const reference = await callSkillsRoute(["pdpp-data-access", "references", "troubleshooting.md"]);
  assert.equal(reference.status, 200);
  assert.match(reference.headers.get("content-type") ?? "", TEXT_MARKDOWN);
  assert.match(await reference.text(), TROUBLESHOOTING_HEADING);

  const traversal = await callSkillsRoute(["pdpp-data-access", "..", "..", "package.json"]);
  assert.equal(traversal.status, 404);
  assert.match(traversal.headers.get("content-type") ?? "", APPLICATION_JSON);
  const traversalBody = await jsonOf(traversal);
  assert.deepEqual(traversalBody, {
    error: {
      type: "not_found_error",
      code: "not_found",
      message: "Skill file not found",
    },
  });
});
