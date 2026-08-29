"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcInput } from "@pdpp/brand-react";
import { useState } from "react";
import type { StaticSecretSetupField } from "../../../lib/ref-client.ts";
import type { BrowserOptionalCredentialContract } from "../../../lib/source-setup-form-contract.ts";
import { optionalCredentialFieldLabel } from "../../../lib/source-setup-form-contract.ts";

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function inputType(field: StaticSecretSetupField): "email" | "password" | "text" {
  return field.type === "email" || field.type === "password" ? field.type : "text";
}

/**
 * The checkbox is the only thing that turns saving new sign-in details on.
 * Fields stay disabled until it is checked so a disabled, greyed-out field
 * cannot itself be mistaken for a currently-saved value.
 */
export function OptionalStoredCredentialFields({
  credentials,
  searchParams,
}: {
  credentials: BrowserOptionalCredentialContract;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const [remember, setRemember] = useState(false);

  return (
    <fieldset
      className="grid gap-3 rounded-lg border border-border/70 bg-muted/20 p-4"
      data-testid="browser-optional-credentials"
    >
      <legend className="pdpp-eyebrow px-1 text-foreground">{credentials.title}</legend>
      <p className="pdpp-caption text-muted-foreground">{credentials.description}</p>
      <label className="flex items-start gap-2" htmlFor="browser-remember-sign-in">
        <input
          checked={remember}
          className="mt-0.5 size-4 rounded border-border accent-primary"
          id="browser-remember-sign-in"
          name={credentials.checkboxName}
          onChange={(event) => setRemember(event.target.checked)}
          type="checkbox"
          value="1"
        />
        <span className="pdpp-caption text-foreground">{credentials.checkboxLabel}</span>
      </label>
      <div className="grid gap-3 border-border/60 border-t pt-3" data-testid="browser-credential-fields">
        {credentials.fields.map((field) => (
          <label className="grid gap-1" htmlFor={`browser-credential-${field.name}`} key={field.name}>
            <span className="pdpp-eyebrow">{optionalCredentialFieldLabel(field)}</span>
            <IcInput
              autoComplete={field.autocomplete ?? (field.secret ? "off" : undefined)}
              defaultValue={firstValue(searchParams[`field_${field.name}`])}
              disabled={!remember}
              id={`browser-credential-${field.name}`}
              name={field.name}
              placeholder={field.placeholder ?? undefined}
              required={false}
              type={inputType(field)}
            />
            {field.description || field.help_text || field.help_url ? (
              <span className="pdpp-caption text-muted-foreground">
                {field.description ?? field.help_text}
                {field.help_url ? (
                  <>
                    {" "}
                    <a
                      className="underline decoration-dotted underline-offset-4"
                      href={field.help_url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Open provider setup page in a new tab
                    </a>
                  </>
                ) : null}
              </span>
            ) : null}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
