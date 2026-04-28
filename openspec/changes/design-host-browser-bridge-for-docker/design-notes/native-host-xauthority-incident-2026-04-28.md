# Native Host X Authority Incident

Status: investigated
Owner: reference runtime owner
Created: 2026-04-28
Updated: 2026-04-28
Related: openspec/changes/design-host-browser-bridge-for-docker, packages/polyfill-connectors/src/browser-launch.ts

## Question

How should the reference runtime fail when a native-host headed browser launch has `DISPLAY` set but cannot authenticate to the host X server because `XAUTHORITY` is missing or stale?

## Context

A worker reported a native-host headed Chrome connector failure:

> Native-host headed Chrome connectors fail with "no XServer" because the AS process inherits a shell environment with `XAUTHORITY` unset, even though `DISPLAY=:0` and Xwayland are healthy. This used to work and started failing after the AS process restarted. The `pnpm dev` wrapper does not auto-resolve `XAUTHORITY` from the running X session, so any restart from a stale-env tmux shell leaves the AS unable to authenticate to the X server.

During owner review of `bound-spine-and-record-read-paths`, the polyfill connector test suite also exposed a related symptom: a headed browser launch reached Chrome and emitted `Invalid MIT-MAGIC-COOKIE-1 key` / `Missing X server or $DISPLAY` before the runtime converted the situation into a PDPP-owned diagnostic.

That test failure was fixed by restoring the intended container fail-closed test signal (`PDPP_FORCE_CONTAINER=1`), but the native-host X authority issue remains distinct. It is not evidence that the bounded-read-path branch caused the field incident.

## Stakes

Headed browser-backed connectors are operator-facing. If the runtime lets Playwright/Patchright surface the generic "no XServer" message, operators cannot tell whether the problem is:

- Docker headed-browser posture,
- host-browser bridge configuration,
- native host `DISPLAY` visibility,
- stale `XAUTHORITY`,
- or a connector-specific login failure.

That ambiguity causes wasted connector debugging and undermines the reference's "inspect don't hide" posture.

## Current Leaning

Do not fold this into the bounded-read-path branch. Treat it as a host environment regression first and a runtime reliability follow-up second.

The local investigation report is summarized below so this note remains self-contained.

The current evidence says the field failure is environmental, not a PDPP code regression:

- Xwayland is healthy and the live cookie file is valid.
- tmux panes inherited `DISPLAY=:0` without `XAUTHORITY`.
- `xset q` reproduces the connector's `Invalid MIT-MAGIC-COOKIE-1` failure with that env and succeeds when `XAUTHORITY` is exported from `systemctl --user show-environment`.
- The current bounded-read-path branch does not touch browser launch or X authority behavior.
- The plausible "what changed" is dotfiles/tmux lifecycle plus browser-daemon retirement: tmux now starts as a user-systemd service before the graphical session, and per-run browser launches expose stale tmux env that a long-lived daemon previously masked.

Immediate unblock is operational, not a PDPP code change:

```bash
eval "$(systemctl --user show-environment | grep -E '^(DISPLAY|XAUTHORITY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)=')"
```

Run that in the tmux pane before restarting `pnpm dev`.

Durable ownership likely belongs in dotfiles/tmux session management: ensure tmux starts after graphical-session env import, or refresh tmux's global env on client attach. The reference runtime can still add an operator-facing preflight diagnostic, but it should report the mismatch rather than silently guessing an X authority path.

The runtime should add a native-host headed-browser preflight before launching Playwright/Patchright:

- If running in a container and a headed browser is requested, keep the existing host-browser-bridge fail-closed behavior.
- If running on the native host and a headed browser is requested, verify `DISPLAY` is set and X authority is usable before launch.
- If `DISPLAY` is set but `XAUTHORITY` is missing or unusable, fail with a stable PDPP diagnostic that names `DISPLAY`, `XAUTHORITY`, and the likely stale-shell/tmux restart cause.
- Do not silently synthesize `XAUTHORITY` by scanning `/run/user/*/xauth_*`. Multiple desktops and sessions make that heuristic fragile, and a wrong guess hides the real operational problem.

## Promotion Trigger

Promote into an OpenSpec change before implementing any of:

- runtime preflight behavior,
- new connector failure subtype,
- environment auto-discovery,
- dev wrapper changes that export `XAUTHORITY`,
- dashboard deployment diagnostics for native headed-browser readiness.

## Decision Log

- 2026-04-28: Captured during owner review. Deferred out of `bound-spine-and-record-read-paths`; likely belongs in a host-browser/runtime reliability tranche.
- 2026-04-28: Investigation found this is a stale tmux/systemd-user environment problem exposed by browser-daemon retirement, not a bounded-read-path code regression. Prefer dotfiles env propagation fix plus PDPP preflight diagnostics over an auto-resolver.
