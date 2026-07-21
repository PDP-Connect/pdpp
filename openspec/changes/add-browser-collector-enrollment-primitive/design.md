## Context

PDPP collects personal data from several topologies. Two matter here:

- **Filesystem-backed local collection** (`claude-code`, `codex`): a local
  collector reads files on the owner's device and pushes normalized records
  through the device-exporter enroll/ingest path. The enrolled binding is
  recorded with `source_kind: "local_device"`.
- **Browser-bound collection** (`amazon`, `chase`, `chatgpt`): a connector drives
  a real browser session against a logged-in provider. Today this runs natively
  (headed Patchright on the owner's desktop) or, in Docker, through the host
  browser bridge (`design-host-browser-bridge-for-docker`). It has **no**
  enrollment primitive — there is no way for a trusted owner agent to initiate a
  browser-bound connection and have it materialize through the device-exporter
  path.

The owner-agent control surface (`add-owner-agent-control-surface`) made the gap
visible and honest: `POST /v1/owner/connections/intents` classifies a connector
by its manifest `runtime_requirements.bindings` and returns `unsupported` for any
`browser` binding, with a reason that names this primitive verbatim. The intent
route is wired but dormant for browser-bound connectors precisely because the
enrollment primitive does not exist.

This change designs that primitive. It does **not** implement it (that is the
next lane). The output is the durable boundary: what `browser_collector` is, how
binding-aware enrollment gates it, what proof is required before Amazon flips
from `unsupported`, and what stays out of PDPP Core.

### Grounding facts (verified in tree)

- `reference-implementation/server/routes/ref-device-exporters.ts` enroll handler
  hardcodes `sourceKind: "local_device"` and `sourceBinding.kind: "local_device"`
  (the `createRequestConnectorInstanceStore().upsert(...)` call). The
  enrollment-code handler accepts `connector_id` + `local_binding_name` and does
  not inspect the manifest.
- `reference-implementation/server/routes/owner-connection-intent.ts`
  `classifyConnectorIntentModality` maps a `browser` binding → `browser_bound`,
  and `unsupportedReason("browser_bound")` already names "`a `browser_collector`
  source kind (distinct from `local_device`), binding-aware enrollment gating, and
  committed proof`".
- `packages/polyfill-connectors/manifests/amazon.json` declares
  `runtime_requirements.bindings: { network: { required: true }, browser: { required: true } }`.
  `claude_code.json` / `codex.json` declare `filesystem`.
- `packages/polyfill-connectors/src/browser-manifest-honesty.test.ts` already
  enforces that browser-backed connectors declare `bindings.browser.required: true`.
- The Collection Profile (`spec-collection-profile.md` §1) defines standard
  bindings `browser_automation`, `browser_profile`, `filesystem`, `network`,
  `interactive`, `loopback_listen`. There is **no** bare `browser` binding in the
  spec registry; reference manifests use `browser` as a reference-local marker.
  This mismatch is captured in
  `design-notes/browser-binding-launch-direction-2026-05-18.md`.

## Goals / Non-Goals

**Goals:**

- Define `browser_collector` as a connector-instance source kind, a peer of
  `local_device`, so browser-collected and filesystem-collected bindings for the
  same connector type never collide and an owner can tell them apart.
- Make device-exporter enrollment binding-aware so the source kind is derived
  from the manifest, not hardcoded, and a contradicting source kind is rejected.
- Specify the owner-mediated initiation flow for browser-bound connectors that
  reaches an actionable next step **without** marking the connection active.
- Make proof a precondition: no route may advertise a real browser-bound next
  step until a committed test + scrubbed fixture shows end-to-end ingest.
- Keep Core / Collection Profile / reference / operator boundaries explicit.

**Non-Goals:**

- Do not implement the primitive in this lane. This is design/spec only.
- Do not promote `browser_collector` (or `local_device`) into PDPP Core
  protocol vocabulary. It is reference / Collection Profile implementation
  vocabulary.
- Do not reconcile the bare `browser` binding name against the spec-defined
  `browser_automation` / `browser_profile` registry here. That is a separate
  promotion tracked by `browser-binding-launch-direction-2026-05-18.md` and must
  not be silently absorbed. This change reads whatever binding marker the
  manifest declares; it does not bless the name.
- Do not build a new browser transport. Browser sessions continue to run via the
  native headed launcher or the host browser bridge. `browser_collector` is an
  **enrollment / identity** primitive, not a new automation channel.
- Do not weaken the device-exporter trust model. Browser-collected ingest uses
  the same enrolled, revocable device credentials and the same instance-resolution
  rules as filesystem collection.

## Decisions

### 1. `browser_collector` is a connector-instance source kind, not a spine source kind

There are two unrelated "source kind" axes in the reference, and conflating them
would be a real bug:

- `reference-implementation/lib/spine.ts` defines `SourceKind = "connector" |
  "provider_native"` for spine **event** provenance. This change does **not**
  touch that union.
- The **connector-instance source binding** carries `sourceKind: "local_device"`
  (the enroll handler's `upsert`). `browser_collector` is a new value on **this**
  axis only — a peer of `local_device`.

A `browser_collector` source binding means: this connector instance is collected
by a local collector that drives a browser session for a browser-bound connector.
It is distinct from `local_device` (filesystem-read) because the trust posture,
the diagnostics an owner needs ("session expired / login required" vs "device
unreachable"), and the future health surface differ. Recording it as
`local_device` would assert filesystem collection that did not happen.

The source binding records enough to namespace and resolve the instance: the
connector key, the source kind (`browser_collector`), the device id, the local
binding name, and a source-instance id — the same shape `local_device` uses, with
the kind swapped. No new top-level noun is minted; per
`connection-first-collection-identity-2026-05-18.md`, a binding becomes
first-class only when it needs independent lifecycle, which it does not here.

### 2. Enrollment derives the source kind from the manifest and rejects contradictions

Today the enroll route hardcodes `local_device`. That is correct only because the
only enrolled connectors are filesystem-backed. The durable rule:

- The enrollment-code and enroll routes SHALL resolve the connector manifest and
  read `runtime_requirements.bindings`.
- A `filesystem` binding → the enrolled binding SHALL be `local_device`.
- A `browser` binding (and no `filesystem` binding) → the enrolled binding SHALL
  be `browser_collector`.
- If a caller supplies an explicit source kind that contradicts the manifest
  (e.g. `local_device` for a `browser`-only connector), the route SHALL reject the
  request rather than silently record the wrong kind.
- A connector with neither binding, or no registered manifest, SHALL be rejected
  with a typed error — enrollment SHALL NOT default to a source kind.

This mirrors the existing intent-route classifier
(`classifyConnectorIntentModality`) so the enroll path and the intent path agree
on the same manifest-derived placement signal. `filesystem` wins over `browser`
if a manifest declares both (defensive; no current manifest does), matching the
classifier's existing precedence.

The binding marker the route reads is whatever the manifest declares
(`browser`). This change deliberately does not rename it to a spec-registry
binding; see Non-Goals and Open Questions.

### 3. New connection creation stays an intent; browser-bound gets a typed next step only after proof

The owner-agent control surface already established that initiation is an intent,
not a mutation, and that every response carries `connection_active: false`. This
change defines the browser-bound branch:

- Before proof: the `browser_bound` branch returns `unsupported` (current
  behavior). The reason names this primitive. No code change flips it early.
- After proof (decision 4): the branch MAY return a typed
  `next_step.kind: "enroll_browser_collector"` carrying a single-use enrollment
  code and the enroll endpoint, minted via the **same**
  `deviceExporterStore.createEnrollmentCode` operation the local-collector branch
  uses (separate bearer auth adapter; no handler cloning). The response SHALL keep
  `connection_active: false`.

The connection materializes only when the owner's collector exchanges the code,
the owner completes provider login **locally** (the agent never receives
credentials or drives 2FA), and the collector ingests at least one batch through
the device-exporter path. Initiation continues to emit
`owner_agent.connection.initiate` spine evidence (actor, connector key, modality,
next-step kind, outcome) and never logs the bearer token or the minted code.

`enroll_browser_collector` is reserved as a distinct next-step kind from
`enroll_local_collector` so the collector and the owner can see that the next
step requires a browser session and a local login, not a filesystem scan. The
contract enum already reserves unused kinds (`open_url`,
`complete_browser_assistance`, `upload_file`); `enroll_browser_collector` joins
them as a reserved-then-emitted kind, so adding it is not a contract break.

### 4. Proof is a precondition, not a follow-up

The acceptance bar from `add-owner-agent-control-surface` is explicit: claiming a
flow the reference does not prove is a faked success and is forbidden. Therefore:

- No route SHALL advertise `enroll_browser_collector` (or otherwise flip a
  browser-bound connector off `unsupported`) until there is a committed test that
  drives a browser-bound connector (Amazon) through enrollment → browser session →
  device-exporter ingest, and a scrubbed fixture (per the
  `scrub-connector-fixtures` pipeline) proving the ingested shape.
- The proof SHALL exercise the real enroll/ingest path, not a mock that asserts
  the happy path without touching the binding-aware enrollment code.
- Until the proof lands, `unsupported` with the named gap is the honest output.

This keeps the flip and the proof in the same reviewable unit when implementation
happens, and prevents a future lane from advertising the next step on faith.

### 5. Browser transport is unchanged; this is identity + enrollment only

`browser_collector` does not introduce a new way to run a browser. The browser
session still runs through the native headed launcher or the host browser bridge
(`design-host-browser-bridge-for-docker`). What is new is:

- the **enrollment** decision (which source kind to record), and
- the **instance identity** (`browser_collector` binding) that ingest resolves
  against.

This keeps browser automation where it already lives (the polyfill-connector
runtime and the host bridge) and out of PDPP Core and the central server. The
central server still receives normalized records, state, health, and diagnostics
— never raw browser control or remote filesystem access — exactly as
`local-device-exporter-collection` requires today.

### 6. Multi-account Amazon is correct by construction

With `browser_collector` as a distinct binding under connection-first identity:

- "the owner personal Amazon" and a future "shared Amazon" are two connector instances
  with the same `connector_id: amazon`, distinct `connector_instance_id`, each
  `browser_collector`, each with its own local binding name, schedules, state,
  health, and idempotency namespace (the instance-scoping requirements in
  `reference-connector-instances` already cover this once the source kind exists).
- A second Amazon account is "enroll another browser-collector binding for
  `amazon`", not a special case. Chase and ChatGPT inherit the same path because
  they share the `browser` binding marker.

## Risks / Trade-offs

- **Risk: `browser_collector` proliferates source-kind values.** Mitigation: it is
  one new value on one existing axis (connector-instance source binding), justified
  by a distinct trust posture and diagnostics need. No new top-level noun, no new
  spine source kind.
- **Risk: binding-aware enrollment misclassifies a connector that declares both
  `filesystem` and `browser`.** Mitigation: deterministic precedence
  (`filesystem` wins), matching the existing intent classifier; no current
  manifest declares both; a connector with neither is rejected, not defaulted.
- **Risk: the bare `browser` binding marker gets blessed by accident.** Mitigation:
  this change reads the marker the manifest already declares and explicitly defers
  the spec-registry reconciliation to
  `browser-binding-launch-direction-2026-05-18.md`. The spec delta does not name
  `browser` as a Core or Collection Profile binding.
- **Risk: a future lane advertises the next step without real proof.** Mitigation:
  the proof gate is a normative requirement, and the flip and proof are designed to
  land in the same unit.
- **Risk: agents attempt unsafe provider automation.** Mitigation: provider login
  and 2FA stay owner-mediated and local; the intent never returns credentials, and
  `connection_active` stays false until local ingest.

## Migration Plan

This change is design only; the migration below is the implementation lane's plan,
recorded so the next slice has a concrete start.

1. Add `browser_collector` to the connector-instance source-kind type and the
   enroll handler's `sourceBinding` construction.
2. Add a manifest-derived source-kind resolver shared by the enrollment-code and
   enroll routes (reuse the intent classifier's binding precedence).
3. Reject contradicting or unresolvable source kinds with typed errors; add unit
   coverage for filesystem→`local_device`, browser→`browser_collector`,
   contradiction→reject, no-binding→reject.
4. Land the Amazon end-to-end proof test + scrubbed fixture.
5. Only then: flip the `browser_bound` intent branch to return
   `enroll_browser_collector`, and add the `add-owner-agent-control-surface`
   Amazon second-account acceptance coverage (its tasks 5.3 / 8.5).

Rollback is route-level: the intent branch reverts to `unsupported`; enrolled
`browser_collector` instances remain valid instance rows governed by normal
retention and grant rules.

## Open Questions

- Should `enroll_browser_collector` be a distinct next-step kind, or should
  `enroll_local_collector` carry a `requires_browser_session: true` flag? Leaning
  distinct kind (decision 3) because the collector and owner need to see the
  browser/login requirement without parsing flags; revisit if the collector CLI
  would rather branch on a flag.
- Should the bare `browser` binding be reconciled to `browser_automation` /
  `browser_profile` before or after this primitive ships? Deferred to
  `browser-binding-launch-direction-2026-05-18.md`. This change works with either
  outcome because it reads whatever marker the manifest declares.
- Does Chase's money-adjacent posture warrant a stricter enrollment gate than
  Amazon (e.g. an explicit per-connector allowlist for `browser_collector`
  initiation)? Out of scope here; flagged for the implementation lane.

## Acceptance Checks

- [x] `browser_collector` is defined as a connector-instance source kind distinct
      from `local_device`, with a stated reason it is not `local_device` and not a
      spine source kind.
- [x] Binding-aware enrollment gating is specified: manifest-derived source kind,
      contradiction rejection, no defaulting.
- [x] The owner-mediated browser-bound initiation flow reaches a typed next step
      without marking the connection active.
- [x] A proof precondition is specified before any route flips Amazon off
      `unsupported`.
- [x] Core / Collection Profile / reference / operator boundaries are explicit, and
      the `browser` binding name reconciliation is deferred, not absorbed.
- [ ] Implementation, Amazon proof test + scrubbed fixture, and the intent-branch
      flip — deferred to the implementation lane (out of scope here).
