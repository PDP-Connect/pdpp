# Semantic Retrieval Experimental Extension — 2026-04-23

**Status:** owner execution brief (project-scoped, non-normative)  
**Purpose:** define the smallest honest public semantic retrieval capability
PDPP should be willing to expose during prelaunch, while keeping the contract
tight enough to revise or cut off later if it proves wrong.

**Depends on:**

- `surface-status-ladder-2026-04-23.md`
- `semantic-retrieval-status-options-2026-04-23.md`
- `semantic-retrieval-reference-experiment-2026-04-23.md`

## Why this exists

The prior semantic brief took a conservative stance:

- reference-first
- `/_ref/*`
- no public extension framing yet

The owner stance is now more aggressive:

- there are no external users yet
- the project is still prelaunch
- if a public semantic extension is bad, we can revise or remove it

That changes the right move from:

- "keep it reference-only for now"

to:

- "ship the smallest honest **experimental extension** now"

## Owner decision

Semantic retrieval may be exposed as a **named optional extension** now, but it
must be explicitly marked as:

- `experimental`
- `unstable`
- not yet a candidate core surface

The extension should be:

- text-query only
- cross-stream
- candidate-reference oriented
- grant-safe
- server-chosen-model, truthfully declared

It should **not** be:

- core PDPP
- a raw-vector API
- a portability promise across servers
- a replacement for lexical retrieval as the public floor

## Why this is acceptable now

The usual caution about public experimental surfaces is still real, but the
practical downside is lower because:

- no outside users are depending on the contract yet
- we can still revise aggressively
- a discoverable public extension is better product feedback than a hidden
  reference-only surface

The key discipline is:

- keep the experimental boundary explicit
- keep the capability metadata truthful
- keep the surface small

## Extension status and stability

Treat this as an **experimental extension**, not a stabilized extension.

That means:

- it is publicly named and discoverable
- clients/agents may use it
- the server must declare that it is experimental
- breaking revisions are still acceptable during prelaunch

The stability marker should be explicit in capability metadata.

## Surface shape

### Public route

Use a dedicated public route:

- `GET /v1/search/semantic`

Reason:

- it avoids mutating the approved lexical retrieval contract on
  `GET /v1/search`
- it keeps the extension family legible
- it lets us retract or revise semantic retrieval without destabilizing lexical
  retrieval

### Query input

The experimental extension should accept **text queries only**.

Allowed v1 parameters:

- `q`
- `limit`
- `cursor`
- `streams[]`

Do **not** add yet:

- raw vector input
- client-supplied embeddings
- semantic model selectors
- ranking knobs
- connector-specific parameters

## Result shape

Return candidate references, not hydrated records.

The shape should stay intentionally close to lexical retrieval:

- `stream`
- `record_key`
- `connector_id` where relevant
- `record_url` when available
- `emitted_at`
- `matched_fields`
- optional `snippet`

The experiment may also return one clearly experimental field such as:

- `retrieval_mode`

for example:

- `semantic`
- `hybrid`

Do **not** expose a portable numeric score contract yet.

## Declared field model

Semantic retrieval must be opt-in at the stream/field level.

Candidate declaration:

```json
{
  "query": {
    "search": {
      "semantic_fields": ["text", "subject", "body"]
    }
  }
}
```

Rules:

- top-level textual fields only in the first experimental extension
- no nested paths
- no blobs
- no silent "embed every string we can find"

This keeps the extension aligned with the truthfulness bar already set for
lexical retrieval.

## Capability metadata

The server must publish a small capability object that makes the experiment
legible.

At minimum it should declare:

- `supported`
- `stability: "experimental"`
- `endpoint`
- `cross_stream`
- `query_input: "text"`
- `snippets`
- `lexical_blending`
- `model`
- `dimensions`
- `distance_metric`
- `default_limit`
- `max_limit`
- `index_state`

Possible `index_state` values:

- `built`
- `building`
- `stale`

If the configured model has a meaningful language/locale bias, the server
should declare that too.

## Grant and snippet safety

The same hard rule from lexical retrieval applies:

- search only granted streams
- search only granted fields
- search only declared semantic fields
- never leak ungranted text in snippets

No "embed everything, filter later" loophole.

If the extension cannot hold that line, it should not ship.

## What remains implementation-defined

The extension may keep these local:

- exact embedding backend
- vector/index backend
- ANN strategy
- tokenizer details
- reranker details
- lexical blending formula
- batch/rebuild mechanics

That is where hackability belongs.

The stable boundary is:

- declared capability facts
- request shape
- grant safety
- result-shape expectations

## What this extension must not promise

It must not promise:

- cross-server comparable results
- portable numeric score semantics
- standardized model choice
- standardized ranking formula
- embedding export as canonical owner self-export content

The point is a useful public capability, not fake portability.

## Success criteria

The extension is successful if it shows:

1. semantic retrieval materially helps on a real PDPP task set
2. the metadata is sufficient for a client/agent to understand what it is
   calling
3. lexical retrieval remains the public floor and semantic stays additive
4. the model/rebuild/version story is explicit enough to avoid black-box drift

## Stop-and-report conditions

Stop rather than widening casually if any of these become necessary:

- changing `GET /v1/search` itself
- raw vector queries
- multiple model families in one public contract
- searching undeclared fields
- snippets from ungranted fields
- pretending results are portable across servers when they are not

## Relationship to lexical retrieval

Lexical retrieval remains the stable public retrieval floor.

Semantic retrieval is:

- additive
- experimental
- more opinionated
- more revisable

Generated/private data should still be able to succeed with lexical retrieval
alone. Semantic retrieval is a higher-power tool, not the baseline contract.

## Next step after this brief

If this brief is accepted, the next semantic artifact should be a worker brief
for the experimental extension itself.

Do **not** jump from this note to a core proposal.
