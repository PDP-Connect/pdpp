// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { StaticSecretSetup } from "../lib/ref-client.ts";
import {
  buildStaticSecretPayload,
  collectStaticSecretSetupFields,
} from "./static-secret/[connectorId]/static-secret-payload.ts";

function setup(overrides: Partial<StaticSecretSetup>): StaticSecretSetup {
  return {
    connector_id: "synthetic",
    credential_capture: {
      description: null,
      fields: [],
      kind: "app_password",
      label: "Credential",
      submit_label: null,
    },
    credential_kind: "app_password",
    deployment_readiness: {
      blockers: [],
      guidance: null,
      state: "ready",
    },
    display_name: "Synthetic",
    object: "static_secret_setup",
    validation: "first_sync",
    ...overrides,
  };
}

test("single-secret credentials store the submitted secret directly", () => {
  const form = new FormData();
  form.set("account_email", "owner@example.com");
  form.set("secret", "app password");

  const payload = buildStaticSecretPayload(
    setup({
      credential_capture: {
        description: null,
        fields: [
          {
            autocomplete: "email",
            description: null,
            help_text: null,
            help_url: null,
            identity: true,
            label: "Email",
            name: "account_email",
            placeholder: null,
            required: true,
            secret: false,
            type: "email",
          },
          {
            autocomplete: "off",
            description: null,
            help_text: null,
            help_url: null,
            identity: false,
            label: "App password",
            name: "secret",
            placeholder: null,
            required: true,
            secret: true,
            type: "password",
          },
        ],
        kind: "app_password",
        label: "App password",
        submit_label: null,
      },
      credential_kind: "app_password",
    }),
    form
  );

  assert.deepEqual(payload, { ok: true, secret: "app password" });
});

test("username/password credentials seal all submitted credential fields as one bundle", () => {
  const form = new FormData();
  form.set("username", "owner@example.com");
  form.set("password", "new password");

  const payload = buildStaticSecretPayload(
    setup({
      credential_capture: {
        description: null,
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
            type: "email",
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
    }),
    form
  );

  assert.equal(payload.ok, true);
  assert.deepEqual(JSON.parse(payload.ok ? payload.secret : ""), {
    password: "new password",
    username: "owner@example.com",
  });
});

test("secret bundles can include required non-secret setup fields needed by the runtime mapping", () => {
  const form = new FormData();
  form.set("slack_workspace", "workspace");
  form.set("slack_token", "xoxc-token");
  form.set("slack_cookie", "d=cookie");

  const sourceSetup = setup({
    credential_capture: {
      description: null,
      fields: [
        {
          autocomplete: "off",
          description: null,
          help_text: null,
          help_url: null,
          identity: true,
          label: "Workspace",
          name: "slack_workspace",
          placeholder: null,
          required: true,
          secret: false,
          type: "text",
        },
        {
          autocomplete: "off",
          description: null,
          help_text: null,
          help_url: null,
          identity: false,
          label: "Token",
          name: "slack_token",
          placeholder: null,
          required: true,
          secret: true,
          type: "password",
        },
        {
          autocomplete: "off",
          description: null,
          help_text: null,
          help_url: null,
          identity: false,
          label: "Cookie",
          name: "slack_cookie",
          placeholder: null,
          required: true,
          secret: true,
          type: "password",
        },
      ],
      kind: "secret_bundle",
      label: "Bundle",
      submit_label: null,
    },
    credential_kind: "secret_bundle",
  });

  const payload = buildStaticSecretPayload(sourceSetup, form);

  assert.equal(payload.ok, true);
  assert.deepEqual(JSON.parse(payload.ok ? payload.secret : ""), {
    slack_cookie: "d=cookie",
    slack_token: "xoxc-token",
    slack_workspace: "workspace",
  });
  assert.deepEqual(collectStaticSecretSetupFields(sourceSetup, form), {
    slack_workspace: "workspace",
  });
});

test("required bundled fields fail before capture instead of storing incomplete credentials", () => {
  const form = new FormData();
  form.set("username", "owner@example.com");

  const payload = buildStaticSecretPayload(
    setup({
      credential_capture: {
        description: null,
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
            type: "email",
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
    }),
    form
  );

  assert.deepEqual(payload, { error: "Password is required.", ok: false });
});
