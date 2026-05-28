## Why

The polyfill connector subsystem has two browser-launch paths that no production runtime uses:

1. **The shared browser daemon** (`src/browser-daemon.ts` + `bin/browser-daemon-worker.ts`) — a long-lived Chromium process that connectors attach to over CDP, originally introduced to keep `Session`-scoped auth cookies (USAA's `LtpaToken2`) warm across runs. No connector currently runs through it. The only remaining callers are two ad-hoc Amazon reverse-engineering scripts (`bin/amazon-request-export.ts`, `bin/amazon-privacy-probe.ts`).
2. **The shared-profile launcher** (`src/browser-profile.ts` + `src/bootstrap.ts`) — a plain-Playwright `launchPersistentContext` against a single shared `~/.pdpp/browser-profile/`, used today by the `pdpp-connectors browser bootstrap|probe` UX and by hand-written Amazon/USAA probe scripts under `bin/`. Both ask for `channel: "chrome"` and so require Google Chrome installed at `/opt/google/chrome/chrome`, which the Docker image does not have.

The actual production connector path is `connector-runtime.ts → acquireIsolatedBrowser`, which uses **patchright with per-connector isolated profile directories** under `~/.pdpp/profiles/<name>/`. This path is dominant on every dimension that matters: stronger stealth (full launch-side + client-side patchright vs. daemon's launch-side-only), per-connector fingerprint isolation, no shared profile lock, no discovery-file dance, no `xvfb-run` dependency, and a single concept that's legible to standards reviewers.

Keeping the daemon and shared-profile paths around imposes ongoing costs:

- A misleading filename: `acquireIsolatedBrowser` lives inside `browser-daemon.ts` even though it explicitly does NOT use the daemon (per the comment at line 265).
- An operational concept (`pdpp-connectors browser start|stop|status|restart|logs`, the `~/.pdpp/browser-daemon.json` discovery file, `xvfb-run` as a launch wrapper) that is not part of any reference contract and that complicates Docker.
- A `channel: "chrome"` requirement on the legacy paths that previously broke in the dev Docker image when Chrome wasn't installed. Per the owner-decided "Option D" in `design-notes/browser-channel-decision-memo.md`, the isolated launcher now auto-detects: it prefers patchright's recommended `channel: "chrome"` and falls back to bundled Patchright Chromium only when Chrome is not installed. `PDPP_BROWSER_CHANNEL=<value>` is a strict override (no fallback). The reference Docker image installs real Chrome explicitly in the final stage so the recommended channel is the default in-container.
- Confusion about what the supported runtime path is, both for human readers and for the in-flight `add-reference-runtime-spec` graduation.

## What Changes

### Retired
- **Browser daemon worker and lifecycle**: delete `bin/browser-daemon-worker.ts`, the daemon-side functions in `src/browser-daemon.ts` (`startDaemon`, `stopDaemon`, `daemonStatus`, `readDiscovery`, `writeDiscovery`, `probeCdp`, `waitForDiscoveryReady`, `clearStaleProfileLock`), and the `pdpp-connectors browser start|stop|status|restart|logs` CLI subcommands.
- **Shared-profile launcher**: delete `src/browser-profile.ts`, `src/bootstrap.ts`, the `pdpp-connectors browser bootstrap|probe` CLI subcommands, and the `bootstrap:browser` / `probe:browser` package scripts.
- **Hand-written probe scripts that required the legacy paths**: delete `bin/usaa-connectivity.ts`, `bin/usaa-structural-probe.ts`, `bin/amazon-listcard-probe.ts`, `bin/amazon-listpage-probe.ts`, `bin/amazon-listcard-yohtmlc-probe.ts`, `bin/amazon-capture-detail.ts`, `bin/bootstrap-slack-session.ts`, `bin/bootstrap-github-pat.ts`. These were one-shot reverse-engineering aids whose findings are already encoded in connector code or design notes.
- **Discovery file and Xvfb**: stop creating `~/.pdpp/browser-daemon.json` and `~/.pdpp/browser-daemon.log`. Stop spawning under `xvfb-run`.

### Preserved
- **`acquireIsolatedBrowser`**: moved out of `browser-daemon.ts` into a new `src/browser-launch.ts`. Behavior unchanged. This is the only browser-launch primitive that remains.
- **`bin/amazon-request-export.ts`** and **`bin/amazon-privacy-probe.ts`**: migrated from CDP-attach to direct `acquireIsolatedBrowser({ profileName: "amazon" })`. Same connector, same profile dir Amazon's runtime connector uses, no daemon.
- The connector-runtime call site (`connector-runtime.ts:608`) is unchanged in behavior; only the import path changes (`./browser-daemon.ts` → `./browser-launch.ts`).

### Future capability noted (out of scope of this change)
- Multi-account support requires keying `profileName` on subject identity (e.g. `${connectorName}__${subjectId}`) so two accounts on the same platform get independent profiles. The current default `profileName = connectorName` is single-account by design. Documenting this here so the convention is locked when multi-account ships.

### Out of scope (handled separately)
- A per-connector replacement for the `bootstrap browser` ergonomics (one-shot UX to seed a connector profile) is deferred. Today, connector auto-login flows (`src/auto-login/*`) handle initial credentialing via `INTERACTION kind=credentials` from a normal connector run, which the existing operator surface already supports.

## Capabilities

### Modified Capabilities

- `polyfill-runtime`: add a requirement that browser-backed connectors SHALL acquire browsers exclusively through the isolated patchright launcher; remove the daemon and shared-profile paths from the operational surface.

## Impact

- `packages/polyfill-connectors/src/browser-daemon.ts` (deleted; relevant code moved)
- `packages/polyfill-connectors/src/browser-launch.ts` (new home for `acquireIsolatedBrowser`)
- `packages/polyfill-connectors/src/browser-profile.ts` (deleted)
- `packages/polyfill-connectors/src/bootstrap.ts` (deleted)
- `packages/polyfill-connectors/src/connector-runtime.ts` (import path update only)
- `packages/polyfill-connectors/bin/pdpp-connectors.ts` (drops `browser` subcommands)
- `packages/polyfill-connectors/bin/browser-daemon-worker.ts` (deleted)
- `packages/polyfill-connectors/bin/amazon-request-export.ts` (migrated off CDP)
- `packages/polyfill-connectors/bin/amazon-privacy-probe.ts` (migrated off CDP)
- `packages/polyfill-connectors/bin/usaa-*.ts`, `bin/amazon-list*-probe.ts`, `bin/amazon-capture-detail.ts`, `bin/bootstrap-*.ts` (deleted)
- `packages/polyfill-connectors/package.json` (drop `bootstrap:browser` / `probe:browser` scripts)
- `openspec/changes/add-polyfill-connector-system/tasks.md` (mark daemon line superseded)
- `openspec/changes/add-reference-runtime-spec/design.md` (drop the daemon row from the in-flight spec graduation)
