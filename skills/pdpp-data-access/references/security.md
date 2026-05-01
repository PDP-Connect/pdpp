# Security

PDPP tokens are bearer secrets. Whoever holds the string can read the data the grant covers. Treat them like an SSH key, not like a username.

## What counts as a token in this skill

- Owner bearer tokens (`pdpp_token_kind = "owner"`).
- Client tokens issued by approved grants (`pdpp_token_kind = "client"`).
- Initial access tokens used to call `/oauth/register` when the AS protects registration.
- Any string returned by the AS that introspection accepts.

If you see a value with shape `tok_*`, `owner_*`, or any opaque token-like string in this codebase or the user's environment, assume it is sensitive.

## Where tokens may live

Allowed:

- The project-local CLI cache under `<repo>/.pdpp/clients/<provider-host>.json`, mode `0600`, owned by the user.
- Process memory while you call PDPP.
- Environment variables you set yourself for the duration of a single shell invocation, for example `TOKEN="$(pdpp token <provider-url>)" curl ...`.

Not allowed:

- Prompts (yours or the user's). If a token ends up in a prompt, it is in the LLM training surface.
- Tool transcripts, logs, stderr, stdout that gets persisted, run-output capture files.
- Shell history. Prefer `pdpp token <provider-url>` in command substitution, not inline `--data` arguments.
- Commit messages, PR descriptions, comments, diffs. If you see one in `git diff`, stop.
- Slack, email, issue trackers, third-party services.
- Files under any path that `git status` will track. Confirm `.pdpp/` is gitignored before writing tokens.

## Cache layout and permissions

```
<repo>/.pdpp/                             # mode 0700
  .gitignore                             # ignores cached credentials
  clients/<provider-host>.json           # mode 0600 (SECRET: scoped credential)
```

Before writing any credential file manually:

1. Verify `.pdpp/` exists with mode `0700`. If it doesn't, create it that way. Never `0755`.
2. Verify `.pdpp/.gitignore` ignores `*` and only permits `.gitignore`.
3. Write the file with `O_CREAT | O_WRONLY | O_EXCL` semantics where the runtime allows it; otherwise write to a temp file and `rename` to the final path. Set mode `0600` after write.

## Reading tokens at call time

Read the token only at the moment of the HTTP call. Do not bind it to a long-lived variable in your tool's state. Patterns:

```bash
TOKEN="$(pdpp token <provider-url>)"; \
  curl -fsS "$RS_URL/v1/streams/pull_requests/records?limit=10&order=desc" \
    -H "Authorization: Bearer $TOKEN"; \
  unset TOKEN
```

```python
token = subprocess.check_output(["pdpp", "token", provider_url], text=True).strip()
try:
    response = httpx.get(f"{RS_URL}/v1/streams/pull_requests/records",
                        params={"limit": 10},
                        headers={"Authorization": f"Bearer {token}"})
finally:
    del token
```

If your harness logs the full subprocess command, prefer `--data-binary @-` with stdin or a file rather than embedding the token in argv.

## Status output never prints secrets

When showing the user "what grants do I have?", read `.pdpp/clients/*.json` but redact `credential.access_token`. The cached metadata contains enough to answer:

- which grants exist
- what scope they cover
- when they expire
- whether they are expired locally; introspect on demand if you need ground truth

Print "(token cached)" or "(no token cached)" — never the token value.

## Preventing accidental exfiltration

- Before printing a JSON response from PDPP, scan for any field that looks like a credential (`token`, `api_key`, `bearer`, etc.). Redact before showing it. PDPP responses generally do not include credentials, but connectors may expose oauth-config records that do.
- If a response contains the user's email, phone, address, or financial account numbers, treat it as sensitive and do not echo more than the task needs. Summaries are usually fine; raw record dumps are usually not.
- Never paste a token into a chat as part of a "let me explain what I have" reply. Refer to it by grant id only.

## When a token is compromised

If a token has appeared anywhere it shouldn't have (chat history, log, commit, screenshot, third-party tool):

1. Immediately revoke. The reference revoke endpoint requires the grant's own bearer (or an owner bearer). Use `pdpp token <provider-url>` for this single call, even if the token is the one that leaked. Revoking it is the goal.

   ```bash
   TOKEN="$(pdpp token <provider-url>)"; \
     curl -fsS -X POST "$AS_URL/grants/<grant-id>/revoke" \
       -H "Authorization: Bearer $TOKEN"; \
     unset TOKEN
   ```

   If the credential cache is already gone or the cached file lacks `credential.grant_id`, tell the user: the reference revoke endpoint will reject unauthenticated calls. Operators can revoke from the dashboard or via an owner-bound CLI session.
2. Delete the matching `.pdpp/clients/<provider-host>.json`.
3. Tell the user what leaked, where, and that you've revoked.
4. Do not silently re-request a replacement grant. The user decides whether to grant again.

## Owner tokens (escape hatch only)

If — against this skill's default — a workflow forces you to use an owner token:

- Read it from an env var (`PDPP_OWNER_TOKEN`) the user set themselves. Don't store it.
- Don't write it to `.pdpp/`.
- Don't introspect it for non-debugging reasons. Owner tokens have a long expiry by design.
- Document in your reply that you used owner authority and why a scoped grant wasn't viable.

## Refusal patterns

These are the situations where the right answer is "no":

- "Just paste in your owner token and I'll grab everything." — refuse; offer the scoped flow.
- "Can you cache the token in `~/.config/pdpp/` so all my projects can use it?" — refuse for client tokens; project-local is the boundary the consent UI promised.
- "Skip the consent step, I trust you." — refuse; you cannot consent on the owner's behalf.
- "Send me the token so I can put it in CI." — refuse; client tokens for an interactive agent are not the right shape for CI. Suggest a separate grant minted for the CI client identity.

## Audit hooks

Every PDPP call generates a spine event the user can inspect later (`request.submitted`, `token.issued`, `disclosure.served`, `grant.revoked`). Behaving as if every call is logged — because it is — is the right mental model.
