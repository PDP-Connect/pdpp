// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { noStoredCredentialReason, resolveLoginCredentials } from "./login-credentials.ts";

const HEB_FIELDS = { password: ["HEB_PASSWORD"], username: ["HEB_USERNAME"] } as const;

test("a complete pair resolves", () => {
  const result = resolveLoginCredentials(
    { HEB_PASSWORD: "synthetic-pw", HEB_USERNAME: "owner@example.invalid" },
    HEB_FIELDS,
    "heb"
  );
  assert.equal(result.kind, "resolved");
  assert.equal(result.kind === "resolved" && result.username, "owner@example.invalid");
  assert.equal(result.kind === "resolved" && result.password, "synthetic-pw");
});

test("an absent pair names the credential, never the page", () => {
  const result = resolveLoginCredentials({}, HEB_FIELDS, "heb");
  assert.equal(result.kind, "absent");
  assert.deepEqual(result.kind === "absent" && result.missing, ["HEB_USERNAME", "HEB_PASSWORD"]);
  const reason = result.kind === "absent" ? result.reason : "";
  assert.match(reason, /no stored credential for this heb connection/);
  // The whole point of the type: the owner-facing sentence must not blame the
  // provider's page. Before this existed the same state reported "sign-in form
  // did not render".
  assert.doesNotMatch(reason, /render|form|page|UI/i);
});

test("a half pair is absent, not a half login", () => {
  // BOTH-OR-NOTHING: a username with no password must never be submitted.
  const result = resolveLoginCredentials({ HEB_USERNAME: "owner@example.invalid" }, HEB_FIELDS, "heb");
  assert.equal(result.kind, "absent");
  assert.deepEqual(result.kind === "absent" && result.missing, ["HEB_PASSWORD"]);
});

test("blank and whitespace-only values count as absent", () => {
  const result = resolveLoginCredentials({ HEB_PASSWORD: "   ", HEB_USERNAME: "" }, HEB_FIELDS, "heb");
  assert.equal(result.kind, "absent");
  assert.deepEqual(result.kind === "absent" && result.missing, ["HEB_USERNAME", "HEB_PASSWORD"]);
});

test("an undefined credentials object is absent, not a crash", () => {
  const result = resolveLoginCredentials(undefined, HEB_FIELDS, "heb");
  assert.equal(result.kind, "absent");
});

test("aliases resolve first-non-empty", () => {
  const fields = { password: ["GITHUB_PASSWORD"], username: ["GITHUB_EMAIL", "GITHUB_USERNAME"] } as const;
  const result = resolveLoginCredentials(
    { GITHUB_PASSWORD: "synthetic-pw", GITHUB_USERNAME: "fallback@example.invalid" },
    fields,
    "github"
  );
  assert.equal(result.kind === "resolved" && result.username, "fallback@example.invalid");

  const preferred = resolveLoginCredentials(
    {
      GITHUB_EMAIL: "preferred@example.invalid",
      GITHUB_PASSWORD: "synthetic-pw",
      GITHUB_USERNAME: "fallback@example.invalid",
    },
    fields,
    "github"
  );
  assert.equal(preferred.kind === "resolved" && preferred.username, "preferred@example.invalid");
});

test("the missing-credential reason names the missing fields", () => {
  assert.match(noStoredCredentialReason("venmo", ["VENMO_PASSWORD"]), /missing: VENMO_PASSWORD/);
  assert.match(noStoredCredentialReason("venmo", []), /missing: username, password/);
});

/**
 * The case the process-global env-var design structurally cannot express.
 *
 * A single `HEB_USERNAME` process variable can hold ONE account. The owner has
 * two HEB connections. This proves the resolver is a pure function of the
 * per-run `credentials` argument — so two runs of the SAME connector, handed
 * their own connection's credentials, resolve two different logins with no
 * ambient state involved.
 */
test("two connections of one connector resolve their own distinct credentials", () => {
  const connectionA = { HEB_PASSWORD: "synthetic-pw-a", HEB_USERNAME: "owner-a@example.invalid" };
  const connectionB = { HEB_PASSWORD: "synthetic-pw-b", HEB_USERNAME: "owner-b@example.invalid" };

  const a = resolveLoginCredentials(connectionA, HEB_FIELDS, "heb");
  const b = resolveLoginCredentials(connectionB, HEB_FIELDS, "heb");

  assert.equal(a.kind, "resolved");
  assert.equal(b.kind, "resolved");
  assert.equal(a.kind === "resolved" && a.username, "owner-a@example.invalid");
  assert.equal(b.kind === "resolved" && b.username, "owner-b@example.invalid");
  assert.notEqual(
    a.kind === "resolved" ? a.username : null,
    b.kind === "resolved" ? b.username : null,
    "two connections must not collapse onto one account"
  );
  assert.notEqual(a.kind === "resolved" ? a.password : null, b.kind === "resolved" ? b.password : null);
});

test("resolution ignores process.env entirely", () => {
  // Ambient state must not be able to satisfy — or mask — a connection's
  // credential. Set a process-global value and prove it neither fills an
  // absent credential nor overrides a present one.
  const priorUser = process.env.HEB_USERNAME;
  const priorPass = process.env.HEB_PASSWORD;
  process.env.HEB_USERNAME = "ambient-should-never-win@example.invalid";
  process.env.HEB_PASSWORD = "ambient-should-never-win";
  try {
    const absent = resolveLoginCredentials({}, HEB_FIELDS, "heb");
    assert.equal(absent.kind, "absent", "ambient process.env must not satisfy a missing stored credential");

    const stored = resolveLoginCredentials(
      { HEB_PASSWORD: "synthetic-pw-a", HEB_USERNAME: "owner-a@example.invalid" },
      HEB_FIELDS,
      "heb"
    );
    assert.equal(stored.kind === "resolved" && stored.username, "owner-a@example.invalid");
  } finally {
    if (priorUser === undefined) {
      delete process.env.HEB_USERNAME;
    } else {
      process.env.HEB_USERNAME = priorUser;
    }
    if (priorPass === undefined) {
      delete process.env.HEB_PASSWORD;
    } else {
      process.env.HEB_PASSWORD = priorPass;
    }
  }
});
