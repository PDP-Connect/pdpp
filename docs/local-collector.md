# PDPP Local Collector

The local collector runs filesystem-class connectors on a host you control and
ingests records into a PDPP reference deployment with a device-scoped token.
Use it for Claude Code and Codex data that the Docker reference container cannot
read directly.

The public runner package is `@pdpp/local-collector`. The `@pdpp/cli` package
owns the `pdpp` binary and keeps a compatibility shim at `pdpp collector ...`,
but new operator docs should lead with `npx -y @pdpp/local-collector ...` or an
installed `pdpp-local-collector` binary.

## Install

Run without installing:

```bash
# @pdpp/local-collector package, npx-launched pdpp-local-collector binary
npx -y @pdpp/local-collector --help
```

Or install the runner once:

```bash
# @pdpp/local-collector package, installs the pdpp-local-collector binary
npm i -g @pdpp/local-collector
pdpp-local-collector --help
```

`@pdpp/cli` is separate:

```bash
# @pdpp/cli package, installs the pdpp binary
npm i -g @pdpp/cli
pdpp --help
```

A monorepo checkout is only needed for PDPP development or unpublished
connector work. It is not required for the public Claude Code / Codex collector
path.

## Advertise

Advertise the runner capabilities before enrolling a device:

```bash
# @pdpp/local-collector package, npx-launched pdpp-local-collector binary
npx -y @pdpp/local-collector advertise
```

The output includes the collector protocol version, runner version, connector
versions, and capabilities such as `network`, `filesystem`, and `local_device`.
Browser-bound connectors are intentionally not shipped in this package until
each has its own publishability review.

## Enroll

Start the reference deployment and open the dashboard's local exporter
enrollment form. Create an enrollment code for the connector id and local
binding you want to run, then exchange that short-lived code on the host that
has the local data:

```bash
# @pdpp/local-collector package, npx-launched pdpp-local-collector binary
npx -y @pdpp/local-collector enroll \
  --base-url https://<reference-host> \
  --code <one-time-code> \
  --device-label "<host label>"
```

The JSON response contains `device_id`, `device_token`, and
`source_instance_id`. Treat `device_token` like an API key. Do not commit it,
paste it into issue trackers, print it in logs, or include it in support
screenshots. The token is device-scoped and ingest-only, but it can still write
records to that collector lane.

## Run

Run the connector with the enrollment response values supplied through
environment variables:

```bash
# @pdpp/local-collector package, npx-launched pdpp-local-collector binary
PDPP_LOCAL_DEVICE_ID=<device_id> \
PDPP_LOCAL_DEVICE_TOKEN=<device_token> \
PDPP_CONNECTION_ID=<source_instance_id> \
npx -y @pdpp/local-collector run \
  --base-url https://<reference-host> \
  --connector claude_code
```

Codex uses the same shape:

```bash
# @pdpp/local-collector package, npx-launched pdpp-local-collector binary
PDPP_LOCAL_DEVICE_ID=<device_id> \
PDPP_LOCAL_DEVICE_TOKEN=<device_token> \
PDPP_CONNECTION_ID=<source_instance_id> \
npx -y @pdpp/local-collector run \
  --base-url https://<reference-host> \
  --connector codex
```

`PDPP_SOURCE_INSTANCE_ID` remains a compatibility alias for
`PDPP_CONNECTION_ID`, but new docs and scripts should use
`PDPP_CONNECTION_ID`.

If you installed globally, replace the `npx -y @pdpp/local-collector` prefix
with `pdpp-local-collector`:

```bash
# @pdpp/local-collector package, globally installed pdpp-local-collector binary
PDPP_LOCAL_DEVICE_ID=<device_id> \
PDPP_LOCAL_DEVICE_TOKEN=<device_token> \
PDPP_CONNECTION_ID=<source_instance_id> \
pdpp-local-collector run \
  --base-url https://<reference-host> \
  --connector claude_code
```

The `@pdpp/cli` shim remains available for operators who have both packages
installed:

```bash
# @pdpp/cli package, pdpp binary lazily resolves @pdpp/local-collector
pdpp collector run --base-url https://<reference-host> --connector claude_code
```

Prefer the direct `@pdpp/local-collector` command in onboarding because it makes
the runtime package explicit.

## Durable Services And Timers

The collector is intentionally not a custom scheduler daemon. Each invocation
drains durable local outbox work, records honest backlog/health, then exits.
Use the host supervisor for periodic execution, boot/login behavior, jitter,
resource limits, and logs. That keeps the package small and lets each operating
system own the lifecycle primitives it already provides.

### systemd

For a durable Linux host, store non-secret settings in an env file and secrets
in a root-readable file or secret manager:

```bash
# /etc/pdpp/local-collector.env
PDPP_REFERENCE_BASE_URL=https://<reference-host>
PDPP_CONNECTION_ID=<source_instance_id>
```

