# Remote surface acceptance playground

This playground launches a local Chromium instance, streams `Page.startScreencast`
frames to a browser page over WebSocket, and sends input back through CDP
`Input.*` commands. It is an acceptance harness for remote-surface UX work, not
part of the published `@opendatalabs/remote-surface` package.

Run it from the repository root:

```sh
pnpm --filter @opendatalabs/remote-surface playground:dev
```

Then open the printed local URL. The server launches headed Chromium by default.
It binds to `127.0.0.1`; to test from a phone on the same LAN, expose it with
`REMOTE_SURFACE_PLAYGROUND_HOST=0.0.0.0` (or `--host 0.0.0.0`) and open the printed
`LAN (phone)` URL. Only do this on a trusted network — the harness dispatches raw
input into a live Chromium with no auth. See `TESTING.md` for a full walkthrough.
The default `--driver=package` path routes CDP viewport, screencast, pointer,
keysym, and text operations through the package `CdpSurfaceAdapter`. Use
`--driver=legacy` to compare against the original hand-rolled CDP driver:

```sh
pnpm --filter @opendatalabs/remote-surface playground:dev -- --driver=legacy
```

For headless automation:

```sh
REMOTE_SURFACE_PLAYGROUND_HEADLESS=1 pnpm --filter @opendatalabs/remote-surface playground:dev
```

Run the scripted acceptance subset:

```sh
pnpm --filter @opendatalabs/remote-surface playground:test
```

The live page shows:

- per-character input telemetry, including the local handler that consumed the
  input, the package/legacy CDP path that handled it, and the current echo state
  read from the remote test form;
- pointer accuracy telemetry, including intended local point, dispatched remote
  coordinates, observed remote click coordinates, and pixel error;
- geometry telemetry for capture size, display scale, black bars, and 1:1 status;
- the Android acceptance checklist from the onboarding dossier, with the subset
  that can run in desktop automation covered by `playground:test`.

The playground intentionally imports no reference implementation, app, or sibling
PDPP package code. The CDP implementation routes pointer and text operations
through the `RemoteSurface` interface shape in `src/types.ts` so the same harness
can later exercise both CDP and n.eko-backed surfaces.
