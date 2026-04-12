# Collection Layer Prior Art: Split Profiles vs Unified Ingestion

## Executive Summary

The question of whether PDPP should keep its bounded-run, pull-based Collection Profile and add sibling profiles for other interaction modes, or evolve toward a unified ingestion framework, has strong prior art on both sides. After examining twelve systems -- six that split different modes into separate specifications and six that attempt unification -- the evidence points toward **keeping the bounded-run model as the primary primitive and adding thin sibling profiles for push/subscription modes, rather than building a unified adapter framework**. The systems that unify (OpenTelemetry Collector, Kafka Connect, Debezium) succeed because they control both sides of the pipeline and operate on data from systems the operator controls. PDPP collects personal data from systems the user does not control, which makes the bounded-run model's explicit lifecycle (spawn, collect, done) a better fit for auditability, consent enforcement, and failure semantics. The strongest counter-argument -- that push-based sources (webhook callbacks from platforms that cooperate) will require a fundamentally different runtime -- is real but addressable through a thin Push Delivery Profile that shares message format and state semantics with the existing Collection Profile.

---

## Taxonomy of Prior Art

### Systems That Split Different Modes

| System | Split Boundary | What Gets Separated |
|--------|---------------|-------------------|
| IETF SET (RFC 8417/8935/8936) | Transport | Token format (8417) vs push delivery (8935) vs poll delivery (8936) |
| OpenID Shared Signals Framework | Delivery method within unified framework | Push (RFC 8935) and poll (RFC 8936) as selectable delivery within one stream management spec |
| SCIM | Provisioning vs eventing | CRUD provisioning (RFC 7644) vs event notification (separate spec) |
| W3C ActivityPub | Client vs federation | Client-to-server API vs server-to-server federation protocol |
| WebSub | Subscription/callback vs feed polling | Push notification (WebSub) as overlay on existing polling infrastructure |
| OAuth 2.0 ecosystem | Interaction pattern | Core framework + separate specs per flow (device, CIBA, introspection, RAR) |

### Systems That Unify Different Modes

| System | Core Abstraction | What Gets Unified |
|--------|-----------------|-------------------|
| OpenTelemetry Collector | Receiver/processor/exporter pipeline | Push (OTLP), pull (Prometheus scraping), file import under one pipeline |
| Kafka Connect | Source/sink task with poll() loop | Poll-based extraction from any source under one framework |
| Airbyte Protocol | spec/check/discover/read lifecycle | Pull-based extraction with RECORD/STATE/CATALOG messages |
| Debezium | Snapshot + streaming CDC connector | Initial snapshot (pull) and continuous log streaming (push from WAL) |
| Apache NiFi | FlowFile processor graph | Batch file, real-time stream, network listener, database poll under one DAG |
| Fluentd/Fluent Bit/Vector | Source/transform/sink pipeline | File tailing, network listeners, pull scrapers under one topology |

---

## Comparison Table

| System | Abstraction Boundary | Lifecycle Model | State/Checkpoint | Split or Unified | Relevance to PDPP |
|--------|---------------------|----------------|-----------------|-----------------|-------------------|
| IETF SET | Token format vs transport | Stateless tokens, delivery is separate | No state; each event is independent | Split (3 RFCs) | High: shows how to split message format from delivery |
| OpenID SSF | Stream management + pluggable delivery | Long-lived streams with verification | Stream-level, managed by transmitter | Unified framework, split delivery | High: shows push/poll as delivery choice within one framework |
| SCIM | CRUD vs notification | Request/response for CRUD; subscription for events | Offset-like pagination for CRUD; event ordering for notification | Split | Medium: identity provisioning is analogous to data sync |
| ActivityPub | C2S vs S2S | Inbox/outbox as persistent collections | OrderedCollection with pagination | Split (C2S/S2S) | Low: federated social is structurally different from personal data collection |
| WebSub | Subscription callback vs feed | Subscription has TTL; feeds are stateless | Hub manages subscription state | Split (overlay) | Medium: shows push as overlay on polling |
| OAuth 2.0 | Per-flow interaction patterns | Each flow has its own lifecycle | Token state managed by AS | Split (modular specs) | High: PDPP already uses this pattern for grant types |
| OTel Collector | Pipeline component interfaces | Start/Shutdown lifecycle per component | Scraper intervals; push is real-time | Unified | Medium: strong pipeline model but assumes controlled systems |
| Kafka Connect | SourceTask.poll() loop | Start/poll/stop on worker thread; offset commit | Framework-managed offset storage | Unified (poll-only for sources) | High: closest architectural analogy to PDPP collection |
| Airbyte Protocol | spec/check/discover/read | Bounded run per sync; state between syncs | Per-stream state with global/stream/legacy modes | Unified (pull-only) | Highest: PDPP's Collection Profile derives from this lineage |
| Debezium | Snapshot + streaming connector | Initial snapshot then continuous streaming | Offset management via Kafka Connect | Unified (snapshot+stream) | Medium: shows how to unify pull+push within one connector |
| Apache NiFi | FlowFile processor DAG | Continuous; processors run on schedule or trigger | FlowFile repository (write-ahead log) | Unified | Low: too broad; NiFi is a general dataflow platform |
| Fluentd/Vector | Source/transform/sink topology | Continuous daemon; sources run concurrently | Buffer management; backpressure | Unified | Low: log/event collection is structurally different |

