# Semantic Retrieval Metadata Carrier — 2026-04-23

**Status:** owner recommendation (project-scoped, non-normative)  
**Purpose:** choose the right discovery carrier and boundary for the semantic
retrieval experimental extension.

## Question

If PDPP exposes semantic retrieval as an experimental optional extension, where
should clients discover it, and what should that metadata contain?

## Recommendation

Use the **existing resource-server metadata document** as the server-level
carrier, under:

```json
{
  "capabilities": {
    "semantic_retrieval": {
      "...": "..."
    }
  }
}
```

Do **not** add a new capability document for this tranche.

Keep the layered split:

- server-level metadata for truly global facts about the extension
- per-stream metadata for stream-specific field participation

That means:

- server metadata advertises that semantic retrieval exists at all
- server metadata describes the experimental/global shape
- per-stream metadata remains the authoritative home of
  `query.search.semantic_fields`

## Why this is the right fit

### 1. It matches the existing capability-discovery direction

The current owner recommendation is small layered discovery, not a broad new
capability statement:

- small server-level capability layer for truly global facts
- stream metadata for stream-specific query power

Semantic retrieval fits that pattern cleanly.

### 2. It keeps lexical and semantic retrieval aligned

Lexical retrieval already uses RS metadata for server-level advertisement plus
stream metadata for field declarations.

Semantic retrieval should follow the same split unless there is a concrete
contradiction. Otherwise we create needless drift between two closely related
extension families.

### 3. It keeps the experimental boundary explicit

Because semantic retrieval is intentionally experimental, clients need to know
that before they call it.

The RS metadata document is the right place to declare facts such as:

- supported or not
- experimental stability
- endpoint path
- cross-stream support
- query-input mode
- snippet support
- model/config facts

### 4. It avoids premature metadata machinery

A separate capability document would add another discovery surface before we
have earned that complexity.

The current problem does not require a CapabilityStatement-like layer. It
requires a small, honest, globally visible advertisement.

## What belongs in server metadata

At minimum, the semantic retrieval capability object should declare:

- `supported`
- `stability`
- `endpoint`
- `cross_stream`
- `query_input`
- `snippets`
- `lexical_blending`
- `model`
- `dimensions`
- `distance_metric`
- `default_limit`
- `max_limit`
- `index_state`

If materially known, it should also declare:

- `language` or locale bias

These are all server-level facts. They tell the client what kind of semantic
retrieval service it is talking to.

## What does not belong in server metadata

The server-level capability object should **not**:

- enumerate per-stream `semantic_fields`
- duplicate stream schemas
- promise cross-server comparability
- expose raw vector or index internals as public contract
- become a generic capability statement for unrelated features

## What belongs in stream metadata

Per-stream metadata remains the home of:

- whether the stream participates at all
- the declared `query.search.semantic_fields`

That keeps stream-specific truth where it belongs.

## Experimental-status requirement

Because this is not a stabilized extension yet, the server-level metadata
should make that explicit.

Recommended shape:

```json
{
  "capabilities": {
    "semantic_retrieval": {
      "supported": true,
      "stability": "experimental"
    }
  }
}
```

If the server cannot publish that experimental status clearly, it should not
advertise the extension publicly.

## Consequence for the upcoming OpenSpec draft

The next semantic retrieval change should:

1. use the existing RS metadata document as the discovery carrier
2. define a small `capabilities.semantic_retrieval` object there
3. keep `query.search.semantic_fields` in per-stream metadata
4. avoid any new top-level capability document unless a concrete contradiction
   appears during drafting

## Default review position

If the worker draft proposes:

- a new capability document
- per-stream facts duplicated into server metadata
- or no explicit `experimental` stability marker

the default owner review should be to push back unless the draft demonstrates a
real contradiction with the current architecture.
