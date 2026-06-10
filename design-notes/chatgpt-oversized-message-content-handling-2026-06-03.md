# ChatGPT oversized message content: in-band truncation now, blob path deferred

Status: decided-defer
Owner: RI owner / connector reliability
Created: 2026-06-03
Updated: 2026-06-03
Related: connectors/chatgpt/schemas.ts (`largeText = pdppSafeText.max(1_048_576)`),
connectors/chatgpt/parsers.ts (`extractContent`), commit 8b8fdb0d (control-char
safe-landing precedent), `hydrate-first-party-blob-streams` (gmail blob substrate)

## Question

A ChatGPT message whose extracted `content` exceeds the 1 MiB (`1_048_576`
character) `largeText` cap fails the `messages` schema at emit time and becomes a
terminal `shape_check_failed` `SKIP_RESULT`. The whole message is dropped and is
non-backfillable through the normal run. What is the right SLVP handling, and is
byte-exact preservation of oversized bodies worth a durable contract change?

## Context

- The cap lives in `connectors/chatgpt/schemas.ts`: `largeText =
  pdppSafeText.max(1_048_576)`, used by `messages.content`, `memories.content`,
  GPT `instructions`, custom-instructions, and `shared_conversations`.
- The runtime (`connector-runtime.ts` `makeEmitRecord`) has no per-record
  recovery hook: any zod failure → `makeShapeCheckSkip` → terminal SKIP. The only
  connector-side lever is to make the record valid at extraction time. This is
  the same lever `8b8fdb0d` used for control-rich content (collapse to `null`).
- A real, working blob substrate exists, but only for **binary attachment
  bytes** on the gmail `attachments` stream: content-addressed (`sha256`),
  `POST /v1/blobs`, `blob_ref.fetch_url`, `GET /v1/blobs/{blob_id}`, grant-visible
  `blob_ref` field (`makeReferenceBlobUploader`, `makeAttachmentHydrator`). It
  requires `PDPP_RS_URL` + `PDPP_OWNER_TOKEN` and a network round-trip mid-run.
- The `chatgpt` manifest (`manifests/chatgpt.json`) enumerates the `messages`
  stream schema `properties` explicitly. Adding fields such as `content_blob_ref`
  / `content_truncated` / `original_content_length` to the message record is a
  durable **contract change** to the messages stream (manifest + zod schema +
  grant-visibility semantics), which AGENTS.md requires be done via OpenSpec.

## Stakes

- The failing payload is **safe, oversized text** (e.g. a multi-megabyte pasted
  log), not binary. The blob substrate is content-addressed binary storage keyed
  to attachment records; reusing it for inline message text would change the
  agent-readable shape of the `messages` stream and is not a drop-in.
- The user cares about data completeness. The chosen immediate fix must not
  permanently lose recoverable content and must leave the record backfillable.

## Current Leaning

Shipped now (this lane), **no contract change**: truncate the oversized body's
head in-band into the existing `content` field (`string|null`) and append a
self-describing recovery marker. The record lands, stays agent-readable, fits the
cap, and is fully backfillable because `id` + `conversation_id` re-fetch the full
body from the conversation detail endpoint. This mirrors the existing
`extractFallback` in-band truncation (`… ` sentinel) and the `8b8fdb0d`
safe-landing precedent. It is strictly better than `content: null` for
completeness while staying within the messages contract.

## Promotion Trigger

Promote to an OpenSpec change if the owner decides byte-exact preservation of
oversized message bodies is required. The recommended shape, NOT smuggled into
code here:

- Add an inline-text hydration path that routes a body over the cap to the blob
  substrate (reuse `makeReferenceBlobUploader`; the substrate is already
  content-addressed and idempotent), emitting `content` = bounded head preview +
  a new `content_blob_ref` (grant-visible, mirroring gmail `attachments`).
- This is a durable `messages`-stream contract change: new manifest properties,
  new schema fields, new grant-visibility semantics, and a new env/runtime
  dependency (`PDPP_RS_URL` + `PDPP_OWNER_TOKEN`) for the chatgpt connector. It
  needs owner sign-off and an OpenSpec proposal before implementation, exactly
  the kind of change the lane decision policy says not to smuggle in.

## Decision Log

- 2026-06-03: Shipped in-band truncation-with-recovery-marker as the SLVP-ideal
  safe immediate fix (closes the terminal `shape_check_failed` gap, no contract
  change). Recorded the blob-backed byte-exact path as `decided-defer` pending
  owner input. Raising the 1 MiB `largeText` cap globally was rejected: no
  evidence justifies it and it would inflate every text stream's storage and
  wire size.
