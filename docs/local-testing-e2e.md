# Local end-to-end testing

This document walks through connecting one data source (ChatGPT) into a local PDPP instance, onboarding a trusted owner agent for local exploration, and viewing the data in the included web dashboard.

It is mechanical — follow the steps in order. Each step either succeeds or returns a clear error.

## If you're running this via a coding agent

You can hand this entire doc to your agent and let it execute the steps. There are **three moments** where the agent will need you personally:

1. **ChatGPT login** — a browser window opens so you can complete Cloudflare's "I'm not a robot" challenge if it appears, and sign in if auto-login doesn't succeed. The connector runs with a visible browser (`PDPP_CHATGPT_HEADLESS=0`) for this reason.
2. **Optional 2FA code** — if your ChatGPT account has 2FA, the terminal prints an `INTERACTION` prompt asking for the code. Type it in the same terminal.
3. **Approve owner-agent onboarding** — `pdpp owner-agent onboard` prints a URL like `http://localhost:7662/device?user_code=XXXXXX`. Open it in a browser and click **Approve**. The agent cannot do this for you. **Important**: the CLI blocks until approval, so the agent won't see the URL unless it runs the command in the background. Tell the agent to background the command, read the output for the URL, then give it to you to approve.

Everything else is mechanical.

## Prerequisites

- Node.js ≥ 20
- `pnpm` installed (`npm i -g pnpm` if not)
- Google Chrome recommended for the strongest Patchright stealth posture. If Chrome is absent, the connector falls back to bundled Patchright Chromium installed by `pnpm install`.
- A ChatGPT account (email + password)

Quick sanity check for Chrome on macOS: `ls "/Applications/Google Chrome.app"`. To install Chrome-for-Testing for Patchright explicitly, run `pnpm --dir packages/polyfill-connectors exec patchright install chrome`.

## Repo setup

```bash
git clone git@github.com:vana-com/pdpp.git
cd pdpp
pnpm install
```

