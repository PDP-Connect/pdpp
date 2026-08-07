// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared "client {…}" caption logic for anywhere a raw `client_id` would
 * otherwise render verbatim (e.g. `cli_8f3a2b1c`). `/grants` had this logic
 * inline to avoid a bare technical id; the grant-packages pages didn't reuse
 * it and printed the raw id straight through.
 */

const TECHNICAL_CLIENT_ID_RE = /^cli_[a-z0-9]+$/i;
const WWW_PREFIX_RE = /^www\./;

export function looksLikeTechnicalClientId(value: string): boolean {
  return TECHNICAL_CLIENT_ID_RE.test(value);
}

export function clientOriginCaption(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(WWW_PREFIX_RE, "");
    return host ? `client ${host}` : null;
  } catch {
    return null;
  }
}

/**
 * Caption for a client identified only by `client_id` (no display name on
 * the record) — an OAuth client origin renders as its host, a technical id
 * (`cli_…`) renders as "registered client", anything else renders verbatim.
 */
export function technicalClientCaption(clientId: string | null | undefined): string | null {
  const trimmed = clientId?.trim();
  if (!trimmed) {
    return null;
  }
  return (
    clientOriginCaption(trimmed) ?? (looksLikeTechnicalClientId(trimmed) ? "registered client" : `client ${trimmed}`)
  );
}

/**
 * Caption for a client that may carry a display name (`client.client_name`)
 * in addition to `client_id` — prefers the name, falls back to
 * `technicalClientCaption`.
 */
export function clientCaption(client: {
  client?: { client_name?: string | null } | null;
  client_id?: string | null;
}): string | null {
  const name = client.client?.client_name?.trim();
  if (name) {
    return `client ${name}`;
  }
  return technicalClientCaption(client.client_id);
}
