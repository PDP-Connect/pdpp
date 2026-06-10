# Open question: manifest completeness vs the source's actual surface (Layer 2)

**Status:** open
**Raised:** 2026-04-19
**Trigger:** the owner on Gmail — "I couldn't find message content." The `messages` stream validates cleanly and its extractor populates every declared field, but no body/text field is declared. The manifest doesn't claim Gmail has bodies. Not drift; a coverage gap.

## The three audit layers

### Layer 1 — manifest vs data
Catches broken extractors, undeclared columns, null-where-required, declared fields that never populate. Recent run surfaced ChatGPT dropping ~67% of messages, Gmail `snippet`/`references`/`content_type` broken, USAA manifest drift. The conformance harness already runs this.

### Layer 2 — manifest vs source surface
Catches the manifest omitting parts of the source a reasonable consumer would expect. Gmail `messages` with no body text is canonical: IMAP has bodies, the connector chose not to fetch them, and the manifest doesn't advertise the omission. Layer 1 passes — the stream still under-represents the source.

### Layer 3 — manifest vs consumer use-cases (grant fitness)
Catches a manifest that is source-complete but still insufficient for use-cases clients need — a grant authorizes "messages" yet fails to power "search my inbox by phrase." Out of scope here beyond naming it.

## What the spec says today

`spec-core.md` §7 defines manifest syntax and calls the manifest "the source of truth for what can be consented to." It says nothing about whether a manifest must represent the source's full surface. "Complete" appears only in "manifest syntax completeness" (a schema property, not a coverage claim). `display.detail` encourages prose about exclusions ("No DMs, profile details, or follower lists") but isn't structured or required.

Effectively: Layer 2 is undefined. A polyfill can declare one trivial field and still be spec-conformant.

## The question

1. Should polyfill manifests commit to a completeness contract at all, or accept that connectors are curated subsets by design?
2. If yes, against which baseline — upstream API surface, user-visible surface, or a declared use-case list?
3. Where does "deliberate omission" live — a structured manifest field, a sibling doc, the `display.detail` prose, or all three?
4. How does the consent card express "this connector covers X, not Y" without overloading `display.detail`?

## Candidate resolutions

### A. Manifest adds a declared-coverage rubric
Optional per-stream field, e.g. `coverage_statement: { included: [...], omitted: [...], rationale: "..." }`. Pro: structured, auditable, renderable in consent UI. Con: every author now has to enumerate what they didn't build; baseline still undefined.

### B. Sibling doc per connector (`coverage.md`)
Each manifest ships a prose companion naming in/out. Pro: low ceremony, close to today's design notes. Con: not machine-readable, won't reach the consent card without extra plumbing.

### C. Spec adds a conformance level
Two tiers — "full coverage of the source" vs "curated subset." Manifests declare which they claim. Pro: sharp contract consumers can reason about. Con: "full coverage" is nearly undefinable for sources without a published API (Gmail bodies are easy; Slack DM edge-cases multiply fast).

### D. Accept silence, rely on consumer inspection
Document that manifests are always curated and consumers must inspect declared fields before building on them. Pro: no spec change. Con: the user-facing failure ("I couldn't find message content") stays invisible until runtime.

## Cross-cutting observations

- **Why Layer 1 missed this.** The harness only validates declared schemas; it cannot flag "missing field that should exist" without a model of the source.
- **Layer 2 audits in flight.** Spot-checking each connector by naming the top 3–5 things a reasonable consumer would expect and comparing to the manifest. Variance looks high — some are near-total coverage, others (Gmail, Slack) are narrow MVPs.
- **Connects to earlier open questions.** `connector-configuration-open-question.md` (a `coverage_statement` would join `credentials_schema` / `options_schema`), `external-tool-dependencies-open-question.md` (coverage sometimes depends on which external tool is used), `owner-self-export-open-question.md` (a `GET /v1/connectors` response is a natural place to surface coverage claims).

## Action items
- [ ] Complete Layer 2 audits across all connectors (in flight).
- [ ] Decide on a coverage model (A/B/C/D) once we see how much variance there is.
- [ ] Update all manifests to declare coverage explicitly, in whichever shape wins.
- [ ] Add a coverage field to `spec-core.md` §7 if option A or C is chosen.
