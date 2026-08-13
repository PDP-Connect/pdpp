# WHOOP browser connector learnings

Companion to [PDPP PR #131](https://github.com/PDP-Connect/pdpp/pull/131).

- The WHOOP browser origin is the trust boundary. The connector reads and uses
  the session bearer only inside the authenticated browser context to call
  WHOOP's cross-origin, private BFF; it never returns or persists that bearer
  outside the browser.
- Requested scopes constrain what is emitted and stored. They do not
  necessarily constrain upstream retrieval: coarse WHOOP endpoints can place
  broader aggregate data in memory before filtering.
- The reported incremental 27 records were a seven-day replay with upserts,
  not proof that 27 records changed.
- Heartbeat evidence covers only an immediate second run. It does not prove
  session-token survival across a day or week.
- WHOOP source quirks must remain explicit: recovery is keyed by cycle,
  PostgreSQL ranges arrive as strings, and current recovery and workouts can
  be absent.
- A connector addition also requires registry, canonical-key, setup-planner,
  and console wiring; the connector implementation alone is incomplete.
- Standalone orchestrator documentation names a nonexistent `.js` entrypoint.
  The actual invocation is
  `node --import tsx packages/polyfill-connectors/bin/orchestrate.ts run whoop`.
