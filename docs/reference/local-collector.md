# PDPP Local Collector

The local collector runs filesystem-class connectors on a host you control and
ingests records into a PDPP reference deployment with a device-scoped token.
Use it for Claude Code and Codex data that the Docker reference container cannot
read directly.

## Ownership Model

For filesystem-class local collectors, the device or host supervisor owns when a
collector process runs. Use `launchd`, `systemd`, cron, or another local
supervisor to decide cadence, retries, and host-level resource limits. The
reference server does not start arbitrary local processes or own a scheduler for
these collectors.

The reference server owns the remote side of the lane: enrollment, device token
validation, record ingestion, connector state persistence, health diagnostics,
and optional desired-freshness or request-run signals for operators. Treat those
signals as advisory until a future spec defines a control protocol; they do not
replace the local supervisor.

`PDPP_CONNECTION_ID` identifies the source connection being collected, even when
today's enrollment response field is named `source_instance_id`. Use a distinct
connection id per device/account/home/user binding so multiple hosts or
accounts do not share cursor state, outbox rows, or dashboard diagnostics.

The public runner package is `@pdpp/local-collector`. The `@pdpp/cli` package
owns the `pdpp` binary and keeps a compatibility shim at `pdpp collector ...`,
but new operator docs should lead with `npx -y @pdpp/local-collector ...`
or an installed `pdpp-local-collector` binary.

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

## Deployment Posture: Published vs Dev

A production or operator host MUST run a **pinned, published** package — never
a monorepo checkout's `dist/`. Mixing the two is the difference between
operator-host evidence and local-dev evidence, and it is easy to do by
accident: an `npm link`ed (or otherwise globally symlinked) `pdpp-local-collector`
resolves the binary into a repo `packages/local-collector/dist/...` tree, so a
`status`/`doctor`/`run` you believe reflects the published package is really
exercising your working copy.

**Production / operator host — install the published release.**

```bash
# Install the current published release (npm's default `latest` dist-tag):
npm i -g @pdpp/local-collector

# Or pin an exact version for reproducible operator evidence (preferred when
# capturing host evidence that must be attributable to a known build):
npm i -g @pdpp/local-collector@0.1.0
```

Confirm what actually resolves before trusting any host evidence. The collector
classifies its own posture — prefer the mechanical `deployment_posture` block on
`status`/`doctor` over a manual path check:

```bash
# Mechanical check (primary): status and doctor carry a redaction-safe
# deployment_posture block. kind is published_package, repo_dist_override, or
# unknown; is_placeholder_version flags the 0.0.0 build; location_hint is a
# redacted descriptor (never a home path).
pdpp-local-collector status | sed -n '/"deployment_posture"/,/}/p'
# doctor turns a repo override or the 0.0.0 placeholder into a warning with a
# remediation hint, so an unhealthy posture surfaces without reading JSON:
pdpp-local-collector doctor
```

A `deployment_posture.kind` of `published_package` with `is_placeholder_version:
false` is the only posture that should back operator-host evidence. A
`repo_dist_override`, an `unknown`, or `is_placeholder_version: true` means
re-pin before treating any output as operator-host evidence.

Re-pinning means moving to a published build that is *at least as current as the
repo build you are leaving*. Releases are cut from `main` only when a
release-worthy Conventional Commit lands, so a `repo_dist_override` built from a
newer `main` can be **ahead** of the published release — re-pinning it onto a
stale published build would regress the host. Before re-pinning, confirm the
published release carries the fixes you need: the release owner runs
`pnpm release:dist-tag-check` to verify the live dist-tag posture, and cuts a
release from `main` if the published build lags. Until then, a repo override
that is ahead of the published release is dev evidence to keep, not a build to
downgrade.

The manual path check still works as an out-of-band cross-check:

```bash
# The realpath must be under a global node_modules, NOT a repo dist/ tree.
command -v pdpp-local-collector
readlink -f "$(command -v pdpp-local-collector)"
```

