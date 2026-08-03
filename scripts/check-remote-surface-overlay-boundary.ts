#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// LOCAL-ONLY UAT guard for candidate 0803: reference-implementation vendors
// an unpublished @opendatalabs/remote-surface tarball (lease-cleanup
// contract) while apps/console must keep resolving the registry-published
// range it declares. A pnpm-workspace.yaml `overrides` entry for this
// package would silently force every importer onto the vendored tarball
// (that regression is what this check exists to catch), so this asserts
// per-importer resolution straight from the lockfile rather than trusting
// the declared specifier in each package.json.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "@opendatalabs/remote-surface";
const CONSOLE_IMPORTER = "apps/console";
const RI_IMPORTER = "reference-implementation";
const TARBALL_VERSION_PATTERN = /^file:/;

const OVERRIDES_ENTRY_PATTERN = /^overrides:\n([\s\S]*?)(?:\n\S|\n$|$)/;
const IMPORTER_HEADER_PATTERN = /^ {2}(\S.*):\n/gm;
const DEPENDENCY_BLOCK_PATTERN = /^ {6}'?@opendatalabs\/remote-surface'?:\n( {8}specifier: (.+)\n {8}version: (.+)\n)/m;

interface ImporterResolution {
  specifier: string;
  version: string;
}

// Pure text-scan over the raw pnpm-lock.yaml so it can be unit tested against
// fixture strings without a YAML parser dependency (none is present in this
// workspace) and without requiring a real `pnpm install` to run.
export function findRemoteSurfaceOverlayBoundaryErrors(lockfileText: string): string[] {
  const problems: string[] = [];

  const overridesMatch = lockfileText.match(OVERRIDES_ENTRY_PATTERN);
  const overridesBlock = overridesMatch?.[1] ?? "";
  if (new RegExp(`^\\s*'?${escapeRegExp(PACKAGE_NAME)}'?:`, "m").test(overridesBlock)) {
    problems.push(
      `pnpm-lock.yaml declares a workspace-wide overrides["${PACKAGE_NAME}"]; this forces every importer onto one resolution and defeats the console/reference-implementation split`
    );
  }

  const importerSections = splitImporterSections(lockfileText);

  const consoleResolution = findDependencyInImporter(importerSections, CONSOLE_IMPORTER);
  if (!consoleResolution) {
    problems.push(`${CONSOLE_IMPORTER} importer has no ${PACKAGE_NAME} dependency in pnpm-lock.yaml`);
  } else if (TARBALL_VERSION_PATTERN.test(consoleResolution.version)) {
    problems.push(
      `${CONSOLE_IMPORTER} must resolve ${PACKAGE_NAME} from the registry; got local tarball resolution ${consoleResolution.version}`
    );
  }

  const riResolution = findDependencyInImporter(importerSections, RI_IMPORTER);
  if (!riResolution) {
    problems.push(`${RI_IMPORTER} importer has no ${PACKAGE_NAME} dependency in pnpm-lock.yaml`);
  } else if (!TARBALL_VERSION_PATTERN.test(riResolution.version)) {
    problems.push(
      `${RI_IMPORTER} must resolve ${PACKAGE_NAME} from the vendored local tarball; got ${riResolution.version}`
    );
  }

  return problems;
}

function splitImporterSections(lockfileText: string): Map<string, string> {
  const importersMatch = lockfileText.match(/^importers:\n([\s\S]*?)^packages:\n/m);
  const importersBlock = importersMatch?.[1] ?? "";

  const headers = [...importersBlock.matchAll(IMPORTER_HEADER_PATTERN)];
  const sections = new Map<string, string>();
  for (const [index, header] of headers.entries()) {
    const rawName = header[1];
    if (rawName === undefined) {
      continue;
    }
    const name = rawName.replace(/^'|'$/g, "");
    const start = (header.index ?? 0) + header[0].length;
    const nextHeader = headers[index + 1];
    const end = nextHeader ? (nextHeader.index ?? importersBlock.length) : importersBlock.length;
    sections.set(name, importersBlock.slice(start, end));
  }
  return sections;
}

function findDependencyInImporter(importerSections: Map<string, string>, importerName: string): ImporterResolution | undefined {
  const section = importerSections.get(importerName);
  if (!section) {
    return undefined;
  }
  const match = section.match(DEPENDENCY_BLOCK_PATTERN);
  const specifier = match?.[2];
  const version = match?.[3];
  if (specifier === undefined || version === undefined) {
    return undefined;
  }
  return { specifier: specifier.trim(), version: version.trim() };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  const lockfileText = readFileSync(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
  const errors = findRemoteSurfaceOverlayBoundaryErrors(lockfileText);

  if (errors.length > 0) {
    console.error(`${PACKAGE_NAME} dependency-boundary check failed:`);
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(
    `${PACKAGE_NAME} dependency-boundary OK: ${CONSOLE_IMPORTER} -> registry, ${RI_IMPORTER} -> local tarball`
  );
}
