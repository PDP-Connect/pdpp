# Add a connection

Status: reference-experimental operator surface. Not PDPP Core or Collection
Profile protocol.

This is the operator's entry point for adding a connection to your own reference
instance. A *connection* is one configured source — "Gmail personal", "Codex on
this laptop", "Chase card account" — not a protocol object. You add connections
through owner-mediated setup, not by editing deployment environment variables.

Normal setup does **not** require connector-specific per-account environment
variables. A self-hosted operator — Docker host, RunPod, Railway, Fly, or VPS —
should never have to edit a service's env vars to add one mailbox or one account.
Source credentials are captured through owner-mediated setup flows and, where
needed, sealed in encrypted instance-scoped storage. The env-var paths still
exist as compatibility fallbacks and local development escape hatches; they are
documented as such below, not as the normal path.

## Three ways to add a connection

All three surfaces read the same shared setup planner, so they give you the same
honest answer for any connector: what you can do now, which owner step is
required, what prerequisite is missing, and when the connection becomes active.

### Console (browser, owner session)

1. Open `/dashboard` on your instance and sign in as owner.
2. Use **Add a connection**. The picker lists every shipped connector.
3. Pick a source. The picker leads with the connectors that set up here in one
   step; everything else lives under **Other connectors**, grouped by the next
   step it still needs.

What each group means:

- **One-step (local collector).** Filesystem-class collectors (Claude Code,
  Codex) enroll in one step. The link opens the device-enrollment form
  pre-selected; you then run the collector on the host that holds the data. The
  connection activates when the enrolled collector ingests.
- **Manual browser-collector setup.** A connector (Amazon today) for which the
  console can mint a `browser_collector` enrollment code, but the run is finished
  by you against a real local browser session. This is an owner-run proof path,
  not a one-click browser flow. See
  [`docs/operator/browser-collector-proof-runbook.md`](browser-collector-proof-runbook.md).
- **Browser-bound — owner-run setup.** A browser-bound connector with no
  generated console path yet. It is visible and honest; it points at the runbook
  rather than offering a button the reference cannot complete.
- **Static-secret — owner-session setup.** Network sources whose first connection
  is created from the owner session: create a draft, paste a provider secret (a
  Gmail app password or a GitHub token) once, and the connection activates on its
  first successful ingest. The console opens a one-page owner-session form for
  this path and starts the first sync after capture. The runbook remains the
  proof/debug reference:
  [`docs/operator/static-secret-connection-runbook.md`](static-secret-connection-runbook.md).
- **Not supported from the console yet.** Network sources with no owner connect
  route at all. They are listed honestly with the reason, not hidden.

The console never deep-links a setup the reference cannot complete, and never
shows a working connection before a real source binding has been proven.

### Owner agent / REST

A trusted owner agent — or a human using owner-bearer REST — calls:

```
POST /v1/owner/connections/intents
```

and receives the same setup plan and next-step contract the console renders. The
agent can initiate setup, explain the next step, receive owner-openable URLs and
setup codes, and poll non-secret status.

The owner agent **never** receives provider credentials, owner cookies, app
passwords, provider access tokens, browser session cookies, or grant-scoped MCP
bearers. Secret-bearing steps are handed off to an owner-session surface (the
console or the owner-session runbook), not completed by the agent. This keeps
owner setup/control surfaces separate from grant-scoped MCP/read surfaces; `/mcp`
continues to reject owner bearers.

### CLI

After owner-agent onboarding, a human or trusted local owner agent can ask for
the same plan from the CLI:

```sh
pdpp owner-agent setup <connector-id> --entrypoint https://your-instance.example
```

Use `--display-name` to carry the owner-facing label for the connection being
set up. The CLI prints support state, setup modality, deployment blockers, and
the next owner step; it sends the owner bearer only as an `Authorization` header
and never prints it.

## Deployment readiness vs. connection setup

Deployment environment variables configure instance-level runtime facts —
database URL, public origin, owner auth/session, AS/RS ports, and the credential
encryption key (`PDPP_CREDENTIAL_ENCRYPTION_KEY`). They are not the path for
adding one mailbox or one account.

If a connector needs platform-level provider app material (for example, an OAuth
client id/secret owned by your deployment), the setup plan reports that the
deployment is not ready yet and tells you what instance-level configuration is
missing. Once that platform config exists, per-account authorization happens
through an owner setup step — not by adding another per-account env var.

So there are two distinct kinds of blocker, and the setup surfaces keep them
apart:

- **Deployment-readiness blockers** — instance-level configuration the operator
  sets once (origin, encryption key, future provider app material).
- **Per-connection owner actions** — the next owner step for one specific
  connection (enroll a collector, run a browser proof, capture a static secret).

## Env vars are a fallback, not normal setup

`.env.docker.example` still lists connector-specific source variables
(`GMAIL_APP_PASSWORD`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `YNAB_PERSONAL_ACCESS_TOKEN`,
and similar). These remain only as:

- a **compatibility fallback** for operators who already drove a connector this
  way, and
- a **local development escape hatch** for testing a single connector against the
  Docker-managed stack.

They are not how you add a normal connection, and they do not scale to multiple
accounts of the same connector — two Gmail mailboxes are two owner-mediated
connections with separate stored credentials, not two env vars. Prefer the
console or owner-agent flow above.

The one variable that is genuinely instance-level is
`PDPP_CREDENTIAL_ENCRYPTION_KEY`: it seals owner-captured static-secret
credentials at rest and is set once per deployment, not per connection. Without
it, a static-secret capture fails closed and no plaintext is stored.

## Related

- [`docs/operator/selfhost-quickstart.md`](selfhost-quickstart.md) — stand up the
  instance these connections live on.
- [`docs/operator/local-collector-runbook.md`](local-collector-runbook.md) —
  the device-enrollment + collector run path for Claude Code / Codex.
- [`docs/operator/static-secret-connection-runbook.md`](static-secret-connection-runbook.md)
  — the owner-session draft → capture → first-ingest sequence for Gmail / GitHub.
- [`docs/operator/browser-collector-proof-runbook.md`](browser-collector-proof-runbook.md)
  — the owner-run browser-collector proof path.
- `openspec/changes/complete-self-service-connection-onboarding/` — the change
  that defines the shared setup engine these surfaces consume.
