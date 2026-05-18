import type { RemoteSurfaceLogger } from "../adapters/neko-surface-adapter.ts";
export declare const XK_BackSpace = 65288;
export declare const XK_Tab = 65289;
export declare const XK_Return = 65293;
export declare const XK_Escape = 65307;
export declare const XK_Delete = 65535;
export declare const XK_Home = 65360;
export declare const XK_Left = 65361;
export declare const XK_Up = 65362;
export declare const XK_Right = 65363;
export declare const XK_Down = 65364;
export declare const XK_PageUp = 65365;
export declare const XK_PageDown = 65366;
export declare const XK_End = 65367;
export interface MobileTextInputControllerDeps {
    /** Hidden textarea the controller attaches its listeners to. */
    textarea: HTMLTextAreaElement;
    /**
     * Called with the committed text (post-composition or non-composing
     * `input.data`). Adapter wires to `client.sendText` / `control.paste`.
     */
    onTextCommit: (text: string) => void;
    /** Called for special-key keysyms (Backspace, Enter, Arrows, F-keys). */
    onSpecialKey: (keysym: number) => void;
    logger?: RemoteSurfaceLogger;
    /**
     * Short delay for the printable-key fallback. Tests may override; production
     * keeps it long enough for beforeinput/input to win on normal browsers.
     */
    keydownFallbackDelayMs?: number;
}
export declare class MobileTextInputController {
    private readonly textarea;
    private readonly onTextCommit;
    private readonly onSpecialKey;
    private readonly log;
    private readonly keydownFallbackDelayMs;
    private composing;
    private disposed;
    private readonly pendingKeydownFallbackTimers;
    private readonly listeners;
    constructor(deps: MobileTextInputControllerDeps);
    dispose(): void;
    /** Test/inspection hook. */
    isComposing(): boolean;
    private resetTextarea;
    private cancelPendingKeydownFallback;
    private scheduleKeydownFallback;
    private isPrintableFallbackKey;
    private attach;
}
//# sourceMappingURL=mobile-text-input-controller.d.ts.map