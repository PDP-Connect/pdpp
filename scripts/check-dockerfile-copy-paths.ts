#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Fails closed if a Dockerfile `COPY <src> <dest>` instruction references a
// source path that does not exist on disk. Root/deploy Dockerfiles COPY
// individual files from apps/**, packages/**, and reference-implementation/**
// by literal path (for Docker layer caching) — a rename in those trees
// without a matching Dockerfile update silently breaks the image build only
// at `docker build` time, not at `pnpm install`/`tsc`/`biome` time. This is
// the class of drift a cross-branch rename integration can introduce.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DOCKERFILES = ["Dockerfile", "deploy/railway/reference.Dockerfile"];

// Matches `COPY <src...> <dest>` for the literal (non `--from=`) form this
// repo uses to COPY individual manifest/script files for cache-friendly
// layering. Multi-source COPY (`COPY a b c dest/`) is handled by treating
// every space-separated token except the last as a source.
const COPY_INSTRUCTION_PATTERN = /^COPY\s+(?!--from=)(.+)$/;
const WHITESPACE_PATTERN = /\s+/;

interface Violation {
  dockerfile: string;
  line: number;
  path: string;
}

function checkDockerfile(relativePath: string): Violation[] {
  const fullPath = join(REPO_ROOT, relativePath);
  if (!existsSync(fullPath)) {
    return [];
  }
  const violations: Violation[] = [];
  const lines = readFileSync(fullPath, "utf8").split("\n");
  for (const [index, rawLine] of lines.entries()) {
    const match = COPY_INSTRUCTION_PATTERN.exec(rawLine.trim());
    if (!match) {
      continue;
    }
    const tokens = (match[1] ?? "").trim().split(WHITESPACE_PATTERN);
    if (tokens.length < 2) {
      continue;
    }
    // Last token is the destination; every earlier token is a source path.
    const sources = tokens.slice(0, -1);
    for (const source of sources) {
      // Skip wildcard/dynamic sources — this check only guards literal,
      // renameable file paths, not glob patterns or build-context roots.
      if (source.includes("*") || source === "." || source.startsWith("$")) {
        continue;
      }
      const sourcePath = join(REPO_ROOT, source);
      if (!existsSync(sourcePath)) {
        violations.push({ dockerfile: relativePath, line: index + 1, path: source });
      }
    }
  }
  return violations;
}

function main(): void {
  const violations = DOCKERFILES.flatMap(checkDockerfile);
  if (violations.length > 0) {
    console.error(`check-dockerfile-copy-paths: ${violations.length} stale COPY source path(s)`);
    for (const violation of violations) {
      console.error(`  ${violation.dockerfile}:${violation.line}: missing ${violation.path}`);
    }
    process.exit(1);
  }
  console.log(
    `check-dockerfile-copy-paths: all COPY source paths resolved across ${DOCKERFILES.length} Dockerfile(s).`
  );
}

main();
