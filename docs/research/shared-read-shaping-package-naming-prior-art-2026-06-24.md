# Shared Read-Shaping Package Naming Prior Art

Status: captured
Date: 2026-06-24
Question: What should we learn from mature package ecosystems before naming a shared package that shapes read/search/fetch outputs into bounded previews, continuation handles, and deliberate escalation descriptors?

## Short Answer

The prior art does not support `bounded-read` as an obviously idiomatic package name. It is semantically accurate, but it names a constraint rather than a package-shaped thing.

Mature ecosystems generally use one of these naming patterns:

- `<domain>-core` or `core` when shared semantics power multiple adapters.
- `<domain>-runtime` when the package executes durable runtime behavior.
- `<domain>-util-to-<output>` when the package is a precise pure transformation.
- A domain noun when the package owns a durable data model.
- `toolkit` only when the package is intentionally broad and batteries-included.

For PDPP, the package should be named after the durable concept it owns, not after a current adapter or a generic utility bucket.

## Prior Art Table

| Package | What It Owns | Naming Pattern | Relevance |
| --- | --- | --- | --- |
| [`@tanstack/query-core`](https://www.npmjs.com/package/%40tanstack/query-core) | Framework-agnostic core that powers TanStack Query adapters. | `<concept>-core` | Strong analogue for shared semantics used by multiple adapters. |
| [`@urql/core`](https://www.npmjs.com/package/%40urql/core) | Shared core for the urql GraphQL client. | `core` | Mature adapter ecosystem uses a small shared core. |
| [`relay-runtime`](https://www.npmjs.com/package/relay-runtime) | Data fetching, reading, normalization, and store runtime for Relay. | `runtime` | Good analogy if package owns executable read semantics. |
| [`@apollo/client`](https://www.npmjs.com/package/%40apollo/client) | Broad GraphQL client package with cache, state, and integrations. | product noun | Shows the opposite choice: one broad public package. Too broad for this PDPP seam. |
| [`@reduxjs/toolkit`](https://www.npmjs.com/package/%40reduxjs/toolkit) | Standard opinionated utilities for Redux logic. | `toolkit` | Useful only if the package is deliberately broad. Risky for this scoped concept. |
| [`@sentry/core`](https://www.npmjs.com/package/%40sentry/core) | Base SDK interfaces, classes, and utilities for Sentry SDKs. | `core` | Shared SDK base used by multiple platform packages. |
| [`@opentelemetry/core`](https://www.npmjs.com/package/%40opentelemetry/core) | Constants and utilities shared by OpenTelemetry SDK packages. | `core` | Common naming for cross-SDK shared behavior. |
| [`@smithy/core`](https://www.npmjs.com/package/%40smithy/core) | Common functionality for generic Smithy clients. | `core` | Close analogue for generated/client adapter shared internals. |
| [`@smithy/types`](https://www.npmjs.com/package/%40smithy/types) | Shared Smithy client types, mostly internal to generated clients. | `types` | If a package is mostly contracts, name it as contracts. |
| [`@aws-sdk/core`](https://www.npmjs.com/package/%40aws-sdk/core) | Shared functions/classes for AWS SDK clients. | `core` | Cross-client shared semantics in a mature modular SDK. |
| [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/%40modelcontextprotocol/sdk) | SDK for MCP tools/resources/prompts/transports/auth helpers. | `sdk` | Broader distribution package, not the right altitude for this seam. |
| [`unified`](https://www.npmjs.com/package/unified) | Interface for processing content with syntax trees. | domain noun | Strong concept noun works when the concept is established. |
| [`vfile`](https://www.npmjs.com/package/vfile) | Virtual file data model with metadata and messages. | data-model noun | Useful analogy if PDPP creates a durable shaped-output data model. |
| [`vfile-reporter`](https://www.npmjs.com/package/vfile-reporter) | Textual reports from processed files/messages. | `<thing>-reporter` | Renderer packages name the output role. |
| [`mdast-util-to-markdown`](https://www.npmjs.com/package/mdast-util-to-markdown) | Serializes mdast syntax trees to markdown. | `<domain>-util-to-<output>` | Precise pure transformation naming. |
| [`hast-util-to-html`](https://www.npmjs.com/package/hast-util-to-html) | Serializes hast syntax trees to HTML. | `<domain>-util-to-<output>` | Good model when the package transforms one data shape into another. |
| [`mdast-util-to-string`](https://www.npmjs.com/package/mdast-util-to-string) | Extracts plain text from mdast nodes. | `<domain>-util-to-<output>` | Names the exact operation rather than a broad abstraction. |
| [`unist-util-visit`](https://www.npmjs.com/package/unist-util-visit) | Visits nodes in unist trees. | `<domain>-util-<verb>` | Small utilities can be domain-specific and verb-specific. |
| [`hast-util-to-string`](https://www.npmjs.com/package/hast-util-to-string) | Gets plain text from hast nodes. | `<domain>-util-to-<output>` | Reinforces explicit transformation naming. |
| [`to-vfile`](https://www.npmjs.com/package/to-vfile) | Creates a virtual file from a description. | `to-<model>` | Functional transform name where the target model is the package concept. |

## Naming Implications

`bounded-read` is understandable engineering vocabulary, but it is not strongly supported by package-name prior art. It reads like a safety constraint rather than a durable concept. Use it in docs as an invariant if needed, not necessarily as the package name.

`disclosure` is too broad. In PDPP it risks attracting consent UI, grant language, positioning, export policy, redaction, and other concerns outside this pure read-output shaping seam.

`record-evidence` has a misleading noun feel. It can sound like a pile of evidence/documents rather than a shaping package.

The closest naming families are:

- `read-*-core` if this is shared semantics used by multiple adapters.
- `*-util-to-*` if we want explicit pure-transform naming.
- A durable PDPP noun if the shaped output model gets one.

## Working Name Candidates

These are candidates to evaluate, not a final decision:

| Candidate | Strength | Risk |
| --- | --- | --- |
| `@pdpp/read-shaping` | Names the function: shape read-like data into safe client-facing output. | Gerund package names are less common. |
| `@pdpp/read-output` | Plain, easy to understand. | May sound like raw output, not policy-bearing shaping. |
| `@pdpp/read-surface-core` | Matches `query-core` / SDK-core prior art while scoping to read surfaces. | Slightly abstract; "surface" must be established vocabulary. |
| `@pdpp/read-result-shaping` | Very explicit. | Long and less elegant. |
| `@pdpp/content-ladder` | Distinctive if "content ladder" is established PDPP vocabulary. | Jargon if not already durable. |

## Recommendation Criteria

Pick the name only after deciding which noun is durable in PDPP vocabulary:

- If the durable noun is "read surface", prefer `@pdpp/read-surface-core`.
- If the durable noun is "content ladder", prefer `@pdpp/content-ladder`.
- If no durable noun exists yet, prefer explicit function over novelty: `@pdpp/read-shaping` or `@pdpp/read-result-shaping`.

Regardless of name, the package boundary should stay pure:

- Input: records, search hits, fetch/read outputs, and field-window responses.
- Output: bounded previews, truncation state, handle descriptors, continuation args, binary/blob metadata, and escalation descriptors.
- Not included: auth, HTTP, filesystem export, CLI flags, UI copy, host-specific ChatGPT workarounds, connector-specific semantics.

## Open Decision

Do not finalize the package name solely from intuition. Choose after confirming whether "content ladder", "read surface", or another noun is already the best PDPP concept term.
