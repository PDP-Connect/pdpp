# Local end-to-end testing

This document walks through connecting one data source (ChatGPT) into a local PDPP instance, minting an owner token, handing that token to a coding agent for exploration, and viewing the data in the included web dashboard.

It is mechanical — follow the steps in order. Each step either succeeds or returns a clear error.

## Prerequisites

- Node.js ≥ 20
- `pnpm` installed (`npm i -g pnpm` if not)
- Google Chrome installed system-wide (`google-chrome-stable` on Linux, Google Chrome on macOS)
- A ChatGPT account (email + password)

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
4. The browser daemon auto-starts, launching patched Chrome.
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

## Mint an owner token

Open a third terminal. Still with `PDPP_DB_PATH` exported, run:

```bash
export PDPP_DB_PATH="$HOME/.pdpp/local-test.sqlite"
node reference-implementation/cli/index.js auth login \
  --rs-url http://localhost:7663 \
  --client-id cli_longview \
  --timeout-seconds 600
```

The CLI prints:

```
Verification URI: http://localhost:7662/device?user_code=XXXXXX
User code: XXXXXX
```

1. Open that URL in a browser.
2. You'll see an "Approve owner access" page.
3. Leave the `Subject ID` field as-is (`owner_local`) and click **Approve and issue owner token**.
4. Return to the terminal. The CLI prints a JSON block with `access_token` and `token_type`. Copy the `access_token` value (a 64-char hex string).

The token is valid for one year against this server.

## Verify the token works

From the third terminal, before handing off to anything else, confirm the token is live:

```bash
TOKEN=<paste-access-token-here>

curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:7663/v1/streams?connector_id=https://registry.pdpp.org/connectors/chatgpt" \
  | python3 -m json.tool
```

You should see a JSON block listing streams with their record counts.

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:7663/v1/streams/conversations/records?connector_id=https://registry.pdpp.org/connectors/chatgpt&limit=3" \
  | python3 -m json.tool | head -60
```

You should see three real conversation records.

## Hand the token to a coding agent

Open a coding agent of your choice (Claude Code, Cursor, etc.). Paste the following prompt, substituting your token:

````
I have a locally-running PDPP server. Your job is to explore the data it exposes.

Base URL: http://localhost:7663
Owner token: <paste-access-token-here>

To authenticate, include this header on every request:
  Authorization: Bearer <owner-token>

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

The agent can then use `curl`, `fetch`, or its HTTP tool of choice to explore your ChatGPT data through a real standards-compliant API.

## View the data in the dashboard

Open a fourth terminal and start the web dashboard:

```bash
export PDPP_DB_PATH="$HOME/.pdpp/local-test.sqlite"
pnpm dev
```

Next.js starts on `http://localhost:3000`. Open `http://localhost:3000/dashboard` in your browser.

The dashboard reads from the same PDPP server you started earlier (at 7662/7663) and shows your connector runs, stream inventory, and record samples.

## Stopping everything

- Connector run already exited — nothing to stop there.
- Stop the PDPP server: Ctrl+C in terminal 2.
- Stop the dashboard: Ctrl+C in terminal 4.
- Stop the browser daemon: `node packages/polyfill-connectors/bin/pdpp-connectors.js browser stop`
- The sqlite file at `$PDPP_DB_PATH` persists your data. Delete it if you want to start clean.

## Troubleshooting

**`Cannot find package 'express'` when running the server** — `reference-implementation` deps didn't install. Run `pnpm install` again at the repo root; it's now a workspace member.

**`Unknown client_id: pdpp-cli`** — the reference server's default pre-registered clients don't include `pdpp-cli`. Use `--client-id cli_longview` as shown above.

**`Timed out waiting for owner approval`** — the `--timeout-seconds 600` window expired before you clicked Approve. Re-run the login command.

**`[orchestrate] result: status=failed records_emitted=0` with no reason** — the orchestrator is swallowing the child connector's error. Run the connector directly to see the real error:

```bash
node packages/polyfill-connectors/connectors/chatgpt/index.js <<< '{"type":"START","request_id":"r1","scope":{"streams":[{"name":"conversations"}]},"state":null}'
```

**Connector hangs waiting on `INTERACTION kind=manual_action`** — ChatGPT's Cloudflare protection blocked auto-login and the connector wrote `/tmp/pdpp-interaction-*.json` asking for a manual login. The INTERACTION message file contains the full request; reply by writing a response JSON file as the message describes. Or re-run with `PDPP_CHATGPT_HEADLESS=0` so you can complete the challenge in the visible browser window.

**Ports 7662/7663 already in use** — a previous server is still running. `lsof -i :7662 :7663` to find it, then kill the PID.

**Records don't appear when querying** — confirm both processes are using the same `PDPP_DB_PATH`. The connector run and the server must point to the same sqlite file.

**`BEWARE: your OS is not officially supported by Patchright`** — patchright officially supports Ubuntu 20.04/22.04/24.04. Newer distributions fall back to the 24.04 build. Ignorable.
