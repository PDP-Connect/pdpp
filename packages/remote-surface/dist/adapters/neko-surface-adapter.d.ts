import { type NekoPointerControl } from "../controllers/neko-pointer-controller.ts";
import type { FocusTextInputOptions, RemoteKeysymEvent, RemotePointerEvent, RemoteSurface, RemoteSurfaceConfig, RemoteSurfaceLifecycleState } from "../types.ts";
export type NekoSurfaceConfig = Extract<RemoteSurfaceConfig, {
    kind: "neko";
}>;
export type RemoteSurfaceLogger = (level: "debug" | "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void;
/**
 * Subset of `neko-client.ts`'s public surface the adapter needs. The
 * dashboard supplies an object that satisfies this shape; keeping it
 * structural avoids a cross-package import and lets neko-client.ts stay
 * untouched during this step.
 *
 * Required fields mirror the in-tree helpers (see neko-client.ts):
 *   - `start`         → `startNeko(container, config)`          (line ~2352)
 *   - `stop`          → no current export; dashboard may pass a wrapper
 *                       around the underlying `nekoInstance.$destroy?.()`.
 *   - `focusKeyboard` → `focusNekoKeyboard()`                   (line ~1095)
 *   - `sendText`      → wraps `nekoInstance.control.paste(text)` (line ~1088)
 *
 * `NekoClientConfig` is intentionally typed as `unknown` here so the
 * adapter doesn't pull in apps/web types. The dashboard owns the cast at
 * the wiring boundary.
 */
export interface NekoClientApi {
    start(container: HTMLElement, config: unknown): Promise<void>;
    stop?(): Promise<void> | void;
    focusKeyboard?(): void;
    blurKeyboard?(): void;
    setRemoteInputFocused?(focused: boolean): void;
    sendText?(text: string): Promise<boolean | undefined> | boolean | undefined;
    pasteText?(text: string): Promise<boolean> | boolean;
    copyRemoteSelection?(): Promise<boolean> | boolean;
    /**
     * Returns the live n.eko `control` object (or a structural equivalent)
     * for the currently-mounted instance, or `null` if not yet ready. Used
     * by NekoPointerController to dispatch pointer events. The dashboard
     * wires this against `nekoInstance.control` at the binding boundary.
     */
    getPointerControl?(): NekoPointerControl | null;
    /**
     * Maps a local-viewport (x, y) to remote-desktop coordinates. The
     * dashboard owns this because it knows the `<video>`/canvas placement
     * (see neko-client.ts `getNekoControlPos`). If absent, the adapter
     * falls back to identity (1:1) and logs a warning.
     */
    mapPointerToRemote?(xLocal: number, yLocal: number): {
        x: number;
        y: number;
    };
    /**
     * Returns the hidden textarea the MobileTextInputController will bind
     * to for soft-keyboard / IME input. The dashboard owns mounting the
     * element (it's visually-hidden + focusable + ariaHidden). May return
     * null if the dashboard has not mounted the textarea yet, in which
     * case the adapter skips IME wiring until next call.
     */
    getTextareaElement?(): HTMLTextAreaElement | null;
    /**
     * Dispatches a single raw X11 keysym press+release at the remote.
     * Used by MobileTextInputController for special keys (Backspace,
     * Enter, Arrow keys, F-keys). The dashboard wires this to n.eko's
     * `nekoInstance.control.keyPress(keysym)` — verified in
     * @demodesk/neko bundle L23746.
     */
    sendKeysym?(keysym: number): void;
}
export interface NekoSurfaceAdapterDeps {
    client: NekoClientApi;
    config: NekoSurfaceConfig;
    logger?: RemoteSurfaceLogger;
}
export declare class NekoSurfaceAdapter implements RemoteSurface {
    private container;
    private lifecycleState;
    private readonly client;
    private readonly config;
    private readonly log;
    private pointerController;
    private pointerControllerControl;
    private textInputController;
    private textInputControllerTextarea;
    constructor(deps: NekoSurfaceAdapterDeps);
    /** Test/inspection hook; not part of RemoteSurface. */
    getLifecycleState(): RemoteSurfaceLifecycleState;
    /** Test/inspection hook; not part of RemoteSurface. */
    getContainer(): HTMLElement | null;
    mount(el: HTMLElement): Promise<void>;
    unmount(): Promise<void>;
    focusTextInput(opts?: FocusTextInputOptions): void;
    blurTextInput(): void;
    setRemoteInputFocused(focused: boolean): void;
    private ensureTextInputController;
    sendPointer(event: RemotePointerEvent): Promise<void>;
    sendKeysym(event: RemoteKeysymEvent): Promise<void>;
    sendText(text: string): Promise<void>;
    private dispatchCommittedText;
    private sendTextViaClient;
    pasteText(text: string): Promise<boolean>;
    copyRemoteSelection(): Promise<boolean>;
    private ensureMounted;
}
//# sourceMappingURL=neko-surface-adapter.d.ts.map