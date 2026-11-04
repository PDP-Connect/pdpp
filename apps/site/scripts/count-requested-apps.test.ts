// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";
import { countRequestedApps } from "./count-requested-apps.mjs";

const USAGE = /Usage:/;
const PRIVATE_LABEL = /PRIVATE.*Do not share/;
const run = promisify(execFile);
const SCRIPT = path.join(import.meta.dirname, "count-requested-apps.mjs");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { force: true, recursive: true }))
  );
});

const EMAIL_VALUE = "alice@example.test";
const NAME_VALUE = "Alice Fakename";
const PHONE_VALUE = "+1 555 010 0199";
const PERSONAL_VALUES = [EMAIL_VALUE, NAME_VALUE, PHONE_VALUE];

test("count folds case, spacing and aliases, and sorts by count", () => {
  const { apps } = countRequestedApps([
    { requestedApps: ["Spotify", "insta"] },
    { requestedApps: ["  spotify ", "Chat  GPT"] },
    { requestedApps: ["OpenAI", "Instagram", "Strava"] },
    { requestedApps: [] },
    { id: "legacy-record-without-the-field" },
  ]);
  assert.deepEqual(apps, [
    { app: "ChatGPT", count: 2 },
    { app: "Instagram", count: 2 },
    { app: "Spotify", count: 2 },
    { app: "Strava", count: 1 },
  ]);
});

test("one signatory counts once per app even when they spell it two ways", () => {
  assert.deepEqual(countRequestedApps([{ requestedApps: ["Insta", "Instagram", "instagram"] }]).apps, [
    { app: "Instagram", count: 1 },
  ]);
});

test("an app outside the suggestion list and alias map is unreviewed, never in apps", () => {
  const result = countRequestedApps([
    { requestedApps: ["oura", "Obscure App"] },
    { requestedApps: ["Oura", "obscure  app"] },
    { requestedApps: ["Obscure App"] },
  ]);
  assert.deepEqual(result.apps, [{ app: "Oura", count: 2 }]);
  assert.equal(result.unreviewedAnswers, 3);
  assert.deepEqual(result.unreviewed, [{ value: "Obscure App", count: 3 }]);
});

async function writeRegister(records: Array<{ id: string; requestedApps: string[] }>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pdpp-app-counts-"));
  temporaryDirectories.push(directory);
  const year = path.join(directory, "signatories", "2026");
  await mkdir(year, { recursive: true });
  await Promise.all(
    records.map(
      async (record) =>
        await writeFile(
          path.join(year, `${record.id}.json`),
          JSON.stringify({
            displayName: `Fake Person ${record.id}`,
            email: `${record.id}@example.test`,
            ...record,
          })
        )
    )
  );
  return directory;
}

test("default output holds canonical names and an unreviewed total, never free text", async () => {
  const directory = await writeRegister([
    { id: "first-fake-id", requestedApps: ["Spotify", "Strava", EMAIL_VALUE] },
    { id: "second-fake-id", requestedApps: ["spotify", NAME_VALUE] },
    { id: "third-fake-id", requestedApps: [PHONE_VALUE] },
  ]);

  const { stdout, stderr } = await run(process.execPath, [SCRIPT, directory]);
  assert.deepEqual(JSON.parse(stdout), {
    apps: [
      { app: "Spotify", count: 2 },
      { app: "Strava", count: 1 },
    ],
    unreviewedAnswers: 3,
  });
  assert.equal(stderr, "");
  for (const private_ of [...PERSONAL_VALUES, "Fake Person", "example.test", "fake-id", "555"]) {
    assert.equal(stdout.includes(private_), false, `${private_} must not appear in the output`);
  }
});

test("--review shows unreviewed values on stderr only, labelled private", async () => {
  const directory = await writeRegister([
    { id: "first-fake-id", requestedApps: ["Spotify", ...PERSONAL_VALUES] },
    { id: "second-fake-id", requestedApps: [EMAIL_VALUE] },
  ]);

  const { stdout, stderr } = await run(process.execPath, [SCRIPT, "--review", directory]);
  assert.deepEqual(JSON.parse(stdout), { apps: [{ app: "Spotify", count: 1 }], unreviewedAnswers: 4 });
  for (const private_ of PERSONAL_VALUES) {
    assert.equal(stdout.includes(private_), false, `${private_} must not appear on stdout`);
    assert.equal(stderr.includes(private_), true, `${private_} should be listed for review on stderr`);
  }
  assert.match(stderr, PRIVATE_LABEL);
  for (const leaked of ["Fake Person", "fake-id"]) {
    assert.equal(stderr.includes(leaked), false, `${leaked} is not a requested app and must not appear`);
  }
});

test("the command exits non-zero with a usage line when given no directory", async () => {
  await assert.rejects(run(process.execPath, [SCRIPT]), (error: { code?: number; stderr?: string }) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr ?? "", USAGE);
    return true;
  });
});
