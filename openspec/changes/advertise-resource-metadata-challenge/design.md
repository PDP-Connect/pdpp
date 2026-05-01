## Context

The reference already serves RFC 9728 protected-resource metadata at `GET /.well-known/oauth-protected-resource`. Clients that know PDPP or RFC 9728 can fetch it directly from the resource origin, but a client that first probes a protected `/v1/**` endpoint currently receives only a JSON 401 error. RFC 9728 Section 5.1 defines a `WWW-Authenticate` `resource_metadata` parameter for that reactive discovery path.

The reference also already protects metadata origin derivation: configured public origins are authoritative, local/private host-derived metadata is allowed, and public host-derived metadata requires `PDPP_TRUSTED_HOSTS`.

## Goals / Non-Goals

**Goals:**

- Emit an RFC 9728 `WWW-Authenticate: Bearer resource_metadata="..."` challenge on RS bearer-token 401 responses.
- Use the same resource-origin resolution and trust checks as the protected-resource metadata endpoint.
- Preserve the existing JSON PDPP error envelope while adding machine-readable discovery hints inside `error`.
- Avoid advertising attacker-controlled public hosts.

**Non-Goals:**

- Do not add a generic `/.well-known/` index.
- Do not change AS OAuth error responses or owner-session UI auth responses.
- Do not invent PDPP-specific challenge parameters.
- Do not change grant-expired/grant-revoked 403 behavior.

## Decisions

### Challenge only RS bearer-token 401s

The helper is wired through the RS request path and called by `requireToken` before returning `401 authentication_error`. This keeps AS login, dynamic client registration, owner-session auth, and grant-state 403s unchanged.

### Derive from trusted metadata origin logic

The challenge URL is computed from the resolved protected-resource identifier and then mapped to its RFC 9728 metadata URL. If resolving that URL would require trusting an unallowlisted public `Host` or `X-Forwarded-Host`, the response keeps the 401 body but omits `WWW-Authenticate`.

### Add body hints for agents that do not read headers

The response body remains the existing PDPP error envelope, but RS 401 responses that have a trusted metadata URL add `error.resource_metadata` and `error.next_step`. The header is the standards path; the body fields are an AI-friendly fallback for clients that call `curl -s`, log only the body, or otherwise ignore response headers.

## Risks / Trade-offs

- Host-header confusion → Mitigated by reusing `isTrustedMetadataRequestOrigin` and omitting the header when the host is not trusted.
- Partial client support → Acceptable; clients that ignore the header still see the existing JSON error.
- Strict JSON clients → Mitigated by adding fields inside the existing error object without changing `type`, `code`, `message`, `param`, or `request_id`.
- Header parsing quirks → The metadata URL is emitted as an HTTP quoted-string and tests assert the exact header value.
