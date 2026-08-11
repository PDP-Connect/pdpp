// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { StaticSecretSetup, StaticSecretSetupField } from "../../../lib/ref-client.ts";

type FormValue = FormDataEntryValue | null;
type FormReader = Pick<FormData, "get">;

function asString(value: FormValue): string {
  return typeof value === "string" ? value.trim() : "";
}

function bundledCredentialKind(kind: string): boolean {
  return kind === "secret_bundle" || kind === "username_password";
}

function missingFieldMessage(field: StaticSecretSetupField): string {
  return `${field.label} is required.`;
}

function bundledSecretPayload(setup: StaticSecretSetup, formData: FormReader): { error: string } | { secret: string } {
  const fields: Record<string, string> = {};
  const allFields = setup.credential_capture.fields;
  const secretFields = allFields.filter((field) => field.secret);

  // `credential_capture.required` (default true) is the ONE provider-neutral
  // fact this decides on — never a connector-name branch, never an inference
  // from field count or which fields happen to be non-secret-required. See
  // its doc in ref-client.ts's StaticSecretSetup for the full contract.
  //
  // required: false is BOTH-OR-NONE: an entirely blank submission (every
  // field empty) is a valid, complete choice — Venmo's browser-driven
  // sign-in always works with zero saved credentials — but the moment ANY
  // field is filled, the submission is no longer "nothing was chosen" and
  // every field still marked `required: true` on itself is enforced exactly
  // as it would be for a required capture. Checked BEFORE the per-field
  // loop below so a blank submission short-circuits before any field can
  // fail its own required check.
  if (setup.credential_capture.required === false && allFields.every((field) => !asString(formData.get(field.name)))) {
    return { secret: "{}" };
  }

  for (const field of allFields) {
    const value = asString(formData.get(field.name));
    if (!value && field.required) {
      return { error: missingFieldMessage(field) };
    }
    if (value) {
      fields[field.name] = value;
    }
  }
  // Jellyfin's shape: a REQUIRED capture (credential_capture.required is not
  // false) whose secret fields are all individually optional describes "at
  // least one credential path" (username+password OR API key) — per-field
  // required checks never fire on a fully empty submission for that shape,
  // so it needs its own presence check to reject one.
  if (
    secretFields.length > 0 &&
    !secretFields.some((field) => field.required) &&
    !secretFields.some((field) => fields[field.name])
  ) {
    return { error: `${secretFields.map((field) => field.label).join(" or ")} is required.` };
  }
  return { secret: JSON.stringify(fields) };
}

function singleSecretPayload(setup: StaticSecretSetup, formData: FormReader): { error: string } | { secret: string } {
  const field = setup.credential_capture.fields.find((candidate) => candidate.secret);
  if (!field) {
    return { error: "Connector setup is missing a secret field." };
  }
  const secret = asString(formData.get(field.name));
  if (!secret) {
    return { error: missingFieldMessage(field) };
  }
  return { secret };
}

export function buildStaticSecretPayload(
  setup: StaticSecretSetup,
  formData: FormReader
): { error: string; ok: false } | { ok: true; secret: string } {
  const result = bundledCredentialKind(setup.credential_kind)
    ? bundledSecretPayload(setup, formData)
    : singleSecretPayload(setup, formData);
  if ("error" in result) {
    return { error: result.error, ok: false };
  }
  return { ok: true, secret: result.secret };
}

export function collectStaticSecretSetupFields(setup: StaticSecretSetup, formData: FormReader): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const field of setup.credential_capture.fields) {
    if (field.secret) {
      continue;
    }
    const value = asString(formData.get(field.name));
    if (value) {
      fields[field.name] = value;
    }
  }
  return fields;
}
