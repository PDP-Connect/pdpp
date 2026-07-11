# Position: Persistence and self-sovereignty (where the grant lives)

**Status:** v0.1 is server-anchored; user-held custody is a designed-for future direction.

## Asked as

- "Does PDPP work if the user is the sole entity storing their consent artifacts?"
- "What if Alice wants to keep grants on her phone, not S3 or a blockchain?"
- "What is PDPP's persistence story, beyond 'chain-specific infrastructure is out of scope'?"
- "Is PDPP actually self-sovereign, or server-of-record dressed in self-sovereign language?"

## Short answer

Storage location and trust anchor are separate concerns. In v0.1 the authoritative grant
lives at the authorization server that issued it, and the resource server enforces access
by introspecting it; a copy on the user's device is useful for inspection but is not what
gets enforced. So "Alice keeps it on her phone" already works but is not load-bearing.
A model where the user is the *sole* custodian and no server holds authoritative state is
**not** the present v0.1 design — that is what signed grants (designed-for, deferred) would
enable.

## Why it's true

- **Three concerns usually conflated, separated:**
  - *Storage/availability* — who holds a copy. Free choice (phone, S3, chain, handed to a
    verifier); no bearing on trust.
  - *Verification* — "is this exactly what was approved?" A signed grant carries its own
    integrity (a signature checkable against the issuer's public key), so once signing
    lands it can live anywhere and a live AS is not needed to verify. This is the
    signed-JWT pattern from ordinary OAuth.
  - *Validity/freshness* — "is it still in force?" The only piece that still needs a live
    component, and it need not be the AS: a short expiry (bounded staleness, no live
    component), or a published revocation/status list the verifier checks (hostable
    anywhere, replicable).
- **v0.1 trust model is server-anchored.** The RS validates each request against live grant
  state via introspection (RFC 7662) or a co-located equivalent; revocation propagates
  within the introspection cache window (`min(token_exp, 60s)`, `spec-core.md` L925).
  Self-contained JWTs are allowed as an optimization but MUST NOT be the sole revocation
  mechanism.
- **The chain remark is coherent, not evasive.** A blockchain is one possible
  always-available, issuer-independent status/revocation host — one option, not a
  requirement. That is the precise sense in which chain-specific infrastructure is out of
  scope.
- **It can still be user-controlled.** A user-operated personal server may co-locate the AS
  and RS and store the grant locally. "User-owned" is satisfied by who runs the server, not
  by the user holding an offline-only copy.

## What we do NOT claim

- We do **not** claim grants are cryptographically bound today. The spec says "designed to
  be signable"; signing, a formal token format, presentation, and delegation flows are
  deferred (`spec-core.md` L1383). External material that says "cryptographically bound and
  not modifiable after issuance" overstates v0.1 — and is what generates reviewers'
  persistence questions. Fix the source doc.
- We do **not** claim the sole-custodian / no-authoritative-server model works in v0.1.
- We do **not** claim signing removes the AS entirely — it removes the *live* AS from
  verification, but the AS remains the issuer and trust root, and revocation still needs a
  live status source (which can be non-AS).

## Design fork (genuinely open, good collaboration topic)

For signed `continuous` grants, the freshness/revocation model is unspecified: short expiry
+ reissue, a published status list (e.g. W3C StatusList-style), or live introspection. This
is the substance of "PDPP's persistence story more generally" and a natural place for
outside input from distributed-trust researchers.

## References

- `apps/site/content/docs/spec-core.md` — introspection / co-located equivalent (L1375), revocation cache window (L925/L1377), short-lived + refresh for continuous (L1379), grant integrity / "signable, deferred" (L1383).
