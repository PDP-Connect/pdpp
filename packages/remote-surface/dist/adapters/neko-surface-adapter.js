// NekoSurfaceAdapter — preferred RemoteSurface implementation for stealth flows.
//
// Implementation pattern: "wrap first, extract second, replace only where
// evidence supports it." See §54-62 of
// docs/5-12-26-chatgpt-remote-surface-brief-response.txt and the follow-up
// plan dated 2026-05-12.
//
// We deliberately do NOT import directly from
// apps/console/src/app/dashboard/runs/[runId]/stream/neko-client.ts. That module
// is not exposed via a workspace package and several of its
// adapter-relevant helpers (startNeko, focusNekoKeyboard, paste-to-text
// path) are file-private. To avoid mutating neko-client.ts during the
// adapter-introduction step, the adapter accepts a structural
// `NekoClientApi` via DI. The dashboard binds this interface against
// neko-client.ts when it later wires the adapter into stream-viewer.tsx
// (step 3 of the plan).
//
// Step ladder:
//   1. (this step) NekoSurfaceAdapter shell delegating to injected client.
//   2. NekoPointerController moves into sendPointer (and absorbs tap-to-click).
//   3. Dashboard switches to RemoteSurface and supplies the NekoClientApi
//      binding from neko-client.ts.
//   4. MobileInputController takes over focusTextInput/sendKeysym/sendText.
import { NekoPointerController, } from "../controllers/neko-pointer-controller.js";
import { MobileTextInputController } from "../ime/mobile-text-input-controller.js";
const noopLogger = () => {
    /* no-op */
};
export class NekoSurfaceAdapter {
    // Mount target supplied via mount(). Held so future controllers
    // (NekoPointerController, MobileInputController) can attach DOM
    // listeners to the same element the underlying neko client uses.
    container = null;
    lifecycleState = "idle";
    client;
    config;
    log;
    pointerController = null;
    // Identity of the control object the current pointerController was
    // built against — used to detect when the client has handed us a new
    // n.eko control (reconnect) and rebuild.
    pointerControllerControl = null;
    textInputController = null;
    textInputControllerTextarea = null;
    constructor(deps) {
        this.client = deps.client;
        this.config = deps.config;
        this.log = deps.logger ?? noopLogger;
    }
    /** Test/inspection hook; not part of RemoteSurface. */
    getLifecycleState() {
        return this.lifecycleState;
    }
    /** Test/inspection hook; not part of RemoteSurface. */
    getContainer() {
        return this.container;
    }
    async mount(el) {
        if (this.lifecycleState !== "idle") {
            throw new Error(`NekoSurfaceAdapter.mount: invalid state ${this.lifecycleState}; expected idle`);
        }
        this.lifecycleState = "mounting";
        this.container = el;
        try {
            // The dashboard is responsible for translating `this.config` (the
            // RemoteSurfaceConfig "neko" variant) into the concrete
            // NekoClientConfig that `startNeko` expects. Passing through as
            // `unknown` keeps that mapping a single-responsibility concern of
            // the dashboard wiring step.
            await this.client.start(el, this.config);
            this.lifecycleState = "mounted";
            this.ensureTextInputController();
            this.log("info", "neko-surface-adapter.mounted");
        }
        catch (err) {
            this.lifecycleState = "error";
            this.log("error", "neko-surface-adapter.mount-failed", {
                error: err instanceof Error ? err.message : String(err),
            });
            throw err;
        }
    }
    async unmount() {
        if (this.lifecycleState === "idle") {
            // Idempotent: nothing to tear down.
            return;
        }
        if (this.lifecycleState === "unmounting") {
            throw new Error("NekoSurfaceAdapter.unmount: already unmounting");
        }
        this.lifecycleState = "unmounting";
        try {
            if (this.client.stop) {
                await this.client.stop();
            }
            else {
                // TODO(step-3): neko-client.ts does not currently expose a stop
                // helper. The dashboard wiring step should add one (wrapping
                // `nekoInstance?.$destroy?.()` plus the cleanup currently inlined
                // in stream-viewer's effect teardown) and pass it via
                // `NekoClientApi.stop`. Without it, repeated mount/unmount cycles
                // will leak the underlying neko instance.
                this.log("warn", "neko-surface-adapter.no-stop-helper");
            }
            this.pointerController?.dispose();
            this.pointerController = null;
            this.pointerControllerControl = null;
            this.textInputController?.dispose();
            this.textInputController = null;
            this.textInputControllerTextarea = null;
            this.container = null;
            this.lifecycleState = "idle";
            this.log("info", "neko-surface-adapter.unmounted");
        }
        catch (err) {
            this.lifecycleState = "error";
            this.log("error", "neko-surface-adapter.unmount-failed", {
                error: err instanceof Error ? err.message : String(err),
            });
            throw err;
        }
    }
    focusTextInput(opts) {
        this.ensureMounted("focusTextInput");
        // TODO(step-4): IME mode-switching belongs in MobileInputController.
        // For now we ignore `opts.inputMode` and just route focus to the
        // n.eko hidden textarea via the existing helper.
        if (opts?.inputMode) {
            this.log("debug", "neko-surface-adapter.focus-text-input.ignored-mode", {
                inputMode: opts.inputMode,
            });
        }
        // Bind MobileTextInputController lazily here — by the time the user
        // requests text input, the dashboard has typically mounted the hidden
        // textarea. Re-bind if the dashboard has handed us a new textarea
        // (e.g. after remount).
        const textarea = this.ensureTextInputController();
        if (this.client.focusKeyboard) {
            this.client.focusKeyboard();
        }
        else {
            this.log("warn", "neko-surface-adapter.no-focus-keyboard-helper");
        }
        if (textarea) {
            textarea.focus({ preventScroll: true });
            this.log("debug", "neko-surface-adapter.text-input-focused");
        }
    }
    blurTextInput() {
        this.ensureMounted("blurTextInput");
        if (this.client.blurKeyboard) {
            this.client.blurKeyboard();
        }
        else {
            this.log("warn", "neko-surface-adapter.no-blur-keyboard-helper");
        }
    }
    setRemoteInputFocused(focused) {
        this.ensureMounted("setRemoteInputFocused");
        if (this.client.setRemoteInputFocused) {
            this.client.setRemoteInputFocused(focused);
        }
        else {
            this.log("warn", "neko-surface-adapter.no-remote-input-focus-helper", {
                focused,
            });
        }
    }
    ensureTextInputController() {
        const textarea = this.client.getTextareaElement?.() ?? null;
        if (!textarea) {
            if (!this.textInputController) {
                this.log("debug", "neko-surface-adapter.no-textarea");
            }
            return null;
        }
        if (this.textInputController &&
            this.textInputControllerTextarea === textarea) {
            return textarea;
        }
        this.textInputController?.dispose();
        this.textInputController = new MobileTextInputController({
            textarea,
            onTextCommit: (text) => {
                void this.dispatchCommittedText(text);
            },
            onSpecialKey: (keysym) => {
                if (this.client.sendKeysym) {
                    this.client.sendKeysym(keysym);
                }
                else {
                    this.log("warn", "neko-surface-adapter.no-send-keysym-helper", {
                        keysym,
                    });
                }
            },
            logger: (level, msg, meta) => this.log(level, msg, meta),
        });
        this.textInputControllerTextarea = textarea;
        this.log("info", "neko-surface-adapter.text-input-bound");
        return textarea;
    }
    // eslint-disable-next-line @typescript-eslint/require-await
    async sendPointer(event) {
        this.ensureMounted("sendPointer");
        const control = this.client.getPointerControl?.() ?? null;
        if (!control) {
            this.log("warn", "neko-surface-adapter.no-pointer-control", {
                type: event.type,
            });
            return;
        }
        // Lazily construct on first use so we get a fresh controller per
        // mount cycle and pick up whatever `control` object the client
        // exposes at this moment (n.eko replaces `control` across reconnects).
        if (!this.pointerController || this.pointerControllerControl !== control) {
            this.pointerController?.dispose();
            this.pointerController = new NekoPointerController({
                control,
                mapToRemote: this.client.mapPointerToRemote ??
                    ((x, y) => {
                        this.log("warn", "neko-surface-adapter.no-pointer-map");
                        return { x, y };
                    }),
                logger: (level, msg, meta) => this.log(level, msg, meta),
            });
            this.pointerControllerControl = control;
        }
        this.pointerController.handle(event);
    }
    // eslint-disable-next-line @typescript-eslint/require-await
    async sendKeysym(event) {
        this.ensureMounted("sendKeysym");
        // Step-5 expert ruling 2: the public `RemoteSurface.sendKeysym` API
        // preserves explicit `{type: "keydown" | "keyup", keysym}` semantics so
        // callers don't have to reason about backend capabilities. Internally
        // the n.eko adapter degrades this to an **edge-triggered** dispatch
        // until/unless n.eko exposes separate down/up primitives:
        //   - `keydown` → `client.sendKeysym(keysym)` (wraps
        //     `control.keyPress`, which is press+release in one shot —
        //     verified in @demodesk/neko bundle L23746)
        //   - `keyup`   → no-op
        // This is fine for soft-keyboard flows (single character commits and
        // discrete special keys) and explicit toolbar dispatches. If a future
        // caller needs true down-up split (chorded modifiers, key-repeat
        // pressure), the right move is to expose `control.keyDown`/`keyUp` on
        // `NekoClientApi` and add a capabilities flag — the expert flagged
        // that as a future move, not a now move.
        if (event.type === "keyup") {
            return;
        }
        if (this.client.sendKeysym) {
            this.client.sendKeysym(event.keysym);
        }
        else {
            this.log("warn", "neko-surface-adapter.no-send-keysym-helper", {
                keysym: event.keysym,
            });
        }
    }
    async sendText(text) {
        this.ensureMounted("sendText");
        await this.sendTextViaClient(text, "surface-api");
    }
    async dispatchCommittedText(text) {
        this.log("debug", "neko-surface-adapter.text-commit", {
            textLength: text.length,
        });
        try {
            await this.sendTextViaClient(text, "mobile-ime");
        }
        catch (err) {
            this.log("error", "neko-surface-adapter.text-commit-failed", {
                error: err instanceof Error ? err.message : String(err),
                textLength: text.length,
            });
        }
    }
    async sendTextViaClient(text, source) {
        if (this.client.sendText) {
            this.log("debug", "neko-surface-adapter.send-text", {
                phase: "start",
                source,
                textLength: text.length,
            });
            const result = await this.client.sendText(text);
            const sent = result !== false;
            this.log(sent ? "info" : "warn", "neko-surface-adapter.send-text", {
                phase: "result",
                sent,
                source,
                textLength: text.length,
            });
            if (!sent) {
                throw new Error("client.sendText returned false");
            }
            return true;
        }
        // TODO(step-3): dashboard wiring should provide a `sendText` that
        // proxies the existing `nekoInstance.control.paste(text)` path
        // (neko-client.ts ~line 1088). Until then, this is a no-op rather
        // than a throw so callers can probe capabilities without crashing.
        this.log("warn", "neko-surface-adapter.no-send-text-helper", {
            textLength: text.length,
        });
        return false;
    }
    async pasteText(text) {
        this.ensureMounted("pasteText");
        if (this.client.pasteText) {
            return await this.client.pasteText(text);
        }
        if (this.client.sendText) {
            await this.client.sendText(text);
            return text.length > 0;
        }
        this.log("warn", "neko-surface-adapter.no-paste-text-helper", {
            textLength: text.length,
        });
        return false;
    }
    async copyRemoteSelection() {
        this.ensureMounted("copyRemoteSelection");
        if (this.client.copyRemoteSelection) {
            return await this.client.copyRemoteSelection();
        }
        this.log("warn", "neko-surface-adapter.no-copy-remote-selection-helper");
        return false;
    }
    ensureMounted(method) {
        if (this.lifecycleState !== "mounted") {
            throw new Error(`NekoSurfaceAdapter.${method}: invalid state ${this.lifecycleState}; expected mounted`);
        }
    }
}
//# sourceMappingURL=neko-surface-adapter.js.map