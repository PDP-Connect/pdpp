## 1. Runtime and controller seam

- [ ] 1.1 Extend `reference-implementation/runtime/controller.js` so controller-managed runs broker pending interactions in memory instead of falling back to the server process stdin prompt.
- [ ] 1.2 Track the current pending interaction per active run, including `interaction_id`, kind, message, schema, timeout, and a resolver for the eventual `INTERACTION_RESPONSE`.
- [ ] 1.3 Reject duplicate, stale, or missing interaction responses honestly at the controller layer before they can fabricate a runtime completion.

## 2. Reference control-plane API

- [ ] 2.1 Add a reference-contract manifest for `POST /_ref/runs/{runId}/interaction` in `packages/reference-contract/src/reference/index.ts`.
- [ ] 2.2 Mount the owner-only route in `reference-implementation/server/index.js` and wire it to the controller interaction broker.
- [ ] 2.3 Keep the route mutation-only: reuse the existing run timeline as the read path and do not add a parallel inbox identity or new public API.
- [ ] 2.4 Ensure submitted interaction data is never persisted to `.env.local`, SQLite state/config, or timeline/log payloads beyond existing safe completion metadata.

## 3. Dashboard UX

- [ ] 3.1 Add a server-side helper / action in `apps/web/src/app/dashboard/lib/ref-client.ts` (and adjacent action file if needed) for submitting a run interaction response.
- [ ] 3.2 Extend `apps/web/src/app/dashboard/runs/[runId]/page.tsx` to render a response form from the current pending interaction schema for `credentials` and `otp`.
- [ ] 3.3 Add the appropriate affordance for `manual_action`: allow the operator to resume with `success` after completing the external step, or cancel the interaction.
- [ ] 3.4 Keep the run detail page polling/live-state behavior honest so the form disappears once the interaction is completed, cancelled, timed out, or the run is no longer active.
- [ ] 3.5 Make the UI copy explicit that dashboard-submitted values satisfy the current run only and are not persisted as durable connector credentials.

## 4. Verification and docs

- [ ] 4.1 Add reference tests covering: successful response, cancelled response, stale `interaction_id`, no pending interaction, unknown/finished run, and proof that submitted secrets do not appear in run timeline artifacts.
- [ ] 4.2 Run `pnpm --dir reference-implementation run verify`.
- [ ] 4.3 Run `pnpm --dir apps/web run types:check` and `pnpm --dir apps/web run build`.
- [ ] 4.4 Update the relevant reference docs to describe the new route as a reference-only control-plane seam, not part of the public PDPP API.
