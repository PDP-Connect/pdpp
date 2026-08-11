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
  for (const field of allFields) {
    const value = asString(formData.get(field.name));
    if (!value && field.required) {
      return { error: missingFieldMessage(field) };
    }
    if (value) {
      fields[field.name] = value;
    }
  }
  // When no secret field is individually required and at least one OTHER
  // field in the same form still is (an "at least one credential path"
  // manifest, e.g. Jellyfin's required base_url plus username+password OR
  // API key), a fully empty submission would otherwise sail through with an
  // empty bundle. Require at least one secret field to be filled in that
  // case. A manifest with NO required field anywhere (e.g. Venmo, whose
  // credentials only ever assist a browser-driven sign-in that works with
  // zero saved credentials) has no such fallback to protect and must accept
  // a fully blank submission.
  const hasRequiredField = allFields.some((field) => field.required);
  if (
    hasRequiredField &&
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
