# Collection Layer Boundary Experiments: Summary

**Date:** 2026-04-12
**Experiments:** webhook-adapter, file-import, scheduler

---

## Bottom Line

All three experiments confirm: **the collection-layer boundary is in the right place.** Push delivery, batch import, and multi-connector orchestration all fit cleanly as runtime/reference architecture. None create interoperability contracts between independent PDPP implementations. No companion specs are warranted today.

## Results

| Experiment | Fits as runtime? | New interop contract? | Profile needed? |
|-----------|------------------|----------------------|-----------------|
| Webhook-to-pull adapter | Yes | No — contract is platform↔adapter, not PDPP↔PDPP | Not today |
| File import (JSONL + archive) | Yes | No — RECORD format (Core §4) is sufficient | Not today |
| Proactive scheduler | Yes | No — scheduling/retry are deployment choices | Not today |

## What each experiment uses from the spec

All three use the same two spec primitives:
1. **RECORD format** (Core §4) — the shared message shape
2. **RS ingest endpoint** (`POST /v1/ingest/{stream}` with owner token) — the shared ingestion path

Neither the Collection Profile's START/DONE lifecycle nor its binding matching is needed for these modes. The Collection Profile is specifically for connector-driven, bounded-run collection from source platforms. The other modes bypass it entirely and go straight to the RS.

## The interoperability test

For each experiment, we asked: "Does this affect wire-level interoperability between independently-built PDPP implementations?"

- **Webhook adapter**: No. The webhook contract is between a cooperating platform and a specific adapter. Different PDPP servers can receive webhooks differently.
- **File import**: No. Archive formats are platform-specific. The only shared contract is the RECORD format, which is already in Core.
- **Scheduler**: No. Scheduling, retry, and coordination are local deployment decisions. PDPP personal servers are per-user; there's no shared connector pool.

## When the answer would change

A Push Delivery Profile becomes warranted when ALL of:
1. A real platform offers PDPP-formatted webhook delivery
2. Multiple PDPP server implementations need to agree on the webhook format
3. Push-to-pull adaptation introduces unacceptable latency

A Batch Import Profile becomes warranted when:
1. Multiple import tools need to agree on an archive discovery format
2. The RS needs import-specific validation beyond the existing ingest endpoint

Neither set of conditions is true today.

## Recommendation

1. Keep the current Collection Profile as-is — it is sound and primary
2. Keep all three experiments as reference runtime modules (non-normative)
3. The conformance test suite for the existing Collection Profile remains the highest-priority spec work
4. Revisit the boundary only when a concrete implementation target forces the question
