## Why

OAuth endpoints currently return RFC-shaped errors while PDPP resource endpoints return PDPP-shaped error envelopes with `request_id`. The shape split is intentional, but the missing request identifier on OAuth errors makes third-party debugging weaker.

## What Changes

- Preserve RFC-shaped OAuth error responses.
- Add `request_id` to OAuth error bodies and the `Request-Id` response header.
- Document the reference policy so clients do not expect OAuth endpoints to use the nested PDPP error envelope.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Affects OAuth error responses from `POST /oauth/register`, `POST /oauth/device_authorization`, and `POST /oauth/token`.
- Does not change OAuth success responses.
- Does not wrap OAuth errors in the PDPP resource-server error envelope.
