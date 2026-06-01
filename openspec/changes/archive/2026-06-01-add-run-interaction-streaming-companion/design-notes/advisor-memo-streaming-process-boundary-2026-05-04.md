# Memo to Architecture Advisor — Streaming Companion Process-Boundary Question

**From**: Implementation agent, working with the owner.
**Date**: 2026-05-04.
**You**: External architecture/design reviewer for PDPP. You guide the
protocol; you have not been working on the reference implementation.
This memo brings you up to the level of context you need to weigh in
on a specific reference-side question.
**Reading time**: ~10 minutes.
**What I want from you**: a position on the architectural question at
the bottom (§5), and any boundary corrections in §3 if I have drifted.

---

## 0. TL;DR

PDPP's reference implementation has a working "browser streaming
companion" for `manual_action` interactions — operator-side machinery
that lets the human satisfy a connector run that needs them to click,
type, or solve a captcha in a real browser. The current implementation
streams an externally launched Chrome via env-var-configured CDP. We
want it to stream the *connector's actual running patchright browser*
instead, so the operator sees what the bot sees. We discovered this
afternoon that the connector runtime and the reference server **are
separate processes** in every supported deployment mode. The patchright
`CDPSession` cannot be shared in memory across the boundary. Three
options remain (§5). I want your read on which is least likely to drift
the reference into bad shape, and whether any of this leaks into spec
territory I shouldn't be touching.

---

## 1. What you need to know about the reference implementation

You've been guiding PDPP Core (consent, grants, enforcement) and
Collection Profile (bounded-run connector mechanism) without engaging
the reference implementation. Quick orientation so you can pressure-
test the question:

- **Where it lives**: `reference-implementation/` (the AS/RS/runtime
  Node.js process) plus `packages/polyfill-connectors/` (the
  connector runtime that spawns connectors as child processes and
  handles browser-based "polyfill" connectors).
