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
  for (const field of setup.credential_capture.fields) {
    const value = asString(formData.get(field.name));
    if (!value && field.required) {
      return { error: missingFieldMessage(field) };
    }
    if (value) {
      fields[field.name] = value;
    }
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
    return { ok: false, error: result.error };
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
