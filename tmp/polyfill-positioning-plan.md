# Plan: Scraping-as-Polyfill Positioning (revised)

## The strategic question

PDPP must work both when platforms cooperate and when they don't. This needs to be clear wherever someone might wonder "but how does this work with Instagram?"

## The narrative (two distinct scopes)

**Scope 1: How data reaches the personal server** (spec-core / architecture level)

Data may arrive at a personal server via:
- Connector-driven collection (the Collection Profile)
- Regulatory data exports (DMA, GDPR Art. 20)
- Manual import (user downloads archive, uploads to server)
- Platform-native API access

The consent and enforcement layers (spec-core §5-8) are agnostic to which path was used. A grant doesn't know whether the posts it authorizes were collected via browser automation or a native API. Field projection, incremental sync, and revocation work identically regardless.

**Scope 2: How connectors collect data** (Collection Profile level)

Within the Collection Profile, connectors are child processes that produce RECORD/STATE/DONE messages. The `bindings` field in the manifest declares what the connector needs from the runtime. The standard bindings include `browser_automation` (a WebSocket URL to a browser instance), among others.

Browser automation is the most common binding today because most platforms don't offer structured data portability APIs. As platforms adopt portability standards or offer their own export APIs, connectors will shift to different binding types. The connector protocol stays the same — only the implementation inside the child process changes.

**The polyfill framing**: browser automation connectors are a polyfill for platform non-cooperation. The protocol is designed so the transition from polyfill to native access requires changing only the connector implementation. The consent surface, grants, enforcement, and query API remain identical.

## Key boundary (from advisor review)

- **In core/architecture**: PDPP works with cooperative and non-cooperative collection paths. Data may arrive by any means.
- **In Collection Profile**: define the runtime protocol for connector-driven collection. Present browser automation as one binding-driven implementation path within that profile.
- **Do NOT blur "all ingestion methods" into "connectors."** Manual import and regulatory exports are valid but don't necessarily run through the connector runtime.
- **Do NOT introduce `api_credentials` as a standard binding** unless ready to specify it. The Collection Profile's existing binding types are sufficient. API-based connectors may use connector-specific credentials or runtime-provided secrets without a new standard binding.

## Tone

- Matter-of-fact, not defensive. Browser automation is a legitimate collection method.
- Do not call it "temporary" in spec prose. Strategically yes, but normatively no collection method should sound second-class.
- Do not oversell plug-compatibility. Say "the connector implementation can change without changing the grant, consent, or query model" rather than "single child-process swap."

## Artifacts to update (in priority order)

### 1. Collection Profile — framing paragraph

**Where**: `spec-collection-profile.md`, early in the document

**What**: A paragraph establishing that connectors abstract over the source platform's data access interface. A connector that uses `browser_automation` produces the same RECORD messages as one using other binding types. The runtime treats all connectors identically.

**Draft**:

> Connectors abstract over the source platform's data access interface. The runtime does not know or constrain how a connector obtains data — only that it produces conformant RECORD messages via stdout. A connector that collects data via browser automation and one that calls a platform's export API both use the same START/RECORD/STATE/DONE protocol, the same binding matching, and the same state management.
>
> This abstraction is intentional. Many platforms do not currently offer structured data portability APIs. The `browser_automation` binding enables connectors that drive a browser to collect data from a platform's web UI. As platforms adopt data portability standards or offer their own APIs, connector implementations can change without affecting the consent surface, grant enforcement, or query API.

### 2. spec-core — introduction or standards table

**Where**: spec-core.md, Section 1 or a note near the Collection Profile reference

**What**: One sentence establishing that PDPP's consent and enforcement layers are agnostic to how data reaches the server.

**Draft** (addition to the existing Collection Profile reference):

> The Collection Profile is one fulfillment mechanism. Data may also reach the personal server via regulatory data exports, manual import, or platform-native APIs. The consent and enforcement layers defined in this specification (Sections 5–8) are agnostic to the collection method.

### 3. Reference page — Ingest section (Level 1 + Level 2)

**Level 1 narrative change**:

Current: "Connectors collect your data from Instagram, Spotify, and other platforms and store it on your personal server."

Proposed: "Connectors collect your data from Instagram, Spotify, and other platforms — whether those platforms offer data APIs or not — and store it on your personal server in structured streams."

**Level 2 detail panel addition** (after the runtime message sequence):

> **How connectors access platforms**: The `bindings` field in the manifest declares what the connector needs — for example, `browser_automation` provides a WebSocket URL to a browser instance. Most connectors today use browser automation because most platforms don't offer structured portability APIs. When a platform begins offering native access, only the connector implementation changes. The consent surface, grants, and enforcement stay the same.

### 4. Reference page — Multi section (Level 1)

Current: "Instagram, Spotify, health data, email. Different sources, same consent flow, same enforcement, same controls."

Proposed: "Instagram, Spotify, health data, email. Different sources, different access methods, but the same consent flow, same enforcement, same controls. The protocol works identically regardless of how data was collected."

### 5. Concept inventory updates

**Concept 61** (Connector as child process): Add: "The child process abstraction means the runtime doesn't know whether the connector calls an API or drives a browser. The consent and enforcement layers never see the difference."

**Concept 64** (Binding matching): Add: "`browser_automation` is the most common binding today (polyfill for platform non-cooperation). Binding types are declared in the manifest; the runtime checks them before spawn."

### 6. Experience architecture — section 1 depth

Add to section 1 depth description: "...binding matching (browser_automation as polyfill for platform non-cooperation; consent/enforcement agnostic to collection method)"

## What NOT to do

- Don't collapse manual import, regulatory exports, and connectors into one taxonomy. They're related but architecturally distinct.
- Don't introduce `api_credentials` as a standard binding. Use existing binding vocabulary.
- Don't make the polyfill a separate section in the reference page. It belongs inside Ingest and Multi.
- Don't change any UI component to distinguish "polyfill" from "native" connectors.
- Don't change grant or enforcement behavior based on collection method.
- Don't call browser automation "temporary" in normative spec text.

## Sequencing

1. Spec changes (Collection Profile framing + spec-core note) — foundational
2. Reference page narratives (Ingest L1 + Multi L1) — what people see
3. Reference page detail (Ingest L2 binding explanation) — engineer depth
4. Concept inventory + experience architecture — internal tracking
5. Design page specimens — if we add binding display to ConnectorCard (optional, lower priority)

## Validation

After changes, check:
- Could someone read only the reference page and understand that PDPP works without platform cooperation?
- Could they explain to a CEO why PDPP is useful today?
- Does the spec maintain a clean boundary between "how data arrives" (multiple paths) and "connector runtime protocol" (Collection Profile)?
- Are we honest about what the Collection Profile covers vs. what it doesn't?
