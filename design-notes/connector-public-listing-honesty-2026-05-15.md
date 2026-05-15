# Connector Public Listing Honesty

Status: decided
Owner: connector fleet reliability
Created: 2026-05-15
Updated: 2026-05-15
Related: add-polyfill-connector-system, make-reference-freshness-honest

## Question

How should the reference deployment distinguish proven user-facing connectors from unproven connectors, local-only connectors, and test stubs in public listings and schedules?

## Context

The Docker reference deployment currently has a mix of production-like connectors, local-only file readers, browser connectors requiring owner-present auth, and e2e stub connectors registered in the control plane. Some manifested connectors also have code and public stream contracts but no observed records in the reference deployment.

Examples from the 2026-05-15 audit:

- `spotify` is manifested and registered, but has zero records in Docker Postgres and requires a pre-issued `SPOTIFY_ACCESS_TOKEN`; it should not appear as proven working until a credentialed run succeeds.
- `manual_action_stub` and `stream-test-stub` are registered in Docker Postgres but are not public connector manifests under `packages/polyfill-connectors/manifests`; they are e2e/test surfaces and should not be presented as real data sources.
- `claude-code` and `codex` are local-only filesystem readers. They can be safe to schedule on the host with matching source paths, but Docker/provider runs can falsely succeed with zero emitted records when source paths are unavailable unless source preflight guards are active.
- `slack` is a real connector with a large historical dataset, but current Docker scheduled runs fail because `slackdump` is missing at runtime.

## Stakes

If public listings and schedules do not expose connector proof state, operators can mistake a registered manifest for a working integration. That causes false success, zero-record refreshes, repeated noisy failures, and missing-data surprises.

## Current Leaning

Keep public manifests, but add an explicit connector maturity/listing layer rather than deleting connectors:

- `proven_working`: recent successful run with useful records or a valid no-change proof.
- `needs_human_auth`: real connector, blocked on credentials/OTP/manual login.
- `local_only`: requires host-local source paths or devices; do not run in provider Docker unless a local collector provides those paths.
- `unproven`: manifested code exists but the reference deployment has no useful records.
- `test_stub`: e2e/control-plane stub; hide from user-facing connector catalog and schedules.
- `broken_in_current_deployment`: connector is real but current deployment lacks a required tool/runtime/config.

## Promotion Trigger

Promote to OpenSpec before implementing any catalog, schedule, API, or dashboard behavior that hides connectors, changes public connector availability, or changes scheduler eligibility.

## Decision Log

- 2026-05-15: Captured during Lane A connector fleet reliability audit. No connector was removed. Spotify manifest was updated only to declare its existing credential requirement honestly.
- 2026-05-15: Implemented a narrow reference-dashboard honesty guard: manifests may opt out of public catalog listing with `capabilities.public_listing.listed: false`, known e2e stub IDs are hidden from the reference connector catalog, and Spotify is marked `unproven` plus non-background-safe until a credentialed run proves useful records. This is reference/operator listing behavior, not a PDPP protocol contract.
