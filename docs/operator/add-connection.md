# Add a data source

Status: reference-experimental operator surface. Not PDPP Core or Collection
Profile protocol.

This is the operator's entry point for adding a data source to your own
reference instance. A *connection* is one configured source — "Gmail personal",
"Codex on this laptop", "Chase card account" — not a protocol object. You add
connections through owner-mediated setup, not by editing deployment environment
variables.

Normal setup does **not** require connector-specific per-account environment
variables. A self-hosted operator — Docker host, RunPod, Railway, Fly, or VPS —
should never have to edit a service's env vars to add one mailbox or one account.
Source credentials are captured through owner-mediated setup flows and, where
needed, sealed in encrypted instance-scoped storage. The env-var paths still
exist as compatibility fallbacks and local development escape hatches; they are
documented as such below, not as the normal path.

## Three ways to add a source

All three surfaces read the same shared setup planner, so they give you the same
honest answer for any connector: what you can do now, which owner step is
required, what prerequisite is missing, and when the connection becomes active.

### Console (browser, owner session)

1. Open `/dashboard` on your instance and sign in as owner.
2. Open **Connect** or click **Add source** from the Sources page.
3. Search for the provider or scan the source cards. Each card shows one source
   name, one support status, and one next action.

The Connect page is intentionally not a runbook dump. A ready source links to
the protected setup form or collector enrollment. A deployment-blocked source
links to deployment readiness. A proof-gated or unsupported source stays visible
with the reason and, where useful, a runbook path. Repeat the same setup with a
new display name to add another account.

The console never deep-links a setup the reference cannot complete, never hides
a shipped connector just because setup is not ready, and never shows a working
connection before a real source binding has been proven.

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
the same catalog and plan from the CLI:

```sh
pdpp owner-agent connectors list --entrypoint https://your-instance.example
pdpp owner-agent connectors search gmail --entrypoint https://your-instance.example
pdpp owner-agent connectors explain gmail --entrypoint https://your-instance.example
pdpp owner-agent setup <connector-id> --entrypoint https://your-instance.example
```

Use `connectors list/search/explain` to discover connector IDs and preview the
next step without minting setup material. Use `setup --display-name` to start
the owner-mediated flow and carry the owner-facing label for the connection
being set up. The CLI prints support state, setup modality, deployment blockers,
and the next owner step; it sends the owner bearer only as an `Authorization`
header and never prints it.

## Deployment readiness vs. connection setup

Deployment environment variables configure instance-level runtime facts —
database URL, public origin, owner auth/session, AS/RS ports, and the credential
key provider (`PDPP_CREDENTIAL_ENCRYPTION_KEY` or
`PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE`). They are not the path for adding one
mailbox or one account.

If a connector needs platform-level provider app material (for example, an OAuth
client id/secret owned by your deployment), the setup plan reports that the
deployment is not ready yet and tells you what instance-level configuration is
missing. Once that platform config exists, per-account authorization happens
through an owner setup step — not by adding another per-account env var.

So there are two distinct kinds of blocker, and the setup surfaces keep them
apart:

- **Deployment-readiness blockers** — instance-level configuration the operator
  sets once (origin, credential key provider, future provider app material).
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

The one static-secret variable that is genuinely instance-level is the
credential key provider: either `PDPP_CREDENTIAL_ENCRYPTION_KEY` or a mounted
secret file referenced by `PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE`. Railway
templates generate `PDPP_CREDENTIAL_ENCRYPTION_KEY` automatically. Docker users
can let `scripts/generate-secrets.sh --write` fill it into `.env.docker`, or
mount a secret file and set `PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE`. Without one
of these providers, the static-secret setup page blocks before accepting a
provider credential and the capture route fails closed without writing a draft
or storing plaintext.

Static-secret forms are generated from connector manifests. If a connector needs
a non-secret account identifier, such as a mailbox address, the manifest declares
that field and the console renders it; the RI console does not carry
connector-specific form knowledge.

## Related

- [`docs/operator/selfhost-quickstart.md`](selfhost-quickstart.md) — stand up the
  instance these connections live on.
- [`docs/operator/local-collector-runbook.md`](local-collector-runbook.md) —
  the device-enrollment + collector run path for Claude Code / Codex.
- `openspec/changes/complete-self-service-connection-onboarding/` — the change
  that defines the shared setup engine these surfaces consume.
