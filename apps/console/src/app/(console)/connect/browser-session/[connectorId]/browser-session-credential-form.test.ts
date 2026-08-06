// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { StaticSecretSetup } from "../../../lib/ref-client.ts";
import { optionalBrowserCredentialSubmission } from "./browser-session-credential-form.ts";

const MISSING_PASSWORD_RE = /Password is required/;
const SECRET_LEAK_RE = /secret-value|do-not-capture/;

const SETUP: StaticSecretSetup = {
  connector_id: "amazon",
  credential_capture: {
    description: "Optional browser sign-in details",
    fields: [
      {
        autocomplete: "username",
        description: null,
        help_text: null,
        help_url: null,
        identity: false,
        label: "Email",
        name: "username",
        placeholder: null,
        required: true,
        secret: true,
        type: "text",
      },
      {
        autocomplete: "current-password",
        description: null,
        help_text: null,
        help_url: null,
        identity: false,
        label: "Password",
        name: "password",
        placeholder: null,
        required: true,
        secret: true,
        type: "password",
      },
    ],
    kind: "username_password",
    label: "Sign-in details",
    submit_label: null,
  },
  credential_kind: "username_password",
  deployment_readiness: { blockers: [], guidance: null, state: "ready" },
  display_name: "Amazon",
  object: "static_secret_setup",
  validation: "synchronous",
};

function form(values: Record<string, string>): Pick<FormData, "get"> {
  return { get: (name: string) => values[name] ?? null };
}

test("unchecked optional credentials take the no-secret path", () => {
  assert.equal(
    optionalBrowserCredentialSubmission(
      SETUP,
      form({ username: "owner@example.test", password: "do-not-capture", remember_sign_in_details: "0" })
    ),
    null
  );
});

test("checked optional credentials reuse manifest validation and encrypted payload shape", () => {
  const result = optionalBrowserCredentialSubmission(
    SETUP,
    form({ username: "owner@example.test", password: "secret-value", remember_sign_in_details: "1" })
  );
  assert.ok(result?.ok);
  assert.equal(result.submission.setupFields.username, undefined, "secret fields never become setup URL context");
  assert.equal(result.submission.setupFields.password, undefined, "secret fields never become setup URL context");
  assert.deepEqual(JSON.parse(result.submission.secret), {
    password: "secret-value",
    username: "owner@example.test",
  });
});

test("checked optional credentials fail before shell creation when a manifest field is missing", () => {
  const result = optionalBrowserCredentialSubmission(
    SETUP,
    form({ username: "owner@example.test", remember_sign_in_details: "true" })
  );
  assert.ok(result && !result.ok);
  assert.match(result.error, MISSING_PASSWORD_RE);
  assert.doesNotMatch(JSON.stringify(result), SECRET_LEAK_RE);
});
