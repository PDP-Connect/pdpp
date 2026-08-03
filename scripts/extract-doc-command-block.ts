#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Extracts one fenced code block from a markdown runbook by matching the
// literal text of the line immediately preceding the fence.
//
// The friend-readiness CI matrix (.github/workflows/friend-os-matrix.yml) runs
// the platform-specific secret-generation and Compose-fetch commands from
// docs/operator/selfhost-quickstart.md verbatim, instead of a hand-copied
// paraphrase living in the workflow file. A hand-copied command block can
// drift from the doc silently — the doc changes, CI keeps testing the old
// text, and a broken quickstart ships undetected. Extracting the block by
// anchor text means CI executes exactly what an operator would copy-paste,
// and a missing/renamed anchor fails loudly instead of silently matching
// nothing.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function extractFencedBlockAfterAnchor(source: string, anchor: string, language: string): string {
  const lines = source.split("\n");
  const anchorIndex = lines.findIndex((line) => line.includes(anchor));
  if (anchorIndex === -1) {
    throw new Error(`anchor not found: ${JSON.stringify(anchor)}`);
  }

  const fenceOpen = `\`\`\`${language}`;
  let fenceStart = -1;
  for (let index = anchorIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }
    if (line.trim() === fenceOpen) {
      fenceStart = index;
      break;
    }
    // A blank line or ordinary prose line is fine between anchor and fence;
    // another fence of a different language means we walked past our target.
    if (line.startsWith("```") && line.trim() !== fenceOpen) {
      throw new Error(
        `expected a ${JSON.stringify(fenceOpen)} fence after anchor ${JSON.stringify(anchor)}, found ${JSON.stringify(line.trim())}`
      );
    }
  }
  if (fenceStart === -1) {
    throw new Error(`no ${JSON.stringify(fenceOpen)} fence found after anchor ${JSON.stringify(anchor)}`);
  }

  const blockLines: string[] = [];
  for (let index = fenceStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      throw new Error(`unterminated fence after anchor ${JSON.stringify(anchor)}`);
    }
    if (line.trim() === "```") {
      return blockLines.join("\n");
    }
    blockLines.push(line);
  }
  throw new Error(`unterminated fence after anchor ${JSON.stringify(anchor)}`);
}

export function extractDocCommandBlock(relativeDocPath: string, anchor: string, language: string): string {
  const docPath = join(REPO_ROOT, relativeDocPath);
  const source = readFileSync(docPath, "utf8");
  return extractFencedBlockAfterAnchor(source, anchor, language);
}

function main(): void {
  const [, , docPath, anchor, language] = process.argv;
  if (!(docPath && anchor && language)) {
    console.error("usage: extract-doc-command-block.ts <doc-path> <anchor-text> <language>");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(extractDocCommandBlock(docPath, anchor, language));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
