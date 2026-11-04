// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { formValuesForRetry, readRestoredForm, restoredFormCookie } from "./form-restoration.ts";

const execFile = promisify(execFileCallback);
const SITE_DIRECTORY = fileURLToPath(new URL("../../..", import.meta.url));
const SIGNING_URL = pathToFileURL(fileURLToPath(new URL("./index.ts", import.meta.url))).href;

// `index.ts` imports "server-only", which only loads under the react-server
// condition, so the schema runs in a child process like the other signing tests.
async function parseWith(requestedApps: unknown, kind: "individual" | "organisation" = "individual") {
  const program = `
    const { submissionSchema, buildRecord } = await import(${JSON.stringify(SIGNING_URL)});
    const base = ${JSON.stringify(
      kind === "individual"
        ? { affiliation: "PDP-Connect", consent_age: "on", signatory_kind: "individual" }
        : {
            consent_authority: "on",
            organisation: "Example Org",
            organisation_type: "Company",
            signatory_kind: "organisation",
          }
    )};
    const input = {
      ...base,
      consent_principles: "on",
      consent_register: "on",
      consent_updates: "on",
      country: "United States",
      email: "person@example.test",
      name: "Fake Person",
      principles_version: "1.0",
    };
    const requested = ${JSON.stringify(requestedApps)};
    if (requested !== undefined) input.requested_apps = requested;
    const parsed = submissionSchema.safeParse(input);
    process.stdout.write(JSON.stringify(parsed.success
      ? { ok: true, apps: parsed.data.requested_apps, stored: buildRecord("fake-id", parsed.data).requestedApps }
      : { ok: false }));
  `;
  const { stdout } = await execFile(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "--eval", program],
    { cwd: SITE_DIRECTORY }
  );
  return JSON.parse(stdout) as { apps?: string[]; ok: boolean; stored?: string[] };
}

test("requested apps are optional and stored as an empty list", async () => {
  const cases = (["individual", "organisation"] as const).flatMap((kind) =>
    [undefined, [], ["", "   "]].map((value) => ({ kind, value }))
  );
  const results = await Promise.all(cases.map(({ kind, value }) => parseWith(value, kind)));
  for (const result of results) {
    assert.deepEqual(result, { apps: [], ok: true, stored: [] });
  }
});

test("requested apps are trimmed, space-collapsed, de-duplicated and stored", async () => {
  const results = await Promise.all(
    (["individual", "organisation"] as const).map((kind) =>
      parseWith(["  Spotify ", "strava   run", "SPOTIFY", ""], kind)
    )
  );
  for (const result of results) {
    assert.deepEqual(result, { apps: ["Spotify", "strava run"], ok: true, stored: ["Spotify", "strava run"] });
  }
});

test("requested apps reject more than three and any over 60 characters", async () => {
  assert.equal((await parseWith(["a", "b", "c"])).ok, true);
  assert.equal((await parseWith(["a", "b", "c", "d"])).ok, false);
  assert.equal((await parseWith(["a".repeat(60)])).ok, true);
  assert.equal((await parseWith(["a".repeat(61)])).ok, false);
});

test("a retry cookie keeps the requested apps", () => {
  const form = new FormData();
  form.append("requested_apps", "Spotify");
  form.append("requested_apps", "Strava");
  form.append("requested_apps", "Oura");
  form.append("requested_apps", "Extra");
  const restored = formValuesForRetry(form);
  assert.deepEqual(restored.requested_apps, ["Spotify", "Strava", "Oura"]);
  assert.deepEqual(readRestoredForm(restoredFormCookie(restored).value)?.requested_apps, ["Spotify", "Strava", "Oura"]);
  assert.deepEqual(readRestoredForm(restoredFormCookie(formValuesForRetry(new FormData())).value)?.requested_apps, []);
});