If `readlink -f` lands inside a repo `packages/local-collector/dist/`, the host
is running a **dev override**, not the published package — and
`deployment_posture.kind` reports `repo_dist_override` for the same reason.

> **Watch for the `0.0.0` bootstrap placeholder.** Before the first stable
> release from `main`, npm's `latest` dist-tag resolved a `0.0.0` bootstrap
> placeholder that is older than every real build. An install that reports
> version `0.0.0` is that placeholder, not a working collector — upgrade to the
> current published release (or pin an exact version). The
> in-repo `package.json` version is also `0.0.0`, by design — the published
> version is set at publish time, and the CLI's own
> `package.version` echoes whatever build is installed, which is exactly why
> the `deployment_posture` block flags `is_placeholder_version` and the manual
> cross-check above still matters.

**Dev override (monorepo development only).** When iterating on the collector
itself, build the package and point the global binary at the repo `dist/` on
purpose, and label it as a dev override wherever you record evidence:

```bash
# Monorepo dev override — repo dist/, NOT a published package. Mark any
# evidence captured this way as dev-only.
( cd packages/local-collector && pnpm build )
npm i -g "file:$(pwd)/packages/local-collector"   # or: npm link
readlink -f "$(command -v pdpp-local-collector)"   # confirm it is the repo dist/
```

Undo the dev override and return to a pinned published package before capturing
operator-host evidence again:

```bash
npm rm -g @pdpp/local-collector
npm i -g @pdpp/local-collector@0.1.0   # re-pin a published version
```

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
`source_instance_id`. Store `source_instance_id` as `PDPP_CONNECTION_ID`; it is
the connection/source identity for this device/account/home binding. Treat
`device_token` like an API key. Do not commit it, paste it into issue trackers,
print it in logs, or include it in support screenshots. The token is
device-scoped and ingest-only, but it can still write records to that collector
lane.

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

## Recover A Stalled Collector

When the dashboard says a local collector needs attention, run the recovery
command on the host that owns that collector. Use the `source_instance_id`
shown in the dashboard's focused recovery panel; do not substitute the
owner-facing `connector_instance_id` / `connection_id`.

```bash
# Dry run: resolves the enrolled local profile and reports what would happen.
npx -y @pdpp/local-collector recover --source-instance-id <source_instance_id>

# Apply: requeues failed uploads if present, then runs the collector once.
npx -y @pdpp/local-collector recover --source-instance-id <source_instance_id> --apply
```

`recover` looks for a local collector profile matching that source instance
under `${PDPP_LOCAL_COLLECTOR_PROFILE_DIR}` or
`${XDG_CONFIG_HOME:-$HOME/.config}/pdpp/collectors`. When it finds one, it uses
the profile's durable outbox path, connector id, reference base URL, device id,
and device token. If no matching profile exists and no explicit queue was
configured, it refuses with an operator error instead of falling back to the
package-default outbox. That refusal is intentional: the package-default queue
is often unrelated to the enrolled host collector and can produce a misleading
`db.exists:false` / `matched:0` result.

