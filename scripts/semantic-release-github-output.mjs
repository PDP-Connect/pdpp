#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync, readFileSync } from "node:fs";

const SEMVER_RE = /([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+][0-9A-Za-z.-]+)?/;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function appendOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  const lines = Object.entries(outputs).map(([key, value]) => {
    const normalized = value == null ? "" : String(value);
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

function releaseOutputs(version, gitTag = `v${version}`) {
  const match = version.match(SEMVER_RE);
  if (!match) {
    fail(`Invalid semantic-release version: ${version}`);
  }

  return {
    "new-release-git-tag": gitTag,
    "new-release-major-minor": `${match[1]}.${match[2]}`,
    "new-release-published": "true",
    "new-release-version": version,
  };
}

function parseDryRun(logPath) {
  const log = readFileSync(logPath, "utf8");
  const match = log.match(/next release version is\s+([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)/i);

  if (!match) {
    appendOutputs({
      "new-release-git-tag": "",
      "new-release-major-minor": "",
      "new-release-published": "false",
      "new-release-version": "",
    });
    console.log("semantic-release dry run did not resolve a new release.");
    return;
  }

  const version = match[1];
  appendOutputs(releaseOutputs(version));
  console.log(`semantic-release dry run resolved ${version}.`);
}

function markPublished(version, gitTag) {
  appendOutputs(releaseOutputs(version, gitTag));
  console.log(`semantic-release published ${gitTag}.`);
}

const [mode, ...args] = process.argv.slice(2);

if (mode === "dry-run") {
  const [logPath] = args;
  if (!logPath) {
    fail("Usage: semantic-release-github-output.mjs dry-run <log-path>");
  }
  parseDryRun(logPath);
} else if (mode === "publish") {
  const [version, gitTag] = args;
  if (!(version && gitTag)) {
    fail("Usage: semantic-release-github-output.mjs publish <version> <git-tag>");
  }
  markPublished(version, gitTag);
} else {
  fail("Usage: semantic-release-github-output.mjs <dry-run|publish> ...");
}
