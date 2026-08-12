// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OWNER_COMMAND = /test-scratch\/run-command/;
const ROOT_OWNER = /test:scratch/;
const RI_DELEGATE = /pnpm --dir reference-implementation run test/;
const PACKAGE_OWNER = /test-scratch\/run-command|pnpm test/;
const OLD_LEDGER_PATH = /mkdtempSync\("\/tmp\/pdpp-replacement-ledger/;
const SCRATCH_ROOT = /PDPP_TEST_SCRATCH_ROOT/;
const SHARED_LOCK = /PDPP_NEKO_DYNAMIC_SMOKE_PORT_LOCK_FILE:-\/tmp\/pdpp-neko-dynamic-smoke-ports\.lock/;
const CONTAINER_PATH = /\/tmp\/pdpp-smoke\.sqlite/;
const RAW_WORKFLOW_TEST = /run:.*(node --test|tsx .*\.test\.|bash scripts\/.*\.test\.sh)/;

function requiredScript(scripts: Record<string, string>, name: string): string {
  const command = scripts[name];
  assert.ok(command, `missing script: ${name}`);
  return command;
}
const rootAliases = [
  "docker:first-boot:test",
  "docker:core:headed-oracle:test",
  "railway:template:test",
  "railway:ghcr-public:test",
  "railway:env-check:test",
  "railway:mcp-query-smoke:test",
  "read-surface:smoke:test",
  "flyio:env:check:test",
  "stream:parity:oracle",
  "agent-skill:boundary-check",
  "openspec:archive-check:test",
  "public-tree:hygiene-check:test",
  "release:policy-check:test",
  "release:matrix:test",
  "release:dist-tag-check:test",
  "owner-journey:acceptance:test",
  "console:health-surface-gate:test",
  "ci:mode:test",
  "test-accounting:check",
  "test-accounting:test",
  "ri-suite:completion:test",
  "docker:reference:verify",
  "docker:smoke",
  "docker:neko:dynamic-allocator-smoke",
  "docker:core:amazon-routes-smoke",
  "docker:stream-smoke",
  "railway:sqlite-restart-smoke",
  "railway:mcp-query-smoke",
  "read-surface:smoke",
  "cli:connect-smoke",
  "stream:no-human-verify",
];
const packageFiles = [
  "reference-implementation/package.json",
  "packages/cli/package.json",
  "packages/local-collector/package.json",
  "packages/read-core/package.json",
  "packages/mcp-server/package.json",
  "packages/polyfill-connectors/package.json",
  "packages/display/package.json",
  "packages/reference-contract/package.json",
  "packages/operator-ui/package.json",
  "packages/pdpp-brand-react/package.json",
  "apps/console/package.json",
  "apps/site/package.json",
];
const workflowFiles = [
  ".github/workflows/reference-implementation.yml",
  ".github/workflows/openspec-archive-check.yml",
  ".github/workflows/remote-surface.yml",
  ".github/workflows/docker-images.yml",
  ".github/workflows/reference-stack-project-safety.yml",
];

test("canonical root and package test front doors enter exactly one scratch owner", async () => {
  const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.match(requiredScript(rootPackage.scripts, "test:scratch"), OWNER_COMMAND);
  for (const alias of rootAliases) {
    assert.match(requiredScript(rootPackage.scripts, alias), ROOT_OWNER);
  }
  assert.match(requiredScript(rootPackage.scripts, "reference-implementation:test"), RI_DELEGATE);
  const packageJsons = await Promise.all(
    packageFiles.map(async (packageFile) => ({
      packageFile,
      packageJson: JSON.parse(await readFile(join(root, packageFile), "utf8")) as {
        scripts: Record<string, string>;
      },
    }))
  );
  for (const { packageFile, packageJson } of packageJsons) {
    assert.ok(packageFile);
    for (const [name, command] of Object.entries(packageJson.scripts)) {
      if (name === "test" || name.startsWith("test:") || (name === "verify" && command.includes("pnpm test"))) {
        assert.match(command, PACKAGE_OWNER);
      }
    }
  }
});

test("reviewed literal /tmp exceptions remain narrow and host profile writers use the invocation root", async () => {
  const browserLedger = await readFile(
    join(root, "reference-implementation/test/browser-surface-replacement-ledger-store.test.ts"),
    "utf8"
  );
  assert.doesNotMatch(browserLedger, OLD_LEDGER_PATH);
  const profileScripts = [
    "scripts/docker-neko-network-durability-smoke.sh",
    "scripts/docker-neko-network-migration-smoke.sh",
    "scripts/docker-neko-dynamic-allocator-smoke-config.mjs",
  ];
  const sources = await Promise.all(profileScripts.map((script) => readFile(join(root, script), "utf8")));
  for (const source of sources) {
    assert.match(source, SCRATCH_ROOT);
  }
  const dynamic = await readFile(join(root, "scripts/docker-neko-dynamic-allocator-smoke.sh"), "utf8");
  assert.match(dynamic, SHARED_LOCK);
  const dockerSmoke = await readFile(join(root, "scripts/docker-smoke.sh"), "utf8");
  assert.match(dockerSmoke, CONTAINER_PATH);
});

test("raw workflow test commands are owner-routed", async () => {
  const workflows = await Promise.all(workflowFiles.map((workflow) => readFile(join(root, workflow), "utf8")));
  for (const workflow of workflows) {
    for (const line of workflow.split("\n")) {
      if (RAW_WORKFLOW_TEST.test(line)) {
        assert.match(line, ROOT_OWNER, `raw workflow test bypasses scratch owner: ${line.trim()}`);
      }
    }
  }
});
