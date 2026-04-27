## Why

Agent assistants should not need owner bearer tokens to use PDPP data. The reference already has grant-bound client tokens, PAR-backed consent, dynamic client registration, owner-device login, schema discovery, search, and changes cursors, but the user experience is not packaged for coding agents.

We want a workflow where an agent can request the minimum useful grant for a task, show the owner an approval link, store the resulting client token in a project-local credential cache, and then consume PDPP data effectively without escalating to owner authority.

## What Changes

- Add a reference CLI workflow for agent-scoped PDPP grants.
- Add an ambitious agent skill that teaches coding agents how to discover capabilities, request grants, cache tokens, query safely, renew/upgrade access, and avoid owner-token use.
- Add a project-local credential cache convention for agent clients.
- Publish the skill through stable discovery channels: `/.well-known/skills/index.json`, explicit skill-file URLs, and `llms.txt`/`llms-full.txt` pointers.
- Keep protocol-facing changes explicitly proposed/experimental until they are reviewed against the root PDPP specs.

## Capabilities

Added:
- `reference-agent-access-workflow`

## Impact

- Requires design review across CLI, dashboard approval UX, reference auth, and agent docs/skills.
- Does not finalize new PDPP core semantics in this change.
- Builds on OAuth-style prior art: RFC 8628 device authorization, GitHub CLI browser/device login, and AWS CLI SSO credential caching.
