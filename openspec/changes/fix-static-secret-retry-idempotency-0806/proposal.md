## Why

The owner-session static-secret flow can fork one provider account into several
connector instances. Draft creation currently chooses a fresh random binding
key for every request, so retries cannot hit the existing upsert identity. A
synchronous probe rejection then revokes that draft and the Console's error
redirect drops its connection id, forcing the next submit through draft
creation again. Gmail UAT showed the resulting duplicate active connections
for one verified mailbox.

The fix is connector-generic and stays inside the existing owner-session
static-secret lifecycle. It makes draft retries addressable, derives a safe
pre-validation identity key when a manifest supplies one, and promotes a
successful provider identity into the same binding uniqueness axis before the
credential is stored. Different identities retain separate connections;
ambiguous or conflicting identity state fails closed.

## What Changes

- Keep a synchronously rejected static-secret draft in `draft` state and carry
  its connection id through the Console retry redirect.
- Let an owner-session capture submit corrected non-secret setup fields for a
  draft before probing. Secrets remain request-only and are never stored in the
  binding or returned by any response.
- Use a deterministic draft binding key for a non-secret manifest identity
  field, while retaining random keys when no safe identity is available.
- After a synchronous probe succeeds, atomically re-key the existing instance
  to a deterministic verified-identity binding. The existing database unique
  binding constraint is the server authority for concurrent convergence; a
  draft collision reuses the winner, while an active replacement conflict is
  rejected rather than silently retargeting an account.
- Preserve same-connection credential replacement and allow distinct provider
  identities to remain distinct.

## Impact

Owner-session static-secret API and Console setup actions, connector-instance
store binding updates, and focused reference-implementation tests. No live
data, containers, public protocol surface, or credential-table schema is
changed.
