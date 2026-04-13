# Collection Method Matrix

Classification of data collection methods against the current PDPP architecture.

---

## Matrix

| Collection method | Fits current Collection Profile? | Classification | Notes |
|---|---|---|---|
| **Browser automation** | Yes | Collection Profile (bounded run, `browser_automation` binding) | Primary path today. Polyfill for platform non-cooperation. Tested, specified, conformance suite passing. |
| **API key / PAT** | Yes | Collection Profile (bounded run, connector-specific credentials) | Connector stores or receives credentials via runtime config. No new binding type needed — credentials passed in START.config or environment. |
| **OAuth API** | Yes | Collection Profile (bounded run, `interactive` + `network` bindings) | OAuth token refresh may require INTERACTION. Connector handles token lifecycle internally; runtime provides network binding. |
| **Local file import** | No | Runtime-only adaptation | Use RS ingest endpoint directly (`POST /v1/ingest/{stream}` + owner token). No START/DONE lifecycle needed. File-import tool exists as reference module. |
| **Remote file pull** | Borderline | Collection Profile if pull is bounded; runtime if one-shot | A connector that fetches a remote archive and emits RECORDs fits the profile. A one-shot download + ingest is simpler as runtime. |
| **Webhook / push** | No | Runtime-only adaptation | Webhook adapter receives events and ingests via RS endpoint. No interop contract between PDPP implementations. Experiment confirmed. |
| **Streams / WebSocket / SSE** | No | Likely future profile territory | Long-lived connection doesn't fit bounded-run lifecycle. Would need a streaming profile with different state/lifecycle model. No current demand. |
| **Scheduling / orchestration** | N/A (meta) | Runtime-only | Coordinates connector runs via `runConnector()`. Scheduling, retry, coordination are deployment choices. Experiment confirmed. |

## Key observations

1. **The bounded-run Collection Profile covers the three most common methods today:** browser automation, API key/PAT, and OAuth API. These share the same lifecycle (spawn → START → collect → DONE) and differ only in bindings and credential handling.

2. **File import and webhooks bypass the Collection Profile entirely.** They use the RS ingest endpoint directly. This is architecturally correct — they don't need the connector runtime's lifecycle, binding matching, or state management.

3. **Long-lived streams are the one method that genuinely doesn't fit.** A WebSocket or SSE connection is inherently open-ended — it has no bounded "run" and no natural DONE message. If a platform offers a streaming API for personal data (none do today), a Streaming Profile with different lifecycle semantics would be warranted.

4. **Scheduling is orthogonal.** It sits above the Collection Profile, not alongside it. The scheduler calls `runConnector()` as a black box.

## Decision criteria for new profiles

A new profile is justified when ALL of:
1. A real implementation target exists (not speculative)
2. Multiple independently-built implementations need to agree on wire-level behavior
3. The existing Collection Profile or RS ingest endpoint cannot cleanly adapt

Currently, no collection method meets all three criteria for a new profile.
