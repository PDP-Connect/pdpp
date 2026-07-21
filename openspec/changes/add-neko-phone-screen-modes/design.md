## Context

n.eko v3 reads XRandR configurations at desktop startup and returns them from `GET /api/room/screen/configurations`. Its `--desktop.screen` option selects one active startup configuration; it is not a list mechanism. The upstream implementation at tag `v3.0.11` gathers `XRRSizes` in `server/pkg/xorg/xorg.c` and exposes that collection through `server/internal/api/room/screen.go`.

The reference image already defines the portrait 412x915 mode. It lacks the landscape twin. Both static Compose and the allocator launch the same `pdpp-neko` image, so the Xorg mode list is the one shared configuration boundary.

## Decision

Add 915x412 to the Xorg modelines and display mode list. n.eko advertises this XRandR timing at 29 Hz and accepts that advertised rate when switching modes. Keep the active default screen at 1440x900@30. Do not add a DPR-scaled mode or an allocator-only device profile.

Derive Chromium's default `--window-size` dimensions from `NEKO_DESKTOP_SCREEN`, the active n.eko startup screen. A small X11 watcher resizes the browser when n.eko changes the active XRandR mode during viewport selection; fixed `PDPP_NEKO_WINDOW_WIDTH` and `PDPP_NEKO_WINDOW_HEIGHT` overrides are removed because they would reintroduce a conflicting window size.

The CDP proxy also exposes a container-local `/pdpp/window-settle` status surface. It reads the X root and every `RemoteBrowserApp` window at request time, reporting settled only when every browser window matches the active root dimensions. The adapter awaits that acknowledgement inside the presentation lifecycle's serialized mutation before it reports the selected screen or promotes a screenshot frame. A captured frame from an earlier lifecycle epoch is discarded rather than promoted after a rotation.

## Out of Scope

- Fingerprint, user-agent, or touch emulation.
- Changing the stream normalizer's DPR-1 contract.
- Changing the presentation lifecycle's baseline ownership or restore policy.

## Acceptance Checks

- The committed Xorg configuration exposes 412x915 and 915x412.
- Static Compose and dynamic allocator configuration use the same n.eko image.
- The adapter selects 412x915@30 for a 412x915 viewport and the advertised 915x412 mode after rotation.
- Chromium defaults its launch window to the active n.eko screen dimensions.
- No phone-sized frame is promoted until the container reports that the Chromium window matches the selected X screen.
