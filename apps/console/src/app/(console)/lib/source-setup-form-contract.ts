// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared owner-form presentation for source setup.
 *
 * Connector manifests own provider credential fields and their metadata. The
 * console owns the small amount of workflow state that is common to every
 * source setup form: the optional connection name and, for browser sessions,
 * the choice to save optional sign-in details. Keeping those two contracts
 * here prevents the three capture forms from quietly inventing different
 * labels or promises.
 */

import type { StaticSecretSetup, StaticSecretSetupField } from "./ref-client.ts";

export interface ConnectionNameFieldContract {
  readonly helpText: string;
  readonly label: "Connection name (optional)";
  readonly maxLength: 200;
  readonly name: "display_name";
  readonly placeholder: string;
}

export function connectionNameFieldContract(displayName: string): ConnectionNameFieldContract {
  return {
    helpText: "Used only when creating a new source. You can rename it later.",
    label: "Connection name (optional)",
    maxLength: 200,
    name: "display_name",
    placeholder: `${displayName} personal`,
  };
}

export interface BrowserOptionalCredentialContract {
  readonly checkboxLabel: "Save these details to assist initial sign-in or repair.";
  readonly checkboxName: "remember_sign_in_details";
  readonly description: string;
  readonly fields: readonly StaticSecretSetupField[];
  readonly title: "Optional saved sign-in details";
}

export interface BrowserSessionFormContract {
  readonly optionalCredentials: BrowserOptionalCredentialContract | null;
  readonly repairLoginDescription: string;
  readonly setupDescription: string;
}

/**
 * Project the presence of manifest credential capture into owner-safe browser
 * copy. A missing setup descriptor is meaningful: the owner signs in in the
 * browser and this flow makes no automatic-login promise.
 */
export function browserSessionFormContract(setup: StaticSecretSetup | null): BrowserSessionFormContract {
  if (!setup) {
    return {
      optionalCredentials: null,
      repairLoginDescription:
        "This flow uses the browser session directly; it does not collect provider credentials and does not promise unattended reconnection.",
      setupDescription:
        "Create a new account in a secure browser. Sign in interactively; this flow does not collect provider credentials and does not promise unattended reconnection.",
    };
  }

  return {
    optionalCredentials: {
      checkboxLabel: "Save these details to assist initial sign-in or repair.",
      checkboxName: "remember_sign_in_details",
      description:
        "Interactive sign-in is valid. Leave these fields blank to sign in in the secure browser; save them only if they may help with initial sign-in or repair. CAPTCHA, OTP, passkeys, and other human steps stay in the browser, and unattended reconnection is not guaranteed.",
      fields: setup.credential_capture.fields,
      title: "Optional saved sign-in details",
    },
    repairLoginDescription:
      "Optional encrypted sign-in details may assist repair, but they do not replace the secure browser or guarantee unattended reconnection.",
    setupDescription:
      "Create a new account in a secure browser. Interactive sign-in is valid; optional saved sign-in details can assist initial sign-in or repair, but they do not guarantee unattended reconnection.",
  };
}

export function optionalCredentialFieldLabel(field: StaticSecretSetupField): string {
  return `${field.label} (optional)`;
}

export interface StaticSecretFormContract {
  readonly connectionName: ConnectionNameFieldContract;
  readonly credentialFields: readonly StaticSecretSetupField[];
  readonly credentialSectionDescription: string;
  readonly primaryActionLabel: string;
}

export function staticSecretFormContract(setup: StaticSecretSetup, isReplaceMode: boolean): StaticSecretFormContract {
  return {
    connectionName: connectionNameFieldContract(setup.display_name),
    credentialFields: setup.credential_capture.fields,
    credentialSectionDescription:
      setup.credential_capture.description ??
      "This form is generated from the connector manifest. Secrets are submitted to the owner-session capture route and are not returned to agents, MCP clients, REST reads, audit payloads, or the dashboard.",
    primaryActionLabel: isReplaceMode
      ? "Reconnect account and run sync"
      : (setup.credential_capture.submit_label ?? "Create connection and start first sync"),
  };
}
