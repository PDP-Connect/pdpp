# ChatGPT session-reuse regression closeout - 2026-06-29

Status: sanitized research closeout. This note preserves the durable diagnosis
from scratch workstream reports without retaining local paths, credential
details, raw run timelines, or record payloads.

## Plain-language finding

The regression was a chain, not a single broken selector.

ChatGPT scheduled collection used to work because existing browser surfaces
still held usable authenticated session state. After the browser-surface
transition and a controller restart, newly allocated ChatGPT surfaces did not
reliably receive equivalent durable profile state. That caused scheduled runs to
start from an unauthenticated or partially authenticated page.

A later credential-injection change changed the user-visible symptom. Instead of
failing quietly when no usable session was present, scheduled runs could submit
stored credentials and trigger ChatGPT app-approval notifications. The
notification spike was therefore a secondary effect: it exposed an already
present session-continuity regression.

The owner-observed contradiction was real. The browser stream could look logged
in, while the collector still failed, because the probe and the collector were
not using the same auth truth source. The probe could observe a live
`/api/auth/session`, while the collector still relied on stale DOM bootstrap
state for an authenticated API token.

## Evidence preserved from the scratch reports

- Scheduled ChatGPT runs succeeded without owner assistance before the browser
  surface transition, then hit a failure cliff immediately after fresh browser
  surfaces were created for the same logical profile keys.
- The first session-loss failures predated the change that injected stored
  credentials into scheduled runs, so stored credentials did not cause the
  original loss of reusable session continuity.
- Post-credential-injection failures reached ChatGPT's approval flow because the
  connector attempted credential login after the session was already missing or
  unusable.
- An owner-attended repair run proved immediate page/session reuse could work:
  the next run accepted the API session and completed without another owner
  action.
- A later scheduled run proved the remaining fragility: the initial API-session
  probe passed, but the first authenticated API fetch returned a refresh-required
  failure.
- A browser-evaluation regression was separately proven when a bundled helper
  symbol leaked into the page context; the fix made the auth extractor a
  browser-local expression.
- Later live validation showed repeated scheduled runs completing without owner
  assistance after the repaired extraction and page-preservation path deployed.

## Fix sequence

- Preserve successful ChatGPT pages after collection when the connector opts in.
- Preserve repairable ChatGPT pages after failures instead of destroying the only
  authenticated surface.
- Read ChatGPT auth through a browser-local `/api/auth/session`-first expression,
  falling back to DOM bootstrap data only as a compatibility path.
- Prevent scheduled or unattended runs from repeatedly starting interactive
  credential repair when the session is inactive.
- Suppress expired owner-attention rows before projecting them into current
  operator surfaces.

## Confidence

High:

- The notification spike was caused by scheduled runs attempting credential login
  after reusable session continuity had already failed.
- The logged-in-stream-but-failed-collection contradiction was caused by
  divergent auth truth sources and was fixed by the browser-local
  `/api/auth/session`-first extractor.
- The repeated owner-notification failure mode is addressed by the quiet
  scheduled auth-required gate plus expired-attention suppression.

Medium-high:

- The original continuity cliff was caused by browser profile/surface persistence
  drift. This best fits the timing, the fresh-surface transition, and the repair
  evidence, but the old live containers needed to replay the exact historical
  state no longer exist.

## Product implication

Do not treat "scheduled runs fail quietly" as the whole product answer. The SLVP
target is:

- scheduled runs do not spam the owner;
- the source clearly surfaces when owner repair is required;
- owner repair is explicit and deliberate;
- after repair, the system validates immediate and delayed reuse before calling
  the connection healthy for automatic collection.
