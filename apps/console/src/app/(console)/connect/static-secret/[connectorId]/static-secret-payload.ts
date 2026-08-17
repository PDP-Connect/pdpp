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

// The wire encoding for "no credential was submitted" on an OPTIONAL
// capture, for EITHER kind shape. `parseCaptureBody`
// (`reference-implementation/server/routes/ref-static-secret-credentials.ts`)
// rejects a genuinely empty string outright as `invalid_request` before any
// required/optional logic ever runs, so blank-but-valid must be encoded as a
// non-empty sentinel. `bundledSecretPayload` already used `"{}"` (an empty
// JSON object) for the bundled case; this reuses the SAME sentinel for a
// single-secret kind rather than inventing a second one, and the RI's
// `validateSingleSecret` checks for this exact string, never a real
// provider secret that happens to be short.
const BLANK_OPTIONAL_SECRET_SENTINEL = "{}";

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
    return { secret: BLANK_OPTIONAL_SECRET_SENTINEL };
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

// F4: a single-secret kind (api_key/app_password/personal_access_token/…)
// has exactly one field, so there is no per-field/BOTH-OR-NONE distinction
// to make — but it must still honor the SAME block-level
// `credential_capture.required` fact `bundledSecretPayload` does. Not
// reachable by any shipped manifest today (every `required: false` manifest
// is `username_password`), but the next single-field optional manifest must
// not silently inherit an always-required assumption from this function
// alone ignoring the fact every other layer already carries.
function singleSecretPayload(setup: StaticSecretSetup, formData: FormReader): { error: string } | { secret: string } {
  const field = setup.credential_capture.fields.find((candidate) => candidate.secret);
  if (!field) {
    return { error: "Connector setup is missing a secret field." };
  }
  const secret = asString(formData.get(field.name));
  if (!secret) {
    return setup.credential_capture.required === false
      ? { secret: BLANK_OPTIONAL_SECRET_SENTINEL }
      : { error: missingFieldMessage(field) };
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