If you installed globally with `npm i -g @pdpp/local-collector`, replace
the `npx -y @pdpp/local-collector` prefix with `pdpp-local-collector`:

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
# @pdpp/cli package, pdpp binary lazily resolves the installed @pdpp/local-collector package
pdpp collector run --base-url https://<reference-host> --connector claude_code
```

Prefer the direct `@pdpp/local-collector` command in onboarding because it
makes the runtime package and dist-tag explicit.

## Durable Services And Timers

The collector is intentionally not a custom scheduler daemon. Each invocation
drains durable local outbox work, records honest backlog/health, then exits.
Use the host supervisor for periodic execution, boot/login behavior, jitter,
resource limits, and logs. That keeps the package small and lets each operating
system own the lifecycle primitives it already provides.

### Persistent State And Scratch Paths

The collector keeps undrained work in a durable SQLite outbox between runs.
That file, and any output you capture, must live on a **persistent,
disk-backed** directory — not a RAM-backed `/tmp`.

On many Linux hosts `/tmp` is a `tmpfs` mounted on RAM (the default on recent
Ubuntu releases, sized at half of physical memory). A wrapper that points the
outbox or a captured run summary at `/tmp` therefore: (a) silently consumes RAM
as the outbox or a large backfill summary grows, and (b) loses undrained
backlog on reboot, so the next run re-scans and re-enqueues the same tranche
instead of draining what was already collected.

Set these explicitly in your wrapper or env file:

```bash
# Durable outbox: a disk-backed state dir, never /tmp.
# Linux (XDG): $XDG_STATE_HOME or ~/.local/state.
PDPP_COLLECTOR_QUEUE="${XDG_STATE_HOME:-$HOME/.local/state}/pdpp/collector-runner-queue.json"
```

When you capture the `run` or `doctor` JSON, write it under the same persistent
state/cache dir rather than a raw `/tmp` file:

```bash
# Capture a run summary on a disk-backed path (not /tmp on a tmpfs host).
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/pdpp"
mkdir -p "$STATE_DIR"
pdpp-local-collector run --connector claude_code > "$STATE_DIR/last-run.json"
```

The optional connector-protocol debug dump
(`PDPP_DEBUG_CONNECTOR_PROTOCOL_DIR`) follows the same rule: point it at a
persistent directory you can inspect later, not `/tmp`. Leave it unset unless
you are actively debugging a protocol parse failure.

If a host genuinely has no spare disk and you must use ephemeral scratch, keep
the durable outbox (`PDPP_COLLECTOR_QUEUE`) on disk regardless — only the
durable outbox carries undrained backlog across runs, and losing it is what
causes a re-scan of the same data.

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
# Keep the durable outbox on a disk-backed path so undrained backlog survives
# reboot and a tmpfs /tmp never holds collector state (see "Persistent State
# And Scratch Paths" above).
Environment=PDPP_COLLECTOR_QUEUE=/var/lib/pdpp/collector-runner-queue.json
ExecStart=/usr/bin/pdpp-local-collector run --connector %i

# --- Durable resource limits (do not drop these) --------------------------
# A collector run scans local source files (for example a very large active
# Codex session). The connector runtime streams the tail so a healthy run's
# working set is small, but a future regression, an unusually large source, or
# a stuck child must not be allowed to consume host memory without bound. These
# cgroup limits keep one collector run from taking the machine down; the host
# supervisor — not the package — owns them, so they belong in the unit you
# install, not only in a manual `systemd-run` wrapper.
MemoryMax=2G
MemorySwapMax=0
OOMPolicy=kill
# Make this background collector the kernel's preferred victim if the WHOLE HOST
# (not just this cgroup) runs out of memory. A positive OOMScoreAdjust raises the
# run's badness score so an unrelated host-wide memory spike sacrifices the
# collector — which is durable and resumes on the next run — before it reaps an
# interactive app. This is host-wide victim selection ONLY; the cgroup's own cap
# above (MemoryMax + MemorySwapMax=0 + OOMPolicy=kill) already self-kills this
# run if IT is the one over budget, independent of this score. See the note
# below for why a collector killed under host pressure is expected, not a fault.
OOMScoreAdjust=500
# Bound the oneshot start operation so a hung connector child cannot run
# forever. RuntimeMaxSec is ignored for Type=oneshot services, so the effective
# wall-clock guard for this unit is TimeoutStartSec.
TimeoutStartSec=900
# Reap the whole control group (the collector and any connector child it
# spawned) on stop so nothing is orphaned.
KillMode=control-group
KillSignal=SIGTERM
TimeoutStopSec=30
```

