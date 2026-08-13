// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findCanonicalEntrypointBypasses, formatRatchetFindings } from "./canonical-entrypoints.ts";

const repositoryRoot = new URL("../..", import.meta.url);

async function fixtureRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pdpp-scratch-ratchet-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { "test:scratch": "node test-scratch/run-command.ts" } })
  );
  return root;
}

async function writeFixture(root: string, path: string, source: string): Promise<void> {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), source);
}

test("repository-derived package, workflow, and host-writer inventories have no bypasses", async () => {
  const root = new URL(".", repositoryRoot).pathname;
  const findings = await findCanonicalEntrypointBypasses(root);
  assert.deepEqual(findings, [], formatRatchetFindings(findings, root));
});

test("a newly discovered package test front door cannot bypass the owner", async () => {
  const root = await fixtureRepository();
  try {
    await writeFixture(
      root,
      "packages/new/package.json",
      JSON.stringify({ scripts: { probe: "node --test probe.test.ts" } })
    );
    const findings = await findCanonicalEntrypointBypasses(root);
    assert.ok(findings.some((finding) => finding.path === "packages/new/package.json"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a newly discovered block-scalar workflow test command cannot bypass the owner", async () => {
  const root = await fixtureRepository();
  try {
    await writeFixture(
      root,
      ".github/workflows/new.yml",
      "jobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          node --test probe.test.ts\n"
    );
    const findings = await findCanonicalEntrypointBypasses(root);
    assert.ok(findings.some((finding) => finding.path === ".github/workflows/new.yml"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the standalone lifecycle oracle exception cannot bless another raw workflow test", async () => {
  const root = await fixtureRepository();
  try {
    await writeFixture(
      root,
      ".github/workflows/test-scratch-lifecycle.yml",
      [
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: pnpm exec tsx --test scripts/test-scratch/run-command.test.ts",
        "      - run: pnpm exec tsx --test scripts/test-scratch/canonical-entrypoints.test.ts",
        "",
      ].join("\n")
    );
    const findings = await findCanonicalEntrypointBypasses(root);
    assert.deepEqual(findings, [
      {
        path: ".github/workflows/test-scratch-lifecycle.yml",
        reason:
          "workflow run bypasses the scratch owner: pnpm exec tsx --test scripts/test-scratch/canonical-entrypoints.test.ts",
      },
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the lifecycle workflow routes its static ratchet through one owner", async () => {
  const root = await fixtureRepository();
  try {
    await writeFixture(
      root,
      ".github/workflows/test-scratch-lifecycle.yml",
      [
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: pnpm exec tsx --test scripts/test-scratch/run-command.test.ts",
        "      - run: pnpm test:scratch -- pnpm exec tsx --test scripts/test-scratch/canonical-entrypoints.test.ts",
        "",
      ].join("\n")
    );
    assert.deepEqual(await findCanonicalEntrypointBypasses(root), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a newly discovered executable literal host writer cannot bypass review", async () => {
  const root = await fixtureRepository();
  try {
    await writeFixture(
      root,
      "scripts/new-writer.ts",
      'import { writeFile } from "node:fs/promises";\nawait writeFile("/tmp/bypass", "x");\n'
    );
    const findings = await findCanonicalEntrypointBypasses(root);
    assert.ok(findings.some((finding) => finding.path === "scripts/new-writer.ts"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("shell writer command-position prefixes cannot bypass review", async () => {
  const root = await fixtureRepository();
  try {
    const mutations = new Map([
      ["scripts/assignment.sh", "TMPDIR=/tmp tee /tmp/assignment"],
      ["scripts/env.sh", "env TMPDIR=/tmp tee /tmp/env"],
      ["scripts/env-options.sh", "env --ignore-environment --unset=HOME tee /tmp/env-options"],
      ["scripts/command-options.sh", "command -p -- tee /tmp/command-options"],
      ["scripts/sudo-options.sh", "sudo -n -u runner -- tee /tmp/sudo-options"],
      ["scripts/sudo-long-option.sh", "sudo --user runner tee /tmp/sudo-long-option"],
      ["scripts/combined.sh", "env -- command -p sudo -- tee /tmp/combined"],
    ]);
    await Promise.all([...mutations].map(([path, source]) => writeFixture(root, path, `${source}\n`)));
    const findings = await findCanonicalEntrypointBypasses(root);
    assert.deepEqual(new Set(findings.map((finding) => finding.path)), new Set(mutations.keys()));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a reviewed occurrence does not exempt another writer in the same file", async () => {
  const root = await fixtureRepository();
  try {
    await writeFixture(
      root,
      "scripts/docker-smoke.sh",
      ['export PDPP_DB_PATH="', "$", '{PDPP_DB_PATH:-/tmp/pdpp-smoke.sqlite}"\ncommand tee /tmp/unreviewed\n'].join("")
    );
    const findings = await findCanonicalEntrypointBypasses(root);
    assert.ok(findings.some((finding) => finding.path === "scripts/docker-smoke.sh"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("owner tokens outside the test command cannot bless a workflow bypass", async () => {
  const root = await fixtureRepository();
  try {
    await writeFixture(
      root,
      ".github/workflows/new.yml",
      "jobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          echo test:scratch\n          node --test bypass.test.ts\n"
    );
    const findings = await findCanonicalEntrypointBypasses(root);
    assert.ok(findings.some((finding) => finding.path === ".github/workflows/new.yml"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a reviewed root alias cannot hide a newly added raw test", async () => {
  const root = await fixtureRepository();
  try {
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        scripts: {
          "test:scratch": "node test-scratch/run-command.ts",
          "friend-journey:acceptance": "node --test bypass.test.ts",
        },
      })
    );
    const findings = await findCanonicalEntrypointBypasses(root);
    assert.ok(findings.some((finding) => finding.path === "package.json"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
