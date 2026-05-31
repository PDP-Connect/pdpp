// Introspection and RFC 7592 client-delete revocation for owner-agent
// credentials. These preserve the existing reference behavior so a revoked
// owner-agent credential stops working and an active one can be confirmed
// without printing the bearer.

import { readFile } from 'node:fs/promises';

import { OwnerAgentError } from './errors.js';

/**
 * Introspect a stored owner-agent credential. Returns the non-secret subset of
 * the introspection response (`active`, `token_kind`/`pdpp_token_kind`, `sub`,
 * `client_id`, `exp`, `scope`). Never returns the bearer.
 */
export async function introspectOwnerAgentCredential({ fetchFn, record }) {
  if (!record?.introspection_endpoint) {
    throw new OwnerAgentError('introspection_unavailable', 'Stored credential has no introspection endpoint.');
  }
  const token = record?.credential?.access_token;
  if (!token) {
    throw new OwnerAgentError('credential_invalid', 'Stored credential is missing an access token.');
  }
  const body = new URLSearchParams();
  body.set('token', token);
  let response;
  try {
    response = await fetchFn(record.introspection_endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${token}`,
      },
      body: body.toString(),
    });
  } catch (error) {
    throw new OwnerAgentError('request_failed', `Introspection request failed: ${error.message}.`);
  }
  if (!response.ok) {
    throw new OwnerAgentError('introspection_failed', `Introspection failed with HTTP ${response.status}.`);
  }
  let json;
  try {
    json = await response.json();
  } catch {
    throw new OwnerAgentError('introspection_failed', 'Introspection response was not valid JSON.');
  }
  return {
    active: Boolean(json.active),
    token_kind: json.pdpp_token_kind ?? json.token_kind ?? null,
    sub: json.sub ?? null,
    client_id: json.client_id ?? null,
    exp: json.exp ?? null,
    scope: json.scope ?? null,
  };
}

/**
 * Revoke an owner-agent credential via RFC 7592 client delete. Requires that
 * the credential was bound to a dynamically registered client carrying a
 * `registration_client_uri` and `registration_access_token`.
 */
export async function revokeOwnerAgentCredential({ fetchFn, record }) {
  const uri = record?.registration_client_uri;
  const regToken = record?.registration_access_token;
  if (!uri || !regToken) {
    throw new OwnerAgentError(
      'revocation_unavailable',
      'Stored credential has no RFC 7592 registration handle (registration_client_uri/registration_access_token). ' +
        'Revoke it from the owner dashboard instead.'
    );
  }
  let response;
  try {
    response = await fetchFn(uri, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${regToken}`, Accept: 'application/json' },
    });
  } catch (error) {
    throw new OwnerAgentError('request_failed', `Revocation request failed: ${error.message}.`);
  }
  // RFC 7592 specifies 204 No Content on successful delete.
  if (response.status === 204 || response.status === 200) {
    return { revoked: true };
  }
  if (response.status === 401 || response.status === 403) {
    throw new OwnerAgentError('revocation_unauthorized', `Revocation rejected (HTTP ${response.status}).`, 4);
  }
  if (response.status === 404) {
    // Already gone is an acceptable terminal state for revocation.
    return { revoked: true, already_absent: true };
  }
  throw new OwnerAgentError('revocation_failed', `Revocation failed with HTTP ${response.status}.`);
}

export async function readCredentialRecord(targetPath) {
  let raw;
  try {
    raw = await readFile(targetPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new OwnerAgentError('not_onboarded', `No owner-agent credential found at ${targetPath}.`, 5);
    }
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new OwnerAgentError('credential_invalid', `Owner-agent credential at ${targetPath} is not valid JSON.`);
  }
}
