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
      required: true,
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
        required: true,
        submit_label: null,
      },
      credential_kind: "app_password",
    }),
    form
  );

  assert.deepEqual(payload, { ok: true, secret: "app password" });
});

// F4: singleSecretPayload must honor credential_capture.required === false
// the SAME way bundledSecretPayload does — not reachable by any shipped
// manifest today (every required:false manifest is username_password), but
// the next single-field optional manifest must not silently inherit an
// always-required assumption.
function singleSecretApiKeySetup(required: boolean): StaticSecretSetup {
  return setup({
    credential_capture: {
      description: null,
      fields: [
        {
          autocomplete: "off",
          description: null,
          help_text: null,
          help_url: null,
          identity: false,
          label: "API key",
          name: "secret",
          placeholder: null,
          required: true,
          secret: true,
          type: "password",
        },
      ],
      kind: "api_key",
      label: "API key",
      required,
      submit_label: null,
    },
    credential_kind: "api_key",
  });
}

test("F4: singleSecretPayload accepts a blank submission when credential_capture.required is false", () => {
  const payload = buildStaticSecretPayload(singleSecretApiKeySetup(false), new FormData());
  assert.equal(payload.ok, true);
  assert.equal(payload.ok ? payload.secret : "", "{}", "blank-optional must use the SAME sentinel as the bundled case");
});

test("F4 counterweight: singleSecretPayload still rejects a blank submission when credential_capture.required is true (default)", () => {
  const payload = buildStaticSecretPayload(singleSecretApiKeySetup(true), new FormData());
  assert.deepEqual(payload, { error: "API key is required.", ok: false });
});

