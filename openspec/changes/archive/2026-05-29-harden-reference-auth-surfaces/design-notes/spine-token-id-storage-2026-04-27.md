# Spine `token_id` storage — followup

- Status: deferred (out of scope for `harden-reference-auth-surfaces`).
- Captured: 2026-04-27.
- Origin: bug-hunt audit, finding P0 #1.

## Context

`reference-implementation/lib/spine.ts` declares `token_id` as a first-class column on `spine_events`. `auth.js::issueToken` and `auth.js::issueOwnerTokenRecord` write the literal opaque bearer string into that column when emitting `token.issued` events. The introspection table uses the same value as `tokens.token_id`. So the spine table holds a live credential.

`harden-reference-auth-surfaces` removes the field from `_ref/grants/:id/timeline` and `_ref/runs/:id/timeline` response payloads. That closes the remote-extraction path, but the column still holds the credential at rest in `pdpp.sqlite`.

## What we want

Replace the stored bearer with something that gives spine consumers correlation without giving them the credential. Two viable shapes:

1. **Hash**: store `sha256(token_id_value)` as `token_id_hash`, drop the original column. Consumers that need to correlate "this event is about that token" can hash the bearer they hold and join on the hash.
2. **Truncated id**: store an opaque identifier minted alongside the bearer (e.g. `tok_<random>` separate from the bearer string itself) so the bearer never lands on the spine.

(2) is cleaner; (1) is a smaller migration. The reference contract already exposes `token_id` on introspection responses; whichever shape we pick has to land in lockstep with that contract.

## Why not now

- Schema migration on every existing `pdpp.sqlite` (live owner DBs included).
- Backfill of every existing spine row that already carries the bearer.
- Audit of every consumer of spine events that may join on `token_id` today (CLI timeline rendering, dashboard timeline view, polyfill connector test fixtures).
- Coordination with the introspection response shape (`token_id` field is part of the public reply).

This is a careful tranche, not a same-night patch.

## Suggested next packet

Open a fresh OpenSpec change `replace-spine-token-id-with-hash` (or `mint-opaque-spine-token-id`). It SHALL:

- propose the chosen shape (hash vs separate id) with a one-paragraph rationale.
- include a migration plan for `pdpp.sqlite` instances in the wild.
- re-review every place that reads `token_id` and decide which need to switch to the new shape.
- pin a regression test that the spine table never contains a row whose `token_id_hash` equals a value returned from `tokens.token_id`.
