// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GET } from "./[...path]/route.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_REWRITE_PAIR =
  /source:\s*['"]\/\.well-known\/skills\/:path\*['"][\s\S]*?destination:\s*['"]\/well-known\/skills\/:path\*['"]/;

const APPLICATION_JSON = /^application\/json/;
const PDPP_SKILL_FRONTMATTER = /name: pdpp-data-access/;
const OWNER_AGENT_SKILL_FRONTMATTER = /name: pdpp-owner-agent/;
const TEXT_MARKDOWN = /^text\/markdown/;
const TROUBLESHOOTING_HEADING = /# Troubleshooting/;

function callSkillsRoute(routePath: string[], headers?: HeadersInit): Promise<Response> {
  return GET(new Request(`http://0.0.0.0:3000/.well-known/skills/${routePath.join("/")}`, { headers }), {
    params: Promise.resolve({ path: routePath }),
  });
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

test("console .well-known skills route serves the catalog with forwarded origin", async () => {
  const response = await callSkillsRoute(["index.json"], {
    "x-forwarded-host": "pdpp.example.com",
    "x-forwarded-proto": "https",
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", APPLICATION_JSON);

  const body = await jsonOf(response);
  assert.equal(body.object, "agent_skill_catalog");
  const skills = body.skills as Array<{ files: Array<{ url: string }> }>;
  assert.equal(skills.length, 2);
  assert.ok(
    skills[0]?.files.some(
      (file) => file.url === "https://pdpp.example.com/.well-known/skills/pdpp-data-access/SKILL.md"
    )
  );
  assert.ok(
    skills.some((skill) =>
      skill.files.some((file) => file.url === "https://pdpp.example.com/.well-known/skills/pdpp-owner-agent/SKILL.md")
    )
  );
});

test("console well-known skills handler lives at the rewrite destination", () => {
  const handler = path.join(HERE, "[...path]", "route.ts");
  assert.equal(existsSync(handler), true, `expected handler at ${handler}`);

  const dotPrefixed = path.join(HERE, "..", "..", ".well-known", "skills", "[...path]", "route.ts");
  assert.equal(
    existsSync(dotPrefixed),
    false,
    "dot-prefixed App Router folders are private; the handler must NOT live under app/.well-known/**"
  );

  const nextConfigPath = path.resolve(HERE, "..", "..", "..", "..", "next.config.mjs");
  const nextConfig = readFileSync(nextConfigPath, "utf8");
  assert.match(
    nextConfig,
    SKILLS_REWRITE_PAIR,
    "next.config.mjs must rewrite /.well-known/skills/** to the routable /well-known/skills/** destination"
  );
});

test("console .well-known skills route serves only allowlisted files", async () => {
  const skill = await callSkillsRoute(["pdpp-data-access", "SKILL.md"]);
  assert.equal(skill.status, 200);
  assert.match(skill.headers.get("content-type") ?? "", TEXT_MARKDOWN);
  assert.equal(skill.headers.get("x-content-type-options"), "nosniff");
  assert.match(await skill.text(), PDPP_SKILL_FRONTMATTER);

  const reference = await callSkillsRoute(["pdpp-data-access", "references", "troubleshooting.md"]);
  assert.equal(reference.status, 200);
  assert.match(reference.headers.get("content-type") ?? "", TEXT_MARKDOWN);
  assert.match(await reference.text(), TROUBLESHOOTING_HEADING);

  const ownerAgent = await callSkillsRoute(["pdpp-owner-agent", "SKILL.md"]);
  assert.equal(ownerAgent.status, 200);
  assert.match(ownerAgent.headers.get("content-type") ?? "", TEXT_MARKDOWN);
  assert.match(await ownerAgent.text(), OWNER_AGENT_SKILL_FRONTMATTER);

  const traversal = await callSkillsRoute(["pdpp-data-access", "..", "..", "package.json"]);
  assert.equal(traversal.status, 404);
  assert.match(traversal.headers.get("content-type") ?? "", APPLICATION_JSON);
  assert.deepEqual(await jsonOf(traversal), {
    error: {
      code: "not_found",
      message: "Skill file not found",
      type: "not_found_error",
    },
  });
});
