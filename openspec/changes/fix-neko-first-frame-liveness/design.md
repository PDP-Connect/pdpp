## Context

The n.eko adapter associates each fetched JPEG with the presentation epoch that existed when the request began. It correctly waits for the serialized presentation-mutation tail and discards a JPEG from an older epoch. That safety boundary leaves no liveness path: the next request waits for the normal poll interval, and another viewport update can repeat the discard.

## Goals / Non-Goals

**Goals:**

- Preserve the acknowledgement gate: a frame SHALL never represent an unacknowledged screen.
- Coalesce a stale frame to the latest settled presentation epoch and fetch its replacement without waiting for the poll delay.
- Bound immediate retry work so a continuously changing viewport cannot form an unbounded request chain.

**Non-Goals:**

- Change n.eko screen selection, window-settle mechanics, or the stream wire contract.
- Queue one frame fetch per viewport event, cancel an in-flight JPEG request, or guarantee a frame while presentation changes never settle.
- Change normal polling cadence after the bounded replacement is exhausted.

## Decisions

### Make delivery report a stale epoch

The frame-delivery helper will wait for the presentation tail, then report whether the fetched frame is current, stale, or no longer deliverable. This keeps the acknowledgement check adjacent to the only frame-promotion effect.

### Permit one immediate replacement per poll cycle

When delivery reports stale, the polling turn will read the current epoch after the tail settled and perform one replacement fetch immediately. A second stale replacement returns to the normal polling loop. Two fetches are therefore the hard per-cycle bound, independent of the number of intervening viewport mutations.

This is preferred to a per-viewport queue, which could amplify churn into unbounded screenshot work, and to removing the epoch check, which would reintroduce promotion of an unacknowledged screen.

### Prove both safety and liveness deterministically

The former expected-failure oracle becomes a required test. A second test holds the first JPEG while a fixed number of phone-orientation changes settle, then asserts that the newest frame is promoted with no more than two fetches. The existing acknowledgement test remains the safety oracle.

## Risks / Trade-offs

- [A replacement becomes stale during continuous churn] → Stop after the one immediate replacement and resume normal polling; no recursive retry is possible.
- [A first frame is delayed until a settled epoch exists] → This is intentional: safety still dominates liveness when the screen has not acknowledged its geometry.
- [An extra JPEG request after one stale fetch] → The extra request is bounded to one per polling cycle and avoids waiting for the configured poll interval.

## Migration Plan

The adapter change is internal and needs no data or wire migration. Reverting it restores the prior polling behavior but also restores the first-frame starvation defect.

## Open Questions

None.
