// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Verify the installed dependency graph a workspace test process will resolve.
 *
 * A package-local `node_modules/<dependency>` entry is not evidence on its own:
 * `lstat()` admits a dangling link, an old shared install, and a link that
 * escapes this worktree. The runner rejects a borrowed root installation, then
 * resolves every direct runtime link, confines external packages to that exact
 * worktree installation, validates package identity, and compares the resolved
 * package version with the lockfile importer when it supplies an exact version.
 */

import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

interface PackageManifest {
  dependencies?: Record<string, string>;
  name?: string;
  version?: string;
}

interface WorkspacePackage {
  dependencies: Record<string, string>;
  name: string;
  relativeDirectory: string;
  resolvedDirectory: string;
}

const DEPENDENCY_LINE = /^ {6}(.+):$/;
const IMPORTER_LINE = /^ {2}(\S.*):$/;
const IMPORTER_SECTION_LINE = /^ {4}\S.*:$/;
const LOCK_VERSION_LINE = /^ {8}version: (.+)$/;
const NUMERIC_PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const RUNTIME_DEPENDENCIES_LINE = /^ {4}dependencies:$/;

export interface InvalidWorkspaceRuntimeDependency {
  dependency: string;
  reason: string;
  workspace: string;
}

const BORROWED_INSTALLATION_REASON = "worktree node_modules resolves outside this worktree's installation boundary";

function isWithin(boundary: string, candidate: string): boolean {
  const pathFromBoundary = relative(boundary, candidate);
  return pathFromBoundary === "" || !(pathFromBoundary.startsWith("..") || isAbsolute(pathFromBoundary));
}

function unquote(value: string): string {
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1);
  }
  return value;
}

function importerLines(lockfile: string, importer: string): string[] {
  const lines = lockfile.split("\n");
  const importerStart = lines.findIndex((line) => unquote(IMPORTER_LINE.exec(line)?.[1] ?? "") === importer);
  if (importerStart === -1) {
    return [];
  }
  const nextImporter = lines.slice(importerStart + 1).findIndex((line) => IMPORTER_LINE.test(line));
  return lines.slice(importerStart + 1, nextImporter === -1 ? undefined : importerStart + nextImporter + 1);
}

/** Read a lockfile importer's resolved dependency value without loading a YAML runtime dependency. */
function lockedDependencyVersion(lockfile: string, importer: string, dependency: string): string | undefined {
  let inDependencies = false;
  let currentDependency: string | undefined;
  for (const line of importerLines(lockfile, importer)) {
    if (RUNTIME_DEPENDENCIES_LINE.test(line)) {
      inDependencies = true;
      currentDependency = undefined;
      continue;
    }
    if (IMPORTER_SECTION_LINE.test(line)) {
      inDependencies = false;
      currentDependency = undefined;
      continue;
    }
    if (!inDependencies) {
      continue;
    }
    const dependencyMatch = DEPENDENCY_LINE.exec(line);
    if (dependencyMatch) {
      currentDependency = unquote(dependencyMatch[1] ?? "");
      continue;
    }
    const versionMatch = LOCK_VERSION_LINE.exec(line);
    if (currentDependency === dependency && versionMatch) {
      return unquote(versionMatch[1] ?? "");
    }
  }
  return undefined;
}

function exactPackageVersion(lockVersion: string | undefined): string | undefined {
  if (!lockVersion || lockVersion.startsWith("file:") || lockVersion.startsWith("link:")) {
    return undefined;
  }
  const version = lockVersion.split("(")[0] ?? "";
  return NUMERIC_PACKAGE_VERSION.test(version) ? version : undefined;
}

