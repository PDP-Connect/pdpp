# Next Tranche Risk Review

Date: 2026-04-16  
Status: Red-team review against current owner decisions, next-tranche docs, and live `e2e/` substrate

## Bottom line

The current next-tranche docs are directionally strong, but they still contain several **real sequencing errors and stale assumptions** that will cause drift if coding follows them literally.

The sharpest pattern is:

- the plans increasingly describe a cleaner post-cutover world
- the current code is still anchored to the old helper/auth/connector dialect
- a few planning docs now assume seams are already cleaned up when they are not

The next tranche should be re-ordered around the actual blocking seams, not the aspirational topology.

## 1. The tranche docs are stale about what has already been completed

### Risk

[next-code-tranche-review.md](/home/user/code/pdpp/docs/inbox/next-code-tranche-review.md:1) is framed as “after the pending-consent seam and the initial owner-path CLI tranche”, but current code already has:

- DB-backed `pending_consents` in [e2e/server/db.js](/home/user/code/pdpp/e2e/server/db.js:1)
- pending-consent persistence in [e2e/server/auth.js](/home/user/code/pdpp/e2e/server/auth.js:1)
- a real CLI entrypoint and command surface in [e2e/cli/index.js](/home/user/code/pdpp/e2e/cli/index.js:1)

### Why it matters

This makes the next tranche easy to mis-sequence because the docs still talk as if those seams are upcoming tranche gates rather than current baseline.

### Change

Update the tranche framing so these are treated as:

- baseline already present
- still needing cleanup/honesty in some places
- but no longer “future tranche preconditions”

Do not keep planning around a pending-consent seam that has already landed.

## 2. Native-path proof is blocked by the request/grant seam, but the docs still treat it as the next direct coding step

### Risk

The owner decisions correctly insist that the native provider path must be connector-free **at the contract level**.

But current AS/grant code still fundamentally depends on connector semantics:

- `approveGrant()` requires `params.connector_id`
- it resolves a connector manifest by `connector_id`
- it builds the grant from that connector-centric shape

See [e2e/server/auth.js](/home/user/code/pdpp/e2e/server/auth.js:1).

At the same time, [request-shape-cutover-plan.md](/home/user/code/pdpp/docs/inbox/request-shape-cutover-plan.md:1) still proposes a “canonical” internal request object whose core selection object includes `connector_id`.

### Why it matters

If coding follows the current “native-path proof next” framing before the request seam is cut over properly, the repo will harden a fake native path on top of a still-connector-centric grant core.

That would violate the owner decision in substance while seeming to comply in naming.

### Change

Move the request/grant seam cleanup ahead of native-path proof.

Specifically:

1. Normalize pending consent to one canonical internal request object.
2. Ensure that internal object can represent a native provider path without requiring connector semantics in the public/native contract.
3. Only then build native-path tests and fixtures.

Without that order, “native path” will be cosmetic.

## 3. The proposed canonical request object currently bakes the old connector worldview deeper into persistence

### Risk

[request-shape-cutover-plan.md](/home/user/code/pdpp/docs/inbox/request-shape-cutover-plan.md:1) is good as a transport cutover plan, but its proposed canonical object still centers:

- `selection.connector_id`

That is acceptable for the current personal-server path, but it is not neutral with respect to the owner decision that the native provider path must read connector-free at the contract level.

### Why it matters

If the “canonical” internal object stores connector identity as the central subject of selection, pending-consent persistence and grant-building will continue to train the system toward connector-first semantics even after the transport shape is cleaned up.

### Change

Do not ship the cutover plan unchanged.

At minimum:

- either rename the object so it is clearly transitional and connector-scoped
- or adjust the internal shape so the top-level semantic target is not permanently “connector”

If that cannot be done cleanly now, then explicitly label the cutover as:

- transport cleanup first
- native-path-neutral semantics still pending

Do not call it the long-term canonical shape if it still encodes the old worldview.

