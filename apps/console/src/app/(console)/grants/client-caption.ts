// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

export function technicalClientCaption(clientId: string | null | undefined): string | null {
  const trimmed = clientId?.trim();
  if (!trimmed) {
    return null;
  }
  return (
    clientOriginCaption(trimmed) ?? (looksLikeTechnicalClientId(trimmed) ? "registered client" : `client ${trimmed}`)
  );
}

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
