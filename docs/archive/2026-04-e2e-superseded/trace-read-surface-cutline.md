# Trace Read Surface Cutline

Date: 2026-04-16

## Recommended minimal routes

The current spine is durable and queryable in-process via [`e2e/lib/spine.js`](/home/user/code/pdpp/e2e/lib/spine.js:60), but it is not yet consumable over HTTP. The smallest honest read surface is:

1. `GET /_ref/traces/:traceId`
   Return one trace envelope plus ordered events. This maps directly to `listSpineEvents({ traceId })` in [`e2e/lib/spine.js`](/home/user/code/pdpp/e2e/lib/spine.js:152) and matches the existing golden-path assertion style in [`e2e/test/event-spine.test.js`](/home/user/code/pdpp/e2e/test/event-spine.test.js:144).
2. `GET /_ref/grants/:grantId/timeline`
   Return the ordered event slice for one grant. This matches the current dominant object on the auth side and mirrors the existing test lookup by `grantId` in [`e2e/test/event-spine.test.js`](/home/user/code/pdpp/e2e/test/event-spine.test.js:140).
3. `GET /_ref/runs/:runId/timeline`
   Return the ordered event slice for one runtime run. This matches the current runtime-side lookup in [`e2e/test/event-spine.test.js`](/home/user/code/pdpp/e2e/test/event-spine.test.js:175).

These should live under a clearly reference-only namespace, consistent with the prior recommendation in [`docs/archive/2026-04-e2e-superseded/event-spine-implementation-plan.md`](/home/user/code/pdpp/docs/archive/2026-04-e2e-superseded/event-spine-implementation-plan.md:440). They should be read-only and should reuse the current append order from `spine_events`, not invent a second ordering model.

## Recommended minimal CLI surface

The CLI already has real auth and query surfaces in [`e2e/cli/index.js`](/home/user/code/pdpp/e2e/cli/index.js:10) and [`e2e/cli/commands/auth.js`](/home/user/code/pdpp/e2e/cli/commands/auth.js:7). The next minimal addition should be object-scoped timeline inspection, not a generic trace browser:

1. `pdpp grant timeline <grant-id> [--as-url <url>] [--format json|table]`
   This fits the existing `grant` group in [`e2e/cli/commands/grant.js`](/home/user/code/pdpp/e2e/cli/commands/grant.js:7) and avoids introducing a new top-level group before the substrate needs it.
2. `pdpp trace show <trace-id> [--as-url <url>] [--format json|table]`
   This is the first standalone trace command worth adding. It aligns with the candidate taxonomy in [`docs/archive/2026-04-inbox-retired/pdpp-cli-surface-memo.md`](/home/user/code/pdpp/docs/archive/2026-04-inbox-retired/pdpp-cli-surface-memo.md:244), but keeps the initial scope to a single retrieval command.
3. `pdpp run timeline <run-id> [--as-url <url>] [--format json|table]`
   Only if a `run` command group is introduced at the same time. If not, defer this until the runtime surface is slightly more formal.

The CLI should consume the new `/_ref/*` routes through the existing HTTP helper in [`e2e/cli/lib/fetch.js`](/home/user/code/pdpp/e2e/cli/lib/fetch.js:1). Tests should stop importing `listSpineEvents(...)` directly once these routes exist.

## What to defer

- `GET /_ref/events`
  Too broad for the current substrate. There is no stable paging, filtering, or access policy yet, and the current spine does not have a separate trace index.
- `pdpp trace list`
  Premature without either a trace index/table or an explicit listing contract. The current implementation stores events, not first-class trace records.
- `pdpp trace tail`
  Premature until there is a real streaming or polling contract. Nothing in the current server or CLI supports live tail semantics yet.
- `GET /_ref/artifacts/:artifactId`
  The first-pass spine deliberately kept artifacts out of scope; see [`docs/archive/2026-04-e2e-superseded/first-event-spine-hookpoints.md`](/home/user/code/pdpp/docs/archive/2026-04-e2e-superseded/first-event-spine-hookpoints.md:17).
- `GET /_ref/scenarios`
  Useful later, but the current emitted spine is trace/run/grant-centric, not scenario-registry-driven.
- Rich summaries or derived dashboards in the route response
  The route should expose ordered events first. Derived summaries can be layered on later.

## Contract risks

1. Do not let `/_ref` become a shadow product API.
   These routes are reference-only and should stay clearly outside PDPP core/public provider semantics, per [`docs/archive/2026-04-e2e-superseded/event-spine-implementation-plan.md`](/home/user/code/pdpp/docs/archive/2026-04-e2e-superseded/event-spine-implementation-plan.md:448).
2. Do not make the route response more authoritative than the spine itself.
   The source of truth remains the append-only `spine_events` rows and the domain tables; the route should be a projection, not a new state model.
3. Be explicit about ordering.
   Current event reads are ordered by SQLite `rowid` in [`e2e/lib/spine.js`](/home/user/code/pdpp/e2e/lib/spine.js:157), not by timestamp sort. The HTTP contract should preserve that append order unless the storage model changes intentionally.
4. Avoid overloading auth decisions into the cutline.
   The next step is to make the data readable, not to solve a full operator-auth model. If gating is added, keep it narrow and clearly reference-only.
5. Stop tests from depending on in-process imports once the routes exist.
   Right now [`e2e/test/event-spine.test.js`](/home/user/code/pdpp/e2e/test/event-spine.test.js:9) imports `listSpineEvents` directly. That is fine for the first implementation tranche, but the next cut should move tests onto the reference read surface so CLI, tests, and the future console all consume the same contract.
