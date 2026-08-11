// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { StaticSecretSetup } from "./ref-client.ts";
import {
  browserSessionFormContract,
  connectionNameFieldContract,
  optionalCredentialFieldLabel,
  staticSecretFormContract,
} from "./source-setup-form-contract.ts";

const INTERACTIVE_SIGN_IN_RE = /Interactive sign-in is valid/;
const LEAVE_FIELDS_BLANK_RE = /Leave these fields blank/;
const UNATTENDED_RECONNECTION_RE = /unattended reconnection is not guaranteed/;
const NO_PROVIDER_CREDENTIALS_RE = /does not collect provider credentials/;
const NO_UNATTENDED_RECONNECTION_RE = /does not promise unattended reconnection/;
const AUTOMATIC_LOGIN_RE = /automatic login/i;

const SETUP: StaticSecretSetup = {
  connector_id: "synthetic-browser-source",
  credential_capture: {
    description: "Manifest-authored sign-in details.",
    fields: [
      {
        autocomplete: "username",
        description: null,
        help_text: null,
        help_url: null,
        identity: false,
        label: "Username",
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
    required: true,
    submit_label: "Save details",
  },
  credential_kind: "username_password",
  deployment_readiness: { blockers: [], guidance: null, state: "ready" },
  display_name: "Synthetic browser source",
  object: "static_secret_setup",
  validation: "first_sync",
};

test("connection-name contract is app-owned and shared across source forms", () => {
  assert.deepEqual(connectionNameFieldContract("Synthetic source"), {
    helpText: "Used only when creating a new source. You can rename it later.",
    label: "Connection name (optional)",
    maxLength: 200,
    name: "display_name",
    placeholder: "Synthetic source personal",
  });
});

test("browser credential contract makes interactive sign-in and optional fields explicit", () => {
  const contract = browserSessionFormContract(SETUP);
  assert.ok(contract.optionalCredentials);
  assert.match(contract.setupDescription, INTERACTIVE_SIGN_IN_RE);
  assert.match(contract.optionalCredentials.description, LEAVE_FIELDS_BLANK_RE);
  assert.match(contract.optionalCredentials.description, UNATTENDED_RECONNECTION_RE);
  const usernameField = SETUP.credential_capture.fields.find((field) => field.name === "username");
  assert.ok(usernameField);
  assert.equal(optionalCredentialFieldLabel(usernameField), "Username (optional)");
  assert.deepEqual(contract.optionalCredentials.fields, SETUP.credential_capture.fields);
});

test("browser-only start has no optional credential section or automatic-login promise", () => {
  const contract = browserSessionFormContract(null);
  assert.equal(contract.optionalCredentials, null);
  assert.match(contract.setupDescription, NO_PROVIDER_CREDENTIALS_RE);
  assert.match(contract.setupDescription, NO_UNATTENDED_RECONNECTION_RE);
  assert.doesNotMatch(contract.setupDescription, AUTOMATIC_LOGIN_RE);
});

test("static-secret form keeps manifest fields and submit label while adding the shared name field", () => {
  const contract = staticSecretFormContract(SETUP, false);
  assert.equal(contract.connectionName.name, "display_name");
  assert.deepEqual(contract.credentialFields, SETUP.credential_capture.fields);
  assert.equal(contract.primaryActionLabel, "Save details");
  assert.equal(staticSecretFormContract(SETUP, true).primaryActionLabel, "Reconnect account and run sync");
});
