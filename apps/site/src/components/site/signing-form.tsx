// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { useState } from "react";
import { Text } from "@/components/typography/text.tsx";
import { signingDisclosure, siteConfig, siteFlags } from "@/lib/site-config.ts";
import { cn } from "@/lib/utils.ts";

// The Supporter signing form.
//
// Behind siteFlags.signingLive. When the flag is off the form is not rendered
// at all — not disabled, not hidden with CSS. A disabled form still ships the
// field names and the endpoint to every reader, and a hidden one can be
// re-enabled from devtools and posted to. Off means absent.
//
// The form posts to siteConfig.formEndpoint and does nothing else client-side:
// no validation logic here is load-bearing. Every rule that matters (the
// schema, the rate limit, the organisation-domain check) is enforced in
// /api/sign, because anything checked only in this file is checked only for
// people who use the form.
//
// The country and type lists are the prototype's. They are deliberately short
// and will grow; a free-text country field would make the public register
// unsortable and invite an address.

const COUNTRIES = ["Australia", "Germany", "Netherlands", "Switzerland", "United Kingdom", "United States"] as const;

const ORGANISATION_TYPES = ["Company", "Platform", "Research institute", "Civil society", "Public body"] as const;

type SignatoryKind = "individual" | "organisation";

const fieldClassName = cn(
  "w-full border border-border bg-background px-3 py-2",
  "font-sans text-[15px] text-foreground",
  "focus-visible:border-primary focus-visible:outline-none"
);

function Field({ children, htmlFor, label }: { children: React.ReactNode; htmlFor: string; label: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Text as="label" color="subtle" htmlFor={htmlFor} size="stamp">
        {label}
      </Text>
      {children}
    </div>
  );
}

function Consent({ id, name, children }: { children: React.ReactNode; id: string; name: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5" htmlFor={id}>
      <input className="mt-1 size-4 shrink-0 accent-[var(--primary)]" id={id} name={name} type="checkbox" />
      <Text as="span" size="small">
        {children}
      </Text>
    </label>
  );
}

export function PdppSigningForm() {
  const [kind, setKind] = useState<SignatoryKind>("individual");

  if (!siteFlags.signingLive) {
    return (
      <div className="border border-border p-6" data-slot="pdpp-signing-closed">
        <Text as="p" size="body">
          Signing opens once hosting is confirmed with LF Decentralized Trust.
        </Text>
      </div>
    );
  }

  const isOrganisation = kind === "organisation";

  return (
    <form action={siteConfig.formEndpoint} className="flex flex-col gap-6" method="post">
      <input name="principles_version" type="hidden" value="1.0" />
      <input name="signatory_kind" type="hidden" value={kind} />

      {/* Two buttons rather than a select: the choice changes which fields and
          which consents are shown, so it is a mode, not a value. */}
      <fieldset className="m-0 flex gap-px border-0 p-0">
        {(["individual", "organisation"] as const).map((option) => (
          <button
            aria-pressed={kind === option}
            className={cn(
              "cursor-pointer border border-border px-4 py-2 font-sans text-[14px] capitalize",
              kind === option
                ? "bg-primary text-on-primary-emphasis"
                : "bg-background text-muted-foreground hover:text-primary"
            )}
            key={option}
            onClick={() => setKind(option)}
            type="button"
          >
            {option}
          </button>
        ))}
      </fieldset>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field htmlFor="sign-name" label="Name">
          <input autoComplete="name" className={fieldClassName} id="sign-name" name="name" required type="text" />
        </Field>
        <Field htmlFor="sign-email" label="Email">
          <input autoComplete="email" className={fieldClassName} id="sign-email" name="email" required type="email" />
        </Field>

        {isOrganisation && (
          <Field htmlFor="sign-organisation" label="Organisation">
            <input className={fieldClassName} id="sign-organisation" name="organisation" required type="text" />
          </Field>
        )}
        {!isOrganisation && (
          <Field htmlFor="sign-affiliation" label="Affiliation, optional">
            <input className={fieldClassName} id="sign-affiliation" name="affiliation" type="text" />
          </Field>
        )}

        <Field htmlFor="sign-country" label="Country">
          <select className={fieldClassName} defaultValue="" id="sign-country" name="country" required>
            <option disabled value="">
              Select a country
            </option>
            {COUNTRIES.map((country) => (
              <option key={country} value={country}>
                {country}
              </option>
            ))}
          </select>
        </Field>

        {isOrganisation && (
          <Field htmlFor="sign-type" label="Type">
            <select className={fieldClassName} defaultValue="" id="sign-type" name="organisation_type" required>
              <option disabled value="">
                Select a type
              </option>
              {ORGANISATION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <Text as="p" color="muted" size="small">
        {isOrganisation
          ? "We show your organisation name, your country, and the date. We never show your email."
          : "We show your first name and last initial, your country, and the date. We never show your email."}
      </Text>

      <div className="flex flex-col gap-3">
        <Consent id="consent-principles" name="consent_principles">
          I support the PDPP Principles v1.0.
        </Consent>
        <Consent id="consent-register" name="consent_register">
          List me on the public register.
        </Consent>
        <Consent id="consent-updates" name="consent_updates">
          Email me about new versions and comment periods.
        </Consent>
        {isOrganisation ? (
          <Consent id="consent-authority" name="consent_authority">
            I am authorised to sign on behalf of this organisation.
          </Consent>
        ) : (
          <Consent id="consent-age" name="consent_age">
            I am 18 or over.
          </Consent>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <button
          className={cn(
            "w-fit cursor-pointer border border-primary bg-primary px-5 py-2.5",
            "font-sans text-[15px] text-on-primary-emphasis",
            "hover:border-primary-emphasis hover:bg-primary-emphasis"
          )}
          type="submit"
        >
          Become a Supporter
        </button>
        <Text as="p" color="muted" size="small">
          We email you to confirm. Organisations sign from an address at their own domain.
        </Text>
        {/* The interim controller disclosure, from config so the transfer to
            LFDT is one edit rather than a hunt through page copy. */}
        <Text as="p" color="subtle" size="small">
          {signingDisclosure()}
        </Text>
      </div>
    </form>
  );
}
