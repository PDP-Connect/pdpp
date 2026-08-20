# PDPP Reference — Example Third-Party Client

A tiny Node + Express app that exercises the **current** thin PDPP reference
provider-connect flow end to end. It is intentionally small, server-rendered,
and has no build step.

It is not:

- a generic OAuth authorization-code redirect client
- a PKCE / code-exchange client
- the PDPP server UI

It is a third-party client illustration that calls the real public endpoints
the reference AS currently advertises:

1. `POST /oauth/register` — public-client self-registration
2. `POST /oauth/par` — PAR request staging
3. Review and owner approval:
   - `POST /consent/review` returns the exact approval artifact and its revision
   - `POST /consent/approve` accepts only the request URI and that revision
   - `GET /consent?request_uri=...` provides the hosted approval page
4. `GET {rs}/v1/streams` / `GET {rs}/v1/streams/:stream/records` — RS reads

## Run

1. Start the reference AS/RS:

   ```bash
   pnpm --dir reference-implementation server
   ```

2. Register the Spotify connector manifest (the example app's shipped default
   request targets this connector):

   ```bash
   curl -sS -X POST http://localhost:7662/connectors \
     -H 'Content-Type: application/json' \
     --data @reference-implementation/fixtures/seed-manifests/spotify.json
   ```

3. Start the example third-party client app:

   ```bash
   pnpm --dir reference-implementation example-client
   ```

Environment:

- `PORT` (default `7674`) — HTTP port for this example app
- `AS_URL` (default `http://localhost:7662`) — reference authorization server
- `RS_URL` (default `http://localhost:7663`) — reference resource server

Visit <http://localhost:7674> and follow the five sections top to bottom.
The shipped defaults target connector
`https://registry.pdpp.dev/connectors/spotify` and stream `top_artists`, so
the form can be submitted as-is once that manifest is registered.

## Approval modes

- The inline JSON path performs a review first. It receives the exact artifact,
  keeps its revision, and submits that revision for final approval. The final
  request does not submit stream or field choices again.
- When `PDPP_OWNER_PASSWORD` is **set**, the inline path is rejected by the
  reference server. This app prompts you to open the hosted `/consent` page.

## What this app proves — and does not prove

This app proves that the current reference flow, from registration through PAR,
review, owner approval, token, and RS query, works end to end against a local
reference stack.

It does **not** prove a full generic third-party authorization-code redirect
profile. It also does not expose RFC 7662 token introspection: in the reference
runtime, introspection is a confidential AS-to-RS boundary and requires
operator-configured caller credentials.
