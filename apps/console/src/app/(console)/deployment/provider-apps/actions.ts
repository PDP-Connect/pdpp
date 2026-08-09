"use server";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDashboardAccess } from "../../lib/dashboard-access.ts";
import { ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { RefRequestError, setProviderAppConfig } from "../../lib/ref-client.ts";
import { type OwnerFacingSaveError, ownerErrorCopy } from "./owner-error-copy.ts";

const PAGE_PATH = "/deployment/provider-apps";
const FIELD_PREFIX = "field_";

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function pageHref(params: Record<string, string> = {}): string {
  const entries = Object.entries(params);
  if (entries.length === 0) {
    return PAGE_PATH;
  }
  return `${PAGE_PATH}?${new URLSearchParams(params).toString()}`;
}

// Adapts the real thrown errors to the plain discriminant `ownerErrorCopy`
// classifies on, so the classification logic itself stays free of
// `server-only` imports and is directly testable.
function classifySaveError(err: unknown): OwnerFacingSaveError {
  if (err instanceof ReferenceServerUnreachableError) {
    return { kind: "unreachable" };
  }
  if (err instanceof RefRequestError) {
    return { kind: "request_failed", status: err.status };
  }
  return { kind: "unknown" };
}

// Sets every non-blank field the owner submitted for one identity group in a
// single atomic write. On first setup the owner fills in every field; on
// later rotation, a blank field means "keep the existing stored value" —
// only fields the owner actually typed into are sent, so an empty input can
// never accidentally clear a configured secret.
export async function setProviderAppConfigAction(formData: FormData) {
  await requireDashboardAccess(PAGE_PATH);
  const identityGroup = asString(formData.get("identity_group"));
  if (!identityGroup) {
    redirect(pageHref({ error: "Missing provider identity." }));
  }

  const values: Record<string, string> = {};
  for (const [name, entry] of formData.entries()) {
    if (!name.startsWith(FIELD_PREFIX)) {
      continue;
    }
    const value = asString(entry);
    if (!value) {
      continue;
    }
    values[name.slice(FIELD_PREFIX.length)] = value;
  }

  if (Object.keys(values).length === 0) {
    redirect(pageHref({ error: "Enter at least one value to save." }));
  }

  let target = pageHref({ notice: "saved" });
  try {
    await setProviderAppConfig({ identityGroup, values });
    revalidatePath(PAGE_PATH);
  } catch (err) {
    target = pageHref({ error: ownerErrorCopy(classifySaveError(err)) });
  }
  redirect(target);
}
