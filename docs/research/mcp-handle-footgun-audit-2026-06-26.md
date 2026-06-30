# MCP handle footgun audit - 2026-06-26

Status: sanitized research closeout. This note preserves the durable client
ergonomics finding from the MCP read-evidence closeout without retaining local
paths or raw transcripts.

## Finding

The reliable ChatGPT-facing read-evidence path is:

1. compact schema/tool discovery;
2. scoped search with bounded visible evidence;
3. a structured `read_record_field` recipe using a self-contained record id and
   field path;
4. inline bounded field text with offsets, continuation cursors, and truncation
   metadata;
5. projected `fetch` only as a fallback.

Raw resource handles are compatibility details, not the ideal model-visible
primary path. In particular, ordinary search output should not leave the model
with only a `pdpp://record/...` URI that generic resource reading cannot read or
that model-callable tools do not accept directly.

## Verified behavior

- Search/content-ladder output normalizes parseable record handles into
  self-contained callable ids such as `connection_id/stream:record_id`.
- Ordinary bounded field-read output uses structured `read_record_field` args
  instead of exposing standalone `pdpp://field-window/...` resource handles as
  the main continuation path.
- `read_record_field`, `fetch`, and capable resource readers still accept
  canonical record URIs for compatibility.
- Resource-less clients can complete the classification journey through visible
  evidence and tool args alone.
- Small message-like evidence remains inline and does not require file
  materialization.

## Local evidence preserved

The closeout audit ran MCP hostile-client and self-contained-id tests plus the
server integration suite. The combined result was passing, and OpenSpec
validation passed for the MCP SLVP surface and read-evidence ladder changes.

## Residual regression rule

If a future hosted-client retest again exposes raw `pdpp://field-window/...`
handles or non-callable `pdpp://record/...` handles as the ordinary model-visible
path, treat that as a regression against the read-evidence ladder. The acceptable
ordinary path is a visible evidence excerpt plus an explicit callable bounded
read recipe.
