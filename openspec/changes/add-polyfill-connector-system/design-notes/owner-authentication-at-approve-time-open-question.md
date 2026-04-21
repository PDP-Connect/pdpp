# Open question: owner authentication at device-approve time

**Status:** open
**Raised:** 2026-04-20
**Trigger:** Minting an owner token for a LAN coding agent exposed that `POST /device/approve` on the reference AS accepts any request, from anywhere, with no authentication, and lets the caller bind the issued token to any `subject_id` they choose. A 6-hex user_code and an open approve endpoint are the only gate between "reachable on the network" and "full owner-scope bearer token."

## What the reference currently does

`reference-implementation/server/index.js:1054`:

```js
app.post('/device/approve', async (req, res) => {
  const userCode = req.body.user_code;
  const subjectId = req.body.subject_id || 'owner_local';
  if (!userCode) return oauthError(res, 400, 'invalid_request', 'user_code is required');
  await approveOwnerDeviceAuthorization(userCode, subjectId);
  // ... renders "Approved" HTML
});
```

No session check, no bearer check, no CSRF token, no rate limit. `subject_id` is caller-supplied. The user_code is 6 hex chars from `randomBytes(3)` = 24 bits of entropy, ~15-minute TTL.

Combined with the AS binding to `0.0.0.0` in dev, this means: **anyone who can reach the AS can approve a live device-authorization and mint a bearer token as any subject they name.**

## Why this is a spec-level question, not a code fix

RFC 8628 (the device-authorization grant the reference implements) explicitly delegates owner authentication to the AS. Section 3.3:

> The authorization server SHOULD display the verification URI in a textual form appropriate for the end user to enter. ... The authorization server MUST authenticate the user before approving the request.

"MUST authenticate" is the spec's only requirement here, and it says *what* to do (authenticate) without saying *how*. The how is AS-defined. That means PDPP needs to either:

1. Adopt a specific authentication mechanism in-spec, so every PDPP implementer is told how owners authenticate at approve time, or
2. Declare that this is implementer-private and require implementer statements to document their authentication approach.

Either is valid; "neither" is what the reference ships today, and it silently violates RFC 8628's MUST. From `openspec/changes/reference-implementation-program/design.md` §3: *"PDPP-specific work should only define the missing glue."* Owner authentication at approve-time is the missing glue between RFC 8628 and a working PDPP AS.

## What gets violated when approve is unauthenticated

1. **Owner agency.** The whole point of device-flow in PDPP is "an agent wants access, the owner decides." If anyone can approve, the owner has been removed from the decision.
2. **Subject binding.** Caller-supplied `subject_id` lets an attacker mint tokens as any subject. Grants tied to that subject-token now belong to the attacker.
3. **Audit integrity.** Spine events record approvals as the owner's action. An unauthenticated approve endpoint produces spine events that *look* owner-authored but aren't.
4. **Scope boundary.** Once a token is minted, all existing grant-scope enforcement in the RS operates on the assumption that the token-holder is the owner (or delegated by the owner). That assumption is unfounded.

## Threat scenarios (ordered by plausibility)

### A. LAN adversary on a shared network
Attacker on the same Wi-Fi as a dev laptop running the reference. Scans the local subnet for open 7662. Polls `/oauth/device_authorization` every few seconds to keep seeding user_codes, or races the legitimate CLI's user_code. 24 bits of entropy × ~15 min × ~10,000 guesses per second = full-space search in hours if the same code is re-queryable; negligible if user_codes are single-shot.

**Mitigating factor today:** user_codes are one-shot (approve → marked used). **Aggravating factor:** attacker can initiate their *own* device_authorization at any time and instantly know a valid user_code.

That second point is the hole. Attacker POSTs `/oauth/device_authorization` as client_id=owner-bootstrap, gets back their own user_code, immediately POSTs `/device/approve` with that code and `subject_id=owner_local`, completes `/oauth/token`. Token is minted. No owner interaction, no user_code guessing required.

### B. Cross-site attack from an open tab
Owner visits a malicious page in the same browser they'll later use for PDPP. Page issues a cross-origin POST to `http://localhost:7662/device/approve`. Without CORS or CSRF protection, the request succeeds. Token is minted to the attacker's pre-seeded device_authorization. Attacker polls `/oauth/token`, gets the bearer, exfiltrates RS data.

### C. Supply-chain / local process
Any process on the dev box (or any container with host networking) can mint tokens at will. Not unique to this bug, but worth noting that any approve-time authentication should also consider "process on the box isn't necessarily the owner."

## What the spec could require

### Option A — Mandate browser-session authentication at `/device/approve`
The AS MUST establish an owner session (cookie-bound, issued after some authentication event) before rendering the approve UI. The approve endpoint MUST reject any request without a valid owner session cookie.

- Pro: matches the RFC 8628 MUST. Matches what every production OAuth AS does. Usable via a browser.
- Con: requires the reference to ship a login flow. What form? Password? Passkey? Magic link? That's a design question the spec has to land.

