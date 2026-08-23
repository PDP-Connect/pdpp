// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A connection with no stored credential must SAY that, naming the fields.
 *
 * These tests pin the owner-facing copy at the moment of absence for each
 * migrated connector. The defect they guard is not a crash — it is a run that
 * bails to manual sign-in within seconds and tells the owner the PAGE failed
 * ("sign-in form did not render", "H-E-B did not finish signing in
 * automatically") when the truth is that no credential ever reached the run.
 * Those two states need different remedies: one is "wait and retry", the other
 * is "store a credential". Copy that conflates them leaves the owner with no
 * way to tell which they are in, indefinitely.
 *
 * The assertions are deliberately two-sided — the message MUST name the
 * credential AND MUST NOT read as a page failure. A one-sided assertion would
 * still pass if someone later prepended the credential reason to page-blaming
 * copy without removing the misdirection.
 *
 * Nothing here touches a provider: `resolveLoginCredentials` is pure, and the
 * connector-level absence checks read source text. No browser, no network.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AMAZON_LOGIN_FIELDS } from "./amazon.ts";
import { type LoginCredentialFields, resolveLoginCredentials } from "./login-credentials.ts";

const AUTO_LOGIN_DIR = dirname(fileURLToPath(import.meta.url));

/** Reads like a broken provider page rather than a missing credential. */
const PAGE_BLAMING = /did not render|failed to load|did not finish signing in|could not finish sign-in/i;

interface Case {
  readonly connector: string;
  readonly fields: LoginCredentialFields;
  readonly password: string;
  readonly username: string;
}

const CASES: readonly Case[] = [
  {
    connector: "amazon",
    fields: AMAZON_LOGIN_FIELDS,
    password: "AMAZON_PASSWORD",
    username: "AMAZON_USERNAME",
  },
  {
    connector: "chase",
    fields: { password: ["CHASE_PASSWORD"], username: ["CHASE_USERNAME"] },
    password: "CHASE_PASSWORD",
    username: "CHASE_USERNAME",
  },
  {
    connector: "chatgpt",
    fields: { password: ["CHATGPT_PASSWORD"], username: ["CHATGPT_USERNAME"] },
    password: "CHATGPT_PASSWORD",
    username: "CHATGPT_USERNAME",
  },
  {
    connector: "heb",
    fields: { password: ["HEB_PASSWORD"], username: ["HEB_USERNAME"] },
    password: "HEB_PASSWORD",
    username: "HEB_USERNAME",
  },
];

for (const { connector, fields, password, username } of CASES) {
  test(`${connector}: an absent credential names both fields and does not blame the page`, () => {
    const resolved = resolveLoginCredentials(undefined, fields, connector);
    assert.equal(resolved.kind, "absent");
    if (resolved.kind !== "absent") {
      return;
    }
    assert.deepEqual(resolved.missing, [username, password]);
    assert.match(resolved.reason, new RegExp(`no stored credential for this ${connector} connection`, "u"));
    assert.match(resolved.reason, new RegExp(`missing: ${username}, ${password}`, "u"));
    assert.doesNotMatch(resolved.reason, PAGE_BLAMING);
  });

  test(`${connector}: a half credential is reported absent, naming only the missing half`, () => {
    // A username with no password must never be submitted as half a login, and
    // the owner must be told WHICH half is missing — "credentials missing" for
    // a connection that has a username stored is actively misleading.
    const resolved = resolveLoginCredentials({ [username]: "owner@example.com" }, fields, connector);
    assert.equal(resolved.kind, "absent");
    if (resolved.kind !== "absent") {
      return;
    }
    assert.deepEqual(resolved.missing, [password]);
    assert.match(resolved.reason, new RegExp(`missing: ${password}`, "u"));
    assert.doesNotMatch(resolved.reason, new RegExp(username, "u"));
    // Names only, never values.
    assert.doesNotMatch(resolved.reason, /owner@example\.com/u);
  });

  test(`${connector}: a complete pair resolves and is never reported absent`, () => {
    const resolved = resolveLoginCredentials(
      { [password]: "synthetic-password", [username]: "owner@example.com" },
      fields,
      connector
    );
    assert.equal(resolved.kind, "resolved");
    if (resolved.kind !== "resolved") {
      return;
    }
    assert.equal(resolved.username, "owner@example.com");
    assert.equal(resolved.password, "synthetic-password");
  });
}

test("blank and whitespace-only credentials count as absent, not as a login attempt", () => {
  // A sealed-but-empty credential fragment is the realistic failure: the
  // connection LOOKS configured. Submitting "" would fail at the provider and
  // surface as a provider/auth error, hiding the real cause.
  for (const blank of ["", "   ", "\t\n"]) {
    const resolved = resolveLoginCredentials(
      { CHASE_PASSWORD: blank, CHASE_USERNAME: "owner@example.com" },
      { password: ["CHASE_PASSWORD"], username: ["CHASE_USERNAME"] },
      "chase"
    );
    assert.equal(resolved.kind, "absent", `"${blank}" must not be treated as a password`);
  }
});

test("every migrated connector resolves its pair from the runtime credentials, not process.env", () => {
  // The declaration and the call site are two halves of one fix. A connector
  // that declared `auth` but still read `process.env` would prompt the owner
  // and then ignore what they supplied for THIS connection, so the pair must
  // be checked together. `check-no-direct-credential-env.ts` enforces the
  // absence; this asserts the positive.
  for (const connector of ["amazon", "chase", "chatgpt", "heb"]) {
    const source = readFileSync(join(AUTO_LOGIN_DIR, `${connector}.ts`), "utf8");
    assert.match(
      source,
      /resolveLoginCredentials\(\s*credentials\s*,/u,
      `${connector}.ts must resolve the connection-scoped credentials object`
    );
  }
});
