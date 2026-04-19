# Collection Profile Prior Art: Decision Memo

**Date:** 2026-04-08
**Status:** Recommendation for review
**Full analysis:** `docs/research/collection-prior-art-deep-dive.md`

---

## Bottom Line

**Keep the bounded-run Collection Profile. Add thin sibling profiles for push delivery and batch import. Do not build a unified ingestion framework.**

The bounded-run model (spawn, START, RECORD/STATE, DONE) is the right primitive for PDPP. Twelve prior-art systems confirm this:

- Every system that successfully unifies push and pull (OTel Collector, Debezium, NiFi) operates on data from systems the operator controls. PDPP collects from platforms the user does not control. The trust model is different, and the bounded-run lifecycle is what gives PDPP its audit and consent enforcement properties.
- Every successful protocol ecosystem that handles multiple interaction modes (OAuth 2.0, IETF SET, OpenID SSF) uses modular specifications, not a single unified framework. PDPP should follow this pattern.
- Airbyte and Kafka Connect -- the two closest analogs -- are both exclusively pull-based by design. When push sources exist, they adapt push to pull via intermediate stores. This is a deliberate architectural choice, not a gap.

---

## Key Evidence

| Finding | Source | Implication |
|---------|--------|-------------|
| Airbyte protocol has no push path; webhook sources use S3 intermediaries | Airbyte docs | Pull-only is a valid, proven design at scale |
| Kafka Connect source tasks are exclusively poll-based | Apache Kafka 4.1 dev guide | The most successful data integration framework chose poll-only for sources |
| IETF SET separates token format (RFC 8417) from push (8935) and poll (8936) delivery | IETF RFCs | Message format can be shared across profiles without unifying the profiles |
| OpenID SSF unifies stream management while keeping push/poll as selectable delivery | OpenID SSF 1.0 (Sept 2025) | Management plane unification + delivery plane modularity is the pattern |
| OAuth 2.0 uses separate specs per interaction mode (device flow, CIBA, introspection) | OAuth ecosystem | The modular spec pattern has 20 years of success |
| OTel Collector's receiver model assumes controlled systems with no consent layer | OTel architecture docs | The "just treat it as another receiver" analogy breaks on trust boundaries |
| Debezium's snapshot+streaming unification works because it reads the DB's own WAL | Debezium docs | Unification works when push source is cooperative and structured |

---

## What to Do Next

1. **No changes to the current Collection Profile.** It is sound and well-specified. The bounded-run model, binding matching, INTERACTION messages, and scope enforcement are genuine innovations over Airbyte/Singer.

2. **Draft a Push Delivery Profile (thin).** Define how a cooperating platform or intermediary delivers RECORD messages to the resource server via HTTP callbacks. Share RECORD format, state semantics, and scope enforcement with the Collection Profile. Add: endpoint authentication, replay protection, event ordering. Model after WebSub and SSF Section 6.1.1.

3. **Draft a Batch Import Profile (thin).** Define how pre-collected data files (platform export archives, CSV, JSON) are validated and imported. Share RECORD format. Simpler lifecycle: validate schema, import records, report result.

4. **Formalize the shared layer.** The RECORD message format, state/checkpoint semantics, and scope enforcement rules should be extracted into a section of the core spec (or a shared definitions document) that all profiles reference. This is the analog of RFC 8417 (SET token format) that sits beneath the delivery-specific profiles.

5. **Do not prioritize this now.** The existing Collection Profile covers the dominant use case (pull-based collection from non-cooperating platforms). Push delivery becomes relevant only when platforms offer data portability APIs or webhooks. Batch import is useful but lower priority. Write the profiles when demand materializes, not speculatively.

---

## What This Does Not Resolve

- **Continuous streaming for cooperative platforms.** If a platform offers a real-time event stream (not just webhooks), that might need a fourth profile. But no current PDPP target platform offers this, so it is premature to specify.
- **Agent-based collection.** If connectors ever run as persistent agents (not bounded processes), the lifecycle model changes fundamentally. This is a bigger architectural question than profile design.
- **Connector SDK design.** How connector authors implement multi-profile support is an SDK/tooling question, not a protocol question. The protocol should define the wire format and conformance requirements; the SDK should make it easy to build connectors that support multiple profiles.
