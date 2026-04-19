# Open question: cross-connector identity graph

**Status:** open
**Raised:** 2026-04-19
**Trigger:** Layer 2 audits found every connector has identity/social data, but each expresses it in connector-native terms — no cross-connector queryability. This may be the most ambitious proposal in the open-question set; flagging it now so we can decide whether to scope it in or consciously defer.

## The shape of the data we have

Layer 2 coverage audits (see `layer-2-coverage-gmail-ynab-usaa-github.md`, `layer-2-coverage-chatgpt-claude-codex.md`) surfaced identity/social data in every connector inspected:

- **GitHub** — followers, following, organization members, collaborators
- **Gmail** — contacts (implicit from message headers: From/To/Cc)
- **Slack** — workspace users, channel memberships, DM relationships
- **USAA** — joint account holders
- **Notion** — workspace members, shared page permissions
- **Instagram (meta)** — followers, following, blocked users
- **ChatGPT** — shared conversation recipients (if they accepted)

Today each connector declares its own `users` / `members` / `contacts` stream in manifest-native terms. A consumer asking "who do I interact with across all my data" must write cross-connector joins and dedup heuristics themselves.

## Use cases this would unlock

- "Show me everyone I've interacted with in the last 30 days across Gmail, Slack, and GitHub"
- "Reconcile this email thread with this Slack conversation with this GitHub mention — same humans?"
- "Deduplicate Jane Smith (`jsmith@co.com`) with Jane Smith (Slack `U123`) with Jane Smith (GitHub `@janey`)"
- "Find the common contacts between two people for warm-intro matching"

This is plausibly the highest-value query surface PDPP enables that no single connector can deliver alone: unified relationship intelligence derived from the user's data exhaust.

## What a primitive might look like

### A. Manifest convention: every identity-bearing connector declares a `contacts` stream with normalized fields
Connectors with identity data emit an `identity` / `contacts` stream with a shared field set: `id`, `display_name`, `email`, `handle`, `source_connector`, `source_id`, plus `relationship_type` (`member`, `follower`, `contact`, etc.). Consumers run dedup on email + handle heuristics. Spec effort is small; intelligence stays consumer-side.

### B. A cross-connector index maintained by the RS
The RS computes an `identity_graph` virtual stream from all declared `contacts`-style streams. Consumer queries it once; RS does dedup and returns unified entities with per-source provenance.

### C. A new top-level concept: "entity streams"
Beyond "streams within a connector," the spec allows cross-connector entity streams with their own identity-resolution rules, consent semantics, and query API. Most invasive; most powerful.

### D. Punt — keep identity local per connector
Document the pattern, let consumers build the graph if they need it. No spec change.

## Technical complications

- **Identity resolution is hard.** Same person can be `the owner@vana.com`, `the owner.nunamaker@gmail.com`, `owner` on GitHub, `U04BB6JH7EU` on Slack. No canonical cross-internet handle exists (ATProto DIDs, Keybase proofs are promising but not universal).
- **Consent surface grows.** "This grant includes identity-graph access" has to be expressible separately from per-connector consent — the graph can reveal things individual streams don't (meta-information attack surface).
- **Privacy asymmetry.** The people in your graph didn't consent to being aggregated across your connectors. A `contacts` stream already has this property; a cross-connector graph amplifies it.
- **Failure modes of dedup.** False merges ("two Jane Smiths become one") are worse than false splits in most use cases, but the spec would have to take a position on precision-vs-recall defaults.

## Connection to existing open questions

- `layer-2-completeness-open-question.md` — identity data is systematically undercovered in today's manifests; if Layer 2 forces us to declare coverage, identity is where the gap is largest.
- Authored-artifacts-vs-activity split — most identity data is activity-side (headers, memberships), but "custom nicknames" or "VIP markings" are authored and should ride with the owner.
- `slackdump-design-gaps.md` Gap 7 (multi-instance providers) — the same person's Gmail account appearing in two workspaces is already a dedup problem at the connector level; identity graph generalizes it.

## Action items
- [ ] Decide whether identity is a spec concern or purely a consumer concern.
- [ ] If spec concern: pick A / B / C.
- [ ] If chosen, define the normalized identity field set and its consent semantics.
- [ ] Revisit after Layer 2 audits complete — coverage variance may force our hand.
