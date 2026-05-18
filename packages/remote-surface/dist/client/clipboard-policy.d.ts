export type ClipboardDirectionPolicy = "disabled" | "local-to-remote" | "remote-to-local" | "bidirectional-text";
export type ClipboardHelperMode = "strict" | "balanced" | "assistive";
export type ClipboardSurfaceKind = "desktop-inline" | "mobile-sheet" | "disabled";
export interface ClipboardCapabilityInput {
    browserFamily: "chromium" | "firefox" | "safari" | "unknown";
    clipboardChangeEventAvailable?: boolean;
    isSecureContext: boolean;
    pointerCoarse: boolean;
    readPermission?: PermissionState | "unsupported" | "unknown";
    readTextAvailable: boolean;
    topLevel: boolean;
    userAgent?: string;
    writePermission?: PermissionState | "unsupported" | "unknown";
    writeTextAvailable: boolean;
}
export interface ClipboardCapabilities extends ClipboardCapabilityInput {
    mobileLike: boolean;
    needsManualReadFallback: boolean;
    needsOwnerGestureForRead: boolean;
    needsOwnerGestureForWrite: boolean;
    supportsClipboardChangeEvent: boolean;
}
export type StreamSessionBackend = "neko" | "cdp" | "unknown";
export interface ClipboardPolicyInput {
    capabilities: ClipboardCapabilities;
    directionPolicy: ClipboardDirectionPolicy;
    hasStreamSession: boolean;
    helperMode: ClipboardHelperMode;
    /**
     * Which streaming backend the user is connected to. Step-5 expert ruling 1:
     * the corner keyboard button is shown only for n.eko (remote-surface)
     * sessions on mobile-like surfaces — never on cdp or other contexts where
     * it was deliberately off.
     */
    sessionBackend?: StreamSessionBackend;
}
export interface ClipboardPolicyDecision {
    allowAssistivePageHelpers: boolean;
    canForwardNativePasteEvent: boolean;
    canReadLocalClipboard: boolean;
    canWriteLocalClipboard: boolean;
    directionPolicy: ClipboardDirectionPolicy;
    helperMode: ClipboardHelperMode;
    showClipboardSheet: boolean;
    showDesktopCopyButton: boolean;
    showDesktopPasteButton: boolean;
    showKeyboardButton: boolean;
    showMobileCopyButton: boolean;
    showMobilePasteButton: boolean;
    surface: ClipboardSurfaceKind;
}
export declare function classifyClipboardBrowser(userAgent: string): ClipboardCapabilityInput["browserFamily"];
export declare function inferMobileLike({ pointerCoarse, userAgent, }: Pick<ClipboardCapabilityInput, "pointerCoarse" | "userAgent">): boolean;
export declare function assessClipboardCapabilities(input: ClipboardCapabilityInput): ClipboardCapabilities;
export declare function decideClipboardPolicy({ capabilities, directionPolicy, hasStreamSession, helperMode, sessionBackend, }: ClipboardPolicyInput): ClipboardPolicyDecision;
export declare function clipboardLengthBucket(text: string): string;
//# sourceMappingURL=clipboard-policy.d.ts.map