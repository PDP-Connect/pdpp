// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { formValuesForRetry } from "./form-restoration.ts";
import { signedOutcome, withdrawOutcome } from "./signing-outcome.ts";

const browserRequest = () => new NextRequest("https://pdpp.example.test/api/sign", { method: "POST" });
const CLEARED_RETRY_COOKIE = /pdpp_signing_form=; Path=\/principles; Expires=Thu, 01 Jan 1970/;
const HTTP_ONLY = /HttpOnly/;
const PRIVATE_EMAIL = /private%40example\.test|private@example\.test/;

test("signed browser outcomes use PRG states", () => {
  for (const [state, status] of [
    ["pending", 303],
    ["incomplete", 400],
    ["ratelimited", 429],
    ["unavailable", 503],
    ["closed", 404],
    ["confirmed", 303],
    ["error", 503],
    ["invalid", 400],
  ] as const) {
    const response = signedOutcome(browserRequest(), state, { error: "failure", status });
    assert.equal(response.status, 303, state);
    assert.equal(response.headers.get("location"), `https://pdpp.example.test/principles?signed=${state}#sign`, state);
  }
});

test("withdraw browser outcomes use PRG states", () => {
  for (const state of ["done", "invalid", "error", "closed"]) {
    const response = withdrawOutcome(browserRequest(), state, { error: "failure", status: 400 });
    assert.equal(response.status, 303, state);
    assert.equal(
      response.headers.get("location"),
      `https://pdpp.example.test/principles?withdraw=${state}#sign`,
      state
    );
  }
});

test("JSON errors are opt-in", async () => {
  const request = new NextRequest("https://pdpp.example.test/api/sign", {
    headers: { accept: "application/json" },
    method: "POST",
  });
  const response = signedOutcome(request, "ratelimited", { error: "Too many submissions.", status: 429 });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "Too many submissions." });
});

test("a terminal signing outcome clears a retry cookie", () => {
  const response = signedOutcome(browserRequest(), "confirmed", { error: "", status: 303 });
  assert.match(response.headers.get("set-cookie") ?? "", CLEARED_RETRY_COOKIE);
});

test("retry cookie restores non-email fields only", () => {
  const form = new FormData();
  form.set("email", "private@example.test");
  form.set("name", "Private Name");
  form.set("country", "United States");
  form.set("signatory_kind", "individual");
  form.set("consent_age", "on");
  const response = signedOutcome(
    browserRequest(),
    "incomplete",
    { error: "failure", status: 400 },
    formValuesForRetry(form)
  );
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, HTTP_ONLY);
  assert.doesNotMatch(cookie, PRIVATE_EMAIL);
});
