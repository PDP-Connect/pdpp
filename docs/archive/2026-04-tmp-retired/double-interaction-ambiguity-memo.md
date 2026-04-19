# Double INTERACTION Ambiguity

**Date:** 2026-04-12
**Test:** `collection-profile.test.js` test #6 (skipped)

---

## The ambiguity

The Collection Profile states that a connector emitting a second INTERACTION while one is pending is a protocol violation. The reference runtime has a guard for this (runtime/index.js:171-174: `if (pendingInteraction) { proc.kill(); throw ... }`). But the guard is unreachable through normal operation.

## Why the spec rule still stands

The rule is correct at the protocol level. A connector that sends two overlapping INTERACTION requests is making contradictory demands on the user — "enter your password" and "enter your OTP" simultaneously. The spec is right to call this a violation regardless of whether any particular runtime architecture happens to prevent it.

The rule also protects against:
- Future runtimes that might process messages concurrently (e.g., a multi-threaded runtime, or one that reads the full stdout buffer and dispatches in parallel)
- Non-JSONL transports where message ordering or delivery timing could differ (e.g., if the connector protocol were ever carried over a different IPC mechanism)
- Connector authors who might assume they can pipeline INTERACTION requests

The rule should stay in the spec. It defines correct connector behavior, not correct runtime behavior.

## Why the current runtime makes it unreachable

The reference runtime processes connector messages through a sequential queue:

```js
async function processNext() {
  if (processing || !msgQueue.length) return;
  processing = true;
  const msg = msgQueue.shift();
  await handleMsg(msg);  // INTERACTION handler awaits onInteraction() here
  processing = false;
  processNext();
}
```

When the first INTERACTION enters `handleMsg`, `processing` is `true`. All subsequent messages queue in `msgQueue` but are not processed until `handleMsg` returns. When the INTERACTION handler completes, it sets `pendingInteraction = null` before `processing = false`. The second INTERACTION is then dequeued and processed — but `pendingInteraction` is already null, so the guard doesn't fire.

The sequential queue is an implementation choice that happens to serialize all message processing. A different runtime architecture (concurrent dispatch, buffered batch processing) could encounter the violation.

## What to do with the skipped test

**Remove it from the black-box conformance suite.** The conformance suite tests observable protocol behavior between a connector and a runtime. Since the double INTERACTION cannot be triggered through the JSONL wire protocol with a sequential runtime — and the spec does not mandate concurrent processing — the test has no observable behavior to assert against.

The guard in the runtime code is a defensive implementation detail, not a testable protocol property. If it matters to validate the guard itself, that belongs in a **unit test of the runtime's message dispatcher**, not in the black-box conformance suite.

**Recommended action:**
1. Remove the skipped test from `collection-profile.test.js`
2. Optionally add a unit test in a separate file that directly calls `handleMsg` twice without waiting, verifying the guard fires — but this is a runtime implementation test, not a protocol conformance test
3. Keep the spec rule as-is
4. Add a non-normative note in the Collection Profile acknowledging that sequential JSONL runtimes inherently prevent this scenario, while the rule remains correct for the protocol

## Where this is recorded

- **Conformance test suite:** test #6 currently skipped with inline comment explaining the ambiguity
- **Coverage memo:** `docs/archive/2026-04-inbox-retired/collection-profile-conformance-coverage-memo.md` documents the ambiguity and the question for spec
- **This memo:** the full analysis and recommendation