---

## Detailed Analysis

### 1. IETF Security Event Tokens (SET): The Cleanest Split

The IETF SET framework is the purest example of separating message format from delivery mechanism. Three RFCs divide the concerns:

- **RFC 8417** defines the Security Event Token as a JWT-based envelope. It specifies what an event looks like but says nothing about how it gets delivered.
- **RFC 8935** defines push-based delivery: the transmitter POSTs the SET to the receiver's endpoint.
- **RFC 8936** defines poll-based delivery: the receiver POSTs to the transmitter's endpoint to fetch pending SETs, then acknowledges receipt.

The split boundary is transport, not semantics. The same SET can be delivered via push or poll. The token format is stable across both delivery methods. This is a clean, IETF-standard approach to the exact split PDPP faces.

**What PDPP can learn:** The SET model proves that you can define a message format (RECORD, STATE, DONE) independently of the delivery mechanism (child-process stdout, webhook callback, polling). PDPP's existing JSONL message types are the analog of RFC 8417. Different Collection Profiles would be analogs of RFC 8935 and 8936.

**Where the analogy breaks down:** SETs are individual events with no concept of a "run" or "session." PDPP collection runs have lifecycle (START, DONE), state management, and binding requirements. The delivery mechanism for PDPP carries more weight than for SETs because it implies a runtime model, not just a transport.

### 2. OpenID Shared Signals Framework: Split Delivery Within Unified Management

The OpenID SSF (finalized September 2025) takes a different approach from pure IETF SET. It defines a unified stream management layer -- stream creation, configuration, verification, status monitoring -- and makes push vs poll a configuration choice within the stream:

- Stream creation via HTTP POST to a Configuration Endpoint
- Delivery method specified as a URI: `urn:ietf:rfc:8935` (push) or `urn:ietf:rfc:8936` (poll)
- Subject identification, event types, and lifecycle management are the same regardless of delivery method
- CAEP and RISC are profiles that define specific event types within the SSF framework

The key insight: SSF unifies the management plane (creating streams, selecting events, verifying delivery) while keeping the delivery plane modular. Push and poll are interchangeable delivery options, not separate protocols.

**What PDPP can learn:** The management/delivery separation is directly applicable. PDPP's grant model and manifest system are the management plane. The Collection Profile is a delivery mechanism. A Push Delivery Profile could be another delivery mechanism sharing the same management plane (grants, manifests, scope).

**Where the analogy breaks down:** SSF streams are long-lived pub/sub relationships between cooperating servers. PDPP collection runs are bounded, often interactive (browser automation), and operate against non-cooperating sources. The "just swap the delivery method" framing understates the lifecycle differences.

### 3. SCIM: Provisioning vs Eventing as Separate Concerns

SCIM cleanly separates its provisioning protocol (RFC 7644, CRUD-based REST API for user and group management) from its eventing model (a separate specification for hub-based notifications about resource changes). The provisioning protocol is synchronous and request/response; the eventing protocol is asynchronous and subscription-based.

RFC 7642 (the use-case document) explicitly describes both push and pull scenarios for identity provisioning: CSP-to-CSP push (one system initiates account creation at another) vs CSP-to-CSP pull (one system requests account information on demand). These are described as different deployment patterns using the same provisioning protocol, not as different protocols.

**What PDPP can learn:** SCIM's split between "doing the CRUD" and "being notified about changes" maps to PDPP's split between "collecting data" (Collection Profile) and "being notified of new data" (a hypothetical push/subscription profile). The SCIM ecosystem treats these as complementary, not competitive.

**Where the analogy breaks down:** SCIM operates between cooperating identity providers and service providers with established trust. PDPP connectors often operate against non-cooperating platforms via browser automation. The "eventing" side of SCIM assumes the source voluntarily sends notifications; PDPP cannot assume that.

