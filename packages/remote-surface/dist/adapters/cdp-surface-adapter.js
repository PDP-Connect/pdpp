import { pointToStreamViewport } from "../client/geometry.js";
import { applyCdpViewport, dispatchCdpKeyboardInput, dispatchCdpPointerInput, insertCdpText, keysymToCdpKey, } from "../backends/cdp/index.js";
const noopLogger = () => {
    /* no-op */
};
const MOTION_THROTTLE_MS = 33;
const SYNTHETIC_MOUSE_SUPPRESSION_MS = 1000;
const TOUCH_DRAG_THRESHOLD_PX = 8;
function isDirectCdpClient(client) {
    return "cdp" in client && "mediaSink" in client;
}
function isLegacyCdpClient(client) {
    return "sendInput" in client;
}
export class CdpSurfaceAdapter {
    container = null;
    lifecycleState = "idle";
    client;
    config;
    log;
    frameSequence = 0;
    screencastStarted = false;
    screencastSubscription = null;
    disposeDomListeners = null;
    motionThrottle = {
        mousePendingCoords: null,
        mouseTimeoutId: null,
        touchPendingTouch: null,
        touchTimeoutId: null,
    };
    activeTouchGesture = null;
    suppressMouseUntil = 0;
    constructor(deps) {
        this.client = deps.client;
        this.config = deps.config;
        this.log = deps.logger ?? noopLogger;
        void this.config;
    }
    /** Test/inspection hook; not part of RemoteSurface. */
    getLifecycleState() {
        return this.lifecycleState;
    }
    async mount(el) {
        if (this.lifecycleState !== "idle") {
            if (this.lifecycleState === "mounted") {
                return;
            }
            throw new Error(`CdpSurfaceAdapter.mount: invalid state ${this.lifecycleState}; expected idle`);
        }
        this.lifecycleState = "mounting";
        this.container = el;
        if (!isDirectCdpClient(this.client)) {
            this.attachLegacyDomListeners(el);
            this.lifecycleState = "mounted";
            this.log("info", "cdp-surface-adapter.mounted", { mode: "legacy-input" });
            return;
        }
        const client = this.client;
        try {
            this.screencastSubscription = client.cdp.on("Page.screencastFrame", (params) => {
                void this.handleScreencastFrame(params);
            });
            const viewport = client.getViewportInfo();
            if (viewport) {
                await this.setViewport(viewport);
            }
            await client.cdp.send("Page.enable");
            await client.cdp.send("Page.startScreencast", {
                everyNthFrame: 1,
                format: "jpeg",
                quality: 80,
            });
            this.screencastStarted = true;
            this.attachDomListeners(el);
            this.lifecycleState = "mounted";
            this.log("info", "cdp-surface-adapter.mounted");
        }
        catch (error) {
            if (this.screencastStarted) {
                try {
                    await client.cdp.send("Page.stopScreencast");
                    this.screencastStarted = false;
                }
                catch (stopError) {
                    await this.reportError(stopError);
                }
            }
            this.screencastSubscription?.unsubscribe();
            this.screencastSubscription = null;
            this.disposeDomListeners?.();
            this.disposeDomListeners = null;
            this.clearMotionThrottle();
            this.container = null;
            this.lifecycleState = "error";
            this.log("error", "cdp-surface-adapter.mount-failed", {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async unmount() {
        if (this.lifecycleState === "idle") {
            return;
        }
        if (this.lifecycleState === "unmounting") {
            throw new Error("CdpSurfaceAdapter.unmount: already unmounting");
        }
        this.lifecycleState = "unmounting";
        this.disposeDomListeners?.();
        this.disposeDomListeners = null;
        this.screencastSubscription?.unsubscribe();
        this.screencastSubscription = null;
        this.clearMotionThrottle();
        if (this.screencastStarted) {
            if (!isDirectCdpClient(this.client)) {
                throw new Error("CdpSurfaceAdapter.unmount: direct CDP client missing while screencast is active");
            }
            await this.client.cdp.send("Page.stopScreencast");
            this.screencastStarted = false;
        }
        this.container = null;
        this.frameSequence = 0;
        this.lifecycleState = "idle";
        this.log("info", "cdp-surface-adapter.unmounted");
    }
    focusTextInput(opts) {
        this.ensureMounted("focusTextInput");
        if (!isDirectCdpClient(this.client)) {
            if (!this.isCoarsePointer()) {
                this.debug("surface.cdp-frame.soft_keyboard.skip", { reason: "fine-pointer" });
                return;
            }
            const input = this.client.getSoftKeyboardElement?.() ?? null;
            input?.focus();
            this.debug("surface.cdp-frame.soft_keyboard.focus", { active: true });
            return;
        }
        if (this.isCoarsePointer()) {
            const input = this.client.getSoftKeyboardElement?.() ?? null;
            input?.focus();
            this.debug("surface.cdp-frame.soft_keyboard.focus", { active: true });
        }
        else {
            this.debug("surface.cdp-frame.soft_keyboard.skip", { reason: "fine-pointer" });
        }
        this.reportAsync(this.focusRemoteTextInput(opts));
    }
    blurTextInput() {
        this.ensureMounted("blurTextInput");
    }
    setRemoteInputFocused(_focused) {
        this.ensureMounted("setRemoteInputFocused");
    }
    async sendPointer(event) {
        this.ensureMounted("sendPointer");
        if (!isDirectCdpClient(this.client)) {
            if (event.pointerType === "touch") {
                await this.client.sendInput({
                    type: "touch",
                    action: toLegacyTouchAction(event.type),
                    x: event.x,
                    y: event.y,
                    id: event.pointerId,
                });
                return;
            }
            await this.client.sendInput({
                type: "mouse",
                action: toLegacyMouseAction(event.type),
                x: event.x,
                y: event.y,
                button: event.button ?? 0,
            });
            return;
        }
        await dispatchCdpPointerInput(this.client.cdp, {
            action: event.type,
            pointerId: event.pointerId,
            pointerType: event.pointerType,
            type: "pointer",
            x: event.x,
            y: event.y,
            ...(event.button === undefined ? {} : { button: event.button }),
        });
    }
    async setViewport(viewport) {
        if (!isDirectCdpClient(this.client)) {
            return;
        }
        await applyCdpViewport(this.client.cdp, toViewportPayload(viewport));
    }
    async sendKeysym(event) {
        this.ensureMounted("sendKeysym");
        if (!isDirectCdpClient(this.client)) {
            await this.client.sendInput({
                type: "keyboard",
                action: event.type,
                code: "",
                key: String(event.keysym),
                modifiers: 0,
            });
            return;
        }
        const key = keysymToCdpKey(event.keysym);
        await dispatchCdpKeyboardInput(this.client.cdp, {
            action: event.type,
            code: key.code,
            key: key.key,
            keysym: event.keysym,
            type: "keyboard",
        });
    }
    async sendText(text) {
        this.ensureMounted("sendText");
        if (!isDirectCdpClient(this.client)) {
            if (text.length > 0) {
                await this.client.sendInput({ type: "paste", text });
            }
            return;
        }
        await insertCdpText(this.client.cdp, text);
    }
    async pasteText(text) {
        this.ensureMounted("pasteText");
        if (text.length === 0) {
            return false;
        }
        if (!isDirectCdpClient(this.client)) {
            await this.client.sendInput({ type: "paste", text });
            return true;
        }
        await insertCdpText(this.client.cdp, text);
        return true;
    }
    async copyRemoteSelection() {
        this.ensureMounted("copyRemoteSelection");
        if (!isDirectCdpClient(this.client)) {
            return false;
        }
        const policy = this.client.getClipboardPolicy?.();
        if (policy?.canReadRemoteSelection === false || !this.client.clipboardSink) {
            return false;
        }
        const result = await this.client.cdp.send("Runtime.evaluate", {
            awaitPromise: true,
            expression: "String(globalThis.getSelection?.() ?? '')",
            returnByValue: true,
        });
        const text = typeof result.result?.value === "string" ? result.result.value : "";
        if (text.length === 0) {
            return false;
        }
        await this.client.clipboardSink.writeText(text);
        return true;
    }
    async handleScreencastFrame(params) {
        const client = this.directClient("handleScreencastFrame");
        try {
            const frame = parseScreencastFrame(params);
            await client.cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
            this.frameSequence += 1;
            await client.mediaSink.onFrame({
                contentType: "image/jpeg",
                data: frame.data,
                ...(frame.metadata ? { metadata: frame.metadata } : {}),
                sequence: this.frameSequence,
                sessionId: frame.sessionId,
                timestamp: Date.now(),
            });
        }
        catch (error) {
            const normalized = error instanceof Error ? error : new Error("CDP screencast frame handling failed");
            await client.mediaSink.onError?.(normalized);
        }
    }
    async focusRemoteTextInput(opts) {
        const client = this.directClient("focusRemoteTextInput");
        const target = client.getRemoteFocusTarget?.(opts) ?? null;
        if (!target) {
            return;
        }
        const expression = target.expression ??
            `(() => {
        const element = document.querySelector(${JSON.stringify(target.selector ?? "")});
        if (element instanceof HTMLElement) {
          element.focus({ preventScroll: true });
          return true;
        }
        return false;
      })()`;
        await client.cdp.send("Runtime.evaluate", {
            awaitPromise: true,
            expression,
            returnByValue: true,
        });
    }
    async sendPointerFromLocal(action, event, pointerType, pointerId = 0) {
        const coords = this.localCoords(event);
        if (!coords) {
            return;
        }
        const client = this.directClient("sendPointerFromLocal");
        await dispatchCdpPointerInput(client.cdp, {
            action,
            pointerId,
            pointerType,
            type: "pointer",
            x: coords.x,
            y: coords.y,
            ...(event.button === undefined ? {} : { button: event.button }),
        });
    }
    async sendWheelFromLocal(event) {
        const coords = this.localCoords(event);
        if (!coords) {
            return;
        }
        const client = this.directClient("sendWheelFromLocal");
        await dispatchCdpPointerInput(client.cdp, {
            action: "wheel",
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            pointerType: "mouse",
            type: "pointer",
            x: coords.x,
            y: coords.y,
        });
    }
    async sendMouseFromLocal(action, event, opts = {}) {
        const coords = this.localCoords(event);
        if (!coords) {
            return;
        }
        const client = this.directClient("sendMouseFromLocal");
        await dispatchCdpPointerInput(client.cdp, {
            action,
            button: 0,
            pointerType: "mouse",
            type: "pointer",
            x: coords.x,
            y: coords.y,
            ...(opts.buttons === undefined ? {} : { buttons: opts.buttons }),
        });
    }
    async blurRemoteActiveElement() {
        const client = this.directClient("blurRemoteActiveElement");
        await client.cdp.send("Runtime.evaluate", {
            awaitPromise: true,
            expression: `(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body) {
          active.blur();
          return true;
        }
        return false;
      })()`,
            returnByValue: true,
        });
    }
    async sendKeyboardEvent(event) {
        const client = this.directClient("sendKeyboardEvent");
        await dispatchCdpKeyboardInput(client.cdp, {
            action: event.type === "keyup" ? "keyup" : "keydown",
            code: event.code,
            key: event.key,
            modifiers: keyboardModifiers(event),
            type: "keyboard",
        });
    }
    async sendPasteEvent(event) {
        const client = this.directClient("sendPasteEvent");
        if (!client.getClipboardPolicy?.().canForwardNativePasteEvent) {
            this.debug("surface.cdp-frame.clipboard.paste", { phase: "skipped", reason: "policy-denied" });
            return;
        }
        const text = event.clipboardData?.getData("text") ?? "";
        this.debug("surface.cdp-frame.clipboard.paste", { length: text.length, phase: "native-paste" });
        await insertCdpText(client.cdp, text);
    }
    attachLegacyDomListeners(node) {
        if (!isLegacyCdpClient(this.client)) {
            throw new Error("CdpSurfaceAdapter.attachLegacyDomListeners: legacy input client required");
        }
        const client = this.client;
        const onMouseMove = (event) => {
            const coords = this.localCoords(event);
            if (!coords) {
                return;
            }
            const state = this.motionThrottle;
            state.mousePendingCoords = coords;
            if (state.mouseTimeoutId) {
                return;
            }
            void client.sendInput({ type: "mouse", action: "mousemove", x: coords.x, y: coords.y });
            state.mouseTimeoutId = setTimeout(() => {
                state.mouseTimeoutId = null;
                if (!state.mousePendingCoords) {
                    return;
                }
                const pending = state.mousePendingCoords;
                state.mousePendingCoords = null;
                void client.sendInput({ type: "mouse", action: "mousemove", x: pending.x, y: pending.y });
            }, MOTION_THROTTLE_MS);
        };
        const onMouseDown = (event) => {
            const coords = this.localCoords(event);
            if (coords) {
                void client.sendInput({
                    type: "mouse",
                    action: "mousedown",
                    button: event.button ?? 0,
                    x: coords.x,
                    y: coords.y,
                });
            }
        };
        const onMouseUp = (event) => {
            const coords = this.localCoords(event);
            if (coords) {
                void client.sendInput({
                    type: "mouse",
                    action: "mouseup",
                    button: event.button ?? 0,
                    x: coords.x,
                    y: coords.y,
                });
            }
        };
        const onTouchStart = (event) => {
            this.focusTextInput();
            const touch = this.firstChangedTouch(event);
            if (touch) {
                void client.sendInput({ type: "touch", action: "touchstart", x: touch.x, y: touch.y, id: touch.id });
            }
        };
        const onTouchMove = (event) => {
            const touch = this.firstChangedTouch(event);
            if (!touch) {
                return;
            }
            const state = this.motionThrottle;
            state.touchPendingTouch = touch;
            if (state.touchTimeoutId) {
                return;
            }
            void client.sendInput({ type: "touch", action: "touchmove", x: touch.x, y: touch.y, id: touch.id });
            state.touchTimeoutId = setTimeout(() => {
                state.touchTimeoutId = null;
                if (!state.touchPendingTouch) {
                    return;
                }
                const pending = state.touchPendingTouch;
                state.touchPendingTouch = null;
                void client.sendInput({ type: "touch", action: "touchmove", x: pending.x, y: pending.y, id: pending.id });
            }, MOTION_THROTTLE_MS);
        };
        const onTouchEnd = (event) => {
            if (this.motionThrottle.touchTimeoutId) {
                clearTimeout(this.motionThrottle.touchTimeoutId);
                this.motionThrottle.touchTimeoutId = null;
            }
            this.motionThrottle.touchPendingTouch = null;
            const touch = this.firstChangedTouch(event);
            if (!touch) {
                void client.sendInput({ type: "touch", action: "touchend", x: 0, y: 0 });
                return;
            }
            void client.sendInput({ type: "touch", action: "touchend", x: touch.x, y: touch.y, id: touch.id });
        };
        const onKey = (event) => {
            if (event.key === "Escape") {
                return;
            }
            event.preventDefault();
            const action = event.type === "keyup" ? "keyup" : "keydown";
            this.debug("surface.cdp-frame.keyboard.forward", {
                action,
                code: event.code,
                key: event.key,
            });
            void client.sendInput({
                type: "keyboard",
                action,
                key: event.key,
                code: event.code,
                modifiers: (event.altKey ? 1 : 0) + (event.ctrlKey ? 2 : 0) + (event.metaKey ? 4 : 0) + (event.shiftKey ? 8 : 0),
            });
        };
        const onWheel = (event) => {
            event.preventDefault();
            const coords = this.localCoords(event);
            if (!coords) {
                return;
            }
            void client.sendInput({
                type: "scroll",
                deltaX: event.deltaX,
                deltaY: event.deltaY,
                x: coords.x,
                y: coords.y,
            });
        };
        const onPaste = (event) => {
            event.preventDefault();
            if (!client.getClipboardPolicy?.().canForwardNativePasteEvent) {
                this.debug("surface.cdp-frame.clipboard.paste", { phase: "skipped", reason: "policy-denied" });
                return;
            }
            const text = event.clipboardData?.getData("text") ?? "";
            this.debug("surface.cdp-frame.clipboard.paste", { length: text.length, phase: "native-paste" });
            if (text.length > 0) {
                void client.sendInput({ type: "paste", text });
            }
        };
        node.addEventListener("mousemove", onMouseMove);
        node.addEventListener("mousedown", onMouseDown);
        node.addEventListener("mouseup", onMouseUp);
        node.addEventListener("touchstart", onTouchStart);
        node.addEventListener("touchmove", onTouchMove);
        node.addEventListener("touchend", onTouchEnd);
        node.addEventListener("touchcancel", onTouchEnd);
        node.addEventListener("keydown", onKey);
        node.addEventListener("keyup", onKey);
        node.addEventListener("wheel", onWheel, { passive: false });
        node.addEventListener("paste", onPaste);
        this.disposeDomListeners = () => {
            node.removeEventListener("mousemove", onMouseMove);
            node.removeEventListener("mousedown", onMouseDown);
            node.removeEventListener("mouseup", onMouseUp);
            node.removeEventListener("touchstart", onTouchStart);
            node.removeEventListener("touchmove", onTouchMove);
            node.removeEventListener("touchend", onTouchEnd);
            node.removeEventListener("touchcancel", onTouchEnd);
            node.removeEventListener("keydown", onKey);
            node.removeEventListener("keyup", onKey);
            node.removeEventListener("wheel", onWheel);
            node.removeEventListener("paste", onPaste);
        };
    }
    attachDomListeners(node) {
        const client = this.directClient("attachDomListeners");
        const markTouchActivity = () => {
            this.suppressMouseUntil = Date.now() + SYNTHETIC_MOUSE_SUPPRESSION_MS;
        };
        const isMouseSuppressed = () => Date.now() < this.suppressMouseUntil;
        const changedTouchForActiveGesture = (event) => {
            const active = this.activeTouchGesture;
            if (!active) {
                return event.changedTouches[0] ?? null;
            }
            for (const touch of Array.from(event.changedTouches)) {
                if (touch.identifier === active.identifier) {
                    return touch;
                }
            }
            return event.changedTouches[0] ?? null;
        };
        const onMouseMove = (event) => {
            if (isMouseSuppressed()) {
                return;
            }
            const coords = this.localCoords(event);
            if (!coords) {
                return;
            }
            const state = this.motionThrottle;
            state.mousePendingCoords = coords;
            if (state.mouseTimeoutId) {
                return;
            }
            this.reportAsync(dispatchCdpPointerInput(client.cdp, {
                action: "pointermove",
                pointerType: "mouse",
                type: "pointer",
                x: coords.x,
                y: coords.y,
            }));
            state.mouseTimeoutId = setTimeout(() => {
                state.mouseTimeoutId = null;
                if (!state.mousePendingCoords) {
                    return;
                }
                const pending = state.mousePendingCoords;
                state.mousePendingCoords = null;
                this.reportAsync(dispatchCdpPointerInput(client.cdp, {
                    action: "pointermove",
                    pointerType: "mouse",
                    type: "pointer",
                    x: pending.x,
                    y: pending.y,
                }));
            }, MOTION_THROTTLE_MS);
        };
        const onMouseDown = (event) => {
            if (isMouseSuppressed()) {
                return;
            }
            this.reportAsync(this.sendPointerFromLocal("pointerdown", event, "mouse"));
        };
        const onMouseUp = (event) => {
            if (isMouseSuppressed()) {
                return;
            }
            this.reportAsync(this.sendPointerFromLocal("pointerup", event, "mouse"));
        };
        const onTouchStart = (event) => {
            event.preventDefault();
            markTouchActivity();
            const touch = event.changedTouches[0] ?? event.touches[0] ?? null;
            if (!touch) {
                return;
            }
            this.reportAsync(this.blurRemoteActiveElement());
            node.focus({ preventScroll: true });
            this.activeTouchGesture = {
                dragging: false,
                identifier: touch.identifier,
                lastClientX: touch.clientX,
                lastClientY: touch.clientY,
                pressed: false,
                startClientX: touch.clientX,
                startClientY: touch.clientY,
            };
        };
        const onTouchMove = (event) => {
            event.preventDefault();
            markTouchActivity();
            const active = this.activeTouchGesture;
            if (!active) {
                return;
            }
            const changed = changedTouchForActiveGesture(event);
            if (!changed) {
                return;
            }
            active.lastClientX = changed.clientX;
            active.lastClientY = changed.clientY;
            const distance = Math.hypot(changed.clientX - active.startClientX, changed.clientY - active.startClientY);
            if (!active.dragging && distance < TOUCH_DRAG_THRESHOLD_PX) {
                return;
            }
            if (!active.pressed) {
                this.reportAsync(this.sendMouseFromLocal("pointerdown", {
                    clientX: active.startClientX,
                    clientY: active.startClientY,
                }));
                active.pressed = true;
            }
            active.dragging = true;
            this.reportAsync(this.sendMouseFromLocal("pointermove", changed, { buttons: 1 }));
        };
        const onTouchEnd = (event) => {
            event.preventDefault();
            markTouchActivity();
            const active = this.activeTouchGesture;
            if (!active) {
                return;
            }
            const changed = changedTouchForActiveGesture(event);
            this.activeTouchGesture = null;
            const endPoint = {
                clientX: changed?.clientX ?? active.lastClientX,
                clientY: changed?.clientY ?? active.lastClientY,
            };
            if (event.type === "touchcancel") {
                if (active.pressed) {
                    this.reportAsync(this.sendMouseFromLocal("pointercancel", endPoint));
                }
                return;
            }
            if (active.dragging) {
                if (active.pressed) {
                    this.reportAsync(this.sendMouseFromLocal("pointerup", endPoint));
                }
                return;
            }
            this.reportAsync((async () => {
                await this.sendMouseFromLocal("pointerdown", endPoint);
                await this.sendMouseFromLocal("pointerup", endPoint);
            })());
        };
        const onKey = (event) => {
            if (event.key === "Escape") {
                return;
            }
            event.preventDefault();
            const action = event.type === "keyup" ? "keyup" : "keydown";
            this.debug("surface.cdp-frame.keyboard.forward", {
                action,
                code: event.code,
                key: event.key,
            });
            this.reportAsync(this.sendKeyboardEvent(event));
        };
        const onWheel = (event) => {
            event.preventDefault();
            const coords = this.localCoords(event);
            if (!coords) {
                return;
            }
            this.reportAsync(this.sendWheelFromLocal(event));
        };
        const onPaste = (event) => {
            event.preventDefault();
            this.reportAsync(this.sendPasteEvent(event));
        };
        node.addEventListener("mousemove", onMouseMove);
        node.addEventListener("mousedown", onMouseDown);
        node.addEventListener("mouseup", onMouseUp);
        node.addEventListener("touchstart", onTouchStart);
        node.addEventListener("touchmove", onTouchMove);
        node.addEventListener("touchend", onTouchEnd);
        node.addEventListener("touchcancel", onTouchEnd);
        node.addEventListener("keydown", onKey);
        node.addEventListener("keyup", onKey);
        node.addEventListener("wheel", onWheel, { passive: false });
        node.addEventListener("paste", onPaste);
        this.disposeDomListeners = () => {
            node.removeEventListener("mousemove", onMouseMove);
            node.removeEventListener("mousedown", onMouseDown);
            node.removeEventListener("mouseup", onMouseUp);
            node.removeEventListener("touchstart", onTouchStart);
            node.removeEventListener("touchmove", onTouchMove);
            node.removeEventListener("touchend", onTouchEnd);
            node.removeEventListener("touchcancel", onTouchEnd);
            node.removeEventListener("keydown", onKey);
            node.removeEventListener("keyup", onKey);
            node.removeEventListener("wheel", onWheel);
            node.removeEventListener("paste", onPaste);
        };
    }
    localCoords(event) {
        const node = this.container;
        const viewport = this.client.getViewportInfo();
        if (!node || !viewport) {
            return null;
        }
        return pointToStreamViewport(event, {
            containerBox: node.getBoundingClientRect(),
            imageBox: this.client.getFrameElement?.()?.getBoundingClientRect() ?? null,
            viewport,
        });
    }
    firstChangedTouch(event) {
        const touch = event.changedTouches[0];
        if (!touch) {
            return null;
        }
        const coords = this.localCoords({ clientX: touch.clientX, clientY: touch.clientY });
        return coords ? { ...coords, id: touch.identifier } : null;
    }
    isCoarsePointer() {
        if (typeof window === "undefined") {
            return false;
        }
        try {
            return window.matchMedia("(pointer: coarse)").matches;
        }
        catch {
            this.debug("surface.cdp-frame.soft_keyboard.skip", { reason: "match-media-error" });
            return false;
        }
    }
    clearMotionThrottle() {
        if (this.motionThrottle.mouseTimeoutId) {
            clearTimeout(this.motionThrottle.mouseTimeoutId);
        }
        if (this.motionThrottle.touchTimeoutId) {
            clearTimeout(this.motionThrottle.touchTimeoutId);
        }
        this.motionThrottle = {
            mousePendingCoords: null,
            mouseTimeoutId: null,
            touchPendingTouch: null,
            touchTimeoutId: null,
        };
        this.activeTouchGesture = null;
    }
    debug(event, payload) {
        this.client.onInputDebug?.(event, payload);
    }
    reportAsync(work) {
        void work.catch((error) => {
            void this.reportError(error);
        });
    }
    async reportError(error) {
        const normalized = error instanceof Error ? error : new Error("CDP asynchronous command failed");
        if (!isDirectCdpClient(this.client)) {
            this.debug("surface.cdp-frame.error", { error: normalized.message });
            return;
        }
        await Promise.resolve(this.client.mediaSink.onError?.(normalized)).catch(() => {
            /* swallow secondary reporting failure */
        });
    }
    directClient(method) {
        if (!isDirectCdpClient(this.client)) {
            throw new Error(`CdpSurfaceAdapter.${method}: direct CDP client required`);
        }
        return this.client;
    }
    ensureMounted(method) {
        if (this.lifecycleState !== "mounted") {
            throw new Error(`CdpSurfaceAdapter.${method}: invalid state ${this.lifecycleState}; expected mounted`);
        }
    }
}
function toViewportPayload(viewport) {
    if ("type" in viewport) {
        return viewport;
    }
    return {
        type: "viewport",
        width: viewport.width,
        height: viewport.height,
        ...(viewport.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: viewport.deviceScaleFactor }),
        ...(viewport.screenWidth === undefined ? {} : { screenWidth: viewport.screenWidth }),
        ...(viewport.screenHeight === undefined ? {} : { screenHeight: viewport.screenHeight }),
        ...(viewport.hasTouch === undefined ? {} : { hasTouch: viewport.hasTouch }),
        ...(viewport.mobile === undefined ? {} : { mobile: viewport.mobile }),
        ...(viewport.orientation === undefined ? {} : { orientation: viewport.orientation }),
    };
}
function toLegacyMouseAction(type) {
    if (type === "pointermove") {
        return "mousemove";
    }
    if (type === "pointerdown") {
        return "mousedown";
    }
    return "mouseup";
}
function toLegacyTouchAction(type) {
    if (type === "pointermove") {
        return "touchmove";
    }
    if (type === "pointerdown") {
        return "touchstart";
    }
    return "touchend";
}
function keyboardModifiers(event) {
    const modifiers = [];
    if (event.altKey) {
        modifiers.push("Alt");
    }
    if (event.ctrlKey) {
        modifiers.push("Control");
    }
    if (event.metaKey) {
        modifiers.push("Meta");
    }
    if (event.shiftKey) {
        modifiers.push("Shift");
    }
    return modifiers;
}
function parseScreencastFrame(params) {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
        throw new Error("Page.screencastFrame payload must be an object");
    }
    const record = params;
    if (typeof record.data !== "string" || typeof record.sessionId !== "number") {
        throw new Error("Page.screencastFrame payload missing data or sessionId");
    }
    return {
        data: record.data,
        ...(isRecord(record.metadata) ? { metadata: record.metadata } : {}),
        sessionId: record.sessionId,
    };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=cdp-surface-adapter.js.map