# Design

## Goal

Improve the first-party polyfill fleet's usefulness while preserving provenance honesty. This change is not about making every connector broad; it is about adding streams that materially improve assistant/demo value and can be verified against real owner data or clearly marked unavailable.

## Sequencing

Start with connectors that do not require hostile browser automation or new upstream accounts. Local-file connectors and API-backed connectors should generally precede bank/browser connectors. Browser-only streams should require a reproducible live-smoke note before being marked done.

## Provenance Rule

Spotify and Reddit are special because local rows have previously been populated by fixture/demo paths. Those rows must not be presented as the owner-account evidence. The implementation must either purge and re-ingest real owner data, or label the connector as blocked/untrusted until real-account ingestion is possible.

## Non-Goals

- No new public API surface.
- No fixture-redaction pipeline; that is `add-connector-fixture-scrubber-pipeline`.
- No partial-run semantics; that is `define-partial-run-honesty`.
- No runtime scheduler/control-plane redesign.

## Acceptance Checks

- Every added stream has manifest schema, parser coverage, and at least one integration-style test.
- Every live-smoke claim distinguishes real owner data from fixture/demo data.
- Spotify/Reddit fake-data cleanup is either completed or visibly tracked as blocked before internal demo evidence is generated from those connectors.