test("F4: singleSecretPayload stores a REAL submitted secret unchanged, even when the capture is optional", () => {
  const form = new FormData();
  form.set("secret", "real-api-key-value");
  const payload = buildStaticSecretPayload(singleSecretApiKeySetup(false), form);
  assert.deepEqual(payload, { ok: true, secret: "real-api-key-value" });
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
        required: true,
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
      required: true,
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

test("at-least-one-path bundles reject a fully empty submission instead of storing an empty bundle", () => {
  const form = new FormData();
  form.set("base_url", "https://jellyfin.example.com");

  const payload = buildStaticSecretPayload(
    setup({
      credential_capture: {
        description: null,
        fields: [
          {
            autocomplete: "off",
            description: null,
            help_text: null,
            help_url: null,
            identity: false,
            label: "Jellyfin Server Base URL",
            name: "base_url",
            placeholder: null,
            required: true,
            secret: false,
            type: "text",
          },
          {
            autocomplete: "username",
            description: null,
            help_text: null,
            help_url: null,
            identity: false,
            label: "Jellyfin Username",
            name: "username",
            placeholder: null,
            required: false,
            secret: true,
            type: "text",
          },
          {
            autocomplete: "current-password",
            description: null,
            help_text: null,
            help_url: null,
            identity: false,
            label: "Jellyfin Password",
            name: "password",
            placeholder: null,
            required: false,
            secret: true,
            type: "password",
          },
          {
            autocomplete: "off",
            description: null,
            help_text: null,
            help_url: null,
            identity: false,
            label: "Jellyfin API Key (advanced, admin-only)",
            name: "secret",
            placeholder: null,
            required: false,
            secret: true,
            type: "password",
          },
        ],
        kind: "username_password",
        label: "Jellyfin sign-in details",
        required: true,
        submit_label: null,
      },
      credential_kind: "username_password",
    }),
    form
  );

  assert.equal(payload.ok, false);
  assert.equal(
    payload.ok ? "" : payload.error,
    "Jellyfin Username or Jellyfin Password or Jellyfin API Key (advanced, admin-only) is required."
  );
});

test("at-least-one-path bundles accept a submission that fills exactly one credential path", () => {
  const form = new FormData();
  form.set("base_url", "https://jellyfin.example.com");
  form.set("secret", "real-api-key");

  const sourceSetup = setup({
    credential_capture: {
      description: null,
      fields: [
        {
          autocomplete: "off",
          description: null,
          help_text: null,
          help_url: null,
          identity: false,
          label: "Jellyfin Server Base URL",
          name: "base_url",
          placeholder: null,
          required: true,
          secret: false,
          type: "text",
        },
        {
          autocomplete: "username",
          description: null,
          help_text: null,
          help_url: null,
          identity: false,
          label: "Jellyfin Username",
          name: "username",
          placeholder: null,
          required: false,
          secret: true,
          type: "text",
        },
        {
          autocomplete: "off",
          description: null,
          help_text: null,
          help_url: null,
          identity: false,
          label: "Jellyfin API Key (advanced, admin-only)",
          name: "secret",
          placeholder: null,
          required: false,
          secret: true,
          type: "password",
        },
      ],
      kind: "username_password",
      label: "Jellyfin sign-in details",
      required: true,
      submit_label: null,
    },
    credential_kind: "username_password",
  });

  const payload = buildStaticSecretPayload(sourceSetup, form);

  assert.equal(payload.ok, true);
  assert.deepEqual(JSON.parse(payload.ok ? payload.secret : ""), {
    base_url: "https://jellyfin.example.com",
    secret: "real-api-key",
  });
});

// ─── credential_capture.required: false (Venmo) — BOTH-OR-NONE ───────────
//
// Venmo's fields are BOTH marked required: true at the FIELD level — the
// same as a normal required capture — but the BLOCK-level
// credential_capture.required is false, because the connector always falls
// back to a browser-driven sign-in that works with zero saved credentials.
// This is deliberately NOT a field-count or field-required inference: it is
// one explicit, provider-neutral manifest fact, checked first.

function venmoSetup(): StaticSecretSetup {
  return setup({
    credential_capture: {
      description: null,
      fields: [
        {
          autocomplete: "username",
          description: null,
          help_text: null,
          help_url: null,
          identity: false,
          label: "Venmo phone, email, or username",
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
          label: "Venmo password",
          name: "password",
          placeholder: null,
          required: true,
          secret: true,
          type: "password",
        },
      ],
      kind: "username_password",
      label: "Venmo sign-in details (optional)",
      required: false,
      submit_label: null,
    },
    credential_kind: "username_password",
  });
}

test("credential_capture.required: false — a fully blank submission is accepted (Venmo: browser sign-in is always valid)", () => {
  const form = new FormData();
  const payload = buildStaticSecretPayload(venmoSetup(), form);
  assert.deepEqual(payload, { ok: true, secret: "{}" });
});

test("credential_capture.required: false — a PARTIAL submission (one of two BOTH-OR-NONE fields) is rejected", () => {
  const form = new FormData();
  form.set("username", "owner@example.com");
  const payload = buildStaticSecretPayload(venmoSetup(), form);
  // The blank-submission short-circuit does not fire (username has a
  // value), so this falls through to the SAME per-field required check a
  // fully required capture would run — password's own field-level
  // `required: true` (BOTH-OR-NONE) is what rejects it.
  assert.deepEqual(payload, { error: "Venmo password is required.", ok: false });
});

test("credential_capture.required: false — a COMPLETE submission (both fields) is accepted", () => {
  const form = new FormData();
  form.set("username", "owner@example.com");
  form.set("password", "hunter2");
  const payload = buildStaticSecretPayload(venmoSetup(), form);
  assert.equal(payload.ok, true);
  assert.deepEqual(JSON.parse(payload.ok ? payload.secret : ""), {
    password: "hunter2",
    username: "owner@example.com",
  });
});

test("credential_capture.required omitted defaults to required — a blank submission with the fact unset (old manifest response shape) still rejects", () => {
  const form = new FormData();
  // Simulate a served payload that predates this fact entirely (an older RI
  // response, or a manifest that never set it) — genuinely ABSENT, not
  // `required: false`. `StaticSecretSetup.required` is typed non-optional
  // because every CURRENT response always sets it; this rebuild via
  // destructuring omission reproduces what an old/foreign payload actually
  // looks like on the wire without a `delete` operator.
  const { required: _omitted, ...captureWithoutRequired } = venmoSetup().credential_capture;
  const withoutRequiredFact: StaticSecretSetup = {
    ...venmoSetup(),
    credential_capture: captureWithoutRequired as StaticSecretSetup["credential_capture"],
  };

  const payload = buildStaticSecretPayload(withoutRequiredFact, form);
  assert.equal(
    payload.ok,
    false,
    "omitting the block-level fact must default to required, not accept a blank submission"
  );
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
        required: true,
        submit_label: null,
      },
      credential_kind: "username_password",
    }),
    form
  );

  assert.deepEqual(payload, { error: "Password is required.", ok: false });
});
