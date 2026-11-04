#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Refreshes src/data/connector-catalog.json, the snapshot behind /apps.
//
// The page loads the catalogue live and refreshes it hourly. This file is
// the copy it falls back to when that load fails, so refresh it now and then.
// The loading code, and what it does and does not verify, is in
// src/lib/connector-catalog.mjs.
//
// Run: node scripts/sync-connector-catalog.mjs [--out <path>]

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConnectorSnapshot } from "../src/lib/connector-catalog.mjs";

// Measured against the repo formatter: it keeps a JSON array on one line up to this width.
const LINE_WIDTH = 80;
const TRAILING_COMMA = /,$/;
const STRING_ARRAY = /^( *)("[^"]+": )\[\n((?: +"(?:[^"\\]|\\.)*",?\n)+) *\]/gm;

/**
 * JSON.stringify output, with each short array of strings on one line. The
 * committed file is checked by the repo formatter, which lays arrays out the
 * same way, so a fresh sync leaves no formatting diff.
 */
export function formatSnapshot(snapshot) {
  const text = JSON.stringify(snapshot, null, 2).replace(STRING_ARRAY, (whole, indent, key, body) => {
    const items = body
      .trim()
      .split("\n")
      .map((item) => item.trim().replace(TRAILING_COMMA, ""));
    const line = `${indent}${key}[${items.join(", ")}]`;
    return line.length <= LINE_WIDTH ? line : whole;
  });
  return `${text}\n`;
}

const DEFAULT_OUTPUT = fileURLToPath(new URL("../src/data/connector-catalog.json", import.meta.url));

export async function syncConnectorCatalog(outputPath = DEFAULT_OUTPUT) {
  const snapshot = await loadConnectorSnapshot();
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, formatSnapshot(snapshot));
  return snapshot;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outIndex = process.argv.indexOf("--out");
  const outputPath = outIndex === -1 ? DEFAULT_OUTPUT : path.resolve(process.argv[outIndex + 1]);
  const snapshot = await syncConnectorCatalog(outputPath);
  const withLabels = snapshot.connectors.filter((connector) => connector.labels.length > 0).length;
  console.log(
    `Wrote ${snapshot.connectors.length} connectors (${withLabels} with labels) to ${outputPath}\n` +
      `manifest ${snapshot.manifest_digest}\nlayer    ${snapshot.layer_digest}\ncommit   ${snapshot.source_commit}`
  );
}