`MemoryMax=2G` is a deliberately generous ceiling: a healthy streamed run stays
far below it, so the cap only fires on a regression or a pathological source.
`MemorySwapMax=0` is the load-bearing line — without it the cgroup spills to
swap under pressure and thrashes the whole host instead of failing the one run,
which is exactly the failure mode an uncapped unit produced (a multi-gigabyte
service peak that had to be killed by hand). With `MemorySwapMax=0` and
`OOMPolicy=kill`, the kernel OOM-kills only this run's cgroup; the next
scheduled run resumes draining the durable outbox. Lower `MemoryMax` for a small
host or raise it for a host that legitimately collects very large sources, but
do not remove it. Use `systemd-run --scope -p MemoryMax=2G -p MemorySwapMax=0`
with the same values when proving a run by hand before installing the unit.

`OOMScoreAdjust=500` is a **separate, deliberate** policy and is easy to confuse
with the cgroup cap above. It does **not** affect what happens when this run
exceeds its own `MemoryMax` — that case is handled entirely by `OOMPolicy=kill`
on the cgroup, regardless of the score. The score only changes **host-wide**
victim selection: when some *other* process (a model server, a browser, an
editor) drives the **whole machine** out of memory, the positive score makes the
kernel pick this collector first. That is intended — a background data collector
should yield to the user's foreground work, and it loses nothing by being killed:
its undelivered work is already durable in the outbox and the next scheduled run
resumes the drain. The practical consequence to remember when reading health
signals: **a collector terminated under host-wide memory pressure is expected
behavior, not a collector fault.** Its tiny resident size means it is almost
never the cause of the pressure; it is the cheapest thing to sacrifice. If you
would rather the collector compete on equal footing with other processes during
a host-wide OOM, set `OOMScoreAdjust=0`; raise it toward `1000` to make the
collector even more strongly preferred as the victim. Leaving it at `500` keeps
the collector a willing-but-not-absolute sacrifice.

If Node is installed under a user-managed prefix such as `nvm`, do not rely on
systemd's minimal default `PATH`. Either point `ExecStart` at a wrapper that
exports the Node bin directory first, or set an explicit `Environment=PATH=...`
in the unit before invoking `pdpp-local-collector`. The installed npm binary
uses a `#!/usr/bin/env node` shebang, so an interactive shell may work while
the same command fails under systemd unless `node` is on the service `PATH`.

Example timer:

```ini
[Unit]
Description=Run PDPP local collector (%i)

[Timer]
# OnActiveSec is relative to when the TIMER UNIT ITSELF is activated —
# enable, `daemon-reload` + timer restart, or a --user manager restart all
# re-activate the timer unit, so each one re-arms this directive fresh. Use
# it for bootstrap instead of OnBootSec= (boot-relative) or OnStartupSec=
# (service-manager-start-relative): both of those failed live on a --user
# manager restart. See "Why OnBootSec=/OnStartupSec=/OnUnitActiveSec= go
# dead after a manager restart" below.
OnActiveSec=2m
# OnUnitInactiveSec is relative to when the oneshot SERVICE last deactivated
# (i.e. finished), not when the timer last fired. That makes recurrence
# self-healing across a manager restart: a restart cannot leave this timer's
# reference point stuck in the past the way OnUnitActiveSec's "last
# activation" bookkeeping can when the manager forgets it.
OnUnitInactiveSec=15m

[Install]
WantedBy=timers.target
```

**Why `OnBootSec=`/`OnStartupSec=`/`OnUnitActiveSec=` go dead after a manager
restart.** All three are defined relative to a reference point the *systemd
manager* tracks in memory: `OnBootSec=` relative to boot, `OnStartupSec=`
relative to when the service manager instance was last started, and
`OnUnitActiveSec=` relative to the timer's own last activation. A `--user`
manager restart (session logout/login cycling `systemd --user`, an explicit
`systemctl --user restart`, or a distro package upgrade that restarts the
user instance) does not reboot the machine, so `OnBootSec=` stays anchored to
a boot that already happened — already far in the past by the next timer
activation. Per `systemd.timer(5)`, a monotonic timer already in the past
when the timer unit activates elapses immediately once, then has no further
trigger from that directive.

