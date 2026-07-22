// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export function isOwnerSessionRequiredBody(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; type?: string } };
    return parsed.error?.code === "owner_session_required";
  } catch {
    return body.includes("owner_session_required");
  }
}
