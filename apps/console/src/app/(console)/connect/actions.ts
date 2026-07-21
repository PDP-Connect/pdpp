// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDashboardAccess } from "../lib/dashboard-access.ts";
import { createCimdClientDocument, deleteCimdClientDocument } from "../lib/ref-client.ts";

const CONNECT_PATH = "/connect";

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function href(params: Record<string, string>): string {
  const query = new URLSearchParams(params);
  return `${CONNECT_PATH}?${query.toString()}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected operator action failure";
}

export async function createCimdClientIdentityAction(formData: FormData) {
  await requireDashboardAccess(CONNECT_PATH);
  const clientName = asString(formData.get("client_name")) || "Custom MCP client";
  const redirectUri = asString(formData.get("redirect_uri"));
  if (!redirectUri) {
    redirect(href({ error: "Redirect URI is required" }));
  }
  let target: string;
  try {
    const doc = await createCimdClientDocument({
      clientName,
      redirectUris: [redirectUri],
    });
    revalidatePath(CONNECT_PATH);
    target = href({ client_identity: doc.document_id, notice: "client_identity_created" });
  } catch (err) {
    target = href({ error: errorMessage(err) });
  }
  redirect(target);
}

export async function deleteCimdClientIdentityAction(formData: FormData) {
  await requireDashboardAccess(CONNECT_PATH);
  const documentId = asString(formData.get("document_id"));
  if (!documentId) {
    redirect(href({ error: "Client identity id is required" }));
  }
  let target: string;
  try {
    await deleteCimdClientDocument(documentId);
    revalidatePath(CONNECT_PATH);
    target = href({ notice: "client_identity_deleted" });
  } catch (err) {
    target = href({ error: errorMessage(err) });
  }
  redirect(target);
}