`OnStartupSec=` was tried as the fix here and looked correct on paper — the
manager restart IS its reference point — but live acceptance evidence on a
test laptop after a `daemon-reload` + timer restart contradicted that: `systemctl
status` showed the timer `active`, `Trigger: n/a`, and the `OnStartupSec=`
elapse computed as already in the past (in one observed run, effectively
`infinity`), not 2 minutes out. In practice the manager-start reference
point `OnStartupSec=` uses did not move the way the restart procedure
assumed, so it reproduced the same dead-timer symptom as `OnBootSec=`.
`OnUnitActiveSec=` independently depends on activation bookkeeping the
restarted manager does not have, so it fails the same way for a different
reason. The net effect observed in the field for all three: the timer shows
`active` with `Trigger: n/a` (no `NextElapse`), and the service never runs
again until the *machine* reboots or an operator manually
restarts/re-triggers the timer.

`OnActiveSec=` is the directive that was actually verified live: relative to
the *timer unit's own activation*, so any event that re-activates the timer
unit — `systemctl enable --now`, a `daemon-reload` followed by a timer
restart, or a `--user` manager restart re-activating enabled timers — re-arms
it. On that laptop, replacing `OnStartupSec=2m` with `OnActiveSec=2m` (leaving
`OnUnitInactiveSec=15m` unchanged) immediately produced `active`/`waiting`
with a concrete `NextElapse` (`NEXT` shown as ~2 minutes out) after the same
`daemon-reload` + timer restart procedure that left `OnStartupSec=` dead.
This is reported as rationale for the directive choice, not as a
machine-specific promise — the underlying mechanism (activation-relative
elapse, re-armed by the operations that reactivate the timer unit) is general
to `--user` systemd timers, not particular to that machine.

Note that `OnActiveSec=`/`OnUnitInactiveSec=` provide **activation-relative
bootstrap**, not **calendar-downtime replay**, and the two are not
interchangeable. This example deliberately omits `Persistent=true`: per
`systemd.timer(5)`, `Persistent=` "only has an effect on timers configured
with `OnCalendar=`" — a purely monotonic timer like this one (no
`OnCalendar=` directive) ignores it entirely, so setting it here would be
inert and misleading in a copy-paste example. The actual catch-up-after-a-gap
behavior for this timer comes from `OnActiveSec=`'s own rule: an
activation-relative elapse point already in the past when the timer
re-activates fires immediately once. That covers "the timer unit was
reactivated (enable, reload+restart, or manager restart) after sitting
inactive a while," which is the scenario this fix targets. It does **not**
cover "the whole host was powered off and missed a scheduled
`OnUnitInactiveSec=` recurrence" — that class of catch-up requires an
`OnCalendar=` anchor plus `Persistent=true`, which this timer does not use.

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
# Keep the durable outbox on a persistent, disk-backed path so undrained
# backlog survives reboot and a tmpfs /tmp never holds collector state.
# (macOS /tmp is disk-backed today, but pinning the path keeps the wrapper
# portable to Linux hosts where /tmp is tmpfs.)
export PDPP_COLLECTOR_QUEUE="$HOME/Library/Application Support/pdpp/collector-runner-queue.json"
mkdir -p "$(dirname "$PDPP_COLLECTOR_QUEUE")"
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

launchd has no per-job equivalent of systemd's `MemoryMax`/`MemorySwapMax`
cgroup cap. On macOS the run's memory bound comes from the connector runtime,
which streams large source files instead of materializing them, so a healthy run
stays small. If you need a hard ceiling on a macOS host, run the collector under
a wrapper that sets one (for example a coarse `ulimit -v` in the wrapper script,
accepting that an address-space limit is blunter than a cgroup memory cap), and
keep the `StartInterval` long enough that runs do not overlap.

Use one service/timer per connection when a host exports multiple sources. The
shared reference server distinguishes them by `PDPP_CONNECTION_ID`, not by the
connector type alone, and the local supervisor remains responsible for deciding
when each service/timer runs.

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

Also confirm you are passing the correct source identity:

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
