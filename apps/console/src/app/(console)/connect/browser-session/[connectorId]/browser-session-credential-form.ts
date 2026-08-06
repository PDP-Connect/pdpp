// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { StaticSecretSetup } from "../../../lib/ref-client.ts";
import {
  buildStaticSecretPayload,
  collectStaticSecretSetupFields,
} from "../../static-secret/[connectorId]/static-secret-payload.ts";

type FormReader = Pick<FormData, "get">;

export interface OptionalBrowserCredentialSubmission {
  readonly secret: string;
  readonly setupFields: Record<string, string>;
}

export type OptionalBrowserCredentialResult =
  | { readonly ok: true; readonly submission: OptionalBrowserCredentialSubmission }
  | { readonly error: string; readonly ok: false; readonly setupFields: Record<string, string> };

/**
 * Applies the browser-session page's optional credential control to the
 * existing manifest-authored static-secret payload builder. An unchecked
 * control returns null, so the no-secret browser path never touches the
 * credential capture route. A checked control validates all manifest-required
 * fields before the route creates or mutates a connection.
 */
export function optionalBrowserCredentialSubmission(
  setup: StaticSecretSetup,
  formData: FormReader
): OptionalBrowserCredentialResult | null {
  const remember = formData.get("remember_sign_in_details");
  if (remember !== "1" && remember !== "true") {
    return null;
  }

  const setupFields = collectStaticSecretSetupFields(setup, formData);
  const payload = buildStaticSecretPayload(setup, formData);
  if (!payload.ok) {
    return { error: payload.error, ok: false, setupFields };
  }
  return {
    ok: true,
    submission: { secret: payload.secret, setupFields },
  };
}
