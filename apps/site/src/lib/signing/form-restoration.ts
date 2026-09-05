// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface RestoredSigningForm {
  affiliation?: string;
  consent_age: boolean;
  consent_authority: boolean;
  consent_principles: boolean;
  consent_register: boolean;
  consent_updates: boolean;
  country?: string;
  name?: string;
  organisation?: string;
  organisation_type?: string;
  signatory_kind: "individual" | "organisation";
}

const COOKIE_MAX_AGE_SECONDS = 10 * 60;
const RESTORED_FORM_COOKIE = "pdpp_signing_form";
const MAX_FIELD_LENGTH = 160;

function text(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  if (typeof value !== "string") {
    return undefined;
  }
  return value.slice(0, MAX_FIELD_LENGTH);
}

/** Returns form values that may be shown back to the person who submitted them. Email is never included. */
export function formValuesForRetry(form: FormData): RestoredSigningForm {
  return {
    affiliation: text(form, "affiliation"),
    consent_age: form.get("consent_age") === "on",
    consent_authority: form.get("consent_authority") === "on",
    consent_principles: form.get("consent_principles") === "on",
    consent_register: form.get("consent_register") === "on",
    consent_updates: form.get("consent_updates") === "on",
    country: text(form, "country"),
    name: text(form, "name"),
    organisation: text(form, "organisation"),
    organisation_type: text(form, "organisation_type"),
    signatory_kind: form.get("signatory_kind") === "organisation" ? "organisation" : "individual",
  };
}

export function restoredFormCookie(form: RestoredSigningForm): { maxAge: number; name: string; value: string } {
  return {
    maxAge: COOKIE_MAX_AGE_SECONDS,
    name: RESTORED_FORM_COOKIE,
    value: Buffer.from(JSON.stringify(form)).toString("base64url"),
  };
}

export function readRestoredForm(value: string | undefined): RestoredSigningForm | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const form = parsed as Partial<RestoredSigningForm>;
    if (form.signatory_kind !== "individual" && form.signatory_kind !== "organisation") {
      return undefined;
    }
    return {
      affiliation: typeof form.affiliation === "string" ? form.affiliation : undefined,
      consent_age: form.consent_age === true,
      consent_authority: form.consent_authority === true,
      consent_principles: form.consent_principles === true,
      consent_register: form.consent_register === true,
      consent_updates: form.consent_updates === true,
      country: typeof form.country === "string" ? form.country : undefined,
      name: typeof form.name === "string" ? form.name : undefined,
      organisation: typeof form.organisation === "string" ? form.organisation : undefined,
      organisation_type: typeof form.organisation_type === "string" ? form.organisation_type : undefined,
      signatory_kind: form.signatory_kind,
    };
  } catch {
    return undefined;
  }
}
