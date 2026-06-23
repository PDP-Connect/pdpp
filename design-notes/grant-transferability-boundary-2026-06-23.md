# Explicit Grant Transferability / Delegation Boundary

Status: captured
Owner: the owner
Created: 2026-06-23
Updated: 2026-06-23
Related: apps/site/content/docs/spec-core.md (§6 Grant, client_id binding); docs/positioning/persistence-and-self-sovereignty.md

## Question

Should the spec state an explicit boundary on transferring or delegating a grant to another
party? Today a grant is bound to a `client_id` and there is no transfer/delegation
mechanism, but the spec neither provides one nor explicitly prohibits transfer.

## Context

Surfaced while answering external person' question, which inferred (from "immutable,
cryptographically bound") that users might share consent artifacts with other users or apps.
The spec is silent: a grant authorizes a specific `client_id`, clients authenticate with
access tokens (not raw grants), so handing over a copy should not confer access — but none
of this is stated normatively.

## Stakes

- Leaving it silent: a reviewer can ask "if it's a bearer token bound to a grant, what stops
  a client handing the token to someone else?" and the spec has no stated answer.
- Stating a boundary ("v0.1 defines no mechanism to transfer or delegate a grant; a grant
  authorizes a specific client_id"): converts silence into explicit scope precision, which
  LFDT reviewers reward, and pre-empts the question.
- Note two distinct future capabilities to keep separate if/when this advances:
  (a) presenting a signed grant as *evidence* (verify what was authorized, no access);
  (b) *delegation* via a new narrowed child grant with its own client/audience binding,
  expiry, and revocation — not transfer of the original grant.

## Current Leaning

Add a one-sentence non-transferability boundary to §6 Grant for v0.1. Defer signing,
presentation, and delegation flows to a future version (the spec already marks the grant
"designed to be signable").

## Promotion Trigger

Promote to an OpenSpec change to add the boundary sentence, since it touches a durable
contract (grant semantics). Small, but it is a normative addition, so it goes through a
proper delta rather than a drive-by edit.

## Decision Log

- 2026-06-23 — Captured from the external person review thread. Not yet decided.
