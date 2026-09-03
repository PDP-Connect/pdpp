#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Reads confirmed records from the checked-out private register and writes the
// public register. The explicit pick in toPublicEntry is the security boundary:
// a future private field cannot reach the public file unless it is added here.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function toPublicEntry(record) {
  return {
    country: record.country,
    principlesVersion: record.principlesVersion,
    publicName: record.publicName,
    signedOn: String(record.confirmedAt).slice(0, 10),
    type: record.type,
  };
}

export async function readSignatories(sourceDirectory) {
  const root = path.join(sourceDirectory, "signatories");
  let years;
  try {
    years = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Private register has no signatories directory: ${root}`, { cause: error });
  }

  const directories = years.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  const filePaths = (
    await Promise.all(
      directories.map(async (year) => {
        const directory = path.join(root, year.name);
        const files = await readdir(directory);
        return files
          .filter((entry) => entry.endsWith(".json"))
          .sort()
          .map((file) => path.join(directory, file));
      })
    )
  ).flat();
  return await Promise.all(filePaths.map(async (filePath) => JSON.parse(await readFile(filePath, "utf8"))));
}

export async function publishSupporters(sourceDirectory, outputPath) {
  const published = [];
  for (const record of await readSignatories(sourceDirectory)) {
    if (record?.consent?.register === true) {
      published.push(toPublicEntry(record));
    }
  }
  published.sort(
    (left, right) => left.signedOn.localeCompare(right.signedOn) || left.publicName.localeCompare(right.publicName)
  );
  const output = `${JSON.stringify(published, null, 2)}\n`;

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output);
  return published.length;
}

async function main() {
  const [sourceDirectory, outputPath] = process.argv.slice(2);
  if (sourceDirectory && outputPath) {
    const count = await publishSupporters(sourceDirectory, outputPath);
    console.log(`Wrote ${count} public signatories.`);
  } else {
    console.error("Usage: publish-supporters.mjs <private-register-directory> <public-output-path>");
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
