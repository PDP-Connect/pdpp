# Troubleshooting

When the flow breaks, work the failure top-down: discovery → registration → PAR → approval → token → introspect → schema → call. Most agent-side failures are at the boundary between two of those stages.

## Discovery

**Symptom:** `404` on `/.well-known/oauth-protected-resource` or `/.well-known/oauth-authorization-server`.

- Confirm the URL the user gave you is the *server* URL, not a project page or a marketing site.
- Try the other well-known path. Many users provide the AS URL when you needed the RS URL or vice versa.
- If both 404, ask the user for the issuer URL printed at server start.

**Symptom:** Discovery returns metadata but no `pushed_authorization_request_endpoint` or `registration_endpoint`.

- This AS is configured without PAR or dynamic registration. The agent flow this skill describes won't work as-is.
- Stop. Tell the user the AS is configured without the endpoints the skill needs, and ask them to either enable them or pre-provision a client_id and grant out-of-band.

## Registration

**Symptom:** `POST /oauth/register` returns `401 invalid_token` or `403`.

- The AS protects registration with an initial-access token and you don't have one.
- Ask the user *once* for an initial-access token (read it from `PDPP_INITIAL_ACCESS_TOKEN` env if they prefer).
- Do not request an owner bearer token to "fall back" to. They are not interchangeable.

**Symptom:** Registration succeeds but the returned `client_id` doesn't appear in subsequent PAR calls (`invalid_client`).

- The AS may use multi-tenant client storage and require a tenant id you didn't pass. Re-read the registration response for hints; check the AS docs the user pointed you to.

## PAR (`POST /oauth/par`)

**Symptom:** `400 invalid_request: connector_id and provider_id are mutually exclusive`.

- You set both. Pick one.

**Symptom:** `400 invalid_client: Unknown client_id`.

- Either the registration didn't complete, or you're pointing at a different AS than the one you registered with. Confirm `client_id` came from `clients/<client-id>.json` and that `AS_URL` matches the AS used at registration time.

**Symptom:** `400` with a manifest-mismatch error referencing a stream you didn't ask for.

- The connector you named has a stream alias (e.g., `messages` vs. `gmail.messages`) that the manifest enforces. Call `/v1/schema` with whatever token you can to see the stream names this connector exposes, then resubmit with the correct names.

**Symptom:** PAR succeeds, but `authorization_url` points to a host the user can't reach (e.g., `localhost` printed to a remote chat).

- The AS resolves its own external URL from `AS_PUBLIC_URL` or the request `Host` header. If the user is remote, ask them to provide the AS URL they reach the consent shell at, and resubmit with that as the `--as-url` (or set the matching env var) when calling PAR.

## Approval (owner)

**Symptom:** Owner approves but you have no token.

- The reference does not yet expose a public polling endpoint for PAR-staged grants. Either:
  - The local CLI captured the token and wrote it to `.pdpp/tokens/<grant-id>.token`. Look there.
  - Ask the user to paste the token from the consent confirmation screen *once*, into a single-message channel. Save with `mode 0600` and never echo it.
- Stop and ask if the user reports approving but neither path produced a token. Don't bypass with an owner token.

**Symptom:** Owner says they approved but the request shows `pending` or `expired` later.

- PAR requests expire in ~5 minutes. If they took longer to approve, the request is gone — start a fresh PAR.

**Symptom:** Owner denies.

- Don't retry. Ask why and adjust the next request: smaller scope, narrower time window, clearer purpose. Re-read `references/grant-design.md` first.

## Introspection

**Symptom:** `introspect` returns `active=false`.

- The token expired, was revoked, or was never valid. Don't use it. If the grant id is still in the cache, mark it dead in `grants/<grant-id>.json` and request a fresh grant.

**Symptom:** `pdpp_token_kind=owner` when you expected `client`.

- You picked up the wrong token. The owner-token path mints these via `/oauth/device_authorization`; check your CLI flow and confirm you ran the agent flow, not the owner flow.

## Schema

**Symptom:** `/v1/schema` returns 401.

- Token isn't being sent or is malformed. Confirm `Authorization: Bearer <token>` exactly, no whitespace.

**Symptom:** `/v1/schema` returns 200 but `connectors[]` is empty.

- The grant has no source binding the RS can resolve. Either the connector hasn't synced any data, or the grant binds to a connector the RS doesn't have. Check the consent UI's grant detail page.

**Symptom:** A stream you asked for is missing from `connectors[].streams`.

- Either the connector doesn't expose that stream, or your grant didn't include it. Re-read the original `authorization_details` you submitted.

## Data calls

**Symptom:** `403 insufficient_scope`.

- The grant doesn't cover this stream/field/filter combination. Don't fall back to a broader grant in the background. Request an upgrade and explain to the user why.

**Symptom:** `403 grant_revoked`.

- The owner revoked. Stop. Don't request a replacement automatically; ask the user.

**Symptom:** `404` on a record id you have a reference to.

- The connector may have re-keyed records on a sync. Re-fetch the parent list and use the current id.

**Symptom:** A record's `blob_ref.fetch_url` returns 404.

- Blob expired or wasn't ingested. Don't synthesize a URL; tell the user the attachment isn't available via this grant.

**Symptom:** A record that should have an attachment is missing `blob_ref` entirely.

- Three possibilities, in order of likelihood:
  1. The grant doesn't include the `blob_ref` field on this stream — re-request the grant including it.
  2. The record's `hydration_status` is `deferred`, `failed`, `too_large`, `unavailable`, or `blocked`. The metadata is real; the bytes are not. Surface the status to the user; don't retry blindly.
  3. The connector for this stream hasn't yet been migrated to emit `blob_ref` (today only Gmail `attachments` ships hydration). Tell the user the bytes are not yet plumbed.
- Do **not** guess at `/v1/streams/.../{id}/content` or `/v1/blobs/{id}/download` — neither is part of the PDPP API.

**Symptom:** Tempted to construct a `/content` or `/download` URL.

- Stop. The PDPP byte-fetch contract is `GET /v1/blobs/{blob_id}` reached through `blob_ref.fetch_url`. Anything else is a guess that may work today against one implementation and silently break against another.

**Symptom:** Aggregate or search endpoint returns `unsupported_capability`.

- `/v1/schema` advertised what's available; trust it. If you skipped the schema check, do it now.

## Cache and filesystem

**Symptom:** `tokens/<grant-id>.token` exists but `cat` returns empty.

- Either the writer failed mid-write or the file was truncated by a tool. Revoke the grant id (just in case it leaked) and request a new grant.

**Symptom:** `.pdpp/` ends up tracked by git.

- Stop. Run `git rm -r --cached .pdpp` (do **not** run `git rm -r .pdpp` — that would delete it on disk too). Update `.gitignore`. If the file ever made it into a remote, the tokens are compromised; revoke them and re-grant.

## Owner says no, repeatedly

If the owner denies multiple times in a row, the request is the problem, not the owner. Pause and ask:

- "Was the purpose unclear?"
- "Is there a stream you'd rather I avoid?"
- "Is there a smaller scope that would still get me what you asked for?"

Don't keep submitting near-identical requests. Each rejection costs trust.

## When you're stuck

Stop. Write a single message to the user containing:

- which step failed (discovery / registration / PAR / approval / introspect / schema / call)
- the exact error code and message you saw
- what you'd try next
- whether you need any owner action (approval, env var, revocation)

Do not improvise around a real failure with degraded auth (owner token, pasted credentials, copy-pasted output from another session). The skill's value is that it stays narrow under pressure.