async function packageManifestForDirectory(
  workspaceRoot: string,
  relativeDirectory: string
): Promise<WorkspacePackage> {
  const manifestPath = join(workspaceRoot, relativeDirectory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
  return {
    dependencies: manifest.dependencies ?? {},
    name: manifest.name ?? relativeDirectory,
    relativeDirectory,
    resolvedDirectory: await realpath(resolve(workspaceRoot, relativeDirectory)),
  };
}

async function workspaceDirectories(workspaceRoot: string): Promise<string[]> {
  const workspaceChildren = await Promise.all(
    ["apps", "packages"].map(async (parent) =>
      (await readdir(join(workspaceRoot, parent), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(parent, entry.name))
    )
  );
  return ["reference-implementation", ...workspaceChildren.flat()].sort();
}

async function invalidDependency(
  workspaceRoot: string,
  installationBoundary: string,
  lockfile: string,
  workspaceByName: Map<string, WorkspacePackage>,
  workspacePackage: WorkspacePackage,
  dependency: string,
  specifier: string
): Promise<InvalidWorkspaceRuntimeDependency | undefined> {
  const linkPath = join(workspaceRoot, workspacePackage.relativeDirectory, "node_modules", ...dependency.split("/"));
  let resolvedDependencyDirectory: string;
  try {
    resolvedDependencyDirectory = await realpath(linkPath);
  } catch (error) {
    return {
      dependency,
      reason: `link does not resolve (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`,
      workspace: workspacePackage.name,
    };
  }
  const lockVersion = lockedDependencyVersion(lockfile, workspacePackage.relativeDirectory, dependency);
  if (!lockVersion) {
    return {
      dependency,
      reason: "lockfile importer does not record this declared runtime dependency",
      workspace: workspacePackage.name,
    };
  }
  const expectedWorkspace = workspaceByName.get(dependency);
  if (specifier.startsWith("workspace:") || lockVersion?.startsWith("link:")) {
    if (!expectedWorkspace || resolvedDependencyDirectory !== expectedWorkspace.resolvedDirectory) {
      return {
        dependency,
        reason: "workspace link does not resolve to this worktree's declared workspace package",
        workspace: workspacePackage.name,
      };
    }
    if (
      lockVersion?.startsWith("link:") &&
      resolve(workspaceRoot, workspacePackage.relativeDirectory, lockVersion.slice("link:".length)) !==
        expectedWorkspace.resolvedDirectory
    ) {
      return {
        dependency,
        reason: "lockfile workspace link does not resolve to this worktree's declared workspace package",
        workspace: workspacePackage.name,
      };
    }
  } else if (!isWithin(installationBoundary, resolvedDependencyDirectory)) {
    return {
      dependency,
      reason: "resolved package escapes this worktree's node_modules installation boundary",
      workspace: workspacePackage.name,
    };
  }
  let installedManifest: PackageManifest;
  try {
    installedManifest = JSON.parse(
      await readFile(join(resolvedDependencyDirectory, "package.json"), "utf8")
    ) as PackageManifest;
  } catch (error) {
    return {
      dependency,
      reason: `resolved package has no readable package.json (${(error as NodeJS.ErrnoException).code ?? "invalid metadata"})`,
      workspace: workspacePackage.name,
    };
  }
  if (installedManifest.name !== dependency) {
    return {
      dependency,
      reason: `resolved package identifies as ${JSON.stringify(installedManifest.name)}, not ${JSON.stringify(dependency)}`,
      workspace: workspacePackage.name,
    };
  }
  const lockedVersion = exactPackageVersion(lockVersion);
  if (lockedVersion && installedManifest.version !== lockedVersion) {
    return {
      dependency,
      reason: `resolved package version ${JSON.stringify(installedManifest.version)} does not match lockfile version ${JSON.stringify(lockedVersion)}`,
      workspace: workspacePackage.name,
    };
  }
  return undefined;
}

/** Return every invalid direct runtime dependency in this workspace installation. */
export async function invalidWorkspaceRuntimeDependencies(
  workspaceRoot: string
): Promise<InvalidWorkspaceRuntimeDependency[]> {
  const packages = await Promise.all(
    (await workspaceDirectories(workspaceRoot)).map((relativeDirectory) =>
      packageManifestForDirectory(workspaceRoot, relativeDirectory)
    )
  );
  const workspaceByName = new Map(packages.map((workspacePackage) => [workspacePackage.name, workspacePackage]));
  const lockfile = await readFile(join(workspaceRoot, "pnpm-lock.yaml"), "utf8");
  const resolvedWorkspaceRoot = await realpath(workspaceRoot);
  const expectedInstallationBoundary = join(resolvedWorkspaceRoot, "node_modules");
  const installationBoundary = await realpath(expectedInstallationBoundary);
  if (installationBoundary !== expectedInstallationBoundary) {
    return packages.flatMap(({ dependencies, name }) =>
      Object.keys(dependencies).map((dependency) => ({
        dependency,
        reason: BORROWED_INSTALLATION_REASON,
        workspace: name,
      }))
    );
  }
  const inspections = packages.flatMap((workspacePackage) =>
    Object.entries(workspacePackage.dependencies).map(([dependency, specifier]) =>
      invalidDependency(
        workspaceRoot,
        installationBoundary,
        lockfile,
        workspaceByName,
        workspacePackage,
        dependency,
        specifier
      )
    )
  );
  return (await Promise.all(inspections)).filter(
    (result): result is InvalidWorkspaceRuntimeDependency => result !== undefined
  );
}

/** Fail before test discovery when the installed workspace graph is not this worktree's locked graph. */
export async function assertWorkspaceRuntimeDependencies(workspaceRoot: string): Promise<void> {
  const invalid = await invalidWorkspaceRuntimeDependencies(workspaceRoot);
  if (invalid.length === 0) {
    return;
  }
  const details = invalid
    .map(({ workspace, dependency, reason }) => `${workspace} -> ${dependency}: ${reason}`)
    .join("; ");
  throw new Error(
    `workspace runtime dependency graph is invalid (${details}). Run "pnpm install --frozen-lockfile" from ${workspaceRoot} before starting the RI test runner.`
  );
}