### 4. W3C ActivityPub: C2S vs S2S Protocol Separation

ActivityPub separates two fundamentally different interaction patterns:

- **Client-to-Server (C2S):** A client interacts with a user's home server to create, read, update, and delete activities. The outbox is the user's publication endpoint.
- **Server-to-Server (S2S):** Servers push activities to each other's inboxes via HTTP POST. This is the federation protocol.

The inbox is a push target (servers POST activities to it). The outbox is a pull source (clients GET the collection, or POST new activities to it). Activities are delivered asynchronously with retry on failure.

As of 2025, the community is actively working on protocol negotiation (formalizing which behaviors an actor supports when it receives different activity types), which is itself a recognition that the C2S/S2S split leaves important behavioral questions unresolved.

**What PDPP can learn:** The C2S/S2S split is instructive as an example of splitting by trust context rather than by transport. C2S operates within a trust boundary (user to their own server); S2S operates across trust boundaries (server to server). PDPP's Collection Profile operates across a trust boundary (connector to platform); a push profile where a cooperating platform sends data to the user's server would operate within a partially trusted relationship.

**Where the analogy breaks down:** ActivityPub is a social federation protocol, not a data collection protocol. The inbox/outbox model assumes mutual willingness to communicate, which is not the case for PDPP connectors that scrape platforms via browser automation.

### 5. WebSub: Push as Overlay on Polling

WebSub (W3C Recommendation, evolved from PubSubHubbub) is the canonical example of adding push notification as an overlay on an existing polling model. Its explicit purpose: "to provide real-time notifications of changes, which improves upon the typical situation where a client periodically polls the feed server at some arbitrary interval."

The architecture has three roles: publisher (produces content at a URL), hub (manages subscriptions and delivers notifications), and subscriber (receives notifications at a callback URL). The subscriber discovers the hub by fetching the publisher's content, then subscribes at the hub with a callback URL. The hub verifies intent and then POSTs content changes to the callback.

Critically, WebSub "builds on existing infrastructure: implementing it won't change or break your current polling infrastructure, and if for some reason something fails, you can still resort to polling."

**What PDPP can learn:** WebSub's design philosophy -- push as an optimization overlay on polling, not a replacement -- is directly applicable. A PDPP Push Delivery Profile could work the same way: when a platform cooperates by offering a webhook or event stream, the runtime can receive push notifications instead of spawning a collection run. When push fails or is unavailable, fall back to the bounded-run model.

**Where the analogy breaks down:** WebSub assumes the publisher cooperates (announces a hub, provides content at a URL). Most PDPP connectors today operate against non-cooperating platforms. WebSub's relevance is aspirational (for the future where platforms offer data portability APIs) rather than immediately practical.

### 6. OAuth 2.0 Ecosystem: The Modular Specification Pattern

The OAuth 2.0 ecosystem is the strongest precedent for the "separate specs per interaction mode" approach, and PDPP already follows this pattern for its grant model (continuous vs single_use access modes).

The core framework (RFC 6749) defines authorization grant types and token mechanics. Each distinct interaction pattern gets its own specification:

- **Device Authorization Grant:** For input-constrained devices
- **CIBA:** Client-initiated backchannel authentication (user authenticates on a different device)
- **Token Introspection:** Resource server validates tokens
- **Rich Authorization Requests (RAR):** Fine-grained permissions beyond scopes (which PDPP uses via RFC 9396)
- **PKCE:** Security extension for public clients

Each spec assumes its own lifecycle, trust model, and interaction pattern. They share the core token mechanics and can be composed. This modularity has been the most successful approach in the identity/authorization space for two decades.

**What PDPP can learn:** This is the strongest argument for the "sibling profiles" approach. Just as OAuth defines separate specs for device flow and CIBA because they have fundamentally different interaction patterns and trust models, PDPP should define separate profiles for pull-based collection and push-based delivery because they have fundamentally different lifecycle models and trust assumptions.

---

### 7. OpenTelemetry Collector: The Unified Pipeline

The OpenTelemetry Collector is the most frequently cited example of a unified ingestion framework. Its architecture:

- **Receivers** accept data via push (OTLP gRPC/HTTP, Jaeger, Zipkin) or pull (Prometheus scraping, host metrics, database metrics). The receiver interface abstracts over both: push receivers listen on a port; pull receivers use a scraper that runs on an interval. Both convert data into the internal `pdata` representation.
- **Processors** transform data in sequence (batching, filtering, attribute manipulation, sampling). Order matters.
- **Exporters** send data to backends via push (OTLP, various vendor protocols) or batch file upload.
- **Connectors** bridge pipelines, acting as both exporter and receiver, enabling cross-signal-type routing.

