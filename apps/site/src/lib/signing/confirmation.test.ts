// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SITE_DIRECTORY = fileURLToPath(new URL("../../..", import.meta.url));
const CONFIRMATION_URL = pathToFileURL(fileURLToPath(new URL("./confirmation.ts", import.meta.url))).href;
const SIGNING_URL = pathToFileURL(fileURLToPath(new URL("./index.ts", import.meta.url))).href;
const CONFIRMATION_FORM = /<form action="\/api\/sign\/confirm" method="post">/;
const CONFIRMED_LOCATION = /\/principles\?signed=confirmed#sign$/;
const ERROR_LOCATION = /\/principles\?signed=error#sign$/;
const INVALID_LOCATION = /\/principles\?signed=invalid#sign$/;
const ESCAPED_TOKEN = "valid-token&amp;&quot;&lt;&gt;&#39;";
const RAW_ATTRIBUTE_BREAKOUT = /value="valid-token&"/;
const UNSAFE_TOKEN = "valid-token&\"<>'";

async function runScenario(mode: "escaped" | "get" | "success" | "concurrent" | "failure" | "mismatch" | "invalid") {
  const program = `
    const mode = ${JSON.stringify(mode)};
    const { NextRequest } = await import("next/server");
    const { createConfirmationHandlers } = await import(${JSON.stringify(CONFIRMATION_URL)});
    const { buildRecord, hasSameImmutableFields, recordPath } = await import(${JSON.stringify(SIGNING_URL)});
    console.error = () => {};
    const token = "valid-token";
    const unsafeToken = ${JSON.stringify(UNSAFE_TOKEN)};
    const id = "signatory-id";
    const submission = {
      affiliation: "PDP-Connect", consent_age: true, consent_principles: true, consent_register: true,
      consent_updates: false, country: "United States", email: "private@example.test",
      name: "Private Display Name", principles_version: "v1.0", signatory_kind: "individual",
    };
    const state = { deleteCalls: 0, pending: submission, readCalls: 0, records: [], writeCalls: 0, writeFailure: mode === "failure" };
    if (mode === "mismatch") state.records.push({ ...buildRecord(id, submission), email: "other@example.test" });
    const handlers = createConfirmationHandlers({
      buildRecord,
      deletePending: async () => { state.deleteCalls += 1; state.pending = null; },
      hasSameImmutableFields,
      isSigningLive: () => true,
      readPending: async () => { state.readCalls += 1; return state.pending; },
      readSignatory: async () => state.records[0] ?? null,
      recordPath,
      verifyToken: (value) => value === token || value === unsafeToken ? id : null,
      writeSignatory: async (record) => {
        state.writeCalls += 1;
        if (state.writeFailure || state.records.length > 0) throw new Error("create lost");
        state.records.push(record);
      },
    });
    const get = (method = "GET", value = token) => new NextRequest("https://pdpp.example.test/api/sign/confirm?token=" + encodeURIComponent(value), { method });
    const post = (value = token) => new NextRequest("https://pdpp.example.test/api/sign/confirm", {
      body: new URLSearchParams({ token: value }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    let pendingAfterFailure = null;
    let responses;
    if (mode === "get") responses = [await handlers.GET(get()), await handlers.HEAD(get("HEAD"))];
    else if (mode === "escaped") responses = [await handlers.GET(get("GET", unsafeToken))];
    else if (mode === "success") responses = [await handlers.POST(post())];
    else if (mode === "concurrent") responses = await Promise.all([handlers.POST(post()), handlers.POST(post())]);
    else if (mode === "failure") {
      const failed = await handlers.POST(post());
      pendingAfterFailure = state.pending !== null;
      state.writeFailure = false;
      responses = [failed, await handlers.POST(post())];
    } else if (mode === "mismatch") responses = [await handlers.POST(post())];
    else responses = [await handlers.POST(post("invalid-token"))];
    process.stdout.write(JSON.stringify({
      deleteCalls: state.deleteCalls,
      pending: state.pending !== null,
      pendingAfterFailure,
      readCalls: state.readCalls,
      records: state.records.length,
      responses: await Promise.all(responses.map(async (response) => ({
        body: await response.text(),
        cache: response.headers.get("cache-control"),
        location: response.headers.get("location"),
        status: response.status,
      }))),
      writeCalls: state.writeCalls,
    }));
  `;
  const { stdout } = await execFile(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "--eval", program],
    { cwd: SITE_DIRECTORY }
  );
  return JSON.parse(stdout) as {
    deleteCalls: number;
    pending: boolean;
    pendingAfterFailure: boolean | null;
    readCalls: number;
    records: number;
    responses: { body: string; cache: string | null; location: string | null; status: number }[];
    writeCalls: number;
  };
}

