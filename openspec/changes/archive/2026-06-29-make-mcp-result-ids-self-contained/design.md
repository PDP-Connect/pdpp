# Design: Self-Contained MCP Search-Result Ids

## Id format choice

Chosen grammar: `{connection_id}/{stream}:{record_id}`
(e.g. `cin_4f2a/orders:o1`), with the legacy `stream:record_id` form still
parsed when no `/` is present.

Why `/` as the connection separator:

- The adapter's `requireSafeName` guard (already enforced on every stream,
  record id, and connection id that crosses the fetch path) rejects `/`, `\`,
  and `..`. So `/` can never legally appear inside any segment — its presence
  unambiguously marks the self-contained form, and every previously issued
  legacy id keeps parsing byte-for-byte identically. No version sentinel or
  escaping scheme is needed.
- A `:`-separated triple (`connection:stream:record`) was rejected because
  legacy parsing splits at the FIRST `:` and record ids may themselves contain
  `:`; `a:b:c` would be ambiguous between the two grammars.
- A prefixed sentinel (`pdpp:...`) was rejected because stream names are
  connector-declared and a stream literally named `pdpp` would collide; the
  reserved-character approach has no such reachable collision.
- The form reads naturally as a scoping path (connection → stream → record),
  matches the citation URL the adapter already constructs
  (`/v1/streams/{stream}/records/{record_id}?connection_id=...`), and
  round-trips through `formatInlineValue` in `content[]` text (which preserves
  `/` and `:`).

## Resolution semantics

- `fetch` parses the connection segment off the front (first `/`), validates
  every segment with `requireSafeName` (path traversal in any segment is
  rejected before an RS call), and forwards the embedded connection as the
  canonical `connection_id` query parameter — the MCP layer still never
  invents or rewrites a connection id; the RS continues to own grant
  enforcement.
- Explicit `connection_id` argument + legacy id: unchanged semantics
  (backcompat), including the typed `ambiguous_connection` 409 path when
  unscoped on a multi-source grant.
- Explicit `connection_id` argument + self-contained id: accepted when equal;
  a disagreement is a typed `conflicting_connection_id` error rather than a
  silent preference, because silently picking either handle could read the
  wrong source.
- Search only wraps base ids that are themselves record handles
  (`stream:record_id`); opaque fallbacks (URLs, `result:N`) and connection ids
  that cannot survive the grammar pass through unwrapped, so the adapter never
  mints a malformed handle.

## Token-budget posture

Longer ids are paid for by removing the now-redundant `connection_id=` field
from search `content[]` preview lines (it reappears only for the degenerate
hit whose id could not embed the connection). Measured on the fat token-budget
fixture: search prose 876 → 877 bytes (budget 1,800); `tools/list`
21,689 → 22,061 bytes (budget 24,576) from the richer id-grammar
descriptions. The preview id truncation bound is raised from 80 to 200 chars
because a truncated id is a dead handle; the bound now exists only to keep
pathological record keys from blowing the text budget.

## Out of scope

- `query_records` / `aggregate` envelopes: they return canonical RS bodies,
  not OpenAI-contract documents, and carry no composite fetch handles.
- RS-side result-id minting (`result_id` on hits): if the RS later mints its
  own self-contained ids, `selfContainedResultId` passes ids that already
  carry a `/` through untouched.