## 4. The CLI is still materially coupled to the old dialect, so current “first-class consumer” language is ahead of reality

### Risk

The plans and owner decisions want the CLI to be a canary for clean engine surfaces.

But the live CLI still depends on old assumptions:

- owner commands require `--connector-id` for all owner queries in [e2e/cli/commands/owner.js](/home/user/code/pdpp/e2e/cli/commands/owner.js:1)
- `grant token` directly calls the compat/demo helper route `/grants/:grantId/tokens` in [e2e/cli/commands/grant.js](/home/user/code/pdpp/e2e/cli/commands/grant.js:1)
- there is no provider discovery, no metadata inspection, and no owner login flow in the CLI

### Why it matters

If tranche planning assumes the CLI is already exercising the intended clean contract, it will miss the fact that the CLI is still teaching the old connector-centric/admin-helper surface.

### Change

Do not treat the current CLI as proof of a clean contract.

Split the next CLI work into two explicit buckets:

- `legacy inspection/debug commands that remain compat-only`
- `new provider-connect / owner self-export commands that are intended to survive`

And in code order:

1. add metadata/discovery and one real owner-login path
2. then add `inspect-provider` / self-export commands
3. only then tighten or demote old grant/helper commands

## 5. Provider-connect planning is still one step ahead of the auth substrate

### Risk

The provider-connect draft and implementation map correctly converge on:

- RFC 9728 protected-resource metadata
- RFC 8414 AS metadata
- device flow as the first proved owner path

But the live auth substrate still looks like:

- `/owner-token`
- `/grants/initiate`
- `/consent/:deviceCode/*`
- no RFC 8414 metadata
- no RFC 9728 metadata
- no RFC 8628 device authorization endpoint

See [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:1).

### Why it matters

If the next tranche focuses on native-path proof and compat-route demotion before implementing one standards-based auth/discovery path, the CLI and tests will continue to accrete on the custom helper routes simply because those are the only real auth surfaces.

### Change

Move “first standards-based owner path” earlier.

Recommended order:

1. protected-resource metadata
2. authorization-server metadata
3. owner-oriented device flow
4. CLI provider inspect + self-export
5. only then compat-route demotion

Otherwise “compat-only” will remain true in prose and false in practice.

## 6. The native-path plan understates how much the RS surface itself is still connector-shaped

### Risk

[next-code-tranche-review.md](/home/user/code/pdpp/docs/inbox/next-code-tranche-review.md:1) calls for native-path tests proving that no `connector_id` is required in the native query path.

But the current owner-facing CLI and RS usage pattern is still explicitly connector-shaped:

- owner stream listing and owner query require `connector_id`
- the demo client and seed flows assume connector-scoped source selection

See [e2e/cli/commands/owner.js](/home/user/code/pdpp/e2e/cli/commands/owner.js:1) and [e2e/client/demo.js](/home/user/code/pdpp/e2e/client/demo.js:1).

### Why it matters

The native-path proof is not blocked only by auth/grant issuance. It is also blocked by the current RS usage model.

If this is missed, tranche 2 could produce “native provider” fixtures while the actual query surface still teaches that every owner query is connector-qualified.

### Change

Add an explicit “native RS surface honesty” step before claiming native-path proof.

That step should answer:

- what scoping primitive replaces `connector_id` in the native path, if any
- whether owner queries become provider-implicit in the native deployment
- how the CLI chooses that path without special casing hacks

Do not let native-path proof proceed without an explicit answer to that seam.

## 7. Grant-scoped state is correctly thin, but its sequencing is still too early relative to the caller that will actually use it

### Risk

[grant-scoped-state-implementation-plan.md](/home/user/code/pdpp/docs/inbox/grant-scoped-state-implementation-plan.md:1) is disciplined and narrow. But the current stack has no real caller yet that runs:

