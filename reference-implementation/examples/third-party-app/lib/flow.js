/**
 * Pure helpers that exercise the current thin PDPP reference provider-connect
 * flow:
 *
 *   POST /oauth/register      (public-client self-registration)
 *   POST /oauth/par           (PAR request staging)
 *   POST /consent/approve     (reference-local inline approval shortcut)
 *   POST /consent/deny        (reference-local inline denial shortcut)
 *   POST /introspect          (RFC 7662-style introspection)
 *   GET  {rs}/v1/streams      (owner/client RS read)
 *
 * This is **not** a generic OAuth authorization-code redirect client. It is a
 * small harness that mirrors the exact contract the reference AS currently
 * advertises so the example app can illustrate it end to end against a local
 * reference server.
 */

function asForm(body) {
  return new URLSearchParams(body).toString();
}

async function readJsonOrText(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return { kind: 'json', value: await response.json() };
  }
  const text = await response.text();
  return { kind: 'text', value: text };
}

function describeFailure(body, fallback) {
  if (body && typeof body === 'object') {
    if (typeof body.error_description === 'string' && body.error_description) {
      return body.error_description;
    }
    if (typeof body.error === 'string' && body.error) {
      return body.error;
    }
    if (body.error && typeof body.error === 'object' && typeof body.error.message === 'string') {
      return body.error.message;
    }
  }
  if (typeof body === 'string' && body.trim()) {
    return body.trim();
  }
  return fallback;
}

export async function registerClient({ asUrl, initialAccessToken, metadata }) {
  const headers = { 'Content-Type': 'application/json' };
  if (initialAccessToken) {
    headers.Authorization = `Bearer ${initialAccessToken}`;
  }
  const response = await fetch(`${asUrl}/oauth/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify(metadata),
  });
  const body = await readJsonOrText(response);
  if (!response.ok || body.kind !== 'json') {
    const err = new Error(describeFailure(body.value, `client registration failed (${response.status})`));
    err.status = response.status;
    throw err;
  }
  return body.value;
}

export function buildParRequest({ clientId, clientName, sourceKind, sourceId, streamName, purposeCode, purposeDescription, accessMode }) {
  if (!clientId) throw new Error('clientId is required');
  if (sourceKind !== 'connector' && sourceKind !== 'provider_native') {
    throw new Error("sourceKind must be 'connector' or 'provider_native'");
  }
  if (!sourceId) {
    throw new Error('sourceId is required');
  }
  if (!streamName) throw new Error('streamName is required');
  return {
    client_id: clientId,
    ...(clientName ? { client_display: { name: clientName } } : {}),
    authorization_details: [
      {
        type: 'https://pdpp.org/data-access',
        source: { kind: sourceKind, id: sourceId },
        purpose_code: purposeCode,
        purpose_description: purposeDescription,
        access_mode: accessMode,
        streams: [{ name: streamName }],
      },
    ],
  };
}

export async function stageParRequest({ asUrl, request }) {
  const response = await fetch(`${asUrl}/oauth/par`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = await readJsonOrText(response);
  if (!response.ok || body.kind !== 'json') {
    const err = new Error(describeFailure(body.value, `PAR staging failed (${response.status})`));
    err.status = response.status;
    throw err;
  }
  return body.value;
}

export function buildHostedApprovalUrl({ asUrl, requestUri }) {
  const url = new URL(`${asUrl}/consent`);
  url.searchParams.set('request_uri', requestUri);
  return url.toString();
}

/**
 * Reference-local inline approval shortcut. This calls the hosted consent
 * endpoint directly with a JSON body and asks for a JSON response. Only usable
 * when owner-auth placeholder is disabled; when it is enabled, the AS will
 * respond with a redirect / 401 and this helper surfaces that honestly.
 */
export async function approveInline({ asUrl, requestUri, subjectId }) {
  const response = await fetch(`${asUrl}/consent/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ request_uri: requestUri, subject_id: subjectId }),
    redirect: 'manual',
  });
  if (response.status >= 300 && response.status < 400) {
    const err = new Error(
      'Inline approval redirected — the reference server appears to have owner authentication enabled. Use the hosted consent page instead.',
    );
    err.status = response.status;
    err.ownerAuthEnabled = true;
    throw err;
  }
  if (response.status === 401) {
    const err = new Error(
      'Inline approval was rejected with 401 — the reference server appears to have owner authentication enabled. Use the hosted consent page instead.',
    );
    err.status = 401;
    err.ownerAuthEnabled = true;
    throw err;
  }
  const body = await readJsonOrText(response);
  if (!response.ok) {
    const err = new Error(describeFailure(body.value, `approval failed (${response.status})`));
    err.status = response.status;
    throw err;
  }
  if (body.kind !== 'json' || !body.value || typeof body.value !== 'object') {
    const err = new Error(
      'Inline approval returned a non-JSON response — the reference server appears to have owner authentication enabled. Use the hosted consent page instead.',
    );
    err.status = response.status;
    err.ownerAuthEnabled = true;
    throw err;
  }
  const { token, grant_id, grant } = body.value;
  if (typeof token !== 'string' || !token) {
    throw new Error('approval returned without a token');
  }
  return { token, grantId: grant_id || null, grant: grant || null };
}

export async function denyInline({ asUrl, requestUri }) {
  const response = await fetch(`${asUrl}/consent/deny`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: asForm({ request_uri: requestUri }),
    redirect: 'manual',
  });
  if (response.status >= 300 && response.status < 400) {
    const err = new Error(
      'Inline denial redirected — the reference server appears to have owner authentication enabled. Use the hosted consent page instead.',
    );
    err.status = response.status;
    err.ownerAuthEnabled = true;
    throw err;
  }
  if (response.status === 401) {
    const err = new Error(
      'Inline denial was rejected with 401 — the reference server appears to have owner authentication enabled. Use the hosted consent page instead.',
    );
    err.status = 401;
    err.ownerAuthEnabled = true;
    throw err;
  }
  if (!response.ok) {
    const body = await readJsonOrText(response);
    throw new Error(describeFailure(body.value, `denial failed (${response.status})`));
  }
  return { ok: true };
}

export async function introspectToken({ asUrl, token }) {
  const response = await fetch(`${asUrl}/introspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const body = await readJsonOrText(response);
  if (!response.ok || body.kind !== 'json') {
    throw new Error(describeFailure(body.value, `introspection failed (${response.status})`));
  }
  return body.value;
}

export async function queryStreams({ rsUrl, token }) {
  const response = await fetch(`${rsUrl}/v1/streams`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await readJsonOrText(response);
  if (!response.ok) {
    throw new Error(describeFailure(body.value, `streams query failed (${response.status})`));
  }
  return body.value;
}

export async function queryStreamRecords({ rsUrl, token, streamName, limit = 10 }) {
  const url = new URL(`${rsUrl}/v1/streams/${encodeURIComponent(streamName)}/records`);
  if (limit) url.searchParams.set('limit', String(limit));
  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await readJsonOrText(response);
  if (!response.ok) {
    throw new Error(describeFailure(body.value, `records query failed (${response.status})`));
  }
  return body.value;
}
