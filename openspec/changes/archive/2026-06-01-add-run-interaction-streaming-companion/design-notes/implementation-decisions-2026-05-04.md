# Streaming-Companion Implementation Decisions

Captures decisions made during the patchright-streaming integration work
that may be useful context for future spec-owner review or rework. Nothing
here is a spec proposal; all framed as reference implementation choices
made under the constraints of the current spec.

## 2026-05-04 — Streaming is operator ergonomics, not protocol surface

**Decision**: The reference server's streaming companion may freely import
browser-automation libraries (patchright, Playwright). The "no automation
library in the reference server" value applies to AS/RS protocol-handling
code, not to operator companions for `INTERACTION` fulfillment.

**Reasoning**:
- PDPP-the-protocol is HTTP/JSON. AS/RS code that produces or enforces
  those wire-level artifacts is "speaking the protocol" and should look
  like HTTP/JSON code, so a reader does not mistake an implementation
  detail for a normative protocol surface.
- `INTERACTION` and its kinds (`credentials`, `manual_action`, ...) are
  protocol concepts. The *fulfillment mechanism* for a `manual_action`
  interaction (ntfy + browser stream, email + screen-share link, phone
  call, in-person assist, ...) is a deployment choice, not a wire-level
  guarantee.
- Therefore `import { chromium } from 'patchright'` inside the streaming
  companion does not mislead a spec reader: it reads as implementation
  of an operator-side concern, not as protocol normativity.

**Open question for spec owners** (not pre-judged here): if streaming
ever becomes a normative interaction-fulfillment mechanism in the
Collection Profile or a future profile, the question of "what shape of
streaming target the reference is required to expose" reopens. Today the
spec is silent on this and the reference is free to pick. This decision
does not pre-commit to any answer.

**Consequence in this tranche** (revised after process-boundary
discovery, see next section):
- The connector runtime and reference server are separate processes
  (verified 2026-05-04). Patchright's `CDPSession` cannot be shared
  in memory across the boundary.
- Patchright is *not* imported into the reference server. It stays
  in the connector runtime where it already lives. What crosses the
  process boundary is a CDP page-target WebSocket URL — a
  serializable handle, not a session object.
- `cdp-adapter.js` (raw JSON-RPC over WebSocket) is therefore *kept*,
  not retired. Its existence is justified by the process boundary:
  the reference server speaks CDP directly to the patchright-launched
  page over a separate WS connection.
- The `PDPP_RUN_INTERACTION_CDP_WS_URL` and
  `PDPP_RUN_INTERACTION_CDP_HTTP_URL` env-var paths are dropped in
  favor of per-run lookup via a new admin/reference-internal
  registration endpoint.

## 2026-05-04 — Cross-process streaming via run-scoped CDP target registration (Option A)

**Decision** (advisor-confirmed): the connector runtime, when launching
patchright for a connector that may need streaming, asks Playwright for
the page target's CDP WebSocket URL and posts
`{ runId, wsUrl, expiry, ... }` to a new admin/reference-internal
endpoint on the reference server (e.g.
`POST /admin/runs/:runId/streaming-target`). The streaming companion
factory's resolver looks up the URL by `runId`; the existing
`cdp-adapter.js` JSON-RPC machinery is the streaming CDP client.

This is a **reference-internal run target registration**, not a PDPP
wire surface. It is admin-scoped and does not affect interoperability
between independently built PDPP implementations.

**Why this shape**:
- Respects the process boundary established by
  `introduce-local-collector-runner`. Reversing the boundary
  (Option C) or moving streaming code into the connector runtime
  process (Option B) would couple streaming to deployment topology.
- Two CDP clients on the same page target (patchright + streaming
  companion) is spike-validated as stealth-safe when the streaming
  client is restricted to Page + Input + Emulation methods (see
  next section).
- The smallest serializable handle (a wsUrl + run id) is the smallest
  thing the boundary can carry; growing it beyond that would invite
  protocol drift.

**Constraints baked into the implementation**:
- Endpoint is `POST /admin/...`, not near PDPP ingest routes.
- No new manifest fields, runtime capability terms, or Collection
  Profile vocabulary in this tranche.
- Target record is ephemeral and run-scoped: cleared on run
  completion, cancellation, revocation, timeout, and process exit
  where possible.
- The CDP wsUrl is treated as a bearer secret: 127.0.0.1-only bind,
  random port, never logged in full, short TTL, explicit unregister
  on run end, registration rejected unless from the local
  collector/runtime authority.
- The streaming client is restricted to the Page + Input + Emulation
  method allowlist (see next section).

**Open question for spec owners** (not pre-judged here): if Collection
Profile or a future profile chooses to formalize a streaming-target
binding (e.g. `browser_session_id` resolution through a control-plane
registry), this resolver becomes the obvious replacement point. The
ephemeral run-scoped registration deliberately does not become a
durable browser-session registry by accident.

**See also**: `advisor-memo-streaming-process-boundary-2026-05-04.md`
and `advisor-response-streaming-process-boundary-2026-05-04.md` for
the full context of this decision.

## 2026-05-04 — Stealth-safety property: Page + Input + Emulation only

**Decision**: the streaming companion may only send CDP methods in the
domains `Page`, `Input`, and `Emulation`. A source-grep test enforces
this at lint time.

**Reasoning**:
- Spike (2026-05-04) showed that attaching a CDPSession that issues
  `Page.startScreencast`, `Input.dispatch{Mouse,Key,Touch}Event`, and
  `Emulation.setDeviceMetricsOverride` to a patchright-launched browser
  produced byte-identical bot-detection output on sannysoft compared
  to a patchright run with no streaming session attached, including
  during active input dispatch. md5 hashes match.
- Patchright's stealth value depends on avoiding `Runtime.enable`. The
  `Page` domain is independent of `Runtime`. Restricting the streaming
  companion to Page + Input + Emulation preserves patchright's stealth
  property by construction.
- A source-grep test that asserts the set of CDP method literals in
  the streaming companion is a subset of the allowlist makes this
  property checkable in PR review, not just by code-reading discipline.

**Caveat**: the spike only tested sannysoft. bot.rebrowser.net was
unreachable from the spike network. Sannysoft is the weaker check.
A follow-up against a real Cloudflare-protected site would be
worthwhile but is not blocking.
