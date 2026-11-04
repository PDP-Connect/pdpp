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
const run = promisify(execFile);
const SCRIPT = path.join(import.meta.dirname, "count-requested-apps.mjs");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { force: true, recursive: true }))
  );
});

test("count folds case, spacing and aliases, and sorts by count", () => {
  const counts = countRequestedApps([
    { requestedApps: ["Spotify", "insta"] },
    { requestedApps: ["  spotify ", "Chat  GPT"] },
    { requestedApps: ["OpenAI", "Instagram", "Strava"] },
    { requestedApps: [] },
    { id: "legacy-record-without-the-field" },
  ]);
  assert.deepEqual(counts, [
    { app: "ChatGPT", count: 2 },
    { app: "Instagram", count: 2 },
    { app: "Spotify", count: 2 },
    { app: "Strava", count: 1 },
  ]);
});

test("one signatory counts once per app even when they spell it two ways", () => {
  assert.deepEqual(countRequestedApps([{ requestedApps: ["Insta", "Instagram", "instagram"] }]), [
    { app: "Instagram", count: 1 },
  ]);
});

test("an unaliased app is shown in its most common spelling", () => {
  const counts = countRequestedApps([
    { requestedApps: ["oura"] },
    { requestedApps: ["Oura"] },
    { requestedApps: ["Oura"] },
  ]);
  assert.deepEqual(counts, [{ app: "Oura", count: 3 }]);
});

test("the command prints counts only, never names, emails or ids", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pdpp-app-counts-"));
  temporaryDirectories.push(directory);
  const year = path.join(directory, "signatories", "2026");
  await mkdir(year, { recursive: true });
  await writeFile(
    path.join(year, "first-fake-id.json"),
    JSON.stringify({
      displayName: "Fake Person One",
      email: "person-one@example.test",
      id: "first-fake-id",
      requestedApps: ["Spotify", "Strava"],
    })
  );
  await writeFile(
    path.join(year, "second-fake-id.json"),
    JSON.stringify({
      displayName: "Fake Person Two",
      email: "person-two@example.test",
      id: "second-fake-id",
      requestedApps: ["spotify"],
    })
  );

  const { stdout } = await run(process.execPath, [SCRIPT, directory]);
  assert.deepEqual(JSON.parse(stdout), [
    { app: "Spotify", count: 2 },
    { app: "Strava", count: 1 },
  ]);
  for (const private_ of ["Fake Person", "example.test", "fake-id"]) {
    assert.equal(stdout.includes(private_), false, `${private_} must not appear in the output`);
  }
});

test("the command exits non-zero with a usage line when given no directory", async () => {
  await assert.rejects(run(process.execPath, [SCRIPT]), (error: { code?: number; stderr?: string }) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr ?? "", USAGE);
    return true;
  });
});