Component lifecycle follows Start/Shutdown. Scrapers run on configurable intervals. Push receivers run continuously. The pipeline model is a DAG where receivers fan out to processors which fan out to exporters.

**The genuine insight:** The receiver interface genuinely unifies push and pull under one model. A push receiver and a pull scraper both produce `pdata` objects and push them into the pipeline. The downstream processors and exporters don't know or care how the data arrived.

**The genuine limitation for PDPP:** The OTel Collector assumes it is collecting telemetry from systems the operator controls or has instrumented. The collector and the systems it collects from exist within a shared operational context. There is no consent model, no grant-based access control, no interactive authentication, no concept of a "run" that starts and finishes. The collector is a daemon, not a bounded process.

PDPP connectors operate in a fundamentally different trust context: the user does not control the source platform. The connector may need to authenticate interactively (credentials, OTP, CAPTCHA). The collection run has a lifecycle with explicit consent boundaries. The "just treat it as another receiver" framing collapses this trust distinction.

**What PDPP can learn from OTel despite the analogy gap:** The message format should be independent of the delivery mechanism. OTel's `pdata` is the internal representation that all receivers produce and all exporters consume. PDPP's RECORD/STATE messages should play the same role: the format that all collection mechanisms produce and the resource server consumes, regardless of whether the data arrived via a bounded child-process run, a webhook callback, or a file import.

### 8. Kafka Connect: Poll-Based Unification

Kafka Connect is architecturally the closest analog to PDPP's Collection Profile among the unified systems, because it faces the same fundamental challenge: how to extract data from external systems that have their own access patterns.

The architecture:

- **Connectors** are high-level job definitions that partition work across tasks. They declare configuration and monitor external systems for changes.
- **Tasks** do the actual data copying. For source connectors, `SourceTask.poll()` is called repeatedly on a dedicated thread, returning `List<SourceRecord>` each time.
- **Offsets** are managed by the framework: each `SourceRecord` includes a source partition and source offset. The framework commits offsets periodically and provides `OffsetStorageReader` for resumption.
- **Exactly-once** is supported since Kafka Connect 3.3.0, with configurable transaction boundaries.

The critical design choice: **source connectors are exclusively poll-based**. The documentation states explicitly: "SourceTask uses a pull interface and SinkTask uses a push interface." There is no mechanism for push-based source connectors. If a source system pushes data (e.g., via webhook), the Kafka Connect approach is to receive it into an intermediate store (an HTTP server writing to a file or database) and then have a source connector poll that store.

**What PDPP can learn:** Kafka Connect's decision to make all source connectors poll-based is a deliberate simplification that has worked at massive scale. The poll loop gives the framework control over lifecycle, offset management, and error handling. When push sources need to be supported, they are adapted to the poll model via an intermediate buffer, not by adding a push path to the framework itself.

This is directly relevant to PDPP: rather than adding a push receiver to the collection runtime, PDPP could define a Push Delivery Profile where a webhook receiver writes records to the resource server (or a staging buffer), and the existing Collection Profile handles any additional reconciliation needed.

**Where the analogy breaks down:** Kafka Connect tasks are long-lived workers that poll continuously. PDPP collection runs are bounded (spawn, collect, done). The poll loop model assumes the task runs indefinitely; PDPP's START/DONE lifecycle assumes the run terminates. This is a strength, not a weakness: PDPP's bounded-run model is better suited to its consent and audit requirements.

### 9. Airbyte Protocol: PDPP's Direct Ancestor

The Airbyte protocol is the closest direct ancestor of PDPP's Collection Profile. Both use:

