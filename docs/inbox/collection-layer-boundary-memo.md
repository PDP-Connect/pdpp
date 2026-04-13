# Collection Layer Boundary: Decision Memo

**Date:** 2026-04-08
**Status:** Recommendation for review
**Full analysis:** `docs/research/collection-layer-boundary-note.md`

---

## Bottom Line

The collection layer boundary is already in the right place. Core owns shared semantics (RECORD envelope, streams, scope, tombstones). The Collection Profile owns the bounded-run mechanism (START/DONE lifecycle, bindings, INTERACTION). Everything else -- scheduling, retry, credential management, push-to-pull adaptation -- is orchestrator/runtime code that needs no spec treatment. Do not draft new profiles until concrete demand materializes.

---

## Key Bullets

- **Shared semantics are stable and correctly housed in Core.** The RECORD envelope, stream semantics, tombstone format, scope enforcement, and state/checkpoint model are cross-cutting. Any future profile reuses them; none redefines them.

- **The bounded-run Collection Profile is sound and primary.** Its lifecycle (START -> collecting -> DONE), state-gating-on-success, binding matching, and INTERACTION protocol are genuine innovations over Airbyte/Singer. They exist because PDPP collects from platforms the user does not control. Do not relax these invariants.

- **Eight collection modes classified; five fit the current profile, three do not.** Platform API pull, browser automation pull, and scheduled recurring pull all fit. Webhook push, data archive import, and platform event streams do not fit and would each need a future profile -- but none is needed now.

- **The interoperability test draws the line.** If it affects wire-level interoperability between independently-built implementations, it needs a spec. If not, it is orchestrator/runtime code. Scheduling, retry, credential storage, multi-connector coordination, and push-to-pull buffering are all on the runtime side of this line.

- **Three criteria gate a future Push Profile.** All must be true: (1) a real platform offers webhooks for personal data, (2) multiple implementers need interoperability for push delivery, (3) push-to-pull adaptation introduces unacceptable latency. None are true today.

- **The reference mock server covers Core RS query semantics but not the Collection Profile wire protocol.** The e2e implementation covers the Collection Profile. Between them, the protocol is demonstrated but orchestrator capabilities are not. The next experiments should fill that gap.

- **Build experiments, not specs.** Webhook-to-pull adapter, file import CLI, and proactive archival scheduler -- all in the reference, all to learn whether the current boundary holds. Hypothesis: it does.

- **The conformance test suite for the existing Collection Profile is higher priority than any new profile.** Prove the current profile works before expanding.

---

## Most Coherent Next Path

Write the Collection Profile conformance test suite first -- it validates the invariants that matter most and has no dependency on new design work. In parallel, build the three implementation experiments (webhook-to-pull, file import, proactive scheduler) in the e2e reference to stress-test the boundary. If the webhook-to-pull adapter works cleanly, that confirms the Push Profile can wait. If the file import experiment reveals that the shared ingest endpoint and RECORD format are sufficient without a Batch Import Profile, that confirms the "not yet" list is correct. Only revisit the boundary when a concrete implementation target forces the question.
