// NekoPointerController — canonical home for RemoteSurface pointer dispatch
// over n.eko's native input path (X11 events via XTest/XInput2 on the
// Chromium-inside-neko X server).
//
// Step 2 of the migration plan documented at
//   docs/5-12-26-chatgpt-remote-surface-brief-response.txt §66-74
// and the follow-up plan at docs/remote-surface-step-1-adapter.md.
//
// ## Canonical tap-to-click pattern (verified)
//
// The bug surfaced in docs/neko-mode-mobile-validation-2026-05-12.md:
// `touchstart`+`touchend` flow end-to-end to the remote, but n.eko's
// Chromium does NOT synthesize a `click` event from a stationary touch
// pair. The working fix — verified empirically in
// apps/console/src/app/(console)/syncs/[runId]/stream/neko-client.ts (see
// `clickNekoAtPoint` at lines 1573-1610) — is to emit:
//
//   control.buttonDown(1, {x, y})
//   control.buttonUp(1, {x, y})
//
// at the same coordinates. Chromium's input pipeline turns that pair into
// a click via the standard mouse path. The same pattern is used in
// ~/code/remote-browser-sandbox/client/src/input.ts (touchstart →
// mousedown, touchend → mouseup), confirming the convention across two
// independent neko consumers.
//
// ## Why we do NOT also emit touchBegin/End by default
//
// The original step-2 brief suggested a "belt-and-suspenders" approach
// emitting BOTH mouse-button events AND native touchBegin/End. The
// existing neko-client.ts code at lines 1771-1778 explicitly warns that
// emitting both causes DOUBLE-DELIVERY on platforms where n.eko's native
// touch path is also active (Android Brave: "click registers twice /
// modal closes immediately / button toggles back"). We therefore default
// to mouse-button-only, matching the verified-working fallback path. A
// `nativeTouch` opt-in is provided for future experimentation but is
// disabled by default and should only be enabled behind a feature flag
// with a duplicate-delivery guard.
//
// @demodesk/neko's `bindTouchHandler` (neko.common.js L26391-26447, per
// docs/demodesk-neko-input-research.md) does emit native touch events,
// but that path is taken only when `control.supportedTouchEvents === true`
// AND the server-side Chromium accepts X11 touch input. PDPP cannot rely
// on that being the case, and even when it is, the mouse-button path
// works.
const noopLogger = () => {
    /* no-op */
};
export class NekoPointerController {
    control;
    mapToRemote;
    nativeTouch;
    log;
    // Track per-pointer-id press state so pointercancel can release a held
    // button without inventing one and pointermove can decide whether to
    // emit a drag vs. hover move.
    activePresses = new Map();
    disposed = false;
    constructor(deps) {
        this.control = deps.control;
        this.mapToRemote = deps.mapToRemote;
        this.nativeTouch = deps.nativeTouch ?? false;
        this.log = deps.logger ?? noopLogger;
    }
    handle(event) {
        if (this.disposed) {
            return;
        }
        const pos = this.mapToRemote(event.x, event.y);
        // `button` is the spec PointerEvent.button field: 0 = primary
        // (left mouse / touch contact), 1 = middle, 2 = right. n.eko's
        // `control.buttonDown/Up` use X11 button codes where 1 is the
        // primary button, so we translate by +1.
        const x11Button = (event.button ?? 0) + 1;
        switch (event.type) {
            case "pointerdown":
                this.activePresses.set(event.pointerId, {
                    button: x11Button,
                    pointerType: event.pointerType,
                });
                this.control.buttonDown(x11Button, pos);
                if (this.shouldEmitNativeTouch(event.pointerType, "touchBegin")) {
                    this.control.touchBegin?.(event.pointerId, pos, event.pressure);
                }
                return;
            case "pointermove": {
                this.control.move(pos);
                const press = this.activePresses.get(event.pointerId);
                if (press && this.shouldEmitNativeTouch(press.pointerType, "touchUpdate")) {
                    this.control.touchUpdate?.(event.pointerId, pos, event.pressure);
                }
                return;
            }
            case "pointerup": {
                const press = this.activePresses.get(event.pointerId);
                const button = press?.button ?? x11Button;
                const pointerType = press?.pointerType ?? event.pointerType;
                this.activePresses.delete(event.pointerId);
                this.control.buttonUp(button, pos);
                if (this.shouldEmitNativeTouch(pointerType, "touchEnd")) {
                    this.control.touchEnd?.(event.pointerId, pos, event.pressure);
                }
                return;
            }
            case "pointercancel": {
                const press = this.activePresses.get(event.pointerId);
                if (!press) {
                    // No held button; nothing to release.
                    this.log("debug", "neko-pointer-controller.cancel-without-press", {
                        pointerId: event.pointerId,
                    });
                    return;
                }
                this.activePresses.delete(event.pointerId);
                // Release the held button at the cancel coordinates so the remote
                // does not see an orphan press. This is the same recovery shape
                // Guacamole/noVNC use for pointer cancel.
                this.control.buttonUp(press.button, pos);
                if (this.shouldEmitNativeTouch(press.pointerType, "touchEnd")) {
                    this.control.touchEnd?.(event.pointerId, pos, event.pressure);
                }
                return;
            }
            default: {
                // Exhaustiveness check; RemotePointerEvent.type is a closed union.
                const _exhaustive = event.type;
                this.log("warn", "neko-pointer-controller.unknown-event-type", {
                    type: _exhaustive,
                });
            }
        }
    }
    dispose() {
        this.disposed = true;
        this.activePresses.clear();
    }
    shouldEmitNativeTouch(pointerType, method) {
        if (!this.nativeTouch) {
            return false;
        }
        if (pointerType !== "touch") {
            return false;
        }
        return typeof this.control[method] === "function";
    }
}
//# sourceMappingURL=neko-pointer-controller.js.map