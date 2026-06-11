# Proposal: render-three-class-consent-authorship

## Why

The consent surface advertises a three-class trust model — protocol-enforced
facts, manifest-authored descriptions, and client-authored claims — and the
operator-ui consent card already renders each class distinctly (every element
carries a `data-authorship` provenance hook). But the reference Authorization
Server's **hosted** consent renderer
(`reference-implementation/server/routes/as-consent-ui-helpers.ts`) did not
honor that boundary:

1. It **flattened** `purpose_description` / `purpose_code` (request-scoped,
   client-authored) into the same undifferentiated key/value list as the
   protocol facts (access mode, retention, source binding) and the client
   identity. A reviewer reading the rendered HTML could not tell which lines
   were facts the server enforces and which were the client's own words.
2. It **dropped** per-stream `client_claims` (request-scoped, client-authored
   purpose/commitments) entirely — they were carried through
   `normalizeStreamSelection` but never surfaced by the renderer, so the
   strongest "the client says this" content never reached the owner.

That violated the steering principle "keep protocol facts, manifest-authored
descriptions, and client-authored claims visually and semantically distinct,"
and the trust model the surface visually claims to enforce. Presenting
client-authored content with the same weight as server-enforced facts invites
the owner to over-trust the client.

## What Changes

1. The hosted consent renderer now emits three semantically distinct,
   authorship-labeled blocks, each carrying a machine-readable
   `data-authorship` attribute (`protocol` | `manifest` | `client`) matching the
   operator-ui consent-card contract:
   - **PROTOCOL** — access mode, retention, the source binding, and (for CIMD
     clients) the resolved client-identity origin. Server-enforced/verified.
   - **MANIFEST** — the requested stream names/descriptions, from the resolved
     manifest. Owner-trusted human descriptions.
   - **CLIENT** — the client's self-described app name, its stated purpose, and
     its per-stream `client_claims` (purpose + commitments). Rendered as claims,
     never as facts, with an explicit "not enforced by your server" disclaimer.
2. `client_claims` (previously dropped) is rendered in the CLIENT block.
3. The batch consent renderer applies the same three-class split per source.
4. The entity-scoped client display name and the request-scoped purpose /
   `client_claims` are both presented as CLIENT-authored; the CIMD origin
   identity stays a PROTOCOL fact (consistent with the existing CIMD
   consent-display requirement).
5. No new pill, ledger, route, storage column, grant semantics, or dependency.
   Pure presentation-layer change in the hosted consent HTML.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: the hosted consent UI renders the
  three authorship classes (protocol facts, manifest descriptions, client
  claims) as visually and semantically distinct, machine-labeled blocks, and
  surfaces client-authored `client_claims` as disclaimed claims rather than
  dropping or flattening them.

## Impact

- Affected file: `reference-implementation/server/routes/as-consent-ui-helpers.ts`
  (consent render path), `reference-implementation/server/hosted-ui.js`
  (authorship-class CSS).
- Affected tests: `test/security-consent-authorship-classes.test.js` (new),
  existing consent/hosted-ui suites stay green.
- No REST contract changes, storage changes, grant semantics changes, connector
  changes, or dependency changes.
