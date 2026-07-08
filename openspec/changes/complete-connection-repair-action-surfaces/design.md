## Context

Archived change `define-connection-repair-routing` established the boundary: manifests declare stable setup and automation mechanisms; live repair routing comes from observed runtime evidence and connection-scoped health conditions. The implementation has part of that boundary already:

- browser-session-bound connections do not fabricate `credential_required` from an absent stored credential row;
- static-secret-bound connections still route missing/rejected credentials to credential capture;
- connection detail pages prefer browser-session binding before connector-level static-secret capability.

The missing piece is the shared rendered action. `RequiredAction.kind = "reauth"` is too coarse for routing and labeling. It says the owner must repair authentication, but not whether the repair surface is stored credential capture, browser session, provider interaction, local device, or another bounded surface.

The July ChatGPT failures showed the rest of the lifecycle problem:

- a scheduled browser-backed connection can fail with bounded evidence that the provider session is inactive;
- a second connection of the same connector type can have different binding and schedule state;
- historical attention rows can remain useful audit records while no longer being current owner work;
- a timed-out owner prompt can hide the prompt but cannot prove the connection is repaired;
- if automation ignores the rendered repair state, it can keep launching failed hourly runs instead of presenting one stable repair action.

This is not just bad code from one connector. Session expiry, provider prompts, browser-surface loss, local-device backlog, and recoverable detail gaps are normal conditions for polyfill connectors. The design goal is to make those recurring conditions low-maintenance: one correct action, on the existing connection, with bounded automation while the owner is not present.

## Decision

Add a small, stable owner-action surface discriminator to the shared projection:

- `stored_credential`: the owner provides or rotates a stored credential for this existing connection.
- `browser_session`: the owner re-establishes an authenticated browser/session proof for this existing connection.
- `provider_interaction`: the owner completes provider-side interaction such as an approval, OTP, consent, or challenge.
- `local_device`: the owner acts on a local collector/device.
- `runtime_retry`, `schedule`, `maintainer`, and `none`: non-secret non-navigation classifications for existing action families.

The discriminator is evidence-derived, not manifest-derived. Manifests can still declare setup mechanisms; they do not decide the live route for a current repair request.

### Current owner action

A durable attention row is not the same thing as current owner work. Attention rows are history plus in-flight state. A row may affect the current health projection only when all of these are true:

- the row is open, unexpired, and not superseded by newer evidence for the same connection generation;
- the row is owner-satisfiable, not maintainer-only or purely informational;
- the row's required action still has a non-`none` satisfaction contract;
- no newer readiness, repair, run, schedule, or connection evidence proves the same action is satisfied or obsolete.

Expired, resolved, or cancelled rows remain audit evidence. They SHALL NOT drive the primary CTA, headline attention count, or scheduler suppression. They also SHALL NOT heal the connection by themselves. If a browser session is still inactive after an owner prompt expires, the current repair state comes from the session-readiness evidence, not from the expired row.

### Repair completion

Repair always targets the existing `connection_id`. A repair SHALL NOT create a replacement connection unless the owner explicitly starts setup for a new source. When repair succeeds, the reference preserves schedules, grants, records, retained stream state, and run history. If the schedule was enabled before the repair-needed state, it resumes on the same connection after a bounded confirmation run. If the schedule was disabled, repair does not silently enroll it; the owner or existing policy must enable it.

This matters for duplicate connector types. Two connections for the same connector may have different source bindings, schedules, and repair surfaces. All repair routing, scheduler suppression, schedule reattachment, and post-repair confirmation MUST be keyed by `connection_id` / `connector_instance_id`, not by `connector_id`.

## Preserve Existing Improvements

Do not revert the static-secret repairs that were added for true missing/rejected stored credentials. A static-secret-bound connection with no usable credential still needs credential capture. A browser-session-bound connection with no credential row still needs browser-session repair. A static-secret-capable mixed connector whose run reason says `session_required` needs browser/session repair for that failure, not a password update.

The reference SHALL NOT treat a password typed into a provider-owned browser page as a stored PDPP credential unless the owner explicitly uses a stored-credential capture flow. Browser-session repair captures session state or session proof needed for that connector; stored-credential update captures an explicit static secret. The UI must label these as different actions.

## UI Rule

Owner console surfaces SHALL use the rendered action surface when present. They may keep fallback route inference only for compatibility with older reference payloads.

The primary action label should come from the same rendered action. Static-secret repair uses credential capture/update copy. Browser-session repair uses reconnect/session copy and routes to the secure browser repair flow. Provider interaction uses prompt/approval copy. Local-device repair uses local collector/device copy. Surfaces SHALL NOT show competing buttons that imply two different repairs for the same underlying condition.

Run and repair stream pages must be actionable while repair is current. A current browser-session repair SHALL NOT strand the owner on "no browser action is waiting" if the run is still preparing, registering, or recovering its browser-surface assistance. If no browser surface can be registered, the repair surface must say that directly and keep the same repair action visible.

## Background Automation Rule

Scheduled automation SHALL consult the same rendered owner-action projection before launching. When the current rendered verdict has an urgent owner-satisfiable repair action (`reauth` or `add_info`), the scheduler treats that action as unresolved owner attention and skips the automatic run until the action is satisfied. It SHALL NOT invent a second durable attention row for terminal run evidence; the terminal run, connection health projection, and rendered verdict remain the source of truth. Non-blocking owner accelerants such as `refresh_now` and `retry_gap` SHALL NOT suppress automation.

The scheduled path SHALL NOT start owner-mediated repair. It records bounded evidence, synthesizes a stable repair action, and waits. The owner-attended path performs the repair. After repair, the controller may run exactly one bounded confirmation run and then resume the configured schedule if schedule policy allows it.

## Past Defect Versus Future Product Reality

This change fixes defects in the current code:

- session-required evidence was collapsed into stored-credential repair;
- owner surfaces could infer the wrong repair route from connector capabilities;
- repeated scheduled runs could continue after the current verdict already said the owner must repair the connection;
- historical attention rows could be confused with current actionability;
- duplicate connector instances could be reasoned about too coarsely at connector-type level.

It also specifies expected future behavior. Browser sessions will expire. Providers will sometimes ask for approval, OTP, or a challenge. Local collectors can fall behind. A connector can have recoverable gaps. Those states are allowed, but the reference must turn them into a bounded current action, wait state, or maintainer state without asking the owner to guess.

## Acceptance Checks

- Stored credential missing/rejected conditions project `surface.kind = "stored_credential"`.
- Session-required failures project `surface.kind = "browser_session"` and do not assert provider credential rejection.
- Rendered `reauth` actions carry the selected surface.
- Connection detail primary repair links route to static-secret capture for `stored_credential` and browser-session repair for `browser_session`.
- Scheduler pre-run gating suppresses repeated automatic runs when the rendered verdict already carries urgent owner-satisfiable repair, including restart-safe cases where no in-memory needs-human flag exists.
- Static-secret repair copy says credential update/capture rather than generic reconnect.
- Expired/resolved/cancelled attention rows do not drive current health, primary CTA, or scheduler suppression.
- A timed-out owner prompt does not make the connection healthy unless current readiness evidence proves repair.
- Two connections of the same connector type preserve independent repair surface, schedule state, and confirmation outcome.
- A successful browser-session repair leaves the existing connection scheduled according to its prior schedule/policy and proves collection with a bounded confirmation run.
- A current browser-session repair route never strands the owner on a generic no-action-waiting page when browser assistance is still being prepared or when browser-surface registration failed.
