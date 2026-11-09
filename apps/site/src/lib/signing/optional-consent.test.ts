// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SITE_DIRECTORY = fileURLToPath(new URL("../../..", import.meta.url));
const SIGNING_URL = pathToFileURL(fileURLToPath(new URL("./index.ts", import.meta.url))).href;

const KINDS = {
  individual: { consent_age: "on", signatory_kind: "individual" },
  organisation: {
    consent_authority: "on",
    organisation: "Example Org",
    organisation_type: "Company",
    signatory_kind: "organisation",
  },
} as const;

// `index.ts` imports "server-only", which only loads under the react-server
// condition, so the schema runs in a child process like the other signing tests.
async function storedUpdatesConsent(kind: keyof typeof KINDS, updates: "on" | undefined) {
  const input = {
    ...KINDS[kind],
    consent_principles: "on",
    consent_register: "on",
    consent_updates: updates,
    country: "United States",
    email: "person@example.test",
    name: "Fake Person",
    principles_version: "1.0",
  };
  const program = `
    const { submissionSchema, buildRecord } = await import(${JSON.stringify(SIGNING_URL)});
    const parsed = submissionSchema.safeParse(${JSON.stringify(input)});
    process.stdout.write(JSON.stringify(parsed.success
      ? { ok: true, updates: buildRecord("fake-id", parsed.data).consent.updates }
      : { ok: false }));
  `;
  const { stdout } = await execFile(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "--eval", program],
    { cwd: SITE_DIRECTORY }
  );
  return JSON.parse(stdout) as { ok: boolean; updates?: boolean };
}

test("a signature with the updates box unticked is accepted and stored as no consent", async () => {
  // An unticked checkbox is left out of the form data, so the key is missing.
  const results = await Promise.all([
    storedUpdatesConsent("individual", undefined),
    storedUpdatesConsent("organisation", undefined),
  ]);
  for (const result of results) {
    assert.deepEqual(result, { ok: true, updates: false });
  }
});

test("a signature with the updates box ticked is stored as consent", async () => {
  const results = await Promise.all([
    storedUpdatesConsent("individual", "on"),
    storedUpdatesConsent("organisation", "on"),
  ]);
  for (const result of results) {
    assert.deepEqual(result, { ok: true, updates: true });
  }
});
