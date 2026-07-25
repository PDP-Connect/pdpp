#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync, readFileSync } from "node:fs";

const SEMVER_PATTERN = /([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+][0-9A-Za-z.-]+)?/;
const DRY_RUN_VERSION_PATTERN = /next release version is\s+([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)/i;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function appendOutputs(outputs: Record<string, string>): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  const lines = Object.entries(outputs).map(([key, value]) => {
    const normalized = value === null ? "" : String(value);
    if (normalized.includes("\n") || normalized.includes("\r")) {
      fail(`Refusing to write multiline GitHub output for ${key}`);
    }
    return `${key}=${normalized}`;
  });

  if (!outputPath) {
    for (const line of lines) {
      console.log(line);
    }
    return;
  }

  appendFileSync(outputPath, `${lines.join("\n")}\n`);
}

function releaseOutputs(version: string, gitTag = `v${version}`): Record<string, string> {
  const match = version.match(SEMVER_PATTERN);
  if (!match) {
    fail(`Invalid semantic-release version: ${version}`);
  }

  return {
    "new-release-published": "true",
    "new-release-version": version,
    "new-release-git-tag": gitTag,
    "new-release-major-minor": `${match[1]}.${match[2]}`,
  };
}

function parseDryRun(logPath: string): void {
  const log = readFileSync(logPath, "utf8");
  const match = log.match(DRY_RUN_VERSION_PATTERN);

  if (!match) {
    appendOutputs({
      "new-release-published": "false",
      "new-release-version": "",
      "new-release-git-tag": "",
      "new-release-major-minor": "",
    });
    console.log("semantic-release dry run did not resolve a new release.");
    return;
  }

  const version = match[1] as string;
  appendOutputs(releaseOutputs(version));
  console.log(`semantic-release dry run resolved ${version}.`);
}

function markPublished(version: string, gitTag: string): void {
  appendOutputs(releaseOutputs(version, gitTag));
  console.log(`semantic-release published ${gitTag}.`);
}

const [mode, ...args] = process.argv.slice(2);

if (mode === "dry-run") {
  const [logPath] = args;
  if (!logPath) {
    fail("Usage: semantic-release-github-output.ts dry-run <log-path>");
  }
  parseDryRun(logPath);
} else if (mode === "publish") {
  const [version, gitTag] = args;
  if (!(version && gitTag)) {
    fail("Usage: semantic-release-github-output.ts publish <version> <git-tag>");
  }
  markPublished(version, gitTag);
} else {
  fail("Usage: semantic-release-github-output.ts <dry-run|publish> ...");
}
