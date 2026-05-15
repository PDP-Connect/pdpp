# Gmail Attachments And Multi-Instance Readiness

Status: decided-promote
Owner: Lane C
Created: 2026-05-15
Updated: 2026-05-15
Related: packages/polyfill-connectors/connectors/gmail, packages/polyfill-connectors/manifests/gmail.json, reference-implementation/runtime/index.js

## Question

Can the current Gmail connector safely collect attachment blobs for all mail and support multiple Gmail accounts or collector devices as separate instances of the same connector?

## Context

The Gmail manifest exposes `messages`, `threads`, `labels`, `message_bodies`, and `attachments`. `attachments` is now a blob-backed stream in connector code: when the stream is requested, the connector decodes IMAP `BODYSTRUCTURE`, downloads each attachment part with `client.download(uid, part_index)`, uploads bytes to `/v1/blobs`, and emits `blob_ref`, `content_sha256`, `hydration_status`, and `hydration_error`.

This is not an all-history blob guarantee. Incremental fetch range is keyed by the message cursor (`priorUidnext:*` after first sync), so attachments are hydrated for messages seen in the current message pass: full resync messages or new UIDs. If `attachments` is enabled after `messages` already advanced state, historical attachment records are not backfilled unless an operator forces a full resync or a future backfill mode is added.

The standard reference runtime stores and ingests by `connector_id`: record upserts, blob bindings, stream state, and schedules all use the manifest connector id as the storage namespace. Two Gmail accounts using `https://registry.pdpp.org/connectors/gmail` would collide on record keys, state, schedules, and dashboard display. The local collector CLI has `source-instance-id`, but the standard ingest/state paths reviewed here do not carry it as the durable record/state/blob namespace.

## Stakes

Gmail attachment content is high-sensitivity binary data. A partial implementation must be honest about which bytes were actually fetched, why missing bytes are missing, and whether a second account could overwrite or suppress the first account's data. Multi-device Claude collectors increase this risk because "same connector id, different account/device" looks operationally plausible while the storage model remains connector-id scoped.

## Current Leaning

Promote this to an OpenSpec change before enabling multi-account Gmail or promising all-mail attachment blobs. The change should define a first-class connector instance identity that is distinct from connector capability identity. That identity should flow through runs, ingest, blob bindings, state, schedules, grants, search, dashboard labels, and collector enrollment.

For attachments, add an explicit backfill plan instead of overloading normal incremental sync. A plausible shape is an attachment-specific cursor such as `attachments.backfilled_through_uid` plus a bounded backfill run mode that can scan historical `BODYSTRUCTURE` rows and hydrate missing or failed attachments without resetting message state.

## Promotion Trigger

Promote before any of these are implemented:

- Running two Gmail accounts under the same PDPP owner.
- Displaying multiple Gmail instances in the dashboard.
- Treating `source_instance_id` as the durable storage namespace.
- Claiming Gmail attachment blobs are complete for previously indexed mail.
- Adding scheduler semantics for per-instance connector runs.

## Decision Log

- 2026-05-15: Captured current state. Attachment hydration exists for requested current-pass messages, but historical backfill and multi-instance storage identity need OpenSpec before implementation.
- 2026-05-15: Added a bounded connector warning when attachment blob upload cannot run because `PDPP_RS_URL`/`RS_URL` or `PDPP_OWNER_TOKEN` is missing.
