## Decision

Core owns the browser mode. `PDPP_BROWSER_HEADLESS=1` is the only deployment-level visibility override; unset and `0` resolve to headed mode. Connector configurations contain a browser request and profile identity only.

The Core image starts Xvfb as a child of `deploy/railway/core-supervisor.ts`, waits for the display socket, and injects `DISPLAY` into the reference, console, and oracle children. The supervisor already owns the child cascade, so display teardown follows the same stop/restart lifecycle as the application processes.

The browser launcher keeps Patchright's normal persistent-context path and existing direct-CDP port publication. The container gate gains an explicit packaged-runtime/display capability input. A Core child with `PDPP_RUNTIME_BROWSER=1` and a managed `DISPLAY` may launch headed; an unrelated container still fails closed unless the existing operator escape hatch is set. A remote CDP URL continues to bypass the local-launch gate because n.eko owns that browser and profile.

## Alternatives rejected

- Per-connector headed/headless flags: rejected because they recreate the compatibility taxonomy and allow connector declarations to disagree with deployment capability.
- UA spoofing, stealth flags, or Patchright changes: rejected; the browser parity fix is launcher selection plus a real display.
- Starting Xvfb in a detached shell: rejected because it would not share the supervisor's lifecycle and could leave an orphaned display/browser process.
- Proving only an HTTP health endpoint: rejected because it cannot distinguish full Chromium from `chromium_headless_shell` or prove the profile/CDP lifecycle.

## Acceptance checks

- Runtime unit tests show headed default, one global headless override, Core display capability, non-Core fail-closed behavior, and unchanged n.eko bypass.
- The production-image oracle runs through the Core supervisor and proves Xvfb readiness, a non-headless full Chromium executable, Patchright persistent profile state, exact-page stream registration plus unregister cleanup, and profile reuse after browser release/reacquire.
- Docker/template checks prove Xvfb is installed, the browser stage still installs the exact Patchright Chromium dependency, and Core invokes the supervisor.