`pnpm install` also runs `patchright install chromium` automatically (it's a `postinstall` in `packages/polyfill-connectors`). You'll see a `BEWARE: your OS is not officially supported by Patchright` warning on Linux distributions newer than Ubuntu 24.04 — patchright falls back to the 24.04 build, which works fine.

## Credentials

Create `.env.local` at the repo root:

```bash
cat > .env.local <<'EOF'
CHATGPT_USERNAME=your-chatgpt-email@example.com
CHATGPT_PASSWORD=your-chatgpt-password
EOF
```

This file is gitignored. It stays on your machine.

## Choose a data directory

Pick a path for the local sqlite database. Every step below will use this path.

```bash
export PDPP_DB_PATH="$HOME/.pdpp/local-test.sqlite"
mkdir -p "$(dirname "$PDPP_DB_PATH")"
```

## Run the ChatGPT connector

In one terminal:

```bash
PDPP_CHATGPT_HEADLESS=0 node packages/polyfill-connectors/bin/orchestrate.js run chatgpt
```

`PDPP_CHATGPT_HEADLESS=0` opens a visible Chrome window. It's recommended for the **first run** because ChatGPT's Cloudflare protection may show a challenge that you need to complete manually once. On subsequent runs the cookies persist and you can omit this flag for a headless run.

What happens:
1. An embedded PDPP authorization + resource server starts on two local ports (ephemeral).
2. The ChatGPT manifest is registered.
3. An owner token is minted internally.
4. An isolated patchright Chrome launches against `~/.pdpp/profiles/chatgpt/`.
5. The connector logs into ChatGPT. If 2FA is required, the terminal will print an `INTERACTION` prompt — type the OTP code into the same terminal and press Enter.
6. Conversations, messages, memories, and other streams are extracted and written to `$PDPP_DB_PATH`.
7. The orchestrator prints record counts per stream, then exits.

**Expected duration**: a few minutes for small accounts, an hour or more for accounts with thousands of conversations. You can Ctrl+C once you've seen records accumulate; partial runs are fine for end-to-end testing.

Successful output ends with:

```
[orchestrate] result: status=succeeded records_emitted=<N>
[orchestrate] verifying records in RS:
  ✓ conversations                 100+ record(s)
  ✓ messages                      100+ record(s)
  ✓ memories                      ...
  ...
```

## Start the long-lived PDPP server

Open a second terminal. Export `PDPP_DB_PATH` with the same value you used for the connector run, then start the reference-implementation server pointed at that DB:

```bash
export PDPP_DB_PATH="$HOME/.pdpp/local-test.sqlite"
pnpm reference-implementation:server
```

The server starts on:
- `http://localhost:7662` — authorization server
- `http://localhost:7663` — resource server

Leave this terminal running.

## Onboard a trusted owner agent

Open a third terminal. Still with `PDPP_DB_PATH` exported, run the public
`@pdpp/cli` binary. If you are working from this checkout without an installed
`pdpp` binary, use `node packages/cli/bin/pdpp.js` in place of `pdpp`.

```bash
export PDPP_DB_PATH="$HOME/.pdpp/local-test.sqlite"
pdpp owner-agent onboard http://localhost:7663 \
  --credential-file ~/applications/daisy/.pi/agent/pdpp-owner-agent.json
```

The CLI prints:

```
Verification URI: http://localhost:7662/device?user_code=XXXXXX
User code: XXXXXX
```

**If a coding agent is running this command**, it will block waiting for approval — the agent won't see the output until the command finishes. Run the command in the background or in a separate terminal so you can read the URL immediately, then approve it before the timeout expires.

1. Open that URL in a browser.
2. You'll see an owner-agent approval page.
3. Approve the trusted local owner agent.
4. Return to the terminal. The CLI writes the credential to the `--credential-file` path with restrictive permissions and prints only non-secret status. It does not print the bearer.

Confirm the local credential is active:

```bash
pdpp owner-agent status \
  --credential-file ~/applications/daisy/.pi/agent/pdpp-owner-agent.json
```

The owner-agent credential is operator-grade material for REST/control-plane access to this local server. Keep it on disk, read it only at call time, and never paste the bearer into a coding-agent chat.

## Verify the owner-agent credential works

From the third terminal, before handing off to anything else, confirm the credential can query the local resource server without echoing the bearer:

```bash
CREDENTIAL_FILE="$HOME/applications/daisy/.pi/agent/pdpp-owner-agent.json"
TOKEN="$(jq -r '.access_token' "$CREDENTIAL_FILE")"

curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:7663/v1/streams?connector_id=https://registry.pdpp.org/connectors/chatgpt" \
  | python3 -m json.tool

unset TOKEN
```

You should see a JSON block listing streams with their record counts.

```bash
TOKEN="$(jq -r '.access_token' "$CREDENTIAL_FILE")"

curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:7663/v1/streams/conversations/records?connector_id=https://registry.pdpp.org/connectors/chatgpt&limit=3" \
  | python3 -m json.tool | head -60

unset TOKEN
```

You should see three real conversation records.

## Hand the local credential path to a coding agent

The owner-agent credential you just onboarded is an operator-grade REST
credential. Use it only with a trusted local agent that runs on your behalf — a
coding agent on your own machine, a CLI tool you wrote, or a backup script. It
is **not** the right shape for an ordinary MCP client, and the bearer should not
be pasted into chat.

For routine MCP clients (the public Claude or ChatGPT connectors, third-party
agents, any session you do not personally control), use the scoped-grant flow
described in [`docs/operator/hosted-mcp-setup.md`](operator/hosted-mcp-setup.md)
and the `pdpp connect <provider-url>` CLI command. The hosted `/mcp` endpoint
rejects owner bearers on purpose.

For a quick local self-test through a trusted agent on your own machine, open a
coding agent (Claude Code, Cursor, etc.) and paste the following prompt. The
agent should read the local credential file at call time and never echo the
bearer:

````
I have a locally-running PDPP server. Your job is to explore the data it exposes.

Base URL: http://localhost:7663
Owner-agent credential file: ~/applications/daisy/.pi/agent/pdpp-owner-agent.json

To authenticate, read `.access_token` from the credential file at call time,
include `Authorization: Bearer <token>` on each request, and unset the token
variable immediately after use. Do not print or summarize the bearer.

Connector ID for ChatGPT: https://registry.pdpp.org/connectors/chatgpt

Available endpoints:

  GET /v1/streams?connector_id=<connector-id>
    → Lists the streams available on a given connector, with record counts.

  GET /v1/streams/<stream>/records?connector_id=<connector-id>&limit=100
    → Paginated records. Returns { data: [...], has_more, next_cursor }.

  GET /v1/streams/<stream>/records/<record-id>?connector_id=<connector-id>
    → Fetch one record by its key.

Start by listing streams on the ChatGPT connector, then fetch a few records
from the `conversations` and `messages` streams. Report what you find.
````

The agent can then use `curl`, `fetch`, or its HTTP tool of choice to explore your ChatGPT data through the reference resource-server API.

## Low-level owner self-export debug path

If you are debugging the older owner self-export surface directly, the
repo-local CLI still supports `auth login` and returns an owner bearer. Treat
that as a low-level diagnostic path, not the trusted owner-agent onboarding
path. Do not paste the bearer into a chat transcript; store it in a local
0600 credential file or shell variable, use it for the immediate debug call,
and clear it afterward.

## View the data in the dashboard

Open a fourth terminal and start the web dashboard:

```bash
export PDPP_DB_PATH="$HOME/.pdpp/local-test.sqlite"
pnpm dev
```

Next.js starts on `http://localhost:3002`. Open `http://localhost:3002/dashboard` in your browser.

The dashboard reads from the same PDPP server you started earlier (at 7662/7663) and shows your connector runs, stream inventory, and record samples.

## Stopping everything

- Connector run already exited — nothing to stop there.
- Stop the PDPP server: Ctrl+C in terminal 2.
- Stop the dashboard: Ctrl+C in terminal 4.
- The Chrome process exits when the connector run finishes; nothing extra to stop.
- The sqlite file at `$PDPP_DB_PATH` persists your data. Delete it if you want to start clean.

## Troubleshooting

**`Cannot find package 'express'` when running the server** — `reference-implementation` deps didn't install. Run `pnpm install` again at the repo root; it's now a workspace member.

**`Unknown client_id: pdpp-cli`** — this applies only if you are debugging the older `auth login` self-export path. The owner-agent onboarding flow dynamically registers its local client.

**`Timed out waiting for owner approval`** — the approval window expired before you clicked Approve. Re-run the owner-agent onboarding command.

**`[orchestrate] result: status=failed records_emitted=0` with no reason** — the orchestrator is swallowing the child connector's error. Run the connector directly to see the real error:

```bash
node packages/polyfill-connectors/connectors/chatgpt/index.js <<< '{"type":"START","request_id":"r1","scope":{"streams":[{"name":"conversations"}]},"state":null}'
```

**Connector hangs waiting on `INTERACTION kind=manual_action`** — ChatGPT's Cloudflare protection blocked auto-login and the connector wrote `/tmp/pdpp-interaction-*.json` asking for a manual login. The INTERACTION message file contains the full request; reply by writing a response JSON file as the message describes. Or re-run with `PDPP_CHATGPT_HEADLESS=0` so you can complete the challenge in the visible browser window.

**Ports 7662/7663 already in use** — a previous server is still running. `lsof -i :7662 :7663` to find it, then kill the PID.

**Records don't appear when querying** — confirm both processes are using the same `PDPP_DB_PATH`. The connector run and the server must point to the same sqlite file.

**`BEWARE: your OS is not officially supported by Patchright`** — patchright officially supports Ubuntu 20.04/22.04/24.04. Newer distributions fall back to the 24.04 build. Ignorable.
