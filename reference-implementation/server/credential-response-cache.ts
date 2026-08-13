// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export const CREDENTIAL_RESPONSE_CACHE_CONTROL = "no-store";
export const CREDENTIAL_RESPONSE_PRAGMA = "no-cache";

export interface HeaderSetter {
  setHeader: (name: string, value: string) => unknown;
}

export function applyCredentialResponseNoStoreHeaders(res: HeaderSetter): void {
  res.setHeader("Cache-Control", CREDENTIAL_RESPONSE_CACHE_CONTROL);
  res.setHeader("Pragma", CREDENTIAL_RESPONSE_PRAGMA);
}

export function credentialResponseNoStoreHeaders(): Record<string, string> {
  return {
    "Cache-Control": CREDENTIAL_RESPONSE_CACHE_CONTROL,
    Pragma: CREDENTIAL_RESPONSE_PRAGMA,
  };
}