test("confirmation GET and HEAD are no-store and do not consume or write", async () => {
  const result = await runScenario("get");

  assert.equal(result.responses[0]?.status, 200);
  assert.equal(result.responses[0]?.cache, "no-store");
  assert.match(result.responses[0]?.body ?? "", CONFIRMATION_FORM);
  assert.equal(result.responses[1]?.status, 200);
  assert.equal(result.responses[1]?.cache, "no-store");
  assert.equal(result.pending, true);
  assert.equal(result.readCalls, 0);
  assert.equal(result.writeCalls, 0);
  assert.equal(result.deleteCalls, 0);
});

test("the confirmation form escapes a verified token with HTML attribute characters", async () => {
  const result = await runScenario("escaped");

  assert.match(result.responses[0]?.body ?? "", new RegExp(`value="${ESCAPED_TOKEN}"`));
  assert.doesNotMatch(result.responses[0]?.body ?? "", RAW_ATTRIBUTE_BREAKOUT);
});

test("an explicit confirmation POST writes once, consumes pending, and redirects", async () => {
  const result = await runScenario("success");

  assert.equal(result.responses[0]?.status, 303);
  assert.match(result.responses[0]?.location ?? "", CONFIRMED_LOCATION);
  assert.equal(result.responses[0]?.cache, "no-store");
  assert.equal(result.records, 1);
  assert.equal(result.pending, false);
  assert.equal(result.deleteCalls, 1);
});

test("two concurrent confirmation POSTs create one matching record and both succeed", async () => {
  const result = await runScenario("concurrent");

  assert.deepEqual(
    result.responses.map((response) => response.status),
    [303, 303]
  );
  assert.equal(result.records, 1);
  assert.equal(result.pending, false);
  assert.equal(result.writeCalls, 2);
});

test("a provider failure keeps pending so a later POST can confirm", async () => {
  const result = await runScenario("failure");

  assert.match(result.responses[0]?.location ?? "", ERROR_LOCATION);
  assert.equal(result.responses[0]?.cache, "no-store");
  assert.equal(result.pendingAfterFailure, true);
  assert.equal(result.pending, false);
  assert.equal(result.deleteCalls, 1);
  assert.match(result.responses[1]?.location ?? "", CONFIRMED_LOCATION);
  assert.equal(result.records, 1);
});

test("a conflicting existing record is not accepted as a successful confirmation", async () => {
  const result = await runScenario("mismatch");

  assert.match(result.responses[0]?.location ?? "", ERROR_LOCATION);
  assert.equal(result.pending, true);
  assert.equal(result.deleteCalls, 0);
});

test("an invalid confirmation POST redirects to signed=invalid without effects", async () => {
  const result = await runScenario("invalid");

  assert.equal(result.responses[0]?.status, 303);
  assert.match(result.responses[0]?.location ?? "", INVALID_LOCATION);
  assert.equal(result.responses[0]?.cache, "no-store");
  assert.equal(result.writeCalls, 0);
  assert.equal(result.deleteCalls, 0);
});