```bash
# /etc/pdpp/local-collector.secret, chmod 0600
PDPP_LOCAL_DEVICE_ID=<device_id>
PDPP_LOCAL_DEVICE_TOKEN=<device_token>
```

Example systemd unit:

```ini
[Unit]
Description=PDPP local collector (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/pdpp/local-collector.env
EnvironmentFile=/etc/pdpp/local-collector.secret
ExecStart=/usr/bin/pdpp-local-collector run --connector %i
```

Example timer:

```ini
[Unit]
Description=Run PDPP local collector (%i)

[Timer]
OnBootSec=2m
OnUnitActiveSec=15m
Persistent=true

[Install]
WantedBy=timers.target
```

Commands for the installed service:

```bash
# systemd, running the globally installed @pdpp/local-collector binary
systemctl enable --now pdpp-local-collector@claude_code.timer
systemctl status pdpp-local-collector@claude_code.service
```

### launchd

For a durable macOS host, use the same environment split and let `launchd`
trigger a one-shot collector run. Keep the token in a user-readable-only env
file or a Keychain-backed wrapper script; do not inline secrets in the plist if
the file will be synced or shared.

Example wrapper:

```bash
#!/bin/zsh
set -eu
source "$HOME/.config/pdpp/local-collector.env"
source "$HOME/.config/pdpp/local-collector.secret"
exec /opt/homebrew/bin/pdpp-local-collector run --connector "$1"
```

Example LaunchAgent:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>fish.vivid.pdpp.local-collector.claude-code</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/<you>/.local/bin/pdpp-local-collector-run</string>
    <string>claude_code</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>900</integer>
  <key>StandardOutPath</key>
  <string>/Users/<you>/Library/Logs/pdpp-local-collector-claude-code.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/<you>/Library/Logs/pdpp-local-collector-claude-code.err.log</string>
</dict>
</plist>
```

Install and inspect:

```bash
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/fish.vivid.pdpp.local-collector.claude-code.plist"
launchctl kickstart -k "gui/$(id -u)/fish.vivid.pdpp.local-collector.claude-code"
launchctl print "gui/$(id -u)/fish.vivid.pdpp.local-collector.claude-code"
```

Use one service/timer per connection when a host exports multiple sources. The
shared reference server distinguishes them by `PDPP_CONNECTION_ID`, not by the
connector type alone.

## Docker Moves And Reference URL Changes

When moving the reference deployment or changing how Docker publishes it:

1. Update `PDPP_REFERENCE_BASE_URL` in every collector env file to the new
   public origin.
2. If the reference database moved with the deployment, preserve the existing
   `PDPP_LOCAL_DEVICE_ID`, `PDPP_LOCAL_DEVICE_TOKEN`, and
   `PDPP_CONNECTION_ID`; the enrollment and connector state move with the DB.
3. If the new deployment has a fresh database, revoke or discard the old local
   env values and re-enroll from the dashboard. Fresh DBs do not know the old
   device id/token.

Do not log the old or new device token while testing the move. Use redacted
commands in chat and tickets.

## Troubleshooting

### 403 After Source Migration

If the collector receives HTTP 403 after moving a source or reference
deployment, first verify that `PDPP_REFERENCE_BASE_URL` points at the deployment
that issued the current device token. A token from one reference DB is not valid
against a fresh DB. If the DB was replaced, create a new enrollment code and run
`npx -y @pdpp/local-collector enroll ...` again.

Also confirm you are passing the correct connection id:

```bash
# shell inspection only; do not print PDPP_LOCAL_DEVICE_TOKEN
printf '%s\n' "$PDPP_REFERENCE_BASE_URL" "$PDPP_LOCAL_DEVICE_ID" "$PDPP_CONNECTION_ID"
```

### Protocol Mismatch

The collector sends `X-PDPP-Collector-Protocol` during enrollment and ingest.
If the reference deployment returns `409 collector_protocol_mismatch`, update
the older side so the collector protocol versions match:

```bash
# @pdpp/local-collector package, inspect local runner version/capabilities
npx -y @pdpp/local-collector advertise
```

For Docker deployments, pull and restart the reference image or install the
matching `@pdpp/local-collector` version on the host. The reference server
rejects incompatible records before persisting them, so retrying after the
version fix is safe.

### Missing Runner

If `pdpp collector ...` from `@pdpp/cli` says the runner is missing, install the
runner package or use npx directly:

```bash
# @pdpp/local-collector package, direct public runner path
npm i -g @pdpp/local-collector
npx -y @pdpp/local-collector advertise
```

### Secret Handling

Never run diagnostics that print `PDPP_LOCAL_DEVICE_TOKEN`. When asking for
help, include the command shape, connector id, base URL, protocol version, and
HTTP status, but redact the token:

```text
PDPP_LOCAL_DEVICE_TOKEN=<redacted>
```
