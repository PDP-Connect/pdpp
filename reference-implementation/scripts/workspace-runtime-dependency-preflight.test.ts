// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertWorkspaceRuntimeDependencies,
  invalidWorkspaceRuntimeDependencies,
} from "./workspace-runtime-dependency-preflight.ts";

const FROZEN_INSTALL_PATTERN = /pnpm install --frozen-lockfile/;
const BORROWED_INSTALL_PATTERN = /worktree node_modules resolves outside this worktree's installation boundary/;
const LOCK_IMPORTER_PATTERN = /lockfile importer does not record/;
const LOCK_VERSION_PATTERN = /does not match lockfile version/;
const LOCK_WORKSPACE_LINK_PATTERN = /lockfile workspace link does not resolve/;
const OUTSIDE_INSTALL_PATTERN = /escapes this worktree's node_modules installation boundary/;
const UNRESOLVED_LINK_PATTERN = /link does not resolve/;
const WORKSPACE_LINK_PATTERN = /workspace link does not resolve/;

async function writePackage(
  directory: string,
  name: string,
  version: string,
  dependencies: Record<string, string> = {}
) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ dependencies, name, version }));
}

async function workspaceFixture(): Promise<{
  link: string;
  root: string;
  storePackage: string;
  workspaceLink: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "pdpp-workspace-runtime-dependencies-"));
  const connector = join(root, "packages/connector");
  const storePackage = join(root, "node_modules/.pnpm/@streamparser+json@0.0.26/node_modules/@streamparser/json");
  const link = join(connector, "node_modules/@streamparser/json");
  const workspaceLink = join(connector, "node_modules/@pdpp/display");
  await Promise.all([
    writePackage(connector, "connector", "0.0.1", {
      "@pdpp/display": "workspace:*",
      "@streamparser/json": "^0.0.25",
    }),
    writePackage(join(root, "apps/console"), "console", "0.0.1"),
    writePackage(join(root, "packages/display"), "@pdpp/display", "0.0.1"),
    writePackage(join(root, "reference-implementation"), "ri", "0.0.1"),
    writePackage(storePackage, "@streamparser/json", "0.0.26"),
  ]);
  await Promise.all([
    mkdir(join(connector, "node_modules/@pdpp"), { recursive: true }),
    mkdir(join(connector, "node_modules/@streamparser"), { recursive: true }),
  ]);
  await Promise.all([symlink(storePackage, link), symlink(join(root, "packages/display"), workspaceLink)]);
  await writeFile(
    join(root, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'\n\nimporters:\n\n  apps/console:\n    dependencies: {}\n\n  packages/connector:\n    dependencies:\n      '@pdpp/display':\n        specifier: workspace:*\n        version: link:../display\n      '@streamparser/json':\n        specifier: ^0.0.25\n        version: 0.0.26\n\n  packages/display:\n    dependencies: {}\n\n  reference-implementation:\n    dependencies: {}\n`
  );
  return { link, root, storePackage, workspaceLink };
}

async function replaceLink(link: string, target: string): Promise<void> {
  await rm(link, { force: true });
  await symlink(target, link);
}

