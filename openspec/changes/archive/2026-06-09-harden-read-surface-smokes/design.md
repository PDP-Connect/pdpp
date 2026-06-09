## Context

Live MCP and REST checks showed the reference read surface was mostly healthy, but the evidence path had three gaps:

- The CLI could cache a scoped grant but could not use that grant for reads.
- Package ambiguity errors could list child grants that were no longer usable.
- The Slack `messages.sent_at` aggregate probe was valid for the record schema but not declared in the manifest.

## Decisions

### Add `pdpp read` instead of widening `pdpp ref`

`pdpp ref` is owner-diagnostic. Grant-scoped reads belong in a separate `pdpp read` namespace that uses the existing `pdpp connect` credential cache and only sends the cached client bearer. This keeps owner credentials out of routine client checks and gives agents a CLI path equivalent to REST reads.

### Probe package child health only on ambiguity metadata

The hosted MCP package adapter now probes child `/v1/streams` only when a source-required package call omits `connection_id`. Scoped calls still route to exactly one child and preserve that child response, including `grant_invalid`.

The ambiguity envelope lists healthy children under `available_connections` and failed probes under `unavailable_connections`. This avoids presenting a stale child grant as a normal selectable option while preserving the authorization failure for explicit selections.

### Declare Slack time buckets where the schema supports them

Slack `messages.sent_at` is a date-time field, cursor field, consent time field, range-filter field, and min/max aggregate field. Declaring `query.aggregations.group_by_time: ["sent_at"]` makes the manifest match the read surface exercised by REST, MCP, and CLI smoke checks.

## Acceptance

- `pdpp read` can call schema, stream, record, search, fetch, and aggregate endpoints with a cached client grant.
- Successful read responses keep machine-readable bodies on stdout and canonical `meta.warnings[]` on stderr.
- Ambiguous package errors do not advertise invalid child grants as normal candidates.
- Live REST, MCP, and CLI smoke checks pass for a granted Slack `messages` stream, excluding only host-specific retest warnings and intentionally skipped side-effect probes.