- **Recent architectural moves**: the host-browser bridge is retired
  (`openspec/changes/retire-browser-daemon`). A "local collector
  runner" was introduced (`openspec/changes/introduce-local-collector-
  runner`) that lets browser-backed connectors run in a host-side
  collector process, separate from a control-plane runtime that
  cannot host a visible browser.
- **In-container fail-closed gate**: `acquireBrowserForConnector`
  refuses to launch a *headed* browser inside a container, because a
  headed Chromium in a container is invisible to the operator and the
  interaction blocks indefinitely. Headless-in-container is allowed.
- **Streaming companion**: a recently merged tranche
  (`openspec/changes/add-run-interaction-streaming-companion`) added
  reference-only machinery for owner-authorized browser streaming,
  intended to satisfy `manual_action` interactions. Today it streams
  a Chrome that the operator launches separately
  (`PDPP_RUN_INTERACTION_CDP_WS_URL` or
  `PDPP_RUN_INTERACTION_CDP_HTTP_URL`). It does *not* yet stream the
  patchright browser the connector itself is using.

The streaming tranche's design notes are already explicit that the
target-binding shape (e.g. whether streaming should resolve a target
through a `browser_session_id` managed by a Collection-Profile-aware
control-plane registry) is an open question for spec owners, and they
deliberately did not pre-commit to a binding shape.

## 2. What we want to do in this tranche

Make the streaming companion stream the connector's actual running
patchright browser, so the operator can satisfy a manual-action
interaction (anti-bot challenge, OTP, login confirm, captcha) by
seeing exactly what the connector sees and providing input back. The
operator is notified via ntfy with a link; clicking it opens the
stream on phone or laptop.

**Stated non-goals for this tranche**:
- No spec proposals or new protocol concepts.
- No new manifest fields, capability vocabulary, or token scopes.
- No commitment to the eventual binding shape for "streaming target
  per browser session." Today's optimistic reference behavior labels
  this as deferred.
- No reference-page integration of the streaming surface (the
  reference page already has its own SLVP work; streaming integration
  there is a later question).

The tranche is about *operator ergonomics* for an existing protocol
concept (`INTERACTION kind=manual_action`). It is not introducing or
modifying any wire-level PDPP surface.

## 3. The architectural assumption we believe we have

Spelling this out so you can correct us if we have drifted past where
the protocol leaves room for reference choices:

1. PDPP Core defines `INTERACTION` as a protocol concept and names
   kinds like `credentials` and `manual_action`. The *fulfillment
   mechanism* for a `manual_action` (ntfy + browser stream, email +
   screen-share link, phone call, in-person) is a deployment choice,
   not a wire-level guarantee.
2. Therefore the reference is free to add a CDP-based browser-stream
   fulfillment mechanism without that becoming a spec surface.
3. Therefore importing browser-automation libraries (patchright,
   Playwright) into the streaming companion code does not blur the
   protocol/implementation line, because streaming is not a protocol
   surface. (We would not import patchright into AS/RS code that
   produces grants or enforces field projection; that *is* protocol
   surface.)

If any of (1)-(3) is wrong from where you sit, please correct us
before we build further on it. The question in §5 is downstream of
these assumptions.

## 4. The new constraint we discovered today

We were planning to share patchright's `CDPSession` directly between
the connector runtime and the streaming companion via an in-process
`Map<runId, CDPSession>`. We then verified the architecture and found
that **the connector runtime and the reference server are separate
Node.js processes in every supported deployment mode**:

- The reference runtime spawns each connector as a child process via
  `spawn()` (`reference-implementation/runtime/index.js:7`,
  `runtime/controller.ts:887-901`).
- The local collector runner similarly spawns connectors as child
  processes (`packages/polyfill-connectors/bin/collector-runner.ts:236`).
- They communicate over HTTP (the connector posts records, run
  events, and interaction events to the reference server via HTTP
  ingest routes).
- The `runId` identifier is the same on both sides (camelCase on the
  connector side, snake_case at API boundaries — same value).

Implication: a JavaScript `CDPSession` object cannot be shared between
the two processes. Whatever crosses the boundary must be serializable
or be a network endpoint.

## 5. Three options, and the question for you

We need to pick one before continuing. All three keep streaming as
operator ergonomics rather than protocol surface; they differ in how
the patchright browser becomes reachable from the streaming-companion
process.

### Option A — Cross-process via a CDP WebSocket URL

Connector runtime, when launching patchright for a connector that may
need streaming, asks for a page-target CDP WebSocket URL (Playwright
exposes one via the underlying browser's `wsEndpoint()` or by
launching with `--remote-debugging-port=0` bound to `127.0.0.1` and
querying the DevTools `/json` endpoint for the page target). It posts
that URL plus `runId` to a registration endpoint on the reference
server. The streaming companion, when minting a session for that
`runId`, looks up the URL and connects a separate CDP client to it
(reuses today's `cdp-adapter.js` JSON-RPC machinery, which exists
specifically for this case).

**Pros**:
- No process-architecture change.
- Reference server stays library-free for streaming (today's
  `cdp-adapter.js` is justified by the process boundary, not deleted).
- Two CDP clients on the same page target — spike-validated as
  stealth-safe so long as the streaming client only sends Page +
  Input + Emulation methods (sannysoft byte-identical with vs without
  the streaming session attached, including during input dispatch).

**Cons**:
- Binds a debug port. Loopback-only mitigates exposure but it's still
  a non-trivial attack surface on the host.
- Requires a small new ingest route on the reference server (e.g.
  `POST /admin/runs/:runId/streaming-target`) with appropriate auth.
- Partial walk-back of an earlier "drop env vars entirely" decision
  — we end up with a per-run lookup instead of a global env var, but
  the *shape* of the resolver is similar.

### Option B — Move streaming companion code into the connector runtime process

The streaming companion (CDP attach, screencast frame relay, input
injection) runs in the same process as the connector runtime, so it
can share patchright's existing `CDPSession` in memory. The reference
server proxies streaming-session HTTP to that process.

**Pros**:
- Single CDP connection to the page (best stealth posture by
  construction).
- No new debug port, no new ingest endpoint.

**Cons**:
- Couples the deployment topology: provider/control-plane runtimes
  that don't host a connector runtime can't stream. Currently the
  collector-runner is the place that hosts the connector runtime;
  this would push streaming into the collector-runner's surface.
- Adds an HTTP-proxy layer through the reference server.
- Larger surgery on existing streaming code (today it lives entirely
  in `reference-implementation/server/streaming/`).

### Option C — Run the connector runtime in the same process as the reference server for this deployment mode

The reference server hosts the connector runtime in-process, eliminating
the boundary entirely.

**Pros**:
- Architecturally simplest from the streaming companion's POV.

**Cons**:
- Largest blast radius. Reverses the boundary that
  `introduce-local-collector-runner` deliberately established.
- Likely lands in spec territory (collector lifecycle, capability
  advertisement) that you've signaled stays open.
- Doesn't match production topologies where a control-plane runtime
  is intentionally separate from collector runtimes.

### Our current lean

Option A. It is the only one that doesn't fight the
already-established process boundary, and the spike-validated stealth
posture (Page + Input + Emulation only, enforced by source-grep lint)
is preserved. The cost — a debug port bound to loopback and a small
registration endpoint — feels like the right kind of incidental
complexity for an operator-ergonomics surface.

But we want to check this with you before committing because:

1. **Boundary check**: does posting a WebSocket URL from the
   connector runtime to the reference server cross any line you'd
   call protocol surface? Today's connector→server traffic is records,
   blobs, run events, and interaction events; "here is a CDP target
   for run X" is a different shape. We don't *think* it's protocol
   (it's reference operator ergonomics), but we'd rather you tell us
   than discover it later.

2. **Capability advertisement**: the existing `runtime_capabilities`
   vocabulary advertises bindings the runtime provides (network,
   browser, ...). Should the act of being able to expose a CDP target
   for streaming be advertised, or is that exactly the kind of
   thing you want to leave open until Collection Profile alignment?
   Our current plan is to *not* add a `cdp_streaming` capability in
   this tranche, on the grounds that doing so would freeze a
   vocabulary you have not yet ratified.

3. **Anything we should be doing instead**: are we missing a fourth
   option that respects the process boundary better?

## 6. What we explicitly do not want from you

- A spec-level decision on streaming-target binding. We will not
  encode any binding into the spec in this tranche; we want to keep
  that question fully open for you.
- Approval to add new manifest fields or capability terms; we are
  not asking for them.
- A reference-page treatment for streaming. Out of scope for this
  tranche.

## 7. Files and locations for your reference

- Streaming tranche: `openspec/changes/add-run-interaction-streaming-companion/{proposal,design,tasks}.md`
- Implementation decisions for this work session:
  `openspec/changes/add-run-interaction-streaming-companion/design-notes/implementation-decisions-2026-05-04.md`
- Reference server streaming code:
  `reference-implementation/server/streaming/{cdp-adapter,cdp-companion,routes,sessions}.js`
- Connector runtime browser launch:
  `packages/polyfill-connectors/src/{browser-launch,connector-runtime}.ts`
- Local collector runner:
  `packages/polyfill-connectors/bin/collector-runner.ts`,
  `openspec/changes/introduce-local-collector-runner/{proposal,design}.md`
- Stealth spike (this afternoon):
  `tmp/spikes/patchright-streaming-spike/` (sannysoft byte-identical
  result with vs without screencast attached; bit-identical md5s
  recorded)

Your move.