- a `continuous` grant
- through the runtime
- with a `grantId`-aware orchestration path

Today the runtime does not receive `grantId`, and the scheduler is still an experimental helper in [e2e/runtime/scheduler.js](/home/user/code/pdpp/e2e/runtime/scheduler.js:1).

### Why it matters

If grant-scoped state lands before the higher-level caller and contract are chosen, it risks becoming dead substrate that reflects the spec text but not a proved execution path.

### Change

Keep the plan, but tighten the sequence:

- server-side support and tests can land early
- runtime write/read helpers can land with that
- but do **not** let this become a major tranche centerpiece until one concrete `continuous` grant run path is chosen

In other words:

- implement the seam
- do not pretend the system is using it yet

## 8. “Trace inspection” is in scope for the CLI before there is any real trace substrate

### Risk

Owner decisions put `trace inspection` into day-one CLI scope and also call the event spine a first-class derived truth.

But current code has:

- no event store
- no trace emission layer
- no CLI trace commands

And [next-code-tranche-review.md](/home/user/code/pdpp/docs/inbox/next-code-tranche-review.md:1) still defers the full event/trace spine.

### Why it matters

This creates a soft contradiction:

- trace inspection is “in scope”
- but the underlying thing to inspect does not yet exist

That is exactly the sort of ambiguity that causes half-built debug surfaces to appear ad hoc later.

### Change

Make one explicit call:

- either remove `trace inspection` from day-one CLI scope now
- or add a minimal golden-path event emission tranche before promising CLI trace commands

The latter is probably better, but it needs to be explicit.

## 9. The docs still over-credit `e2e/client/` as a first-class consumer even though it is mostly legacy demo substrate

### Risk

[e2e-reference-implementation-plan.md](/home/user/code/pdpp/docs/archive/2026-04-e2e-superseded/e2e-reference-implementation-plan.md:1) says the working standard should point implementers to:

- `e2e/client/` and `e2e/cli/` for consumer behavior

But the only substantial `e2e/client/` consumer is still the old demo in [e2e/client/demo.js](/home/user/code/pdpp/e2e/client/demo.js:1), which:

- uses the old `/owner-token` helper
- uses the flat `/grants/initiate` shape
- is deeply tied to connector manifests and seed flows

### Why it matters

This inflates confidence in the cleanliness of the consumer side and hides how much of the non-CLI surface is still legacy reference/demo code.

### Change

Update the plan language so it says something closer to:

- `e2e/cli/` is the primary external consumer surface
- `e2e/client/demo.js` is legacy/reference demo substrate until explicitly refactored

Do not count `e2e/client/` as proof of clean consumer behavior yet.

## Recommended code-order correction

If the goal is to reduce drift and avoid building the wrong thing next, the next code order should be:

1. **Request/grant seam cutover**
   - normalize pending consent and grant-building away from raw flat bodies
   - do not harden connector-centric semantics further while doing it

2. **First standards-based provider-connect owner path**
   - RFC 9728 metadata
   - RFC 8414 metadata
   - one real owner login flow

3. **CLI provider/self-export tranche**
   - inspect provider
   - owner self-export
   - keep old helper/debug commands explicitly compat-only

4. **Native-path honesty**
   - only after the request/auth and owner-query seams are clean enough to support it honestly

5. **Grant-scoped state activation**
   - after one concrete `continuous`-grant caller exists

6. **Minimal event emission**
   - only enough to support the promised golden-path trace/debug story

7. **Compat-route demotion**
   - once a real replacement path exists and is exercised by the CLI/tests

## Final recommendation

The biggest mistake available right now is to start with “native-path proof” as though the contract seams underneath it are already clean.

They are not.

The next tranche should start by fixing the seams that all later consumers depend on:

- request/grant shape
- discovery/auth metadata
- CLI’s first real provider/self-export path

Only then should the project claim that the native path, compat cleanup, and trace tooling are being proven against the right contract.
