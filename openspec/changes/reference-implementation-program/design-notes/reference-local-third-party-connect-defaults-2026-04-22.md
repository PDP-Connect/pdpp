# Reference-local third-party connect defaults (2026-04-22)

## Summary

The forkable PDPP reference now makes the current thin provider-connect flow
usable **by default** for local development:

- dynamic client registration is enabled out of the box, backed by a shared
  reference-local default initial access token
- the dashboard bootstrap client (`pdpp-web-dashboard`) and the polyfill
  owner bootstrap client (`pdpp-polyfill-owner-bootstrap`) are pre-registered
  at server startup
- the dashboard's DCR workspace picks up the same shared default when no
  environment override is set
- a small example third-party app under `reference-implementation/examples/
  third-party-app/` exercises the real current flow end to end against a
  running local reference stack

Shared defaults live in [`reference-implementation/server/reference-local-defaults.js`](../../../../reference-implementation/server/reference-local-defaults.js)
so the fallback token literal and the default pre-registered client list are
not duplicated between the reference server and the dashboard.

## Why this is reference-local convenience, not PDPP protocol

The default initial access token, the default pre-registered client set, and
the inline JSON approval shortcut in the example app are all developer
ergonomics for the forkable local reference — they are **not** part of the
PDPP contract:

- operators deploying the reference non-locally are expected to supply their
  own `PDPP_DCR_INITIAL_ACCESS_TOKENS` and their own pre-registered client set
- `PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION=0` still turns DCR off entirely
- when `PDPP_OWNER_PASSWORD` is set, the example app's inline JSON approval
  shortcut is rejected by the reference server; the example surfaces that
  honestly and points to the hosted `/consent` page

This tranche deliberately does not add:

- a generic OAuth authorization-code redirect profile
- PKCE / code-verifier / code-exchange machinery
- any hidden private token minting route
- a widened `registration_endpoint` contract

## What the example app proves — and does not prove

The example client proves the **current** thin reference provider-connect
flow end to end:

1. `POST /oauth/register` (dynamic client registration)
2. `POST /oauth/par` (PAR request staging)
3. owner approval, either through the hosted `/consent` page or through the
   reference-local JSON shortcut on `POST /consent/approve`
4. an RS read with the issued bearer token

The example client does **not** prove a full generic third-party
authorization-code redirect profile. Whether the launch reference should
eventually prove that broader profile remains one of the still-open provider-
connect design questions recorded in
[`design.md`](../design.md).

## Validation

- `pnpm --dir reference-implementation test` runs new focused tests that
  prove default startup advertises `registration_endpoint`, explicit disable
  still removes it, `pdpp-web-dashboard` is seeded, and the example client
  completes the inline-approval path end to end (including an honest
  owner-auth-enabled rejection path)
- `pnpm --dir apps/web types:check` confirms the dashboard picks up the
  shared defaults module through the `pdpp-reference-implementation`
  workspace import
- `pnpm --dir apps/web build` confirms the dashboard still compiles
- `pnpm --filter @pdpp/reference-contract test` and
  `pnpm reference-contract:check-generated` confirm no contract drift
