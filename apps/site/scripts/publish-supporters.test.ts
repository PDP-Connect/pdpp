// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { publishSupporters } from "./publish-supporters.mjs";

const temporaryDirectories: string[] = [];
const MISSING_SIGNATORIES_DIRECTORY = /Private register has no signatories directory/;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { force: true, recursive: true }))
  );
});

test("publish supporters writes only consented public fields", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pdpp-supporters-"));
  temporaryDirectories.push(directory);
  const sourceDirectory = path.join(directory, "private");
  const signatoriesDirectory = path.join(sourceDirectory, "signatories", "2026");
  const outputPath = path.join(directory, "public", "supporters.json");
  await mkdir(signatoriesDirectory, { recursive: true });

  await writeFile(
    path.join(signatoriesDirectory, "listed.json"),
    JSON.stringify({
      confirmedAt: "2026-09-03T14:15:16.000Z",
      consent: { register: true, updates: true },
      country: "United States",
      displayName: "Private Display Name",
      email: "private@example.test",
      ip: "203.0.113.42",
      organisation: "Private Organisation",
      privateMetadata: { identityProviderToken: "nested-private-token" },
      principlesVersion: "v1.0",
      publicName: "Public P.",
      signatoryName: "Private Signatory",
      signatoryRole: "Private Role",
      type: "Individual",
    })
  );
  await writeFile(
    path.join(signatoriesDirectory, "unlisted.json"),
    JSON.stringify({
      confirmedAt: "2026-09-04T14:15:16.000Z",
      consent: { register: false },
      country: "United States",
      email: "unlisted@example.test",
      principlesVersion: "v1.0",
      publicName: "Not Listed",
      type: "Individual",
    })
  );

  assert.equal(await publishSupporters(sourceDirectory, outputPath), 1);
  const output = await readFile(outputPath, "utf8");
  assert.deepEqual(JSON.parse(output), [
    {
      country: "United States",
      principlesVersion: "v1.0",
      publicName: "Public P.",
      signedOn: "2026-09-03",
      type: "Individual",
    },
  ]);
  for (const privateValue of [
    "Private Display Name",
    "private@example.test",
    "203.0.113.42",
    "Private Organisation",
    "nested-private-token",
    "Private Signatory",
    "Private Role",
    "unlisted@example.test",
  ]) {
    assert.equal(output.includes(privateValue), false, `${privateValue} must not reach the public register`);
  }
});

test("publish supporters refuses a missing private register instead of clearing the public file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pdpp-supporters-"));
  temporaryDirectories.push(directory);

  await assert.rejects(
    async () => await publishSupporters(path.join(directory, "missing"), path.join(directory, "supporters.json")),
    MISSING_SIGNATORIES_DIRECTORY
  );
});
