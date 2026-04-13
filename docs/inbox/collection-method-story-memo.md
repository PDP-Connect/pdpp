# Collection Method Story

**Date:** 2026-04-12
**Status:** Settled product framing

---

## The story

PDPP works with your data regardless of how it gets to your server.

- **Use an API when one is available.** If a platform offers a data portability API, the connector calls it directly. Fastest, most reliable, lowest friction.
- **Use browser automation when it's not.** Most platforms don't offer structured data APIs today. Connectors drive a browser to collect data from the platform's web UI. Same protocol, same consent, same enforcement — the browser is just the transport.
- **Use import when that's what you have.** Downloaded your data archive from a platform? Import it directly to your server. The data enters the same streams, gets the same grants, the same field projection.

All three paths produce the same result: structured records on your personal server, queryable under the same consent and enforcement rules. The protocol doesn't know or care which path was used.

## Why this matters

The most common question about PDPP is: "This is great, but Instagram doesn't have a PDPP API."

The answer: PDPP doesn't require platform cooperation. Browser automation is a polyfill. When platforms adopt data portability standards (DMA, GDPR Art. 20) or offer their own APIs, connectors get simpler — but your grants, your consent UX, and your enforcement don't change.

## Where this is expressed

- **spec-core.md §1:** "Data may reach the personal server via connector-driven collection, regulatory data exports, manual import, or platform-native APIs. The consent and enforcement layers are agnostic to the collection method."
- **spec-collection-profile.md Overview:** "Collection method abstraction" subsection.
- **Reference page Ingest section (Level 1):** "whether those platforms offer data APIs or not"
- **Reference page Multi section (Level 1):** "different access methods, same protocol"
- **Reference page Ingest detail panel (Level 2):** explains `bindings` and the polyfill-to-native transition