- A bounded-run model: `read(Config, Catalog, State) -> Stream<Record | State>`
- RECORD and STATE messages over stdout
- State checkpointing for incremental sync
- A `discover()` equivalent (PDPP's manifest)
- A `check()` equivalent (PDPP's binding matching)

Key Airbyte protocol details:

- **Message envelope:** All messages are wrapped in `AirbyteMessage` with a `type` discriminator. Message types include RECORD, STATE, LOG, SPEC, CONNECTION_STATUS, CATALOG, and TRACE.
- **State modes:** Per-stream state (each stream has independent state), global state (shared cursor, e.g., CDC), and legacy (opaque blob).
- **Incremental vs full refresh:** Incremental uses cursor fields to track changes; full refresh re-reads everything.
- **No push support:** The protocol documentation contains no mention of push-based or webhook sources. Airbyte is exclusively pull-based.

When Airbyte users need to ingest webhook/push data, they use external workarounds: receiving webhooks into S3 or a database, then using an Airbyte source connector to read from that intermediate store. The protocol itself has no push path.

**What PDPP can learn:** Airbyte's success with a pull-only protocol validates PDPP's current approach. The bounded-run model with RECORD/STATE messages is proven at scale (Airbyte 2.0 shipped October 2025 with major performance improvements). Airbyte's limitations -- no push support, underspecified configuration (inherited from Singer), no interactive authentication -- are precisely the areas where PDPP has already innovated (binding matching, INTERACTION messages, scope enforcement).

**Where PDPP has already gone beyond Airbyte:** PDPP's Collection Profile adds several features absent from Airbyte: interactive authentication (INTERACTION/INTERACTION_RESPONSE), explicit scope enforcement (connectors MUST NOT emit records outside scope), binding matching (runtime verifies capability before spawning), and the SKIP_RESULT message for intentional omissions. These additions are all consistent with the bounded-run model and strengthen it.

### 10. Debezium: Unifying Snapshot and Streaming

Debezium is the most instructive example of unifying pull and push within a single connector, because it faces a version of the same problem: capturing both historical data (pull) and ongoing changes (push from the database's write-ahead log).

Debezium's unified model:

- **Snapshot phase:** On first startup, the connector performs an initial snapshot by reading all rows from enabled tables. This is pull-based, bounded (it completes), and produces a consistent point-in-time view.
- **Streaming phase:** After snapshot completion, the connector switches to reading the database's transaction log (WAL/binlog). This is push-based (the database pushes log entries) and continuous.
- **Transition:** The connector records snapshot completion in its offsets. On restart, it checks offsets to determine whether to re-snapshot or resume streaming.
- **Incremental snapshots:** Since Debezium 1.6+, you can trigger ad-hoc snapshots of individual tables while streaming continues in parallel, using a signaling table mechanism.

The offset management unifies both modes: the same offset store tracks snapshot progress and streaming position. The same output format (change events with before/after values) is produced by both phases.

**What PDPP can learn:** Debezium's snapshot-then-stream model is a useful pattern for PDPP's "proactive archival then incremental sync" flow. The initial collection run (full_refresh) is analogous to the snapshot phase. Subsequent incremental runs are analogous to streaming (though PDPP's are bounded runs rather than continuous streams). Debezium shows that unifying the output format while keeping the phases distinct is the right level of abstraction.

**Where the analogy breaks down:** Debezium connectors operate against databases the operator controls, with direct access to the transaction log. The "push" in Debezium is the database's WAL, which is a cooperative, structured stream. PDPP's "push" sources (if platforms cooperate) would be webhook callbacks or subscription events -- a fundamentally different trust model. And Debezium connectors are long-running daemons, not bounded processes.

### 11. Apache NiFi: The Universal Dataflow Platform

NiFi is the most broadly scoped system in this analysis. Its FlowFile abstraction and processor graph can handle virtually any data movement pattern: batch file import, real-time event streaming, database polling, network listeners, API calls, message queue consumers.

The core model:

- **FlowFiles** are the unit of data: content + key-value attributes.
- **Processors** operate on FlowFiles: creating, transforming, routing, splitting, merging.
- **Connections** are queues between processors, with configurable backpressure and prioritization.
- **Process Groups** provide composition and abstraction.
- **FlowFile Repository** is a write-ahead log that ensures durability and atomicity.

NiFi's strength is its generality. Its weakness for PDPP's purposes is the same: it is a general-purpose dataflow platform, not a protocol specification. NiFi defines an execution environment, not a wire format or a conformance test. A PDPP collection profile that looked like NiFi would be a runtime specification, not a protocol specification.

**What PDPP can learn:** NiFi's write-ahead log for FlowFile durability is relevant to PDPP's "STATE is persisted only after records are durably written" requirement. The processor model's connection queues with backpressure are relevant if PDPP ever needs to handle high-throughput push sources. But these are implementation patterns, not protocol design patterns.

**Where the analogy breaks down:** NiFi is an execution platform. PDPP is a protocol specification. NiFi tells you how to build a dataflow; PDPP tells you what messages a conformant connector must emit. They operate at different levels of abstraction.

### 12. Fluentd/Fluent Bit and Vector: Log Collection Pipelines

These systems share a common architecture: sources (input) -> transforms/filters -> sinks (output), with all data represented as structured events.

- **Fluentd** treats all data as events with tags and timestamps. Input plugins cover file tailing, syslog, HTTP, database polling. The plugin ecosystem is large (500+ gems). It supports both push and pull models for data transfer.
- **Fluent Bit** is the lightweight C-based counterpart, with ~80 built-in plugins covering tail, syslog, TCP, systemd, MQTT, OpenTelemetry. Deployed as a DaemonSet in Kubernetes for container log collection.
- **Vector** (maintained by Datadog) uses a sources/transforms/sinks DAG model with YAML/TOML/JSON configuration. Sources "define where Vector should pull data from, or how it should receive data pushed to it." The pipeline is a directed acyclic graph with backpressure propagation.

All three run as continuous daemons. Their "unified" model means different input plugins produce the same internal event representation, which processors and sinks consume uniformly.

**What PDPP can learn:** The event-as-internal-representation pattern is sound and PDPP already follows it (RECORD messages). The common pattern of forwarder/aggregator (edge collection + centralized processing) could inform PDPP's architecture if connectors ever run on edge devices.

**Where the analogy breaks down:** These are log/event collection pipelines for infrastructure monitoring. They assume continuous operation, high throughput, and a cooperative relationship with the systems being monitored. PDPP collects personal data from non-cooperating platforms, in bounded runs, with consent enforcement. The operational model is fundamentally different.

---

## Strongest Arguments for Split Profiles

1. **Different lifecycle models require different specifications.** A bounded-run connector (spawn, START, RECORD, DONE) and a webhook receiver (register callback, receive events indefinitely) have fundamentally different lifecycle semantics. Trying to express both in one spec creates a "lowest common denominator" abstraction that serves neither well. The OAuth 2.0 ecosystem proves this: device flow and CIBA have different specs because they have different lifecycles, even though they both produce tokens.

2. **Different trust models require different conformance requirements.** A pull-based connector that drives a browser to scrape a platform has different trust properties than a push endpoint that receives webhook events from a cooperating platform. The former needs binding matching, interactive authentication, and scope enforcement. The latter needs endpoint authentication, event validation, and replay protection. Specifying both in one profile either overspecifies the simple case or underspecifies the complex case.

3. **The IETF SET precedent works.** Three separate RFCs for token format, push delivery, and poll delivery have been successfully adopted. The OpenID SSF built on this foundation. The modular approach allows implementers to adopt only what they need.

4. **Split profiles can share message format.** The strongest argument for unification -- that all modes should produce the same records -- is achievable without unifying the profiles. PDPP's RECORD/STATE/DONE messages can be the shared format (like SET tokens are the shared format across RFC 8935/8936), while the profiles define different delivery mechanisms and lifecycle models.

5. **Simpler conformance testing.** A conformant pull connector and a conformant push receiver have different test suites. Splitting profiles makes conformance testing clearer: you test against the profile you implement.

---

## Strongest Arguments for Unified Adapter Model

1. **One message format, one state model, one resource server interface.** The resource server doesn't care how data arrived. Whether a RECORD came from a child-process connector or a webhook callback, the RS processes it the same way. A unified protocol could enforce this consistency at the spec level rather than relying on profile alignment.

2. **OpenTelemetry proves unification works.** The OTel Collector's receiver interface genuinely abstracts over push and pull. Downstream components are agnostic to the data source. The same pipeline processes scraped Prometheus metrics and pushed OTLP traces.

3. **Debezium proves snapshot+streaming unification works.** The same connector handles both bounded pulls (snapshot) and continuous pushes (WAL streaming), with unified offset management and output format. PDPP could similarly define a connector that handles both bounded collection and continuous subscription.

4. **Fewer specs means less fragmentation.** Every new profile is a spec that must be maintained, versioned, and kept consistent with the core protocol. If PDPP eventually needs pull, push, subscription, batch-import, and streaming profiles, that's five specs that must all agree on message format, state semantics, and scope enforcement.

5. **Connector authors already handle multiple modes.** A Spotify connector might call an API (pull) and also receive webhook events (push). Forcing connector authors to implement two different profiles for the same platform creates duplication. A unified model lets one connector implementation handle both.

---

## Which Examples Are Most Relevant to PDPP

### Highest Relevance

**Airbyte Protocol:** PDPP's direct ancestor. The bounded-run, pull-based model with RECORD/STATE messages is proven. Airbyte's limitations (no push, no interactive auth, no scope enforcement) are exactly where PDPP has innovated. PDPP should study Airbyte's state management (per-stream vs global vs legacy) and its lack of push support as a deliberate design choice, not a gap.

**Kafka Connect:** The closest architectural analog. The poll()-based source connector model with framework-managed offsets validates the "runtime controls lifecycle, connector controls collection logic" separation. Kafka Connect's explicit decision that source connectors are poll-only, with push sources adapted via intermediate stores, is strong precedent for PDPP's approach.

**OAuth 2.0 ecosystem:** The strongest precedent for modular specifications. PDPP already follows this pattern for grant types. Extending it to collection profiles is natural and well-understood.

**IETF SET / OpenID SSF:** The cleanest model for splitting message format from delivery mechanism. PDPP's RECORD/STATE messages are the equivalent of SETs; different collection profiles are the equivalent of different delivery methods.

### Medium Relevance

**Debezium:** Instructive for how to handle the "initial snapshot then incremental" pattern within one connector. Less relevant because Debezium operates against cooperative databases, not adversarial platforms.

**WebSub:** Instructive as the model for "push as overlay on polling." If platforms cooperate, PDPP could adopt a WebSub-like pattern where push notifications supplement (but don't replace) pull-based collection.

**SCIM:** Instructive for the provisioning/eventing split, which maps to PDPP's collection/notification split.

### Lower Relevance

**OpenTelemetry Collector, Apache NiFi, Fluentd/Vector:** These are execution platforms, not protocol specifications. Their pipeline models are useful implementation patterns but operate at a different level of abstraction from what PDPP specifies. The "just treat it as another receiver" framing from OTel collapses trust distinctions that PDPP must preserve.

**ActivityPub:** Federated social networking is structurally different from personal data collection. The C2S/S2S split is conceptually interesting but not directly applicable.

---

## Where Analogy Breaks Down

The deepest analogy gap across all these systems is the **trust and control boundary**:

- OTel collects telemetry from systems you operate or have instrumented.
- Kafka Connect extracts data from systems you have API access to.
- Debezium reads transaction logs from databases you administer.
- NiFi processes data from systems you have configured to send it.

PDPP collects personal data from platforms the user does not control, often via browser automation against platforms that do not cooperate. This means:

1. **Interactive authentication is a first-class concern**, not an edge case. PDPP's INTERACTION/INTERACTION_RESPONSE messages have no analog in any of these systems.
2. **Scope enforcement is a consent obligation**, not an optimization. PDPP connectors MUST NOT emit records outside scope. This is a normative requirement tied to user consent, not a "nice to have."
3. **The bounded-run model has audit advantages.** A discrete run with START/DONE produces a clear audit trail: this run, authorized by this grant, collected these records. A continuous receiver produces a stream with less clear boundaries for consent enforcement.
4. **Failure semantics are different.** When an OTel receiver fails, you lose some telemetry. When a PDPP connector fails, you may have partially collected personal data that needs to be handled according to the grant's terms. The DONE message with explicit status (succeeded/failed/cancelled) and the "STATE is only persisted on success" rule are consent-layer requirements, not just engineering convenience.

---

## Final Recommendation for PDPP

**Keep the bounded-run Collection Profile as the primary primitive. Add thin sibling profiles for push delivery and batch import. Share the message format and state semantics across all profiles.**

Specifically:

1. **The existing Collection Profile (child-process, stdin/stdout JSONL, START/RECORD/STATE/DONE)** remains the primary and most-specified profile. It handles the dominant use case (pulling data from platforms via API or browser automation) and has the strongest audit, consent, and lifecycle properties.

2. **A Push Delivery Profile** should be defined as a thin spec that describes how a cooperating platform (or an intermediary) delivers records to the resource server via HTTP callbacks. It shares RECORD format and state semantics with the Collection Profile. It does not need START/DONE (events arrive continuously) but does need authentication, replay protection, and scope validation. This is the WebSub/SSF pattern: push as an overlay on the existing model.

3. **A Batch Import Profile** should be defined as a thin spec for importing pre-collected data files (CSV, JSON, platform export archives). It shares RECORD format but has simpler lifecycle (validate, import, done). This handles the "I already have my data export from Instagram" case.

4. **RECORD, STATE, and scope semantics are the shared layer.** All profiles produce RECORD messages with the same schema. All profiles use the same state/checkpoint model. All profiles are subject to the same scope enforcement rules. This is the "shared message format, different delivery" pattern from IETF SET.

5. **Do not build a unified receiver/adapter framework.** The OTel Collector model is elegant but assumes controlled systems and continuous operation. PDPP's value is in the bounded-run model's auditability and consent alignment. A unified framework would either compromise those properties or end up with so many conditional paths that it's a unified framework in name only.

The strongest argument against this recommendation is the connector-author burden: a Spotify connector might need to implement both the pull Collection Profile (for browser-based collection) and respond to the Push Delivery Profile (for Spotify's hypothetical webhook API). The mitigation is to keep the shared layer (RECORD format, state semantics, scope rules) large enough that the profile-specific code is thin.

---

## Sources

### Standards and Specifications
- [RFC 8417 - Security Event Token (SET)](https://datatracker.ietf.org/doc/rfc8417/)
- [RFC 8935 - Push-Based SET Delivery Using HTTP](https://datatracker.ietf.org/doc/html/rfc8935)
- [RFC 8936 - Poll-Based SET Delivery Using HTTP](https://datatracker.ietf.org/doc/html/rfc8936)
- [OpenID Shared Signals Framework 1.0](https://openid.net/specs/openid-sharedsignals-framework-1_0-final.html)
- [OpenID CAEP 1.0](https://openid.net/specs/openid-caep-1_0-final.html)
- [RFC 7644 - SCIM Protocol](https://datatracker.ietf.org/doc/html/rfc7644)
- [RFC 7642 - SCIM Definitions, Overview, Concepts](https://www.rfc-editor.org/rfc/rfc7642.html)
- [W3C ActivityPub](https://www.w3.org/TR/activitypub/)
- [W3C WebSub](https://www.w3.org/TR/websub/)
- [RFC 6749 - OAuth 2.0 Authorization Framework](https://datatracker.ietf.org/doc/html/rfc6749)
- [Map of OAuth 2.0 Specs](https://www.oauth.com/oauth2-servers/map-oauth-2-0-specs/)
- [OpenID CIBA Core 1.0](https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html)

### System Documentation
- [OpenTelemetry Collector Architecture](https://opentelemetry.io/docs/collector/architecture/)
- [OpenTelemetry Collector Components](https://opentelemetry.io/docs/collector/components/)
- [OpenTelemetry Build a Receiver](https://opentelemetry.io/docs/collector/building/receiver/)
- [OpenTelemetry Scraping Receivers](https://github.com/open-telemetry/opentelemetry-collector/blob/main/docs/scraping-receivers.md)
- [Kafka Connect Connector Development Guide](https://kafka.apache.org/41/kafka-connect/connector-development-guide/)
- [Kafka Connect Architecture (Confluent)](https://docs.confluent.io/platform/current/connect/design.html)
- [Airbyte Protocol](https://docs.airbyte.com/understanding-airbyte/airbyte-protocol)
- [Airbyte Connector Specification Reference](https://docs.airbyte.com/platform/connector-development/connector-specification-reference)
- [Debezium Features](https://debezium.io/documentation/reference/stable/features.html)
- [Debezium Incremental Snapshots](https://debezium.io/blog/2021/10/07/incremental-snapshots/)
- [Apache NiFi Overview](https://nifi.apache.org/docs/nifi-docs/html/overview.html)
- [Apache NiFi User Guide](https://nifi.apache.org/docs/nifi-docs/html/user-guide.html)
- [Vector Pipeline Model](https://vector.dev/docs/architecture/pipeline-model/)
- [Vector Concepts](https://vector.dev/docs/introduction/concepts/)
- [Fluentd Architecture](https://platformengineeringplaybook.com/technical/fluentd/)
- [Fluent Bit](https://fluentbit.io/)
- [Fivetran Connector SDK](https://fivetran.com/docs/connector-sdk)
- [Fivetran Webhooks](https://fivetran.com/docs/connectors/events/webhooks)

### Singer Protocol
- [Singer Specification](https://github.com/singer-io/getting-started/blob/master/docs/SPEC.md)
- [Singer Spec (Meltano)](https://hub.meltano.com/singer/spec/)
- [Why Not Build on Singer (Airbyte)](https://airbyte.com/blog/why-you-should-not-build-your-data-pipeline-on-top-of-singer)

### Community and Analysis
- [CNCF: Logstash, Fluentd, Fluent Bit, or Vector](https://www.cncf.io/blog/2022/02/10/logstash-fluentd-fluent-bit-or-vector-how-to-choose-the-right-open-source-log-collector/)
- [Shared Signals Guide](https://sharedsignals.guide/)
- [WebSub Deep Dive (Ably)](https://ably.com/topic/websub)
- [Kafka Connect Source vs Sink (AutoMQ)](https://www.automq.com/blog/kafka-connect-source-vs-sink-connectors)
