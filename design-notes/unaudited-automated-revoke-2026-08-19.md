# The only revoke nobody records is the one nobody chose

**Status:** diagnosed on the live instance 2026-08-19. Fix not written.

## What happened

Venmo disappeared from the sources page between two reads. Its
`connector_instances.status` was `revoked`. No spine event explained it, and I
could not find one by searching every event shape I could think of.

The absence was the finding.

```
created_at:            2026-08-19T01:10:57.658Z
enrollment_expires_at: 2026-08-19T03:10:57.658Z   (created + exactly 2h)
revoked_at:            2026-08-19T03:11:24.425Z   (27s after expiry)
source_binding_json:   {"kind":"browser_enrollment_shell", ...}
```

`BROWSER_ENROLLMENT_SHELL_TTL_MS` is two hours
(`routes/ref-browser-enrollment-shell.ts:48`). The delta matches exactly, and
the 27-second lag is the maintenance tick that runs the retirement sweep. Venmo
was never a connection — it was enrollment scaffolding that expired before the
browser login ever completed.

## The defect

`retireExpiredBrowserEnrollmentShells`
(`browser-enrollment-shell-retirement.ts:73-84`) calls `store.updateStatus(...)`
and emits nothing.

Every owner-initiated revoke path takes an `emitSpineEvent` or `emitShellAudit`
dependency: `owner-connection-revoke.ts`, and the abandon path in
`ref-browser-enrollment-shell.ts`. Both leave a record.

So the system's audit trail covers exactly the revocations a human chose and
remembers making, and omits the one that happens on a timer while nobody is
watching. That is backwards. A state change the owner did not initiate is the
one they most need explained — and the row is then hidden from the sources list
(`connector-instance-store.ts:1966`), so the connection simply vanishes with no
account of why.

This is variant two of `failure-diagnosability-2026-08-18.md`: a change nothing
reports. It cost a full investigation to recover a fact the sweep already knew
at the moment it acted.

## The fix

Emit an audit event from the retirement sweep, naming the shell, its expiry,
and the TTL that governed it. The sweep already has every field; it just
discards them.

## The second trap

`POST /v1/owner/connections/:id/reactivate` sets `status='active'` and clears
`revoked_at`, but leaves `source_binding_json` as an expired enrollment shell.
The sweep's predicate (`enrollmentShellExpired`, lines 32-46) matches `draft` or
`active` shells with a past expiry — so the next tick re-revokes it.

Reactivating an expired shell is a loop. The honest path is to discard it and
enroll fresh, completing the browser login inside the TTL so the binding
promotes to `browser_collector`, which is TTL-exempt by construction. Either
reactivate should refuse an expired shell with that explanation, or it should
re-arm the TTL. Silently restoring a row the sweep will immediately take back
is the worst of the three.

Read from the predicate, not executed — testing it would mean mutating live
state.

## Related

`failure-diagnosability-2026-08-18.md` — the three variants.