test("workspace dependency preflight accepts a resolved package inside this worktree that matches the lockfile", async () => {
  const { root } = await workspaceFixture();
  try {
    assert.deepEqual(await invalidWorkspaceRuntimeDependencies(root), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("workspace dependency preflight rejects a dangling package-local link", async () => {
  const { link, root } = await workspaceFixture();
  try {
    await replaceLink(link, join(root, "node_modules/.pnpm/missing/node_modules/@streamparser/json"));
    assert.match((await invalidWorkspaceRuntimeDependencies(root))[0]?.reason ?? "", UNRESOLVED_LINK_PATTERN);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("workspace dependency preflight rejects a stale external package even when its identity and version look valid", async () => {
  const { link, root } = await workspaceFixture();
  const external = await mkdtemp(join(tmpdir(), "pdpp-external-node-modules-"));
  try {
    await writePackage(external, "@streamparser/json", "0.0.26");
    await replaceLink(link, external);
    assert.match((await invalidWorkspaceRuntimeDependencies(root))[0]?.reason ?? "", OUTSIDE_INSTALL_PATTERN);
  } finally {
    await Promise.all([rm(root, { force: true, recursive: true }), rm(external, { force: true, recursive: true })]);
  }
});

test("workspace dependency preflight rejects a borrowed root node_modules installation", async () => {
  const { link, root } = await workspaceFixture();
  const externalRoot = await mkdtemp(join(tmpdir(), "pdpp-borrowed-node-modules-"));
  const externalNodeModules = join(externalRoot, "node_modules");
  try {
    await writePackage(
      join(externalNodeModules, ".pnpm/@streamparser+json@0.0.26/node_modules/@streamparser/json"),
      "@streamparser/json",
      "0.0.26"
    );
    await rm(join(root, "node_modules"), { force: true, recursive: true });
    await symlink(externalNodeModules, join(root, "node_modules"));
    await replaceLink(link, join(root, "node_modules/.pnpm/@streamparser+json@0.0.26/node_modules/@streamparser/json"));
    assert.match((await invalidWorkspaceRuntimeDependencies(root))[0]?.reason ?? "", BORROWED_INSTALL_PATTERN);
  } finally {
    await Promise.all([rm(root, { force: true, recursive: true }), rm(externalRoot, { force: true, recursive: true })]);
  }
});

test("workspace dependency preflight rejects a stale external workspace package link", async () => {
  const { root, workspaceLink } = await workspaceFixture();
  const external = await mkdtemp(join(tmpdir(), "pdpp-external-workspace-package-"));
  try {
    await writePackage(external, "@pdpp/display", "0.0.1");
    await replaceLink(workspaceLink, external);
    const invalid = await invalidWorkspaceRuntimeDependencies(root);
    assert.match(
      invalid.find(({ dependency }) => dependency === "@pdpp/display")?.reason ?? "",
      WORKSPACE_LINK_PATTERN
    );
  } finally {
    await Promise.all([rm(root, { force: true, recursive: true }), rm(external, { force: true, recursive: true })]);
  }
});

test("workspace dependency preflight rejects a lockfile workspace target that disagrees with the package", async () => {
  const { root } = await workspaceFixture();
  try {
    const lockfilePath = join(root, "pnpm-lock.yaml");
    const lockfile = await readFile(lockfilePath, "utf8");
    await writeFile(lockfilePath, lockfile.replace("version: link:../display", "version: link:../stale-display"));
    const invalid = await invalidWorkspaceRuntimeDependencies(root);
    assert.match(
      invalid.find(({ dependency }) => dependency === "@pdpp/display")?.reason ?? "",
      LOCK_WORKSPACE_LINK_PATTERN
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("workspace dependency preflight rejects a declared package absent from its lockfile importer", async () => {
  const { root } = await workspaceFixture();
  try {
    const lockfilePath = join(root, "pnpm-lock.yaml");
    const lockfile = await readFile(lockfilePath, "utf8");
    await writeFile(lockfilePath, lockfile.replace("        version: 0.0.26\n", ""));
    const invalid = await invalidWorkspaceRuntimeDependencies(root);
    assert.match(
      invalid.find(({ dependency }) => dependency === "@streamparser/json")?.reason ?? "",
      LOCK_IMPORTER_PATTERN
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("workspace dependency preflight rejects a stale in-worktree package that satisfies the manifest range but not the lockfile", async () => {
  const { root, storePackage } = await workspaceFixture();
  try {
    await writePackage(storePackage, "@streamparser/json", "0.0.25");
    assert.match((await invalidWorkspaceRuntimeDependencies(root))[0]?.reason ?? "", LOCK_VERSION_PATTERN);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("workspace dependency preflight fails closed with the immutable-install repair", async () => {
  const { link, root } = await workspaceFixture();
  try {
    await replaceLink(link, join(root, "node_modules/.pnpm/missing/node_modules/@streamparser/json"));
    await assert.rejects(assertWorkspaceRuntimeDependencies(root), FROZEN_INSTALL_PATTERN);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
