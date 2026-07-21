# First-frame starvation root cause

Status: bounded analysis of candidate `5eee3522e` against rollback `e869d8531`.

## Finding

The candidate can starve the first n.eko frame when phone presentation changes
arrive while window-settle acknowledgements oscillate. The regression is the
combination of three candidate-only semantics:

1. Each presentation change increments `presentationEpoch` and serializes its
   screen mutation behind `presentationMutationTail`
   (`reference-implementation/server/streaming/neko-adapter.js:897-907`,
   `1365-1369`).
2. Each queued screen selection waits until `/pdpp/window-settle` reports the
   requested width and height as settled (`876-890`, `959-968`).
3. A screenshot already fetched by the polling loop waits for that same tail
   and is discarded unless its captured epoch remains current
   (`1302-1315`).

The rollback emitted a fetched screenshot immediately. Its `emitPolledFrame`
had no mutation-tail wait and no epoch rejection
(`e869d8531:reference-implementation/server/streaming/neko-adapter.js:1189-1200`).

## Causal chain

1. The stream route establishes the controlling attachment, writes the SSE
   `attached` event, subscribes to frames, and only then awaits
   `companion.start` (`reference-implementation/server/streaming/routes.js:1257-1313`,
   `1403-1411`).
2. On `attached`, the viewer marks the presentation attachment ready and
   schedules a viewport measurement (`apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:2486-2498`).
   Its viewport writer correctly refuses to post before that attachment
   (`2578-2601`) and the route serializes accepted controller posts
   (`reference-implementation/server/streaming/routes.js:1536-1570`).
3. A phone viewport selects the 412x915 or 915x412 screen configuration. The
   Chromium launcher watcher follows each X root mode change by resizing the
   `RemoteBrowserApp` window (`docker/neko/start-chromium.sh:157-176`). The
   local settle endpoint reports `settled` only when every such window equals
   the X root (`docker/neko/cdp-proxy.py:76-96`). This explains the observed
   true → false → true acknowledgements during presentation changes.
4. A poll captures `frameEpoch` before it fetches the JPEG. While that fetch is
   in flight, a viewer viewport update increments `presentationEpoch`; its
   selected phone mode waits for the false → true settle transition. A second
   update can increment the epoch again before the first mutation releases.
5. Once the tail finally drains, the already-fetched frame's old epoch fails
   the condition at adapter line 1304. It is silently discarded. The next
   poll is the only new frame opportunity, so recurrent presentation changes
   can repeat the loss indefinitely. The production symptom—no decoded first
   frame, no remote telemetry, and a near-black remote raster—is consistent
   with no frame reaching the viewer.

The supplied watched-canary evidence rules out capability skew: the app,
n.eko image, and allocator were rebuilt together; the settle endpoint answered;
and there were no HTTP or n.eko HTTP failures. The rollback passed the same
smoke.

## Suspects

- **Frame-promotion starvation: proven.** The deterministic oracle below
  reproduces the candidate code path without a browser or synthetic model.
- **Attachment/settle deadlock: eliminated.** The server emits `attached`
  before awaiting companion start, and the client posts only after that event.
  Attachment enables presentation input; it does not wait for a frame or
  media-settle result. It can supply the racing viewport mutations, but it is
  not a circular wait.
- **One aborted EventSource as root cause: eliminated.** After an attachment
  exists, the viewer leaves transient transport recovery to EventSource
  (`stream-viewer.tsx:2507-2510`). Server close cleanup removes only that
  connection's subscriptions and deliberately keeps the companion alive
  (`routes.js:1342-1368`). The oracle reproduces starvation with no SSE at
  all, so the abort is a symptom or an independent transport event, not the
  cause.
- **Viewer media-settle promotion: downstream symptom.** The viewer only sets
  `mediaReady` after a displayable media sample reaches `settled`
  (`stream-viewer.tsx:4215-4306`), then uses it to remove the loading state
  (`4363-4369`). With no frame, it cannot promote media, but it does not gate
  the adapter's JPEG polling.

## Discriminating oracle

`reference-implementation/server/streaming/neko-adapter.test.js:382-479`
uses the real adapter with its real screen-selection, settle-poll,
presentation-tail, epoch, JPEG-poll, and frame-handler paths:

1. Start in 412x915 and block the first `cast.jpg` response after its poll has
   captured the initial epoch.
2. Apply 915x412. Its first settle acknowledgement is false and remains
   blocked.
3. Queue a return to 412x915, then release the first acknowledgement and the
   already-fetched JPEG. Remaining acknowledgements settle.
4. Require at least one promoted frame before a second polling interval.

`5eee3522e` produces zero frames because the original fetched frame is stale
when the shared tail releases. It is marked TODO/expected-fail by default; set
`PDPP_ACCEPT_FIRST_FRAME_ORACLE=1` to make the assertion a normal acceptance
gate. The same scenario passed against `e869d8531`, where the frame emits
independently of the presentation tail.

## Recommended fix direction

Keep the safety invariant that a frame must not represent an unacknowledged
screen size, but separate it from liveness: coalesce presentation mutations to
the latest requested viewport and guarantee an immediate fresh-frame
opportunity when that latest epoch settles. A stale pre-mutation JPEG may be
discarded, but its discard must trigger (or be replaced by) a fetch for the
settled epoch rather than relying on another polling interval while viewport
changes can continue. The oracle is the acceptance boundary; this analysis
does not choose an implementation.