### Option B — Mandate a bootstrap secret for first-run, then session for subsequent approvals
First run of the AS prints a one-time bootstrap secret to the console. The very first `/device/approve` requires that secret in a header. That bootstrap flow issues the owner a persistent credential (password, passkey) which is used for subsequent approvals.

- Pro: solves the "headless server, no browser" dev case; doesn't require picking a login UI yet.
- Con: introduces a phase distinction (bootstrap vs normal) that implementers have to get right. Bootstrap secrets leak in console logs.

### Option C — Mandate loopback-only approve + OS-level auth for CLI
The approve endpoint MUST bind to 127.0.0.1 (or a Unix socket), never a public interface. CLI clients authenticate by OS user (reading the socket that only the owner's UID can access). Browser-driven approval requires an SSH tunnel or localhost browser.

- Pro: simple, honest for single-user local. Aligns with "owner = the OS user running the server."
- Con: breaks any remote-owner use case (owner on laptop, AS on home server). That's a real case.

### Option D — Declare implementer-private; add conformance test
The spec says "AS MUST authenticate the owner per RFC 8628." Reference ships something (one of A/B/C) as an example. Implementers are required to document their authentication in their implementer statement, and to pass a conformance test that demonstrates unauthenticated approve is rejected.

- Pro: minimum spec surface; maximum flexibility.
- Con: the reference keeps its own gap unless it picks something — and the reference is what sets the community expectation.

### Option E — Do nothing, document the dev-only posture
Keep today's behavior. Ship a big `DEV ONLY — DO NOT EXPOSE TO A NETWORK` warning. Require a flag (`--dangerously-disable-owner-auth`) for anyone who wants the current behavior.

- Pro: ships today's bug as an explicit feature with a scary name.
- Con: dodges the actual question. RFC 8628 says MUST. A reference implementation that's explicitly non-conformant to the RFC it cites isn't a reference.

## Trade-offs to weigh

- **Developer ergonomics.** Every option above adds friction to the bootstrap CLI case (minting owner tokens for local scripts). The friction is the point — unauthenticated approve is what makes the current experience frictionless and unsafe. A good answer finds ergonomics inside authentication, not around it.
- **Multi-owner futures.** Today's reference is single-owner. A spec answer should accommodate multi-tenant implementations without re-opening the same hole.
- **CLI vs browser asymmetry.** Browser OAuth has century-old patterns (sessions, CSRF tokens, SameSite cookies). CLI has `ssh-agent`-style patterns (OS-level trust) and device-code itself (user reads a code on one device, approves on another). The spec should probably recognize both as valid approve surfaces and specify authentication for each.
- **LF / regulator review.** A protocol claiming owner agency that ships an unauthenticated approve endpoint will not survive a security review. This is not a "nice to have."

## What the reference should probably do in the meantime

The reference impl has three options that don't require deciding the spec today:

1. **Bind the AS to 127.0.0.1 by default**, require explicit opt-in for LAN exposure. The honest default.
2. **Add a shared-secret header check on `/device/approve`**, shared-secret printed to the server console on startup. Workaround but visible.
3. **Keep the gap, add a warning banner on server startup**, treat as a known open gap tracked by this note. The least honest option but matches current reality.

Any of these is reversible once the spec decision lands.

## Cross-cutting

- `credential-storage-open-question.md` — if the owner has a persistent authenticator (password, passkey), where does it live? Adjacent, not duplicative.
- `credential-bootstrap-automation-open-question.md` — the first-run bootstrap story interacts with Option B above.
- `rs-storage-topology-open-question.md` — tokens live in the AS DB. Topology decisions affect how compromised tokens are revoked at scale.
- `owner-self-export-open-question.md` — self-export assumes an authenticated owner. Approve-time authentication is the precondition.

## Action items

- [ ] Decide A/B/C/D/E, scoping to reference-implementation *and* to what the spec says about conformant ASes.
- [ ] Regardless of long-term answer: bind the reference AS to 127.0.0.1 by default. This is a one-line change and closes the LAN attack window.
- [ ] Add a conformance test: "POST /device/approve without authentication MUST be rejected."
- [ ] Audit existing spine events for any approvals that might have been unauthenticated. If the reference has ever been exposed to a network, this is a retrospective question.

## Why this note and not "just fix it"

The fix depends on the spec answer. Binding to 127.0.0.1 is a safe stopgap but doesn't answer "how does a remote owner approve?" Shipping a login UI is the right long-term answer but requires deciding whether password / passkey / magic link / OIDC-to-a-parent-idP is the expected path. Shipping a bootstrap secret is a middle ground that still needs design work for the persistent-credential handoff.

"Just fix it" is what gets you a login form that prejudges the spec. The right move is to name the hole as a spec gap, stopgap with the safe default (127.0.0.1 bind), and let the spec answer the bigger question on its own timeline.
