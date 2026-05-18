import type { RemotePointerEvent } from "../types.ts";
export interface NekoControlPos {
    x: number;
    y: number;
}
/**
 * The minimal n.eko control surface this controller needs. Mirrors the
 * shape of `nekoInstance.control` (see neko-client.ts NekoControl type),
 * but kept structural so this package does not depend on neko-client.ts.
 *
 * `touchBegin/Update/End` are optional and only used when the caller
 * opts into the native-touch path via `NekoPointerControllerDeps.nativeTouch`.
 */
export interface NekoPointerControl {
    buttonDown(button: number, pos: NekoControlPos): void;
    buttonUp(button: number, pos: NekoControlPos): void;
    move(pos: NekoControlPos): void;
    touchBegin?(touchId: number, pos: NekoControlPos, pressure?: number): void;
    touchUpdate?(touchId: number, pos: NekoControlPos, pressure?: number): void;
    touchEnd?(touchId: number, pos: NekoControlPos, pressure?: number): void;
}
export type NekoPointerLogger = (level: "debug" | "info" | "warn", msg: string, meta?: Record<string, unknown>) => void;
export interface NekoPointerControllerDeps {
    control: NekoPointerControl;
    /**
     * Viewport-local → remote-desktop coordinate mapping. The dashboard
     * owns this because it knows the `<video>`/canvas placement and remote
     * screen size (see neko-client.ts `getNekoControlPos`).
     */
    mapToRemote: (xLocal: number, yLocal: number) => NekoControlPos;
    /**
     * Opt-in: also emit native `touchBegin/Update/End` for touch pointers.
     * Default `false` because of the double-delivery hazard documented at
     * neko-client.ts:1771-1778. Only enable behind a feature flag with a
     * duplicate-delivery guard.
     */
    nativeTouch?: boolean;
    logger?: NekoPointerLogger;
}
export declare class NekoPointerController {
    private readonly control;
    private readonly mapToRemote;
    private readonly nativeTouch;
    private readonly log;
    private readonly activePresses;
    private disposed;
    constructor(deps: NekoPointerControllerDeps);
    handle(event: RemotePointerEvent): void;
    dispose(): void;
    private shouldEmitNativeTouch;
}
//# sourceMappingURL=neko-pointer-controller.d.ts.map